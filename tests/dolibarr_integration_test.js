'use strict';

const assert = require('assert');
const {
  DolibarrIntegrationError,
  createDolibarrIntegrationService,
  resourceForRemoteType,
} = require('../backend/services/dolibarr_integration');
const { DolibarrApiError } = require('../backend/services/dolibarr_client');

function createMemoryDb(seed = {}) {
  const state = {
    jobs: [],
    links: [],
    attempts: [],
    operations: seed.operations || [],
    nextJobId: 1,
    nextLinkId: 1,
    nextAttemptId: 1,
  };

  function clone(row) {
    return row ? { ...row } : null;
  }

  const api = {
    state,
    async transaction(fn) {
      return fn(api);
    },
    async queryOne(sql, params = []) {
      if (/FROM integration_jobs WHERE id=\?/i.test(sql)) {
        return clone(state.jobs.find(row => row.id === Number(params[0])));
      }
      if (/FROM integration_jobs\s+WHERE provider=\? AND job_type=\? AND local_type=\? AND local_id=\?/i.test(sql)) {
        return clone(state.jobs.find(row =>
          row.provider === params[0] &&
          row.job_type === params[1] &&
          row.local_type === params[2] &&
          row.local_id === Number(params[3])
        ));
      }
      if (/FROM integration_links\s+WHERE provider=\? AND local_type=\? AND local_id=\?/i.test(sql)) {
        return clone(state.links.find(row =>
          row.provider === params[0] &&
          row.local_type === params[1] &&
          row.local_id === Number(params[2])
        ));
      }
      if (/FROM operations WHERE id=\?/i.test(sql)) {
        return clone(state.operations.find(row => row.id === Number(params[0])));
      }
      throw new Error(`Unexpected queryOne SQL: ${sql}`);
    },
    async execute(sql, params = []) {
      if (/INSERT IGNORE INTO integration_jobs/i.test(sql)) {
        const [provider, job_type, local_type, local_id, created_by] = params;
        const existing = state.jobs.find(row =>
          row.provider === provider &&
          row.job_type === job_type &&
          row.local_type === local_type &&
          row.local_id === Number(local_id)
        );
        if (existing) return { insertId: existing.id, affectedRows: 0 };
        const row = {
          id: state.nextJobId++,
          provider,
          job_type,
          local_type,
          local_id: Number(local_id),
          status: 'pending',
          attempts_count: 0,
          last_error_code: null,
          last_error_message: null,
          next_retry_at: null,
          created_by,
        };
        state.jobs.push(row);
        return { insertId: row.id, affectedRows: 1 };
      }
      if (/INSERT INTO integration_attempts/i.test(sql)) {
        const [
          job_id, provider, method, endpoint, request_hash,
          response_status, success, error_code, error_message, duration_ms,
        ] = params;
        const row = {
          id: state.nextAttemptId++,
          job_id: Number(job_id),
          provider,
          method,
          endpoint,
          request_hash,
          response_status,
          success,
          error_code,
          error_message,
          duration_ms,
        };
        state.attempts.push(row);
        return { insertId: row.id, affectedRows: 1 };
      }
      if (/INSERT IGNORE INTO integration_links/i.test(sql)) {
        const [provider, local_type, local_id, remote_type, remote_id, remote_ref, idempotency_key, created_by] = params;
        const existing = state.links.find(row =>
          row.provider === provider &&
          row.local_type === local_type &&
          row.local_id === Number(local_id)
        );
        if (existing) return { insertId: existing.id, affectedRows: 0 };
        const row = {
          id: state.nextLinkId++,
          provider,
          local_type,
          local_id: Number(local_id),
          remote_type,
          remote_id: String(remote_id),
          remote_ref,
          idempotency_key,
          created_by,
        };
        state.links.push(row);
        return { insertId: row.id, affectedRows: 1 };
      }
      if (/SET status='running', attempts_count=attempts_count\+1/i.test(sql)) {
        const job = state.jobs.find(row => row.id === Number(params[1]));
        job.status = 'running';
        job.attempts_count += 1;
        job.locked_by = params[0];
        return { affectedRows: 1 };
      }
      if (/UPDATE integration_jobs\s+SET status=\?, last_error_code=\?/i.test(sql)) {
        const [status, last_error_code, last_error_message, next_retry_at, id] = params;
        const job = state.jobs.find(row => row.id === Number(id));
        job.status = status;
        job.last_error_code = last_error_code;
        job.last_error_message = last_error_message;
        job.next_retry_at = next_retry_at;
        return { affectedRows: 1 };
      }
      if (/SET status='retrying'/i.test(sql)) {
        const job = state.jobs.find(row => row.id === Number(params[0]));
        job.status = 'retrying';
        return { affectedRows: 1 };
      }
      throw new Error(`Unexpected execute SQL: ${sql}`);
    },
  };

  return api;
}

const receipt = {
  id: 101,
  date: '2026-07-08',
  num_piece: 'REC-101',
  libelle: 'Reglement facture client',
  tiers: 'CLIENT ALPHA',
  montant: '250000.50',
  type_op: 'encaissement',
  statut: 'valide',
  mode_reglement: 'virement_bancaire',
  ref_externe: 'VIR-BANK-101',
};

async function run() {
  assert.strictEqual(resourceForRemoteType('thirdparty'), 'thirdparties');
  assert.strictEqual(resourceForRemoteType('bank_account_line', { bankAccountId: 42 }), 'bankaccounts/42/lines');
  assert.throws(
    () => resourceForRemoteType('bank_account_line'),
    error => error instanceof DolibarrIntegrationError && error.code === 'DOLIBARR_BANK_ACCOUNT_REQUIRED'
  );

  const calls = [];
  const db = createMemoryDb({ operations: [receipt] });
  const service = createDolibarrIntegrationService({
    db,
    config: { enabled: true, baseUrl: 'https://dolibarr.example.test', apiKey: 'test-api-key', bankAccountId: 42 },
    client: {
      async post(resource, payload) {
        calls.push({ resource, payload });
        if (resource === 'thirdparties') return { status: 201, data: { id: 77, ref: payload.ref_ext } };
        if (resource === 'bankaccounts/42/lines') return { status: 201, data: 900 };
        throw new Error(`Unexpected resource ${resource}`);
      },
    },
  });

  const firstJob = await service.enqueueSync('operation', 101, 'export_customer_payment', { id: 5 });
  const secondJob = await service.enqueueSync('operation', 101, 'export_customer_payment', { id: 5 });
  assert.strictEqual(firstJob.id, secondJob.id);
  assert.strictEqual(db.state.jobs.length, 1);

  const result = await service.runJob(firstJob.id, { id: 5 });
  assert.strictEqual(result.status, 'synced');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map(call => call.resource), ['thirdparties', 'bankaccounts/42/lines']);
  assert.strictEqual(db.state.links.length, 2);
  assert.strictEqual(db.state.links.find(link => link.local_type === 'operation_tiers').remote_id, '77');
  assert.strictEqual(db.state.links.find(link => link.local_type === 'operation').remote_id, '900');
  assert.strictEqual(db.state.attempts.length, 2);
  assert(db.state.attempts.every(attempt => attempt.success === 1));

  const callsBeforeRerun = calls.length;
  const rerun = await service.runJob(firstJob.id, { id: 5 });
  assert.strictEqual(rerun.status, 'synced');
  assert.strictEqual(calls.length, callsBeforeRerun, 'A synced job must not create remote objects again');

  const blockedDb = createMemoryDb({ operations: [{ ...receipt, id: 102, statut: 'en_attente' }] });
  const blockedService = createDolibarrIntegrationService({
    db: blockedDb,
    client: { async post() { throw new Error('must not call Dolibarr'); } },
  });
  const blockedJob = await blockedService.enqueueSync('operation', 102, 'export_customer_payment');
  const blocked = await blockedService.runJob(blockedJob.id);
  assert.strictEqual(blocked.status, 'blocked');
  assert.strictEqual(blocked.last_error_code, 'OPERATION_NOT_VALIDATED');
  assert.strictEqual(blockedDb.state.attempts.length, 0);

  const retryDb = createMemoryDb({ operations: [receipt] });
  const retryService = createDolibarrIntegrationService({
    db: retryDb,
    client: {
      async post() {
        throw new DolibarrApiError('Dolibarr API HTTP 503', {
          code: 'DOLIBARR_HTTP_503',
          category: 'retryable_http',
          retryable: true,
          status: 503,
          endpoint: '/api/index.php/thirdparties',
        });
      },
    },
  });
  const retryJob = await retryService.enqueueSync('operation', 101, 'export_customer_payment');
  const failed = await retryService.runJob(retryJob.id);
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.last_error_code, 'DOLIBARR_HTTP_503');
  assert(failed.next_retry_at);
  assert.strictEqual(retryDb.state.attempts.length, 1);
  assert.strictEqual(retryDb.state.attempts[0].success, 0);

  const retried = await retryService.retryJob(retryJob.id);
  assert.strictEqual(retried.status, 'failed');
  assert.strictEqual(retryDb.state.jobs[0].attempts_count, 2);
  assert.strictEqual(retryDb.state.attempts.length, 2);

  const badPayloadDb = createMemoryDb({ operations: [{ ...receipt, id: 103 }] });
  const badPayloadService = createDolibarrIntegrationService({
    db: badPayloadDb,
    client: {
      async post() {
        throw new DolibarrApiError('Payload invalide', {
          code: 'DOLIBARR_HTTP_400',
          category: 'blocked',
          retryable: false,
          status: 400,
          endpoint: '/api/index.php/thirdparties',
        });
      },
    },
  });
  const badPayloadJob = await badPayloadService.enqueueSync('operation', 103, 'export_customer_payment');
  const badPayload = await badPayloadService.runJob(badPayloadJob.id);
  assert.strictEqual(badPayload.status, 'blocked');
  assert.strictEqual(badPayload.last_error_code, 'DOLIBARR_HTTP_400');
  assert.strictEqual(badPayloadDb.state.attempts.length, 1);
  assert.strictEqual(badPayloadDb.state.attempts[0].response_status, 400);
  assert.strictEqual(badPayloadDb.state.attempts[0].success, 0);

  const networkDb = createMemoryDb({ operations: [{ ...receipt, id: 104 }] });
  const networkService = createDolibarrIntegrationService({
    db: networkDb,
    client: {
      async post() {
        throw new DolibarrApiError('Dolibarr API network error', {
          code: 'DOLIBARR_NETWORK_ERROR',
          category: 'retryable_network',
          retryable: true,
          endpoint: '/api/index.php/thirdparties',
        });
      },
    },
  });
  const networkJob = await networkService.enqueueSync('operation', 104, 'export_customer_payment');
  const networkFailed = await networkService.runJob(networkJob.id);
  assert.strictEqual(networkFailed.status, 'failed');
  assert.strictEqual(networkFailed.last_error_code, 'DOLIBARR_NETWORK_ERROR');
  assert(networkFailed.next_retry_at);
  assert.strictEqual(networkDb.state.attempts.length, 1);
  assert.strictEqual(networkDb.state.attempts[0].success, 0);

  await assert.rejects(
    () => retryService.retryJob(999),
    error => error instanceof DolibarrIntegrationError && error.code === 'JOB_NOT_FOUND'
  );

  console.log('dolibarr_integration_test: OK');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

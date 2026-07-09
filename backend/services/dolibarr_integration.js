'use strict';

const db = require('../db');
const { publicDolibarrConfig } = require('./dolibarr_config');
const {
  DolibarrMappingError,
  buildOperationSyncPlan,
  mapOperationPayment,
  mapThirdpartyFromOperation,
} = require('./dolibarr_mapping');

const PROVIDER = 'dolibarr';

class DolibarrIntegrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DolibarrIntegrationError';
    this.code = code;
    this.details = details;
  }
}

function actorId(actor) {
  if (actor == null) return null;
  if (typeof actor === 'number') return actor;
  return actor.id || actor.user_id || null;
}

function remoteIdFromResponse(result) {
  const data = result && result.data != null ? result.data : result;
  if (data == null) return null;
  if (typeof data === 'number' || typeof data === 'string') return String(data);
  return String(data.id || data.rowid || data.remote_id || data.ref || '');
}

function remoteRefFromResponse(result, fallback = null) {
  const data = result && result.data != null ? result.data : result;
  if (data && typeof data === 'object') {
    return data.ref || data.ref_ext || data.id || data.rowid || fallback;
  }
  return fallback;
}

function classifyError(error) {
  if (error && error.name === 'DolibarrMappingError') {
    return {
      status: 'blocked',
      code: error.code || 'DOLIBARR_MAPPING_ERROR',
      message: error.message,
      retryable: false,
    };
  }
  if (error && error.retryable) {
    return {
      status: 'failed',
      code: error.code || 'DOLIBARR_RETRYABLE_ERROR',
      message: error.message,
      retryable: true,
    };
  }
  return {
    status: 'blocked',
    code: error && error.code ? error.code : 'DOLIBARR_BLOCKED_ERROR',
    message: error && error.message ? error.message : 'Erreur integration Dolibarr',
    retryable: false,
  };
}

function resourceForRemoteType(remoteType, context = {}) {
  if (remoteType === 'thirdparty') return 'thirdparties';
  if (remoteType === 'bank_account_line') {
    const bankAccountId = Number(context.bankAccountId || (context.config && context.config.bankAccountId));
    if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) {
      throw new DolibarrIntegrationError(
        'DOLIBARR_BANK_ACCOUNT_REQUIRED',
        'Compte banque/caisse Dolibarr requis pour exporter une operation',
        { remoteType }
      );
    }
    return `bankaccounts/${bankAccountId}/lines`;
  }
  throw new DolibarrIntegrationError('REMOTE_TYPE_UNSUPPORTED', 'Type distant Dolibarr non supporte', { remoteType });
}

function rawEnvEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(env.DOLIBARR_ENABLED || '').trim().toLowerCase())
    && String(env.DOLIBARR_SYNC_MODE || 'manual').trim().toLowerCase() !== 'disabled';
}

function createDolibarrIntegrationService(options = {}) {
  const dbc = options.db || db;
  const client = options.client || null;
  const config = options.config || null;

  async function getStatus() {
    return {
      provider: PROVIDER,
      config: publicDolibarrConfig(config || {}),
    };
  }

  async function findExistingLink(provider, localType, localId, executor = dbc) {
    return executor.queryOne(`
      SELECT *
      FROM integration_links
      WHERE provider=? AND local_type=? AND local_id=?
      LIMIT 1
    `, [provider, localType, localId]);
  }

  async function findJobById(jobId, executor = dbc) {
    const job = await executor.queryOne('SELECT * FROM integration_jobs WHERE id=? LIMIT 1', [jobId]);
    if (!job) throw new DolibarrIntegrationError('JOB_NOT_FOUND', 'Job integration introuvable', { jobId });
    return job;
  }

  async function getOperation(localId, executor = dbc) {
    const operation = await executor.queryOne('SELECT * FROM operations WHERE id=? LIMIT 1', [localId]);
    if (!operation) throw new DolibarrIntegrationError('OPERATION_NOT_FOUND', 'Operation Tala SMI introuvable', { localId });
    return operation;
  }

  async function enqueueSync(localType, localId, jobType, actor = null) {
    if (localType !== 'operation') {
      throw new DolibarrIntegrationError('LOCAL_TYPE_UNSUPPORTED', 'Seules les operations sont supportees en V1', { localType });
    }
    if (!localId) throw new DolibarrIntegrationError('LOCAL_ID_REQUIRED', 'Identifiant local requis');
    if (!jobType) throw new DolibarrIntegrationError('JOB_TYPE_REQUIRED', 'Type de job requis');

    await dbc.execute(`
      INSERT IGNORE INTO integration_jobs
        (provider, job_type, local_type, local_id, status, created_by)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `, [PROVIDER, jobType, localType, localId, actorId(actor)]);

    return dbc.queryOne(`
      SELECT *
      FROM integration_jobs
      WHERE provider=? AND job_type=? AND local_type=? AND local_id=?
      LIMIT 1
    `, [PROVIDER, jobType, localType, localId]);
  }

  async function recordAttempt(jobId, attempt, executor = dbc) {
    return executor.execute(`
      INSERT INTO integration_attempts
        (job_id, provider, method, endpoint, request_hash, response_status, success, error_code, error_message, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId,
      PROVIDER,
      attempt.method || 'POST',
      attempt.endpoint || 'local',
      attempt.request_hash || null,
      attempt.response_status || null,
      attempt.success ? 1 : 0,
      attempt.error_code || null,
      attempt.error_message || null,
      attempt.duration_ms || null,
    ]);
  }

  async function upsertLink(input, executor = dbc) {
    await executor.execute(`
      INSERT IGNORE INTO integration_links
        (provider, local_type, local_id, remote_type, remote_id, remote_ref, idempotency_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      PROVIDER,
      input.localType,
      input.localId,
      input.remoteType,
      input.remoteId,
      input.remoteRef || null,
      input.idempotencyKey,
      input.createdBy || null,
    ]);
    return findExistingLink(PROVIDER, input.localType, input.localId, executor);
  }

  async function markJob(jobId, status, fields = {}, executor = dbc) {
    await executor.execute(`
      UPDATE integration_jobs
      SET status=?, last_error_code=?, last_error_message=?, next_retry_at=?, updated_at=NOW()
      WHERE id=?
    `, [
      status,
      fields.last_error_code || null,
      fields.last_error_message || null,
      fields.next_retry_at || null,
      jobId,
    ]);
    return findJobById(jobId, executor);
  }

  async function callDolibarr(job, remoteType, payload, executor) {
    if (!client) {
      throw new DolibarrIntegrationError('DOLIBARR_CLIENT_REQUIRED', 'Client Dolibarr requis');
    }

    const resource = resourceForRemoteType(remoteType, { config });
    const started = Date.now();
    try {
      const result = await client.post(resource, payload);
      await recordAttempt(job.id, {
        method: 'POST',
        endpoint: `/api/index.php/${resource}`,
        response_status: result.status,
        success: true,
        duration_ms: Date.now() - started,
      }, executor);
      return result;
    } catch (error) {
      await recordAttempt(job.id, {
        method: 'POST',
        endpoint: error.endpoint || `/api/index.php/${resource}`,
        response_status: error.status || null,
        success: false,
        error_code: error.code || 'DOLIBARR_CALL_FAILED',
        error_message: error.message || 'Erreur appel Dolibarr',
        duration_ms: Date.now() - started,
      }, executor);
      throw error;
    }
  }

  async function runJob(jobId, actor = null) {
    const job = await findJobById(jobId);
    if (job.status === 'synced') return job;

    await dbc.execute(`
      UPDATE integration_jobs
      SET status='running', attempts_count=attempts_count+1, locked_at=NOW(), locked_by=?, updated_at=NOW()
      WHERE id=?
    `, [actorId(actor) ? `user:${actorId(actor)}` : 'system', job.id]);

    try {
      const operation = await getOperation(job.local_id);
      const paymentLink = await findExistingLink(PROVIDER, 'operation', operation.id);
      if (paymentLink) {
        return markJob(job.id, 'synced');
      }

      const thirdpartyLink = await findExistingLink(PROVIDER, 'operation_tiers', operation.id);
      const links = thirdpartyLink ? { thirdpartyRemoteId: thirdpartyLink.remote_id } : {};
      buildOperationSyncPlan(operation, links);

      let effectiveThirdpartyLink = thirdpartyLink;
      if (!effectiveThirdpartyLink) {
        const thirdparty = mapThirdpartyFromOperation(operation);
        const result = await callDolibarr(job, thirdparty.remoteType, thirdparty.payload, dbc);
        const remoteId = remoteIdFromResponse(result);
        if (!remoteId) throw new DolibarrIntegrationError('REMOTE_ID_MISSING', 'Dolibarr n’a pas retourne d’identifiant tiers');
        effectiveThirdpartyLink = await upsertLink({
          localType: 'operation_tiers',
          localId: operation.id,
          remoteType: thirdparty.remoteType,
          remoteId,
          remoteRef: remoteRefFromResponse(result, thirdparty.payload.ref_ext),
          idempotencyKey: `dolibarr:thirdparty:${operation.id || operation.num_piece}`,
          createdBy: actorId(actor),
        });
      }

      const payment = mapOperationPayment(operation, { thirdpartyRemoteId: effectiveThirdpartyLink.remote_id });
      const result = await callDolibarr(job, payment.remoteType, payment.payload, dbc);
      const remoteId = remoteIdFromResponse(result);
      if (!remoteId) throw new DolibarrIntegrationError('REMOTE_ID_MISSING', 'Dolibarr n’a pas retourne d’identifiant paiement');
      await upsertLink({
        localType: 'operation',
        localId: operation.id,
        remoteType: payment.remoteType,
        remoteId,
        remoteRef: remoteRefFromResponse(result, payment.payload.ref_ext),
        idempotencyKey: payment.idempotencyKey,
        createdBy: actorId(actor),
      });

      return markJob(job.id, 'synced');
    } catch (error) {
      const classified = classifyError(error);
      return markJob(job.id, classified.status, {
        last_error_code: classified.code,
        last_error_message: classified.message,
        next_retry_at: classified.retryable ? new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') : null,
      });
    }
  }

  async function retryJob(jobId, actor = null) {
    const job = await findJobById(jobId);
    if (!['failed', 'retrying', 'pending'].includes(job.status)) {
      throw new DolibarrIntegrationError('JOB_NOT_RETRYABLE', 'Job non relancable', { status: job.status });
    }
    await dbc.execute(`
      UPDATE integration_jobs
      SET status='retrying', updated_at=NOW()
      WHERE id=?
    `, [job.id]);
    return runJob(job.id, actor);
  }

  return {
    enqueueSync,
    findExistingLink,
    getStatus,
    recordAttempt,
    retryJob,
    runJob,
  };
}

async function enqueueOperationSyncIfEnabled(options = {}) {
  const env = options.env || process.env;
  if (!rawEnvEnabled(env)) {
    return { queued: false, reason: 'disabled' };
  }

  const dbc = options.db || db;
  const actor = options.actor || null;
  const operationId = Number(options.operationId);
  if (!operationId) throw new DolibarrIntegrationError('OPERATION_ID_REQUIRED', 'Identifiant operation requis');

  const operation = options.operation || await dbc.queryOne('SELECT * FROM operations WHERE id=? LIMIT 1', [operationId]);
  if (!operation) throw new DolibarrIntegrationError('OPERATION_NOT_FOUND', 'Operation Tala SMI introuvable', { operationId });

  const plan = buildOperationSyncPlan(operation);
  const service = createDolibarrIntegrationService({ db: dbc });
  const job = await service.enqueueSync(plan.localType, plan.localId, plan.jobType, actor);
  return { queued: true, job };
}

module.exports = {
  DolibarrIntegrationError,
  createDolibarrIntegrationService,
  enqueueOperationSyncIfEnabled,
  resourceForRemoteType,
};

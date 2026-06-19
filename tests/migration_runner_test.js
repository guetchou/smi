'use strict';

const assert = require('assert');
const {
  splitStatements,
  isIdempotentMysqlError,
  isRetryableMysqlError,
  executeStatementWithRetry,
} = require('../backend/migrations/runner');

async function run() {
  const statements = splitStatements(`
    -- commentaire
    ALTER TABLE operations ADD COLUMN business_status VARCHAR(32) NULL;
    CREATE INDEX idx_operations_business_status ON operations(business_status);
  `);
  assert.strictEqual(statements.length, 2);
  assert(statements[0].startsWith('ALTER TABLE operations'));
  assert(statements[1].startsWith('CREATE INDEX idx_operations_business_status'));

  for (const code of ['ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME', 'ER_DUP_FIELDNAME', 'ER_FK_DUP_NAME']) {
    assert.strictEqual(isIdempotentMysqlError({ code }), true, `${code} doit être tolérée`);
  }
  assert.strictEqual(isIdempotentMysqlError({ code: 'ER_PARSE_ERROR' }), false);
  assert.strictEqual(isRetryableMysqlError({ code: 'ER_LOCK_DEADLOCK' }), true);
  assert.strictEqual(isRetryableMysqlError({ code: 'ER_LOCK_WAIT_TIMEOUT' }), true);

  let duplicateCalls = 0;
  const duplicatePool = {
    async execute() {
      duplicateCalls += 1;
      const error = new Error('Duplicate column');
      error.code = 'ER_DUP_FIELDNAME';
      throw error;
    },
  };
  const duplicateResult = await executeStatementWithRetry(
    duplicatePool,
    'ALTER TABLE operations ADD COLUMN business_status VARCHAR(32)',
    { file: '031_test.sql', waitFn: async () => {} }
  );
  assert.strictEqual(duplicateResult.status, 'already_present');
  assert.strictEqual(duplicateResult.attempts, 1);
  assert.strictEqual(duplicateCalls, 1);

  let retryCalls = 0;
  const retryPool = {
    async execute() {
      retryCalls += 1;
      if (retryCalls < 3) {
        const error = new Error('Deadlock');
        error.code = 'ER_LOCK_DEADLOCK';
        throw error;
      }
      return [{ affectedRows: 0 }];
    },
  };
  const waits = [];
  const retryResult = await executeStatementWithRetry(
    retryPool,
    'ALTER TABLE operations ADD COLUMN payment_status VARCHAR(32)',
    { file: '031_test.sql', waitFn: async ms => waits.push(ms) }
  );
  assert.strictEqual(retryResult.status, 'executed');
  assert.strictEqual(retryResult.attempts, 3);
  assert.deepStrictEqual(waits, [1000, 2000]);

  const fatalPool = {
    async execute() {
      const error = new Error('Syntax error');
      error.code = 'ER_PARSE_ERROR';
      throw error;
    },
  };
  await assert.rejects(
    () => executeStatementWithRetry(fatalPool, 'INVALID SQL', { waitFn: async () => {} }),
    error => error.code === 'ER_PARSE_ERROR'
  );

  console.log(JSON.stringify({
    migrationStatementSplit: true,
    duplicateErrorsTolerated: true,
    lockRetryVerified: true,
    fatalErrorsPropagated: true,
  }));
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

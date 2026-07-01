'use strict';

const assert = require('assert');

const {
  detectDelegationCycle,
  assertNoOverlappingDelegation,
  DelegationError,
} = require('../backend/services/delegation_engine');

async function testIndirectCycle() {
  const executor = {
    async query() {
      return [
        { delegator_id: 1, delegate_id: 2 },
        { delegator_id: 2, delegate_id: 3 },
      ];
    },
  };

  assert.strictEqual(
    await detectDelegationCycle(3, 1, executor),
    true,
    '3 → 1 doit être refusé car 1 → 2 → 3 existe',
  );

  assert.strictEqual(
    await detectDelegationCycle(4, 5, executor),
    false,
    '4 → 5 ne crée aucun cycle',
  );
}

async function testOverlap() {
  const existingExecutor = {
    async queryOne() {
      return { id: 99 };
    },
  };

  let error = null;

  try {
    await assertNoOverlappingDelegation({
      delegatorId: 1,
      delegateId: 2,
      permissionId: 10,
      profileId: null,
      scopeModule: null,
      startsAt: '2026-07-01 08:00:00',
      expiresAt: '2026-07-10 18:00:00',
    }, existingExecutor);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof DelegationError);
  assert.strictEqual(error.code, 'DELEGATION_OVERLAP');

  const emptyExecutor = {
    async queryOne() {
      return null;
    },
  };

  await assertNoOverlappingDelegation({
    delegatorId: 1,
    delegateId: 2,
    permissionId: 10,
    profileId: null,
    scopeModule: null,
    startsAt: '2026-07-01 08:00:00',
    expiresAt: '2026-07-10 18:00:00',
  }, emptyExecutor);
}

(async () => {
  await testIndirectCycle();
  await testOverlap();

  console.log('delegation_cycle_test: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

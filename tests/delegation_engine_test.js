'use strict';

const assert = require('assert');

const {
  DelegationError,
  validateDelegationInput,
} = require('../backend/services/delegation_engine');

function mustThrow(fn, expectedCode) {
  let thrown = null;

  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof DelegationError);
  assert.strictEqual(thrown.code, expectedCode);
}

const valid = validateDelegationInput({
  delegatorId: 1,
  delegateId: 2,
  permissionId: 10,
  startsAt: '2026-07-01 08:00:00',
  expiresAt: '2026-07-05 18:00:00',
  amountLimit: 500000,
  reason: 'Absence temporaire',
});

assert.strictEqual(valid.delegatorId, 1);
assert.strictEqual(valid.delegateId, 2);
assert.strictEqual(valid.permissionId, 10);
assert.strictEqual(valid.profileId, null);
assert.strictEqual(valid.scopeModule, null);
assert.strictEqual(valid.amountLimit, 500000);
assert.strictEqual(valid.allowRedelegation, 0);
assert.strictEqual(valid.sourceType, 'manual');

mustThrow(() => validateDelegationInput({
  delegatorId: 1,
  delegateId: 1,
  permissionId: 10,
  expiresAt: '2026-07-05 18:00:00',
}), 'SELF_DELEGATION');

mustThrow(() => validateDelegationInput({
  delegatorId: 1,
  delegateId: 2,
  permissionId: 10,
  profileId: 3,
  expiresAt: '2026-07-05 18:00:00',
}), 'INVALID_DELEGATION_SCOPE');

mustThrow(() => validateDelegationInput({
  delegatorId: 1,
  delegateId: 2,
  permissionId: 10,
  startsAt: '2026-07-05 18:00:00',
  expiresAt: '2026-07-01 08:00:00',
}), 'INVALID_DELEGATION_PERIOD');

mustThrow(() => validateDelegationInput({
  delegatorId: 1,
  delegateId: 2,
  permissionId: 10,
  expiresAt: '2026-07-05 18:00:00',
  amountLimit: -1,
}), 'INVALID_AMOUNT_LIMIT');

console.log('delegation_engine_test: OK');

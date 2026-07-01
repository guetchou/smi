'use strict';

const assert = require('assert');

const {
  DelegationError,
  getPermissionGovernance,
  resolveDelegatorAuthority,
  assertDelegationWithinAuthority,
} = require('../backend/services/delegation_engine');

async function expectError(fn, code) {
  let caught = null;

  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  assert(caught instanceof DelegationError);
  assert.strictEqual(caught.code, code);
}

async function testNonDelegablePermission() {
  const executor = {
    async queryOne() {
      return {
        id: 10,
        code: 'salary.pay',
        actif: 1,
        sensitive: 1,
        delegable: 0,
      };
    },
  };

  await expectError(
    () => getPermissionGovernance(10, executor),
    'PERMISSION_NOT_DELEGABLE',
  );
}

async function testDirectAuthority() {
  let call = 0;

  const executor = {
    async queryOne() {
      call += 1;

      if (call === 1) {
        return {
          id: 10,
          code: 'cash.out.validate',
          actif: 1,
          sensitive: 0,
          delegable: 1,
        };
      }

      return {
        authority_source: 'direct_permission',
        amount_limit: 500000,
      };
    },
  };

  const authority = await resolveDelegatorAuthority({
    delegatorId: 1,
    permissionId: 10,
  }, executor);

  assert.strictEqual(authority.source, 'direct_permission');
  assert.strictEqual(authority.amountLimit, 500000);
  assert.strictEqual(authority.parentDelegationId, null);
}

async function testRedelegationForbidden() {
  let call = 0;

  const executor = {
    async queryOne() {
      call += 1;

      if (call === 1) {
        return {
          id: 10,
          code: 'cash.out.validate',
          actif: 1,
          sensitive: 0,
          delegable: 1,
        };
      }

      if (call === 2) return null;

      return {
        id: 77,
        amount_limit: 250000,
        expires_at: '2026-07-20 18:00:00',
        allow_redelegation: 0,
      };
    },
  };

  await expectError(
    () => resolveDelegatorAuthority({
      delegatorId: 2,
      permissionId: 10,
    }, executor),
    'REDELEGATION_FORBIDDEN',
  );
}

function testInheritedAmountLimit() {
  assert.throws(
    () => assertDelegationWithinAuthority({
      amountLimit: 300000,
      expiresAt: '2026-07-10 18:00:00',
    }, {
      amountLimit: 250000,
      expiresAt: '2026-07-20 18:00:00',
    }),
    error => (
      error instanceof DelegationError
      && error.code === 'DELEGATION_AMOUNT_LIMIT_EXCEEDED'
    ),
  );
}

function testInheritedExpiry() {
  assert.throws(
    () => assertDelegationWithinAuthority({
      amountLimit: 200000,
      expiresAt: '2026-07-25 18:00:00',
    }, {
      amountLimit: 250000,
      expiresAt: '2026-07-20 18:00:00',
    }),
    error => (
      error instanceof DelegationError
      && error.code === 'DELEGATION_EXPIRY_EXCEEDED'
    ),
  );
}

(async () => {
  await testNonDelegablePermission();
  await testDirectAuthority();
  await testRedelegationForbidden();
  testInheritedAmountLimit();
  testInheritedExpiry();

  console.log('delegation_governance_test: OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

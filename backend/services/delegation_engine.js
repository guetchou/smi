'use strict';

const db = require('../db');

class DelegationError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
    this.status = status;
  }
}

function normalizeDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date
    ? value
    : new Date(String(value).replace(' ', 'T'));

  if (Number.isNaN(date.getTime())) {
    throw new DelegationError(
      'Date de délégation invalide',
      'INVALID_DELEGATION_DATE',
    );
  }

  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function validateDelegationInput(input = {}) {
  const delegatorId = Number(input.delegatorId);
  const delegateId = Number(input.delegateId);

  if (!Number.isInteger(delegatorId) || delegatorId <= 0) {
    throw new DelegationError(
      'Délégant invalide',
      'INVALID_DELEGATOR',
    );
  }

  if (!Number.isInteger(delegateId) || delegateId <= 0) {
    throw new DelegationError(
      'Délégataire invalide',
      'INVALID_DELEGATE',
    );
  }

  if (delegatorId === delegateId) {
    throw new DelegationError(
      'Un utilisateur ne peut pas se déléguer un droit à lui-même',
      'SELF_DELEGATION',
      409,
    );
  }

  const permissionId = input.permissionId
    ? Number(input.permissionId)
    : null;

  const profileId = input.profileId
    ? Number(input.profileId)
    : null;

  const scopeModule = input.scopeModule
    ? String(input.scopeModule).trim()
    : null;

  const selectedScopes = [
    permissionId,
    profileId,
    scopeModule,
  ].filter(Boolean);

  if (selectedScopes.length !== 1) {
    throw new DelegationError(
      'Une délégation doit cibler exactement une permission, un profil ou un module',
      'INVALID_DELEGATION_SCOPE',
    );
  }

  const startsAt = normalizeDateTime(input.startsAt || new Date());
  const expiresAt = normalizeDateTime(input.expiresAt);

  if (!expiresAt) {
    throw new DelegationError(
      'La date de fin est obligatoire',
      'DELEGATION_EXPIRY_REQUIRED',
    );
  }

  if (new Date(expiresAt) <= new Date(startsAt)) {
    throw new DelegationError(
      'La date de fin doit être postérieure à la date de début',
      'INVALID_DELEGATION_PERIOD',
    );
  }

  const amountLimit = input.amountLimit == null || input.amountLimit === ''
    ? null
    : Number(input.amountLimit);

  if (
    amountLimit !== null
    && (!Number.isFinite(amountLimit) || amountLimit < 0)
  ) {
    throw new DelegationError(
      'Le plafond de délégation est invalide',
      'INVALID_AMOUNT_LIMIT',
    );
  }

  return {
    delegatorId,
    delegateId,
    permissionId,
    profileId,
    scopeModule,
    startsAt,
    expiresAt,
    amountLimit,
    reason: input.reason ? String(input.reason).trim() : null,
    delegationType: input.delegationType || 'permission',
    allowRedelegation: input.allowRedelegation ? 1 : 0,
    sourceType: input.sourceType || 'manual',
    sourceId: input.sourceId ? Number(input.sourceId) : null,
  };
}

async function userExists(userId, executor = db) {
  const row = await executor.queryOne(
    'SELECT id, actif FROM users WHERE id=? LIMIT 1',
    [userId],
  );

  return Boolean(row && Number(row.actif) === 1);
}

async function detectDelegationCycle(
  delegatorId,
  delegateId,
  executor = db,
) {
  const rows = await executor.query(`
    SELECT delegator_id, delegate_id
    FROM delegations
    WHERE active=1
      AND revoked_at IS NULL
      AND starts_at <= NOW()
      AND expires_at > NOW()
  `);

  const graph = new Map();

  for (const row of rows || []) {
    const from = Number(row.delegator_id);
    const to = Number(row.delegate_id);

    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }

  if (!graph.has(delegatorId)) graph.set(delegatorId, []);
  graph.get(delegatorId).push(delegateId);

  const visited = new Set();
  const stack = [delegateId];

  while (stack.length) {
    const current = stack.pop();

    if (current === delegatorId) {
      return true;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    for (const next of graph.get(current) || []) {
      stack.push(next);
    }
  }

  return false;
}

async function assertNoOverlappingDelegation(
  data,
  executor = db,
) {
  const duplicate = await executor.queryOne(`
    SELECT id
    FROM delegations
    WHERE delegator_id=?
      AND delegate_id=?
      AND active=1
      AND revoked_at IS NULL
      AND (
        (permission_id IS NULL AND ? IS NULL)
        OR permission_id=?
      )
      AND (
        (profile_id IS NULL AND ? IS NULL)
        OR profile_id=?
      )
      AND (
        (scope_module IS NULL AND ? IS NULL)
        OR scope_module=?
      )
      AND starts_at < ?
      AND expires_at > ?
    LIMIT 1
  `, [
    data.delegatorId,
    data.delegateId,
    data.permissionId,
    data.permissionId,
    data.profileId,
    data.profileId,
    data.scopeModule,
    data.scopeModule,
    data.expiresAt,
    data.startsAt,
  ]);

  if (duplicate) {
    throw new DelegationError(
      'Une délégation active existe déjà sur cette période et ce périmètre',
      'DELEGATION_OVERLAP',
      409,
    );
  }
}

async function assertDelegatorOwnsPermission(
  delegatorId,
  permissionId,
  executor = db,
) {
  if (!permissionId) return true;

  const owned = await executor.queryOne(`
    SELECT 1 AS ok
    FROM permissions p
    WHERE p.id=?
      AND p.actif=1
      AND (
        EXISTS (
          SELECT 1
          FROM user_permissions up
          WHERE up.user_id=?
            AND up.permission_id=p.id
            AND up.active=1
            AND up.allowed=1
            AND (
              up.expires_at IS NULL
              OR up.expires_at > NOW()
            )
        )
        OR EXISTS (
          SELECT 1
          FROM user_profiles usr
          JOIN profile_permissions pp
            ON pp.profile_id=usr.profile_id
           AND pp.permission_id=p.id
           AND pp.allowed=1
          WHERE usr.user_id=?
            AND usr.active=1
            AND (
              usr.expires_at IS NULL
              OR usr.expires_at > NOW()
            )
        )
      )
    LIMIT 1
  `, [permissionId, delegatorId, delegatorId]);

  if (!owned) {
    throw new DelegationError(
      'Le délégant ne possède pas la permission demandée',
      'PERMISSION_NOT_OWNED',
      403,
    );
  }

  return true;
}

async function createDelegation(input, actorUserId, executor = db) {
  const data = validateDelegationInput(input);

  if (!(await userExists(data.delegatorId, executor))) {
    throw new DelegationError(
      'Délégant actif introuvable',
      'DELEGATOR_NOT_FOUND',
      404,
    );
  }

  if (!(await userExists(data.delegateId, executor))) {
    throw new DelegationError(
      'Délégataire actif introuvable',
      'DELEGATE_NOT_FOUND',
      404,
    );
  }

  if (
    await detectDelegationCycle(
      data.delegatorId,
      data.delegateId,
      executor,
    )
  ) {
    throw new DelegationError(
      'Cette délégation créerait un cycle de délégation',
      'DELEGATION_CYCLE',
      409,
    );
  }

  await assertNoOverlappingDelegation(data, executor);

  await assertDelegatorOwnsPermission(
    data.delegatorId,
    data.permissionId,
    executor,
  );

  const result = await executor.execute(`
    INSERT INTO delegations (
      delegator_id,
      delegate_id,
      permission_id,
      profile_id,
      scope_module,
      amount_limit,
      starts_at,
      expires_at,
      active,
      reason,
      delegation_type,
      allow_redelegation,
      source_type,
      source_id,
      created_by,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `, [
    data.delegatorId,
    data.delegateId,
    data.permissionId,
    data.profileId,
    data.scopeModule,
    data.amountLimit,
    data.startsAt,
    data.expiresAt,
    data.reason,
    data.delegationType,
    data.allowRedelegation,
    data.sourceType,
    data.sourceId,
    actorUserId || data.delegatorId,
  ]);

  return {
    id: result.insertId || result.lastInsertRowid,
    ...data,
    active: true,
  };
}

async function revokeDelegation(
  delegationId,
  actorUserId,
  reason,
  executor = db,
) {
  const delegation = await executor.queryOne(
    'SELECT * FROM delegations WHERE id=? LIMIT 1',
    [delegationId],
  );

  if (!delegation) {
    throw new DelegationError(
      'Délégation introuvable',
      'DELEGATION_NOT_FOUND',
      404,
    );
  }

  if (!Number(delegation.active) || delegation.revoked_at) {
    throw new DelegationError(
      'Délégation déjà inactive',
      'DELEGATION_ALREADY_INACTIVE',
      409,
    );
  }

  await executor.execute(`
    UPDATE delegations
    SET active=0,
        revoked_at=NOW(),
        revoked_by=?,
        revoke_reason=?,
        updated_at=NOW()
    WHERE id=? AND active=1
  `, [
    actorUserId,
    reason ? String(reason).trim() : null,
    delegationId,
  ]);

  return {
    id: Number(delegationId),
    active: false,
  };
}

async function resolveActiveDelegation({
  delegateId,
  permissionCode,
  amount = null,
}, executor = db) {
  const delegation = await executor.queryOne(`
    SELECT
      d.id,
      d.delegator_id,
      d.delegate_id,
      d.amount_limit,
      d.expires_at,
      d.source_type,
      d.source_id
    FROM delegations d
    LEFT JOIN permissions p
      ON p.id=d.permission_id
    LEFT JOIN profile_permissions pp
      ON pp.profile_id=d.profile_id
     AND pp.allowed=1
    LEFT JOIN permissions profile_permission
      ON profile_permission.id=pp.permission_id
    WHERE d.delegate_id=?
      AND d.active=1
      AND d.revoked_at IS NULL
      AND d.starts_at <= NOW()
      AND d.expires_at > NOW()
      AND (
        p.code=?
        OR profile_permission.code=?
        OR d.scope_module=?
      )
    ORDER BY d.expires_at ASC, d.id ASC
    LIMIT 1
  `, [
    delegateId,
    permissionCode,
    permissionCode,
    String(permissionCode).split('.')[0],
  ]);

  if (!delegation) return null;

  if (
    delegation.amount_limit != null
    && amount != null
    && Number(amount) > Number(delegation.amount_limit)
  ) {
    return null;
  }

  return delegation;
}

module.exports = {
  DelegationError,
  validateDelegationInput,
  detectDelegationCycle,
  assertNoOverlappingDelegation,
  assertDelegatorOwnsPermission,
  createDelegation,
  revokeDelegation,
  resolveActiveDelegation,
};

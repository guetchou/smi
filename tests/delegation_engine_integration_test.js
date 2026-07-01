'use strict';

const assert = require('assert');
const fs = require('fs');

const permissions = fs.readFileSync(
  'backend/services/permissions.js',
  'utf8',
);

const access = fs.readFileSync(
  'backend/routes/access.js',
  'utf8',
);

const migration = fs.readFileSync(
  'backend/migrations/043_delegation_engine.sql',
  'utf8',
);

assert(
  permissions.includes("require('./delegation_engine')"),
  'permissions.js doit utiliser delegation_engine',
);

assert(
  permissions.includes('await resolveActiveDelegation({'),
  'can() doit résoudre les délégations via le moteur canonique',
);

assert(
  !permissions.includes('FROM delegations d\n    LEFT JOIN permissions'),
  'L’ancien SQL de résolution ne doit plus rester dans can()',
);

assert(
  access.includes('await createDelegation({'),
  'La route Access doit créer les délégations via le service',
);

assert(
  access.includes('await revokeDelegation('),
  'La route Access doit révoquer via le service',
);

assert(
  migration.includes('revoked_at'),
  'La migration doit tracer les révocations',
);

assert(
  migration.includes('allow_redelegation'),
  'La migration doit contrôler la redélégation',
);

console.log('delegation_engine_integration_test: OK');

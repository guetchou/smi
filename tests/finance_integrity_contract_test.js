'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  expectedLedgerLegs,
  isEffectiveOperation,
  operationDeltaForPosition,
} = require('../backend/services/finance-integrity');

const servicePath = path.join(__dirname, '..', 'backend', 'services', 'finance-integrity.js');
const scriptPath = path.join(__dirname, '..', 'scripts', 'check_finance_integrity_mysql.js');
const serviceSource = fs.readFileSync(servicePath, 'utf8');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');
const forbiddenWriteSql = /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_`]|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i;

assert(!forbiddenWriteSql.test(serviceSource), 'finance integrity service must remain SQL read-only');
assert(!forbiddenWriteSql.test(scriptSource), 'finance integrity CLI must remain SQL read-only');
assert(serviceSource.includes('read_only: true'), 'report must declare read-only mode');
assert(scriptSource.includes("process.env.DB_DRIVER = 'mysql'"), 'CLI must target MySQL');
assert(scriptSource.includes("process.argv.includes('--json')"), 'CLI must support --json');
assert(scriptSource.includes("startsWith(`${prefix}=`)"), 'CLI must support scoped identifiers');

assert.strictEqual(isEffectiveOperation({ type_op: 'encaissement', statut: 'valide' }), true);
assert.strictEqual(isEffectiveOperation({ type_op: 'decaissement', statut: 'valide', dec_statut: 'valide' }), false);
assert.strictEqual(isEffectiveOperation({ type_op: 'decaissement', statut: 'valide', dec_statut: 'paye' }), true);
assert.strictEqual(isEffectiveOperation({ type_op: 'virement', statut: 'annule' }), false);

const transfer = {
  id: 1,
  type_op: 'virement',
  statut: 'valide',
  montant: 25000,
  position_source_id: 10,
  position_id: 20,
};
assert.deepStrictEqual(expectedLedgerLegs(transfer), [
  { caisse_id: 10, type_mouvement: 'debit', montant: 25000 },
  { caisse_id: 20, type_mouvement: 'credit', montant: 25000 },
]);
assert.strictEqual(operationDeltaForPosition(transfer, 10), -25000);
assert.strictEqual(operationDeltaForPosition(transfer, 20), 25000);

console.log('finance_integrity_contract_test: OK');

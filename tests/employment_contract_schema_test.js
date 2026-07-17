'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/046_employment_contract_management.sql'), 'utf8');
const sqliteSchema = fs.readFileSync(path.join(root, 'backend/database.js'), 'utf8');
const requiredTables = [
  'payroll_rule_sets',
  'employment_contract_templates',
  'employment_contract_template_versions',
  'employment_contracts',
  'employment_contract_components',
  'employment_contract_documents',
  'employment_contract_events',
];
for (const table of requiredTables) {
  assert(migration.includes(`CREATE TABLE ${table}`), `${table} absent`);
  assert(sqliteSchema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} absent du schema SQLite`);
}

assert(migration.includes('remuneration_snapshot JSON NOT NULL'));
assert(migration.includes('rules_snapshot JSON'));
assert(migration.includes("ENUM('brouillon','en_verification','valide','signe','archive','annule')"));
assert(migration.includes("'employment_contract.template.manage'"));
assert(migration.includes("'employment_contract.rules.manage'"));
assert(!/employeeRate[^\n]*DEFAULT|cnss[^\n]*4\.725/i.test(migration), 'Aucun taux legal ne doit etre seme');
assert(sqliteSchema.includes('migrateEmploymentContractManagement();'), 'Migration SQLite non branchee');
assert(sqliteSchema.includes("CHECK(statut IN ('brouillon','en_verification','valide','signe','archive','annule'))"));
assert(sqliteSchema.includes("CHECK(format IN ('docx','pdf'))"));

const dbPath = path.join(os.tmpdir(), `smi-employment-schema-${process.pid}-${Date.now()}.db`);
const startupProbe = `
  const db = require('./backend/database');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'employment_contract%' OR name='payroll_rule_sets') ORDER BY name").all().map(row => row.name);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_ec_employee','idx_ec_event_contract','idx_ec_period') ORDER BY name").all().map(row => row.name);
  const permissions = db.prepare("SELECT code FROM permissions WHERE code LIKE 'employment_contract.%' ORDER BY code").all().map(row => row.code);
  const grants = db.prepare("SELECT pr.code,COUNT(*) AS total FROM profile_permissions pp JOIN profiles pr ON pr.id=pp.profile_id JOIN permissions pm ON pm.id=pp.permission_id WHERE pm.code LIKE 'employment_contract.%' AND pp.allowed=1 GROUP BY pr.code ORDER BY pr.code").all();
  const contractForeignKeys = db.prepare('PRAGMA foreign_key_list(employment_contracts)').all().map(row => row.from).sort();
  console.log('EMPLOYMENT_SCHEMA_SNAPSHOT=' + JSON.stringify({ tables, indexes, permissions, grants, contractForeignKeys }));
  db.close();
`;

function startAndInspect() {
  const result = spawnSync(process.execPath, ['-e', startupProbe], {
    cwd: root,
    env: { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'Demarrage SQLite impossible');
  const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith('EMPLOYMENT_SCHEMA_SNAPSHOT='));
  assert(marker, `Snapshot SQLite absent: ${result.stdout}`);
  return JSON.parse(marker.slice('EMPLOYMENT_SCHEMA_SNAPSHOT='.length));
}

const firstStartup = startAndInspect();
const secondStartup = startAndInspect();
assert.deepStrictEqual(secondStartup, firstStartup, 'Le second demarrage ne doit modifier ni schema ni permissions');
assert.strictEqual(firstStartup.tables.length, requiredTables.length);
assert.deepStrictEqual(firstStartup.indexes, ['idx_ec_employee', 'idx_ec_event_contract', 'idx_ec_period']);
assert.strictEqual(firstStartup.permissions.length, 7);
assert.deepStrictEqual(firstStartup.contractForeignKeys, [
  'cancelled_by', 'created_by', 'employe_id', 'legacy_contract_id', 'parent_contract_id',
  'payroll_rule_set_id', 'submitted_by', 'template_version_id', 'validated_by',
]);
assert.deepStrictEqual(firstStartup.grants, [
  { code: 'admin', total: 7 },
  { code: 'dg', total: 3 },
  { code: 'rh', total: 5 },
]);

for (const suffix of ['', '-shm', '-wal']) {
  const file = `${dbPath}${suffix}`;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

console.log('employment_contract_schema_test: OK');

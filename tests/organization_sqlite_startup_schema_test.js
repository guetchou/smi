'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(os.tmpdir(), `smi-org-schema-${process.pid}-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = dbPath;

async function inspectDatabase({ seedHistoricalManager = false } = {}) {
  const db = require('../backend/database');
  const workflow = require('../backend/services/department_function_workflow');

  for (const table of [
    'org_unites',
    'org_departement_fonctions',
    'org_departement_fonction_events',
  ]) {
    assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} must exist`);
  }

  const functionColumns = new Set(
    db.prepare('PRAGMA table_info(org_departement_fonctions)').all().map(row => row.name),
  );
  for (const column of ['unite_id', 'poste_id', 'statut', 'version', 'document_url', 'effective_at']) {
    assert(functionColumns.has(column), `org_departement_fonctions.${column} must exist`);
  }

  const employeeColumns = new Set(db.prepare('PRAGMA table_info(employes)').all().map(row => row.name));
  assert(employeeColumns.has('poste_id'), 'employes.poste_id must exist');

  const indexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name),
  );
  assert(indexes.has('uq_org_df_singleton_active'));
  assert(indexes.has('uq_org_dfe_version_event'));

  const permissionCount = db.prepare(`
    SELECT COUNT(*) AS total FROM permissions
    WHERE code LIKE 'hr.department_function.%'
  `).get().total;
  assert.strictEqual(permissionCount, 8, 'all department function permissions must be registered');

  const adminGrantCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM profile_permissions pp
    JOIN profiles pr ON pr.id=pp.profile_id
    JOIN permissions pm ON pm.id=pp.permission_id
    WHERE pr.code='admin' AND pm.code LIKE 'hr.department_function.%' AND pp.allowed=1
  `).get().total;
  assert.strictEqual(adminGrantCount, 8, 'admin must receive every department function permission');

  if (seedHistoricalManager) {
    const employee = db.prepare(`
      SELECT id FROM employes WHERE actif=1 ORDER BY id LIMIT 1
    `).get();
    assert(employee, 'an active employee is required for the historical manager fixture');
    db.prepare(`
      INSERT OR IGNORE INTO org_departements (libelle, code, responsable_id, actif)
      VALUES ('Département idempotence E2E', 'IDEMP-E2E', ?, 1)
    `).run(employee.id);
    db.prepare(`
      UPDATE org_departements SET responsable_id=? WHERE code='IDEMP-E2E'
    `).run(employee.id);
  }

  const due = await workflow.processDue(null);
  assert.deepStrictEqual(due, {
    activated: [],
    closed: [],
    failed: [],
  });

  const snapshot = {
    functionCount: db.prepare(`
      SELECT COUNT(*) AS total
      FROM org_departement_fonctions f
      JOIN org_departements d ON d.id=f.departement_id
      WHERE d.code='IDEMP-E2E'
    `).get().total,
    legacyEventCount: db.prepare(`
      SELECT COUNT(*) AS total
      FROM org_departement_fonction_events ev
      JOIN org_departement_fonctions f ON f.id=ev.fonction_id
      JOIN org_departements d ON d.id=f.departement_id
      WHERE d.code='IDEMP-E2E' AND ev.event_type='legacy_import'
    `).get().total,
    permissionCount,
    adminGrantCount,
    organizationIndexCount: db.prepare(`
      SELECT COUNT(*) AS total FROM sqlite_master
      WHERE type='index' AND name LIKE 'idx_org_%' OR name LIKE 'uq_org_%'
    `).get().total,
    due,
  };
  db.close();
  return snapshot;
}

async function childMain() {
  const snapshot = await inspectDatabase({
    seedHistoricalManager: process.env.SMI_ORG_SCHEMA_SEED === '1',
  });
  console.log(`SMI_ORG_SCHEMA_SNAPSHOT=${JSON.stringify(snapshot)}`);
}

function runChild(extraEnv = {}) {
  const result = spawnSync(process.execPath, [__filename], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...extraEnv,
      DB_DRIVER: 'sqlite',
      DB_PATH: dbPath,
      SMI_ORG_SCHEMA_CHILD: '1',
    },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'SQLite child failed');
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('SMI_ORG_SCHEMA_SNAPSHOT='));
  assert(line, `missing SQLite snapshot in child output: ${result.stdout}`);
  return JSON.parse(line.slice('SMI_ORG_SCHEMA_SNAPSHOT='.length));
}

function main() {
  runChild({ SMI_ORG_SCHEMA_SEED: '1' });
  const firstStartup = runChild();
  const secondStartup = runChild();

  assert.strictEqual(firstStartup.functionCount, 1, 'historical manager must be imported once');
  assert.strictEqual(firstStartup.legacyEventCount, 1, 'legacy import event must be written once');
  assert.deepStrictEqual(secondStartup, firstStartup, 'second startup must not change schema reference data');

  for (const suffix of ['', '-shm', '-wal']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('OK - SQLite organization workflow startup schema is idempotent across two starts');
}

if (process.env.SMI_ORG_SCHEMA_CHILD === '1') {
  const keepAlive = setInterval(() => {}, 1000);
  childMain()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => clearInterval(keepAlive));
} else {
  main();
}

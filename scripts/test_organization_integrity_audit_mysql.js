'use strict';

process.env.DB_DRIVER = 'mysql';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../backend/db');
const integrity = require('../backend/services/organization_integrity_audit');

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const deptLabel = `CI Integrity ${suffix}`;
  const deptCode = `INT-${suffix}`.slice(0, 64);
  const managerMatricule = `IM-${suffix}`.slice(0, 64);
  const employeeMatricule = `IE-${suffix}`.slice(0, 64);
  let departmentId = null;
  let managerId = null;
  let employeeId = null;

  try {
    const department = await db.execute(
      'INSERT INTO org_departements (libelle, code, actif) VALUES (?, ?, 1)',
      [deptLabel, deptCode],
    );
    departmentId = department.insertId;

    const manager = await db.execute(`
      INSERT INTO employes
        (nom, prenom, poste, departement, site, matricule, actif, statut_dossier, date_embauche)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'actif', CURDATE())
    `, [`Manager-${suffix}`, 'CI', 'Manager', deptLabel, 'CI', managerMatricule]);
    managerId = manager.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (nom, prenom, poste, departement, site, matricule, actif, statut_dossier, date_embauche,
         superieur_id, superieur_hierarchique)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'actif', CURDATE(), NULL, '')
    `, [`Agent-${suffix}`, 'CI', 'Agent', deptLabel, 'CI', employeeMatricule]);
    employeeId = employee.insertId;

    await db.execute('UPDATE org_departements SET responsable_id=? WHERE id=?', [managerId, departmentId]);

    const before = await integrity.scanIntegrity();
    const planned = before.planned_changes.find(change => Number(change.employee_id) === Number(employeeId));
    assert(planned, 'employee repair must be planned');
    assert.strictEqual(Number(planned.new_supervisor_id), Number(managerId));

    let rollbackError = null;
    try {
      await integrity.repairIntegrity({
        dryRun: false,
        actorUserId: null,
        failAfterEmployeeUpdate: true,
      });
    } catch (error) {
      rollbackError = error;
    }
    assert(rollbackError, 'forced integrity failure expected');
    assert.strictEqual(rollbackError.message, 'ORG_INTEGRITY_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE');

    const afterRollback = await db.queryOne(
      'SELECT superieur_id, superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    assert.strictEqual(afterRollback.superieur_id, null, 'employee supervisor update must rollback');
    assert.strictEqual(String(afterRollback.superieur_hierarchique || ''), '', 'employee supervisor name must rollback');

    const rollbackMutations = await db.queryOne(
      'SELECT COUNT(*) AS total FROM employes_mutations WHERE employe_id=?',
      [employeeId],
    );
    assert.strictEqual(Number(rollbackMutations.total), 0, 'mutation log must rollback');

    const rollbackAudits = await db.queryOne(
      "SELECT COUNT(*) AS total FROM audit_logs WHERE table_name='employes' AND record_id=? AND action='organization_integrity_repair'",
      [employeeId],
    );
    assert.strictEqual(Number(rollbackAudits.total), 0, 'repair audit must rollback');

    const repaired = await integrity.repairIntegrity({ dryRun: false, actorUserId: null });
    assert(repaired.applied_changes.some(change => Number(change.employee_id) === Number(employeeId)));

    const afterCommit = await db.queryOne(
      'SELECT superieur_id, superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    assert.strictEqual(Number(afterCommit.superieur_id), Number(managerId));
    assert(String(afterCommit.superieur_hierarchique || '').includes(`Manager-${suffix}`));

    const committedMutations = await db.queryOne(
      'SELECT COUNT(*) AS total FROM employes_mutations WHERE employe_id=?',
      [employeeId],
    );
    assert(Number(committedMutations.total) >= 1, 'repair mutation log expected');

    const committedAudits = await db.queryOne(
      "SELECT COUNT(*) AS total FROM audit_logs WHERE table_name='employes' AND record_id=? AND action='organization_integrity_repair'",
      [employeeId],
    );
    assert(Number(committedAudits.total) >= 1, 'repair audit expected');

    console.log('organization_integrity_audit_mysql: OK');
  } finally {
    if (employeeId) {
      await db.execute("DELETE FROM audit_logs WHERE (table_name='employes' AND record_id=?) OR (table_name='organization_integrity' AND action='repair_run')", [employeeId]);
      await db.execute('DELETE FROM employes_mutations WHERE employe_id=?', [employeeId]);
    }
    if (departmentId) await db.execute('UPDATE org_departements SET responsable_id=NULL WHERE id=?', [departmentId]);
    if (employeeId) await db.execute('DELETE FROM employes WHERE id=?', [employeeId]);
    if (managerId) await db.execute('DELETE FROM employes WHERE id=?', [managerId]);
    if (departmentId) await db.execute('DELETE FROM org_departements WHERE id=?', [departmentId]);
  }
}

main()
  .then(async () => {
    await db._pool.end();
    execFileSync(process.execPath, [path.join(__dirname, 'test_organization_assignment_mysql.js')], {
      stdio: 'inherit',
      env: { ...process.env, DB_DRIVER: 'mysql' },
    });
  })
  .catch(async error => {
    console.error(error.stack || error.message);
    try { await db._pool.end(); } catch (_) {}
    process.exitCode = 1;
  });

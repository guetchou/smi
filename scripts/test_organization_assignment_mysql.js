'use strict';

process.env.DB_DRIVER = 'mysql';
const assert = require('assert');
const db = require('../backend/db');
const { createOrganizationAssignmentService } = require('../backend/services/organization_assignment');

async function main() {
  const organization = createOrganizationAssignmentService(db);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const deptLabel = `CI Assignment ${suffix}`;
  const deptCode = `ASG-${suffix}`.slice(0, 64);
  const managerMatricule = `AM-${suffix}`.slice(0, 64);
  const employeeMatricule = `AE-${suffix}`.slice(0, 64);
  let departmentId = null;
  let managerId = null;
  let employeeId = null;

  try {
    const department = await db.execute(
      'INSERT INTO org_departements (libelle, code, actif, responsable_id) VALUES (?, ?, 1, NULL)',
      [deptLabel, deptCode],
    );
    departmentId = department.insertId;

    const manager = await db.execute(`
      INSERT INTO employes
        (nom, prenom, poste, departement, site, matricule, actif, statut_dossier, date_embauche,
         superieur_id, superieur_hierarchique)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'actif', CURDATE(), NULL, '')
    `, [`Manager-${suffix}`, 'CI', 'Manager', deptLabel, 'CI', managerMatricule]);
    managerId = manager.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (nom, prenom, poste, departement, site, matricule, actif, statut_dossier, date_embauche,
         superieur_id, superieur_hierarchique)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'actif', CURDATE(), NULL, '')
    `, [`Agent-${suffix}`, 'CI', 'Agent', deptLabel, 'CI', employeeMatricule]);
    employeeId = employee.insertId;

    let rollbackError = null;
    try {
      await organization.synchronizeDepartmentManager({
        departmentId,
        managerId,
        actorUserId: null,
        motif: 'CI forced rollback',
        failAfterDepartmentUpdate: true,
      });
    } catch (error) {
      rollbackError = error;
    }

    assert(rollbackError, 'forced organization assignment failure expected');
    assert.strictEqual(rollbackError.message, 'ORG_ASSIGNMENT_TEST_FAILURE_AFTER_DEPARTMENT_UPDATE');

    const departmentAfterRollback = await db.queryOne(
      'SELECT responsable_id FROM org_departements WHERE id=?',
      [departmentId],
    );
    assert.strictEqual(departmentAfterRollback.responsable_id, null, 'department manager update must rollback');

    const employeeAfterRollback = await db.queryOne(
      'SELECT superieur_id, superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    assert.strictEqual(employeeAfterRollback.superieur_id, null, 'employee supervisor must stay unchanged after rollback');
    assert.strictEqual(String(employeeAfterRollback.superieur_hierarchique || ''), '');

    const mutationsAfterRollback = await db.queryOne(
      'SELECT COUNT(*) AS total FROM employes_mutations WHERE employe_id=?',
      [employeeId],
    );
    assert.strictEqual(Number(mutationsAfterRollback.total), 0, 'mutation history must rollback');

    const result = await organization.synchronizeDepartmentManager({
      departmentId,
      managerId,
      actorUserId: null,
      motif: 'CI committed synchronization',
    });
    assert.strictEqual(Number(result.manager.id), Number(managerId));
    assert.strictEqual(Number(result.changedAgents), 1);

    const departmentAfterCommit = await db.queryOne(
      'SELECT responsable_id FROM org_departements WHERE id=?',
      [departmentId],
    );
    assert.strictEqual(Number(departmentAfterCommit.responsable_id), Number(managerId));

    const employeeAfterCommit = await db.queryOne(
      'SELECT superieur_id, superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    assert.strictEqual(Number(employeeAfterCommit.superieur_id), Number(managerId));
    assert(String(employeeAfterCommit.superieur_hierarchique || '').includes(`Manager-${suffix}`));

    const committedMutations = await db.queryOne(
      'SELECT COUNT(*) AS total FROM employes_mutations WHERE employe_id=?',
      [employeeId],
    );
    assert(Number(committedMutations.total) >= 1, 'committed supervisor mutation expected');

    console.log('organization_assignment_mysql: OK');
  } finally {
    if (employeeId) await db.execute('DELETE FROM employes_mutations WHERE employe_id=?', [employeeId]);
    if (managerId) await db.execute('DELETE FROM employes_mutations WHERE employe_id=?', [managerId]);
    if (departmentId) await db.execute('UPDATE org_departements SET responsable_id=NULL WHERE id=?', [departmentId]);
    if (employeeId) await db.execute('DELETE FROM employes WHERE id=?', [employeeId]);
    if (managerId) await db.execute('DELETE FROM employes WHERE id=?', [managerId]);
    if (departmentId) await db.execute('DELETE FROM org_departements WHERE id=?', [departmentId]);
  }
}

main()
  .then(() => db._pool.end())
  .catch(async error => {
    console.error(error.stack || error.message);
    try { await db._pool.end(); } catch (_) {}
    process.exitCode = 1;
  });

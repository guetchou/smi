'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { createOrganizationMutationWorkflow, STATUS } = require('../backend/services/organization_mutation_workflow');

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const suffix = unique('org_mutation');
  let rhUserId = null;
  let dgUserId = null;
  let managerId = null;
  let employeeId = null;
  let mutationId = null;

  try {
    const rh = await db.execute(
      "INSERT INTO users (nom,email,password_hash,role,actif,created_at) VALUES (?,?,?,'rh',1,NOW())",
      [`RH ${suffix}`, `rh-${suffix}@example.test`, 'not-used-in-test'],
    );
    rhUserId = rh.insertId;
    const dg = await db.execute(
      "INSERT INTO users (nom,email,password_hash,role,actif,created_at) VALUES (?,?,?,'dg',1,NOW())",
      [`DG ${suffix}`, `dg-${suffix}@example.test`, 'not-used-in-test'],
    );
    dgUserId = dg.insertId;

    const manager = await db.execute(`
      INSERT INTO employes
        (matricule,nom,prenom,poste,departement,site,actif,statut_dossier,created_at,updated_at)
      VALUES (?, 'Manager', 'CI', 'Chef cible', 'CI Target', 'Site B', 1, 'actif', NOW(), NOW())
    `, [`MGR-${suffix}`]);
    managerId = manager.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule,nom,prenom,poste,departement,site,superieur_id,superieur_hierarchique,
         actif,statut_dossier,created_at,updated_at)
      VALUES (?, 'Agent', 'Mutation', 'Ancien poste', 'CI Source', 'Site A', NULL, '', 1, 'actif', NOW(), NOW())
    `, [`EMP-${suffix}`]);
    employeeId = employee.insertId;

    const organization = {
      activeDepartmentByLabel(label) {
        return label === 'CI Target'
          ? { id: 999999, libelle: 'CI Target', responsable_id: managerId, actif: 1 }
          : null;
      },
      assertManagerActive(id) {
        if (Number(id) !== Number(managerId)) throw new Error('unexpected manager');
        return {
          id: managerId,
          nom: 'Manager',
          prenom: 'CI',
          poste: 'Chef cible',
          departement: 'CI Target',
          site: 'Site B',
        };
      },
      assertNoCycle() {},
    };
    const workflow = createOrganizationMutationWorkflow(db, organization);

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const draft = await workflow.createDraft({
      employe_id: employeeId,
      nouveau_poste: 'Nouveau poste',
      nouveau_dept: 'CI Target',
      nouveau_site: 'Site B',
      date_effective: tomorrow,
      motif: 'Test transaction mutation',
    }, rhUserId);
    mutationId = draft.id;
    assert.strictEqual(draft.statut, STATUS.DRAFT);

    const submitted = await workflow.submit(mutationId, rhUserId);
    assert.strictEqual(submitted.statut, STATUS.SUBMITTED);

    let selfApproval = null;
    try {
      await workflow.approve(mutationId, rhUserId);
    } catch (error) {
      selfApproval = error;
    }
    assert(selfApproval, 'self approval must fail');
    assert.strictEqual(selfApproval.code, 'SELF_APPROVAL_FORBIDDEN');

    const approved = await workflow.approve(mutationId, dgUserId);
    assert.strictEqual(approved.statut, STATUS.APPROVED);

    const today = new Date().toISOString().slice(0, 10);
    await db.execute(
      'UPDATE employes_mutations SET date_effet=?, date_effective=? WHERE id=?',
      [today, today, mutationId],
    );

    let forcedFailure = null;
    try {
      await workflow.apply(mutationId, dgUserId, { failAfterEmployeeUpdate: true });
    } catch (error) {
      forcedFailure = error;
    }
    assert(forcedFailure, 'forced transaction failure did not throw');
    assert.strictEqual(forcedFailure.message, 'ORG_MUTATION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE');

    const employeeAfterRollback = await db.queryOne(
      'SELECT poste,departement,site,superieur_id,superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    const mutationAfterRollback = await db.queryOne('SELECT statut FROM employes_mutations WHERE id=?', [mutationId]);
    const auditAfterRollback = await db.queryOne(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE table_name='employes_mutations' AND record_id=? AND action='mutation_effective'",
      [mutationId],
    );
    assert.strictEqual(employeeAfterRollback.poste, 'Ancien poste');
    assert.strictEqual(employeeAfterRollback.departement, 'CI Source');
    assert.strictEqual(employeeAfterRollback.site, 'Site A');
    assert.strictEqual(employeeAfterRollback.superieur_id, null);
    assert.strictEqual(mutationAfterRollback.statut, STATUS.APPROVED);
    assert.strictEqual(Number(auditAfterRollback.c), 0, 'audit leaked after rollback');

    const effective = await workflow.apply(mutationId, dgUserId);
    assert.strictEqual(effective.statut, STATUS.EFFECTIVE);

    const employeeAfterCommit = await db.queryOne(
      'SELECT poste,departement,site,superieur_id,superieur_hierarchique FROM employes WHERE id=?',
      [employeeId],
    );
    const auditAfterCommit = await db.queryOne(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE table_name='employes_mutations' AND record_id=? AND action='mutation_effective'",
      [mutationId],
    );
    assert.strictEqual(employeeAfterCommit.poste, 'Nouveau poste');
    assert.strictEqual(employeeAfterCommit.departement, 'CI Target');
    assert.strictEqual(employeeAfterCommit.site, 'Site B');
    assert.strictEqual(Number(employeeAfterCommit.superieur_id), Number(managerId));
    assert.strictEqual(employeeAfterCommit.superieur_hierarchique, 'Manager CI');
    assert.strictEqual(Number(auditAfterCommit.c), 1, 'mutation effective audit missing');

    console.log('test_organization_mutation_mysql: OK');
  } finally {
    if (mutationId) {
      await db.execute("DELETE FROM audit_logs WHERE table_name='employes_mutations' AND record_id=?", [mutationId]);
      await db.execute('DELETE FROM employes_mutations WHERE id=?', [mutationId]);
    }
    if (employeeId) await db.execute('DELETE FROM employes WHERE id=?', [employeeId]);
    if (managerId) await db.execute('DELETE FROM employes WHERE id=?', [managerId]);
    if (rhUserId) await db.execute('DELETE FROM users WHERE id=?', [rhUserId]);
    if (dgUserId) await db.execute('DELETE FROM users WHERE id=?', [dgUserId]);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

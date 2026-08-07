'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { applyRevisionInTransaction } = require('../backend/routes/revisions_salaire');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup({ revisionId, employeeId, userId }) {
  if (revisionId) {
    await db.execute('DELETE FROM historique_salaires WHERE demande_revision_id = ?', [revisionId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'demandes_revision_salaire' AND record_id = ?", [revisionId]);
    await db.execute('DELETE FROM demandes_revision_salaire WHERE id = ?', [revisionId]);
  }
  if (employeeId) {
    await db.execute('DELETE FROM historique_salaires WHERE employe_id = ?', [employeeId]);
    await db.execute('DELETE FROM employes WHERE id = ?', [employeeId]);
  }
  if (userId) {
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  }
}

async function applyRevisionTransaction(revision, userId, options = {}) {
  return db.transaction(tx => applyRevisionInTransaction(tx, revision, userId, options));
}

async function main() {
  const suffix = uniq('salary_revision_atomicity');
  let userId = null;
  let employeeId = null;
  let revisionId = null;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'dg', 1, NOW())
    `, ['Test DG revision', `${suffix}@example.test`, 'not-used-in-test']);
    userId = user.insertId;
    assert(userId, 'test user not created');

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, salaire_base, prime_transport, prime_logement,
         statut_dossier, actif, created_at, updated_at)
      VALUES (?, 'Agent', 'Revision', 300000, 20000, 15000, 'actif', 1, NOW(), NOW())
    `, [suffix]);
    employeeId = employee.insertId;
    assert(employeeId, 'test employee not created');

    const revisionInsert = await db.execute(`
      INSERT INTO demandes_revision_salaire
        (employe_id, type_revision, date_effet,
         salaire_actuel, salaire_propose,
         transport_actuel, transport_propose,
         logement_actuel, logement_propose,
         motif, statut, created_by, updated_at)
      VALUES (?, 'augmentation', '2026-08-01', 300000, 350000, 20000, 25000,
              15000, 18000, 'Test atomicité', 'approuve', ?, NOW())
    `, [employeeId, userId]);
    revisionId = revisionInsert.insertId;
    assert(revisionId, 'test revision not created');

    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [revisionId]);
    assert(revision, 'test revision unreadable');

    let forcedError = null;
    try {
      await applyRevisionTransaction(revision, userId, { failAfterEmployeeUpdate: true });
    } catch (error) {
      forcedError = error;
    }
    assert(forcedError, 'forced failure did not throw');
    assert.strictEqual(forcedError.message, 'SALARY_REVISION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE');

    const employeeAfterRollback = await db.queryOne(
      'SELECT salaire_base, prime_transport, prime_logement FROM employes WHERE id = ?',
      [employeeId],
    );
    const revisionAfterRollback = await db.queryOne('SELECT statut FROM demandes_revision_salaire WHERE id = ?', [revisionId]);
    const historyAfterRollback = await db.query('SELECT id FROM historique_salaires WHERE demande_revision_id = ?', [revisionId]);
    assert.strictEqual(Number(employeeAfterRollback.salaire_base), 300000, 'salary leaked after rollback');
    assert.strictEqual(Number(employeeAfterRollback.prime_transport), 20000, 'transport leaked after rollback');
    assert.strictEqual(Number(employeeAfterRollback.prime_logement), 15000, 'housing leaked after rollback');
    assert.strictEqual(revisionAfterRollback.statut, 'approuve', 'revision status leaked after rollback');
    assert.strictEqual(historyAfterRollback.length, 0, 'salary history leaked after rollback');

    await applyRevisionTransaction(revision, userId);

    const employeeAfterCommit = await db.queryOne(
      'SELECT salaire_base, prime_transport, prime_logement FROM employes WHERE id = ?',
      [employeeId],
    );
    const revisionAfterCommit = await db.queryOne('SELECT statut FROM demandes_revision_salaire WHERE id = ?', [revisionId]);
    const historyAfterCommit = await db.queryOne('SELECT id FROM historique_salaires WHERE demande_revision_id = ?', [revisionId]);
    const auditAfterCommit = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name='demandes_revision_salaire' AND record_id=? AND action='appliquer'",
      [revisionId],
    );
    assert.strictEqual(Number(employeeAfterCommit.salaire_base), 350000, 'salary commit missing');
    assert.strictEqual(Number(employeeAfterCommit.prime_transport), 25000, 'transport commit missing');
    assert.strictEqual(Number(employeeAfterCommit.prime_logement), 18000, 'housing commit missing');
    assert.strictEqual(revisionAfterCommit.statut, 'applique', 'revision status commit missing');
    assert(historyAfterCommit, 'salary history commit missing');
    assert(auditAfterCommit, 'salary revision audit missing');

    console.log('test_salary_revision_mysql: OK');
  } finally {
    await cleanup({ revisionId, employeeId, userId });
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

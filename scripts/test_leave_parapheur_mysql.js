'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { createLeaveRequest } = require('../backend/services/leave_workflow');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function removeLeave(leaveId) {
  const parapheurs = await db.query(
    "SELECT id FROM parapheur WHERE ref_source_table = 'employes_conges' AND ref_source_id = ?",
    [leaveId],
  );
  for (const item of parapheurs) {
    await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [item.id]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [item.id]);
    await db.execute('DELETE FROM parapheur WHERE id = ?', [item.id]);
  }
  await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_conges' AND record_id = ?", [leaveId]);
  await db.execute('DELETE FROM employes_conges WHERE id = ?', [leaveId]);
}

async function cleanup(employeeId, userId) {
  if (employeeId) {
    const leaves = await db.query('SELECT id FROM employes_conges WHERE employe_id = ?', [employeeId]);
    for (const leave of leaves) await removeLeave(leave.id);
    await db.execute('DELETE FROM employes WHERE id = ?', [employeeId]);
  }
  if (userId) {
    const orphans = await db.query(
      "SELECT id FROM parapheur WHERE ref_source_table = 'employes_conges' AND initiateur_id = ?",
      [userId],
    );
    for (const item of orphans) {
      await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [item.id]);
      await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [item.id]);
      await db.execute('DELETE FROM parapheur WHERE id = ?', [item.id]);
    }
    await db.execute('DELETE FROM notif_messages WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  }
}

async function main() {
  const suffix = uniq('leave_atomicity');
  let userId;
  let employeeId;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'rh', 1, NOW())
    `, ['Test congé atomique', `${suffix}@example.test`, 'not-used-in-test']);
    userId = user.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, date_embauche, salaire_base, statut_dossier, actif, created_at, updated_at)
      VALUES (?, 'Agent', 'Congé', '2020-01-01', 300000, 'actif', 1, NOW(), NOW())
    `, [suffix]);
    employeeId = employee.insertId;
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);

    const success = await createLeaveRequest({
      employee: agent,
      payload: {
        type_conge: 'autre',
        date_debut: '2026-08-10',
        date_fin: '2026-08-12',
        motif: 'Test atomique',
      },
      actorId: userId,
    });

    const leave = await db.queryOne('SELECT id FROM employes_conges WHERE id = ?', [success.id]);
    const parapheur = await db.queryOne('SELECT id FROM parapheur WHERE id = ?', [success.parapheurId]);
    const action = await db.queryOne('SELECT id FROM parapheur_actions WHERE parapheur_id = ?', [success.parapheurId]);
    const leaveAudit = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'employes_conges' AND record_id = ? AND action = 'create'",
      [success.id],
    );
    const connectorAudit = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ? AND action = 'connector_created'",
      [success.parapheurId],
    );
    assert(leave && parapheur && action && leaveAudit && connectorAudit, 'successful leave transaction incomplete');
    await removeLeave(success.id);

    let forcedError;
    try {
      await createLeaveRequest({
        employee: agent,
        payload: {
          type_conge: 'autre',
          date_debut: '2026-09-10',
          date_fin: '2026-09-11',
        },
        actorId: userId,
        failAfterLeave: true,
      });
    } catch (error) {
      forcedError = error;
    }
    assert(forcedError, 'forced leave failure did not throw');
    assert.strictEqual(forcedError.message, 'LEAVE_TEST_FAILURE_AFTER_INSERT');

    const remainingLeaves = await db.query('SELECT id FROM employes_conges WHERE employe_id = ?', [employeeId]);
    const orphanParapheurs = await db.query(
      "SELECT id FROM parapheur WHERE ref_source_table = 'employes_conges' AND initiateur_id = ?",
      [userId],
    );
    assert.strictEqual(remainingLeaves.length, 0, 'leave remained after rollback');
    assert.strictEqual(orphanParapheurs.length, 0, 'leave parapheur remained after rollback');

    console.log('test_leave_parapheur_mysql: OK');
  } finally {
    await cleanup(employeeId, userId);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { createLeaveRequest } = require('../backend/services/leave_workflow');
const {
  approveLeave,
  cancelLeave,
  finishLeave,
  rejectLeave,
  validateBySupervisor,
} = require('../backend/services/leave_transition_workflow');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function removeLeave(leaveId) {
  await db.execute(
    "DELETE FROM notif_messages WHERE src_table = 'employes_conges' AND src_id = ?",
    [leaveId],
  );
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

async function createTestLeave(agent, userId, payload) {
  return createLeaveRequest({
    employee: agent,
    payload,
    actorId: userId,
    isAdmin: true,
  });
}

async function auditActions(leaveId) {
  const audits = await db.query(
    `SELECT action
     FROM audit_logs
     WHERE table_name = 'employes_conges'
       AND record_id = ?`,
    [leaveId],
  );
  return audits.map(row => row.action);
}

async function assertSingleAudit(leaveId, action) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total
     FROM audit_logs
     WHERE table_name = 'employes_conges'
       AND record_id = ?
       AND action = ?`,
    [leaveId, action],
  );
  assert.strictEqual(Number(row.total), 1, `expected one audit ${action}`);
}

async function notificationTargetCount() {
  const users = await db.query('SELECT role, roles FROM users WHERE actif = 1');
  return users.filter((user) => {
    let extra = [];
    try { extra = user.roles ? JSON.parse(user.roles) : []; } catch (_) { extra = []; }
    const roles = new Set([user.role, ...extra].filter(Boolean));
    return roles.has('admin') || roles.has('dg') || roles.has('rh');
  }).length;
}

async function assertNotification(leaveId, type) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total
     FROM notif_messages
     WHERE src_table = 'employes_conges'
       AND src_id = ?
     AND type = ?`,
    [leaveId, type],
  );
  const expected = await notificationTargetCount();
  assert(expected >= 1, 'expected at least one leave notification target');
  assert.strictEqual(Number(row.total), expected, `unexpected notification count for ${type}`);
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
      VALUES (?, ?, ?, 'admin', 1, NOW())
    `, ['Test congé atomique', `${suffix}@example.test`, 'not-used-in-test']);
    userId = user.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, date_embauche, salaire_base, statut_dossier, actif, created_at, updated_at)
      VALUES (?, 'Agent', 'Congé', '2020-01-01', 300000, 'actif', 1, NOW(), NOW())
    `, [suffix]);
    employeeId = employee.insertId;
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);
    const actor = await db.queryOne(
      'SELECT id, role, roles, employe_id FROM users WHERE id = ?',
      [userId],
    );

    const success = await createTestLeave(agent, userId, {
      type_conge: 'annuel',
      date_debut: '2026-08-10',
      date_fin: '2026-08-12',
      motif: 'Test atomique',
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

    const validated = await validateBySupervisor({
      employeeId,
      leaveId: success.id,
      actor,
      notes: 'Validation MySQL CI',
    });
    assert.strictEqual(validated.statut, 'valide_sup');

    const approved = await approveLeave({
      employeeId,
      leaveId: success.id,
      actorId: userId,
    });
    assert.strictEqual(approved.statut, 'approuve');
    assert.strictEqual(Number(approved.counters.pris), 3);

    const finished = await finishLeave({
      employeeId,
      leaveId: success.id,
      actorId: userId,
    });
    assert.strictEqual(finished.statut, 'termine');
    assert.strictEqual(Number(finished.counters.pris), 3);

    const finalLeave = await db.queryOne(
      `SELECT statut, valide_sup_par, valide_sup_at,
              approuve_par, approuve_at
       FROM employes_conges
       WHERE id = ?`,
      [success.id],
    );

    assert.strictEqual(finalLeave.statut, 'termine');
    assert(finalLeave.valide_sup_par);
    assert(finalLeave.valide_sup_at);
    assert(finalLeave.approuve_par);
    assert(finalLeave.approuve_at);

    const counters = await db.queryOne(
      'SELECT conges_pris_annuel, conges_solde_annuel FROM employes WHERE id = ?',
      [employeeId],
    );
    assert.strictEqual(Number(counters.conges_pris_annuel), 3);
    assert(Number(counters.conges_solde_annuel) <= 27);

    const actions = await auditActions(success.id);
    for (const auditAction of ['create', 'valide_sup', 'approuve', 'termine']) {
      assert(actions.includes(auditAction), `missing audit action: ${auditAction}`);
      await assertSingleAudit(success.id, auditAction);
    }

    await assertNotification(success.id, 'NOTIF_CONGE_VALIDE_SUP');
    await assertNotification(success.id, 'NOTIF_CONGE_APPROUVE');
    await assertNotification(success.id, 'NOTIF_CONGE_TERMINE');
    await removeLeave(success.id);

    const rejectedLeave = await createTestLeave(agent, userId, {
      type_conge: 'autre',
      date_debut: '2026-10-10',
      date_fin: '2026-10-11',
      motif: 'Test refus MySQL',
    });

    await validateBySupervisor({
      employeeId,
      leaveId: rejectedLeave.id,
      actor,
      notes: 'Validation avant refus',
    });

    const rejected = await rejectLeave({
      employeeId,
      leaveId: rejectedLeave.id,
      actorId: userId,
      reason: 'Refus MySQL CI',
    });
    assert.strictEqual(rejected.statut, 'refuse');
    await assertSingleAudit(rejectedLeave.id, 'refuse');
    await assertNotification(rejectedLeave.id, 'NOTIF_CONGE_REFUSE');
    await removeLeave(rejectedLeave.id);

    const cancelledLeave = await createTestLeave(agent, userId, {
      type_conge: 'autre',
      date_debut: '2026-11-10',
      date_fin: '2026-11-11',
      motif: 'Test annulation MySQL',
    });

    const cancelled = await cancelLeave({
      employeeId,
      leaveId: cancelledLeave.id,
      actorId: userId,
      reason: 'Annulation MySQL CI',
    });
    assert.strictEqual(cancelled.statut, 'annule');
    await assertSingleAudit(cancelledLeave.id, 'annule');
    await assertNotification(cancelledLeave.id, 'NOTIF_CONGE_ANNULE');
    await removeLeave(cancelledLeave.id);

    const concurrentLeave = await createTestLeave(agent, userId, {
      type_conge: 'autre',
      date_debut: '2026-12-10',
      date_fin: '2026-12-11',
      motif: 'Test concurrence',
    });

    await validateBySupervisor({
      employeeId,
      leaveId: concurrentLeave.id,
      actor,
      notes: 'Prêt concurrence',
    });

    const results = await Promise.allSettled([
      approveLeave({
        employeeId,
        leaveId: concurrentLeave.id,
        actorId: userId,
      }),
      approveLeave({
        employeeId,
        leaveId: concurrentLeave.id,
        actorId: userId,
      }),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejectedResults = results.filter(result => result.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'exactly one approval must succeed');
    assert.strictEqual(rejectedResults.length, 1, 'exactly one approval must fail');
    assert.strictEqual(rejectedResults[0].reason.status, 409);
    assert.strictEqual(fulfilled[0].value.statut, 'approuve');

    const concurrentFinal = await db.queryOne(
      'SELECT statut FROM employes_conges WHERE id = ?',
      [concurrentLeave.id],
    );
    assert.strictEqual(concurrentFinal.statut, 'approuve');

    await assertSingleAudit(concurrentLeave.id, 'approuve');
    await assertNotification(concurrentLeave.id, 'NOTIF_CONGE_APPROUVE');
    await removeLeave(concurrentLeave.id);

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

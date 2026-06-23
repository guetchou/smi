'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { submitSalaryAdvance } = require('../backend/services/salary_advance_workflow');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function removeParapheurs(advanceId) {
  const items = await db.query(
    "SELECT id FROM parapheur WHERE ref_source_table = 'employes_avances' AND ref_source_id = ?",
    [advanceId],
  );
  for (const item of items) {
    await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [item.id]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [item.id]);
    await db.execute('DELETE FROM parapheur WHERE id = ?', [item.id]);
  }
}

async function cleanup(advanceId, employeeId, userId) {
  if (advanceId) {
    await removeParapheurs(advanceId);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_avances' AND record_id = ?", [advanceId]);
    await db.execute('DELETE FROM employes_avances WHERE id = ?', [advanceId]);
  }
  if (employeeId) await db.execute('DELETE FROM employes WHERE id = ?', [employeeId]);
  if (userId) {
    await db.execute('DELETE FROM notif_messages WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  }
}

async function main() {
  const suffix = uniq('advance_atomicity');
  let userId;
  let employeeId;
  let advanceId;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'rh', 1, NOW())
    `, ['Test avance atomique', `${suffix}@example.test`, 'not-used-in-test']);
    userId = user.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, date_embauche, salaire_base, statut_dossier, actif, created_at, updated_at)
      VALUES (?, 'Agent', 'Avance', '2020-01-01', 300000, 'actif', 1, NOW(), NOW())
    `, [suffix]);
    employeeId = employee.insertId;
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);

    const advance = await db.execute(`
      INSERT INTO employes_avances
        (employe_id, date, montant, motif, statut, nb_echeances,
         montant_echeance, solde_restant, statut_workflow, created_by, created_at)
      VALUES (?, '2026-06-23', 120000, 'Test atomique', 'en_cours', 3,
              40000, 120000, 'brouillon', ?, NOW())
    `, [employeeId, userId]);
    advanceId = advance.insertId;

    const success = await submitSalaryAdvance({
      employee: agent,
      advanceId,
      actorId: userId,
    });
    assert.strictEqual(success.statut_workflow, 'soumis');
    assert(success.parapheurId, 'advance parapheur missing');

    const stored = await db.queryOne('SELECT statut_workflow FROM employes_avances WHERE id = ?', [advanceId]);
    const parapheur = await db.queryOne('SELECT id FROM parapheur WHERE id = ?', [success.parapheurId]);
    const action = await db.queryOne('SELECT id FROM parapheur_actions WHERE parapheur_id = ?', [success.parapheurId]);
    const advanceAudit = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'employes_avances' AND record_id = ? AND action = 'soumettre'",
      [advanceId],
    );
    const connectorAudit = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ? AND action = 'connector_created'",
      [success.parapheurId],
    );
    assert(stored?.statut_workflow === 'soumis' && parapheur && action && advanceAudit && connectorAudit,
      'successful advance transaction incomplete');

    await removeParapheurs(advanceId);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_avances' AND record_id = ?", [advanceId]);
    await db.execute("UPDATE employes_avances SET statut_workflow = 'brouillon', updated_at = NOW() WHERE id = ?", [advanceId]);

    let forcedError;
    try {
      await submitSalaryAdvance({
        employee: agent,
        advanceId,
        actorId: userId,
        failAfterStatus: true,
      });
    } catch (error) {
      forcedError = error;
    }
    assert(forcedError, 'forced advance failure did not throw');
    assert.strictEqual(forcedError.message, 'ADVANCE_TEST_FAILURE_AFTER_STATUS');

    const rolledBack = await db.queryOne('SELECT statut_workflow FROM employes_avances WHERE id = ?', [advanceId]);
    const orphanParapheurs = await db.query(
      "SELECT id FROM parapheur WHERE ref_source_table = 'employes_avances' AND ref_source_id = ?",
      [advanceId],
    );
    assert.strictEqual(rolledBack?.statut_workflow, 'brouillon', 'advance status did not roll back');
    assert.strictEqual(orphanParapheurs.length, 0, 'advance parapheur remained after rollback');

    console.log('test_salary_advance_parapheur_mysql: OK');
  } finally {
    await cleanup(advanceId, employeeId, userId);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

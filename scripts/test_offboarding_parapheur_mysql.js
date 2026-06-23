'use strict';

/**
 * Scénario MySQL réel pour la transaction offboarding → parapheur.
 * À exécuter après les migrations sur une base CI isolée.
 */
process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { initiateOffboarding } = require('../backend/routes/offboarding_parapheur_required_safe');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup({ employeeId, userId }) {
  if (employeeId) {
    const dossiers = await db.query('SELECT id FROM employes_sortie WHERE employe_id = ?', [employeeId]);
    for (const dossier of dossiers) {
      const parapheurs = await db.query(
        "SELECT id FROM parapheur WHERE ref_source_table = 'employes_sortie' AND ref_source_id = ?",
        [dossier.id],
      );
      for (const parapheur of parapheurs) {
        await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [parapheur.id]);
        await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [parapheur.id]);
        await db.execute('DELETE FROM parapheur WHERE id = ?', [parapheur.id]);
      }
      await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_sortie' AND record_id = ?", [dossier.id]);
      await db.execute('DELETE FROM employes_sortie WHERE id = ?', [dossier.id]);
    }
    await db.execute('DELETE FROM employes WHERE id = ?', [employeeId]);
  }
  if (userId) {
    await db.execute('DELETE FROM notif_messages WHERE user_id = ?', [userId]);
    await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  }
}

async function main() {
  const suffix = uniq('offboarding_atomicity');
  let userId = null;
  let employeeId = null;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'rh', 1, NOW())
    `, ['Test RH atomique', `${suffix}@example.test`, 'not-used-in-test']);
    userId = user.insertId;
    assert(userId, 'test user not created');

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, date_embauche, salaire_base, statut_dossier, actif, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'actif', 1, NOW(), NOW())
    `, [suffix, 'Agent', 'Atomique', '2020-01-01', 300000]);
    employeeId = employee.insertId;
    assert(employeeId, 'test employee not created');

    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);
    assert(agent, 'test employee unreadable');

    const success = await initiateOffboarding({
      agent,
      payload: {
        type_sortie: 'fin_contrat',
        date_annonce: '2026-06-01',
        date_depart_effectif: '2026-06-30',
        autres_indemnites: 10000,
      },
      actorId: userId,
    });

    assert(success.id, 'offboarding dossier id missing');
    assert(success.parapheurId, 'parapheur id missing');

    const dossier = await db.queryOne('SELECT id FROM employes_sortie WHERE id = ?', [success.id]);
    const parapheur = await db.queryOne('SELECT id FROM parapheur WHERE id = ?', [success.parapheurId]);
    const action = await db.queryOne('SELECT id FROM parapheur_actions WHERE parapheur_id = ?', [success.parapheurId]);
    const auditOffboarding = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'employes_sortie' AND record_id = ? AND action = 'initier'",
      [success.id],
    );
    const auditConnector = await db.queryOne(
      "SELECT id FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ? AND action = 'connector_created'",
      [success.parapheurId],
    );
    assert(dossier && parapheur && action && auditOffboarding && auditConnector, 'successful transaction incomplete');

    await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [success.parapheurId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [success.parapheurId]);
    await db.execute('DELETE FROM parapheur WHERE id = ?', [success.parapheurId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_sortie' AND record_id = ?", [success.id]);
    await db.execute('DELETE FROM employes_sortie WHERE id = ?', [success.id]);

    let forcedError = null;
    try {
      await initiateOffboarding({
        agent,
        payload: {
          type_sortie: 'fin_contrat',
          date_depart_effectif: '2026-07-01',
        },
        actorId: userId,
        failAfterDossier: true,
      });
    } catch (error) {
      forcedError = error;
    }
    assert(forcedError, 'forced failure did not throw');
    assert.strictEqual(forcedError.message, 'OFFBOARDING_TEST_FAILURE_AFTER_DOSSIER');

    const rollbackDossiers = await db.query(
      'SELECT id FROM employes_sortie WHERE employe_id = ?',
      [employeeId],
    );
    assert.strictEqual(rollbackDossiers.length, 0, 'dossier remained after rollback');

    const rollbackParapheurs = await db.query(
      "SELECT id FROM parapheur WHERE ref_source_table = 'employes_sortie' AND ref_source_id IN (SELECT id FROM employes_sortie WHERE employe_id = ?)",
      [employeeId],
    );
    assert.strictEqual(rollbackParapheurs.length, 0, 'parapheur remained after rollback');

    console.log('test_offboarding_parapheur_mysql: OK');
  } finally {
    await cleanup({ employeeId, userId });
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

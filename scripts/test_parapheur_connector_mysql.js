'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { creerEntreeParapheur } = require('../backend/services/parapheur');

async function main() {
  const token = `ci_parapheur_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sourceId = Math.floor(Date.now() / 1000);
  let userId = null;
  let parapheurId = null;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'rh', 1, NOW())
    `, ['CI Parapheur', `${token}@example.test`, 'not-used-in-test']);
    userId = user.insertId;
    assert(userId, 'test user not created');

    const payload = {
      type: 'demande_achat',
      titre: token,
      initiateur_id: userId,
      montant: 125000,
      ref_source_table: 'ci_parapheur_test',
      ref_source_id: sourceId,
      priorite: 'urgent',
    };

    parapheurId = await creerEntreeParapheur(payload);
    assert(parapheurId, 'parapheur entry not created');

    const duplicateId = await creerEntreeParapheur(payload);
    assert.strictEqual(Number(duplicateId), Number(parapheurId), 'duplicate connector entry was created');

    const row = await db.queryOne('SELECT id, type, statut, ref_source_table, ref_source_id FROM parapheur WHERE id = ?', [parapheurId]);
    assert(row, 'created parapheur row missing');
    assert.strictEqual(row.type, 'demande_achat');
    assert.strictEqual(row.statut, 'en_attente_assistante');
    assert.strictEqual(row.ref_source_table, 'ci_parapheur_test');
    assert.strictEqual(Number(row.ref_source_id), sourceId);

    const count = await db.queryOne(
      'SELECT COUNT(*) AS c FROM parapheur WHERE ref_source_table = ? AND ref_source_id = ?',
      ['ci_parapheur_test', sourceId],
    );
    assert.strictEqual(Number(count.c), 1, 'connector duplicate guard failed');

    const action = await db.queryOne(
      "SELECT id FROM parapheur_actions WHERE parapheur_id = ? AND action_type = 'soumis'",
      [parapheurId],
    );
    assert(action, 'parapheur submission action missing');

    console.log('test_parapheur_connector_mysql: OK');
  } finally {
    if (parapheurId) await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [parapheurId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND details LIKE ?", [`%${token}%`]);
    await db.execute('DELETE FROM notif_messages WHERE message LIKE ?', [`%${token}%`]).catch(() => {});
    if (parapheurId) await db.execute('DELETE FROM parapheur WHERE id = ?', [parapheurId]);
    if (userId) await db.execute('DELETE FROM users WHERE id = ?', [userId]);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

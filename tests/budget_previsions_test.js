'use strict';
/*
 * Garde — prévisions budgétaires par catégorie et par mois (décision du
 * 29/09/2026) et étape Budget des opérations.
 *
 * Jusqu'ici aucune ligne de code ne faisait passer budget_status à un état
 * final : chaque opération validée ouvrait une anomalie que rien ne pouvait
 * refermer, et les virements de fonds en ouvraient une alors qu'ils n'ont
 * aucun impact budgétaire. Cette garde exécute le service sur une base
 * SQLite réelle et regarde les états, les anomalies et le réalisé.
 */
const assert = require('assert');
const fs = require('fs');

const dbPath = `/tmp/projet-smi-budget-${process.pid}.db`;
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = dbPath;

const db = require('../backend/db');
const budget = require('../backend/services/budget');

let vertes = 0;
let echecs = 0;
async function verifier(nom, fn) {
  try { await fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
}

async function operation({ type = 'encaissement', categorieId, date, montant = 100000, statut = 'valide', budgetStatus = 'pending', positionId, sourceId = null, userId }) {
  const r = await db.execute(`
    INSERT INTO operations (date, num_piece, libelle, tiers, montant, type_op, position_id, position_source_id,
      categorie_id, mode_reglement, statut, treasury_status, accounting_status, budget_status, allocation_status, created_by)
    VALUES (?, ?, 'Garde budget', 'Client test', ?, ?, ?, ?, ?, 'especes', ?, 'synced', 'pending', ?, 'pending', ?)
  `, [date, `BUD-${Date.now()}-${Math.random()}`, montant, type, positionId, sourceId, categorieId, statut, budgetStatus, userId]);
  return r.insertId;
}
const etat = async id => (await db.queryOne('SELECT budget_status FROM operations WHERE id = ?', [id])).budget_status;
const anomalieOuverte = async id => Boolean(await db.queryOne(
  "SELECT id FROM sync_errors WHERE source_module = 'operations' AND source_record_id = ? AND error_type = 'BUDGET_SYNC_PENDING' AND status = 'open'",
  [id],
));
async function ouvrirAnomalie(id) {
  await db.execute(`
    INSERT INTO sync_errors (source_module, source_record_id, error_type, error_message, status, created_at, updated_at)
    VALUES ('operations', ?, 'BUDGET_SYNC_PENDING', 'test', 'open', datetime('now'), datetime('now'))
  `, [id]);
}

async function run() {
  const user = await db.queryOne("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const caisse = await db.queryOne("SELECT id FROM positions WHERE type = 'caisse' ORDER BY id LIMIT 1");
  const banque = await db.queryOne("SELECT id FROM positions WHERE type = 'banque' ORDER BY id LIMIT 1");
  const [catA, catB] = await db.query("SELECT id FROM categories WHERE type = 'encaissement' ORDER BY id LIMIT 2");
  const catDep = await db.queryOne("SELECT id FROM categories WHERE type = 'decaissement' ORDER BY id LIMIT 1");
  assert(user && caisse && banque && catA && catB && catDep, 'Semis de test incomplet');
  const u = user.id;
  await db.execute('DELETE FROM budgets WHERE annee = 2031');

  const opA = await operation({ categorieId: catA.id, date: '2031-10-12', montant: 250000, positionId: caisse.id, userId: u });
  const opB = await operation({ categorieId: catB.id, date: '2031-10-15', montant: 90000, positionId: caisse.id, userId: u });
  const vir = await operation({ type: 'virement', categorieId: null, date: '2031-10-05', montant: 500000, positionId: caisse.id, sourceId: banque.id, userId: u });
  const passe = await operation({ categorieId: catA.id, date: '2031-10-01', budgetStatus: 'not_applicable', positionId: caisse.id, userId: u });
  const brouillon = await operation({ categorieId: catA.id, date: '2031-10-20', statut: 'en_attente', positionId: caisse.id, userId: u });
  for (const id of [opA, opB, vir]) await ouvrirAnomalie(id);

  await verifier('sans prévision, une opération reste « à traiter » et son anomalie reste ouverte', async () => {
    await budget.synchroniserBudget();
    assert.strictEqual(await etat(opA), 'pending');
    assert.ok(await anomalieOuverte(opA));
  });

  await verifier('un virement de fonds est sans objet pour le budget, et son anomalie se ferme', async () => {
    assert.strictEqual(await etat(vir), 'not_applicable');
    assert.ok(!await anomalieOuverte(vir));
  });

  await verifier('saisir une prévision impute les opérations de la catégorie et du mois, et elles seules', async () => {
    const r = await budget.enregistrerPrevisions({ annee: 2031, type: 'encaissement', lignes: [{ categorie_id: catA.id, mois: 10, prevu: 1000000 }] }, u);
    assert.strictEqual(r.ecrites, 1);
    assert.strictEqual(await etat(opA), 'synced');
    assert.ok(!await anomalieOuverte(opA), 'l anomalie de l opération imputée doit être résolue');
    assert.strictEqual(await etat(opB), 'pending', 'autre catégorie : rien ne change');
    assert.ok(await anomalieOuverte(opB));
  });

  await verifier('les états finaux posés ailleurs ne bougent pas', async () => {
    assert.strictEqual(await etat(passe), 'not_applicable');
    assert.strictEqual(await etat(brouillon), 'pending', 'une opération non validée n est pas imputée');
  });

  await verifier('le réalisé est la somme des opérations validées, par mois', async () => {
    const p = await budget.lirePrevisions({ annee: 2031, type: 'encaissement' });
    const ligneA = p.lignes.find(l => l.categorie_id === Number(catA.id));
    assert.ok(ligneA, 'catégorie absente de la grille');
    const oct = ligneA.mois[9];
    assert.strictEqual(oct.prevu, 1000000);
    // opA (250 000) + passe (100 000) : validées ; le brouillon n'est pas compté.
    assert.strictEqual(oct.realise, 350000);
    assert.strictEqual(ligneA.mois[8].prevu, null, 'un mois sans prévision est vide, pas zéro');
    // L'écart ne compare que les cases prévues : le réalisé de B (sans
    // prévision) ne doit pas gonfler le réalisé mis en face du prévu.
    assert.strictEqual(p.totaux.prevu, 1000000);
    assert.strictEqual(p.totaux.realise_prevu, 350000);
    assert.ok(p.totaux.realise > p.totaux.realise_prevu, 'le réalisé total inclut les cases sans prévision');
    assert.strictEqual(p.lignes.some(l => l.categorie_id === Number(catDep.id)), false, 'pas de catégorie de décaissement dans la grille des encaissements');
  });

  await verifier('un montant saisi avec séparateurs de milliers est lu comme ailleurs', async () => {
    await budget.enregistrerPrevisions({ annee: 2031, type: 'encaissement', lignes: [{ categorie_id: catA.id, mois: 11, prevu: '1 250 000' }] }, u);
    const p = await budget.lirePrevisions({ annee: 2031, type: 'encaissement' });
    assert.strictEqual(p.lignes.find(l => l.categorie_id === Number(catA.id)).mois[10].prevu, 1250000);
  });

  await verifier('une opération validée après la saisie est imputée tout de suite', async () => {
    const tard = await operation({ categorieId: catA.id, date: '2031-10-28', positionId: caisse.id, userId: u });
    const op = await db.queryOne('SELECT * FROM operations WHERE id = ?', [tard]);
    assert.strictEqual(await budget.imputerOperation(op), 'synced');
    assert.strictEqual(await etat(tard), 'synced');
  });

  await verifier('retirer la prévision remet les opérations « à traiter » et rouvre leur anomalie', async () => {
    const r = await budget.enregistrerPrevisions({ annee: 2031, type: 'encaissement', lignes: [{ categorie_id: catA.id, mois: 10, prevu: '' }] }, u);
    assert.strictEqual(r.retirees, 1);
    assert.strictEqual(await etat(opA), 'pending');
    assert.ok(await anomalieOuverte(opA), 'l anomalie doit se rouvrir');
  });

  await verifier('une saisie invalide est refusée sans rien écrire', async () => {
    const avant = (await db.queryOne('SELECT COUNT(*) AS n FROM budgets WHERE annee = 2031')).n;
    for (const lignes of [
      [{ categorie_id: catA.id, mois: 13, prevu: 1 }],
      [{ categorie_id: catA.id, mois: 1, prevu: -5 }],
      [{ categorie_id: catDep.id, mois: 1, prevu: 5 }],
      [{ categorie_id: catA.id, mois: 1, prevu: 'abc' }],
    ]) {
      await assert.rejects(budget.enregistrerPrevisions({ annee: 2031, type: 'encaissement', lignes }, u), budget.BudgetError);
    }
    await assert.rejects(budget.lirePrevisions({ annee: 1850, type: 'encaissement' }), budget.BudgetError);
    await assert.rejects(budget.lirePrevisions({ annee: 2031, type: 'virement' }), budget.BudgetError);
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) AS n FROM budgets WHERE annee = 2031')).n, avant);
  });

  await verifier('chaque saisie laisse une trace au journal d audit', async () => {
    const n = (await db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE table_name = 'budgets' AND action = 'previsions_saisies'")).n;
    assert.ok(Number(n) >= 2, 'traces : ' + n);
  });
}

run()
  .catch(e => { console.log('  ECHEC exécution\n        ' + (e.stack || e.message)); echecs++; })
  .finally(() => {
    try { fs.unlinkSync(dbPath); } catch (_) {}
    console.log(`${vertes}/${vertes + echecs} gardes vertes — prévisions budgétaires`);
    if (echecs) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });

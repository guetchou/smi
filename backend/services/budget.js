'use strict';
/*
 * Prévisions budgétaires par catégorie et par mois — décision du 29/09/2026.
 *
 * Une prévision est une ligne de la table budgets : (categorie_id, mois,
 * annee, montant_prevu). Le réalisé n'est pas stocké : c'est la somme des
 * opérations validées de la catégorie, ce mois-là.
 *
 * L'étape Budget d'une opération (budget_status) se déduit de la même règle :
 *   - une opération validée dont la catégorie a une prévision ce mois-là est
 *     imputée : 'synced' ;
 *   - sans prévision, elle attend : 'pending' (et son anomalie reste ouverte) ;
 *   - un virement de fonds n'a pas d'impact budgétaire : 'not_applicable'.
 * Les états finaux posés ailleurs ('not_applicable' du passé, 'cancelled')
 * ne sont jamais touchés.
 *
 * La règle est appliquée par imputerOperation au moment où une opération
 * devient valide, et par synchroniserBudget après chaque saisie de prévisions
 * et périodiquement : un chemin de validation qui n'appellerait pas la
 * première est rattrapé par la seconde.
 */
const db = require('../db');
const { parseAmount } = require('./numeric');

const TYPES = ['encaissement', 'decaissement'];
const ANOMALIE = 'BUDGET_SYNC_PENDING';
// Seule source de ce libellé : routes/operations.js le lit ici.
const MESSAGE_ANOMALIE = 'Impact budget non confirmé : ligne budgétaire ou imputation à compléter';

class BudgetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Les dates arrivent en 'AAAA-MM-JJ' (dateStrings côté MySQL, TEXT côté SQLite).
const moisDe = date => Number(String(date).slice(5, 7));
const anneeDe = date => Number(String(date).slice(0, 4));
const cle = (categorieId, mois, annee) => `${categorieId}-${mois}-${annee}`;

function statutAttendu(operation, prevues) {
  if (operation.type_op === 'virement') return 'not_applicable';
  if (!operation.categorie_id) return 'pending';
  return prevues.has(cle(operation.categorie_id, moisDe(operation.date), anneeDe(operation.date)))
    ? 'synced'
    : 'pending';
}

async function prevuesPourAnnees(annees, dbc) {
  const liste = [...new Set(annees)].filter(Number.isFinite);
  if (!liste.length) return new Set();
  const lignes = await dbc.query(
    `SELECT categorie_id, mois, annee FROM budgets WHERE annee IN (${liste.map(() => '?').join(',')})`,
    liste,
  );
  return new Set(lignes.map(l => cle(l.categorie_id, Number(l.mois), Number(l.annee))));
}

async function resoudreAnomalies(ids, dbc) {
  if (!ids.length) return;
  await dbc.execute(`
    UPDATE sync_errors
    SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
    WHERE source_module = 'operations' AND error_type = ? AND status = 'open'
      AND source_record_id IN (${ids.map(() => '?').join(',')})
  `, [ANOMALIE, ...ids]);
}

async function rouvrirAnomalie(operationId, userId, dbc) {
  const ouverte = await dbc.queryOne(
    "SELECT id FROM sync_errors WHERE source_module = 'operations' AND source_record_id = ? AND error_type = ? AND status = 'open'",
    [operationId, ANOMALIE],
  );
  if (ouverte) return;
  await dbc.execute(`
    INSERT INTO sync_errors (source_module, source_record_id, error_type, error_message, technical_details, status, created_at, updated_at)
    VALUES ('operations', ?, ?, ?, ?, 'open', NOW(), NOW())
  `, [operationId, ANOMALIE, MESSAGE_ANOMALIE, JSON.stringify({ status_column: 'budget_status', cause: 'prevision_retiree' })]);
  await dbc.execute(
    'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?, ?, ?, ?, ?)',
    ['operations', operationId, 'sync_error_opened', JSON.stringify({ errorType: ANOMALIE, userId }), userId || null],
  );
}

async function appliquer(changements, dbc) {
  const parStatut = new Map();
  for (const { id, statut } of changements) {
    if (!parStatut.has(statut)) parStatut.set(statut, []);
    parStatut.get(statut).push(id);
  }
  for (const [statut, ids] of parStatut) {
    await dbc.execute(
      `UPDATE operations SET budget_status = ?, updated_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
      [statut, ...ids],
    );
  }
  await resoudreAnomalies(changements.filter(c => c.statut !== 'pending').map(c => c.id), dbc);
}

/* Une opération qui vient d'être validée. Rend son nouvel état Budget. */
async function imputerOperation(operation, dbc = db) {
  if (!operation || operation.statut !== 'valide') return operation?.budget_status;
  const actuel = operation.budget_status || 'pending';
  if (!['pending', 'synced'].includes(actuel)) return actuel;
  const prevues = await prevuesPourAnnees([anneeDe(operation.date)], dbc);
  const attendu = statutAttendu(operation, prevues);
  if (attendu !== actuel) await appliquer([{ id: operation.id, statut: attendu }], dbc);
  return attendu;
}

/* Toutes les opérations validées dont l'étape Budget peut encore bouger. */
async function synchroniserBudget(dbc = db, userId = null) {
  const operations = await dbc.query(`
    SELECT id, type_op, categorie_id, date, statut, budget_status
    FROM operations
    WHERE statut = 'valide' AND budget_status IN ('pending', 'synced')
  `);
  const prevues = await prevuesPourAnnees(operations.map(o => anneeDe(o.date)), dbc);
  const changements = [];
  for (const o of operations) {
    const attendu = statutAttendu(o, prevues);
    if (attendu !== o.budget_status) changements.push({ id: o.id, statut: attendu });
  }
  await appliquer(changements, dbc);

  // Une prévision retirée : l'opération redevient « à traiter » et son
  // anomalie se rouvre, comme lors de la validation.
  const redevenues = changements.filter(c => c.statut === 'pending').map(c => c.id);
  for (const id of redevenues) await rouvrirAnomalie(id, userId, dbc);
  return {
    imputees: changements.filter(c => c.statut === 'synced').length,
    sans_objet: changements.filter(c => c.statut === 'not_applicable').length,
    en_attente: redevenues.length,
  };
}

function verifierAnnee(annee) {
  const a = Number(annee);
  if (!Number.isInteger(a) || a < 2000 || a > 2100) throw new BudgetError('Période invalide');
  return a;
}

function verifierType(type) {
  if (!TYPES.includes(type)) throw new BudgetError('Type opération invalide');
  return type;
}

async function lirePrevisions({ annee, type }, dbc = db) {
  const a = verifierAnnee(annee);
  const t = verifierType(type);
  const debut = `${a}-01-01`;
  const fin = `${a}-12-31`;
  const operations = await dbc.query(`
    SELECT categorie_id, date, montant FROM operations
    WHERE statut = 'valide' AND type_op = ? AND date >= ? AND date <= ? AND categorie_id IS NOT NULL
  `, [t, debut, fin]);
  const idsAvecRealise = [...new Set(operations.map(o => Number(o.categorie_id)))];
  // Les catégories actives du type, plus celles qui ont du réalisé cette
  // année même désactivées depuis : sinon une partie du réalisé disparaîtrait.
  const categories = await dbc.query(`
    SELECT id, nom FROM categories
    WHERE type = ? AND (actif = 1 ${idsAvecRealise.length ? `OR id IN (${idsAvecRealise.map(() => '?').join(',')})` : ''})
    ORDER BY nom
  `, [t, ...idsAvecRealise]);
  const budgets = categories.length ? await dbc.query(`
    SELECT categorie_id, mois, montant_prevu FROM budgets
    WHERE annee = ? AND categorie_id IN (${categories.map(() => '?').join(',')})
  `, [a, ...categories.map(c => c.id)]) : [];

  const prevu = new Map(budgets.map(b => [`${b.categorie_id}-${Number(b.mois)}`, Number(b.montant_prevu || 0)]));
  const realise = new Map();
  for (const o of operations) {
    const k = `${o.categorie_id}-${moisDe(o.date)}`;
    realise.set(k, Math.round(((realise.get(k) || 0) + Number(o.montant || 0)) * 100) / 100);
  }

  let totalPrevu = 0;
  let totalRealise = 0;
  let totalRealisePrevu = 0;
  const lignes = categories.map(c => {
    const mois = Array.from({ length: 12 }, (_, i) => {
      const k = `${c.id}-${i + 1}`;
      return { mois: i + 1, prevu: prevu.has(k) ? prevu.get(k) : null, realise: realise.get(k) || 0 };
    });
    const tp = mois.reduce((s, m) => s + (m.prevu || 0), 0);
    const tr = mois.reduce((s, m) => s + m.realise, 0);
    // L'écart ne compare que ce qui a été prévu : le réalisé d'un mois sans
    // prévision n'a rien en face (comme les lignes de budget d'Odoo).
    const trp = mois.reduce((s, m) => s + (m.prevu === null ? 0 : m.realise), 0);
    totalPrevu += tp;
    totalRealise += tr;
    totalRealisePrevu += trp;
    return {
      categorie_id: Number(c.id), nom: c.nom, mois,
      total_prevu: tp, total_realise: tr, realise_prevu: trp,
      a_une_prevision: mois.some(m => m.prevu !== null),
    };
  });
  return {
    annee: a,
    type: t,
    lignes,
    totaux: {
      prevu: totalPrevu,
      realise: totalRealise,
      realise_prevu: totalRealisePrevu,
      a_une_prevision: lignes.some(l => l.a_une_prevision),
    },
  };
}

async function enregistrerPrevisions({ annee, type, lignes }, userId, dbc = db) {
  const a = verifierAnnee(annee);
  const t = verifierType(type);
  if (!Array.isArray(lignes) || !lignes.length) throw new BudgetError('Aucun champ modifiable fourni');

  const categories = await dbc.query('SELECT id FROM categories WHERE type = ?', [t]);
  const permises = new Set(categories.map(c => Number(c.id)));
  // Une case par (catégorie, mois) : un doublon garde la dernière valeur, ce
  // qui borne aussi l'envoi à douze mois par catégorie existante.
  const parCase = new Map();
  for (const l of lignes) {
    const categorieId = Number(l.categorie_id);
    const mois = Number(l.mois);
    if (!permises.has(categorieId)) throw new BudgetError('Catégorie invalide');
    if (!Number.isInteger(mois) || mois < 1 || mois > 12) throw new BudgetError('Période invalide');
    if (l.prevu === null || l.prevu === '' || l.prevu === undefined) {
      parCase.set(`${categorieId}-${mois}`, { categorieId, mois, prevu: null });
      continue;
    }
    // « 1 000 000 », « 1.000.000 » : la saisie se lit comme partout ailleurs.
    const prevu = parseAmount(l.prevu);
    if (!Number.isFinite(prevu) || prevu < 0) throw new BudgetError('Montant invalide');
    parCase.set(`${categorieId}-${mois}`, { categorieId, mois, prevu: Math.round(prevu * 100) / 100 });
  }
  const propres = [...parCase.values()];

  return dbc.transaction(async tx => {
    let ecrites = 0;
    let retirees = 0;
    for (const l of propres) {
      const existante = await tx.queryOne(
        'SELECT id FROM budgets WHERE categorie_id = ? AND mois = ? AND annee = ?',
        [l.categorieId, l.mois, a],
      );
      if (l.prevu === null) {
        if (existante) { await tx.execute('DELETE FROM budgets WHERE id = ?', [existante.id]); retirees++; }
        continue;
      }
      if (existante) await tx.execute('UPDATE budgets SET montant_prevu = ? WHERE id = ?', [l.prevu, existante.id]);
      else await tx.execute('INSERT INTO budgets (mois, annee, categorie_id, montant_prevu) VALUES (?, ?, ?, ?)', [l.mois, a, l.categorieId, l.prevu]);
      ecrites++;
    }
    await tx.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('budgets', 0, 'previsions_saisies', ?, ?)",
      [JSON.stringify({ annee: a, type: t, ecrites, retirees }), userId || null],
    );
    const synchro = await synchroniserBudget(tx, userId);
    return { ecrites, retirees, ...synchro };
  });
}

module.exports = {
  ANOMALIE,
  MESSAGE_ANOMALIE,
  BudgetError,
  imputerOperation,
  synchroniserBudget,
  lirePrevisions,
  enregistrerPrevisions,
  _statutAttendu: statutAttendu,
};

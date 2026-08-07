'use strict';

/**
 * Correctifs ciblés autour de l'écosystème Agent.
 * Intercepte les écritures fragiles avant backend/routes/agents.js.
 */
const express = require('express');
const db = require('../db');
const { can } = require('../services/permissions');

const router = express.Router();

const CONGE_TYPES = ['annuel', 'maladie', 'maternite', 'paternite', 'sans_solde', 'autre'];
const SANCTION_TYPES = ['avertissement_verbal', 'avertissement_ecrit', 'mise_a_pied', 'licenciement_cause_reelle', 'autre'];
const HS_TYPES = ['normal', 'dimanche', 'ferie'];

function hasRole(user, ...roles) {
  const all = new Set([user?.role].filter(Boolean));
  if (Array.isArray(user?.roles)) user.roles.forEach(r => all.add(r));
  if (typeof user?.roles === 'string') {
    try { JSON.parse(user.roles).forEach(r => all.add(r)); } catch (_) {}
  }
  return roles.some(r => all.has(r));
}

async function canWriteAgent(req, res) {
  if (await can(req.user, 'hr.agent.update')) return true;
  res.status(403).json({ error: 'Permission hr.agent.update requise', permission: 'hr.agent.update' });
  return false;
}
function canRH(user) { return hasRole(user, 'admin', 'dg', 'rh'); }
function canFinance(user) { return hasRole(user, 'admin', 'dg', 'finance'); }
function canCashPay(user) { return hasRole(user, 'admin', 'finance', 'caissier'); }

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function money(value) { return Math.max(0, Math.round(num(value, 0))); }
function dateOrNull(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}
function boolInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}
function diffDaysInclusive(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1);
}

async function agentOr404(id, res, dbc = db) {
  const agent = await dbc.queryOne('SELECT * FROM employes WHERE id = ?', [Number(id)]);
  if (!agent) {
    res.status(404).json({ error: 'Agent introuvable' });
    return null;
  }
  return agent;
}
async function activeAgentOr400(id, res, dbc = db) {
  const agent = await agentOr404(id, res, dbc);
  if (!agent) return null;
  if (Number(agent.actif) !== 1 || agent.statut_dossier !== 'actif') {
    res.status(400).json({ error: "L'agent doit être actif" });
    return null;
  }
  return agent;
}
async function touchAgent(id, dbc = db) {
  await dbc.execute('UPDATE employes SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [Number(id)]);
}
async function audit(dbc, table, recordId, action, details, userId) {
  await dbc.execute(
    'INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
    [table, Number(recordId), action, details ? JSON.stringify(details) : null, userId || null],
  );
}
async function param(cle, defaut, dbc = db) {
  const row = await dbc.queryOne('SELECT valeur FROM parametres WHERE cle = ?', [cle]);
  return row ? row.valeur : defaut;
}
async function congeSolde(employeId, dbc = db) {
  const year = new Date().getFullYear();
  const emp = await dbc.queryOne(
    'SELECT date_embauche, conges_report_n1, conges_maladie_droit, conges_maladie_pris, conges_maladie_solde FROM employes WHERE id=?',
    [Number(employeId)],
  );
  if (!emp) return null;
  let acquis = 0;
  if (emp.date_embauche) {
    const taux = parseFloat(await param('conges_jours_par_mois', '2.5', dbc)) || 2.5;
    const now = new Date();
    const emb = new Date(emp.date_embauche);
    const debAnnee = new Date(now.getFullYear(), 0, 1);
    const ref = emb > debAnnee ? emb : debAnnee;
    const mois = Math.min(12, Math.max(0,
      (now.getFullYear() - ref.getFullYear()) * 12
      + (now.getMonth() - ref.getMonth())
      + (now.getDate() >= ref.getDate() ? 1 : 0)));
    acquis = Math.min(30, Math.round(mois * taux * 2) / 2);
  }
  const row = await dbc.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN statut IN ('approuve','termine') THEN nb_jours ELSE 0 END), 0) AS pris,
      COALESCE(SUM(CASE WHEN statut IN ('demande','valide_sup') THEN nb_jours ELSE 0 END), 0) AS en_attente
    FROM employes_conges
    WHERE employe_id=? AND type_conge='annuel' AND YEAR(date_debut)=?
  `, [Number(employeId), year]);
  const report = num(emp.conges_report_n1, 0);
  const pris = num(row?.pris, 0);
  const enAttente = num(row?.en_attente, 0);
  return {
    acquis,
    pris,
    report,
    en_attente: enAttente,
    solde: Math.round((acquis + report - pris) * 10) / 10,
    solde_apres_attente: Math.round((acquis + report - pris - enAttente) * 10) / 10,
    maladie: {
      droit: num(emp.conges_maladie_droit, 15),
      pris: num(emp.conges_maladie_pris, 0),
      solde: num(emp.conges_maladie_solde, 15),
    },
  };
}
async function setLeaveCounters(employeId, dbc = db) {
  const s = await congeSolde(employeId, dbc);
  if (!s) return null;
  await dbc.execute(`
    UPDATE employes
    SET conges_acquis_annuel=?, conges_pris_annuel=?, conges_solde_annuel=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `, [s.acquis, s.pris, s.solde, Number(employeId)]);
  return s;
}
async function hsRates(dbc = db) {
  const rows = await dbc.query("SELECT cle, valeur FROM parametres WHERE cle LIKE 'heures_sup%'");
  const p = {};
  rows.forEach(r => { p[r.cle] = parseFloat(r.valeur) || 0; });
  return {
    normal: p.heures_sup_taux_normal || 1.25,
    dimanche: p.heures_sup_taux_dimanche || 1.50,
    ferie: p.heures_sup_taux_ferie || 2.00,
    plafond: p.heures_sup_plafond_mois || 40,
  };
}
async function hsAmount(hours, type, salary, rates = null, dbc = db) {
  const r = rates || await hsRates(dbc);
  const rate = r[type] || r.normal;
  const hourly = (num(salary, 0) || 0) / (26 * 8);
  return { rate, amount: Math.round(num(hours, 0) * hourly * rate), rates: r };
}

router.post('/:id/enfants', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const agent = await agentOr404(req.params.id, res); if (!agent) return;
    if (agent.statut_dossier === 'sorti') return res.status(403).json({ error: 'Agent sorti — modification famille interdite' });
    const prenom = text(req.body?.prenom);
    if (!prenom) return res.status(400).json({ error: 'Prénom requis' });
    const nom = text(req.body?.nom);
    const date_naissance = dateOrNull(req.body?.date_naissance);
    const sexe = ['M', 'F'].includes(text(req.body?.sexe, 'M')) ? text(req.body?.sexe, 'M') : 'M';
    const est_charge = boolInt(req.body?.est_charge, 1);
    const scolarise = boolInt(req.body?.scolarise, 0);
    const observation = text(req.body?.observation);
    const id = Number(req.params.id);
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_enfants (employe_id,nom,prenom,date_naissance,sexe,est_charge,scolarise,observation) VALUES (?,?,?,?,?,?,?,?)', [id, nom, prenom, date_naissance, sexe, est_charge, scolarise, observation]);
      const enfants = await tx.query('SELECT est_charge FROM employes_enfants WHERE employe_id = ?', [id]);
      const charge = enfants.filter(e => Number(e.est_charge) === 1).length;
      await tx.execute('UPDATE employes SET nb_enfants=?, nb_enfants_charge=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [enfants.length, charge, id]);
      await audit(tx, 'employes_enfants', r.insertId, 'create', { employe_id: id, prenom, nom, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, nom, prenom, date_naissance, sexe, est_charge, scolarise, observation });
  } catch (e) { next(e); }
});

router.post('/:id/documents', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    if (!await agentOr404(req.params.id, res)) return;
    const type_document = text(req.body?.type_document);
    if (!type_document) return res.status(400).json({ error: 'Type de document requis' });
    const date_emission = dateOrNull(req.body?.date_emission);
    const date_expiration = dateOrNull(req.body?.date_expiration);
    if (date_emission && date_expiration && date_expiration < date_emission) return res.status(400).json({ error: 'Date expiration antérieure à date émission' });
    const statut = text(req.body?.statut, 'valide') || 'valide';
    const observation = text(req.body?.observation);
    const id = Number(req.params.id);
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_documents (employe_id,type_document,date_emission,date_expiration,statut,observation) VALUES (?,?,?,?,?,?)', [id, type_document, date_emission, date_expiration, statut, observation]);
      await touchAgent(id, tx);
      await audit(tx, 'employes_documents', r.insertId, 'create', { employe_id: id, type_document, statut, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, type_document, date_emission, date_expiration, statut, observation });
  } catch (e) { next(e); }
});

router.post('/:id/diplomes', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    if (!await agentOr404(req.params.id, res)) return;
    const intitule = text(req.body?.intitule);
    if (!intitule) return res.status(400).json({ error: 'Intitulé requis' });
    const annee = req.body?.annee_obtention ? num(req.body.annee_obtention, null) : null;
    const nowYear = new Date().getFullYear();
    if (annee && (annee < 1950 || annee > nowYear + 1)) return res.status(400).json({ error: `Année obtention invalide (${annee})` });
    const payload = { etablissement: text(req.body?.etablissement), pays: text(req.body?.pays, 'Congo-Brazzaville') || 'Congo-Brazzaville', niveau: text(req.body?.niveau, 'autre') || 'autre', observation: text(req.body?.observation) };
    const id = Number(req.params.id);
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_diplomes (employe_id,intitule,etablissement,pays,annee_obtention,niveau,observation) VALUES (?,?,?,?,?,?,?)', [id, intitule, payload.etablissement, payload.pays, annee, payload.niveau, payload.observation]);
      await touchAgent(id, tx);
      await audit(tx, 'employes_diplomes', r.insertId, 'create', { employe_id: id, intitule, niveau: payload.niveau, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, intitule, ...payload, annee_obtention: annee });
  } catch (e) { next(e); }
});

router.post('/:id/experiences', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    if (!await agentOr404(req.params.id, res)) return;
    const poste = text(req.body?.poste);
    if (!poste) return res.status(400).json({ error: 'Poste requis' });
    const date_debut = dateOrNull(req.body?.date_debut);
    const date_fin = dateOrNull(req.body?.date_fin);
    if (date_debut && date_fin && date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });
    const entreprise = text(req.body?.entreprise);
    const type_contrat = text(req.body?.type_contrat);
    const description = text(req.body?.description);
    const id = Number(req.params.id);
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_experiences (employe_id,poste,entreprise,date_debut,date_fin,type_contrat,description) VALUES (?,?,?,?,?,?,?)', [id, poste, entreprise, date_debut, date_fin, type_contrat, description]);
      await touchAgent(id, tx);
      await audit(tx, 'employes_experiences', r.insertId, 'create', { employe_id: id, poste, entreprise, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, poste, entreprise, date_debut, date_fin, type_contrat, description });
  } catch (e) { next(e); }
});

router.post('/:id/avances/:aid/remboursements', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const avance = await db.queryOne('SELECT * FROM employes_avances WHERE id=? AND employe_id=?', [Number(req.params.aid), Number(req.params.id)]);
    if (!avance) return res.status(404).json({ error: 'Avance non trouvée' });
    if (!['en_cours', 'rembourse'].includes(avance.statut) || ['annule', 'rejete'].includes(avance.statut_workflow)) return res.status(400).json({ error: 'Avance non remboursable' });
    const date = dateOrNull(req.body?.date);
    const montant = money(req.body?.montant);
    const notes = text(req.body?.notes);
    if (!date || montant <= 0) return res.status(400).json({ error: 'Date et montant positif requis' });
    const solde = money(avance.solde_restant);
    if (montant > solde) return res.status(400).json({ error: `Montant dépasse le solde restant (${solde} XAF)`, solde_restant: solde });
    const nouveauSolde = Math.max(0, solde - montant);
    const nouveauStatut = nouveauSolde <= 0 ? 'rembourse' : 'en_cours';
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_avances_remboursements (avance_id,date,montant,notes,created_by) VALUES (?,?,?,?,?)', [avance.id, date, montant, notes, req.user?.id || null]);
      await tx.execute('UPDATE employes_avances SET solde_restant=?, montant_rembourse=COALESCE(montant_rembourse,0)+?, statut=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [nouveauSolde, montant, nouveauStatut, avance.id]);
      await audit(tx, 'employes_avances', avance.id, 'remboursement_partiel', { remboursement_id: r.insertId, montant, solde_restant: nouveauSolde, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ ok: true, remboursement_id: out.insertId, solde_restant: nouveauSolde, statut: nouveauStatut });
  } catch (e) { next(e); }
});

router.post('/:id/avances/:aid/decaisser', async (req, res, next) => {
  try {
    if (!canCashPay(req.user)) return res.status(403).json({ error: 'Rôle Finance, Caissier ou Admin requis pour décaisser une avance' });
    const avance = await db.queryOne('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?', [Number(req.params.aid), Number(req.params.id)]);
    if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
    if (avance.statut_workflow !== 'approuve_dg') return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — décaissement impossible. L'avance doit être approuvée avant décaissement.` });
    if (avance.operation_id) return res.status(400).json({ error: 'Cette avance a déjà été décaissée' });
    const agent = await activeAgentOr400(req.params.id, res); if (!agent) return;
    const position = req.body?.position_id ? await db.queryOne('SELECT id FROM positions WHERE id = ? AND actif = 1', [Number(req.body.position_id)]) : await db.queryOne("SELECT id FROM positions WHERE actif=1 AND type IN ('caisse','banque') ORDER BY ordre LIMIT 1");
    if (!position) return res.status(400).json({ error: 'Position de trésorerie introuvable — précisez position_id' });
    const montant = money(avance.montant);
    const bal = await db.queryOne('SELECT solde_courant FROM cashbox_balances WHERE caisse_id = ?', [position.id]);
    let soldeBefore;
    if (bal != null) soldeBefore = Math.round(Number(bal.solde_courant) * 100) / 100;
    else {
      const computed = await db.queryOne(`SELECT p.solde_initial + COALESCE(SUM(CASE WHEN o.type_op='encaissement' AND o.position_id=p.id THEN o.montant WHEN o.type_op='virement' AND o.position_id=p.id THEN o.montant WHEN o.type_op='decaissement' AND o.position_id=p.id THEN -o.montant WHEN o.type_op='virement' AND o.position_source_id=p.id THEN -o.montant ELSE 0 END), 0) AS solde FROM positions p LEFT JOIN operations o ON (o.position_id=p.id OR o.position_source_id=p.id) AND o.statut='valide' WHERE p.id=? GROUP BY p.id, p.solde_initial`, [position.id]);
      soldeBefore = Math.round(Number(computed?.solde || 0) * 100) / 100;
    }
    if (soldeBefore < montant) return res.status(400).json({ error: `Solde insuffisant pour décaisser l'avance (disponible : ${soldeBefore} XAF, requis : ${montant} XAF)`, code: 'SOLDE_INSUFFISANT', solde_disponible: soldeBefore, montant });
    const soldeAfter = Math.round((soldeBefore - montant) * 100) / 100;
    const cat = await db.queryOne("SELECT id FROM categories WHERE type IN ('decaissement','depense') AND (LOWER(nom) LIKE '%avance%' OR LOWER(nom) LIKE '%salaire%') ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END LIMIT 1");
    const libelle = `Avance sur salaire — ${agent.nom} ${agent.prenom || ''}`.trim();
    const tiers = `${agent.nom} ${agent.prenom || ''}`.trim();
    const opId = await db.transaction(async tx => {
      const op = await tx.execute(`INSERT INTO operations (date, libelle, tiers, montant, type_op, position_id, categorie_id, mode_reglement, employe_id, statut, dec_statut, paid_by, paid_at, created_by) VALUES (CURDATE(), ?, ?, ?, 'decaissement', ?, ?, 'especes', ?, 'valide', 'paye', ?, CURRENT_TIMESTAMP, ?)`, [libelle, tiers, montant, position.id, cat?.id || null, Number(req.params.id), req.user.id, req.user.id]);
      const advanced = await tx.execute("UPDATE employes_avances SET statut_workflow='decaisse', operation_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND operation_id IS NULL", [op.insertId, avance.id]);
      if (Number(advanced.affectedRows || 0) !== 1) throw new Error('Avance déjà décaissée concurremment');
      await tx.execute(`INSERT INTO cash_ledger (caisse_id, operation_id, type_mouvement, montant, solde_avant, solde_apres, reference, created_by) VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)`, [position.id, op.insertId, montant, soldeBefore, soldeAfter, libelle, req.user.id]);
      const upd = await tx.execute('UPDATE cashbox_balances SET solde_courant=?, derniere_operation_id=?, updated_at=CURRENT_TIMESTAMP WHERE caisse_id=?', [soldeAfter, op.insertId, position.id]);
      if (!upd.affectedRows) await tx.execute('INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [position.id, soldeAfter, op.insertId]);
      await audit(tx, 'employes_avances', avance.id, 'decaisser', { operation_id: op.insertId, montant, position_id: position.id, solde_avant: soldeBefore, solde_apres: soldeAfter, safe_ecosystem: true }, req.user?.id);
      return op.insertId;
    });
    res.json({ ok: true, statut_workflow: 'decaisse', operation_id: opId, montant, solde_apres: soldeAfter });
  } catch (e) { next(e); }
});

router.post('/:id/conges', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const emp = await activeAgentOr400(req.params.id, res); if (!emp) return;
    let type_conge = text(req.body?.type_conge, 'annuel') || 'annuel';
    if (!CONGE_TYPES.includes(type_conge)) return res.status(400).json({ error: `type_conge invalide. Valeurs : ${CONGE_TYPES.join(', ')}` });
    const date_debut = dateOrNull(req.body?.date_debut), date_fin = dateOrNull(req.body?.date_fin);
    if (!date_debut || !date_fin) return res.status(400).json({ error: 'Dates requises' });
    if (date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });
    const nb_jours = diffDaysInclusive(date_debut, date_fin);
    const motif = text(req.body?.motif), notes = text(req.body?.notes);
    const force = req.body?.force_creation === true || req.body?.force_creation === 'true';
    const overlap = await db.queryOne("SELECT id, date_debut, date_fin FROM employes_conges WHERE employe_id=? AND statut IN ('demande','valide_sup','approuve') AND date_debut <= ? AND date_fin >= ? LIMIT 1", [Number(req.params.id), date_fin, date_debut]);
    if (overlap) return res.status(409).json({ error: `Chevauchement avec un congé existant du ${overlap.date_debut} au ${overlap.date_fin}`, overlap_id: overlap.id });
    const s = await congeSolde(req.params.id);
    if (type_conge === 'annuel' && s && nb_jours > s.solde_apres_attente && !force && !hasRole(req.user, 'admin')) return res.status(400).json({ error: `Solde insuffisant : ${s.solde_apres_attente} jour(s) disponible(s) après demandes en attente`, solde: s, nb_jours });
    if (type_conge === 'maladie' && s && nb_jours > s.maladie.solde) {
      if (!force && !hasRole(req.user, 'admin')) return res.status(400).json({ error: `Solde maladie insuffisant : ${s.maladie.solde} j disponible(s), ${nb_jours} demandé(s)`, solde_maladie: s.maladie.solde, nb_jours });
      if (force) type_conge = 'sans_solde';
    }
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_conges (employe_id,type_conge,date_debut,date_fin,nb_jours,motif,notes,created_by) VALUES (?,?,?,?,?,?,?,?)', [Number(req.params.id), type_conge, date_debut, date_fin, nb_jours, motif, notes, req.user?.id || null]);
      await audit(tx, 'employes_conges', r.insertId, 'create', { type_conge, date_debut, date_fin, nb_jours, safe_ecosystem: true }, req.user?.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, type_conge, date_debut, date_fin, nb_jours, motif, statut: 'demande', notes });
  } catch (e) { next(e); }
});

router.put('/:id/conges/:cid/valider-sup', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Validation supérieur réservée DG, RH ou Admin' });
    const conge = await db.queryOne('SELECT * FROM employes_conges WHERE id=? AND employe_id=?', [Number(req.params.cid), Number(req.params.id)]);
    if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
    if (conge.statut !== 'demande') return res.status(400).json({ error: `Impossible de valider : statut actuel "${conge.statut}" (attendu: demande)` });
    const notes = text(req.body?.notes);
    await db.transaction(async tx => {
      await tx.execute("UPDATE employes_conges SET statut='valide_sup', valide_sup_par=?, valide_sup_at=CURRENT_TIMESTAMP, valide_sup_notes=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, notes || null, req.user.id, conge.id]);
      await audit(tx, 'employes_conges', conge.id, 'valide_sup', { notes, safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true, statut: 'valide_sup' });
  } catch (e) { next(e); }
});

router.put('/:id/conges/:cid/approuver', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const conge = await db.queryOne('SELECT * FROM employes_conges WHERE id=? AND employe_id=?', [Number(req.params.cid), Number(req.params.id)]);
    if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
    const workflowSup = (await param('conges_workflow_sup', '1') || '1') === '1';
    const expected = workflowSup ? ['valide_sup'] : ['demande', 'valide_sup'];
    if (!expected.includes(conge.statut)) return res.status(400).json({ error: workflowSup ? `Approbation impossible : validation supérieur requise (statut actuel: ${conge.statut})` : `Impossible d'approuver un congé en statut ${conge.statut}` });
    const overlap = await db.queryOne("SELECT id, date_debut, date_fin FROM employes_conges WHERE employe_id=? AND id != ? AND statut='approuve' AND date_debut <= ? AND date_fin >= ? LIMIT 1", [Number(req.params.id), Number(req.params.cid), conge.date_fin, conge.date_debut]);
    if (overlap) return res.status(409).json({ error: `Chevauchement avec un congé approuvé du ${overlap.date_debut} au ${overlap.date_fin}` });
    const balance = await db.transaction(async tx => {
      const changed = await tx.execute("UPDATE employes_conges SET statut='approuve', approuve_par=?, approuve_at=CURRENT_TIMESTAMP, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND statut=?", [req.user.id, req.user.id, conge.id, conge.statut]);
      if (Number(changed.affectedRows || 0) !== 1) throw new Error('Congé déjà traité concurremment');
      const current = await setLeaveCounters(req.params.id, tx);
      if (conge.type_conge === 'maladie') {
        const emp = await tx.queryOne('SELECT conges_maladie_pris, conges_maladie_solde FROM employes WHERE id=?', [Number(req.params.id)]);
        await tx.execute('UPDATE employes SET conges_maladie_pris=?, conges_maladie_solde=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [num(emp?.conges_maladie_pris, 0) + num(conge.nb_jours, 0), Math.max(0, num(emp?.conges_maladie_solde, 15) - num(conge.nb_jours, 0)), Number(req.params.id)]);
      }
      await audit(tx, 'employes_conges', conge.id, 'approuve', { nb_jours: conge.nb_jours, safe_ecosystem: true }, req.user?.id);
      return current;
    });
    res.json({ ok: true, statut: 'approuve', solde: balance });
  } catch (e) { next(e); }
});

router.put('/:id/conges/:cid/refuser', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const conge = await db.queryOne('SELECT * FROM employes_conges WHERE id=? AND employe_id=?', [Number(req.params.cid), Number(req.params.id)]);
    if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
    if (['refuse', 'annule', 'termine', 'approuve'].includes(conge.statut)) return res.status(400).json({ error: `Refus impossible en statut ${conge.statut}` });
    const motif = text(req.body?.motif);
    if (!motif) return res.status(400).json({ error: 'Motif de refus obligatoire' });
    await db.transaction(async tx => {
      await tx.execute("UPDATE employes_conges SET statut='refuse', refuse_par=?, refuse_at=CURRENT_TIMESTAMP, refuse_motif=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, motif, req.user.id, conge.id]);
      await audit(tx, 'employes_conges', conge.id, 'refuse', { motif, safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true, statut: 'refuse' });
  } catch (e) { next(e); }
});

router.put('/:id/conges/:cid/terminer', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const conge = await db.queryOne('SELECT * FROM employes_conges WHERE id=? AND employe_id=?', [Number(req.params.cid), Number(req.params.id)]);
    if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
    if (conge.statut !== 'approuve') return res.status(400).json({ error: 'Seul un congé approuvé peut être terminé' });
    await db.transaction(async tx => {
      await tx.execute("UPDATE employes_conges SET statut='termine', updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, conge.id]);
      await audit(tx, 'employes_conges', conge.id, 'termine', { nb_jours: conge.nb_jours, safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true, statut: 'termine' });
  } catch (e) { next(e); }
});

router.put('/:id/conges/:cid/annuler', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
    const conge = await db.queryOne('SELECT * FROM employes_conges WHERE id=? AND employe_id=?', [Number(req.params.cid), Number(req.params.id)]);
    if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
    if (['annule', 'termine'].includes(conge.statut)) return res.status(400).json({ error: `Congé déjà en statut ${conge.statut}` });
    const motif = text(req.body?.motif);
    if (!motif) return res.status(400).json({ error: "Motif d'annulation obligatoire" });
    const balance = await db.transaction(async tx => {
      await tx.execute("UPDATE employes_conges SET statut='annule', annule_statut=?, annule_at=CURRENT_TIMESTAMP, annule_by=?, annule_motif=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [conge.statut, req.user.id, motif, req.user.id, conge.id]);
      const current = await setLeaveCounters(req.params.id, tx);
      if (conge.statut === 'approuve' && conge.type_conge === 'maladie') {
        const emp = await tx.queryOne('SELECT conges_maladie_pris, conges_maladie_solde FROM employes WHERE id=?', [Number(req.params.id)]);
        await tx.execute('UPDATE employes SET conges_maladie_pris=?, conges_maladie_solde=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [Math.max(0, num(emp?.conges_maladie_pris, 0) - num(conge.nb_jours, 0)), num(emp?.conges_maladie_solde, 15) + num(conge.nb_jours, 0), Number(req.params.id)]);
      }
      await audit(tx, 'employes_conges', conge.id, 'annule', { motif, annule_statut: conge.statut, safe_ecosystem: true }, req.user?.id);
      return current;
    });
    res.json({ ok: true, statut: 'annule', solde: balance || await congeSolde(req.params.id) });
  } catch (e) { next(e); }
});

router.post('/:id/sanctions', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'rh')) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const agent = await activeAgentOr400(req.params.id, res); if (!agent) return;
    const type = text(req.body?.type);
    if (!SANCTION_TYPES.includes(type)) return res.status(400).json({ error: `type invalide. Valeurs : ${SANCTION_TYPES.join(', ')}` });
    const date_sanction = dateOrNull(req.body?.date_sanction), motif_detaille = text(req.body?.motif_detaille);
    if (!date_sanction || !motif_detaille) return res.status(400).json({ error: !date_sanction ? 'date_sanction requis' : 'motif_detaille obligatoire' });
    const jours = type === 'mise_a_pied' ? num(req.body?.nb_jours_mise_a_pied, 0) : 0;
    if (type === 'mise_a_pied' && jours <= 0) return res.status(400).json({ error: 'nb_jours_mise_a_pied requis pour une mise à pied' });
    const retenue = type === 'mise_a_pied' && agent.salaire_base > 0 ? Math.round((jours / 26) * Number(agent.salaire_base)) : 0;
    const document_url = text(req.body?.document_url) || null;
    const sanction = await db.transaction(async tx => {
      const r = await tx.execute("INSERT INTO employes_sanctions (employe_id,type,date_sanction,motif_detaille,nb_jours_mise_a_pied,retenue_calculee,document_url,statut,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'projet',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [agent.id, type, date_sanction, motif_detaille, jours, retenue, document_url, req.user.id]);
      await audit(tx, 'employes_sanctions', r.insertId, 'creer', { type, retenue_calculee: retenue, safe_ecosystem: true }, req.user?.id);
      return tx.queryOne('SELECT * FROM employes_sanctions WHERE id=?', [r.insertId]);
    });
    res.status(201).json(sanction);
  } catch (e) { next(e); }
});

router.put('/:id/sanctions/:sid', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'rh')) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id=? AND employe_id=?', [Number(req.params.sid), Number(req.params.id)]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (sanction.statut !== 'projet') return res.status(400).json({ error: `Statut ${sanction.statut} — modification impossible` });
    const agent = await agentOr404(req.params.id, res); if (!agent) return;
    const type = text(req.body?.type, sanction.type), date_sanction = dateOrNull(req.body?.date_sanction) || sanction.date_sanction, motif_detaille = text(req.body?.motif_detaille, sanction.motif_detaille);
    const jours = type === 'mise_a_pied' ? num(req.body?.nb_jours_mise_a_pied, sanction.nb_jours_mise_a_pied) : 0;
    if (!SANCTION_TYPES.includes(type) || !motif_detaille || (type === 'mise_a_pied' && jours <= 0)) return res.status(400).json({ error: 'Données sanction invalides' });
    const retenue = type === 'mise_a_pied' && agent.salaire_base > 0 ? Math.round((jours / 26) * Number(agent.salaire_base)) : 0;
    const document_url = req.body?.document_url === undefined ? sanction.document_url : (text(req.body?.document_url) || null);
    const updated = await db.transaction(async tx => {
      await tx.execute('UPDATE employes_sanctions SET type=?, date_sanction=?, motif_detaille=?, nb_jours_mise_a_pied=?, retenue_calculee=?, document_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [type, date_sanction, motif_detaille, jours, retenue, document_url, sanction.id]);
      await audit(tx, 'employes_sanctions', sanction.id, 'modifier', { type, retenue_calculee: retenue, safe_ecosystem: true }, req.user?.id);
      return tx.queryOne('SELECT * FROM employes_sanctions WHERE id=?', [sanction.id]);
    });
    res.json(updated);
  } catch (e) { next(e); }
});

async function transitionSanction(req, res, next, { roles, expected, nextStatus, action, requireMotif = false }) {
  try {
    if (!hasRole(req.user, ...roles)) return res.status(403).json({ error: 'Accès refusé' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id=? AND employe_id=?', [Number(req.params.sid), Number(req.params.id)]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (!expected.includes(sanction.statut)) return res.status(400).json({ error: `${action} impossible en statut ${sanction.statut}` });
    const motif = requireMotif ? text(req.body?.conteste_motif) : '';
    if (requireMotif && !motif) return res.status(400).json({ error: 'conteste_motif obligatoire' });
    await db.transaction(async tx => {
      if (requireMotif) await tx.execute('UPDATE employes_sanctions SET statut=?, conteste_motif=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [nextStatus, motif, sanction.id]);
      else await tx.execute('UPDATE employes_sanctions SET statut=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [nextStatus, sanction.id]);
      await audit(tx, 'employes_sanctions', sanction.id, action, requireMotif ? { conteste_motif: motif, safe_ecosystem: true } : { safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true, statut: nextStatus });
  } catch (e) { next(e); }
}
router.put('/:id/sanctions/:sid/notifier', (req, res, next) => transitionSanction(req, res, next, { roles: ['admin', 'rh', 'dg'], expected: ['projet'], nextStatus: 'notifie', action: 'notifier' }));
router.put('/:id/sanctions/:sid/contester', (req, res, next) => transitionSanction(req, res, next, { roles: ['admin', 'rh'], expected: ['notifie'], nextStatus: 'conteste', action: 'contester', requireMotif: true }));
router.put('/:id/sanctions/:sid/clore', (req, res, next) => transitionSanction(req, res, next, { roles: ['admin', 'dg'], expected: ['notifie', 'conteste'], nextStatus: 'clos', action: 'clore' }));

router.post('/:id/heures-sup', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'rh', 'finance', 'dg')) return res.status(403).json({ error: 'Rôle RH, Finance, DG ou Admin requis' });
    const agent = await activeAgentOr400(req.params.id, res); if (!agent) return;
    const date_heures = dateOrNull(req.body?.date_heures), nb_heures = num(req.body?.nb_heures, 0), type = text(req.body?.type, 'normal') || 'normal', motif = text(req.body?.motif);
    if (!date_heures || nb_heures <= 0 || nb_heures > 24 || !HS_TYPES.includes(type)) return res.status(400).json({ error: 'Données heures supplémentaires invalides' });
    const [annee, mois] = date_heures.slice(0, 7).split('-').map(Number);
    const rates = await hsRates();
    const total = await db.queryOne("SELECT COALESCE(SUM(nb_heures),0) AS total FROM employes_heures_sup WHERE employe_id=? AND mois=? AND annee=? AND statut IN ('saisi','valide','integre_bulletin')", [agent.id, mois, annee]);
    const deja = num(total?.total, 0);
    if (deja + nb_heures > rates.plafond) return res.status(400).json({ error: `Plafond mensuel dépassé. Total : ${deja}h + ${nb_heures}h > ${rates.plafond}h`, code: 'PLAFOND_HEURES_SUP', dejaEnregistre: deja, plafond: rates.plafond });
    const { rate, amount } = await hsAmount(nb_heures, type, agent.salaire_base, rates);
    const autoValide = canFinance(req.user);
    const created = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO employes_heures_sup (employe_id,mois,annee,date_heures,nb_heures,type,taux_majoration,montant_brut,statut,valide_par,motif,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)', [agent.id, mois, annee, date_heures, nb_heures, type, rate, amount, autoValide ? 'valide' : 'saisi', autoValide ? req.user.id : null, motif || null, req.user.id]);
      await audit(tx, 'employes_heures_sup', r.insertId, autoValide ? 'creer_auto_valider' : 'creer', { nb_heures, type, montant_brut: amount, safe_ecosystem: true }, req.user?.id);
      return tx.queryOne('SELECT * FROM employes_heures_sup WHERE id=?', [r.insertId]);
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.put('/:id/heures-sup/:hid/valider', async (req, res, next) => {
  try {
    if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance, DG ou Admin requis' });
    const hs = await db.queryOne('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?', [Number(req.params.hid), Number(req.params.id)]);
    if (!hs || hs.statut !== 'saisi') return res.status(hs ? 400 : 404).json({ error: hs ? `Validation impossible en statut ${hs.statut}` : 'Entrée heures sup introuvable' });
    const agent = await agentOr404(req.params.id, res); if (!agent) return;
    const { amount } = await hsAmount(hs.nb_heures, hs.type, agent.salaire_base);
    await db.transaction(async tx => {
      await tx.execute("UPDATE employes_heures_sup SET statut='valide', valide_par=?, montant_brut=? WHERE id=?", [req.user.id, amount, hs.id]);
      await audit(tx, 'employes_heures_sup', hs.id, 'valider', { montant_brut: amount, safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true, statut: 'valide', montant_brut: amount });
  } catch (e) { next(e); }
});

router.delete('/:id/heures-sup/:hid', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'rh', 'finance', 'dg')) return res.status(403).json({ error: 'Accès refusé' });
    const hs = await db.queryOne('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?', [Number(req.params.hid), Number(req.params.id)]);
    if (!hs) return res.status(404).json({ error: 'Entrée heures sup introuvable' });
    if (hs.statut === 'integre_bulletin') return res.status(400).json({ error: 'Heures sup déjà intégrées dans un bulletin — suppression impossible' });
    if (hs.statut === 'valide' && !hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Seul Admin/DG peut supprimer des heures sup validées' });
    await db.transaction(async tx => {
      await tx.execute('DELETE FROM employes_heures_sup WHERE id=?', [hs.id]);
      await audit(tx, 'employes_heures_sup', hs.id, 'supprimer', { nb_heures: hs.nb_heures, type: hs.type, statut: hs.statut, safe_ecosystem: true }, req.user?.id);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

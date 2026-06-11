'use strict';

/**
 * Intercepteur RH : rend obligatoire la création parapheur pour les flux RH
 * dont la décision finale dépend du parapheur.
 *
 * Monté avant agents_safe_write/agents_ecosystem_safe/agents.js.
 */
const express = require('express');
const db = require('../database');
const { hasRole } = require('./auth');
const { creerEntreeParapheur } = require('../services/parapheur');

const router = express.Router();
const CONGE_TYPES = ['annuel', 'maladie', 'maternite', 'paternite', 'sans_solde', 'autre'];

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function dateOrNull(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}
function diffDaysInclusive(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1);
}
function canRH(user) { return hasRole(user, 'admin', 'dg', 'rh'); }
function agentActif(id, res) {
  const emp = db.prepare('SELECT * FROM employes WHERE id=?').get(id);
  if (!emp) {
    res.status(404).json({ error: 'Agent introuvable' });
    return null;
  }
  if (emp.actif !== 1 || emp.statut_dossier !== 'actif') {
    res.status(400).json({ error: "L'agent doit être actif" });
    return null;
  }
  return emp;
}
function audit(table, recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run(table, recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}
function param(cle, defaut) {
  const row = db.prepare('SELECT valeur FROM parametres WHERE cle=?').get(cle);
  return row ? row.valeur : defaut;
}
function congeSolde(employeId) {
  const year = String(new Date().getFullYear());
  const emp = db.prepare('SELECT date_embauche, conges_report_n1, conges_maladie_droit, conges_maladie_pris, conges_maladie_solde FROM employes WHERE id=?').get(employeId);
  if (!emp) return null;
  let acquis = 0;
  if (emp.date_embauche) {
    const taux = parseFloat(param('conges_jours_par_mois', '2.5')) || 2.5;
    const now = new Date();
    const emb = new Date(emp.date_embauche);
    const debAnnee = new Date(now.getFullYear(), 0, 1);
    const ref = emb > debAnnee ? emb : debAnnee;
    const mois = Math.min(12, Math.max(0, (now.getFullYear() - ref.getFullYear()) * 12 + (now.getMonth() - ref.getMonth()) + (now.getDate() >= ref.getDate() ? 1 : 0)));
    acquis = Math.min(30, Math.round(mois * taux * 2) / 2);
  }
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN statut IN ('approuve','termine') THEN nb_jours ELSE 0 END),0) AS pris,
      COALESCE(SUM(CASE WHEN statut IN ('demande','valide_sup') THEN nb_jours ELSE 0 END),0) AS en_attente
    FROM employes_conges
    WHERE employe_id=? AND type_conge='annuel' AND strftime('%Y', date_debut)=?
  `).get(employeId, year);
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

router.post('/:id/conges', (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const emp = agentActif(req.params.id, res); if (!emp) return;

    let type_conge = text(req.body?.type_conge, 'annuel') || 'annuel';
    if (!CONGE_TYPES.includes(type_conge)) return res.status(400).json({ error: `type_conge invalide. Valeurs : ${CONGE_TYPES.join(', ')}` });

    const date_debut = dateOrNull(req.body?.date_debut);
    const date_fin = dateOrNull(req.body?.date_fin);
    if (!date_debut || !date_fin) return res.status(400).json({ error: 'Dates requises' });
    if (date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });

    const nb_jours = diffDaysInclusive(date_debut, date_fin);
    if (!nb_jours) return res.status(400).json({ error: 'Dates invalides' });

    const motif = text(req.body?.motif);
    const notes = text(req.body?.notes);
    const force = req.body?.force_creation === true || req.body?.force_creation === 'true';

    const overlap = db.prepare(`
      SELECT id, date_debut, date_fin
      FROM employes_conges
      WHERE employe_id=?
        AND statut IN ('demande','valide_sup','approuve')
        AND date_debut <= ?
        AND date_fin >= ?
      LIMIT 1
    `).get(req.params.id, date_fin, date_debut);
    if (overlap) return res.status(409).json({ error: `Chevauchement avec un congé existant du ${overlap.date_debut} au ${overlap.date_fin}`, overlap_id: overlap.id });

    if (type_conge === 'annuel') {
      const s = congeSolde(req.params.id);
      if (s && nb_jours > s.solde_apres_attente && !force && !hasRole(req.user, 'admin')) {
        return res.status(400).json({ error: `Solde insuffisant : ${s.solde_apres_attente} jour(s) disponible(s) après demandes en attente`, solde: s, nb_jours });
      }
    }
    if (type_conge === 'maladie') {
      const s = congeSolde(req.params.id);
      if (nb_jours > s.maladie.solde && !force && !hasRole(req.user, 'admin')) {
        return res.status(400).json({ error: `Solde maladie insuffisant : ${s.maladie.solde} j disponible(s), ${nb_jours} demandé(s)`, solde_maladie: s.maladie.solde, nb_jours });
      }
      if (nb_jours > s.maladie.solde && force) type_conge = 'sans_solde';
    }

    const tx = db.transaction(() => {
      const r = db.prepare('INSERT INTO employes_conges (employe_id,type_conge,date_debut,date_fin,nb_jours,motif,notes,created_by) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.params.id, type_conge, date_debut, date_fin, nb_jours, motif, notes, req.user?.id || null);

      const titre = `Congé ${type_conge} — ${emp.nom} ${emp.prenom || ''} (${date_debut} → ${date_fin}, ${nb_jours}j)`;
      const parapheurId = creerEntreeParapheur({
        type: 'conge',
        titre,
        initiateur_id: req.user.id,
        ref_source_table: 'employes_conges',
        ref_source_id: r.lastInsertRowid,
        priorite: type_conge === 'maladie' ? 'urgent' : 'normal',
        required: true,
      });
      audit('employes_conges', r.lastInsertRowid, 'create', { type_conge, date_debut, date_fin, nb_jours, parapheur_id: parapheurId, required_parapheur: true }, req.user?.id);
      return { id: r.lastInsertRowid, parapheurId };
    });

    const out = tx();
    res.status(201).json({ id: out.id, parapheur_id: out.parapheurId, type_conge, date_debut, date_fin, nb_jours, motif, statut: 'demande', notes });
  } catch (e) { next(e); }
});

router.post('/:id/avances/:aid/soumettre', (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const emp = agentActif(req.params.id, res); if (!emp) return;
    const avance = db.prepare('SELECT * FROM employes_avances WHERE id=? AND employe_id=?').get(req.params.aid, req.params.id);
    if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
    if (avance.statut_workflow !== 'brouillon') return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — soumission impossible` });

    if (hasRole(req.user, 'admin', 'finance', 'dg')) {
      db.prepare("UPDATE employes_avances SET statut_workflow='approuve_dg', approuve_par=?, approuve_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .run(req.user.id, avance.id);
      audit('employes_avances', avance.id, 'soumettre_auto_approuver', { approuve_par: req.user.id }, req.user.id);
      return res.json({ ok: true, statut_workflow: 'approuve_dg', auto_approved: true });
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE employes_avances SET statut_workflow='soumis', updated_at=datetime('now') WHERE id=?").run(avance.id);
      const parapheurId = creerEntreeParapheur({
        type: 'avance_salaire',
        titre: `Avance salaire — ${emp.nom} ${emp.prenom || ''} (${new Intl.NumberFormat('fr-FR').format(avance.montant)} XAF)`,
        initiateur_id: req.user.id,
        montant: avance.montant,
        ref_source_table: 'employes_avances',
        ref_source_id: avance.id,
        priorite: 'normal',
        required: true,
      });
      audit('employes_avances', avance.id, 'soumettre', { parapheur_id: parapheurId, required_parapheur: true }, req.user.id);
      return parapheurId;
    });

    const parapheurId = tx();
    res.json({ ok: true, statut_workflow: 'soumis', parapheur_id: parapheurId });
  } catch (e) { next(e); }
});

module.exports = router;

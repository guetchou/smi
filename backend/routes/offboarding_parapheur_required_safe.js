'use strict';

/**
 * Intercepteur offboarding : le dossier de sortie ne doit pas être initié sans
 * entrée parapheur liée. Monté via agents_safe_write avant offboarding.js.
 */
const express = require('express');
const db = require('../database');
const { hasRole } = require('./auth');
const { creerEntreeParapheur } = require('../services/parapheur');

const router = express.Router();
const WRITE_ROLES = ['admin', 'rh', 'dg'];
const TYPES_SORTIE = ['demission', 'licenciement', 'licenciement_cause_reelle', 'retraite', 'fin_contrat', 'deces', 'rupture_conventionnelle'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function money(n) { return Math.round(Number(n || 0)); }
function text(v, fallback = '') { return v === undefined || v === null ? fallback : String(v).trim(); }
function dateOrNull(v) { return v ? String(v).slice(0, 10) : null; }
function calcAncienneteAnnees(dateEmbauche) {
  if (!dateEmbauche) return 0;
  const debut = new Date(dateEmbauche);
  const now = new Date();
  return Math.max(0, Math.floor(((now - debut) / (1000 * 60 * 60 * 24 * 365.25)) * 10) / 10);
}
function calcIndemnites(type_sortie, anciennete_annees, salaire_base) {
  const sal = money(salaire_base);
  let indemnite_licenciement = 0;
  let indemnite_preavis = 0;
  if (['licenciement', 'licenciement_cause_reelle', 'rupture_conventionnelle'].includes(type_sortie) && anciennete_annees >= 1) {
    const tranches = Math.floor(anciennete_annees / 5);
    indemnite_licenciement = tranches * sal;
    if (anciennete_annees >= 1 && tranches === 0) indemnite_licenciement = Math.round(sal * 0.5);
  }
  if (!['demission'].includes(type_sortie)) {
    if (anciennete_annees < 2) indemnite_preavis = sal;
    else if (anciennete_annees < 5) indemnite_preavis = sal * 2;
    else indemnite_preavis = sal * 3;
  }
  if (type_sortie === 'demission' && anciennete_annees >= 1) {
    indemnite_preavis = anciennete_annees < 2 ? sal : anciennete_annees < 5 ? sal * 2 : sal * 3;
  }
  return { indemnite_licenciement, indemnite_preavis };
}
function audit(id, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)')
      .run('employes_sortie', id, action, JSON.stringify(details || {}), userId || null);
  } catch (_) {}
}

router.post('/:id/sortie/initier', (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });

    const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    if (!['actif', 'suspendu'].includes(agent.statut_dossier)) {
      return res.status(400).json({ error: `L'agent doit être actif ou suspendu pour initier une sortie (statut actuel : ${agent.statut_dossier})` });
    }

    const existant = db.prepare("SELECT id, statut FROM employes_sortie WHERE employe_id = ? AND statut NOT IN ('solde','annule')").get(agent.id);
    if (existant) return res.status(409).json({ error: `Un dossier de sortie existe déjà pour cet agent (statut : ${existant.statut}, id: ${existant.id})` });

    const type_sortie = text(req.body?.type_sortie);
    const date_annonce = dateOrNull(req.body?.date_annonce);
    const date_depart_effectif = dateOrNull(req.body?.date_depart_effectif);
    const date_fin_preavis = dateOrNull(req.body?.date_fin_preavis);
    const notes = text(req.body?.notes) || null;
    const autres_indemnites = money(req.body?.autres_indemnites);

    if (!type_sortie || !TYPES_SORTIE.includes(type_sortie)) return res.status(400).json({ error: `type_sortie invalide. Valeurs : ${TYPES_SORTIE.join(', ')}` });
    if (!date_depart_effectif) return res.status(400).json({ error: 'date_depart_effectif requis' });
    if (date_annonce && date_depart_effectif < date_annonce) return res.status(400).json({ error: 'date_depart_effectif antérieure à date_annonce' });

    const anciennete_annees = calcAncienneteAnnees(agent.date_embauche);
    const { indemnite_licenciement, indemnite_preavis } = calcIndemnites(type_sortie, anciennete_annees, agent.salaire_base);
    const conges_restants = Math.max(0, Number(agent.conges_solde_annuel || 0));
    const salaire_journalier = Number(agent.salaire_base || 0) / 26;
    const conges_montant = Math.round(conges_restants * salaire_journalier);
    const solde_tout_compte = money(indemnite_licenciement + indemnite_preavis + conges_montant + autres_indemnites);

    const checkMateriel = req.body?.checklist_materiel || JSON.stringify(['Badge / carte d\'accès', 'Ordinateur portable', 'Téléphone professionnel', 'Clés / accès locaux', 'Documents confidentiels', 'Matériel de terrain']);
    const checkAcces = req.body?.checklist_acces || JSON.stringify(['Accès système informatique', 'Email professionnel', 'Accès intranet', 'Accès logiciels métier', 'Accès réseaux sociaux entreprise']);

    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO employes_sortie
          (employe_id, type_sortie, date_annonce, date_fin_preavis, date_depart_effectif,
           anciennete_annees, indemnite_licenciement, indemnite_preavis,
           conges_payes_restants, conges_payes_montant, autres_indemnites,
           solde_tout_compte_total, statut, checklist_materiel, checklist_acces,
           notes, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initie', ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        agent.id, type_sortie, date_annonce, date_fin_preavis, date_depart_effectif,
        anciennete_annees, indemnite_licenciement, indemnite_preavis,
        conges_restants, conges_montant, autres_indemnites,
        solde_tout_compte, checkMateriel, checkAcces, notes, req.user.id
      );

      const parapheurId = creerEntreeParapheur({
        type: 'offboarding',
        titre: `Offboarding — ${agent.nom} ${agent.prenom || ''} (${type_sortie}) — STC : ${new Intl.NumberFormat('fr-FR').format(solde_tout_compte)} XAF`,
        initiateur_id: req.user.id,
        montant: solde_tout_compte,
        ref_source_table: 'employes_sortie',
        ref_source_id: r.lastInsertRowid,
        priorite: 'urgent',
        required: true,
      });
      audit(r.lastInsertRowid, 'initier', { type_sortie, solde_tout_compte, parapheur_id: parapheurId, required_parapheur: true }, req.user.id);
      return { id: r.lastInsertRowid, parapheurId };
    });

    const out = tx();
    const dossier = db.prepare('SELECT * FROM employes_sortie WHERE id = ?').get(out.id);
    res.status(201).json({ ...dossier, parapheur_id: out.parapheurId });
  } catch (e) { next(e); }
});

module.exports = router;

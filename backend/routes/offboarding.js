/**
 * MODULE OFFBOARDING / SORTIE AGENT — TOP CENTER
 * Calcul légal indemnités + génération PDF solde tout compte + certificat de travail
 * Droit applicable : Congo-Brazzaville (OHADA, Code du travail congolais)
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const userProvSvc  = require('../services/user_provisioning');
const { creerEntreeParapheur } = require('../services/parapheur');

const WRITE_ROLES = ['admin', 'rh', 'dg'];
const VALID_ROLES = ['admin', 'dg'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function canValid(user) { return hasRole(user, ...VALID_ROLES); }

function audit(empId, action, details, userId) {
  try {
    db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
      .run('employes_sortie', empId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── Calcul indemnités (droit congolais) ─────────────────────────────────────

function calcAncienneteAnnees(dateEmbauche) {
  if (!dateEmbauche) return 0;
  const debut = new Date(dateEmbauche);
  const now   = new Date();
  const diff  = (now - debut) / (1000 * 60 * 60 * 24 * 365.25);
  return Math.max(0, Math.floor(diff * 10) / 10); // 1 décimale
}

function calcIndemnites(type_sortie, anciennete_annees, salaire_base) {
  const sal = salaire_base || 0;
  let indemnite_licenciement = 0;
  let indemnite_preavis      = 0;

  // Indemnité de licenciement (Congo) : 1 mois de salaire par tranche de 5 ans d'ancienneté
  // Applicable pour licenciement (toutes formes) et rupture conventionnelle
  if (['licenciement', 'licenciement_cause_reelle', 'rupture_conventionnelle'].includes(type_sortie) && anciennete_annees >= 1) {
    const tranches = Math.floor(anciennete_annees / 5);
    indemnite_licenciement = tranches * sal;
    // Minimum 1/2 mois si >= 1 an et < 5 ans
    if (anciennete_annees >= 1 && tranches === 0) {
      indemnite_licenciement = Math.round(sal * 0.5);
    }
  }

  // Indemnité de préavis (non applicable si démission sans préavis respecté)
  if (!['demission'].includes(type_sortie)) {
    if (anciennete_annees < 2)       indemnite_preavis = sal * 1;
    else if (anciennete_annees < 5)  indemnite_preavis = sal * 2;
    else                             indemnite_preavis = sal * 3;
  }

  // Pour démission : préavis seulement si ancienneté ≥ 1 an
  if (type_sortie === 'demission' && anciennete_annees >= 1) {
    indemnite_preavis = anciennete_annees < 2 ? sal : anciennete_annees < 5 ? sal * 2 : sal * 3;
  }

  return { indemnite_licenciement, indemnite_preavis };
}

// ─── Helpers PDF ─────────────────────────────────────────────────────────────

const { generatePdf } = require('../services/pdf');
const htmlToPdf = (html) => generatePdf(html, { prefix: 'off', marginTop: '15mm', marginBottom: '15mm', marginLeft: '18mm', marginRight: '18mm' });

function getEntreprise() {
  const rows = db.prepare('SELECT cle, valeur FROM parametres').all();
  const p = {};
  rows.forEach(r => { p[r.cle] = r.valeur; });
  const ent = db.prepare('SELECT * FROM entreprise LIMIT 1').get() || {};
  return { nom: ent.nom || p.societe || 'TOP CENTER', adresse: ent.adresse || '', logo_url: ent.logo_url || '' };
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtMontant(n, devise = 'XAF') {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)) + ' ' + devise;
}

// ─── GET /api/agents/sorties ─────────────────────────────────────────────────
// Doit rester avant /:id/sortie pour éviter que "sorties" soit interprété comme un id.
router.get('/sorties', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      s.*,
      e.id AS employe_id,
      e.nom || ' ' || COALESCE(e.prenom, '') AS employe_nom,
      e.matricule AS employe_matricule,
      e.poste,
      e.departement
    FROM employes_sortie s
    JOIN employes e ON e.id = s.employe_id
    ORDER BY
      CASE s.statut
        WHEN 'initie' THEN 1
        WHEN 'calcule' THEN 2
        WHEN 'valide' THEN 3
        ELSE 4
      END,
      COALESCE(s.date_depart_effectif, s.created_at) DESC
  `).all();

  res.json({ sorties: rows });
});

// ─── POST /api/agents/:id/sortie/initier ─────────────────────────────────────
router.post('/:id/sortie/initier', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });

  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  if (!['actif', 'suspendu'].includes(agent.statut_dossier))
    return res.status(400).json({ error: `L'agent doit être actif ou suspendu pour initier une sortie (statut actuel : ${agent.statut_dossier})` });

  // Bloquer si dossier sortie déjà en cours
  const existant = db.prepare("SELECT id, statut FROM employes_sortie WHERE employe_id = ? AND statut NOT IN ('solde')").get(agent.id);
  if (existant) return res.status(409).json({ error: `Un dossier de sortie existe déjà pour cet agent (statut : ${existant.statut}, id: ${existant.id})` });

  const {
    type_sortie, date_annonce, date_depart_effectif,
    date_fin_preavis, autres_indemnites = 0,
    checklist_materiel, checklist_acces, notes,
  } = req.body;

  const typesValides = ['demission', 'licenciement', 'licenciement_cause_reelle', 'retraite', 'fin_contrat', 'deces', 'rupture_conventionnelle'];
  if (!type_sortie || !typesValides.includes(type_sortie))
    return res.status(400).json({ error: `type_sortie invalide. Valeurs : ${typesValides.join(', ')}` });
  if (!date_depart_effectif)
    return res.status(400).json({ error: 'date_depart_effectif requis' });

  const anciennete_annees = calcAncienneteAnnees(agent.date_embauche);
  const { indemnite_licenciement, indemnite_preavis } = calcIndemnites(
    type_sortie, anciennete_annees, agent.salaire_base
  );

  const conges_restants  = Math.max(0, agent.conges_solde_annuel || 0);
  const salaire_journalier = (agent.salaire_base || 0) / 26;
  const conges_montant   = Math.round(conges_restants * salaire_journalier);
  const indemnites_autres = Number(autres_indemnites) || 0;

  const solde_tout_compte = indemnite_licenciement + indemnite_preavis + conges_montant + indemnites_autres;

  // Checklist par défaut
  const checkMateriel = checklist_materiel || JSON.stringify([
    'Badge / carte d\'accès', 'Ordinateur portable', 'Téléphone professionnel',
    'Clés / accès locaux', 'Documents confidentiels', 'Matériel de terrain',
  ]);
  const checkAcces = checklist_acces || JSON.stringify([
    'Accès système informatique', 'Email professionnel', 'Accès intranet',
    'Accès logiciels métier', 'Accès réseaux sociaux entreprise',
  ]);

  const r = db.prepare(`
    INSERT INTO employes_sortie
      (employe_id, type_sortie, date_annonce, date_fin_preavis, date_depart_effectif,
       anciennete_annees, indemnite_licenciement, indemnite_preavis,
       conges_payes_restants, conges_payes_montant, autres_indemnites,
       solde_tout_compte_total, statut, checklist_materiel, checklist_acces,
       notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initie', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    agent.id, type_sortie,
    date_annonce || null, date_fin_preavis || null, date_depart_effectif,
    anciennete_annees, indemnite_licenciement, indemnite_preavis,
    conges_restants, conges_montant, indemnites_autres,
    solde_tout_compte,
    checkMateriel, checkAcces,
    notes || null, req.user.id
  );

  audit(r.lastInsertRowid, 'initier', { type_sortie, solde_tout_compte }, req.user.id);

  // Connecteur parapheur (non bloquant)
  setImmediate(() => {
    Promise.resolve()
      .then(() => creerEntreeParapheur({
        type: 'offboarding',
        titre: `Offboarding — ${agent.nom} ${agent.prenom} (${type_sortie}) — STC : ${new Intl.NumberFormat('fr-FR').format(solde_tout_compte)} XAF`,
        initiateur_id: req.user.id,
        montant: solde_tout_compte,
        ref_source_table: 'employes_sortie',
        ref_source_id: r.lastInsertRowid,
        priorite: 'urgent',
      }))
      .catch(err => console.error('[offboarding] parapheur error:', err?.message));
  });

  res.status(201).json(db.prepare('SELECT * FROM employes_sortie WHERE id = ?').get(r.lastInsertRowid));
});

// ─── GET /api/agents/:id/sortie ──────────────────────────────────────────────
router.get('/:id/sortie', (req, res) => {
  const agent  = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const dossier = db.prepare('SELECT * FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.id);
  if (!dossier) return res.status(404).json({ error: 'Aucun dossier de sortie pour cet agent' });

  const creBy  = dossier.created_by  ? db.prepare('SELECT nom FROM users WHERE id=?').get(dossier.created_by)  : null;
  const valBy  = dossier.validated_by ? db.prepare('SELECT nom FROM users WHERE id=?').get(dossier.validated_by) : null;
  const devise = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get()?.valeur || 'XAF';

  res.json({
    ...dossier,
    agent: { id: agent.id, nom: agent.nom, prenom: agent.prenom, poste: agent.poste,
             departement: agent.departement, date_embauche: agent.date_embauche },
    created_by_nom:  creBy ? creBy.nom : null,
    validated_by_nom: valBy ? valBy.nom : null,
    devise,
    detail_calcul: {
      anciennete_annees:      dossier.anciennete_annees,
      salaire_base:           agent.salaire_base,
      indemnite_licenciement: dossier.indemnite_licenciement,
      indemnite_preavis:      dossier.indemnite_preavis,
      conges_restants_jours:  dossier.conges_payes_restants,
      conges_restants_montant:dossier.conges_payes_montant,
      autres_indemnites:      dossier.autres_indemnites,
      total:                  dossier.solde_tout_compte_total,
    },
  });
});

// ─── PUT /api/agents/:id/sortie/valider ──────────────────────────────────────
router.put('/:id/sortie/valider', (req, res) => {
  if (!canValid(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis pour valider une sortie' });

  const agent   = db.prepare('SELECT id, statut_dossier FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const dossier = db.prepare("SELECT * FROM employes_sortie WHERE employe_id = ? AND statut = 'initie'").get(agent.id);
  if (!dossier) return res.status(404).json({ error: 'Aucun dossier de sortie en statut initié' });

  db.transaction(() => {
    db.prepare(`
      UPDATE employes_sortie
      SET statut='valide', validated_by=?, validated_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, dossier.id);

    db.prepare(`
      UPDATE employes
      SET actif=0, statut_dossier='sorti', motif_sortie=?, date_sortie=?, updated_at=datetime('now')
      WHERE id=?
    `).run(dossier.type_sortie, dossier.date_depart_effectif, agent.id);

    // Audit dans la transaction pour atomicité
    try {
      db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
        .run('employes_sortie', dossier.id, 'valider', JSON.stringify({ type_sortie: dossier.type_sortie }), req.user.id);
      db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
        .run('employes', agent.id, 'statut_sorti', JSON.stringify({ motif: dossier.type_sortie }), req.user.id);
    } catch (_) {}
  })();

  res.json({ ok: true, statut: 'valide', employe_statut: 'sorti' });

  // Révoquer le compte utilisateur lié (non bloquant, après réponse)
  setImmediate(() => {
    Promise.resolve()
      .then(() => userProvSvc.revoquerAcces(agent.id, req.user.id, dossier.type_sortie, req.ip))
      .catch(err => console.error('[offboarding] revoquerAcces error:', err?.message));
  });
});

// ─── GET /api/agents/:id/sortie/solde-tout-compte-pdf ────────────────────────
router.get('/:id/sortie/solde-tout-compte-pdf', async (req, res) => {
  const agent   = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const dossier = db.prepare('SELECT * FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.id);
  if (!dossier) return res.status(404).json({ error: 'Aucun dossier de sortie' });

  const ent    = getEntreprise();
  const devise = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get()?.valeur || 'XAF';

  // Historique de postes occupés
  const mutations = db.prepare(
    'SELECT ancien_poste, nouveau_poste, date_effet FROM employes_mutations WHERE employe_id = ? ORDER BY date_effet ASC'
  ).all(agent.id);

  const typeLabel = {
    demission: 'Démission', licenciement: 'Licenciement', retraite: 'Départ en retraite',
    fin_contrat: 'Fin de contrat', deces: 'Décès', rupture_conventionnelle: 'Rupture conventionnelle',
  };

  const ligneRow = (label, montant, gras = false) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;${gras ? 'font-weight:600;' : ''}">${label}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;${gras ? 'font-weight:600;' : ''}">${fmtMontant(montant, devise)}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #1f2937; margin:0; padding:0; }
  .header { background:#1e3a5f; color:#fff; padding:20px 24px; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { margin:0; font-size:18px; letter-spacing:1px; }
  .header .sub { font-size:12px; opacity:.8; margin-top:4px; }
  .section { margin:18px 24px; }
  .section h2 { font-size:14px; color:#1e3a5f; border-bottom:2px solid #1e3a5f; padding-bottom:4px; margin-bottom:12px; }
  .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 24px; }
  .info-row { font-size:12px; }
  .info-row .label { color:#6b7280; font-size:11px; }
  table.calcul { width:100%; border-collapse:collapse; font-size:13px; }
  .total-row td { background:#1e3a5f; color:#fff; padding:8px 10px; font-weight:700; font-size:14px; }
  .signatures { margin:32px 24px; display:flex; justify-content:space-between; }
  .sig-block { width:45%; text-align:center; }
  .sig-block .sig-line { border-top:1px solid #374151; margin-top:40px; padding-top:6px; font-size:11px; color:#6b7280; }
  .footer { margin-top:24px; font-size:10px; color:#9ca3af; text-align:center; border-top:1px solid #e5e7eb; padding:8px 24px; }
</style></head><body>

<div class="header">
  <div>
    <div class="sub">${ent.nom}</div>
    <h1>SOLDE DE TOUT COMPTE</h1>
    <div class="sub">${typeLabel[dossier.type_sortie] || dossier.type_sortie} — ${fmtDate(dossier.date_depart_effectif)}</div>
  </div>
  <div style="text-align:right;font-size:12px;">
    <div>Établi le ${fmtDate(new Date().toISOString().slice(0,10))}</div>
    <div style="font-size:11px;opacity:.7;">${ent.adresse || ''}</div>
  </div>
</div>

<div class="section">
  <h2>Identification de l'agent</h2>
  <div class="info-grid">
    <div class="info-row"><div class="label">Nom & Prénom</div><strong>${agent.nom} ${agent.prenom || ''}</strong></div>
    <div class="info-row"><div class="label">Matricule</div>${agent.matricule || '—'}</div>
    <div class="info-row"><div class="label">Poste occupé</div>${agent.poste || '—'}</div>
    <div class="info-row"><div class="label">Département</div>${agent.departement || '—'}</div>
    <div class="info-row"><div class="label">Date d'embauche</div>${fmtDate(agent.date_embauche)}</div>
    <div class="info-row"><div class="label">Date de départ</div>${fmtDate(dossier.date_depart_effectif)}</div>
    <div class="info-row"><div class="label">Ancienneté</div>${dossier.anciennete_annees} an(s)</div>
    <div class="info-row"><div class="label">Type de départ</div>${typeLabel[dossier.type_sortie] || dossier.type_sortie}</div>
    <div class="info-row"><div class="label">N° CNSS</div>${agent.cnss || '—'}</div>
    <div class="info-row"><div class="label">Mode de paiement</div>${agent.mode_paiement || '—'}</div>
  </div>
</div>

<div class="section">
  <h2>Décompte des indemnités</h2>
  <table class="calcul">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="text-align:left;padding:8px 10px;font-size:12px;">Rubrique</th>
        <th style="text-align:right;padding:8px 10px;font-size:12px;">Montant (${devise})</th>
      </tr>
    </thead>
    <tbody>
      ${ligneRow('Salaire de base mensuel', agent.salaire_base)}
      ${dossier.indemnite_licenciement > 0 ? ligneRow(`Indemnité de licenciement (${dossier.anciennete_annees} ans)`, dossier.indemnite_licenciement) : ''}
      ${dossier.indemnite_preavis > 0 ? ligneRow('Indemnité de préavis', dossier.indemnite_preavis) : ''}
      ${dossier.conges_payes_restants > 0 ? ligneRow(`Congés payés restants (${dossier.conges_payes_restants} jours × ${fmtMontant(agent.salaire_base / 26, devise)}/j)`, dossier.conges_payes_montant) : ''}
      ${dossier.autres_indemnites > 0 ? ligneRow('Autres indemnités', dossier.autres_indemnites) : ''}
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td>TOTAL NET À VERSER</td>
        <td style="text-align:right">${fmtMontant(dossier.solde_tout_compte_total, devise)}</td>
      </tr>
    </tfoot>
  </table>
</div>

<div class="signatures">
  <div class="sig-block">
    <div class="sig-line">L'Agent<br>${agent.nom} ${agent.prenom || ''}</div>
  </div>
  <div class="sig-block">
    <div class="sig-line">Le Directeur Général<br>${ent.nom}</div>
  </div>
</div>

<div class="footer">
  Document généré le ${new Date().toLocaleDateString('fr-FR')} — ${ent.nom} — Confidentiel
</div>
</body></html>`;

  try {
    const buf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="solde-tout-compte-${agent.nom}-${agent.prenom || ''}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Génération PDF impossible : ' + err.message });
  }
});

// ─── GET /api/agents/:id/sortie/certificat-travail-pdf ───────────────────────
router.get('/:id/sortie/certificat-travail-pdf', async (req, res) => {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const ent = getEntreprise();
  const mutations = db.prepare(
    'SELECT * FROM employes_mutations WHERE employe_id = ? ORDER BY date_effet ASC'
  ).all(agent.id);

  // Construire la liste des postes occupés depuis les mutations
  const postesOccupes = [];
  if (agent.date_embauche) {
    const premierPoste = mutations.length > 0 ? (mutations[0].ancien_poste || agent.poste) : agent.poste;
    postesOccupes.push({ poste: premierPoste || '—', debut: agent.date_embauche, fin: mutations[0]?.date_effet || null });
  }
  mutations.forEach((m, i) => {
    const fin = mutations[i + 1]?.date_effet || null;
    if (m.nouveau_poste) postesOccupes.push({ poste: m.nouveau_poste, debut: m.date_effet, fin });
  });
  if (postesOccupes.length === 0) {
    postesOccupes.push({ poste: agent.poste || '—', debut: agent.date_embauche, fin: null });
  }
  // Fermer le dernier poste à la date de départ
  const dossier = db.prepare('SELECT date_depart_effectif FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.id);
  if (postesOccupes.length > 0 && !postesOccupes[postesOccupes.length - 1].fin) {
    postesOccupes[postesOccupes.length - 1].fin = dossier?.date_depart_effectif || new Date().toISOString().slice(0, 10);
  }

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size:13px; color:#1f2937; margin:0; padding:0; }
  .header { text-align:center; padding:28px 24px 16px; border-bottom:3px solid #1e3a5f; }
  .header .co { font-size:16px; font-weight:700; color:#1e3a5f; }
  .header .titre { font-size:22px; font-weight:700; letter-spacing:2px; margin:16px 0 4px; text-transform:uppercase; }
  .body { padding:24px 36px; }
  .para { margin-bottom:16px; line-height:1.7; }
  table.postes { width:100%; border-collapse:collapse; margin:16px 0; font-size:12px; }
  table.postes th { background:#1e3a5f; color:#fff; padding:7px 10px; text-align:left; }
  table.postes td { padding:7px 10px; border-bottom:1px solid #e5e7eb; }
  .signatures { margin-top:48px; display:flex; justify-content:space-between; padding:0 24px; }
  .sig-block { width:45%; text-align:center; }
  .sig-line { border-top:1px solid #374151; margin-top:44px; padding-top:6px; font-size:11px; color:#6b7280; }
  .footer { font-size:10px; color:#9ca3af; text-align:center; margin-top:32px; padding:8px 24px; border-top:1px solid #e5e7eb; }
  .mention { background:#f9fafb; border-left:3px solid #1e3a5f; padding:10px 14px; font-size:12px; color:#374151; margin-top:20px; }
</style></head><body>

<div class="header">
  <div class="co">${ent.nom}</div>
  ${ent.adresse ? `<div style="font-size:11px;color:#6b7280;">${ent.adresse}</div>` : ''}
  <div class="titre">Certificat de Travail</div>
  <div style="font-size:12px;color:#6b7280;">Délivré le ${fmtDate(new Date().toISOString().slice(0,10))}</div>
</div>

<div class="body">
  <div class="para">
    Je soussigné(e), Directeur(trice) Général(e) de <strong>${ent.nom}</strong>, certifie que :
  </div>

  <div class="para">
    <strong>M. / Mme ${agent.nom} ${agent.prenom || ''}</strong>${agent.matricule ? ` (Matricule : ${agent.matricule})` : ''},
    ${agent.date_naissance ? `né(e) le ${fmtDate(agent.date_naissance)}` : ''},
    a été employé(e) dans notre entreprise
    ${agent.date_embauche ? `du <strong>${fmtDate(agent.date_embauche)}</strong>` : ''}
    au <strong>${fmtDate(dossier?.date_depart_effectif || new Date().toISOString().slice(0, 10))}</strong>.
  </div>

  ${postesOccupes.length > 0 ? `
  <div class="para">Durant son emploi, il / elle a occupé les postes suivants :</div>
  <table class="postes">
    <thead><tr><th>Poste / Fonction</th><th>Du</th><th>Au</th></tr></thead>
    <tbody>
      ${postesOccupes.map(p => `
        <tr>
          <td>${p.poste}</td>
          <td>${fmtDate(p.debut)}</td>
          <td>${p.fin ? fmtDate(p.fin) : 'Départ'}</td>
        </tr>`).join('')}
    </tbody>
  </table>` : ''}

  <div class="para">
    Ce certificat de travail est délivré pour servir et valoir ce que de droit,
    sans engagement de notre part quant aux causes qui ont mis fin au contrat de travail.
  </div>

  <div class="mention">
    Conformément à l'article 70 du Code du Travail de la République du Congo, ce certificat mentionne
    uniquement la date d'entrée en service, la date de sortie et les emplois successivement occupés.
  </div>
</div>

<div class="signatures">
  <div class="sig-block">
    <div class="sig-line">L'intéressé(e)<br>${agent.nom} ${agent.prenom || ''}</div>
  </div>
  <div class="sig-block">
    <div class="sig-line">Le Directeur Général<br>${ent.nom}</div>
  </div>
</div>

<div class="footer">${ent.nom} — Document officiel — ${new Date().getFullYear()}</div>
</body></html>`;

  try {
    const buf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificat-travail-${agent.nom}-${agent.prenom || ''}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Génération PDF impossible : ' + err.message });
  }
});

module.exports = router;

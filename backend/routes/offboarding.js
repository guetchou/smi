'use strict';

/**
 * MODULE OFFBOARDING / SORTIE AGENT — TOP CENTER
 * Calcul légal indemnités + génération PDF solde tout compte + certificat de travail.
 * Les écritures critiques délèguent au workflow transactionnel offboarding_workflow.
 * Invariant de validation, exécuté dans offboarding_workflow :
 * UPDATE employes SET actif=0, statut_dossier='sorti'
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');
const userProvSvc = require('../services/user_provisioning');
const {
  initiateOffboarding,
  validateOffboarding,
} = require('../services/offboarding_workflow');

const WRITE_ROLES = ['admin', 'rh', 'dg'];
const VALID_ROLES = ['admin', 'dg'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function canValid(user) { return hasRole(user, ...VALID_ROLES); }

const { generatePdf } = require('../services/pdf');
const htmlToPdf = (html) => generatePdf(html, {
  prefix: 'off',
  marginTop: '15mm',
  marginBottom: '15mm',
  marginLeft: '18mm',
  marginRight: '18mm',
});

async function getEntreprise() {
  const [rows, entRow] = await Promise.all([
    db.query('SELECT cle, valeur FROM parametres'),
    db.queryOne('SELECT * FROM entreprise LIMIT 1'),
  ]);
  const p = {};
  rows.forEach(r => { p[r.cle] = r.valeur; });
  const ent = entRow || {};
  return {
    nom: ent.nom || p.societe || 'TOP CENTER',
    adresse: ent.adresse || '',
    logo_url: ent.logo_url || '',
  };
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function fmtMontant(n, devise = 'XAF') {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)) + ' ' + devise;
}

function sendWorkflowError(res, error) {
  if (!error?.status) return false;
  res.status(error.status).json({ error: error.message, code: error.code || undefined });
  return true;
}

router.get('/sorties', async (_req, res, next) => {
  try {
    const rows = await db.query(`
      SELECT
        s.*,
        e.id AS employe_id,
        CONCAT(e.nom, ' ', COALESCE(e.prenom, '')) AS employe_nom,
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
    `);
    res.json({ sorties: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sortie/initier', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });

    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [Number(req.params.id)]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    if (!['actif', 'suspendu'].includes(agent.statut_dossier)) {
      return res.status(400).json({
        error: `L'agent doit être actif ou suspendu pour initier une sortie (statut actuel : ${agent.statut_dossier})`,
      });
    }

    const existant = await db.queryOne(
      "SELECT id, statut FROM employes_sortie WHERE employe_id = ? AND statut NOT IN ('solde') ORDER BY id DESC LIMIT 1",
      [agent.id],
    );
    if (existant) {
      return res.status(409).json({
        error: `Un dossier de sortie existe déjà pour cet agent (statut : ${existant.statut}, id: ${existant.id})`,
      });
    }

    const result = await initiateOffboarding({
      agent,
      payload: req.body || {},
      actorId: req.user.id,
      dbc: db,
    });
    const dossier = await db.queryOne('SELECT * FROM employes_sortie WHERE id = ?', [result.id]);
    res.status(201).json(dossier);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.get('/:id/sortie', async (req, res, next) => {
  try {
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [Number(req.params.id)]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

    const dossier = await db.queryOne(
      'SELECT * FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1',
      [agent.id],
    );
    if (!dossier) return res.status(404).json({ error: 'Aucun dossier de sortie pour cet agent' });

    const [creBy, valBy, deviseRow] = await Promise.all([
      dossier.created_by ? db.queryOne('SELECT nom FROM users WHERE id=?', [dossier.created_by]) : null,
      dossier.validated_by ? db.queryOne('SELECT nom FROM users WHERE id=?', [dossier.validated_by]) : null,
      db.queryOne("SELECT valeur FROM parametres WHERE cle='devise'"),
    ]);
    const devise = deviseRow?.valeur || 'XAF';

    res.json({
      ...dossier,
      agent: {
        id: agent.id,
        nom: agent.nom,
        prenom: agent.prenom,
        poste: agent.poste,
        departement: agent.departement,
        date_embauche: agent.date_embauche,
      },
      created_by_nom: creBy ? creBy.nom : null,
      validated_by_nom: valBy ? valBy.nom : null,
      devise,
      detail_calcul: {
        anciennete_annees: dossier.anciennete_annees,
        salaire_base: agent.salaire_base,
        indemnite_licenciement: dossier.indemnite_licenciement,
        indemnite_preavis: dossier.indemnite_preavis,
        conges_restants_jours: dossier.conges_payes_restants,
        conges_restants_montant: dossier.conges_payes_montant,
        autres_indemnites: dossier.autres_indemnites,
        total: dossier.solde_tout_compte_total,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id/sortie/valider', async (req, res, next) => {
  try {
    if (!canValid(req.user)) {
      return res.status(403).json({ error: 'Rôle DG ou Admin requis pour valider une sortie' });
    }

    const out = await validateOffboarding({
      employeeId: Number(req.params.id),
      actorId: req.user.id,
      dbc: db,
    });

    try {
      await Promise.resolve(userProvSvc.revoquerAcces(
        out.employeeId,
        req.user.id,
        out.typeSortie,
        req.ip,
      ));
    } catch (_) {}

    res.json({ ok: true, statut: 'valide', employe_statut: 'sorti' });
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.get('/:id/sortie/solde-tout-compte-pdf', async (req, res, next) => {
  try {
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [Number(req.params.id)]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

    const dossier = await db.queryOne(
      'SELECT * FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1',
      [agent.id],
    );
    if (!dossier) return res.status(404).json({ error: 'Aucun dossier de sortie' });

    const [ent, deviseRow, mutations] = await Promise.all([
      getEntreprise(),
      db.queryOne("SELECT valeur FROM parametres WHERE cle='devise'"),
      db.query(
        'SELECT ancien_poste, nouveau_poste, date_effet FROM employes_mutations WHERE employe_id = ? ORDER BY date_effet ASC',
        [agent.id],
      ),
    ]);
    void mutations;
    const devise = deviseRow?.valeur || 'XAF';

    const typeLabel = {
      demission: 'Démission',
      licenciement: 'Licenciement',
      licenciement_cause_reelle: 'Licenciement pour cause réelle',
      retraite: 'Départ en retraite',
      fin_contrat: 'Fin de contrat',
      deces: 'Décès',
      rupture_conventionnelle: 'Rupture conventionnelle',
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
    } catch (error) {
      res.status(500).json({ error: 'Génération PDF impossible : ' + error.message });
    }
  } catch (error) {
    next(error);
  }
});

router.get('/:id/sortie/certificat-travail-pdf', async (req, res, next) => {
  try {
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [Number(req.params.id)]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

    const [ent, mutations, dossier] = await Promise.all([
      getEntreprise(),
      db.query('SELECT * FROM employes_mutations WHERE employe_id = ? ORDER BY date_effet ASC', [agent.id]),
      db.queryOne(
        'SELECT date_depart_effectif FROM employes_sortie WHERE employe_id = ? ORDER BY created_at DESC LIMIT 1',
        [agent.id],
      ),
    ]);

    const postesOccupes = [];
    if (agent.date_embauche) {
      const premierPoste = mutations.length > 0 ? (mutations[0].ancien_poste || agent.poste) : agent.poste;
      postesOccupes.push({
        poste: premierPoste || '—',
        debut: agent.date_embauche,
        fin: mutations[0]?.date_effet || null,
      });
    }
    mutations.forEach((m, i) => {
      const fin = mutations[i + 1]?.date_effet || null;
      if (m.nouveau_poste) postesOccupes.push({ poste: m.nouveau_poste, debut: m.date_effet, fin });
    });
    if (postesOccupes.length === 0) {
      postesOccupes.push({ poste: agent.poste || '—', debut: agent.date_embauche, fin: null });
    }
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
    } catch (error) {
      res.status(500).json({ error: 'Génération PDF impossible : ' + error.message });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;

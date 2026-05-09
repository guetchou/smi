/**
 * MODULE SALAIRES — TOP CENTER
 * Calcul OHADA / Congo-Brazzaville
 * CNSS, CAMU, IRPP progressif, bulletin de paie complet
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { creerNotification, evaluerAlerteSoldes } = require('../services/notif');

// Importé après le premier require pour éviter la dépendance circulaire
// (operations.js charge aussi database.js — pas de problème, Node met en cache)
let recalculateSoldes;
setImmediate(() => {
  ({ recalculateSoldes } = require('./operations'));
});

// Rôles autorisés pour les opérations financières de paie
const FINANCE_ROLES = ['admin', 'caissier', 'finance'];
// Rôles autorisés pour la gestion RH (bulletins inclus avant paiement)
const RH_FINANCE_ROLES = ['admin', 'caissier', 'finance', 'rh'];
const WRITE_ROLES = ['admin', 'caissier', 'finance', 'rh', 'dg', 'assistante_direction', 'delegue'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTaux() {
  const rows = db.prepare('SELECT cle, valeur FROM parametres').all();
  const p    = {};
  rows.forEach(r => { p[r.cle] = parseFloat(r.valeur) || 0; });
  return {
    cnss_employe : p.cnss_employe_taux  || 4.725,
    cnss_patron  : p.cnss_patron_taux   || 20,
    camu_employe : p.camu_employe_taux  || 2.25,
    camu_patron  : p.camu_patron_taux   || 5,
    irpp: {
      plafond_t1 : p.irpp_plafond_t1 || 464000,
      taux_t2    : p.irpp_taux_t2    || 10,
      plafond_t2 : p.irpp_plafond_t2 || 1000000,
      taux_t3    : p.irpp_taux_t3    || 25,
      plafond_t3 : p.irpp_plafond_t3 || 3000000,
      taux_t4    : p.irpp_taux_t4    || 40,
    },
  };
}

function canFinance(user) {
  return hasRole(user, ...FINANCE_ROLES);
}

function canRHFinance(user) {
  return hasRole(user, ...RH_FINANCE_ROLES);
}

function canWrite(user) {
  return hasRole(user, ...WRITE_ROLES);
}

function getDevise() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get();
  return r ? r.valeur : 'XAF';
}

function getSociete() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='societe'").get();
  return r ? r.valeur : 'TOP CENTER';
}

/**
 * Retourne les rubriques paie custom configurées dans les paramètres.
 * Format JSON : [{ nom, type:'prime'|'retenue', calcul:'fixe'|'pct_brut', valeur }]
 */
function getRubriquesPaieCustom() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='rubriques_custom'").get();
  if (!r || !r.valeur) return [];
  try { return JSON.parse(r.valeur); } catch { return []; }
}

/**
 * Calcule toutes les rubriques d'un bulletin à partir du brut et des taux.
 */
function calculer(base, primes, taux, rubriquesCustom = []) {
  const { prime_transport = 0, prime_logement = 0, autres_primes = 0 } = primes;

  // Rubriques custom : primes additionnelles
  let extra_primes   = 0;
  let extra_retenues = 0;
  const lignes_custom = [];
  for (const r of rubriquesCustom) {
    const montant = r.calcul === 'pct_brut'
      ? Math.round((base + prime_transport + prime_logement + autres_primes) * (parseFloat(r.valeur) || 0) / 100)
      : Math.round(parseFloat(r.valeur) || 0);
    lignes_custom.push({ nom: r.nom, type: r.type, montant });
    if (r.type === 'prime')   extra_primes   += montant;
    else                       extra_retenues += montant;
  }

  const brut = base + prime_transport + prime_logement + autres_primes + extra_primes;

  // Cotisations salariales
  const cnss_employe = Math.round(brut * taux.cnss_employe / 100);
  const camu_employe = Math.round(brut * taux.camu_employe / 100);

  // Net imposable = brut – cotisations sociales salariales
  const net_imposable = brut - cnss_employe - camu_employe;

  // IRPP — barème progressif mensuel Congo-Brazzaville
  const tranches = [
    { seuil: 0,                   plafond: taux.irpp.plafond_t1, taux: 0 },
    { seuil: taux.irpp.plafond_t1, plafond: taux.irpp.plafond_t2, taux: taux.irpp.taux_t2 / 100 },
    { seuil: taux.irpp.plafond_t2, plafond: taux.irpp.plafond_t3, taux: taux.irpp.taux_t3 / 100 },
    { seuil: taux.irpp.plafond_t3, plafond: Infinity,             taux: taux.irpp.taux_t4 / 100 },
  ];
  let irpp = 0;
  for (const t of tranches) {
    if (net_imposable <= t.seuil) break;
    const base_tranche = Math.min(net_imposable, t.plafond) - t.seuil;
    irpp += base_tranche * t.taux;
  }
  irpp = Math.round(irpp);

  const total_retenues       = cnss_employe + camu_employe + irpp + extra_retenues;
  const net_a_payer          = brut - total_retenues;

  // Charges patronales
  const cnss_patronal        = Math.round(brut * taux.cnss_patron / 100);
  const camu_patronal        = Math.round(brut * taux.camu_patron / 100);
  const cout_total_employeur = brut + cnss_patronal + camu_patronal;

  return {
    brut, cnss_employe, camu_employe, irpp,
    total_retenues, net_imposable, net_a_payer,
    cnss_patronal, camu_patronal, cout_total_employeur,
    lignes_custom,
    extra_primes, extra_retenues,
  };
}

// ─── Rapport mensuel ─────────────────────────────────────────────────────────

router.get('/rapport', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const employes  = db.prepare("SELECT * FROM employes WHERE actif = 1 AND statut_dossier = 'actif' ORDER BY type, nom").all();
  const bulletins = db.prepare(
    'SELECT * FROM bulletins_salaire WHERE mois = ? AND annee = ?'
  ).all(mois, annee);
  const bulMap = {};
  bulletins.forEach(b => { bulMap[b.employe_id] = b; });

  // Paiements réalisés via opérations caisse (pour les bulletins en statut paye)
  const debut = `${annee}-${String(mois).padStart(2,'0')}-01`;
  const fin   = `${annee}-${String(mois).padStart(2,'0')}-31`;
  const paiements = db.prepare(`
    SELECT employe_id, SUM(montant) as paye
    FROM operations
    WHERE date BETWEEN ? AND ?
      AND statut != 'annule'
      AND employe_id IS NOT NULL
      AND type_op = 'decaissement'
    GROUP BY employe_id
  `).all(debut, fin);
  const payMap = {};
  paiements.forEach(p => { payMap[p.employe_id] = p.paye || 0; });

  const liste = employes.map(e => ({
    ...e,
    bulletin : bulMap[e.id] || null,
    paye     : payMap[e.id] || 0,
  }));

  const totaux = {
    brut    : liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.brut        : e.salaire_base), 0),
    net     : liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.net_a_payer : e.salaire_base), 0),
    paye    : liste.reduce((s, e) => s + e.paye, 0),
    restant : 0,
    patronal: liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.cnss_patronal + e.bulletin.camu_patronal : 0), 0),
  };
  totaux.restant = totaux.net - totaux.paye;

  res.json({ mois, annee, employes: liste, totaux });
});

// ─── Générer bulletins du mois ────────────────────────────────────────────────

router.post('/generer', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee, employe_id } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });

  const taux  = getTaux();
  const where = employe_id
    ? "WHERE actif = 1 AND statut_dossier = 'actif' AND id = ?"
    : "WHERE actif = 1 AND statut_dossier = 'actif'";
  const employes = employe_id
    ? db.prepare(`SELECT * FROM employes ${where}`).all(employe_id)
    : db.prepare(`SELECT * FROM employes ${where} ORDER BY type, nom`).all();

  const upsert = db.prepare(`
    INSERT INTO bulletins_salaire
      (employe_id, mois, annee, salaire_base, prime_transport, prime_logement, autres_primes,
       brut, cnss_employe, camu_employe, irpp, total_retenues, net_imposable, net_a_payer,
       cnss_patronal, camu_patronal, cout_total_employeur, lignes_custom, statut, created_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'brouillon',?,datetime('now'))
    ON CONFLICT(employe_id, mois, annee) DO UPDATE SET
      salaire_base=excluded.salaire_base,
      prime_transport=excluded.prime_transport,
      prime_logement=excluded.prime_logement,
      autres_primes=excluded.autres_primes,
      brut=excluded.brut,
      cnss_employe=excluded.cnss_employe,
      camu_employe=excluded.camu_employe,
      irpp=excluded.irpp,
      total_retenues=excluded.total_retenues,
      net_imposable=excluded.net_imposable,
      net_a_payer=excluded.net_a_payer,
      cnss_patronal=excluded.cnss_patronal,
      camu_patronal=excluded.camu_patronal,
      cout_total_employeur=excluded.cout_total_employeur,
      lignes_custom=excluded.lignes_custom,
      updated_at=datetime('now')
    WHERE bulletins_salaire.statut = 'brouillon'
  `);

  // Séparer les agents sans salaire (bloqués) des agents éligibles
  const sansalaire = employes.filter(e => !e.salaire_base || e.salaire_base <= 0);
  const eligibles  = employes.filter(e => e.salaire_base > 0);

  if (employe_id && sansalaire.length > 0) {
    // Génération individuelle : refus explicite
    return res.status(400).json({
      error: `Impossible de générer le bulletin : salaire de base non défini ou nul pour ${sansalaire[0].nom} ${sansalaire[0].prenom}. Corrigez le dossier avant de générer.`
    });
  }

  const rubriquesCustom = getRubriquesPaieCustom();
  const tx = db.transaction(() => {
    for (const e of eligibles) {
      const primes = { prime_transport: 0, prime_logement: 0, autres_primes: 0 };
      const calc   = calculer(e.salaire_base, primes, taux, rubriquesCustom);
      upsert.run(
        e.id, mois, annee,
        e.salaire_base, 0, 0, 0,
        calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
        calc.total_retenues, calc.net_imposable, calc.net_a_payer,
        calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
        JSON.stringify(calc.lignes_custom || []),
        req.user.id
      );
    }
  });
  tx();

  res.json({
    ok: true,
    count: eligibles.length,
    mois, annee,
    ignores: sansalaire.map(e => ({ id: e.id, nom: e.nom, prenom: e.prenom, raison: 'salaire_base non défini' }))
  });
});

// ─── Détail d'un bulletin ─────────────────────────────────────────────────────

router.get('/bulletin/:id', (req, res) => {
  const bulletin = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bulletin) return res.status(404).json({ error: 'Bulletin introuvable' });

  const employe = db.prepare('SELECT * FROM employes WHERE id = ?').get(bulletin.employe_id);

  // Référence décaissement (numéro de pièce de l'opération liée)
  let reference_decaissement = null;
  if (bulletin.operation_id) {
    const op = db.prepare('SELECT num_piece FROM operations WHERE id = ?').get(bulletin.operation_id);
    reference_decaissement = op?.num_piece || `OP-${bulletin.operation_id}`;
  }

  // Avances en cours de cet employé (pour proposer une retenue)
  const avances_actives = db.prepare(
    "SELECT id, date, montant, solde_restant, motif FROM employes_avances WHERE employe_id = ? AND statut = 'en_cours' ORDER BY date"
  ).all(bulletin.employe_id);

  res.json({
    bulletin: { ...bulletin, reference_decaissement },
    employe,
    avances_actives,
    devise: getDevise(),
    societe: getSociete(),
    taux: getTaux()
  });
});

// ─── Helper audit ─────────────────────────────────────────────────────────────
function auditBulletin(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('bulletins_salaire', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── Helper log d'envoi ────────────────────────────────────────────────────────
function logEnvoi({ bulletin_id, employe_id, mois, annee, canal = 'email',
                    destinataire = null, statut, erreur = null,
                    avec_pdf = 0, groupe = 0, envoye_par = null }) {
  try {
    db.prepare(`
      INSERT INTO bulletin_envois
        (bulletin_id, employe_id, mois, annee, canal, destinataire,
         statut, erreur, avec_pdf, groupe, envoye_par)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(bulletin_id, employe_id, mois, annee, canal, destinataire,
           statut, erreur || null, avec_pdf ? 1 : 0, groupe ? 1 : 0, envoye_par);
    if (statut === 'envoye') {
      db.prepare(`
        UPDATE bulletins_salaire
        SET dernier_envoi_at = datetime('now'),
            dernier_envoi_dest = ?,
            nb_envois = COALESCE(nb_envois, 0) + 1
        WHERE id = ?
      `).run(destinataire, bulletin_id);
    }
  } catch (_) {}
}

// ─── Helper HTML bulletin (factorisé — utilisé par email ET PDF) ──────────────
function buildHtmlBulletin(bul, emp, opts = {}) {
  const devise   = opts.devise   || getDevise();
  const societe  = opts.societe  || getSociete();
  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const moisLabel = `${nomsMois[bul.mois] || bul.mois} ${bul.annee}`;
  const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v || 0);
  let lignesCustom = [];
  try { lignesCustom = bul.lignes_custom ? JSON.parse(bul.lignes_custom) : []; } catch { lignesCustom = []; }
  const netAVerser = (bul.retenue_avance > 0 && bul.net_a_verser > 0) ? bul.net_a_verser : bul.net_a_payer;
  const cnssEmplPct = bul.brut > 0 ? (bul.cnss_employe / bul.brut * 100).toFixed(3) : '4.725';

  const ligneGain = (label, val) => val > 0
    ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${label}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f1f5f9">${fmt(val)}&nbsp;${devise}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f1f5f9">—</td></tr>` : '';
  const ligneRet = (label, val, rouge = false) => val > 0
    ? `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${label}</td><td style="text-align:right;border-bottom:1px solid #f1f5f9">—</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f1f5f9;${rouge?'color:#dc2626':''}">${fmt(val)}&nbsp;${devise}</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;font-size:13px;color:#1e293b;margin:0;padding:24px;max-width:700px}
  h1{font-size:16px;margin:0}
  table{width:100%;border-collapse:collapse}
  th{background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;border-bottom:2px solid #e2e8f0;font-size:12px}
  th:not(:first-child){text-align:right}
  .section-title{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;padding:10px 0 4px;border-bottom:1px solid #e2e8f0;margin-bottom:2px}
  .total-row{font-weight:700;background:#f8fafc}
  .net-row{background:#f0fdf4;font-weight:700}
  .net-row td{padding:10px!important;color:#15803d;font-size:15px}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#f8fafc;border-radius:8px;padding:12px;margin:12px 0;font-size:12px}
  .info-label{color:#64748b}
  .sig-box{border:1px solid #e2e8f0;border-radius:8px;padding:14px;min-height:60px;font-size:12px}
  .charge-row td{color:#92400e;font-size:12px}
  @media print{body{padding:12px}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #e2e8f0;padding-bottom:14px;margin-bottom:14px">
  <div><h1>${societe}</h1><div style="color:#64748b;font-size:12px">Brazzaville, République du Congo</div></div>
  <div style="text-align:right">
    <div style="font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:.05em">Bulletin de Paie</div>
    <div style="color:#64748b;font-size:12px">Période : ${moisLabel}</div>
    <div style="color:#64748b;font-size:12px">Émis le ${new Date().toLocaleDateString('fr-FR')}</div>
  </div>
</div>

<div class="info-grid">
  <div><span class="info-label">Employé : </span><strong>${emp.nom} ${emp.prenom || ''}</strong></div>
  <div><span class="info-label">Poste : </span>${emp.poste || '—'}</div>
  <div><span class="info-label">Matricule : </span>${emp.matricule || '—'}</div>
  <div><span class="info-label">N° CNSS : </span>${emp.cnss || '—'}</div>
  <div><span class="info-label">Contrat : </span>${emp.type === 'permanent' ? 'Permanent' : 'Stagiaire'}</div>
  <div><span class="info-label">Mode paiement : </span>${emp.mode_paiement === 'virement_bancaire' ? `Virement — ${emp.banque || ''} ${emp.numero_compte || ''}` : 'Espèces'}</div>
</div>

<div class="section-title">Rémunération</div>
<table>
  <thead><tr><th>Rubrique</th><th>Gain</th><th>Retenue</th></tr></thead>
  <tbody>
    ${ligneGain('Salaire de base', bul.salaire_base)}
    ${ligneGain('Prime de transport', bul.prime_transport)}
    ${ligneGain('Prime de logement', bul.prime_logement)}
    ${ligneGain('Autres primes', bul.autres_primes)}
    ${lignesCustom.map(l => l.type === 'prime' ? ligneGain(l.nom, l.montant) : ligneRet(l.nom, l.montant)).join('')}
    <tr class="total-row"><td style="padding:8px 10px">Salaire brut</td><td style="padding:8px 10px;text-align:right">${fmt(bul.brut)}&nbsp;${devise}</td><td style="text-align:right">—</td></tr>
  </tbody>
</table>

<div class="section-title" style="margin-top:10px">Retenues salariales</div>
<table><tbody>
  ${ligneRet(`CNSS salarié (${cnssEmplPct}%)`, bul.cnss_employe)}
  ${ligneRet('CAMU salarié (2,25%)', bul.camu_employe)}
  ${ligneRet('IRPP (barème progressif)', bul.irpp)}
  ${bul.retenue_avance > 0 ? ligneRet('Retenue avance sur salaire', bul.retenue_avance, true) : ''}
  <tr class="total-row"><td style="padding:8px 10px">Total retenues</td><td style="text-align:right">—</td><td style="padding:8px 10px;text-align:right">${fmt(bul.total_retenues + (bul.retenue_avance || 0))}&nbsp;${devise}</td></tr>
</tbody></table>

<table style="margin-top:10px"><tbody>
  <tr class="net-row"><td style="padding:10px">NET À PAYER</td><td style="padding:10px;text-align:right">${fmt(netAVerser)}&nbsp;${devise}</td><td style="text-align:right">—</td></tr>
</tbody></table>

<div class="section-title" style="margin-top:10px">Charges patronales (information)</div>
<table><tbody>
  <tr class="charge-row"><td style="padding:5px 10px">CNSS patronal (20%)</td><td></td><td style="padding:5px 10px;text-align:right">${fmt(bul.cnss_patronal)}&nbsp;${devise}</td></tr>
  <tr class="charge-row"><td style="padding:5px 10px">CAMU patronal (5%)</td><td></td><td style="padding:5px 10px;text-align:right">${fmt(bul.camu_patronal)}&nbsp;${devise}</td></tr>
  <tr style="font-weight:700"><td style="padding:8px 10px;border-top:1px solid #e2e8f0">Coût total employeur</td><td></td><td style="padding:8px 10px;text-align:right;border-top:1px solid #e2e8f0">${fmt(bul.cout_total_employeur)}&nbsp;${devise}</td></tr>
</tbody></table>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px;padding-top:14px;border-top:1px solid #e2e8f0">
  <div class="sig-box"><div style="font-weight:700;font-size:11px;color:#64748b;margin-bottom:8px">L'EMPLOYEUR</div><div style="color:#94a3b8;font-size:11px">Nom &amp; signature :</div></div>
  <div class="sig-box">
    <div style="font-weight:700;font-size:11px;color:#64748b;margin-bottom:4px">L'EMPLOYÉ(E)</div>
    <div style="font-weight:600">${emp.nom} ${emp.prenom || ''}</div>
    <div style="color:#64748b;font-size:11px;margin-top:4px">Certifie avoir reçu ${fmt(netAVerser)}&nbsp;${devise}</div>
  </div>
</div>
${bul.notes ? `<p style="margin-top:12px;font-size:11px;color:#64748b;font-style:italic">Notes : ${bul.notes}</p>` : ''}
</body></html>`;
}

// ─── Générer PDF d'un bulletin via wkhtmltopdf ────────────────────────────────
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function htmlToPdf(htmlContent) {
  return new Promise((resolve, reject) => {
    const tmpHtml = path.join(os.tmpdir(), `bul_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
    const tmpPdf  = tmpHtml.replace('.html', '.pdf');
    fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

    const proc = spawn('wkhtmltopdf', [
      '--quiet',
      '--page-size', 'A4',
      '--margin-top',    '12mm',
      '--margin-bottom', '12mm',
      '--margin-left',   '14mm',
      '--margin-right',  '14mm',
      '--encoding', 'UTF-8',
      '--disable-smart-shrinking',
      tmpHtml, tmpPdf
    ]);

    proc.on('close', code => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      if (code !== 0) {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
        return reject(new Error(`wkhtmltopdf a échoué (code ${code})`));
      }
      if (!fs.existsSync(tmpPdf)) return reject(new Error('PDF non généré'));
      const buf = fs.readFileSync(tmpPdf);
      try { fs.unlinkSync(tmpPdf); } catch (_) {}
      resolve(buf);
    });

    proc.on('error', err => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      reject(new Error('wkhtmltopdf introuvable : ' + err.message));
    });
  });
}

// ─── Modifier les primes d'un bulletin ───────────────────────────────────────

router.put('/bulletin/:id', (req, res) => {
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'valide') return res.status(400).json({ error: 'Bulletin validé — annulez-le d\'abord pour le modifier' });
  if (bul.statut === 'paye')   return res.status(400).json({ error: 'Bulletin payé, modification impossible' });

  const {
    prime_transport = bul.prime_transport,
    prime_logement  = bul.prime_logement,
    autres_primes   = bul.autres_primes,
    notes           = bul.notes,
    retenue_avance  = bul.retenue_avance || 0,
    avance_id       = bul.avance_id || null,
  } = req.body;

  const taux    = getTaux();
  const rubriquesCustom = getRubriquesPaieCustom();
  const employe = db.prepare('SELECT salaire_base FROM employes WHERE id = ?').get(bul.employe_id);
  const primes  = { prime_transport, prime_logement, autres_primes };
  const calc    = calculer(employe.salaire_base, primes, taux, rubriquesCustom);
  const net_a_verser = calc.net_a_payer - Math.max(0, retenue_avance);

  db.prepare(`
    UPDATE bulletins_salaire SET
      prime_transport=?, prime_logement=?, autres_primes=?,
      brut=?, cnss_employe=?, camu_employe=?, irpp=?,
      total_retenues=?, net_imposable=?, net_a_payer=?,
      cnss_patronal=?, camu_patronal=?, cout_total_employeur=?,
      lignes_custom=?,
      notes=?, retenue_avance=?, avance_id=?, net_a_verser=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    prime_transport, prime_logement, autres_primes,
    calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
    calc.total_retenues, calc.net_imposable, calc.net_a_payer,
    calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
    JSON.stringify(calc.lignes_custom || []),
    notes, retenue_avance, avance_id, net_a_verser,
    req.params.id
  );

  res.json({ ok: true, ...calc, net_a_verser });
});

// ─── Attacher une retenue avance à un bulletin ────────────────────────────────

router.post('/bulletin/:id/retenue-avance', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: 'Seul un bulletin brouillon peut être modifié' });

  const { avance_id, montant } = req.body;
  if (!avance_id || !montant || montant <= 0)
    return res.status(400).json({ error: 'avance_id et montant positif requis' });

  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?')
    .get(avance_id, bul.employe_id);
  if (!avance) return res.status(404).json({ error: 'Avance non trouvée pour cet employé' });
  if (avance.statut !== 'en_cours') return res.status(400).json({ error: 'Avance non active' });
  if (montant > avance.solde_restant)
    return res.status(400).json({ error: `Montant dépasse le solde restant (${avance.solde_restant} XAF)` });

  const net_a_verser = bul.net_a_payer - montant;
  db.prepare("UPDATE bulletins_salaire SET retenue_avance=?, avance_id=?, net_a_verser=?, updated_at=datetime('now') WHERE id=?")
    .run(montant, avance_id, net_a_verser, bul.id);
  auditBulletin(bul.id, 'retenue_avance', { avance_id, montant, net_a_verser }, req.user.id);
  res.json({ ok: true, retenue_avance: montant, net_a_verser });
});

// ─── Supprimer la retenue avance d'un bulletin ────────────────────────────────

router.delete('/bulletin/:id/retenue-avance', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: 'Seul un bulletin brouillon peut être modifié' });
  db.prepare("UPDATE bulletins_salaire SET retenue_avance=0, avance_id=NULL, net_a_verser=net_a_payer, updated_at=datetime('now') WHERE id=?")
    .run(bul.id);
  res.json({ ok: true });
});

// ─── Payer un bulletin ────────────────────────────────────────────────────────

router.post('/bulletin/:id/payer', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour payer un bulletin' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'paye')      return res.status(400).json({ error: 'Bulletin déjà payé' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Validez le bulletin avant de procéder au paiement' });
  if (bul.statut !== 'valide')    return res.status(400).json({ error: `Statut "${bul.statut}" — seul un bulletin validé peut être payé` });

  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(bul.employe_id);
  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Position de paiement (caisse principale par défaut)
  const position = db.prepare("SELECT id FROM positions WHERE actif=1 ORDER BY ordre LIMIT 1").get();
  const posId    = req.body.position_id || position?.id || 1;

  // Catégorie salaire
  const salCat = db.prepare(
    "SELECT id FROM categories WHERE type='depense' AND lower(nom) LIKE '%salaire%' LIMIT 1"
  ).get();

  // categorie_id : obligatoire dans le journal OHADA
  if (!salCat) return res.status(400).json({
    error: "Aucune catégorie de dépense 'Salaires' trouvée. Créez-en une dans Paramètres → Rubriques."
  });

  const dateOp = `${bul.annee}-${String(bul.mois).padStart(2,'0')}-${new Date().getDate().toString().padStart(2,'0')}`;

  // Montant décaissé = net_a_verser si retenue avance, sinon net_a_payer
  const montantDecaisse = (bul.retenue_avance > 0 && bul.net_a_verser > 0)
    ? bul.net_a_verser
    : bul.net_a_payer;

  const tx = db.transaction(() => {
    // Insérer le décaissement — solde_position sera recalculé proprement ensuite
    const libelle = `Salaire ${emp.nom} ${emp.prenom} — ${nomsMois[bul.mois]} ${bul.annee}`;
    const opResult = db.prepare(`
      INSERT INTO operations
        (date, libelle, detail, tiers, montant, type_op, position_id,
         categorie_id, mode_reglement, decharge_signee, employe_id, statut, created_by)
      VALUES (?,?,?,?,?,'decaissement',?,?,'especes',1,?,'valide',?)
    `).run(
      dateOp,
      libelle,
      libelle,
      `${emp.nom} ${emp.prenom}`,
      montantDecaisse,
      posId,
      salCat.id,
      emp.id,
      req.user.id
    );

    db.prepare(
      "UPDATE bulletins_salaire SET statut='paye', operation_id=?, updated_at=datetime('now') WHERE id=?"
    ).run(opResult.lastInsertRowid, bul.id);

    // Si retenue avance : enregistrer le remboursement partiel sur l'avance
    if (bul.avance_id && bul.retenue_avance > 0) {
      const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ?').get(bul.avance_id);
      if (avance && avance.statut === 'en_cours') {
        const nouveau_solde  = Math.max(0, (avance.solde_restant || 0) - bul.retenue_avance);
        const nouveau_statut = nouveau_solde <= 0 ? 'rembourse' : 'en_cours';
        db.prepare('INSERT INTO employes_avances_remboursements (avance_id,date,montant,notes,created_by) VALUES (?,?,?,?,?)')
          .run(avance.id, dateOp, bul.retenue_avance, `Retenue bulletin ${nomsMois[bul.mois]} ${bul.annee}`, req.user.id);
        db.prepare("UPDATE employes_avances SET solde_restant=?, montant_rembourse=COALESCE(montant_rembourse,0)+?, statut=?, updated_at=datetime('now') WHERE id=?")
          .run(nouveau_solde, bul.retenue_avance, nouveau_statut, avance.id);
      }
    }
  });
  tx();

  // Recalcul propre des soldes — identique à operations.js POST /
  if (recalculateSoldes) recalculateSoldes();

  auditBulletin(bul.id, 'paye', { mois: bul.mois, annee: bul.annee, net_a_payer: bul.net_a_payer, montant_decaisse: montantDecaisse, retenue_avance: bul.retenue_avance || 0, position_id: posId }, req.user.id);

  setImmediate(() => {
    try {
      const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(bul.employe_id);
      creerNotification({
        type:     'NOTIF_BULLETIN_PAYE',
        titre:    'Bulletin de paie payé',
        message:  `Salaire de ${emp?.nom} ${emp?.prenom} — ${nomsMois[bul.mois]} ${bul.annee} payé (${new Intl.NumberFormat('fr-FR').format(montantDecaisse)} XAF).`,
        srcTable: 'bulletins_salaire',
        srcId:    bul.id,
        createdBy: req.user.id,
      });
      evaluerAlerteSoldes();
    } catch (_) {}
  });

  res.json({ ok: true, net_a_payer: bul.net_a_payer, net_a_verser: montantDecaisse });
});

// ─── Valider un bulletin (brouillon → validé) ─────────────────────────────────

router.put('/bulletin/:id/valider', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour valider un bulletin' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: `Bulletin en statut "${bul.statut}", impossible à valider` });
  // C2 : persistance decharge_signee à la validation
  const decharge = req.body?.decharge_signee ? 1 : 0;
  db.prepare("UPDATE bulletins_salaire SET statut='valide', decharge_signee=?, updated_at=datetime('now') WHERE id=?").run(decharge, req.params.id);
  auditBulletin(req.params.id, 'valide', { mois: bul.mois, annee: bul.annee, net_a_payer: bul.net_a_payer }, req.user.id);

  setImmediate(() => {
    try {
      const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(bul.employe_id);
      creerNotification({
        type:     'NOTIF_BULLETIN_VALIDE',
        titre:    'Bulletin de paie validé',
        message:  `Bulletin de ${emp?.nom} ${emp?.prenom} — ${nomsMois[bul.mois]} ${bul.annee} validé (${new Intl.NumberFormat('fr-FR').format(bul.net_a_payer)} XAF).`,
        srcTable: 'bulletins_salaire',
        srcId:    Number(req.params.id),
        createdBy: req.user.id,
      });
    } catch (_) {}
  });

  res.json({ ok: true });
});

// ─── Annuler un bulletin validé (valide → brouillon) ─────────────────────────

router.put('/bulletin/:id/annuler', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'paye') return res.status(400).json({ error: 'Bulletin déjà payé — annulation impossible' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Bulletin déjà en brouillon' });
  const { motif = '' } = req.body;
  db.prepare("UPDATE bulletins_salaire SET statut='brouillon', annule_at=datetime('now'), annule_by=?, annule_motif=?, updated_at=datetime('now') WHERE id=?")
    .run(req.user.id, motif, req.params.id);
  auditBulletin(req.params.id, 'annule', { motif, ancien_statut: bul.statut }, req.user.id);
  res.json({ ok: true });
});

// ─── POST /bulletin/:id/email — Envoyer bulletin par email au salarié ────────

router.post('/bulletin/:id/email', async (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Validez le bulletin avant de l\'envoyer par email' });

  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(bul.employe_id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });

  const emailDest = req.body?.email_override || emp.email;
  if (!emailDest || !emailDest.includes('@'))
    return res.status(400).json({ error: 'Aucun email valide pour cet employé. Renseignez-le dans son dossier.' });

  const societe = getSociete();
  const devise  = getDevise();
  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const moisLabel = `${nomsMois[bul.mois] || bul.mois} ${bul.annee}`;
  const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v || 0);

  // Rubriques custom stockées dans le bulletin (lignes_custom JSON si présent)
  let lignesCustom = [];
  try { lignesCustom = bul.lignes_custom ? JSON.parse(bul.lignes_custom) : []; } catch { lignesCustom = []; }

  const netAVerser = (bul.retenue_avance > 0 && bul.net_a_verser > 0) ? bul.net_a_verser : bul.net_a_payer;

  const htmlBulletin = `
<table style="width:100%;border-collapse:collapse;font-size:13px;color:#1e293b">
  <thead>
    <tr style="background:#f1f5f9">
      <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e2e8f0">Rubrique</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e2e8f0">Gain</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #e2e8f0">Retenue</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">Salaire de base</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.salaire_base)} ${devise}</td>
      <td style="padding:7px 12px;text-align:right">—</td>
    </tr>
    ${bul.prime_transport > 0 ? `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">Prime de transport</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.prime_transport)} ${devise}</td>
      <td style="padding:7px 12px;text-align:right">—</td>
    </tr>` : ''}
    ${bul.prime_logement > 0 ? `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">Prime de logement</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.prime_logement)} ${devise}</td>
      <td style="padding:7px 12px;text-align:right">—</td>
    </tr>` : ''}
    ${bul.autres_primes > 0 ? `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">Autres primes</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.autres_primes)} ${devise}</td>
      <td style="padding:7px 12px;text-align:right">—</td>
    </tr>` : ''}
    ${lignesCustom.map(l => `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">${l.nom}</td>
      <td style="padding:7px 12px;text-align:right">${l.type === 'prime' ? fmt(l.montant) + ' ' + devise : '—'}</td>
      <td style="padding:7px 12px;text-align:right">${l.type === 'retenue' ? fmt(l.montant) + ' ' + devise : '—'}</td>
    </tr>`).join('')}
    <tr style="background:#f8fafc;font-weight:700;border-top:2px solid #e2e8f0">
      <td style="padding:8px 12px">Salaire brut</td>
      <td style="padding:8px 12px;text-align:right">${fmt(bul.brut)} ${devise}</td>
      <td style="padding:8px 12px;text-align:right">—</td>
    </tr>
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">CNSS salarié (${(bul.cnss_employe / bul.brut * 100).toFixed(3)}%)</td>
      <td style="padding:7px 12px;text-align:right">—</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.cnss_employe)} ${devise}</td>
    </tr>
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">CAMU salarié</td>
      <td style="padding:7px 12px;text-align:right">—</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.camu_employe)} ${devise}</td>
    </tr>
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">IRPP</td>
      <td style="padding:7px 12px;text-align:right">—</td>
      <td style="padding:7px 12px;text-align:right">${fmt(bul.irpp)} ${devise}</td>
    </tr>
    ${bul.retenue_avance > 0 ? `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:7px 12px">Retenue avance sur salaire</td>
      <td style="padding:7px 12px;text-align:right">—</td>
      <td style="padding:7px 12px;text-align:right;color:#dc2626">${fmt(bul.retenue_avance)} ${devise}</td>
    </tr>` : ''}
    <tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #86efac">
      <td style="padding:10px 12px;color:#15803d">NET À PAYER</td>
      <td style="padding:10px 12px;text-align:right;color:#15803d;font-size:15px">${fmt(netAVerser)} ${devise}</td>
      <td style="padding:10px 12px;text-align:right">—</td>
    </tr>
  </tbody>
</table>
<table style="width:100%;border-collapse:collapse;font-size:12px;color:#64748b;margin-top:16px">
  <tr>
    <td style="padding:4px 0">Net imposable</td>
    <td style="padding:4px 0;text-align:right">${fmt(bul.net_imposable)} ${devise}</td>
  </tr>
  <tr>
    <td style="padding:4px 0">CNSS patronal</td>
    <td style="padding:4px 0;text-align:right">${fmt(bul.cnss_patronal)} ${devise}</td>
  </tr>
  <tr>
    <td style="padding:4px 0">CAMU patronal</td>
    <td style="padding:4px 0;text-align:right">${fmt(bul.camu_patronal)} ${devise}</td>
  </tr>
  <tr style="font-weight:600;color:#475569">
    <td style="padding:6px 0;border-top:1px solid #e2e8f0">Coût total employeur</td>
    <td style="padding:6px 0;text-align:right;border-top:1px solid #e2e8f0">${fmt(bul.cout_total_employeur)} ${devise}</td>
  </tr>
</table>
${bul.notes ? `<p style="margin-top:12px;font-size:12px;color:#64748b;font-style:italic">Note : ${bul.notes}</p>` : ''}`;

  try {
    const { sendBulletin } = require('../services/email');
    await sendBulletin(emailDest, `${emp.nom} ${emp.prenom}`, bul.mois, bul.annee, htmlBulletin);

    // Audit + log envoi
    auditBulletin(bul.id, 'email_envoye', { to: emailDest, mois: bul.mois, annee: bul.annee }, req.user.id);
    logEnvoi({
      bulletin_id: bul.id, employe_id: bul.employe_id,
      mois: bul.mois, annee: bul.annee,
      canal: 'email', destinataire: emailDest,
      statut: 'envoye', groupe: 0, envoye_par: req.user.id,
    });

    // Notification inapp
    setImmediate(() => {
      try {
        creerNotification({
          type:     'NOTIF_BULLETIN_VALIDE',
          titre:    'Bulletin envoyé par email',
          message:  `Bulletin de paie de ${emp.nom} ${emp.prenom} — ${moisLabel} envoyé à ${emailDest}.`,
          srcTable: 'bulletins_salaire',
          srcId:    bul.id,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });

    res.json({ ok: true, envoye_a: emailDest });
  } catch (e) {
    logEnvoi({
      bulletin_id: bul.id, employe_id: bul.employe_id,
      mois: bul.mois, annee: bul.annee,
      canal: 'email', destinataire: emailDest,
      statut: 'echec', erreur: e.message,
      groupe: 0, envoye_par: req.user.id,
    });
    res.status(500).json({ error: 'Échec envoi email : ' + e.message });
  }
});

// ─── Taux en vigueur (pour affichage dans les paramètres) ────────────────────

router.get('/taux', (req, res) => {
  res.json(getTaux());
});

// ─── Note de virement bancaire ────────────────────────────────────────────────

router.get('/note-banque', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.poste, e.type, e.banque, e.numero_compte, e.mode_paiement
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.banque, e.nom
  `).all(mois, annee);

  const virements = rows.filter(r => r.mode_paiement === 'virement_bancaire');
  const total = virements.reduce((s, r) => s + (r.net_a_payer || 0), 0);

  res.json({ mois, annee, societe: getSociete(), devise: getDevise(), virements, total });
});

// ─── Export CSV masse salariale ───────────────────────────────────────────────

router.get('/export-csv', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.poste, e.type, e.mode_paiement, e.banque, e.numero_compte
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.type, e.nom
  `).all(mois, annee);

  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const BOM = '\uFEFF';
  const headers = [
    'Nom','Prénom','Poste','Type contrat',
    'Salaire base','Total primes','Brut',
    'CNSS salarié','CAMU salarié','IRPP','Total retenues',
    'Net à payer',
    'CNSS patronal','CAMU patronal','Coût total employeur',
    'Mode paiement','Banque','N° Compte','Statut'
  ];
  const sep = ';';
  const csvRows = rows.map(r => [
    r.nom, r.prenom, r.poste || '', r.type,
    r.salaire_base,
    (r.prime_transport || 0) + (r.prime_logement || 0) + (r.autres_primes || 0),
    r.brut, r.cnss_employe, r.camu_employe, r.irpp, r.total_retenues, r.net_a_payer,
    r.cnss_patronal, r.camu_patronal, r.cout_total_employeur,
    r.mode_paiement || 'especes', r.banque || '', r.numero_compte || '', r.statut
  ].join(sep));

  const content = BOM + [headers.join(sep), ...csvRows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="salaires-${nomsMois[mois]}-${annee}.csv"`);
  res.send(content);
});

// ─── Supprimer/réinitialiser un bulletin brouillon ────────────────────────────

router.delete('/bulletin/:id', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const bul = db.prepare('SELECT statut FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'valide') return res.status(400).json({ error: 'Bulletin validé — annulez-le d\'abord via "Annuler la validation"' });
  if (bul.statut === 'paye')   return res.status(400).json({ error: 'Impossible de supprimer un bulletin payé' });
  db.prepare('DELETE FROM bulletins_salaire WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── GET /bulletin/:id/historique — audit trail d'un bulletin ────────────────

router.get('/bulletin/:id/historique', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.details, a.created_at,
           u.nom as user_nom, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.table_name = 'bulletins_salaire' AND a.record_id = ?
    ORDER BY a.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(r => ({
    ...r,
    details: (() => { try { return JSON.parse(r.details); } catch { return r.details; } })()
  })));
});

// ─── PDF d'un bulletin ────────────────────────────────────────────────────────

router.get('/bulletin/:id/pdf', async (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Validez le bulletin avant de générer le PDF' });

  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(bul.employe_id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });

  try {
    const html = buildHtmlBulletin(bul, emp, { devise: getDevise(), societe: getSociete() });
    const pdfBuf = await htmlToPdf(html);

    const nomsMois = ['','Janvier','Fevrier','Mars','Avril','Mai','Juin',
                      'Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];
    const nomFichier = `bulletin_${emp.nom}_${emp.prenom || ''}_${nomsMois[bul.mois]}_${bul.annee}.pdf`
      .replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');

    logEnvoi({
      bulletin_id: bul.id, employe_id: bul.employe_id,
      mois: bul.mois, annee: bul.annee,
      canal: 'pdf_download', destinataire: req.user.email || 'download',
      statut: 'envoye', avec_pdf: 1, groupe: 0, envoye_par: req.user.id,
    });
    auditBulletin(bul.id, 'pdf_telecharge', { par: req.user.email }, req.user.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  } catch (e) {
    logEnvoi({
      bulletin_id: bul.id, employe_id: bul.employe_id,
      mois: bul.mois, annee: bul.annee,
      canal: 'pdf_download', statut: 'echec',
      erreur: e.message, envoye_par: req.user.id,
    });
    res.status(500).json({ error: 'Génération PDF échouée : ' + e.message });
  }
});

// ─── Logs d'envoi d'un bulletin ───────────────────────────────────────────────

router.get('/bulletin/:id/envois', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const rows = db.prepare(`
    SELECT be.*, u.nom AS envoye_par_nom
    FROM bulletin_envois be
    LEFT JOIN users u ON u.id = be.envoye_par
    WHERE be.bulletin_id = ?
    ORDER BY be.created_at DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(rows);
});

// ─── Logs d'envoi globaux (par mois/annee) ────────────────────────────────────

router.get('/envois', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee, statut, limit = 200, offset = 0 } = req.query;
  let where = '1=1';
  const params = [];
  if (mois)   { where += ' AND be.mois = ?';   params.push(Number(mois)); }
  if (annee)  { where += ' AND be.annee = ?';  params.push(Number(annee)); }
  if (statut) { where += ' AND be.statut = ?'; params.push(statut); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM bulletin_envois be WHERE ${where}`).get(...params).c;
  const rows  = db.prepare(`
    SELECT be.*,
           e.nom || ' ' || COALESCE(e.prenom,'') AS employe_nom,
           u.nom AS envoye_par_nom
    FROM bulletin_envois be
    JOIN employes e ON e.id = be.employe_id
    LEFT JOIN users u ON u.id = be.envoye_par
    WHERE ${where}
    ORDER BY be.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  res.json({ total, rows });
});

// ─── Noms de mois (utilisé par C3 pour le nom de fichier PDF) ─────────────────
const NOMS_MOIS = ['','Janvier','Fevrier','Mars','Avril','Mai','Juin',
                   'Juillet','Aout','Septembre','Octobre','Novembre','Decembre'];

// ─── C3 — Envoi groupé des bulletins avec PDF joint ──────────────────────────
//
// Paramètres body :
//   mois, annee        (obligatoires)
//   seulement_echecs   (bool, défaut false) — ne traite que les bulletins ayant
//                      au moins un log echec et aucun log envoye depuis
//   forcer_renvoi      (bool, défaut false) — ignore la protection double envoi
//                      pour les bulletins déjà envoyés avec succès
//
// Règles :
//   - Seuls les bulletins statut='paye' sont traités
//   - Un bulletin sans email valide est ignoré (sans_email)
//   - Un bulletin déjà envoyé avec succès est ignoré sauf si forcer_renvoi=true
//   - Chaque email est individuel : un seul destinataire par envoi
//   - Le PDF est généré via wkhtmltopdf et joint en pièce jointe
//   - En cas d'échec PDF, l'email HTML seul est envoyé (fallback) avec flag sans_pdf
//   - Chaque envoi est journalisé individuellement dans bulletin_envois
//
router.post('/envoyer-groupe', async (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const {
    mois,
    annee,
    seulement_echecs = false,
    forcer_renvoi    = false,
  } = req.body;

  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
  const moisN  = Number(mois);
  const anneeN = Number(annee);
  if (moisN < 1 || moisN > 12 || anneeN < 2000)
    return res.status(400).json({ error: 'mois ou annee invalide' });

  // ── 1. Charger tous les bulletins payés du mois ────────────────────────────
  const bulletins = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.email, e.id AS employe_id_ref
    FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    WHERE b.mois = ? AND b.annee = ? AND b.statut = 'paye'
    ORDER BY e.nom, e.prenom
  `).all(moisN, anneeN);

  const r = {
    envoyes:    [],  // { id, nom, email }
    echecs:     [],  // { id, nom, email, erreur, pdf_ok }
    ignores:    [],  // { id, nom, raison } — déjà envoyé sans forcer_renvoi
    sans_email: [],  // { id, nom }
    sans_pdf:   [],  // id des bulletins où le PDF a échoué mais HTML envoyé
  };

  const { sendBulletinAvecPdf, sendBulletin } = require('../services/email');

  for (const b of bulletins) {
    const nomComplet = `${b.nom} ${b.prenom || ''}`.trim();

    // ── 2a. Vérification email ──────────────────────────────────────────────
    if (!b.email || !b.email.includes('@')) {
      r.sans_email.push({ id: b.id, nom: nomComplet });
      logEnvoi({
        bulletin_id: b.id, employe_id: b.employe_id,
        mois: moisN, annee: anneeN,
        canal: 'email', destinataire: null,
        statut: 'echec', erreur: 'email_absent', groupe: 1,
        envoye_par: req.user.id,
      });
      continue;
    }

    // ── 2b. Guard double envoi ──────────────────────────────────────────────
    // Vérifier si un envoi réussi existe déjà pour ce bulletin
    const dernierSucces = db.prepare(`
      SELECT id, created_at FROM bulletin_envois
      WHERE bulletin_id = ? AND statut = 'envoye' AND canal = 'email' AND groupe = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(b.id);

    if (dernierSucces && !forcer_renvoi) {
      // Mode seulement_echecs : on veut re-traiter les bulletins en échec
      // → si un succès existe déjà, ce bulletin est définitivement ignoré
      r.ignores.push({
        id:  b.id, nom: nomComplet,
        raison: `déjà envoyé le ${dernierSucces.created_at.slice(0, 10)}`,
      });
      continue;
    }

    // Mode seulement_echecs : ignorer les bulletins sans aucun log échec
    if (seulement_echecs) {
      const nbEchecs = db.prepare(`
        SELECT COUNT(*) as c FROM bulletin_envois
        WHERE bulletin_id = ? AND statut = 'echec' AND canal = 'email' AND groupe = 1
      `).get(b.id).c;
      if (nbEchecs === 0) {
        r.ignores.push({ id: b.id, nom: nomComplet, raison: 'aucun echec précédent' });
        continue;
      }
    }

    // ── 3. Construire HTML bulletin (buildHtmlBulletin factorisé) ───────────
    const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(b.employe_id);
    const htmlBulletin = buildHtmlBulletin(b, emp, { devise: getDevise(), societe: getSociete() });

    // ── 4. Générer le PDF ───────────────────────────────────────────────────
    const nomFichier = `bulletin_${b.nom}_${b.prenom || ''}_${NOMS_MOIS[moisN]}_${anneeN}.pdf`
      .replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');

    let pdfBuf = null;
    let pdfErreur = null;
    try {
      pdfBuf = await htmlToPdf(htmlBulletin);
    } catch (pdfErr) {
      pdfErreur = pdfErr.message;
      r.sans_pdf.push(b.id);
      // Limit: PDF synchrone échoué → on continue avec HTML seul
    }

    // ── 5. Envoyer l'email (un seul destinataire) ───────────────────────────
    try {
      if (pdfBuf) {
        await sendBulletinAvecPdf(
          b.email, nomComplet, moisN, anneeN, htmlBulletin, pdfBuf, nomFichier
        );
      } else {
        // Fallback HTML sans PDF si wkhtmltopdf a échoué
        await sendBulletin(b.email, nomComplet, moisN, anneeN, htmlBulletin);
      }

      auditBulletin(b.id, 'email_envoye', {
        to: b.email, groupe: true, mois: moisN, annee: anneeN,
        avec_pdf: !!pdfBuf, pdf_erreur: pdfErreur || undefined,
      }, req.user.id);

      logEnvoi({
        bulletin_id: b.id, employe_id: b.employe_id,
        mois: moisN, annee: anneeN,
        canal: 'email', destinataire: b.email,
        statut: 'envoye', avec_pdf: pdfBuf ? 1 : 0,
        groupe: 1, envoye_par: req.user.id,
        erreur: pdfErreur ? `PDF non joint : ${pdfErreur}` : null,
      });

      r.envoyes.push({ id: b.id, nom: nomComplet, email: b.email, avec_pdf: !!pdfBuf });

    } catch (mailErr) {
      logEnvoi({
        bulletin_id: b.id, employe_id: b.employe_id,
        mois: moisN, annee: anneeN,
        canal: 'email', destinataire: b.email,
        statut: 'echec', erreur: mailErr.message,
        avec_pdf: 0, groupe: 1, envoye_par: req.user.id,
      });
      r.echecs.push({ id: b.id, nom: nomComplet, email: b.email, erreur: mailErr.message, pdf_ok: !!pdfBuf });
    }
  }

  // ── 6. Résumé complet ──────────────────────────────────────────────────────
  res.json({
    ok:               true,
    mois:             moisN,
    annee:            anneeN,
    total_bulletins:  bulletins.length,
    envoyes:          r.envoyes.length,
    echecs:           r.echecs.length,
    ignores:          r.ignores.length,
    sans_email:       r.sans_email.length,
    sans_pdf:         r.sans_pdf.length,    // envoyés HTML seul car PDF échoué
    detail: {
      envoyes:    r.envoyes,
      echecs:     r.echecs,
      ignores:    r.ignores,
      sans_email: r.sans_email,
      sans_pdf:   r.sans_pdf,
    },
    // Indications pour le frontend
    peut_renvoyer_echecs: r.echecs.length > 0,
    // Limite connue : PDF synchrone ~300-800 ms/bulletin — documenter si > 20 agents
    limite_pdf: bulletins.length >= 20
      ? 'Avertissement : génération PDF synchrone — prévoir une file si > 20 bulletins'
      : null,
  });
});

// C4 — Bordereau CNSS mensuel
router.get('/cnss-bordereau', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.poste, e.cnss, e.camu, e.type_contrat, e.matricule
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.nom
  `).all(mois, annee);

  const societe = getSociete();
  const totaux  = rows.reduce((acc, r) => ({
    brut:          acc.brut          + (r.brut           || 0),
    cnss_employe:  acc.cnss_employe  + (r.cnss_employe   || 0),
    cnss_patronal: acc.cnss_patronal + (r.cnss_patronal  || 0),
    camu_employe:  acc.camu_employe  + (r.camu_employe   || 0),
    camu_patronal: acc.camu_patronal + (r.camu_patronal  || 0),
    irpp:          acc.irpp          + (r.irpp            || 0),
  }), { brut:0, cnss_employe:0, cnss_patronal:0, camu_employe:0, camu_patronal:0, irpp:0 });

  if (req.query.format === 'csv') {
    const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                      'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
    const BOM = '﻿';
    const SEP = ';';
    const headers = [
      'Matricule','N° CNSS','N° CAMU','Nom','Prénom','Poste','Type contrat',
      'Salaire brut','CNSS salarié','CNSS patronal','CAMU salarié','CAMU patronal',
      'Total cotisations salarié','Total cotisations patronal','IRPP','Statut bulletin'
    ];
    const csvRows = rows.map(r => [
      r.matricule || '', r.cnss || '', r.camu || '',
      `"${(r.nom || '').replace(/"/g,'""')}"`,
      `"${(r.prenom || '').replace(/"/g,'""')}"`,
      r.poste || '', r.type_contrat || '',
      r.brut || 0, r.cnss_employe || 0, r.cnss_patronal || 0,
      r.camu_employe || 0, r.camu_patronal || 0,
      (r.cnss_employe || 0) + (r.camu_employe || 0),
      (r.cnss_patronal || 0) + (r.camu_patronal || 0),
      r.irpp || 0, r.statut
    ].join(SEP));
    // Ligne totaux
    csvRows.push(['','','','TOTAL','','','',
      totaux.brut, totaux.cnss_employe, totaux.cnss_patronal,
      totaux.camu_employe, totaux.camu_patronal,
      totaux.cnss_employe + totaux.camu_employe,
      totaux.cnss_patronal + totaux.camu_patronal,
      totaux.irpp, ''
    ].join(SEP));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="cnss-bordereau-${mois}-${annee}.csv"`);
    return res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
  }

  res.json({ mois, annee, societe, lignes: rows, totaux });
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE CNSS — Déclarations, paiements, paramètres, PDF, CSV, historique
// ═══════════════════════════════════════════════════════════════════════════

// ── Helpers CNSS ────────────────────────────────────────────────────────────

function getCnssParams() {
  const rows = db.prepare("SELECT cle, valeur FROM parametres WHERE cle LIKE 'cnss%' OR cle LIKE 'camu%'").all();
  const p = {};
  rows.forEach(r => { p[r.cle] = r.valeur; });
  return p;
}

function agregeBulletins(mois, annee) {
  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.cnss, e.camu, e.matricule, e.poste, e.type
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.nom
  `).all(mois, annee);

  const totaux = rows.reduce((acc, r) => ({
    nb_employes:    acc.nb_employes    + 1,
    masse_salariale:acc.masse_salariale+ (r.brut || 0),
    cotis_employe:  acc.cotis_employe  + (r.cnss_employe  || 0),
    cotis_patronal: acc.cotis_patronal + (r.cnss_patronal || 0),
    camu_employe:   acc.camu_employe   + (r.camu_employe  || 0),
    camu_patronal:  acc.camu_patronal  + (r.camu_patronal || 0),
  }), { nb_employes:0, masse_salariale:0, cotis_employe:0, cotis_patronal:0, camu_employe:0, camu_patronal:0 });

  totaux.total_du = totaux.cotis_employe + totaux.cotis_patronal
                  + totaux.camu_employe  + totaux.camu_patronal;
  return { lignes: rows, totaux };
}

// ── GET /api/salaires/cnss/params ────────────────────────────────────────────
router.get('/cnss/params', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(getCnssParams());
});

// ── PUT /api/salaires/cnss/params ────────────────────────────────────────────
router.put('/cnss/params', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const allowed = ['cnss_numero_adherent','cnss_numero_camu','cnss_date_limite_jour','cnss_adresse_depot',
                   'cnss_employe_taux','cnss_patron_taux','camu_employe_taux','camu_patron_taux'];
  const upd = db.prepare("INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) upd.run(k, String(v));
    }
  });
  tx();
  res.json({ ok: true });
});

// ── GET /api/salaires/cnss/declarations ─────────────────────────────────────
router.get('/cnss/declarations', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const rows = db.prepare(`
    SELECT d.*,
      (SELECT SUM(montant) FROM cnss_paiements WHERE declaration_id = d.id) AS deja_paye
    FROM cnss_declarations d
    WHERE d.annee = ?
    ORDER BY d.mois DESC
  `).all(annee);
  res.json(rows);
});

// ── GET /api/salaires/cnss/declaration/:mois/:annee ──────────────────────────
router.get('/cnss/declaration/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  if (!mois || !annee) return res.status(400).json({ error: 'Période invalide' });

  const decl = db.prepare("SELECT * FROM cnss_declarations WHERE mois = ? AND annee = ?").get(mois, annee);
  const { lignes, totaux } = agregeBulletins(mois, annee);
  const paiements = decl
    ? db.prepare("SELECT * FROM cnss_paiements WHERE declaration_id = ? ORDER BY date_paiement").all(decl.id)
    : [];
  const params = getCnssParams();

  res.json({ declaration: decl || null, lignes, totaux, paiements, params });
});

// ── POST /api/salaires/cnss/declaration ─────────────────────────────────────
// Crée ou recalcule une déclaration pour un mois/année
router.post('/cnss/declaration', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee, notes } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });

  const { totaux } = agregeBulletins(Number(mois), Number(annee));
  if (totaux.nb_employes === 0) return res.status(400).json({ error: 'Aucun bulletin pour cette période' });

  const p = getCnssParams();
  const jour = parseInt(p.cnss_date_limite_jour || '15', 10);
  const moisSuivant = Number(mois) === 12 ? 1 : Number(mois) + 1;
  const anneeSuivant = Number(mois) === 12 ? Number(annee) + 1 : Number(annee);
  const date_limite = `${anneeSuivant}-${String(moisSuivant).padStart(2,'0')}-${String(jour).padStart(2,'0')}`;

  const existing = db.prepare("SELECT id FROM cnss_declarations WHERE mois = ? AND annee = ?").get(mois, annee);
  if (existing) {
    db.prepare(`
      UPDATE cnss_declarations
      SET nb_employes=?, masse_salariale=?, cotis_employe=?, cotis_patronal=?,
          camu_employe=?, camu_patronal=?, total_du=?, date_limite=?, notes=COALESCE(?,notes),
          updated_by=?, updated_at=datetime('now')
      WHERE id=?
    `).run(totaux.nb_employes, totaux.masse_salariale, totaux.cotis_employe, totaux.cotis_patronal,
           totaux.camu_employe, totaux.camu_patronal, totaux.total_du, date_limite,
           notes || null, req.user.id, existing.id);
    return res.json({ ok: true, id: existing.id });
  }

  const r = db.prepare(`
    INSERT INTO cnss_declarations
      (mois, annee, date_limite, nb_employes, masse_salariale,
       cotis_employe, cotis_patronal, camu_employe, camu_patronal, total_du, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(mois, annee, date_limite, totaux.nb_employes, totaux.masse_salariale,
         totaux.cotis_employe, totaux.cotis_patronal, totaux.camu_employe, totaux.camu_patronal,
         totaux.total_du, notes || null, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── PUT /api/salaires/cnss/declaration/:id/statut ────────────────────────────
router.put('/cnss/declaration/:id/statut', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { statut, date_depot } = req.body;
  const STATUTS = ['en_attente','deposee','payee','rejetee'];
  if (!STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const r = db.prepare(`
    UPDATE cnss_declarations
    SET statut=?, date_depot=COALESCE(?,date_depot), updated_by=?, updated_at=datetime('now')
    WHERE id=?
  `).run(statut, date_depot || null, req.user.id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Déclaration introuvable' });
  res.json({ ok: true });
});

// ── POST /api/salaires/cnss/paiement ─────────────────────────────────────────
router.post('/cnss/paiement', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { declaration_id, montant, date_paiement, mode_paiement, ref_paiement, banque, notes } = req.body;
  if (!declaration_id || !montant || !date_paiement)
    return res.status(400).json({ error: 'declaration_id, montant et date_paiement requis' });

  const decl = db.prepare("SELECT * FROM cnss_declarations WHERE id=?").get(declaration_id);
  if (!decl) return res.status(404).json({ error: 'Déclaration introuvable' });

  const r = db.prepare(`
    INSERT INTO cnss_paiements
      (declaration_id, montant, date_paiement, mode_paiement, ref_paiement, banque, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(declaration_id, montant, date_paiement,
         mode_paiement || 'virement_bancaire', ref_paiement || null,
         banque || null, notes || null, req.user.id);

  // Vérifier si entièrement payée
  const totalPaye = db.prepare("SELECT SUM(montant) AS s FROM cnss_paiements WHERE declaration_id=?")
    .get(declaration_id).s || 0;
  if (totalPaye >= decl.total_du) {
    db.prepare("UPDATE cnss_declarations SET statut='payee', montant_paye=?, date_paiement=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
      .run(totalPaye, date_paiement, req.user.id, declaration_id);
  } else {
    db.prepare("UPDATE cnss_declarations SET montant_paye=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
      .run(totalPaye, req.user.id, declaration_id);
  }

  res.json({ ok: true, id: r.lastInsertRowid, total_paye: totalPaye });
});

// ── DELETE /api/salaires/cnss/paiement/:id ───────────────────────────────────
router.delete('/cnss/paiement/:id', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const pmt = db.prepare("SELECT * FROM cnss_paiements WHERE id=?").get(req.params.id);
  if (!pmt) return res.status(404).json({ error: 'Paiement introuvable' });
  db.prepare("DELETE FROM cnss_paiements WHERE id=?").run(req.params.id);
  // Recalc montant_paye et statut
  const totalPaye = db.prepare("SELECT SUM(montant) AS s FROM cnss_paiements WHERE declaration_id=?")
    .get(pmt.declaration_id).s || 0;
  const decl = db.prepare("SELECT total_du FROM cnss_declarations WHERE id=?").get(pmt.declaration_id);
  const newStatut = totalPaye >= (decl?.total_du || 0) ? 'payee' : 'deposee';
  db.prepare("UPDATE cnss_declarations SET montant_paye=?, statut=?, updated_at=datetime('now') WHERE id=?")
    .run(totalPaye, newStatut, pmt.declaration_id);
  res.json({ ok: true });
});

// ── GET /api/salaires/cnss/bordereau-pdf/:mois/:annee ────────────────────────
router.get('/cnss/bordereau-pdf/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  const { lignes, totaux } = agregeBulletins(mois, annee);
  const params  = getCnssParams();
  const societe = getSociete();
  const devise  = getDevise();
  const fmt = n => Math.round(n || 0).toLocaleString('fr-FR');

  const MOIS_NOM = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  const lignesHtml = lignes.map((r, i) => `
    <tr class="${i % 2 === 0 ? 'pair' : 'impair'}">
      <td>${i + 1}</td>
      <td>${r.matricule || '—'}</td>
      <td>${r.cnss || '—'}</td>
      <td>${r.nom} ${r.prenom}</td>
      <td>${r.poste || '—'}</td>
      <td class="num">${fmt(r.brut)}</td>
      <td class="num">${fmt(r.cnss_employe)}</td>
      <td class="num">${fmt(r.cnss_patronal)}</td>
      <td class="num">${fmt(r.camu_employe)}</td>
      <td class="num">${fmt(r.camu_patronal)}</td>
      <td class="num total-col">${fmt((r.cnss_employe||0)+(r.cnss_patronal||0)+(r.camu_employe||0)+(r.camu_patronal||0))}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bordereau CNSS — ${MOIS_NOM[mois]} ${annee}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #1a1a1a; padding: 20px; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 2px solid #1e3a5f; padding-bottom: 12px; }
  .societe { font-size: 14px; font-weight: bold; color: #1e3a5f; }
  .ref { font-size: 11px; color: #555; margin-top: 4px; }
  .titre { text-align: center; font-size: 16px; font-weight: bold; color: #1e3a5f; margin-bottom: 4px; }
  .sous-titre { text-align: center; font-size: 12px; color: #444; margin-bottom: 16px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; font-size: 10px; }
  .info-box { background: #f0f4ff; border: 1px solid #c7d2fe; border-radius: 4px; padding: 6px 10px; }
  .info-box label { font-weight: bold; color: #3730a3; display: block; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; }
  th { background: #1e3a5f; color: white; padding: 5px 4px; text-align: center; }
  td { border: 1px solid #d1d5db; padding: 4px; }
  .num { text-align: right; }
  .pair { background: #f9fafb; }
  .impair { background: #ffffff; }
  .total-col { background: #fef3c7; font-weight: bold; }
  .tfoot-row td { background: #1e3a5f; color: white; font-weight: bold; text-align: right; font-size: 10px; }
  .tfoot-row td:first-child, .tfoot-row td:nth-child(2), .tfoot-row td:nth-child(3), .tfoot-row td:nth-child(4), .tfoot-row td:nth-child(5) { text-align: center; }
  .recap { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
  .recap-box { border: 1px solid #d1d5db; border-radius: 4px; padding: 10px; }
  .recap-box h3 { font-size: 11px; color: #1e3a5f; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin-bottom: 6px; }
  .recap-ligne { display: flex; justify-content: space-between; padding: 2px 0; }
  .grand-total { background: #1e3a5f; color: white; text-align: center; padding: 10px; border-radius: 4px; margin-top: 12px; font-size: 13px; font-weight: bold; }
  .signature { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 30px; }
  .sign-box { border-top: 1px solid #9ca3af; padding-top: 8px; text-align: center; font-size: 10px; color: #555; min-height: 60px; }
  .footer { margin-top: 20px; border-top: 1px solid #e5e7eb; padding-top: 8px; text-align: center; font-size: 8px; color: #9ca3af; }
  @media print { body { padding: 10px; } }
</style>
</head>
<body>
<div class="entete">
  <div>
    <div class="societe">${societe}</div>
    <div class="ref">N° Adhérent CNSS : <b>${params.cnss_numero_adherent || '________________'}</b></div>
    <div class="ref">N° Affilié CAMU  : <b>${params.cnss_numero_camu    || '________________'}</b></div>
  </div>
  <div style="text-align:right">
    <div class="ref">Adresse : ${params.cnss_adresse_depot || 'CNSS Brazzaville'}</div>
    <div class="ref">Date d'édition : ${new Date().toLocaleDateString('fr-FR')}</div>
  </div>
</div>

<div class="titre">BORDEREAU DE DÉCLARATION DES COTISATIONS SOCIALES</div>
<div class="sous-titre">CNSS &amp; CAMU — Période : <b>${MOIS_NOM[mois]} ${annee}</b></div>

<div class="info-grid">
  <div class="info-box"><label>Nombre d'employés déclarés</label>${totaux.nb_employes}</div>
  <div class="info-box"><label>Masse salariale brute</label>${fmt(totaux.masse_salariale)} ${devise}</div>
  <div class="info-box"><label>Taux CNSS salarié</label>${params.cnss_employe_taux || '4.725'} %</div>
  <div class="info-box"><label>Taux CNSS patronal</label>${params.cnss_patron_taux || '20'} %</div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th><th>Matricule</th><th>N° CNSS</th><th>Nom &amp; Prénom</th><th>Poste</th>
      <th>Salaire brut</th><th>CNSS salarié</th><th>CNSS patronal</th>
      <th>CAMU salarié</th><th>CAMU patronal</th><th>Total cotisations</th>
    </tr>
  </thead>
  <tbody>${lignesHtml}</tbody>
  <tfoot>
    <tr class="tfoot-row">
      <td colspan="5">TOTAUX</td>
      <td>${fmt(totaux.masse_salariale)}</td>
      <td>${fmt(totaux.cotis_employe)}</td>
      <td>${fmt(totaux.cotis_patronal)}</td>
      <td>${fmt(totaux.camu_employe)}</td>
      <td>${fmt(totaux.camu_patronal)}</td>
      <td>${fmt(totaux.total_du)}</td>
    </tr>
  </tfoot>
</table>

<div class="recap">
  <div class="recap-box">
    <h3>Récapitulatif CNSS</h3>
    <div class="recap-ligne"><span>Part salariale (${params.cnss_employe_taux||'4.725'}%)</span><span><b>${fmt(totaux.cotis_employe)} ${devise}</b></span></div>
    <div class="recap-ligne"><span>Part patronale (${params.cnss_patron_taux||'20'}%)</span><span><b>${fmt(totaux.cotis_patronal)} ${devise}</b></span></div>
    <div class="recap-ligne" style="border-top:1px solid #e5e7eb;margin-top:4px;padding-top:4px"><span><b>Total CNSS</b></span><span><b>${fmt(totaux.cotis_employe+totaux.cotis_patronal)} ${devise}</b></span></div>
  </div>
  <div class="recap-box">
    <h3>Récapitulatif CAMU</h3>
    <div class="recap-ligne"><span>Part salariale (${params.camu_employe_taux||'2.25'}%)</span><span><b>${fmt(totaux.camu_employe)} ${devise}</b></span></div>
    <div class="recap-ligne"><span>Part patronale (${params.camu_patron_taux||'5'}%)</span><span><b>${fmt(totaux.camu_patronal)} ${devise}</b></span></div>
    <div class="recap-ligne" style="border-top:1px solid #e5e7eb;margin-top:4px;padding-top:4px"><span><b>Total CAMU</b></span><span><b>${fmt(totaux.camu_employe+totaux.camu_patronal)} ${devise}</b></span></div>
  </div>
</div>

<div class="grand-total">
  TOTAL GÉNÉRAL DÛ : ${fmt(totaux.total_du)} ${devise}
</div>

<div class="signature">
  <div class="sign-box">Cachet &amp; Signature de l'Employeur<br><br><br>${societe}</div>
  <div class="sign-box">Cachet &amp; Signature CNSS<br><br><br>Reçu le : ___/___/______</div>
</div>

<div class="footer">
  Document généré automatiquement — ${societe} — ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}
  | Ce bordereau doit être déposé au plus tard le ${params.cnss_date_limite_jour || '15'} du mois suivant.
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition',
    `inline; filename="bordereau-cnss-${mois}-${annee}.html"`);
  res.send(html);
});

// ── GET /api/salaires/cnss/bordereau-csv/:mois/:annee ───────────────────────
router.get('/cnss/bordereau-csv/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  const { lignes, totaux } = agregeBulletins(mois, annee);
  const MOIS_NOM = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const BOM = '﻿';
  const SEP = ';';
  const headers = ['N°','Matricule','N° CNSS','Nom','Prénom','Poste','Salaire brut',
                   'CNSS salarié','CNSS patronal','CAMU salarié','CAMU patronal','Total cotisations'];
  const csvRows = lignes.map((r, i) => [
    i+1, r.matricule||'', r.cnss||'',
    `"${(r.nom||'').replace(/"/g,'""')}"`,
    `"${(r.prenom||'').replace(/"/g,'""')}"`,
    r.poste||'',
    r.brut||0, r.cnss_employe||0, r.cnss_patronal||0,
    r.camu_employe||0, r.camu_patronal||0,
    (r.cnss_employe||0)+(r.cnss_patronal||0)+(r.camu_employe||0)+(r.camu_patronal||0)
  ].join(SEP));
  csvRows.push(['','','','TOTAL','','',
    totaux.masse_salariale, totaux.cotis_employe, totaux.cotis_patronal,
    totaux.camu_employe, totaux.camu_patronal, totaux.total_du
  ].join(SEP));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="cnss-${mois}-${annee}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
});

// ═══════════════════════════════════════════════════════════════════════════
// MODULE DGI — Fiscalité paie / IRPP retenu à la source
// ═══════════════════════════════════════════════════════════════════════════

function getDgiParams() {
  const rows = db.prepare("SELECT cle, valeur FROM parametres WHERE cle LIKE 'dgi%' OR cle LIKE 'irpp%'").all();
  const p = {};
  rows.forEach(r => { p[r.cle] = r.valeur; });
  return p;
}

function agregeBulletinsDgi(mois, annee) {
  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.matricule, e.poste, e.type, e.cnss
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.nom
  `).all(mois, annee);

  const totaux = rows.reduce((acc, r) => ({
    nb_employes:         acc.nb_employes         + 1,
    masse_salariale:     acc.masse_salariale      + (r.brut            || 0),
    total_net_imposable: acc.total_net_imposable  + (r.net_imposable   || 0),
    total_irpp:          acc.total_irpp           + (r.irpp            || 0),
  }), { nb_employes:0, masse_salariale:0, total_net_imposable:0, total_irpp:0 });

  return { lignes: rows, totaux };
}

// ── GET /api/salaires/dgi/params ────────────────────────────────────────────
router.get('/dgi/params', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(getDgiParams());
});

// ── PUT /api/salaires/dgi/params ────────────────────────────────────────────
router.put('/dgi/params', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const allowed = ['dgi_numero_contribuable','dgi_centre_impot','dgi_date_limite_jour','dgi_formulaire',
                   'irpp_plafond_t1','irpp_taux_t2','irpp_plafond_t2','irpp_taux_t3',
                   'irpp_plafond_t3','irpp_taux_t4'];
  const upd = db.prepare("INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) upd.run(k, String(v));
    }
  });
  tx();
  res.json({ ok: true });
});

// ── GET /api/salaires/dgi/declarations ──────────────────────────────────────
router.get('/dgi/declarations', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const rows = db.prepare(`
    SELECT d.*,
      (SELECT SUM(montant) FROM dgi_paiements WHERE declaration_id = d.id) AS deja_paye
    FROM dgi_declarations d
    WHERE d.annee = ?
    ORDER BY d.mois DESC
  `).all(annee);
  res.json(rows);
});

// ── GET /api/salaires/dgi/declaration/:mois/:annee ───────────────────────────
router.get('/dgi/declaration/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  if (!mois || !annee) return res.status(400).json({ error: 'Période invalide' });

  const decl      = db.prepare("SELECT * FROM dgi_declarations WHERE mois = ? AND annee = ?").get(mois, annee);
  const { lignes, totaux } = agregeBulletinsDgi(mois, annee);
  const paiements = decl
    ? db.prepare("SELECT * FROM dgi_paiements WHERE declaration_id = ? ORDER BY date_paiement").all(decl.id)
    : [];
  const params = getDgiParams();

  res.json({ declaration: decl || null, lignes, totaux, paiements, params });
});

// ── POST /api/salaires/dgi/declaration ──────────────────────────────────────
router.post('/dgi/declaration', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee, notes, ref_declaration } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });

  const { totaux } = agregeBulletinsDgi(Number(mois), Number(annee));
  if (totaux.nb_employes === 0) return res.status(400).json({ error: 'Aucun bulletin pour cette période' });

  const p = getDgiParams();
  const jour = parseInt(p.dgi_date_limite_jour || '15', 10);
  const moisSuiv  = Number(mois) === 12 ? 1 : Number(mois) + 1;
  const anneeSuiv = Number(mois) === 12 ? Number(annee) + 1 : Number(annee);
  const date_limite = `${anneeSuiv}-${String(moisSuiv).padStart(2,'0')}-${String(jour).padStart(2,'0')}`;

  const existing = db.prepare("SELECT id FROM dgi_declarations WHERE mois = ? AND annee = ?").get(mois, annee);
  if (existing) {
    db.prepare(`
      UPDATE dgi_declarations
      SET nb_employes=?, masse_salariale=?, total_net_imposable=?, total_irpp=?,
          date_limite=?, ref_declaration=COALESCE(?,ref_declaration),
          notes=COALESCE(?,notes), updated_by=?, updated_at=datetime('now')
      WHERE id=?
    `).run(totaux.nb_employes, totaux.masse_salariale, totaux.total_net_imposable, totaux.total_irpp,
           date_limite, ref_declaration || null, notes || null, req.user.id, existing.id);
    return res.json({ ok: true, id: existing.id });
  }

  const r = db.prepare(`
    INSERT INTO dgi_declarations
      (mois, annee, date_limite, nb_employes, masse_salariale,
       total_net_imposable, total_irpp, ref_declaration, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(mois, annee, date_limite, totaux.nb_employes, totaux.masse_salariale,
         totaux.total_net_imposable, totaux.total_irpp,
         ref_declaration || null, notes || null, req.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── PUT /api/salaires/dgi/declaration/:id/statut ────────────────────────────
router.put('/dgi/declaration/:id/statut', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { statut, date_depot, ref_declaration } = req.body;
  const STATUTS = ['en_attente','deposee','payee','rejetee','archivee'];
  if (!STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const archive_at = statut === 'archivee' ? `datetime('now')` : null;
  const r = db.prepare(`
    UPDATE dgi_declarations
    SET statut=?, date_depot=COALESCE(?,date_depot),
        ref_declaration=COALESCE(?,ref_declaration),
        archive_at=CASE WHEN ? = 'archivee' THEN datetime('now') ELSE archive_at END,
        updated_by=?, updated_at=datetime('now')
    WHERE id=?
  `).run(statut, date_depot || null, ref_declaration || null, statut, req.user.id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Déclaration introuvable' });
  res.json({ ok: true });
});

// ── POST /api/salaires/dgi/paiement ─────────────────────────────────────────
router.post('/dgi/paiement', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { declaration_id, montant, date_paiement, mode_paiement, ref_paiement, banque, notes } = req.body;
  if (!declaration_id || !montant || !date_paiement)
    return res.status(400).json({ error: 'declaration_id, montant et date_paiement requis' });

  const decl = db.prepare("SELECT * FROM dgi_declarations WHERE id=?").get(declaration_id);
  if (!decl) return res.status(404).json({ error: 'Déclaration introuvable' });

  const r = db.prepare(`
    INSERT INTO dgi_paiements
      (declaration_id, montant, date_paiement, mode_paiement, ref_paiement, banque, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(declaration_id, montant, date_paiement,
         mode_paiement || 'virement_bancaire', ref_paiement || null,
         banque || null, notes || null, req.user.id);

  const totalPaye = db.prepare("SELECT SUM(montant) AS s FROM dgi_paiements WHERE declaration_id=?")
    .get(declaration_id).s || 0;
  if (totalPaye >= decl.total_irpp) {
    db.prepare("UPDATE dgi_declarations SET statut='payee', montant_paye=?, date_paiement=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
      .run(totalPaye, date_paiement, req.user.id, declaration_id);
  } else {
    db.prepare("UPDATE dgi_declarations SET montant_paye=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
      .run(totalPaye, req.user.id, declaration_id);
  }

  res.json({ ok: true, id: r.lastInsertRowid, total_paye: totalPaye });
});

// ── DELETE /api/salaires/dgi/paiement/:id ───────────────────────────────────
router.delete('/dgi/paiement/:id', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const pmt = db.prepare("SELECT * FROM dgi_paiements WHERE id=?").get(req.params.id);
  if (!pmt) return res.status(404).json({ error: 'Paiement introuvable' });
  db.prepare("DELETE FROM dgi_paiements WHERE id=?").run(req.params.id);
  const totalPaye = db.prepare("SELECT SUM(montant) AS s FROM dgi_paiements WHERE declaration_id=?")
    .get(pmt.declaration_id).s || 0;
  const decl = db.prepare("SELECT total_irpp FROM dgi_declarations WHERE id=?").get(pmt.declaration_id);
  const newStatut = totalPaye >= (decl?.total_irpp || 0) ? 'payee' : 'deposee';
  db.prepare("UPDATE dgi_declarations SET montant_paye=?, statut=?, updated_at=datetime('now') WHERE id=?")
    .run(totalPaye, newStatut, pmt.declaration_id);
  res.json({ ok: true });
});

// ── GET /api/salaires/dgi/bordereau-pdf/:mois/:annee ────────────────────────
router.get('/dgi/bordereau-pdf/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  const { lignes, totaux } = agregeBulletinsDgi(mois, annee);
  const params  = getDgiParams();
  const societe = getSociete();
  const devise  = getDevise();
  const fmt = n => Math.round(n || 0).toLocaleString('fr-FR');
  const MOIS_NOM = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Tableau des tranches IRPP en vigueur
  const t1 = fmt(params.irpp_plafond_t1 || 464000);
  const t2 = fmt(params.irpp_plafond_t2 || 1000000);
  const t3 = fmt(params.irpp_plafond_t3 || 3000000);

  const lignesHtml = lignes.map((r, i) => {
    const taux_effectif = r.net_imposable > 0
      ? ((r.irpp / r.net_imposable) * 100).toFixed(2)
      : '0.00';
    return `
    <tr class="${i % 2 === 0 ? 'pair' : 'impair'}">
      <td>${i + 1}</td>
      <td>${r.matricule || '—'}</td>
      <td>${r.nom} ${r.prenom}</td>
      <td>${r.poste || '—'}</td>
      <td>${r.type === 'permanent' ? 'CDI/CDD' : 'Stagiaire'}</td>
      <td class="num">${fmt(r.brut)}</td>
      <td class="num">${fmt((r.cnss_employe||0)+(r.camu_employe||0))}</td>
      <td class="num">${fmt(r.net_imposable)}</td>
      <td class="num irpp-col">${fmt(r.irpp)}</td>
      <td class="num">${taux_effectif}%</td>
      <td class="num net-col">${fmt(r.net_a_payer)}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bordereau DGI IRPP — ${MOIS_NOM[mois]} ${annee}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #1a1a1a; padding: 20px; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 2px solid #7c3aed; padding-bottom: 12px; }
  .societe { font-size: 14px; font-weight: bold; color: #7c3aed; }
  .ref { font-size: 10px; color: #555; margin-top: 3px; }
  .titre { text-align: center; font-size: 16px; font-weight: bold; color: #7c3aed; margin-bottom: 3px; }
  .sous-titre { text-align: center; font-size: 12px; color: #444; margin-bottom: 14px; }
  .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
  .info-box { background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 4px; padding: 6px 8px; }
  .info-box label { font-weight: bold; color: #7c3aed; display: block; margin-bottom: 2px; font-size: 9px; }
  .tranches { background: #fdf4ff; border: 1px solid #e9d5ff; border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; font-size: 9px; }
  .tranches h4 { color: #7c3aed; font-size: 10px; margin-bottom: 5px; }
  .tranches-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .tranche-item { text-align: center; padding: 3px; background: white; border-radius: 3px; border: 1px solid #e9d5ff; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; }
  th { background: #7c3aed; color: white; padding: 5px 4px; text-align: center; }
  td { border: 1px solid #d1d5db; padding: 3px 4px; }
  .num { text-align: right; }
  .pair { background: #f9fafb; }
  .impair { background: #ffffff; }
  .irpp-col { background: #fdf4ff; font-weight: bold; color: #7c3aed; }
  .net-col { background: #f0fdf4; font-weight: bold; color: #16a34a; }
  .tfoot-row td { background: #7c3aed; color: white; font-weight: bold; text-align: right; font-size: 10px; }
  .tfoot-row td:first-child, .tfoot-row td:nth-child(2), .tfoot-row td:nth-child(3),
  .tfoot-row td:nth-child(4), .tfoot-row td:nth-child(5) { text-align: center; }
  .recap { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
  .recap-box { border: 1px solid #d1d5db; border-radius: 4px; padding: 10px; }
  .recap-box h3 { font-size: 11px; color: #7c3aed; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin-bottom: 6px; }
  .recap-ligne { display: flex; justify-content: space-between; padding: 2px 0; font-size: 10px; }
  .grand-total { background: #7c3aed; color: white; text-align: center; padding: 10px; border-radius: 4px; margin-top: 12px; font-size: 13px; font-weight: bold; }
  .attestation { border: 1px solid #d1d5db; border-radius: 4px; padding: 10px; margin-top: 14px; font-size: 9px; color: #555; line-height: 1.6; }
  .signature { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 24px; }
  .sign-box { border-top: 1px solid #9ca3af; padding-top: 8px; text-align: center; font-size: 10px; color: #555; min-height: 60px; }
  .footer { margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 8px; text-align: center; font-size: 8px; color: #9ca3af; }
  @media print { body { padding: 10px; } }
</style>
</head>
<body>
<div class="entete">
  <div>
    <div class="societe">${societe}</div>
    <div class="ref">N° Contribuable DGI : <b>${params.dgi_numero_contribuable || '________________'}</b></div>
    <div class="ref">Centre des impôts : <b>${params.dgi_centre_impot || '________________'}</b></div>
    <div class="ref">Formulaire : <b>${params.dgi_formulaire || 'IRPP-Salaires'}</b></div>
  </div>
  <div style="text-align:right">
    <div class="ref">Date d'édition : ${new Date().toLocaleDateString('fr-FR')}</div>
    <div class="ref">République du Congo</div>
    <div class="ref">Direction Générale des Impôts</div>
  </div>
</div>

<div class="titre">BORDEREAU DE VERSEMENT DE L'IMPÔT SUR LE REVENU DES PERSONNES PHYSIQUES</div>
<div class="sous-titre">Retenues à la source sur salaires — Période : <b>${MOIS_NOM[mois]} ${annee}</b></div>

<div class="info-grid">
  <div class="info-box"><label>Employés déclarés</label>${totaux.nb_employes}</div>
  <div class="info-box"><label>Masse salariale brute</label>${fmt(totaux.masse_salariale)} ${devise}</div>
  <div class="info-box"><label>Total net imposable</label>${fmt(totaux.total_net_imposable)} ${devise}</div>
  <div class="info-box"><label>IRPP total à reverser</label><span style="color:#7c3aed;font-weight:bold">${fmt(totaux.total_irpp)} ${devise}</span></div>
</div>

<div class="tranches">
  <h4>Barème IRPP mensuel en vigueur — Congo-Brazzaville</h4>
  <div class="tranches-grid">
    <div class="tranche-item"><div style="font-weight:bold;color:#7c3aed">Tranche 1</div>0 — ${t1} XAF<br><b>0%</b></div>
    <div class="tranche-item"><div style="font-weight:bold;color:#7c3aed">Tranche 2</div>${t1} — ${t2} XAF<br><b>${params.irpp_taux_t2||10}%</b></div>
    <div class="tranche-item"><div style="font-weight:bold;color:#7c3aed">Tranche 3</div>${t2} — ${t3} XAF<br><b>${params.irpp_taux_t3||25}%</b></div>
    <div class="tranche-item"><div style="font-weight:bold;color:#7c3aed">Tranche 4</div>&gt; ${t3} XAF<br><b>${params.irpp_taux_t4||40}%</b></div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th><th>Matricule</th><th>Nom &amp; Prénom</th><th>Poste</th><th>Contrat</th>
      <th>Salaire brut</th><th>Cotis. soc.</th><th>Net imposable</th>
      <th>IRPP retenu</th><th>Taux eff.</th><th>Net à payer</th>
    </tr>
  </thead>
  <tbody>${lignesHtml}</tbody>
  <tfoot>
    <tr class="tfoot-row">
      <td colspan="5">TOTAUX</td>
      <td>${fmt(totaux.masse_salariale)}</td>
      <td>—</td>
      <td>${fmt(totaux.total_net_imposable)}</td>
      <td>${fmt(totaux.total_irpp)}</td>
      <td>—</td>
      <td>—</td>
    </tr>
  </tfoot>
</table>

<div class="recap">
  <div class="recap-box">
    <h3>Récapitulatif fiscal</h3>
    <div class="recap-ligne"><span>Masse salariale brute</span><span><b>${fmt(totaux.masse_salariale)} ${devise}</b></span></div>
    <div class="recap-ligne"><span>Total net imposable</span><span><b>${fmt(totaux.total_net_imposable)} ${devise}</b></span></div>
    <div class="recap-ligne" style="border-top:1px solid #e5e7eb;margin-top:4px;padding-top:4px;color:#7c3aed">
      <span><b>IRPP total à reverser</b></span><span><b>${fmt(totaux.total_irpp)} ${devise}</b></span>
    </div>
  </div>
  <div class="recap-box">
    <h3>Base légale</h3>
    <div class="recap-ligne"><span>Texte</span><span>Loi n° 4-2019 portant Code général des impôts</span></div>
    <div class="recap-ligne"><span>Retenue</span><span>À la source par l'employeur</span></div>
    <div class="recap-ligne"><span>Délai</span><span>Au plus tard le ${params.dgi_date_limite_jour||'15'} du mois suivant</span></div>
  </div>
</div>

<div class="grand-total">
  MONTANT IRPP À VERSER À LA DGI : ${fmt(totaux.total_irpp)} ${devise}
</div>

<div class="attestation">
  Je soussigné(e), représentant légal de <b>${societe}</b>, atteste l'exactitude des informations portées sur ce bordereau
  et certifie que les retenues à la source ont été effectuées sur les salaires des ${totaux.nb_employes} employé(s)
  déclarés au titre de <b>${MOIS_NOM[mois]} ${annee}</b>, conformément à la législation fiscale en vigueur en République du Congo.
</div>

<div class="signature">
  <div class="sign-box">Cachet &amp; Signature du représentant légal<br><br><br>${societe}</div>
  <div class="sign-box">Cachet &amp; Visa DGI<br><br><br>Reçu le : ___/___/______</div>
</div>

<div class="footer">
  Document généré automatiquement — ${societe} — ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}
  | Ce bordereau doit être déposé à la DGI au plus tard le ${params.dgi_date_limite_jour||'15'} du mois suivant.
  | République du Congo — Direction Générale des Impôts
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="dgi-irpp-${mois}-${annee}.html"`);
  res.send(html);
});

// ── GET /api/salaires/dgi/bordereau-csv/:mois/:annee ────────────────────────
router.get('/dgi/bordereau-csv/:mois/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const mois  = Number(req.params.mois);
  const annee = Number(req.params.annee);
  const { lignes, totaux } = agregeBulletinsDgi(mois, annee);
  const MOIS_NOM = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const BOM = '﻿';
  const SEP = ';';
  const headers = ['N°','Matricule','Nom','Prénom','Poste','Type contrat',
                   'Salaire brut','Cotisations sociales','Net imposable',
                   'IRPP retenu','Taux effectif (%)','Net à payer','Statut bulletin'];
  const csvRows = lignes.map((r, i) => {
    const cotSoc = (r.cnss_employe||0) + (r.camu_employe||0);
    const taux   = r.net_imposable > 0 ? ((r.irpp / r.net_imposable) * 100).toFixed(2) : '0.00';
    return [
      i+1, r.matricule||'',
      `"${(r.nom||'').replace(/"/g,'""')}"`,
      `"${(r.prenom||'').replace(/"/g,'""')}"`,
      r.poste||'', r.type||'',
      r.brut||0, cotSoc,
      r.net_imposable||0, r.irpp||0, taux,
      r.net_a_payer||0, r.statut
    ].join(SEP);
  });
  csvRows.push(['','','TOTAL','','','',
    totaux.masse_salariale,'',
    totaux.total_net_imposable, totaux.total_irpp,'',
    '',''].join(SEP));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dgi-irpp-${mois}-${annee}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
});

// ── GET /api/salaires/dgi/export-fiscal/:annee ──────────────────────────────
// Export annuel récapitulatif — utile pour la déclaration annuelle DGI
router.get('/dgi/export-fiscal/:annee', (req, res) => {
  if (!canRHFinance(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const annee = Number(req.params.annee);
  const MOIS_NOM = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Par employé : cumul annuel
  const rows = db.prepare(`
    SELECT e.matricule, e.nom, e.prenom, e.poste, e.type,
      COUNT(b.id)              AS nb_bulletins,
      SUM(b.brut)              AS total_brut,
      SUM(b.net_imposable)     AS total_net_imposable,
      SUM(b.irpp)              AS total_irpp,
      SUM(b.net_a_payer)       AS total_net
    FROM employes e
    JOIN bulletins_salaire b ON b.employe_id = e.id
    WHERE b.annee = ?
    GROUP BY e.id
    ORDER BY e.nom
  `).all(annee);

  if (req.query.format === 'csv') {
    const BOM = '﻿';
    const SEP = ';';
    const headers = ['Matricule','Nom','Prénom','Poste','Type','Bulletins',
                     'Total brut annuel','Total net imposable','Total IRPP annuel','Total net perçu'];
    const csvRows = rows.map(r => [
      r.matricule||'',
      `"${(r.nom||'').replace(/"/g,'""')}"`,
      `"${(r.prenom||'').replace(/"/g,'""')}"`,
      r.poste||'', r.type||'', r.nb_bulletins,
      r.total_brut||0, r.total_net_imposable||0,
      r.total_irpp||0, r.total_net||0
    ].join(SEP));
    const totRow = rows.reduce((acc, r) => {
      acc.brut += r.total_brut||0;
      acc.ni   += r.total_net_imposable||0;
      acc.irpp += r.total_irpp||0;
      acc.net  += r.total_net||0;
      return acc;
    }, { brut:0, ni:0, irpp:0, net:0 });
    csvRows.push(['','TOTAL','','','','',totRow.brut,totRow.ni,totRow.irpp,totRow.net].join(SEP));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dgi-fiscal-annuel-${annee}.csv"`);
    return res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
  }

  // JSON par défaut
  const totaux = rows.reduce((acc, r) => ({
    nb_employes: acc.nb_employes + 1,
    total_brut:  acc.total_brut  + (r.total_brut||0),
    total_net_imposable: acc.total_net_imposable + (r.total_net_imposable||0),
    total_irpp:  acc.total_irpp  + (r.total_irpp||0),
    total_net:   acc.total_net   + (r.total_net||0),
  }), { nb_employes:0, total_brut:0, total_net_imposable:0, total_irpp:0, total_net:0 });

  res.json({ annee, lignes: rows, totaux });
});

function getDevise() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get();
  return r ? r.valeur : 'XAF';
}

module.exports = router;

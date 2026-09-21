'use strict';

const nodemailer = require('nodemailer');
const db         = require('../db');

async function getEmailConfig() {
  const params = await db.query(
    "SELECT cle, valeur FROM parametres WHERE cle LIKE ? OR cle LIKE ?",
    ['smtp_%', 'imap_%']
  );
  const cfg = {};
  params.forEach(p => { cfg[p.cle] = p.valeur; });
  return {
    smtp_host: cfg.smtp_host || process.env.SMTP_HOST || 'mail.infomaniak.com',
    smtp_port: Number(cfg.smtp_port || process.env.SMTP_PORT || 587),
    smtp_user: cfg.smtp_user || process.env.SMTP_USER || 'support@topcenter.cg',
    smtp_pass: cfg.smtp_pass || process.env.SMTP_PASS || '',
    smtp_from: cfg.smtp_from || process.env.SMTP_FROM || 'TOP CENTER <support@topcenter.cg>',
    imap_host: cfg.imap_host || process.env.IMAP_HOST || 'mail.infomaniak.com',
    imap_port: Number(cfg.imap_port || process.env.IMAP_PORT || 993),
  };
}

// ─── VÉRIFICATION DE LA CONFIGURATION ─────────────────────────────────────────
// Un réglage absent rendait chaque envoi impossible sans jamais dire lequel :
// le transport était construit avec auth = { user, pass: '' }, Nodemailer
// annonçait PLAIN sans mot de passe et rendait « Missing credentials for
// "PLAIN" ». Cette erreur était recopiée telle quelle dans notif_envois.erreur
// (420 lignes entre le 2026-05-09 et le 2026-09-14, aucun envoi réussi) sans
// désigner le réglage à renseigner ni l'endroit où le faire.

// Réglages sans lesquels aucun envoi ne peut aboutir, et leur source.
const REGLAGES_REQUIS = [
  { cle: 'smtp_host', env: 'SMTP_HOST' },
  { cle: 'smtp_port', env: 'SMTP_PORT' },
  { cle: 'smtp_user', env: 'SMTP_USER' },
  { cle: 'smtp_pass', env: 'SMTP_PASS' },
  { cle: 'smtp_from', env: 'SMTP_FROM' },
];

function estRenseigne(valeur) {
  if (valeur === null || valeur === undefined) return false;
  if (typeof valeur === 'number') return Number.isFinite(valeur) && valeur > 0;
  return String(valeur).trim() !== '';
}

/**
 * Inspecte une configuration courriel et nomme ce qui manque.
 * Ne rend que des noms de réglages — jamais une valeur.
 *
 * @param   {object} cfg  issu de getEmailConfig()
 * @returns {{ complete: boolean, manquants: string[], sources: string[] }}
 */
function verifierConfigEmail(cfg) {
  const absents = REGLAGES_REQUIS.filter(r => !estRenseigne(cfg && cfg[r.cle]));
  return {
    complete:  absents.length === 0,
    manquants: absents.map(r => r.cle),
    sources:   absents.map(r => `parametres.${r.cle} ou ${r.env}`),
  };
}

function messageConfigIncomplete(verdict) {
  return 'Configuration courriel incomplète — réglage(s) manquant(s) : '
    + `${verdict.manquants.join(', ')}. `
    + `À renseigner dans la table parametres (clé ${verdict.manquants.join(', ')}) `
    + `ou par variable d'environnement (${verdict.sources.join(' ; ')}). `
    + 'Aucun envoi tenté.';
}

/**
 * Refuse l'envoi tant que la configuration est incomplète, en nommant le
 * réglage manquant. Échouer ici évite d'ouvrir un transport qui ne peut
 * qu'être rejeté, et remplace « Missing credentials for "PLAIN" » par une
 * cause exploitable dans notif_envois.erreur.
 */
function assurerConfigUtilisable(cfg) {
  const verdict = verifierConfigEmail(cfg);
  if (!verdict.complete) throw new Error(messageConfigIncomplete(verdict));
  return verdict;
}

let avertissementEmis = false;

/**
 * Contrôle de démarrage. Écrit un avertissement net une seule fois plutôt que
 * de laisser la panne se répéter en silence à chaque envoi.
 * `bloquant: true` arrête le serveur, sur le modèle du runner de migrations.
 *
 * @returns {Promise<{ complete: boolean, manquants: string[], sources: string[] }>}
 */
async function verifierConfigDemarrage({ bloquant = false } = {}) {
  let verdict;
  try {
    verdict = verifierConfigEmail(await getEmailConfig());
  } catch (err) {
    console.error('[courriel] configuration illisible :', err.message);
    if (bloquant) process.exit(1);
    return { complete: false, manquants: ['inconnu'], sources: [] };
  }
  if (!verdict.complete) {
    console.error(`[courriel] ${messageConfigIncomplete(verdict)}`);
    console.error('[courriel] tant que ce réglage manque, aucune alerte par courriel '
      + 'n\'est remise (notif_envois passe en statut=echec).');
    if (bloquant) {
      console.error('[courriel] ERREUR CRITIQUE - arrêt du serveur');
      process.exit(1);
    }
  }
  avertissementEmis = true;
  return verdict;
}

function avertirUneFois(verdict) {
  if (avertissementEmis) return;
  avertissementEmis = true;
  console.error(`[courriel] ${messageConfigIncomplete(verdict)}`);
}

function buildTransporter(cfg) {
  const options = {
    host:       cfg.smtp_host,
    port:       cfg.smtp_port,
    secure:     cfg.smtp_port === 465,
    requireTLS: cfg.smtp_port === 587,
    tls:        { rejectUnauthorized: false },
  };
  // N'annoncer l'authentification que si les deux identifiants existent.
  // Un bloc auth au mot de passe vide fait échouer la session sur PLAIN.
  if (estRenseigne(cfg.smtp_user) && estRenseigne(cfg.smtp_pass)) {
    options.auth = { user: cfg.smtp_user, pass: cfg.smtp_pass };
  }
  return nodemailer.createTransport(options);
}

async function sendMail({ to, subject, html, text, attachments }) {
  const cfg = await getEmailConfig();
  const verdict = verifierConfigEmail(cfg);
  if (!verdict.complete) {
    avertirUneFois(verdict);
    throw new Error(messageConfigIncomplete(verdict));
  }
  const transporter = buildTransporter(cfg);
  const msg = {
    from:    cfg.smtp_from,
    to,
    subject,
    html,
    text:    text || html.replace(/<[^>]+>/g, ''),
  };
  if (attachments && attachments.length) msg.attachments = attachments;
  return transporter.sendMail(msg);
}

async function sendPasswordReset(to, nom, resetUrl) {
  return sendMail({
    to,
    subject: 'Réinitialisation de mot de passe — TOP CENTER Caisse',
    html: `
      <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px;text-align:center">
          <h1 style="margin:0;font-size:24px;color:white">TOP CENTER</h1>
          <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px">Gestion de Caisse</p>
        </div>
        <div style="padding:32px">
          <p style="margin:0 0 16px">Bonjour <strong>${nom}</strong>,</p>
          <p style="margin:0 0 24px;color:#94a3b8">Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous (valable 1 heure) :</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${resetUrl}" style="background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
              Réinitialiser le mot de passe
            </a>
          </div>
          <p style="margin:24px 0 0;font-size:12px;color:#475569">Si vous n'avez pas fait cette demande, ignorez cet email. Lien : ${resetUrl}</p>
        </div>
      </div>`,
  });
}

const NOMS_MOIS_FR = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                      'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function _bulletinHtmlEnveloppe(nom, mois, annee, htmlBulletin) {
  return `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:auto">
      <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px;border-radius:12px 12px 0 0;text-align:center">
        <h1 style="margin:0;font-size:20px;color:white">TOP CENTER — Bulletin de Paie</h1>
        <p style="margin:6px 0 0;color:#c4b5fd">${NOMS_MOIS_FR[mois] || mois}/${annee}</p>
      </div>
      <div style="background:#1e293b;padding:24px;border-radius:0 0 12px 12px;color:#e2e8f0">
        <p>Bonjour <strong>${nom}</strong>, veuillez trouver ci-dessous votre bulletin de paie.</p>
        ${htmlBulletin}
        <p style="font-size:12px;color:#475569;margin-top:24px">Ce document est confidentiel — TOP CENTER Congo</p>
      </div>
    </div>`;
}

async function sendBulletin(to, nom, mois, annee, htmlBulletin) {
  return sendMail({
    to,
    subject: `Bulletin de paie ${NOMS_MOIS_FR[mois] || mois} ${annee} — TOP CENTER`,
    html:    _bulletinHtmlEnveloppe(nom, mois, annee, htmlBulletin),
  });
}

async function sendBulletinAvecPdf(to, nom, mois, annee, htmlBulletin, pdfBuffer, nomFichier) {
  return sendMail({
    to,
    subject:     `Bulletin de paie ${NOMS_MOIS_FR[mois] || mois} ${annee} — TOP CENTER`,
    html:        _bulletinHtmlEnveloppe(nom, mois, annee, htmlBulletin),
    attachments: [{ filename: nomFichier, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

async function sendAlerte(sujet, message) {
  const cfg = await getEmailConfig();
  return sendMail({
    to:      cfg.smtp_user,
    subject: `⚠️ Alerte Caisse — ${sujet}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#1e293b;color:#e2e8f0;border-radius:12px;padding:24px">
        <h2 style="color:#f59e0b;margin-top:0">⚠️ ${sujet}</h2>
        <p>${message}</p>
        <p style="font-size:12px;color:#475569">TOP CENTER Caisse — ${new Date().toLocaleString('fr-FR')}</p>
      </div>`,
  });
}

async function testConnection() {
  const cfg = await getEmailConfig();
  assurerConfigUtilisable(cfg);
  return buildTransporter(cfg).verify();
}

async function sendCongeNotification({ to, employe_nom, action, date_debut, date_fin, nb_jours, type_conge, motif = '', par_nom = '' }) {
  const LABELS = {
    demande:    { titre: 'Demande de congé reçue',         couleur: '#6366f1' },
    valide_sup: { titre: 'Congé validé par le supérieur',  couleur: '#f59e0b' },
    approuve:   { titre: 'Congé approuvé',                 couleur: '#10b981' },
    refuse:     { titre: 'Congé refusé',                   couleur: '#ef4444' },
    annule:     { titre: 'Congé annulé',                   couleur: '#64748b' },
    termine:    { titre: 'Congé clôturé',                  couleur: '#3b82f6' },
  };
  const TYPE_LABELS = { annuel:'Annuel', maladie:'Maladie', maternite:'Maternité', paternite:'Paternité', sans_solde:'Sans solde', autre:'Autre' };
  const { titre, couleur } = LABELS[action] || { titre: action, couleur: '#6366f1' };

  const html = `
    <div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:16px;overflow:hidden">
      <div style="background:${couleur};padding:28px;text-align:center">
        <h1 style="margin:0;font-size:20px;color:white">TOP CENTER</h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px">${titre}</p>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 12px">Agent : <strong>${employe_nom}</strong></p>
        <p style="margin:0 0 6px;color:#94a3b8">Type : ${TYPE_LABELS[type_conge] || type_conge}</p>
        <p style="margin:0 0 6px;color:#94a3b8">Période : ${date_debut} → ${date_fin} (${nb_jours} jour(s))</p>
        ${motif   ? `<p style="margin:0 0 6px;color:#94a3b8">Motif/Note : ${motif}</p>`   : ''}
        ${par_nom ? `<p style="margin:0 0 6px;color:#94a3b8">Par : ${par_nom}</p>`         : ''}
      </div>
      <div style="padding:0 28px 20px;color:#475569;font-size:12px">TOP CENTER Caisse — ${new Date().toLocaleString('fr-FR')}</div>
    </div>`;

  return sendMail({ to, subject: `[Congés] ${titre} — ${employe_nom}`, html });
}

module.exports = { sendMail, sendPasswordReset, sendBulletin, sendBulletinAvecPdf, sendAlerte, sendCongeNotification, testConnection, getEmailConfig, verifierConfigEmail, verifierConfigDemarrage };

const nodemailer = require('nodemailer');
const db = require('../database');

function getEmailConfig() {
  const params = db.prepare('SELECT cle, valeur FROM parametres WHERE cle LIKE ? OR cle LIKE ?').all('smtp_%', 'imap_%');
  const cfg = {};
  params.forEach(p => cfg[p.cle] = p.valeur);
  return {
    smtp_host:  cfg.smtp_host  || process.env.SMTP_HOST  || 'mail.infomaniak.com',
    smtp_port:  Number(cfg.smtp_port  || process.env.SMTP_PORT  || 587),
    smtp_user:  cfg.smtp_user  || process.env.SMTP_USER  || 'support@topcenter.cg',
    smtp_pass:  cfg.smtp_pass  || process.env.SMTP_PASS  || '',
    smtp_from:  cfg.smtp_from  || process.env.SMTP_FROM  || 'TOP CENTER <support@topcenter.cg>',
    imap_host:  cfg.imap_host  || process.env.IMAP_HOST  || 'mail.infomaniak.com',
    imap_port:  Number(cfg.imap_port  || process.env.IMAP_PORT  || 993),
  };
}

function createTransporter() {
  const cfg = getEmailConfig();
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    requireTLS: cfg.smtp_port === 587,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    tls: { rejectUnauthorized: false }
  });
}

async function sendMail({ to, subject, html, text }) {
  const cfg = getEmailConfig();
  const transporter = createTransporter();
  return transporter.sendMail({
    from: cfg.smtp_from,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, '')
  });
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
      </div>`
  });
}

async function sendBulletin(to, nom, mois, annee, htmlBulletin) {
  return sendMail({
    to,
    subject: `Bulletin de paie ${mois}/${annee} — TOP CENTER`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:auto">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:20px;color:white">TOP CENTER — Bulletin de Paie</h1>
          <p style="margin:6px 0 0;color:#c4b5fd">${mois}/${annee}</p>
        </div>
        <div style="background:#1e293b;padding:24px;border-radius:0 0 12px 12px;color:#e2e8f0">
          <p>Bonjour <strong>${nom}</strong>, veuillez trouver ci-dessous votre bulletin de paie.</p>
          ${htmlBulletin}
          <p style="font-size:12px;color:#475569;margin-top:24px">Ce document est confidentiel — TOP CENTER Congo</p>
        </div>
      </div>`
  });
}

async function sendAlerte(sujet, message) {
  const cfg = getEmailConfig();
  return sendMail({
    to: cfg.smtp_user,
    subject: `⚠️ Alerte Caisse — ${sujet}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#1e293b;color:#e2e8f0;border-radius:12px;padding:24px">
        <h2 style="color:#f59e0b;margin-top:0">⚠️ ${sujet}</h2>
        <p>${message}</p>
        <p style="font-size:12px;color:#475569">TOP CENTER Caisse — ${new Date().toLocaleString('fr-FR')}</p>
      </div>`
  });
}

async function testConnection() {
  const transporter = createTransporter();
  return transporter.verify();
}

module.exports = { sendMail, sendPasswordReset, sendBulletin, sendAlerte, testConnection, getEmailConfig };

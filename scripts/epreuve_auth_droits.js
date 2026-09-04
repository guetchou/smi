'use strict';

/*
 * Épreuve réelle de requireAuth devenu asynchrone et relisant les droits.
 *
 * Un contrôle statique ne dirait pas si Express supporte l'intergiciel, si la
 * connexion aboutit, ni si un droit modifié en base prend effet sans
 * reconnexion. On démarre donc un vrai serveur sur une base SQLite jetable et
 * on parcourt le chemin complet — c'est ce que le défaut constaté le
 * 04/09/2026 exigeait de vérifier.
 *
 * Le captcha est demandé puis résolu selon la convention déjà employée par
 * tests/employment_contracts_playwright.spec.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const racine = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3455);
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-auth-'));
const url = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_DRIVER: 'sqlite',
  DB_PATH: path.join(dossier, 'auth.db'),
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function portLibre() {
  return new Promise((ok, ko) => {
    const s = net.createServer();
    s.once('error', (e) => ko(new Error(`Port ${port} occupé : ${e.message}`)));
    s.listen(port, '127.0.0.1', () => s.close(ok));
  });
}

function resoudreCaptcha(question) {
  const m = String(question).match(/(\d+)\s*([+\-×])\s*(\d+)/);
  if (!m) throw new Error(`Captcha illisible : ${question}`);
  if (m[2] === '+') return Number(m[1]) + Number(m[3]);
  if (m[2] === '-') return Number(m[1]) - Number(m[3]);
  return Number(m[1]) * Number(m[3]);
}

let journal = '';

async function attendreServeur(serveur) {
  for (let i = 0; i < 90; i++) {
    if (serveur.exitCode !== null) throw new Error('Le serveur s est arrêté au démarrage');
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch { /* pas encore prêt */ }
    await dormir(500);
  }
  throw new Error('Le serveur ne répond pas');
}

(async () => {
  await portLibre();
  Object.assign(process.env, env);

  const db = require('../backend/database');
  const admin = db.prepare("SELECT id, password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Compte admin absent de la base de test');

  // Une utilisatrice sans droit d'encaissement : on observera un droit qui
  // arrive APRÈS sa connexion, exactement le cas constaté en production.
  db.prepare(
    "INSERT INTO users (nom, prenom, email, login_identifier, password_hash, role, roles, actif)" +
    " VALUES ('ESSAI','Droits','essai.droits@topcenter.cg','essai.droits@topcenter.cg',?," +
    "'assistante_direction','[\"assistante_direction\"]',1)"
  ).run(admin.password_hash);
  const essai = db.prepare("SELECT id FROM users WHERE email='essai.droits@topcenter.cg'").get();

  const serveur = spawn(process.execPath, ['backend/server.js'], { cwd: racine, env, stdio: 'pipe' });
  serveur.stdout.on('data', (d) => { journal += d; });
  serveur.stderr.on('data', (d) => { journal += d; });

  const r = {};
  try {
    await attendreServeur(serveur);

    const captcha = await (await fetch(`${url}/api/auth/captcha`)).json();
    const reponse = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'essai.droits@topcenter.cg',
        password: 'Admin@2025!',
        captchaId: captcha.id,
        captchaAnswer: resoudreCaptcha(captcha.question),
      }),
    });
    const corpsConnexion = await reponse.json();
    if (!corpsConnexion.token) {
      throw new Error(`Connexion refusée (${reponse.status}) : ${JSON.stringify(corpsConnexion).slice(0, 140)}`);
    }
    const token = corpsConnexion.token;
    r.connexionAboutit = true;

    // Cible : une route gardée par hasRole seul. Les routes de caisse passent
    // par can(), qui interroge les délégations — une table dont le schéma
    // SQLite diffère de MySQL. Ce n'est pas ce qu'on éprouve ici.
    const appeler = async () => {
      const rep = await fetch(`${url}/api/salaires/rapport-comparatif`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return rep.status;
    };

    r.refuseSansLeRole = (await appeler()) === 403;

    // Le rôle est accordé EN BASE, sans nouvelle connexion.
    db.prepare('UPDATE users SET roles = ? WHERE id = ?')
      .run('["assistante_direction","rh"]', essai.id);

    const apres = await appeler();
    r.acceptDesQueLeRoleEstAccorde = apres !== 403;
    r.statutApres = apres;

    // Un compte désactivé doit être refusé sur-le-champ.
    db.prepare('UPDATE users SET actif = 0 WHERE id = ?').run(essai.id);
    r.refuseDesQueLeCompteEstDesactive = (await appeler()) === 401;
  } finally {
    serveur.kill('SIGTERM');
    await dormir(400);
  }

  const attendu = {
    connexionAboutit: true,
    refuseSansLeRole: true,
    acceptDesQueLeRoleEstAccorde: true,
    refuseDesQueLeCompteEstDesactive: true,
  };
  for (const [cle, valeur] of Object.entries(attendu)) {
    if (r[cle] !== valeur) {
      console.error(`ÉCHEC — ${cle} : ${r[cle]} (attendu ${valeur})`);
      console.error('mesures : ' + JSON.stringify(r));
      console.error('journal serveur :');
      console.error(journal.slice(-1500));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({
    loginWorksWithAsyncMiddleware: true,
    refusedWithoutTheRole: true,
    acceptedAsSoonAsTheRoleIsGranted: true,
    refusedAsSoonAsTheAccountIsDisabled: true,
  }));
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC : ' + e.message);
  console.error('journal serveur :');
  console.error(journal.slice(-1500));
  process.exit(1);
});

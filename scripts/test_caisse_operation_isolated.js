'use strict';
/*
 * Parcours de caisse, joué sans personne.
 *
 * Une panne de saisie a occupé deux jours faute de pouvoir la rejouer : il
 * fallait qu'un agent ouvre l'écran et raconte ce qu'il voyait. Ce harnais
 * lève cette dépendance — serveur jetable, base éphémère, compte semé avec le
 * profil exact d'une assistante de direction, et le parcours complet :
 * ouvrir l'écran, ouvrir la fenêtre, saisir, enregistrer.
 *
 * La session est provisionnée directement avec le secret JWT du serveur de
 * test. Le formulaire de connexion et son contrôle anti-robot ne sont pas
 * dans le périmètre mesuré ici : ce qu'on veut savoir, c'est si la saisie
 * aboutit une fois la personne entrée.
 *
 * Même forme que test_employment_contracts_isolated.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
/* Port par défaut choisi hors de la plage 3336-3340 et 3347, occupée sur le VPS
   par d'autres projets (dont la base MySQL de bantudelice-staging, publiée sur
   127.0.0.1:3339). Un banc qui ne peut pas démarrer localement n'est plus un
   outil de vérification : il ne reste que la CI, où l'on ne regarde rien.
   Vérifier avec « ss -ltn » avant d'en choisir un nouveau ; TEST_PORT reste
   prioritaire. */
const port = Number(process.env.TEST_PORT || 3345);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-caisse-'));
const dbPath = path.join(tempDir, 'smi-caisse.db');
const screenshotDir = process.env.SMI_E2E_SCREENSHOT_DIR || path.join(tempDir, 'captures');
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const systemChrome = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(candidate => fs.existsSync(candidate));

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_DRIVER: 'sqlite',
  DB_PATH: dbPath,
  SMI_E2E_BASE_URL: baseURL,
  SMI_E2E_SCREENSHOT_DIR: screenshotDir,
};
if (!env.PLAYWRIGHT_CHROME_PATH && systemChrome) env.PLAYWRIGHT_CHROME_PATH = systemChrome;

let server;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertPortFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(`Port E2E ${port} indisponible: ${error.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

/* Le compte mesuré porte le profil d'une assistante de direction, avec les
   rôles qu'elle cumule en production. C'est ce cumul qui décide de ce que
   l'écran montre et de ce que l'API accorde. */
function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');

  const inserted = db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('CAISSE','E2E','caisse.e2e@topcenter.cg','caisse.e2e',?,'assistante_direction',
            '["assistante_direction","finance","caissier","rh"]',1)
  `).run(admin.password_hash);
  const userId = Number(inserted.lastInsertRowid);

  for (const code of ['assistante_direction', 'caissier', 'rh']) {
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(code);
    if (!profil) throw new Error(`Le profil « ${code} » doit exister dans le socle`);
    db.prepare(`
      INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')
    `).run(userId, profil.id);
  }

  const modules = db.prepare(`
    SELECT DISTINCT p.module FROM user_profiles up
      JOIN profile_permissions pp ON pp.profile_id = up.profile_id
      JOIN permissions p ON p.id = pp.permission_id
     WHERE up.user_id = ? AND up.active = 1
  `).all(userId).map(r => r.module);

  // La convention est « encaissement »/« decaissement » ; « recette »/« depense »
  // reste accepte cote ecran, fillRubriques prend les deux.
  const rubriques = db.prepare(
    "SELECT COUNT(*) n FROM categories WHERE type IN ('recette','encaissement')").get().n;
  const positions = db.prepare('SELECT COUNT(*) n FROM positions').get().n;
  /* Les six règles de ventilation sont semées en brouillon — « draftRules »,
     is_active = 0 — pour qu'un comptable les valide avant qu'une machine ne
     poste dans les comptes. La production les a activées ; le banc mesure la
     configuration réelle, pas celle d'une installation que personne n'a
     paramétrée. Sans cela aucun parcours ne verrait jamais d'écriture, et
     c'est précisément ce trou qui a laissé passer le 17/09/2026. */
  db.prepare('UPDATE accounting_mapping_rules SET is_active = 1').run();
  const regleVente = db.prepare(`
    SELECT id FROM accounting_mapping_rules
     WHERE is_active = 1 AND operation_type = 'encaissement'
       AND payment_method = 'especes' AND position_type = 'caisse'
       AND third_party_type = 'tiers'
  `).get();
  db.close();
  if (!regleVente) {
    throw new Error('Le socle doit porter une règle active « encaissement · espèces · caisse · tiers » — sans elle la vente entre en caisse sans écriture');
  }

  if (!modules.includes('cash')) throw new Error('Le compte mesuré doit porter le module « cash »');
  if (!rubriques) throw new Error('Le socle doit contenir au moins une rubrique de recette');
  if (!positions) throw new Error('Le socle doit contenir au moins une position');

  fs.writeFileSync(
    path.join(tempDir, 'compte.json'),
    JSON.stringify({ id: userId, modules, rubriques, positions }),
  );
  console.log(`[socle] compte #${userId} — modules : ${modules.sort().join(', ')}`);
  console.log(`[socle] ${rubriques} rubrique(s) de recette, ${positions} position(s)`);

  env.SMI_E2E_USER_ID = String(userId);

  // La session est provisionnee ici : le formulaire de connexion et son
  // controle anti-robot ne sont pas l'objet de cette mesure.
  const base64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signerHS256 = (charge, cle) => {
    const tete = base64url({ alg: 'HS256', typ: 'JWT' });
    const corps = base64url({ ...charge, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    const signature = crypto.createHmac('sha256', cle).update(`${tete}.${corps}`).digest('base64url');
    return `${tete}.${corps}.${signature}`;
  };
  env.SMI_E2E_TOKEN = signerHS256({
    id: userId,
    email: 'caisse.e2e@topcenter.cg',
    role: 'assistante_direction',
    roles: ['assistante_direction', 'finance', 'caissier', 'rh'],
    nom: 'CAISSE',
    prenom: 'E2E',
    jti: 'e2e-caisse',
  }, env.JWT_SECRET);
}

async function waitForHealth() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error(`Serveur E2E non disponible sur ${baseURL}`);
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const cli = require.resolve('@playwright/test/cli');
    const child = spawn(process.execPath, [
      cli, 'test', 'tests/caisse_operation_playwright.spec.js',
      '--project=chromium', '--reporter=line', '--retries=0',
    ], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Playwright termine avec le code ${code}`))));
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function main() {
  await assertPortFree();
  fs.mkdirSync(screenshotDir, { recursive: true });
  seedDatabase();

  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, ['backend/server.js'], {
    cwd: root, env, stdio: ['ignore', log, log],
  });
  server.on('exit', code => {
    if (code !== 0 && code !== null) {
      console.error(`[serveur] arret inattendu (code ${code}) — journal : ${logPath}`);
    }
  });

  try {
    await waitForHealth();
    await runPlaywright();
    console.log(`caisse_operation_isolated: OK — captures dans ${screenshotDir}`);
  } finally {
    await stopServer();
  }
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

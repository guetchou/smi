'use strict';
/*
 * Banc isolé — écran « Prévisions budgétaires » (décision du 29/09/2026).
 *
 * Un serveur réel sur une base SQLite jetable, un compte finance, trois
 * encaissements validés et un virement de fonds. Playwright ouvre l'écran à
 * 1366×768 (l'écran de l'utilisateur), saisit une prévision, l'enregistre,
 * et le banc vérifie ensuite en base : la ligne budgétaire existe, l'opération
 * du mois est imputée, celle d'un autre mois ne l'est pas, le virement est
 * sans objet. Chaque étape laisse une capture.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
/* Port choisi hors de ceux des autres bancs et des services du VPS ;
   TEST_PORT reste prioritaire. */
const port = Number(process.env.TEST_PORT || 3361);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-budget-'));
const dbPath = path.join(tempDir, 'smi-budget.db');
const screenshotDir = process.env.SMI_E2E_SCREENSHOT_DIR || path.join(tempDir, 'captures');
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;
const ANNEE = new Date().getFullYear();

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
  SMI_E2E_ANNEE: String(ANNEE),
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

function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');
  const userId = Number(db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('FINANCE','E2E','finance.e2e@topcenter.cg','finance.e2e',?,'finance','["finance"]',1)
  `).run(admin.password_hash).lastInsertRowid);
  const profil = db.prepare("SELECT id FROM profiles WHERE code = 'caissier'").get();
  if (!profil) throw new Error('Le profil « caissier » doit exister dans le socle');
  db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')").run(userId, profil.id);

  const categorie = db.prepare("SELECT id, nom FROM categories WHERE type = 'encaissement' AND actif = 1 ORDER BY id LIMIT 1").get();
  const caisse = db.prepare("SELECT id FROM positions WHERE type = 'caisse' ORDER BY id LIMIT 1").get();
  const banque = db.prepare("SELECT id FROM positions WHERE type = 'banque' ORDER BY id LIMIT 1").get();
  if (!categorie || !caisse || !banque) throw new Error('Socle incomplet : catégorie, caisse ou banque absente');

  const inserer = db.prepare(`
    INSERT INTO operations (date, num_piece, libelle, tiers, montant, type_op, position_id, position_source_id,
      categorie_id, mode_reglement, statut, treasury_status, accounting_status, budget_status, allocation_status, created_by)
    VALUES (?, ?, 'Recette prestation', 'Client E2E', ?, ?, ?, ?, ?, 'especes', 'valide', 'synced', 'pending', 'pending', 'pending', ?)
  `);
  const ids = {
    janvier: Number(inserer.run(`${ANNEE}-01-13`, 'E2E-BUD-1', 1200000, 'encaissement', caisse.id, null, categorie.id, userId).lastInsertRowid),
    fevrier: Number(inserer.run(`${ANNEE}-02-02`, 'E2E-BUD-2', 2000000, 'encaissement', caisse.id, null, categorie.id, userId).lastInsertRowid),
    virement: Number(inserer.run(`${ANNEE}-02-05`, 'E2E-BUD-3', 600000, 'virement', caisse.id, banque.id, null, userId).lastInsertRowid),
  };
  db.close();

  fs.writeFileSync(path.join(tempDir, 'socle.json'), JSON.stringify({ userId, categorie, ids }));
  console.log(`[socle] compte finance #${userId} ; catégorie « ${categorie.nom} » ; opérations ${JSON.stringify(ids)}`);

  env.SMI_E2E_CATEGORIE = categorie.nom;
  const base64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tete = base64url({ alg: 'HS256', typ: 'JWT' });
  const corps = base64url({
    id: userId, email: 'finance.e2e@topcenter.cg', role: 'finance', roles: ['finance'],
    nom: 'FINANCE', prenom: 'E2E', jti: 'e2e-budget',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto.createHmac('sha256', env.JWT_SECRET).update(`${tete}.${corps}`).digest('base64url');
  env.SMI_E2E_TOKEN = `${tete}.${corps}.${signature}`;
  env.SMI_E2E_USER_ID = String(userId);
  return ids;
}

function verifierBase(ids) {
  const Database = require(path.join(root, 'backend', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: true });
  const etat = id => db.prepare('SELECT budget_status FROM operations WHERE id = ?').get(id).budget_status;
  const lignes = db.prepare('SELECT mois, annee, montant_prevu FROM budgets').all();
  const resultats = {
    lignes,
    janvier: etat(ids.janvier),
    fevrier: etat(ids.fevrier),
    virement: etat(ids.virement),
  };
  db.close();
  console.log('[base] ' + JSON.stringify(resultats));
  const erreurs = [];
  if (!lignes.some(l => Number(l.mois) === 1 && Number(l.annee) === ANNEE && Number(l.montant_prevu) === 3000000)) erreurs.push('la prévision de janvier n est pas en base');
  if (resultats.janvier !== 'synced') erreurs.push(`janvier devrait être imputé, il est « ${resultats.janvier} »`);
  if (resultats.fevrier !== 'pending') erreurs.push(`février n a pas de prévision, il est « ${resultats.fevrier} »`);
  if (resultats.virement !== 'not_applicable') erreurs.push(`le virement devrait être sans objet, il est « ${resultats.virement} »`);
  if (erreurs.length) throw new Error(erreurs.join(' ; '));
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
      cli, 'test', 'tests/budget_ecran_playwright.spec.js',
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
  const ids = seedDatabase();

  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['ignore', log, log] });
  server.on('exit', code => {
    if (code !== 0 && code !== null) console.error(`[serveur] arret inattendu (code ${code}) — journal : ${logPath}`);
  });

  try {
    await waitForHealth();
    await runPlaywright();
  } finally {
    await stopServer();
  }
  verifierBase(ids);
  console.log(`budget_ecran_isolated: OK — captures dans ${screenshotDir}`);
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

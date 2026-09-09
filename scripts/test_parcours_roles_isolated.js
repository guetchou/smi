'use strict';
/*
 * Chaque rôle ouvre ce que son menu lui propose — sans refus, sans erreur.
 *
 * La panne de septembre 2026 tenait en une phrase : l'écran proposait des
 * pages que l'API refusait. Dix profils sur quatorze étaient touchés, et
 * personne ne l'a vu pendant deux jours parce que le compte de direction
 * court-circuite les contrôles de module.
 *
 * Ce banc ne joue pas un métier : il joue la promesse que le menu fait. Pour
 * chaque profil, il ouvre tour à tour chaque entrée visible et refuse le
 * moindre 4xx ou la moindre exception de navigateur. C'est la mesure qui
 * aurait signalé la panne le jour où elle a été introduite, pour tous les
 * rôles à la fois.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3341);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-roles-'));
const dbPath = path.join(tempDir, 'smi-roles.db');
const screenshotDir = process.env.SMI_E2E_SCREENSHOT_DIR || path.join(tempDir, 'captures');
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

/* Les rôles mesurés : ceux que portent de vraies personnes, et ceux que la
   panne avait touchés. « admin » y figure comme témoin — son raccourci lui
   fait tout voir, donc il ne prouve rien seul, mais un échec chez lui
   signalerait une régression franche. */
/* La colonne users.role porte une contrainte qui n'admet que ces valeurs :
   un profil comme « achats_logistique » existe cote RBAC sans etre un role.
   On mesure donc le vocabulaire que le compte peut reellement porter. */
const PROFILS = [
  'assistante_direction',
  'caissier',
  'finance',
  'rh',
  'dg',
  'lecteur',
  'admin',
];

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
  // Le banc parcourt tous les ecrans de tous les roles : le plafond normal
  // repondrait 429 et masquerait les refus qu'on cherche.
  API_RATE_LIMIT: '100000',
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

const base64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signerHS256(charge, cle) {
  const tete = base64url({ alg: 'HS256', typ: 'JWT' });
  const maintenant = Math.floor(Date.now() / 1000);
  const corps = base64url({ ...charge, iat: maintenant, exp: maintenant + 3600 });
  const signature = crypto.createHmac('sha256', cle).update(`${tete}.${corps}`).digest('base64url');
  return `${tete}.${corps}.${signature}`;
}

function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');

  const comptes = [];
  for (const code of PROFILS) {
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(code);
    if (!profil) {
      console.log(`[socle] profil « ${code} » absent du socle — ignoré`);
      continue;
    }
    const email = `${code}.e2e@topcenter.cg`;
    const insere = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES (?,'E2E',?,?,?,?,?,1)
    `).run(code.toUpperCase(), email, email, admin.password_hash, code, JSON.stringify([code]));
    const userId = Number(insere.lastInsertRowid);
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(userId, profil.id);

    const modules = db.prepare(`
      SELECT DISTINCT p.module FROM user_profiles up
        JOIN profile_permissions pp ON pp.profile_id = up.profile_id
        JOIN permissions p ON p.id = pp.permission_id
       WHERE up.user_id = ? AND up.active = 1
    `).all(userId).map(r => r.module).sort();

    comptes.push({
      code,
      id: userId,
      email,
      modules,
      token: signerHS256({
        id: userId, email, role: code, roles: [code],
        nom: code.toUpperCase(), prenom: 'E2E', jti: `e2e-${code}`,
      }, env.JWT_SECRET),
    });
    console.log(`[socle] ${code} → #${userId} — modules : ${modules.join(', ') || 'aucun'}`);
  }
  db.close();

  if (comptes.length < 3) throw new Error('Trop peu de profils semés : la mesure ne vaudrait rien');
  env.SMI_E2E_COMPTES = JSON.stringify(comptes);
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
      cli, 'test', 'tests/parcours_roles_playwright.spec.js',
      '--project=chromium', '--reporter=line', '--retries=0', '--workers=1',
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
  server = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['ignore', log, log] });

  try {
    await waitForHealth();
    await runPlaywright();
    console.log(`parcours_roles_isolated: OK — captures dans ${screenshotDir}`);
  } finally {
    await stopServer();
  }
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

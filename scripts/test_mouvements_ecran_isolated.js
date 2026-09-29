'use strict';
/*
 * Ecran « Mouvements caisse/banque », rejoue sans personne — refonte du
 * 29/09/2026 d'apres la reference Pinterest « Finora – Transaction Dashboard UI ».
 *
 * Meme harnais que test_caisse_operation_isolated.js (serveur jetable, base
 * ephemere, session provisionnee), avec un journal seme a l'image de la
 * production : recettes en caisse, approvisionnements par virement depuis la
 * BCH (qui passe negative), deux decaissements, cinq anomalies ouvertes.
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
const port = Number(process.env.TEST_PORT || 3348);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-mouvements-'));
const dbPath = path.join(tempDir, 'smi-mouvements.db');
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
  /* Journal seme : memes montants et libelles que la production le 29/09/2026. */
  const ajouter = db.prepare(`
    INSERT INTO operations (date,num_piece,libelle,montant,type_op,position_id,position_source_id,categorie_id,
      mode_reglement,statut,treasury_status,accounting_status,budget_status,created_by)
    VALUES (?,?,?,?,?,?,?,?,'especes','valide','synced',?,'not_applicable',?)`);
  const caisse = db.prepare("SELECT id FROM positions WHERE code = 'CAISSE'").get().id;
  const bch = db.prepare("SELECT id FROM positions WHERE code = 'BCH'").get().id;
  const prestation = db.prepare("SELECT id FROM categories WHERE nom = 'Prestations de services'").get().id;
  const salaire = db.prepare("SELECT id FROM categories WHERE type = 'decaissement' ORDER BY id LIMIT 1").get().id;
  const journal = [
    ['2026-01-13', 'REC-2026-000001', 'Recette prestation', 1200000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-01-20', 'REC-2026-000013', 'appro caisse', 250000, 'virement', caisse, bch, null, 'not_applicable'],
    ['2026-01-20', 'REC-2026-000016', 'Recette prestation', 252000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-01-28', 'REC-2026-000018', 'Appro caisse', 1000000, 'virement', caisse, bch, null, 'not_applicable'],
    ['2026-01-30', 'REC-2026-000017', 'Recette prestation', 700000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-02-02', 'REC-2026-000019', 'Recette prestation', 2000000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-02-05', 'REC-2026-000020', 'retrait banque', 600000, 'virement', caisse, bch, null, 'not_applicable'],
    ['2026-02-05', 'REC-2026-000021', 'Recette prestation', 30000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-02-09', 'REC-2026-000022', 'Recette prestation', 750000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-02-13', 'REC-2026-000023', 'Recette prestation', 83000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-02-17', 'REC-2026-000024', 'Recette prestation', 1500000, 'encaissement', caisse, null, prestation, 'synced'],
    ['2026-02-20', 'DEC-2026-000002', 'Avance sur salaire — janvier', 150000, 'decaissement', caisse, null, salaire, 'synced'],
    ['2026-02-25', 'REC-2026-000025', 'Recette prestation', 500000, 'encaissement', caisse, null, prestation, 'pending'],
    ['2026-03-02', 'DEC-2026-000003', 'Carburant groupe électrogène', 85000, 'decaissement', caisse, null, salaire, 'error'],
    ['2026-03-04', 'REC-2026-000026', 'Recette prestation', 3500000, 'encaissement', caisse, null, prestation, 'pending'],
  ];
  for (const [date, piece, libelle, montant, type, pos, src, cat, compta] of journal) {
    ajouter.run(date, piece, libelle, montant, type, pos, src, cat, compta, admin.id || 1);
  }
  const anomalie = db.prepare(`INSERT INTO sync_errors (source_module,source_record_id,error_type,error_message,status)
    VALUES ('operations',?,'accounting','Écriture comptable générée en brouillon et en attente de validation','open')`);
  for (const id of db.prepare("SELECT id FROM operations WHERE accounting_status = 'pending' ORDER BY id DESC LIMIT 5").all().map(o => o.id)) anomalie.run(id);
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
      cli, 'test', 'tests/mouvements_ecran_playwright.spec.js',
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
    console.log(`mouvements_ecran_isolated: OK — captures dans ${screenshotDir}`);
  } finally {
    await stopServer();
  }
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

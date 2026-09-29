'use strict';
/*
 * Banc isolé — écrans de comptabilité générale C1 à C3 (ADR 0002).
 *
 * Un serveur Tala SMI réel sur une base SQLite jetable, relié à un faux
 * Dolibarr (serveur HTTP local) qui sert les points d'API du module « smi »
 * avec les écritures du bac à sable du 29/09/2026. Playwright ouvre les écrans
 * à 1366×768 et laisse une capture de chacun.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3363);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-compta-'));
const dbPath = path.join(tempDir, 'smi-compta.db');
const screenshotDir = process.env.SMI_E2E_SCREENSHOT_DIR || path.join(tempDir, 'captures');
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;
const CLE = crypto.randomBytes(16).toString('hex');

const systemChrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find(candidate => fs.existsSync(candidate));

const L = (date, journal, piece, reference, compte, libelle_compte, libelle, debit, credit) =>
  ({ date, journal, piece, origine: journal === 'OD' ? 'smi' : 'bank', reference, compte, libelle_compte, libelle, tiers: '', debit, credit });
const LIGNES = [
  L('2026-01-13', 'VT', 1, 'IN2601-0001', '411', 'Clients', 'Client comptant', 1200000, 0),
  L('2026-01-13', 'VT', 1, 'IN2601-0001', '706', 'Services vendus', 'Services vendus', 0, 1200000),
  L('2026-01-13', 'BQ', 2, 'Paiement client', '5711', 'Caisse principale', 'Paiement client', 1200000, 0),
  L('2026-01-13', 'BQ', 2, 'Paiement client', '411', 'Clients', 'Paiement client', 0, 1200000),
  L('2026-01-13', 'BQ', 3, 'Ligne sans piece', '5711', 'Caisse principale', 'Ligne sans piece', 1200000, 0),
  L('2026-01-13', 'BQ', 3, 'Ligne sans piece', '471', 'Comptes d attente', 'Ligne sans piece', 0, 1200000),
  L('2026-02-05', 'BQ', 4, 'Retrait banque', '585', 'Virements de fonds', 'Retrait banque', 600000, 0),
  L('2026-02-05', 'BQ', 4, 'Retrait banque', '5211', 'Banque BCH', 'Retrait banque', 0, 600000),
  L('2026-02-05', 'BQ', 5, 'Retrait banque', '5711', 'Caisse principale', 'Retrait banque', 600000, 0),
  L('2026-02-05', 'BQ', 5, 'Retrait banque', '585', 'Virements de fonds', 'Retrait banque', 0, 600000),
  L('2026-02-10', 'AC', 6, 'SI2602-0001', '6053', 'Autres energies', 'Carburant', 50000, 0),
  L('2026-02-10', 'AC', 6, 'SI2602-0001', '401', 'Fournisseurs', 'Fournisseur', 0, 50000),
  L('2026-02-10', 'BQ', 7, 'Paiement fournisseur', '401', 'Fournisseurs', 'Paiement fournisseur', 50000, 0),
  L('2026-02-10', 'BQ', 7, 'Paiement fournisseur', '5711', 'Caisse principale', 'Paiement fournisseur', 0, 50000),
  L('2026-03-31', 'OD', 8, 'SMI-PAIE-2026-03', '6611', 'Appointements, salaires', 'Salaires bruts mars', 180000, 0),
  L('2026-03-31', 'OD', 8, 'SMI-PAIE-2026-03', '6641', 'Charges sociales', 'CNSS part patronale mars', 25000, 0),
  L('2026-03-31', 'OD', 8, 'SMI-PAIE-2026-03', '422', 'Personnel, remunerations dues', 'Net a payer mars', 0, 150000),
  L('2026-03-31', 'OD', 8, 'SMI-PAIE-2026-03', '431', 'Securite sociale', 'CNSS mars', 0, 37000),
  L('2026-03-31', 'OD', 8, 'SMI-PAIE-2026-03', '447', 'Etat, impots retenus', 'IRPP retenu mars', 0, 18000),
];

let fauxDolibarr;
function demarrerFauxDolibarr() {
  fauxDolibarr = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const envoyer = (code, corps) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corps)); };
    if (req.headers.dolapikey !== CLE) return envoyer(401, { error: { code: 401, message: 'Unauthorized' } });
    if (url.pathname.endsWith('/smi/etat')) return envoyer(200, { horodatage: new Date(Date.now() - 2 * 60000).toISOString(), statut: 'ok', ecritures_ajoutees: 4, en_retard: false });
    if (url.pathname.endsWith('/smi/exercices')) return envoyer(200, [{ libelle: '2026', debut: '2026-01-01', fin: '2026-12-31' }]);
    // Écriture d'une pièce (C4) : ajoutée au grand livre, une seule fois.
    if (url.pathname.endsWith('/smi/pieces') && req.method === 'POST') {
      let corps = '';
      req.on('data', d => { corps += d; });
      req.on('end', () => {
        const piece = JSON.parse(corps);
        const deja = LIGNES.some(l => l.reference === piece.reference);
        if (!deja) {
          const num = Math.max(...LIGNES.map(l => l.piece)) + 1;
          for (const l of piece.lignes) LIGNES.push(L(piece.date, piece.journal, num, piece.reference, l.compte, l.compte, l.libelle, l.debit || 0, l.credit || 0));
        }
        envoyer(200, { statut: deja ? 'deja_ecrite' : 'ecrite', piece_num: 99, lignes: piece.lignes.length });
      });
      return undefined;
    }
    if (url.pathname.endsWith('/smi/grandlivre')) {
      const q = url.searchParams;
      const lignes = LIGNES.filter(l => l.date >= q.get('date_debut') && l.date <= q.get('date_fin')
        && (!q.get('journal') || l.journal === q.get('journal')) && (!q.get('compte') || l.compte.startsWith(q.get('compte'))));
      return envoyer(200, { lignes, total_debit: lignes.reduce((s, l) => s + l.debit, 0), total_credit: lignes.reduce((s, l) => s + l.credit, 0) });
    }
    return envoyer(404, { error: { code: 404, message: 'Not found' } });
  });
  return new Promise(r => fauxDolibarr.listen(0, '127.0.0.1', r));
}

const env = {
  ...process.env, NODE_ENV: 'test', PORT: String(port), JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_DRIVER: 'sqlite', DB_PATH: dbPath, SMI_E2E_BASE_URL: baseURL, SMI_E2E_SCREENSHOT_DIR: screenshotDir,
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
    VALUES ('COMPTA','E2E','compta.e2e@topcenter.cg','compta.e2e',?,'finance','["finance"]',1)
  `).run(admin.password_hash).lastInsertRowid);
  for (const code of ['caissier', 'finance']) {
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(code);
    if (profil) db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')").run(userId, profil.id);
  }
  // Paie d'août de l'année en cours, validée par la direction : une pièce à écrire.
  const annee = new Date().getFullYear();
  const periodeId = Number(db.prepare("INSERT INTO periodes_paie (annee, mois, statut) VALUES (?, 8, 'cloturee')").run(annee).lastInsertRowid);
  const [e1, e2] = db.prepare('SELECT id FROM employes ORDER BY id LIMIT 2').all();
  const bulletin = db.prepare(`INSERT INTO bulletins_salaire (employe_id, mois, annee, periode_id, brut, cnss_employe, camu_employe, irpp, net_a_payer, retenue_avance, cnss_patronal, camu_patronal, statut)
    VALUES (?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valide')`);
  bulletin.run(e1.id, annee, periodeId, 180000, 7200, 1800, 18000, 153000, 20000, 25000, 3000);
  bulletin.run(e2.id, annee, periodeId, 100000, 4000, 0, 6000, 90000, 0, 14000, 0);
  db.close();
  const base64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tete = base64url({ alg: 'HS256', typ: 'JWT' });
  const corps = base64url({ id: userId, email: 'compta.e2e@topcenter.cg', role: 'finance', roles: ['finance'], nom: 'COMPTA', prenom: 'E2E', jti: 'e2e-compta',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  env.SMI_E2E_TOKEN = `${tete}.${corps}.${crypto.createHmac('sha256', env.JWT_SECRET).update(`${tete}.${corps}`).digest('base64url')}`;
  env.SMI_E2E_USER_ID = String(userId);
}

async function waitForHealth() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try { if ((await fetch(`${baseURL}/api/health`)).ok) return; } catch (_) {}
    await sleep(250);
  }
  throw new Error(`Serveur E2E non disponible sur ${baseURL}`);
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const cli = require.resolve('@playwright/test/cli');
    const child = spawn(process.execPath, [cli, 'test', 'tests/comptabilite_ecran_playwright.spec.js', '--project=chromium', '--reporter=line', '--retries=0'],
      { cwd: root, env, stdio: 'inherit' });
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
  await demarrerFauxDolibarr();
  env.DOLIBARR_URL = `http://127.0.0.1:${fauxDolibarr.address().port}`;
  env.DOLIBARR_API_KEY = CLE;
  seedDatabase();
  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, ['backend/server.js'], { cwd: root, env, stdio: ['ignore', log, log] });
  try {
    await waitForHealth();
    await runPlaywright();
  } finally {
    await stopServer();
    fauxDolibarr.close();
  }
  console.log(`comptabilite_ecran_isolated: OK — captures dans ${screenshotDir}`);
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
  try { fauxDolibarr && fauxDolibarr.close(); } catch (_) {}
});

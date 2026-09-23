'use strict';
/*
 * Un montant rendu par l'API est un nombre, pas une chaîne.
 *
 * Le pool `mysql2` du serveur ne réglait pas `decimalNumbers`. Toute colonne
 * `decimal(15,2)` — et toute `SUM()` sur une telle colonne — revenait donc en
 * CHAÎNE, et `+` concaténait au lieu d'additionner.
 *
 * Ce n'est pas une élégance de typage : le 23/09/2026, `'0.00'` + `'7000.00'` a
 * donné `'0.007000.00'`, que MySQL a refusé d'écrire dans une colonne décimale.
 * En mode strict — celui de la production — la clôture de caisse ne pouvait rien
 * enregistrer. Le même piège a menacé les tuiles de montants du tableau de bord
 * le même jour, ailleurs et sans rapport.
 *
 * Pourquoi ce banc était nécessaire alors que cinq autres existaient : la façade
 * `backend/mysql_sync_runner.js`, par laquelle passe le SEMIS des bancs, règle
 * `decimalNumbers: true`. Un banc qui n'interrogerait que par elle ne verrait
 * jamais le défaut. Celui-ci lit par des appels HTTP réels, qui traversent le
 * pool du serveur — le seul chemin où le défaut se manifeste.
 *
 * L'assertion centrale ne décrit pas le défaut, elle le rejoue : additionner
 * deux montants lus dans l'API doit donner une somme.
 *
 * Même forme que scripts/test_seuils_approbation_isolated.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { provisionner, supprimer } = require('./lib/socle_mysql');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3351);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-decimaux-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_decimaux_banc';
const connexion = {
  base: BASE,
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'root',
};

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  API_RATE_LIMIT: '100000',
};

/* Des valeurs à décimales non nulles : une concaténation est alors visible à
   l'œil nu dans le message d'échec, et un arrondi malheureux aussi. */
const SOLDE_INITIAL = 7000.5;
const MONTANT = 1234.56;

let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let jeton = null;
const ids = {};

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
  const corps = base64url({
    ...charge,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto.createHmac('sha256', cle).update(`${tete}.${corps}`).digest('base64url');
  return `${tete}.${corps}.${signature}`;
}

function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');

  const r = db.prepare(`
    INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
    VALUES ('E2E_DEC','Caisse des décimaux','caisse',?,1,96)
  `).run(SOLDE_INITIAL);
  ids.position = Number(r.lastInsertRowid);

  const email = 'finance.decimaux@topcenter.cg';
  const u = db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('DECIMAUX','FINANCE',?,?,?,'finance',?,1)
  `).run(email, 'finance.decimaux', admin.password_hash, JSON.stringify(['finance']));
  ids.user = Number(u.lastInsertRowid);
  const profil = db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
  if (profil) {
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(ids.user, profil.id);
  }
  jeton = signerHS256(
    { id: ids.user, email, role: 'finance', roles: ['finance'], nom: 'DECIMAUX', prenom: 'FINANCE', jti: 'e2e-decimaux' },
    env.JWT_SECRET,
  );

  ids.date = new Date().toISOString().slice(0, 10);
  const op = db.prepare(`
    INSERT INTO operations (date,libelle,montant,type_op,position_id,statut,created_by)
    VALUES (?,'Encaissement à décimales',?, 'encaissement',?,'valide',?)
  `).run(ids.date, MONTANT, ids.position, admin.id);
  ids.operation = Number(op.lastInsertRowid);

  db.close();
  console.log(
    `[socle] caisse ${ids.position} (solde initial ${SOLDE_INITIAL}) · `
    + `opération ${ids.operation} (montant ${MONTANT})`,
  );
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

async function lire(chemin) {
  const response = await fetch(`${baseURL}${chemin}`, {
    headers: { Authorization: `Bearer ${jeton}` },
  });
  if (!response.ok) throw new Error(`GET ${chemin} : HTTP ${response.status}`);
  return response.json();
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

function typeEtValeur(etiquette, valeur) {
  return `${etiquette} = ${JSON.stringify(valeur)} (${typeof valeur})`;
}

async function mesurer() {
  /* Un montant issu de la table des opérations, rendu tel quel par la liste. */
  const liste = await lire('/api/operations?limit=500');
  const lignes = Array.isArray(liste)
    ? liste
    : (liste?.rows ?? liste?.operations ?? liste?.items ?? []);
  const ligne = lignes.find(o => Number(o.id) === ids.operation);
  if (!ligne) throw new Error("L'opération semée doit figurer dans la liste — sinon rien n'est comparable");
  const montant = ligne.montant;
  console.log(`[mesure] ${typeEtValeur('montant', montant)}`);

  /* Un solde initial issu de la table des positions, rendu tel quel. */
  const positions = await lire('/api/operations/positions');
  const position = (Array.isArray(positions) ? positions : []).find(p => Number(p.id) === ids.position);
  if (!position) throw new Error('La caisse semée doit figurer dans les positions');
  const soldeInitial = position.solde_initial;
  console.log(`[mesure] ${typeEtValeur('solde_initial', soldeInitial)}`);

  verifier(
    typeof montant === 'number',
    `un montant rendu par l'API doit être un nombre — ${typeEtValeur('montant', montant)}`,
  );
  verifier(
    typeof soldeInitial === 'number',
    `un solde rendu par l'API doit être un nombre — ${typeEtValeur('solde_initial', soldeInitial)}`,
  );

  verifier(
    Math.abs(Number(montant) - MONTANT) < 0.001,
    `la valeur doit traverser sans perte : attendu ${MONTANT}, lu ${montant}`,
  );

  /* L'assertion qui rejoue le défaut au lieu de le décrire. Sur deux chaînes,
     « + » concatène : la somme de 1234.56 et 7000.5 vaudrait « 1234.567000.5 ». */
  const somme = montant + soldeInitial;
  console.log(`[mesure] ${typeEtValeur('montant + solde_initial', somme)}`);
  verifier(
    typeof somme === 'number' && Math.abs(somme - (MONTANT + SOLDE_INITIAL)) < 0.001,
    `additionner deux montants de l'API doit donner une somme, pas une concaténation : `
    + `attendu ${MONTANT + SOLDE_INITIAL}, obtenu ${JSON.stringify(somme)}`,
  );
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function main() {
  await assertPortFree();
  Object.assign(env, (await provisionner(connexion)).env);
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
    await mesurer();
  } finally {
    await stopServer();
    await supprimer(connexion);
  }
  if (echecs.length) {
    for (const echec of echecs) console.error(`  ✗ ${echec}`);
    throw new Error(`decimaux_frontiere_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('decimaux_frontiere_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

'use strict';
/*
 * Le rapprochement et le reste de l'application doivent compter le même solde.
 *
 * Constat C13 de l'audit des flux. `calcSoldeSysteme` et
 * `calcSoldeLogicielCaisse` additionnaient :
 *
 *     SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE -montant END)
 *     WHERE position_id = ?
 *
 * Deux erreurs dans une seule ligne :
 *
 *   1. un VIREMENT ENTRANT est compté en négatif — sa destination reçoit
 *      l'argent, le calcul le retire ;
 *   2. un VIREMENT SORTANT est absent de la somme — la caisse quittée figure
 *      dans `position_source_id`, que le WHERE ne regarde pas.
 *
 * La convention juste existait déjà dans `getSoldePosition`, côté opérations.
 * Il y avait donc trois copies d'une même règle, dont deux fausses.
 *
 * Ce banc ne compare pas à un nombre choisi par moi : il exige que les DEUX
 * calculs de la même quantité s'accordent — le solde de clôture rendu par le
 * rapprochement, et le solde que l'application affiche pour la même caisse.
 * C'est l'objectif « une seule source de vérité » exprimé comme une garde.
 * La valeur arithmétique est vérifiée en plus, pour qu'une panne qui fausserait
 * les deux calculs de la même façon ne passe pas.
 *
 * Même forme que scripts/test_perimetre_caisse_isolated.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { provisionner, supprimer } = require('./lib/socle_mysql');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3348);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-rapproch-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_rapproch_banc';
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

/* Les trois mouvements semés sur la caisse A, et le solde qu'ils impliquent.
   Un encaissement entre, un virement arrive de B, un virement part vers B. */
const ENCAISSEMENT = 10000;
const VIREMENT_ENTRANT = 3000;
const VIREMENT_SORTANT = 1000;
const SOLDE_ATTENDU = ENCAISSEMENT + VIREMENT_ENTRANT - VIREMENT_SORTANT;

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

  /* La clôture exige type='caisse' : les deux positions en sont. */
  const creerCaisse = (code, libelle) => {
    const r = db.prepare(`
      INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
      VALUES (?,?,'caisse',0,1,98)
    `).run(code, libelle);
    return Number(r.lastInsertRowid);
  };
  ids.caisseA = creerCaisse('E2E_RAP_A', 'Caisse rapprochée');
  ids.caisseB = creerCaisse('E2E_RAP_B', 'Caisse de contrepartie');

  /* Compte « finance » : non restreint par le périmètre caisse, pour que ce banc
     mesure le calcul du solde et non un filtrage d'accès. */
  const email = 'finance.rapproch@topcenter.cg';
  const r = db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('RAPPROCH','FINANCE',?,?,?,'finance',?,1)
  `).run(email, 'finance.rapproch', admin.password_hash, JSON.stringify(['finance']));
  ids.user = Number(r.lastInsertRowid);
  const profil = db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
  if (profil) {
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(ids.user, profil.id);
  }
  jeton = signerHS256(
    { id: ids.user, email, role: 'finance', roles: ['finance'], nom: 'RAPPROCH', prenom: 'FINANCE', jti: 'e2e-rapproch' },
    env.JWT_SECRET,
  );

  ids.date = new Date().toISOString().slice(0, 10);
  const creerOp = (libelle, montant, typeOp, positionId, sourceId) => {
    const ins = db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,position_source_id,statut,created_by)
      VALUES (?,?,?,?,?,?,'valide',?)
    `).run(ids.date, libelle, montant, typeOp, positionId, sourceId || null, admin.id);
    return Number(ins.lastInsertRowid);
  };

  creerOp('Encaissement sur A', ENCAISSEMENT, 'encaissement', ids.caisseA, null);
  creerOp('Virement B vers A', VIREMENT_ENTRANT, 'virement', ids.caisseA, ids.caisseB);
  creerOp('Virement A vers B', VIREMENT_SORTANT, 'virement', ids.caisseB, ids.caisseA);

  db.close();
  console.log(
    `[socle] caisse A=${ids.caisseA} B=${ids.caisseB} — ${ENCAISSEMENT} encaissé, `
    + `${VIREMENT_ENTRANT} reçu de B, ${VIREMENT_SORTANT} envoyé vers B → solde attendu ${SOLDE_ATTENDU}`,
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

async function appel(chemin, options = {}) {
  const response = await fetch(`${baseURL}${chemin}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${jeton}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let corps = null;
  try { corps = await response.json(); } catch (_) { corps = null; }
  return { statut: response.status, corps };
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

async function mesurer() {
  /* 1. Le solde que l'application affiche pour la caisse A. */
  const positions = await appel('/api/operations/positions');
  if (positions.statut !== 200) throw new Error(`GET /operations/positions : HTTP ${positions.statut}`);
  const caisseA = (Array.isArray(positions.corps) ? positions.corps : [])
    .find(p => Number(p.id) === ids.caisseA);
  if (!caisseA) throw new Error('La caisse A doit figurer dans les positions — sinon rien n\'est comparable');
  const soldeApplication = Number(caisseA.solde);
  console.log(`[mesure] solde affiché par l'application : ${soldeApplication}`);

  /* Prémisse : l'application, elle, doit déjà compter juste. Si elle se trompe
     aussi, la comparaison qui suit ne dirait pas laquelle des deux a tort. */
  verifier(
    soldeApplication === SOLDE_ATTENDU,
    `le solde affiché par l'application doit valoir ${SOLDE_ATTENDU}, lu ${soldeApplication} `
    + '— la prémisse de ce banc est que getSoldePosition compte juste',
  );

  /* 2. Le solde que le rapprochement calcule pour la même caisse, à la même date. */
  const cloture = await appel('/api/rapprochements/caisse/cloture', {
    method: 'POST',
    body: JSON.stringify({
      position_id: ids.caisseA,
      date_cloture: ids.date,
      solde_physique_declare: SOLDE_ATTENDU,
      notes: 'Clôture jouée par le banc',
    }),
  });
  if (cloture.statut !== 201) {
    throw new Error(
      `POST /rapprochements/caisse/cloture : HTTP ${cloture.statut} — ${cloture.corps?.error || ''}`,
    );
  }
  const soldeRapprochement = Number(cloture.corps.solde_logiciel_cloture);
  const ecart = Number(cloture.corps.ecart);
  console.log(`[mesure] solde calculé par le rapprochement : ${soldeRapprochement} (écart annoncé ${ecart})`);

  /* 3. La règle : deux calculs de la même quantité doivent s'accorder. */
  verifier(
    soldeRapprochement === soldeApplication,
    `le rapprochement et l'application doivent compter le même solde pour la même caisse : `
    + `rapprochement ${soldeRapprochement}, application ${soldeApplication}`,
  );
  verifier(
    soldeRapprochement === SOLDE_ATTENDU,
    `le solde de clôture doit valoir ${SOLDE_ATTENDU} : ${ENCAISSEMENT} encaissé `
    + `+ ${VIREMENT_ENTRANT} reçu − ${VIREMENT_SORTANT} envoyé. Lu ${soldeRapprochement}`,
  );

  /* 4. Et l'écart annoncé au caissier doit être nul, puisque le physique déclaré
        est le solde réel. Un écart non nul ici accuserait la caisse à tort. */
  verifier(
    Math.abs(ecart) < 0.01,
    `l'écart doit être nul quand le physique déclaré est le solde réel, annoncé ${ecart} `
    + '— un faux écart accuse la caisse d\'un manquant qui n\'existe pas',
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
    throw new Error(`rapprochement_virement_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('rapprochement_virement_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

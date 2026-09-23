'use strict';
/*
 * Un caissier ne voit et n'utilise que les caisses qui lui sont affectées.
 *
 * Constat C14 de l'audit des flux : `user_cashboxes` existait sans qu'aucune
 * route ne la lise. Le correctif applique le périmètre côté serveur.
 *
 * Ce banc ne lit pas la source. Il sème deux caisses, trois opérations et trois
 * comptes, puis interroge l'API et compare ce qui revient. Il mesure donc la
 * règle et non l'écriture : renommer un helper ou reformuler le SQL doit le
 * laisser vert, inverser une visibilité doit le faire rougir.
 *
 * Les trois cas qui comptent, et le troisième est celui qu'aucune lecture de
 * source ne prouve :
 *
 *   1. le caissier affecté à A voit A et ne voit pas B ;
 *   2. un caissier sans aucune affectation ne voit RIEN — la direction sûre
 *      pour un contrôle d'accès est de fermer, pas d'ouvrir ;
 *   3. un VIREMENT dont la destination est A mais la source est B reste
 *      invisible au caissier de A. Une opération porte deux caisses ; ne
 *      filtrer que `position_id` laisserait fuiter le mouvement de B.
 *
 * Et `finance` n'est pas restreint : sans ce témoin, un filtre qui masquerait
 * tout à tout le monde passerait pour un succès.
 *
 * Même forme que scripts/test_alertes_destinataire_isolated.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { provisionner, supprimer } = require('./lib/socle_mysql');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3346);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-perimetre-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_perimetre_banc';
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

let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const jetons = {};
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

  /* Deux caisses distinctes du socle, pour que « affectée » et « non affectée »
     soient deux choses observables. */
  const creerPosition = (code, libelle) => {
    const r = db.prepare(`
      INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
      VALUES (?,?,'caisse',0,1,99)
    `).run(code, libelle);
    return Number(r.lastInsertRowid);
  };
  ids.caisseA = creerPosition('E2E_PERIM_A', 'Caisse affectée');
  ids.caisseB = creerPosition('E2E_PERIM_B', 'Caisse non affectée');

  const creerCompte = (prenom, role) => {
    const email = `${role}.${prenom.toLowerCase()}@topcenter.cg`;
    const r = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES ('PERIMETRE',?,?,?,?,?,?,1)
    `).run(prenom, email, `${role}.${prenom.toLowerCase()}`, admin.password_hash, role, JSON.stringify([role]));
    const id = Number(r.lastInsertRowid);
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(role);
    if (profil) {
      db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
        .run(id, profil.id);
    }
    jetons[prenom] = signerHS256(
      { id, email, role, roles: [role], nom: 'PERIMETRE', prenom, jti: `e2e-perim-${prenom}` },
      env.JWT_SECRET,
    );
    return id;
  };

  ids.userAffecte = creerCompte('AFFECTE', 'caissier');
  ids.userSansCaisse = creerCompte('SANSCAISSE', 'caissier');
  ids.userFinance = creerCompte('FINANCE', 'finance');

  /* Une seule affectation, en lecture et en écriture, sur la caisse A. */
  db.prepare(`
    INSERT INTO user_cashboxes (user_id,caisse_id,can_read,can_write,affecte_par)
    VALUES (?,?,1,1,?)
  `).run(ids.userAffecte, ids.caisseA, admin.id);

  /* La saisie exige une rubrique comptable. On la prend dans le socle et on
     l'affirme : sans elle, l'écriture échouerait en 400 et le banc croirait
     mesurer un refus de périmètre là où il ne mesure qu'une validation. */
  const rubrique = db.prepare(
    "SELECT id FROM categories WHERE type IN ('recette','encaissement') LIMIT 1",
  ).get();
  if (!rubrique) throw new Error('Le socle doit contenir au moins une rubrique de recette');
  ids.categorie = Number(rubrique.id);

  const aujourdhui = new Date().toISOString().slice(0, 10);
  const creerOp = (libelle, positionId, sourceId) => {
    const r = db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,position_source_id,statut,created_by)
      VALUES (?,?,1000,?,?,?,'valide',?)
    `).run(aujourdhui, libelle, sourceId ? 'virement' : 'encaissement', positionId, sourceId || null, admin.id);
    return Number(r.lastInsertRowid);
  };
  ids.opA = creerOp('Encaissement caisse A', ids.caisseA, null);
  ids.opB = creerOp('Encaissement caisse B', ids.caisseB, null);
  ids.opVirement = creerOp('Virement B vers A', ids.caisseA, ids.caisseB);

  db.close();
  console.log(
    `[socle] caisses A=${ids.caisseA} B=${ids.caisseB} · opérations A=${ids.opA} B=${ids.opB} `
    + `virement=${ids.opVirement}`,
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

async function appel(compte, chemin, options = {}) {
  const response = await fetch(`${baseURL}${chemin}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${jetons[compte]}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let corps = null;
  try { corps = await response.json(); } catch (_) { corps = null; }
  return { statut: response.status, corps };
}

/* La réponse de la liste a plusieurs formes selon les versions ; on la normalise
   ici et le témoin « finance » ci-dessous vérifie que la normalisation marche. */
function liste(corps) {
  if (Array.isArray(corps)) return corps;
  return corps?.operations ?? corps?.items ?? corps?.rows ?? [];
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

async function mesurer() {
  const vues = {};
  for (const compte of ['AFFECTE', 'SANSCAISSE', 'FINANCE']) {
    const { statut, corps } = await appel(compte, '/api/operations?limit=500');
    if (statut !== 200) throw new Error(`GET /operations en ${compte} : HTTP ${statut}`);
    const identifiants = liste(corps).map(o => Number(o.id));
    vues[compte] = identifiants;
    console.log(`[mesure] ${compte} voit ${identifiants.length} opération(s)`);
  }

  /* Témoin : sans lui, un filtre qui masque tout à tout le monde passerait pour
     un succès, et la normalisation de la réponse ne serait pas vérifiée. */
  verifier(
    vues.FINANCE.includes(ids.opA) && vues.FINANCE.includes(ids.opB) && vues.FINANCE.includes(ids.opVirement),
    'finance n\'est pas restreint : il doit voir les trois opérations semées '
    + `(vu : ${vues.FINANCE.length})`,
  );

  verifier(vues.AFFECTE.includes(ids.opA), 'le caissier affecté doit voir l\'opération de sa caisse');
  verifier(
    !vues.AFFECTE.includes(ids.opB),
    'le caissier affecté ne doit pas voir l\'opération d\'une caisse qui ne lui est pas affectée',
  );
  verifier(
    !vues.AFFECTE.includes(ids.opVirement),
    'un virement dont la SOURCE est une caisse non affectée doit rester invisible : '
    + 'une opération porte deux caisses, filtrer position_id seul laisse fuiter la source',
  );
  verifier(
    vues.SANSCAISSE.length === 0,
    'un caissier sans aucune affectation ne doit rien voir : un contrôle d\'accès se ferme par défaut '
    + `(vu : ${vues.SANSCAISSE.length})`,
  );

  /* Les positions proposées à l'écran suivent la même règle : proposer une caisse
     que l'API refuse ensuite est la panne de septembre 2026. */
  const positions = {};
  for (const compte of ['AFFECTE', 'SANSCAISSE', 'FINANCE']) {
    const { statut, corps } = await appel(compte, '/api/operations/positions');
    if (statut !== 200) throw new Error(`GET /operations/positions en ${compte} : HTTP ${statut}`);
    positions[compte] = (Array.isArray(corps) ? corps : []).map(p => Number(p.id));
  }
  console.log(`[mesure] positions — AFFECTE=${positions.AFFECTE.length} SANSCAISSE=${positions.SANSCAISSE.length} FINANCE=${positions.FINANCE.length}`);

  verifier(
    positions.FINANCE.includes(ids.caisseA) && positions.FINANCE.includes(ids.caisseB),
    'finance doit voir les deux caisses',
  );
  verifier(
    positions.AFFECTE.includes(ids.caisseA) && !positions.AFFECTE.includes(ids.caisseB),
    'le caissier affecté ne doit voir que sa caisse dans la liste des positions',
  );
  verifier(
    positions.SANSCAISSE.length === 0,
    'un caissier sans affectation ne doit voir aucune position',
  );

  /* L'écriture suit la lecture : la caisse non affectée est refusée, la caisse
     affectée est acceptée. Le second appel est indispensable — un refus
     systématique passerait sinon pour un succès. */
  const refus = await appel('AFFECTE', '/api/operations', {
    method: 'POST',
    body: JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      libelle: 'Tentative sur caisse non affectée',
      montant: 500,
      type_op: 'encaissement',
      position_id: ids.caisseB,
      categorie_id: ids.categorie,
      tiers: 'Banc',
    }),
  });
  console.log(`[mesure] écriture sur caisse non affectée → HTTP ${refus.statut}`);
  verifier(refus.statut === 403, `écrire sur une caisse non affectée doit être refusé (403), reçu ${refus.statut}`);

  const accepte = await appel('AFFECTE', '/api/operations', {
    method: 'POST',
    body: JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      libelle: 'Saisie sur caisse affectée',
      montant: 500,
      type_op: 'encaissement',
      position_id: ids.caisseA,
      categorie_id: ids.categorie,
      tiers: 'Banc',
    }),
  });
  console.log(`[mesure] écriture sur caisse affectée → HTTP ${accepte.statut}`);
  verifier(
    accepte.statut >= 200 && accepte.statut < 300,
    'écrire sur sa propre caisse doit rester possible, sinon le périmètre bloque le métier '
    + `(reçu ${accepte.statut}${accepte.corps?.error ? ' — ' + accepte.corps.error : ''})`,
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
    throw new Error(`perimetre_caisse_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('perimetre_caisse_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

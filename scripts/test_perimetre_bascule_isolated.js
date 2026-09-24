'use strict';
/*
 * Un rôle qui n'est pas global est soumis aux caisses affectées — sur tous les
 * chemins financiers, y compris la file de décaissement et l'import.
 *
 * Décision produit du 23/09/2026 : seuls `admin`, `dg` et `finance` échappent au
 * périmètre. La liste est fermée, donc `assistante_direction` — qui voyait
 * jusque-là toutes les caisses par la retombée implicite — y est désormais
 * soumise, comme le sera tout rôle créé demain.
 *
 * Ce banc mesure ce basculement sur un rôle qui n'était PAS restreint avant. Le
 * banc `test_perimetre_caisse_isolated.js` continue de couvrir le cas `caissier`,
 * qui l'était déjà : les deux ne mesurent pas la même chose.
 *
 * Le compte mesuré porte une affectation, et c'est délibéré. Un compte sans
 * aucune affectation ne voit rien partout, ce qui rend toutes les assertions
 * vraies pour une mauvaise raison. En lui donnant UNE caisse, chaque assertion
 * doit distinguer ce qu'il voit de ce qu'il ne voit pas — et le témoin global
 * montre ce qui existe réellement.
 *
 * Chemins couverts : lecture, écriture, virement par la source, file de
 * décaissement, import de classeur.
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
const XLSX = require(path.join(root, 'backend', 'node_modules', 'xlsx'));

const port = Number(process.env.TEST_PORT || 3352);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-bascule-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_bascule_banc';
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

  const creerCaisse = (code, libelle) => {
    const r = db.prepare(`
      INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
      VALUES (?,?,'caisse',100000,1,95)
    `).run(code, libelle);
    return Number(r.lastInsertRowid);
  };
  ids.caisseA = creerCaisse('E2E_BAS_A', 'Caisse affectee');
  ids.caisseB = creerCaisse('E2E_BAS_B', 'Caisse non affectee');

  /*
   * Le compte mesuré : rôle `assistante_direction`, qui n'est PAS global, avec le
   * profil `finance` pour le module. C'est le modèle même de la décision — la
   * permission fonctionnelle vient du profil, le périmètre vient du rôle. Porter
   * le profil finance ne rend pas global : seul le RÔLE compte pour le périmètre.
   */
  const creerCompte = (prenom, role, profilCode) => {
    const email = `${prenom.toLowerCase()}.bascule@topcenter.cg`;
    const r = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES ('BASCULE',?,?,?,?,?,?,1)
    `).run(prenom, email, `${prenom.toLowerCase()}.bascule`, admin.password_hash, role, JSON.stringify([role]));
    const id = Number(r.lastInsertRowid);
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(profilCode);
    if (!profil) throw new Error(`Le socle doit contenir le profil « ${profilCode} »`);
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(id, profil.id);
    jetons[prenom] = signerHS256(
      { id, email, role, roles: [role], nom: 'BASCULE', prenom, jti: `e2e-bascule-${prenom}` },
      env.JWT_SECRET,
    );
    return id;
  };

  ids.assistante = creerCompte('ASSISTANTE', 'assistante_direction', 'finance');
  ids.finance = creerCompte('FINANCE', 'finance', 'finance');
  /* Les écritures et l'import exigent ENC_CREATE_ROLES — admin, caissier,
     finance, dg. Le seul de ces rôles qui ne soit PAS global est « caissier » :
     c'est donc le seul compte avec lequel on puisse mesurer un refus de
     PÉRIMÈTRE sur ces chemins. Mesurer l'assistante y mesurerait un refus de
     rôle en croyant mesurer un périmètre. */
  ids.caissiere = creerCompte('CAISSIERE', 'caissier', 'caissier');

  /* UNE seule caisse affectée : c'est ce qui rend chaque assertion discriminante. */
  const affecter = utilisateur => db.prepare(`
    INSERT INTO user_cashboxes (user_id,caisse_id,can_read,can_write,affecte_par)
    VALUES (?,?,1,1,?)
  `).run(utilisateur, ids.caisseA, admin.id);
  affecter(ids.assistante);
  affecter(ids.caissiere);

  const rubrique = db.prepare(
    "SELECT id, nom FROM categories WHERE type IN ('recette','encaissement') LIMIT 1",
  ).get();
  if (!rubrique) throw new Error('Le socle doit contenir au moins une rubrique de recette');
  ids.categorie = Number(rubrique.id);
  ids.rubriqueNom = rubrique.nom;

  ids.date = new Date().toISOString().slice(0, 10);

  const encaissement = (libelle, positionId) => {
    const r = db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,statut,created_by)
      VALUES (?,?,5000,'encaissement',?,'valide',?)
    `).run(ids.date, libelle, positionId, admin.id);
    return Number(r.lastInsertRowid);
  };
  ids.encA = encaissement('Encaissement sur A', ids.caisseA);
  ids.encB = encaissement('Encaissement sur B', ids.caisseB);

  const decaissement = (libelle, positionId) => {
    const r = db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,statut,dec_statut,created_by)
      VALUES (?,?,3000,'decaissement',?,'en_attente','soumis',?)
    `).run(ids.date, libelle, positionId, admin.id);
    return Number(r.lastInsertRowid);
  };
  ids.decA = decaissement('Décaissement sur A', ids.caisseA);
  ids.decB = decaissement('Décaissement sur B', ids.caisseB);

  db.close();
  console.log(
    `[socle] caisses A=${ids.caisseA} (affectée) B=${ids.caisseB} · `
    + `encaissements ${ids.encA}/${ids.encB} · décaissements ${ids.decA}/${ids.decB}`,
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
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  let corps = null;
  try { corps = await response.json(); } catch (_) { corps = null; }
  return { statut: response.status, corps };
}

function liste(corps) {
  if (Array.isArray(corps)) return corps;
  return corps?.rows ?? corps?.operations ?? corps?.items ?? [];
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

async function mesurerLecture() {
  const vues = {};
  for (const compte of ['ASSISTANTE', 'FINANCE']) {
    const { statut, corps } = await appel(compte, '/api/operations?limit=500');
    if (statut !== 200) throw new Error(`GET /operations en ${compte} : HTTP ${statut}`);
    vues[compte] = liste(corps).map(o => Number(o.id));
    console.log(`[mesure] ${compte} voit ${vues[compte].length} opération(s) valides`);
  }

  /* Témoin : sans lui, un filtre qui masquerait tout passerait pour un succès. */
  verifier(
    vues.FINANCE.includes(ids.encA) && vues.FINANCE.includes(ids.encB),
    'finance reste global : il doit voir les deux encaissements',
  );
  verifier(
    vues.ASSISTANTE.includes(ids.encA),
    'l\'assistante doit voir l\'encaissement de SA caisse — sans quoi la mesure suivante ne prouve rien',
  );
  verifier(
    !vues.ASSISTANTE.includes(ids.encB),
    'l\'assistante ne doit plus voir l\'encaissement d\'une caisse non affectée : '
    + 'ce rôle n\'était pas restreint avant la bascule',
  );
}

async function mesurerPositions() {
  const vues = {};
  for (const compte of ['ASSISTANTE', 'FINANCE']) {
    const { statut, corps } = await appel(compte, '/api/operations/positions');
    if (statut !== 200) throw new Error(`GET /positions en ${compte} : HTTP ${statut}`);
    vues[compte] = (Array.isArray(corps) ? corps : []).map(p => Number(p.id));
  }
  console.log(`[mesure] positions — ASSISTANTE=${vues.ASSISTANTE.length} FINANCE=${vues.FINANCE.length}`);
  verifier(
    vues.FINANCE.includes(ids.caisseA) && vues.FINANCE.includes(ids.caisseB),
    'finance doit voir les deux caisses',
  );
  verifier(
    vues.ASSISTANTE.includes(ids.caisseA) && !vues.ASSISTANTE.includes(ids.caisseB),
    'l\'assistante ne doit voir que la caisse qui lui est affectée',
  );
}

async function mesurerEcriture() {
  const charge = (libelle, positionId, extra = {}) => ({
    date: ids.date,
    libelle,
    montant: 500,
    type_op: 'encaissement',
    position_id: positionId,
    categorie_id: ids.categorie,
    tiers: 'Banc',
    ...extra,
  });

  /* La permission fonctionnelle passe avant le périmètre : l'assistante n'est pas
     dans ENC_CREATE_ROLES, elle est donc refusée sur son RÔLE, pas sur sa caisse.
     Mesurer ce refus-là évite de croire qu'on mesure un périmètre quand on mesure
     un rôle — c'est le piège de ce banc, et il a failli l'emporter. */
  const parLeRole = await appel('ASSISTANTE', '/api/operations', {
    method: 'POST', body: JSON.stringify(charge('Saisie par un rôle non habilité', ids.caisseA)),
  });
  console.log(`[mesure] assistante sur SA caisse → HTTP ${parLeRole.statut} — ${parLeRole.corps?.error || ''}`);
  verifier(
    parLeRole.statut === 403 && /rôles/i.test(parLeRole.corps?.error || ''),
    'l\'assistante doit être refusée sur son rôle, et le message doit le dire : '
    + 'la permission fonctionnelle est le premier contrôle, le périmètre le second',
  );

  const surSa = await appel('CAISSIERE', '/api/operations', {
    method: 'POST', body: JSON.stringify(charge('Saisie sur caisse affectée', ids.caisseA)),
  });
  console.log(`[mesure] caissière sur SA caisse → HTTP ${surSa.statut}`);
  verifier(
    surSa.statut >= 200 && surSa.statut < 300,
    `la caissière doit pouvoir écrire sur sa caisse, reçu ${surSa.statut}`
    + `${surSa.corps?.error ? ' — ' + surSa.corps.error : ''}`,
  );

  const surAutre = await appel('CAISSIERE', '/api/operations', {
    method: 'POST', body: JSON.stringify(charge('Saisie sur caisse non affectée', ids.caisseB)),
  });
  console.log(`[mesure] caissière sur une caisse non affectée → HTTP ${surAutre.statut}`);
  verifier(surAutre.statut === 403, `écrire sur une caisse non affectée doit être refusé, reçu ${surAutre.statut}`);

  /* Un virement porte deux caisses : partir d'une caisse non affectée est une
     écriture sur elle, même si la destination est autorisée. */
  const virement = await appel('CAISSIERE', '/api/operations', {
    method: 'POST',
    body: JSON.stringify(charge('Virement depuis caisse non affectée', ids.caisseA, {
      type_op: 'virement', position_source_id: ids.caisseB,
    })),
  });
  console.log(`[mesure] virement dont la SOURCE n'est pas affectée → HTTP ${virement.statut}`);
  verifier(
    virement.statut === 403,
    `un virement dont la source n'est pas affectée doit être refusé, reçu ${virement.statut}`,
  );
}

async function mesurerFileDecaissement() {
  const vues = {};
  for (const compte of ['ASSISTANTE', 'FINANCE']) {
    const { statut, corps } = await appel(compte, '/api/operations/decaissements/pending');
    if (statut !== 200) throw new Error(`GET /decaissements/pending en ${compte} : HTTP ${statut}`);
    vues[compte] = liste(corps).map(o => Number(o.id));
    console.log(`[mesure] file de décaissement — ${compte} : ${vues[compte].length} ligne(s)`);
  }

  /* Témoin indispensable : si l'assistante ne voyait RIEN faute de critères, la
     mesure d'exclusion serait vraie pour une mauvaise raison. */
  verifier(
    vues.ASSISTANTE.includes(ids.decA),
    'l\'assistante doit voir le décaissement de sa caisse dans la file — '
    + 'sans quoi l\'exclusion mesurée ensuite ne prouverait rien',
  );
  verifier(
    !vues.ASSISTANTE.includes(ids.decB),
    'la file de décaissement doit exclure une caisse non affectée',
  );
  verifier(
    vues.FINANCE.includes(ids.decA) && vues.FINANCE.includes(ids.decB),
    'finance doit voir les deux décaissements dans la file',
  );
}

async function mesurerImport() {
  /* Un classeur de deux lignes : l'une sur la caisse affectée, l'autre non.
     L'import résout les positions dans le périmètre de l'appelant, donc la
     seconde ligne ne doit pas trouver sa caisse. */
  const feuille = XLSX.utils.aoa_to_sheet([
    ['Date', 'Libellé', 'Montant', 'Caisse', 'Rubrique'],
    [ids.date, 'Import ligne caisse affectée', 700, 'E2E_BAS_A', ids.rubriqueNom],
    [ids.date, 'Import ligne caisse non affectée', 800, 'E2E_BAS_B', ids.rubriqueNom],
  ]);
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, 'Operations');
  const tampon = XLSX.write(classeur, { type: 'buffer', bookType: 'xlsx' });

  const formulaire = new FormData();
  formulaire.append('type', 'encaissement');
  formulaire.append('file', new Blob([tampon]), 'import.xlsx');

  const { statut, corps } = await appel('CAISSIERE', '/api/operations/import', {
    method: 'POST', body: formulaire,
  });
  const importees = Number(corps?.imported ?? corps?.inserted ?? 0);
  const erreurs = Array.isArray(corps?.errors) ? corps.errors.length : 0;
  console.log(`[mesure] import → HTTP ${statut} · ${importees} importée(s), ${erreurs} refusée(s)` + (corps && corps.error ? ' — ' + corps.error : ''));

  verifier(statut >= 200 && statut < 300, `l'import doit aboutir, reçu HTTP ${statut}`);
  verifier(
    importees === 1,
    `seule la ligne de la caisse affectée doit entrer : ${importees} importée(s) `
    + `(la seconde vise une caisse hors périmètre)`,
  );
  verifier(
    erreurs >= 1,
    'la ligne visant une caisse non affectée doit être refusée et signalée, pas ignorée en silence',
  );
}

async function mesurer() {
  await mesurerLecture();
  await mesurerPositions();
  await mesurerEcriture();
  await mesurerFileDecaissement();
  await mesurerImport();
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
    throw new Error(`perimetre_bascule_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('perimetre_bascule_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

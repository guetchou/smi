'use strict';
/*
 * Quand la garde de clôture refuse, rien n'est écrit — nulle part.
 *
 * Chantier 6 : la centralisation du contrôle a déplacé l'endroit où l'exception
 * est levée. Déplacer une exception dans du code transactionnel est une opération
 * dangereuse : si elle part après une écriture et que le rollback ne couvre pas
 * tout, il reste une opération sans écriture comptable, un audit sans objet, ou
 * un grand livre à moitié alimenté.
 *
 * Ce banc ne vérifie donc pas seulement le code HTTP. Il photographie la base
 * avant, tente chaque chemin financier, et exige que la photographie soit
 * identique après : aucune opération créée, aucun mouvement de grand livre,
 * aucune écriture comptable, aucun statut modifié.
 *
 * Deux dispositifs le protègent du faux succès :
 *
 *   — chaque refus doit NOMMER la clôture. Sans cela, un refus de permission ou
 *     de validation passerait pour un refus de garde, et le banc signerait vert
 *     en ne mesurant rien ;
 *   — un témoin final écrit sur une caisse NON clôturée et doit réussir. Sans
 *     lui, une base cassée refusant tout passerait pour un succès.
 *
 * Même forme que scripts/test_cloture_verrou_isolated.js.
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

const port = Number(process.env.TEST_PORT || 3355);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-transac-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_transac_banc';
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

function ouvrirBase() {
  Object.assign(process.env, env);
  return require('../backend/database');
}

function seedDatabase() {
  const db = ouvrirBase();

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');

  const creerCaisse = (code, libelle) => {
    const r = db.prepare(`
      INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
      VALUES (?,?,'caisse',500000,1,94)
    `).run(code, libelle);
    return Number(r.lastInsertRowid);
  };
  ids.fermee = creerCaisse('E2E_TRX_FERMEE', 'Caisse clôturée');
  ids.ouverte = creerCaisse('E2E_TRX_OUVERTE', 'Caisse ouverte');

  const email = 'finance.transac@topcenter.cg';
  const u = db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('TRANSAC','FINANCE',?,?,?,'finance',?,1)
  `).run(email, 'finance.transac', admin.password_hash, JSON.stringify(['finance']));
  ids.user = Number(u.lastInsertRowid);
  const profil = db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
  if (profil) {
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(ids.user, profil.id);
  }
  jeton = signerHS256(
    { id: ids.user, email, role: 'finance', roles: ['finance'], nom: 'TRANSAC', prenom: 'FINANCE', jti: 'e2e-transac' },
    env.JWT_SECRET,
  );

  const recette = db.prepare(
    "SELECT id, nom FROM categories WHERE type IN ('recette','encaissement') LIMIT 1",
  ).get();
  if (!recette) throw new Error('Le socle doit contenir au moins une rubrique de recette');
  ids.categorie = Number(recette.id);
  ids.categorieNom = recette.nom;

  const { d } = db.prepare("SELECT date('now') AS d").get();
  ids.date = String(d).slice(0, 10);

  /* Une opération valide et un décaissement prêt à payer, tous deux sur la caisse
     qui sera clôturée : ce sont les objets que les tentatives essaieront de
     modifier, d'annuler et de payer. */
  const enc = db.prepare(`
    INSERT INTO operations (date,libelle,montant,type_op,position_id,categorie_id,statut,created_by)
    VALUES (?,'Encaissement existant',9000,'encaissement',?,?,'valide',?)
  `).run(ids.date, ids.fermee, ids.categorie, admin.id);
  ids.encaissement = Number(enc.lastInsertRowid);

  const dec = db.prepare(`
    INSERT INTO operations
      (date,libelle,montant,type_op,position_id,statut,dec_statut,created_by,submitted_by,submitted_at,validated_by,validated_at)
    VALUES (?,'Décaissement prêt à payer',4000,'decaissement',?,'en_attente','valide',?,?,NOW(),?,NOW())
  `).run(ids.date, ids.fermee, admin.id, admin.id, admin.id);
  ids.decaissement = Number(dec.lastInsertRowid);

  /* La clôture journalière de la caisse, validée côté opérations. */
  db.prepare(`
    INSERT INTO cashbox_closures
      (caisse_id,date_cloture,solde_ouverture,solde_cloture,total_encaissements,total_decaissements,ecart,cloture_par,statut)
    VALUES (?,?,0,0,0,0,0,?,'cloturee')
  `).run(ids.fermee, ids.date, admin.id);

  db.close();
  console.log(
    `[socle] caisse fermée=${ids.fermee} ouverte=${ids.ouverte} · `
    + `encaissement=${ids.encaissement} décaissement=${ids.decaissement} · jour ${ids.date}`,
  );
}

function photographier() {
  const db = ouvrirBase();
  const un = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
  const cliche = {
    operations: un('SELECT COUNT(*) AS n FROM operations'),
    cashLedger: un('SELECT COUNT(*) AS n FROM cash_ledger'),
    ecritures: un('SELECT COUNT(*) AS n FROM accounting_entries'),
    lignesEcritures: un('SELECT COUNT(*) AS n FROM accounting_entry_lines'),
    encaissement: db.prepare('SELECT statut FROM operations WHERE id = ?').get(ids.encaissement)?.statut,
    decaissement: db.prepare('SELECT dec_statut FROM operations WHERE id = ?').get(ids.decaissement)?.dec_statut,
  };
  db.close();
  return cliche;
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
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
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

/* Un refus qui ne nomme pas la clôture n'est pas le refus qu'on mesure. */
function nommeLaCloture(erreur) {
  return /clôtur/i.test(String(erreur || ''));
}

async function tenter(nom, chemin, options) {
  const { statut, corps } = await appel(chemin, options);
  const erreur = corps?.error || '';
  console.log(`[mesure] ${nom} → HTTP ${statut} — ${erreur.slice(0, 70)}`);
  verifier(statut >= 400, `${nom} : doit être refusé, reçu HTTP ${statut}`);
  verifier(
    nommeLaCloture(erreur),
    `${nom} : le refus doit nommer la clôture, sinon il mesure autre chose — reçu « ${erreur} »`,
  );
}

async function mesurer() {
  const avant = photographier();
  console.log(`[cliché] avant : ${JSON.stringify(avant)}`);

  const charge = (extra = {}) => JSON.stringify({
    date: ids.date,
    libelle: 'Tentative en période clôturée',
    montant: 1000,
    type_op: 'encaissement',
    position_id: ids.fermee,
    categorie_id: ids.categorie,
    tiers: 'Banc',
    ...extra,
  });

  await tenter('création sur caisse clôturée', '/api/operations', { method: 'POST', body: charge() });

  await tenter('modification d\'une opération de la journée clôturée',
    `/api/operations/${ids.encaissement}`, { method: 'PUT', body: charge() });

  await tenter('annulation', `/api/operations/${ids.encaissement}`,
    { method: 'DELETE', body: JSON.stringify({ motif: 'Tentative du banc' }) });

  await tenter('paiement du décaissement', `/api/operations/${ids.decaissement}/payer`,
    { method: 'POST', body: JSON.stringify({}) });

  await tenter('virement dont la destination est clôturée', '/api/operations',
    { method: 'POST', body: charge({ type_op: 'virement', position_id: ids.fermee, position_source_id: ids.ouverte }) });

  await tenter('virement dont la source est clôturée', '/api/operations',
    { method: 'POST', body: charge({ type_op: 'virement', position_id: ids.ouverte, position_source_id: ids.fermee }) });

  /* L'import : son refus est porté ligne à ligne, pas par le code HTTP. */
  const feuille = XLSX.utils.aoa_to_sheet([
    ['Date', 'Libellé', 'Montant', 'Caisse', 'Rubrique'],
    [ids.date, 'Import en période clôturée', 1500, 'E2E_TRX_FERMEE', ids.categorieNom],
  ]);
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, 'Operations');
  const formulaire = new FormData();
  formulaire.append('type', 'encaissement');
  formulaire.append('file', new Blob([XLSX.write(classeur, { type: 'buffer', bookType: 'xlsx' })]), 'i.xlsx');
  const imp = await appel('/api/operations/import', { method: 'POST', body: formulaire });
  const importees = Number(imp.corps?.imported ?? imp.corps?.inserted ?? 0);
  console.log(`[mesure] import en période clôturée → HTTP ${imp.statut} · ${importees} importée(s)`);
  verifier(importees === 0, `l'import ne doit rien écrire dans une journée clôturée, ${importees} ligne(s) entrées`);

  /* La photographie doit être identique : c'est l'objet de ce banc. */
  const apres = photographier();
  console.log(`[cliché] après : ${JSON.stringify(apres)}`);

  for (const clef of ['operations', 'cashLedger', 'ecritures', 'lignesEcritures']) {
    verifier(
      apres[clef] === avant[clef],
      `${clef} : aucune écriture ne doit subsister après un refus — ${avant[clef]} avant, ${apres[clef]} après`,
    );
  }
  verifier(
    apres.encaissement === avant.encaissement,
    `le statut de l'opération ne doit pas changer — ${avant.encaissement} → ${apres.encaissement}`,
  );
  verifier(
    apres.decaissement === avant.decaissement,
    `le statut du décaissement ne doit pas changer — ${avant.decaissement} → ${apres.decaissement}`,
  );

  /* Témoin : sur une caisse ouverte, l'écriture passe. Sans lui, une base cassée
     refusant tout signerait vert. */
  const temoin = await appel('/api/operations', {
    method: 'POST',
    body: charge({ position_id: ids.ouverte, libelle: 'Témoin sur caisse ouverte' }),
  });
  console.log(`[mesure] témoin sur caisse ouverte → HTTP ${temoin.statut}`);
  verifier(
    temoin.statut >= 200 && temoin.statut < 300,
    `le témoin doit passer sur une caisse ouverte, reçu ${temoin.statut}`
    + `${temoin.corps?.error ? ' — ' + temoin.corps.error : ''}`,
  );

  const final = photographier();
  verifier(
    final.operations === avant.operations + 1,
    `le témoin doit avoir écrit exactement une opération — ${avant.operations} puis ${final.operations}`,
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
    throw new Error(`cloture_transaction_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('cloture_transaction_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

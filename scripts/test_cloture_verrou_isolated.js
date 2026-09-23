'use strict';
/*
 * Une caisse clôturée n'accepte plus d'écriture, quel que soit le chemin.
 *
 * Constat C12 de l'audit des flux. `operations.js` ne consultait que
 * `periodes_cloturees`, au mois. Une opération pouvait donc être saisie dans une
 * journée dont la caisse était clôturée et validée — et il existait quatre
 * copies du contrôle mensuel pour aucun contrôle journalier.
 *
 * Deux modèles de clôture journalière coexistent et sont tous deux vivants :
 * `cashbox_closures` (écrite par les opérations) et `caisses_clotures` (écrite
 * par le rapprochement). Ce banc ferme une caisse par chacun des deux chemins,
 * et exige que les deux bloquent.
 *
 * Il vérifie aussi les deux directions du virement. Une opération de virement
 * porte DEUX caisses : l'argent quitte la source et entre dans la destination.
 * Fermer l'une ou l'autre doit s'opposer à l'écriture — ne contrôler que
 * `position_id` laisserait écrire sur une caisse fermée par sa source.
 *
 * Trois témoins protègent le banc du faux succès :
 *   — une caisse sans clôture accepte l'écriture ;
 *   — une clôture rouverte (`reopened`) redevient ouverte ;
 *   — sans quoi un refus systématique passerait pour une réussite.
 *
 * Même forme que scripts/test_rapprochement_virement_isolated.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { provisionner, supprimer } = require('./lib/socle_mysql');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3349);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-cloture-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_cloture_banc';
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

function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');

  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();
  if (!admin) throw new Error('Le socle de test doit contenir le compte administrateur');

  const creerCaisse = (code, libelle) => {
    const r = db.prepare(`
      INSERT INTO positions (code,libelle,type,solde_initial,actif,ordre)
      VALUES (?,?,'caisse',0,1,97)
    `).run(code, libelle);
    return Number(r.lastInsertRowid);
  };
  ids.ouverte   = creerCaisse('E2E_CLO_OUVERTE',  'Caisse sans clôture');
  ids.fermeeOps = creerCaisse('E2E_CLO_OPS',      'Caisse fermée côté opérations');
  ids.fermeeRap = creerCaisse('E2E_CLO_RAP',      'Caisse fermée côté rapprochement');
  ids.rouverte  = creerCaisse('E2E_CLO_ROUVERTE', 'Caisse rouverte');

  const email = 'finance.cloture@topcenter.cg';
  const r = db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('CLOTURE','FINANCE',?,?,?,'finance',?,1)
  `).run(email, 'finance.cloture', admin.password_hash, JSON.stringify(['finance']));
  ids.user = Number(r.lastInsertRowid);
  const profil = db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
  if (profil) {
    db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
      .run(ids.user, profil.id);
  }
  jeton = signerHS256(
    { id: ids.user, email, role: 'finance', roles: ['finance'], nom: 'CLOTURE', prenom: 'FINANCE', jti: 'e2e-cloture' },
    env.JWT_SECRET,
  );

  const rubrique = db.prepare(
    "SELECT id FROM categories WHERE type IN ('recette','encaissement') LIMIT 1",
  ).get();
  if (!rubrique) throw new Error('Le socle doit contenir au moins une rubrique de recette');
  ids.categorie = Number(rubrique.id);

  ids.date = new Date().toISOString().slice(0, 10);

  /* De quoi couvrir les virements : chaque caisse porte déjà un solde. Ces
     lignes sont semées en base, donc elles ne passent pas par la garde. */
  for (const caisse of [ids.ouverte, ids.fermeeOps, ids.fermeeRap, ids.rouverte]) {
    db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,statut,created_by)
      VALUES (?,'Solde initial du banc',100000,'encaissement',?,'valide',?)
    `).run(ids.date, caisse, admin.id);
  }

  /* Les deux modèles de clôture, chacun sur sa caisse, plus une réouverture. */
  db.prepare(`
    INSERT INTO cashbox_closures
      (caisse_id,date_cloture,solde_ouverture,solde_cloture,total_encaissements,total_decaissements,ecart,cloture_par,statut)
    VALUES (?,?,0,0,0,0,0,?,'cloturee')
  `).run(ids.fermeeOps, ids.date, admin.id);

  db.prepare(`
    INSERT INTO cashbox_closures
      (caisse_id,date_cloture,solde_ouverture,solde_cloture,total_encaissements,total_decaissements,ecart,cloture_par,statut)
    VALUES (?,?,0,0,0,0,0,?,'reopened')
  `).run(ids.rouverte, ids.date, admin.id);

  db.prepare(`
    INSERT INTO caisses_clotures
      (position_id,date_cloture,caissier_id,solde_logiciel_ouverture,solde_logiciel_cloture,
       solde_physique_declare,ecart,statut)
    VALUES (?,?,?,0,0,0,0,'valide')
  `).run(ids.fermeeRap, ids.date, admin.id);

  db.close();
  console.log(
    `[socle] caisses — ouverte=${ids.ouverte} ferméeOps=${ids.fermeeOps} `
    + `ferméeRap=${ids.fermeeRap} rouverte=${ids.rouverte} · date ${ids.date}`,
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

async function ecrire(charge) {
  const response = await fetch(`${baseURL}/api/operations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: ids.date,
      montant: 500,
      categorie_id: ids.categorie,
      tiers: 'Banc',
      ...charge,
    }),
  });
  let corps = null;
  try { corps = await response.json(); } catch (_) { corps = null; }
  return { statut: response.status, erreur: corps?.error || null };
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

async function attendreRefus(nom, charge) {
  const { statut, erreur } = await ecrire(charge);
  console.log(`[mesure] ${nom} → HTTP ${statut}${erreur ? ' — ' + erreur : ''}`);
  verifier(
    statut === 400 || statut === 409,
    `${nom} : l'écriture doit être refusée, reçu HTTP ${statut}`,
  );
  return erreur;
}

async function attendreAcceptation(nom, charge) {
  const { statut, erreur } = await ecrire(charge);
  console.log(`[mesure] ${nom} → HTTP ${statut}${erreur ? ' — ' + erreur : ''}`);
  verifier(
    statut >= 200 && statut < 300,
    `${nom} : l'écriture doit rester possible, reçu HTTP ${statut}${erreur ? ' — ' + erreur : ''}`,
  );
}

async function mesurer() {
  /* Témoin : sans lui, une garde qui refuse tout passerait pour un succès. */
  await attendreAcceptation('caisse sans clôture', {
    libelle: 'Encaissement sur caisse ouverte',
    type_op: 'encaissement',
    position_id: ids.ouverte,
  });

  /* Second témoin : une clôture rouverte ne ferme plus. */
  await attendreAcceptation('caisse rouverte', {
    libelle: 'Encaissement après réouverture',
    type_op: 'encaissement',
    position_id: ids.rouverte,
  });

  await attendreRefus('caisse clôturée côté opérations', {
    libelle: 'Encaissement sur caisse fermée',
    type_op: 'encaissement',
    position_id: ids.fermeeOps,
  });

  await attendreRefus('caisse clôturée côté rapprochement', {
    libelle: 'Encaissement sur caisse fermée',
    type_op: 'encaissement',
    position_id: ids.fermeeRap,
  });

  /* Les deux directions du virement. L'argent quitte la source et entre dans la
     destination : fermer l'une ou l'autre s'oppose à l'écriture. */
  await attendreRefus('virement dont la DESTINATION est clôturée', {
    libelle: 'Virement vers caisse fermée',
    type_op: 'virement',
    position_id: ids.fermeeOps,
    position_source_id: ids.ouverte,
  });

  await attendreRefus('virement dont la SOURCE est clôturée', {
    libelle: 'Virement depuis caisse fermée',
    type_op: 'virement',
    position_id: ids.ouverte,
    position_source_id: ids.fermeeOps,
  });

  /* Et le mois, qui ferme tout — vérifié en dernier pour ne pas masquer le reste. */
  Object.assign(process.env, env);
  const db = require('../backend/database');
  const [annee, mois] = ids.date.split('-').map(Number);
  db.prepare('INSERT INTO periodes_cloturees (annee,mois,cloture_by) VALUES (?,?,?)')
    .run(annee, mois, ids.user);
  db.close();

  const erreurMois = await attendreRefus('mois clôturé, caisse pourtant ouverte', {
    libelle: 'Encaissement en période close',
    type_op: 'encaissement',
    position_id: ids.ouverte,
  });
  verifier(
    !erreurMois || /Période/i.test(erreurMois),
    `le refus mensuel doit nommer la période, reçu : ${erreurMois}`,
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
    throw new Error(`cloture_verrou_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('cloture_verrou_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

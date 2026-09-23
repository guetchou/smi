'use strict';
/*
 * Au-delà du seuil, seul le DG valide — et le seuil se règle sans toucher au code.
 *
 * Constat C7b de l'audit des flux : les seuils d'approbation décrits dans le PRD
 * ne sont pas appliqués. Les deux clés existaient pourtant déjà dans
 * `parametres` (`seuil_approbation_finance`, `seuil_approbation_dg`) : le
 * paramétrage était là, le comportement manquait.
 *
 * Ce banc ne lit pas la source. Il sème des décaissements soumis de montants
 * différents, puis appelle la route de validation avec des comptes d'autorité
 * différente.
 *
 * Deux cas portent tout le sens du correctif :
 *
 *   — un délégué dont la délégation vient d'un DG franchit le seuil ; un délégué
 *     dont elle vient de la finance ne le franchit pas. Déléguer une approbation
 *     de finance ne confère pas l'autorité du DG, et la table porte
 *     `delegant_id` pour en décider sur des données plutôt qu'une convention ;
 *
 *   — le dernier cas modifie le seuil dans `parametres` et rejoue la même
 *     validation. C'est la seule façon de prouver « configurable » : un seuil
 *     écrit en dur passerait tous les autres cas.
 *
 * Le témoin du premier cas empêche un refus systématique de passer pour un
 * succès.
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
const port = Number(process.env.TEST_PORT || 3350);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-seuils-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_seuils_banc';
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
let seuilDG = null;

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

  /* Prémisse : le banc mesure un seuil configuré, il ne l'invente pas. */
  const lu = db.prepare("SELECT valeur FROM parametres WHERE cle='seuil_approbation_dg'").get();
  seuilDG = lu ? Number(lu.valeur) : null;
  if (!Number.isFinite(seuilDG) || seuilDG <= 0) {
    throw new Error(`Le socle doit porter un seuil_approbation_dg exploitable — lu : ${lu && lu.valeur}`);
  }

  const creerCompte = (prenom, role) => {
    const email = `${role}.${prenom.toLowerCase()}@topcenter.cg`;
    const r = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES ('SEUILS',?,?,?,?,?,?,1)
    `).run(prenom, email, `${role}.${prenom.toLowerCase()}`, admin.password_hash, role, JSON.stringify([role]));
    const id = Number(r.lastInsertRowid);
    /* Le profil porte les permissions de MODULE. Aucun profil « delegue »
       n'existe dans le socle, or sans module la route repond « Module non
       assigne a votre compte » et le cas mesurerait ce refus au lieu du seuil.
       On retombe donc sur le profil finance : l'AUTORITE d'un delegue vient de
       sa delegation, pas de son profil. */
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(role)
      || db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
    if (profil) {
      db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
        .run(id, profil.id);
    }
    jetons[prenom] = signerHS256(
      { id, email, role, roles: [role], nom: 'SEUILS', prenom, jti: `e2e-seuils-${prenom}` },
      env.JWT_SECRET,
    );
    return id;
  };

  ids.finance = creerCompte('FINANCE', 'finance');
  ids.dg = creerCompte('DG', 'dg');
  ids.delegueDeDG = creerCompte('DELEGUEDG', 'delegue');
  ids.delegueDeFinance = creerCompte('DELEGUEFI', 'delegue');

  const deleguer = (delegantId, delegueId) => {
    db.prepare(`
      INSERT INTO delegations_approbation (delegant_id,delegue_id,date_debut,date_fin,actif)
      VALUES (?,?,CURDATE(),NULL,1)
    `).run(delegantId, delegueId);
  };
  deleguer(ids.dg, ids.delegueDeDG);
  deleguer(ids.finance, ids.delegueDeFinance);


  const position = db.prepare("SELECT id FROM positions WHERE actif = 1 LIMIT 1").get();
  if (!position) throw new Error('Le socle doit contenir au moins une position');
  ids.position = Number(position.id);
  /* Depuis la bascule du périmètre caisse, « delegue » n'est plus un rôle
     global : sans affectation, un délégué est refusé avant même que son autorité
     soit examinée, et le banc mesurerait ce refus-là. On l'affecte donc à la
     caisse mesurée — c'est ce que la production devra faire aussi. */
  for (const delegue of [ids.delegueDeDG, ids.delegueDeFinance]) {
    db.prepare(`
      INSERT INTO user_cashboxes (user_id,caisse_id,can_read,can_write,affecte_par)
      VALUES (?,?,1,1,?)
    `).run(delegue, ids.position, admin.id);
  }

  ids.date = new Date().toISOString().slice(0, 10);
  /* La soumission crée un dossier de parapheur dans la même transaction depuis
     le 23/06/2026, et c'est lui qui porte le journal des approbations. Semer une
     opération sans dossier produirait un décaissement qu'aucune route ne sait
     valider — un état que la production ne connaît pas. */
  const creerDecaissement = montant => {
    const r = db.prepare(`
      INSERT INTO operations (date,libelle,montant,type_op,position_id,statut,dec_statut,created_by,submitted_by,submitted_at)
      VALUES (?,'Décaissement semé par le banc',?, 'decaissement',?,'en_attente','soumis',?,?,NOW())
    `).run(ids.date, montant, ids.position, admin.id, admin.id);
    const operationId = Number(r.lastInsertRowid);
    const dossier = db.prepare(`
      INSERT INTO parapheur (type,titre,initiateur_id,priorite,statut,montant,ref_source_table,ref_source_id)
      VALUES ('decaissement','Décaissement du banc',?,'normal','transmis_dg',?,'operations',?)
    `).run(admin.id, montant, operationId);
    db.prepare(`
      INSERT INTO parapheur_actions (parapheur_id,acteur_id,acteur_role,action_type,is_interim)
      VALUES (?,?,'system','soumis',0)
    `).run(Number(dossier.lastInsertRowid), admin.id);
    return operationId;
  };

  const petit = Math.max(1, Math.floor(seuilDG / 100));
  const grand = seuilDG + 1000;
  ids.opPetite = creerDecaissement(petit);
  ids.opGrandeFinance = creerDecaissement(grand);
  ids.opGrandeDG = creerDecaissement(grand);
  ids.opGrandeDelegueDG = creerDecaissement(grand);
  ids.opGrandeDelegueFinance = creerDecaissement(grand);
  ids.opApresRelevement = creerDecaissement(grand);

  db.close();
  console.log(`[socle] seuil DG lu = ${seuilDG} · petit montant ${petit} · grand montant ${grand}`);
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

async function valider(compte, operationId) {
  const response = await fetch(`${baseURL}/api/operations/${operationId}/valider`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jetons[compte]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  let corps = null;
  try { corps = await response.json(); } catch (_) { corps = null; }
  return { statut: response.status, erreur: corps?.error || null };
}

const echecs = [];
function verifier(condition, message) {
  if (!condition) echecs.push(message);
}

async function cas(nom, compte, operationId, attendu) {
  const { statut, erreur } = await valider(compte, operationId);
  console.log(`[mesure] ${nom} → HTTP ${statut}${erreur ? ' — ' + erreur : ''}`);
  const accepte = statut >= 200 && statut < 300;
  if (attendu === 'accepte') {
    verifier(accepte, `${nom} : la validation doit aboutir, reçue HTTP ${statut}${erreur ? ' — ' + erreur : ''}`);
  } else {
    verifier(!accepte, `${nom} : la validation doit être refusée, reçue HTTP ${statut}`);
  }
  return erreur;
}

async function mesurer() {
  /* Témoin : sous le seuil, la finance valide. Sans lui, un refus systématique
     passerait pour un succès. */
  await cas('petit montant, validé par la finance', 'FINANCE', ids.opPetite, 'accepte');

  await cas('grand montant, validé par la finance', 'FINANCE', ids.opGrandeFinance, 'refuse');
  await cas('grand montant, validé par le DG', 'DG', ids.opGrandeDG, 'accepte');
  await cas('grand montant, délégué DU DG', 'DELEGUEDG', ids.opGrandeDelegueDG, 'accepte');
  await cas('grand montant, délégué de la finance', 'DELEGUEFI', ids.opGrandeDelegueFinance, 'refuse');

  /* Configurabilité : on relève le seuil au-dessus du montant, et la MÊME
     validation par la MÊME finance doit désormais aboutir. Un seuil écrit en dur
     passerait tous les cas précédents et échouerait ici. */
  const db = ouvrirBase();
  db.prepare("UPDATE parametres SET valeur = ? WHERE cle = 'seuil_approbation_dg'")
    .run(String(seuilDG * 1000));
  db.close();
  console.log(`[mesure] seuil relevé à ${seuilDG * 1000}`);

  await cas(
    'même montant après relèvement du seuil, par la finance',
    'FINANCE', ids.opApresRelevement, 'accepte',
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
    throw new Error(`seuils_approbation_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('seuils_approbation_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

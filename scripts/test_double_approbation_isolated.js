'use strict';
/*
 * Deux approbations, par deux personnes distinctes, dont le DG.
 *
 * Le PRD décrit une bande intermédiaire « Finance + DG ». Elle demande deux
 * décisions distinctes, et `operations` ne porte qu'un seul `validated_by` : les y
 * représenter serait faux quelle que soit l'astuce. Les décisions vont donc au
 * journal qui existe déjà — `parapheur_actions` — et `validated_by` n'en est plus
 * que la projection finale. Voir docs/adr/0001-journal-des-approbations.md.
 *
 * Décision produit du 23/09/2026 : l'ordre est LIBRE. La bande est satisfaite
 * quand le journal porte deux approbations par deux acteurs distincts, dont au
 * moins une portée par l'autorité du DG.
 *
 * Ce banc joue la séquence complète par HTTP et lit ensuite le journal pour
 * vérifier que la trace existe vraiment, avec les bonnes capacités. Sans cette
 * dernière lecture, il mesurerait le statut sans savoir si la décision a laissé
 * une trace — or c'est la trace qui est l'objet du chantier.
 *
 * Deux cas portent tout le sens :
 *   — le même approbateur qui revient est refusé : personne ne se donne le
 *     second avis à soi-même ;
 *   — deux approbations Finance ne suffisent PAS : c'est « Finance + DG », pas
 *     « deux personnes ».
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
const port = Number(process.env.TEST_PORT || 3353);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-approb-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

const BASE = process.env.SMI_BANC_BASE || 'caisse_approb_banc';
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
let seuils = { finance: null, dg: null };

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

  const lire = cle => {
    const r = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
    return r ? Number(r.valeur) : null;
  };
  seuils = { finance: lire('seuil_approbation_finance'), dg: lire('seuil_approbation_dg') };
  if (!Number.isFinite(seuils.finance) || !Number.isFinite(seuils.dg) || seuils.finance >= seuils.dg) {
    throw new Error(`Le socle doit porter deux seuils exploitables — lus : ${JSON.stringify(seuils)}`);
  }

  const creerCompte = (prenom, role) => {
    const email = `${prenom.toLowerCase()}.approb@topcenter.cg`;
    const r = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES ('APPROB',?,?,?,?,?,?,1)
    `).run(prenom, email, `${prenom.toLowerCase()}.approb`, admin.password_hash, role, JSON.stringify([role]));
    const id = Number(r.lastInsertRowid);
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(role)
      || db.prepare("SELECT id FROM profiles WHERE code = 'finance'").get();
    if (profil) {
      db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
        .run(id, profil.id);
    }
    jetons[prenom] = signerHS256(
      { id, email, role, roles: [role], nom: 'APPROB', prenom, jti: `e2e-approb-${prenom}` },
      env.JWT_SECRET,
    );
    return id;
  };

  ids.finance1 = creerCompte('FINANCEA', 'finance');
  ids.finance2 = creerCompte('FINANCEB', 'finance');
  ids.dg = creerCompte('DG', 'dg');

  const position = db.prepare('SELECT id FROM positions WHERE actif = 1 LIMIT 1').get();
  if (!position) throw new Error('Le socle doit contenir au moins une position');
  ids.position = Number(position.id);
  ids.date = new Date().toISOString().slice(0, 10);

  /* L'initiateur et le soumetteur sont l'administrateur : la séparation des
     fonctions, en place depuis le 23/06/2026, interdit à l'un ou l'autre
     d'approuver, et ce banc ne mesure pas cette règle-là. */
  const creerDecaissement = montant => {
    const r = db.prepare(`
      INSERT INTO operations
        (date,libelle,montant,type_op,position_id,statut,dec_statut,created_by,submitted_by,submitted_at)
      VALUES (?,'Décaissement semé par le banc',?, 'decaissement',?,'en_attente','soumis',?,?,NOW())
    `).run(ids.date, montant, ids.position, admin.id, admin.id);
    const operationId = Number(r.lastInsertRowid);
    /* Le dossier de parapheur : c'est lui qui porte le journal des décisions. */
    const d = db.prepare(`
      INSERT INTO parapheur (type,titre,initiateur_id,priorite,statut,montant,ref_source_table,ref_source_id)
      VALUES ('decaissement','Décaissement du banc',?,'normal','transmis_dg',?,'operations',?)
    `).run(admin.id, montant, operationId);
    db.prepare(`
      INSERT INTO parapheur_actions (parapheur_id,acteur_id,acteur_role,action_type,is_interim)
      VALUES (?,?,'system','soumis',0)
    `).run(Number(d.lastInsertRowid), admin.id);
    return operationId;
  };

  const petit = Math.max(1, Math.floor(seuils.finance / 2));
  const moyen = Math.floor((seuils.finance + seuils.dg) / 2);
  ids.opPetite = creerDecaissement(petit);
  ids.opMoyenne = creerDecaissement(moyen);
  ids.opDeuxFinances = creerDecaissement(moyen);

  db.close();
  console.log(
    `[socle] seuils ${seuils.finance}/${seuils.dg} · petite=${ids.opPetite} (${petit}) · `
    + `moyenne=${ids.opMoyenne} (${moyen}) · deuxFinances=${ids.opDeuxFinances}`,
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

async function approuver(compte, operationId) {
  const response = await fetch(`${baseURL}/api/operations/${operationId}/valider`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jetons[compte]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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
  /* Témoin : sous le seuil finance, une seule approbation suffit. Sans lui, une
     règle qui exigerait toujours deux approbations passerait pour un succès. */
  const petite = await approuver('FINANCEA', ids.opPetite);
  console.log(`[mesure] petit montant, une approbation → ${petite.statut} · ${petite.corps?.dec_statut}`);
  verifier(
    petite.statut === 200 && petite.corps?.dec_statut === 'valide',
    `sous le seuil finance, une approbation doit suffire — reçu ${petite.statut} / ${petite.corps?.dec_statut}`,
  );

  /* Bande intermédiaire : la première approbation ne conclut pas. */
  const premiere = await approuver('FINANCEA', ids.opMoyenne);
  console.log(`[mesure] moyenne, 1re approbation (finance) → ${premiere.statut} · ${premiere.corps?.dec_statut} · ${premiere.corps?.approbations} approbation(s)`);
  verifier(
    premiere.statut === 200 && premiere.corps?.dec_statut !== 'valide',
    `dans la bande intermédiaire, une seule approbation ne doit pas valider — reçu ${premiere.corps?.dec_statut}`,
  );

  /* Le même approbateur ne peut pas se donner le second avis. */
  const repetee = await approuver('FINANCEA', ids.opMoyenne);
  console.log(`[mesure] même approbateur à nouveau → ${repetee.statut} · ${repetee.corps?.code || ''}`);
  verifier(
    repetee.statut === 409,
    `le même approbateur ne doit pas pouvoir approuver deux fois — reçu ${repetee.statut}`,
  );

  /* Deux approbations Finance ne suffisent pas : c'est « Finance + DG ». */
  await approuver('FINANCEA', ids.opDeuxFinances);
  const deuxieme = await approuver('FINANCEB', ids.opDeuxFinances);
  console.log(`[mesure] deux approbations finance → ${deuxieme.statut} · ${deuxieme.corps?.dec_statut} · ${deuxieme.corps?.approbations} approbation(s)`);
  verifier(
    deuxieme.corps?.dec_statut !== 'valide',
    'deux approbations Finance ne doivent pas valider : la bande exige l\'autorité du DG',
  );

  /* Le DG conclut. */
  const parDG = await approuver('DG', ids.opMoyenne);
  console.log(`[mesure] le DG approuve à son tour → ${parDG.statut} · ${parDG.corps?.dec_statut} · ${parDG.corps?.approbations} approbation(s)`);
  verifier(
    parDG.statut === 200 && parDG.corps?.dec_statut === 'valide',
    `une approbation finance puis une approbation DG doivent valider — reçu ${parDG.corps?.dec_statut}`,
  );

  /* La trace : c'est l'objet du chantier, et le statut seul ne la prouve pas. */
  const db = ouvrirBase();
  const dossier = db.prepare(
    "SELECT id FROM parapheur WHERE ref_source_table='operations' AND ref_source_id = ?",
  ).get(ids.opMoyenne);
  const actions = dossier
    ? db.prepare(
      "SELECT acteur_id, acteur_role FROM parapheur_actions WHERE parapheur_id = ? AND action_type = 'approuve' ORDER BY id",
    ).all(dossier.id)
    : [];
  const projection = db.prepare('SELECT validated_by, dec_statut FROM operations WHERE id = ?').get(ids.opMoyenne);
  db.close();

  console.log(`[mesure] journal : ${actions.length} approbation(s) — ${actions.map(a => a.acteur_role).join(', ')}`);
  verifier(
    actions.length === 2,
    `le journal doit porter les deux approbations, il en porte ${actions.length}`,
  );
  verifier(
    new Set(actions.map(a => Number(a.acteur_id))).size === 2,
    'les deux approbations doivent être portées par deux acteurs distincts',
  );
  verifier(
    actions.some(a => a.acteur_role === 'dg') && actions.some(a => a.acteur_role === 'finance'),
    `le journal doit garder la capacité de chaque approbateur — lu : ${actions.map(a => a.acteur_role).join(', ')}`,
  );
  verifier(
    Number(projection?.validated_by) === Number(ids.dg) && projection?.dec_statut === 'valide',
    'validated_by doit rester la projection de la décision finale, pour que les anciens lecteurs ne changent pas',
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
    throw new Error(`double_approbation_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('double_approbation_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

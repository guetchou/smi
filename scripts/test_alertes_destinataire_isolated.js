'use strict';
/*
 * Une alerte ne se montre qu'à qui elle est adressée.
 *
 * `GET /api/notifs/alertes` portait en commentaire la phrase « Un non-admin ne
 * voit que les alertes dont il est destinataire selon les règles », et son
 * WHERE n'en faisait rien. La règle existait pourtant en base depuis toujours :
 * `notif_regles.roles_dest`, une liste de rôles par type d'alerte. L'écran
 * avait compensé de son côté — `if (canApproveDec() || canPayDec())` dans
 * dashboard.html — ce qui plaçait la règle à deux endroits et laissait le
 * serveur ouvert à qui appelait l'API directement.
 *
 * Ce banc ne lit pas la source : il sème trois alertes, interroge la route avec
 * deux comptes de rôles différents et compare ce qui revient. Il mesure donc la
 * règle, pas l'écriture qui l'implémente — une reformulation du SQL ne doit pas
 * le faire passer au vert si la visibilité change.
 *
 * Trois cas, et le troisième est le plus important :
 *   1. type adressé à finance   → vu par finance, pas par le caissier ;
 *   2. type adressé aussi au caissier → vu par les deux ;
 *   3. type SANS règle          → vu par les deux. Une alarme qu'aucune règle
 *      ne décrit ne doit jamais être masquée par défaut : on préfère un bruit
 *      visible à un danger silencieux.
 *
 * Et `total` doit toujours compter ce que `items` contient : c'est la même
 * exigence que les compteurs plafonnés du tableau de bord — un compte qui ne
 * décrit pas sa liste est un compte faux.
 *
 * Ce banc tourne sur une VRAIE base MySQL, jetable, dont le schéma vient des
 * migrations — la même source que la production. Voir scripts/lib/socle_mysql.js
 * pour le pourquoi : un socle SQLite reconstruit à la main dérive, et une
 * dérive rend des chemins entiers inatteignables sans que rien ne rougisse.
 *
 * Même forme que test_caisse_operation_isolated.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { provisionner, supprimer } = require('./lib/socle_mysql');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3343);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-alertes-'));
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;

/* Le nom porte « _banc » : c'est le garde-fou que socle_mysql.js exige avant
   d'écrire quoi que ce soit. Le serveur MySQL du VPS porte aussi la production. */
const BASE = process.env.SMI_BANC_BASE || 'caisse_alertes_banc';
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

/* Le type que le socle ne décrit pas : il porte le cas « aucune règle ». */
const TYPE_SANS_REGLE = 'ALRT_E2E_SANS_REGLE';

const jetons = {};
/* L'opération dont on annule le décaissement : son alerte doit mourir avec elle. */
let operationId = null;

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

  /* Les prémisses du banc sont affirmées, pas supposées : si le socle changeait
     roles_dest, la mesure ne voudrait plus rien dire et il vaut mieux qu'elle
     s'arrête que de signer un vert vide. */
  const regleDec = db.prepare("SELECT roles_dest FROM notif_regles WHERE type='ALRT_DEC_SOUMIS'").get();
  if (!regleDec) throw new Error('Le socle doit porter la règle ALRT_DEC_SOUMIS');
  const destDec = JSON.parse(regleDec.roles_dest);
  if (!destDec.includes('finance') || destDec.includes('caissier')) {
    throw new Error(
      `ALRT_DEC_SOUMIS doit être adressée à finance et pas au caissier pour que ce banc discrimine — lu : ${regleDec.roles_dest}`,
    );
  }

  const regleSolde = db.prepare("SELECT roles_dest FROM notif_regles WHERE type='ALRT_SOLDE_CRITIQUE'").get();
  if (!regleSolde) throw new Error('Le socle doit porter la règle ALRT_SOLDE_CRITIQUE');
  const destSolde = JSON.parse(regleSolde.roles_dest);
  if (!destSolde.includes('finance') || !destSolde.includes('caissier')) {
    throw new Error(
      `ALRT_SOLDE_CRITIQUE doit être adressée aux deux rôles mesurés — lu : ${regleSolde.roles_dest}`,
    );
  }

  const sansRegle = db.prepare('SELECT id FROM notif_regles WHERE type=?').get(TYPE_SANS_REGLE);
  if (sansRegle) throw new Error(`${TYPE_SANS_REGLE} ne doit décrire aucune règle`);

  const creerCompte = (prenom, role) => {
    const email = `${role}.alertes@topcenter.cg`;
    const inserted = db.prepare(`
      INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
      VALUES ('ALERTES',?,?,?,?,?,?,1)
    `).run(prenom, email, `${role}.alertes`, admin.password_hash, role, JSON.stringify([role]));
    const id = Number(inserted.lastInsertRowid);
    /* Le profil porte les permissions de module : sans lui l'API refuse avant
       même d'avoir à trancher la visibilité, et le banc mesurerait un 403. */
    const profil = db.prepare('SELECT id FROM profiles WHERE code = ?').get(role);
    if (profil) {
      db.prepare("INSERT INTO user_profiles (user_id,profile_id,active,source) VALUES (?,?,1,'e2e')")
        .run(id, profil.id);
    }
    jetons[role] = signerHS256(
      { id, email, role, roles: [role], nom: 'ALERTES', prenom, jti: `e2e-alertes-${role}` },
      env.JWT_SECRET,
    );
    return id;
  };

  creerCompte('FINANCE', 'finance');
  creerCompte('CAISSE', 'caissier');

  const semer = db.prepare(`
    INSERT INTO alertes_actives (type,priorite,bloquant,titre,message,statut)
    VALUES (?,?,0,?,?,'active')
  `);
  semer.run('ALRT_DEC_SOUMIS', 'avertissement', 'Décaissement soumis', 'Semé par le banc');
  semer.run('ALRT_SOLDE_CRITIQUE', 'critique', 'Solde critique', 'Semé par le banc');
  semer.run(TYPE_SANS_REGLE, 'avertissement', 'Type sans règle', 'Semé par le banc');

  /* Le quatrième cas : une alerte attachée à une opération réelle. L'annulation
     de l'opération doit la refermer. Les orphelines 14 et 15 trouvées en
     production le 23/09/2026 sont la trace de ce trou — une alerte qui survit à
     son opération est comptée comme une validation en attente qui n'existe plus. */
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const op = db.prepare(`
    INSERT INTO operations (date,libelle,montant,type_op,position_id)
    VALUES (?,'Décaissement semé par le banc',1000,'decaissement',1)
  `).run(aujourdhui);
  operationId = Number(op.lastInsertRowid);
  db.prepare(`
    INSERT INTO alertes_actives (type,priorite,bloquant,titre,message,statut,src_table,src_id)
    VALUES ('ALRT_DEC_SOUMIS','avertissement',0,'Décaissement à valider','Semé par le banc','active','operations',?)
  `).run(operationId);

  db.close();
  console.log(`[socle] 2 comptes, 4 alertes, opération #${operationId} semées`);
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

async function lireAlertes(role) {
  const response = await fetch(`${baseURL}/api/notifs/alertes?statut=actives&limit=50`, {
    headers: { Authorization: `Bearer ${jetons[role]}` },
  });
  if (!response.ok) throw new Error(`GET /notifs/alertes en ${role} : HTTP ${response.status}`);
  return response.json();
}

const echecs = [];
function verifier(condition, message) {
  if (condition) return;
  echecs.push(message);
}

async function mesurer() {
  const vues = {};
  for (const role of ['finance', 'caissier']) {
    const data = await lireAlertes(role);
    const types = (data.items ?? []).map(a => a.type).sort();
    vues[role] = { total: data.total, types };
    console.log(`[mesure] ${role} → total=${data.total} types=${types.join(', ') || '∅'}`);

    /* Un total qui ne décrit pas sa liste est un total faux — même exigence
       que les compteurs du tableau de bord. Vrai ici parce que 3 < limit. */
    verifier(
      data.total === types.length,
      `${role} : total=${data.total} mais ${types.length} élément(s) rendus — le compte ne décrit pas la liste`,
    );
  }

  verifier(
    vues.finance.types.includes('ALRT_DEC_SOUMIS'),
    'finance doit voir ALRT_DEC_SOUMIS : la règle la lui adresse',
  );
  verifier(
    !vues.caissier.types.includes('ALRT_DEC_SOUMIS'),
    'le caissier ne doit pas voir ALRT_DEC_SOUMIS : la règle ne la lui adresse pas',
  );
  verifier(
    vues.finance.types.includes('ALRT_SOLDE_CRITIQUE') && vues.caissier.types.includes('ALRT_SOLDE_CRITIQUE'),
    'ALRT_SOLDE_CRITIQUE est adressée aux deux rôles : les deux doivent la voir',
  );
  verifier(
    vues.finance.types.includes(TYPE_SANS_REGLE) && vues.caissier.types.includes(TYPE_SANS_REGLE),
    `${TYPE_SANS_REGLE} n'a aucune règle : elle doit rester visible pour tous — une alarme ne se masque pas par défaut`,
  );

  await mesurerAnnulation();
}

/* Annuler une opération doit refermer l'alerte qu'elle rend sans objet.
   La présence est affirmée AVANT l'annulation : un témoin qui ne pourrait pas
   échouer sur l'état initial ne prouverait rien de l'état final. */
async function mesurerAnnulation() {
  const cible = a => a.src_table === 'operations' && Number(a.src_id) === operationId;

  const avant = await lireAlertes('finance');
  verifier(
    (avant.items ?? []).some(cible),
    `L'alerte de l'opération #${operationId} doit être active avant l'annulation — sans quoi la mesure qui suit ne mesure rien`,
  );

  const annulation = await fetch(`${baseURL}/api/operations/${operationId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jetons.finance}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ motif: 'Annulation jouée par le banc' }),
  });
  if (!annulation.ok) {
    throw new Error(
      `DELETE /api/operations/${operationId} : HTTP ${annulation.status} — ${await annulation.text()}`,
    );
  }

  const apres = await lireAlertes('finance');
  const survivante = (apres.items ?? []).find(cible);
  console.log(`[mesure] annulation de l'opération #${operationId} → alerte ${survivante ? `encore ${survivante.statut}` : 'refermée'}`);
  verifier(
    !survivante,
    `L'alerte de l'opération #${operationId} survit à son annulation : elle reste comptée comme une validation en attente qui n'existe plus`,
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
    throw new Error(`alertes_destinataire_isolated: ${echecs.length} règle(s) non tenue(s)`);
  }
  console.log('alertes_destinataire_isolated: OK');
}

main().catch(error => {
  console.error(error.message);
  try { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n')); } catch (_) {}
  process.exitCode = 1;
});

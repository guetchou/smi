'use strict';

/**
 * Garde — les courriels ne doivent pas échouer en silence quand leur
 * configuration est incomplète.
 *
 * DÉFAUT CONSTATÉ EN PRODUCTION (relevé du 18/09/2026, base caisse-topcenter) :
 *
 *   - notif_envois : 420 lignes statut='echec', canal='email', du
 *     2026-05-09 13:06:35 au 2026-09-14 11:13:56, toutes avec la même
 *     erreur — Missing credentials for "PLAIN". Aucune ligne statut='envoye'.
 *     Le courriel sortant n'a donc jamais fonctionné depuis la mise en service.
 *   - audit_logs : 26 lignes table_name='email', action='failed', du
 *     2026-09-10 07:42:11 au 2026-09-15 08:23:12 — ALRT_DEC_SOUMIS ×16 et
 *     RAP_DGI_MENSUEL ×10. Les alertes « décaissement soumis » ne sont pas
 *     remises : personne n'est prévenu qu'une dépense attend sa signature.
 *   - 19 lignes restent bloquées en statut='en_attente' depuis le 2026-07-09.
 *
 * CAUSE : aucune source ne fournit le mot de passe SMTP. La table parametres
 * ne contient aucune clé smtp_*, le conteneur n'expose aucune variable SMTP_*,
 * et getEmailConfig() rabat smtp_pass sur '' sans rien signaler. Le transport
 * était malgré tout construit avec auth = { user, pass: '' }, ce qui fait
 * annoncer l'authentification PLAIN à Nodemailer avec un mot de passe vide.
 * L'erreur remontée — Missing credentials for "PLAIN" — ne nomme ni le
 * réglage manquant ni l'endroit où le renseigner.
 *
 * CE QUE CETTE GARDE EXIGE :
 *   1. la configuration est vérifiable avant tout envoi, et la vérification
 *      nomme précisément les réglages manquants ;
 *   2. un envoi sur configuration incomplète échoue immédiatement, avec un
 *      message qui nomme le réglage manquant, sans ouvrir de transport ;
 *   3. le message d'échec ne retombe jamais sur « Missing credentials » ;
 *   4. aucun identifiant n'est écrit en dur dans le service.
 *
 * Le test est hermétique : la base et Nodemailer sont remplacés en cache de
 * modules. Aucune connexion réseau, aucun courriel réel.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const RACINE       = path.join(__dirname, '..');
const CHEMIN_EMAIL = path.join(RACINE, 'backend', 'services', 'email.js');

const VARIABLES_SMTP = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'IMAP_HOST', 'IMAP_PORT',
];

// ── Bancs de remplacement ─────────────────────────────────────────────────────

function resoudre(depuis, requete) {
  return Module.createRequire(depuis).resolve(requete);
}

/**
 * Charge backend/services/email.js avec une base et un Nodemailer factices.
 * parametres = lignes rendues par la table parametres (production : aucune).
 */
function chargerService({ parametres = [], env = {} } = {}) {
  const cheminDb          = resoudre(CHEMIN_EMAIL, '../db');
  const cheminNodemailer  = resoudre(CHEMIN_EMAIL, 'nodemailer');

  const transportsCrees = [];
  const messagesEnvoyes = [];

  const faussDb = {
    query:   async () => parametres.map(p => ({ ...p })),
    queryOne: async () => null,
    execute: async () => ({ insertId: 0, affectedRows: 0 }),
  };

  const fauxNodemailer = {
    createTransport(options) {
      transportsCrees.push(options);
      return {
        async sendMail(msg) {
          // Reproduit le refus de Nodemailer : PLAIN annoncé sans mot de passe.
          if (options.auth && !options.auth.pass) {
            throw new Error('Missing credentials for "PLAIN"');
          }
          messagesEnvoyes.push(msg);
          return { messageId: 'banc-essai' };
        },
        async verify() {
          if (options.auth && !options.auth.pass) {
            throw new Error('Missing credentials for "PLAIN"');
          }
          return true;
        },
      };
    },
  };

  const envSauvegarde = {};
  for (const nom of VARIABLES_SMTP) {
    envSauvegarde[nom] = process.env[nom];
    if (Object.prototype.hasOwnProperty.call(env, nom)) process.env[nom] = env[nom];
    else delete process.env[nom];
  }

  const cacheSauvegarde = {
    db:         require.cache[cheminDb],
    nodemailer: require.cache[cheminNodemailer],
    email:      require.cache[CHEMIN_EMAIL],
  };

  const faux = (chemin, exports) => ({
    id: chemin, filename: chemin, loaded: true, exports, children: [], paths: [],
  });

  require.cache[cheminDb]         = faux(cheminDb, faussDb);
  require.cache[cheminNodemailer] = faux(cheminNodemailer, fauxNodemailer);
  delete require.cache[CHEMIN_EMAIL];

  let service;
  try {
    service = require(CHEMIN_EMAIL);
  } finally {
    delete require.cache[CHEMIN_EMAIL];
    for (const [cle, chemin] of [['db', cheminDb], ['nodemailer', cheminNodemailer]]) {
      if (cacheSauvegarde[cle]) require.cache[chemin] = cacheSauvegarde[cle];
      else delete require.cache[chemin];
    }
    if (cacheSauvegarde.email) require.cache[CHEMIN_EMAIL] = cacheSauvegarde.email;
    for (const nom of VARIABLES_SMTP) {
      if (envSauvegarde[nom] === undefined) delete process.env[nom];
      else process.env[nom] = envSauvegarde[nom];
    }
  }

  return { service, transportsCrees, messagesEnvoyes };
}

async function capturerRejet(promesse) {
  try {
    await promesse;
    return null;
  } catch (err) {
    return err;
  }
}

const COURRIEL = {
  to:      'destinataire@exemple.invalid',
  subject: 'Banc d\'essai',
  html:    '<p>Banc d\'essai</p>',
};

// ── 1. La configuration incomplète est détectée et nommée ─────────────────────

async function laConfigurationIncompleteEstNommee() {
  const { service } = chargerService({ parametres: [] });

  assert.strictEqual(
    typeof service.verifierConfigEmail, 'function',
    'backend/services/email.js doit exporter verifierConfigEmail() : sans vérification, '
    + 'la configuration incomplète ne se voit qu\'au 420e échec dans notif_envois.'
  );

  const cfg     = await service.getEmailConfig();
  const verdict = service.verifierConfigEmail(cfg);

  assert.strictEqual(
    verdict.complete, false,
    'Sans aucune clé smtp_* en base ni variable SMTP_* dans l\'environnement, '
    + 'la configuration ne peut pas être déclarée complète.'
  );
  assert(
    Array.isArray(verdict.manquants) && verdict.manquants.includes('smtp_pass'),
    `Le réglage manquant doit être nommé. Reçu : ${JSON.stringify(verdict.manquants)}`
  );

  const rapport = JSON.stringify(verdict);
  assert(
    !/Missing credentials/i.test(rapport),
    'Le verdict doit nommer le réglage manquant, pas recopier l\'erreur de Nodemailer.'
  );
}

// ── 2. Une configuration complète passe ───────────────────────────────────────

async function laConfigurationCompletePasse() {
  const { service, messagesEnvoyes } = chargerService({
    parametres: [
      { cle: 'smtp_host', valeur: 'mail.exemple.invalid' },
      { cle: 'smtp_port', valeur: '587' },
      { cle: 'smtp_user', valeur: 'boite@exemple.invalid' },
      { cle: 'smtp_pass', valeur: 'valeur-de-banc-essai' },
      { cle: 'smtp_from', valeur: 'Banc <boite@exemple.invalid>' },
    ],
  });

  const cfg     = await service.getEmailConfig();
  const verdict = service.verifierConfigEmail(cfg);

  assert.strictEqual(
    verdict.complete, true,
    `Une configuration complète ne doit rien réclamer. Reçu : ${JSON.stringify(verdict.manquants)}`
  );

  await service.sendMail(COURRIEL);
  assert.strictEqual(
    messagesEnvoyes.length, 1,
    'Configuration complète : l\'envoi doit être remis au transport.'
  );
}

// ── 3. L'envoi échoue vite, en nommant le réglage manquant ────────────────────

async function lEnvoiEchoueVitEtNommeLeReglage() {
  const { service, transportsCrees } = chargerService({ parametres: [] });

  const err = await capturerRejet(service.sendMail(COURRIEL));

  assert(err, 'Sans mot de passe SMTP, sendMail() doit rejeter, pas résoudre en silence.');
  assert(
    !/Missing credentials/i.test(err.message),
    'C\'est exactement le message opaque écrit 420 fois dans notif_envois.erreur. '
    + `L'échec doit nommer le réglage manquant. Reçu : ${err.message}`
  );
  assert(
    /smtp_pass/.test(err.message),
    `Le message d'échec doit nommer smtp_pass. Reçu : ${err.message}`
  );
  assert.strictEqual(
    transportsCrees.length, 0,
    'Configuration incomplète : aucun transport ne doit être ouvert — l\'échec doit '
    + 'être constaté avant toute tentative de connexion SMTP.'
  );
}

// ── 4. Le test de connexion échoue de la même façon ───────────────────────────

async function leTestDeConnexionEchoueDeLaMemeFacon() {
  const { service, transportsCrees } = chargerService({ parametres: [] });

  const err = await capturerRejet(service.testConnection());

  assert(err, 'testConnection() doit rejeter quand la configuration est incomplète.');
  assert(
    /smtp_pass/.test(err.message) && !/Missing credentials/i.test(err.message),
    `testConnection() doit nommer le réglage manquant. Reçu : ${err.message}`
  );
  assert.strictEqual(
    transportsCrees.length, 0,
    'testConnection() ne doit pas ouvrir de transport sur configuration incomplète.'
  );
}

// ── 5. Le transport n'annonce jamais PLAIN sans mot de passe ──────────────────

async function leTransportNAnnoncePasPlainAVide() {
  /* On mesure le transport reellement construit, pas la forme du code. La
     premiere version de cette garde exigeait la syntaxe « auth: » alors que
     le service ecrit « options.auth = … » a l'interieur d'un « if » — plus
     juste, puisque conditionnel — et elle serait passee au vert sur une
     affectation posee sans condition, c'est-a-dire sur le defaut meme. */
  const { service, transportsCrees } = chargerService({
    parametres: [
      { cle: 'smtp_host', valeur: 'mail.exemple.invalid' },
      { cle: 'smtp_port', valeur: '587' },
      { cle: 'smtp_user', valeur: 'boite@exemple.invalid' },
      { cle: 'smtp_pass', valeur: 'valeur-de-banc-essai' },
      { cle: 'smtp_from', valeur: 'Banc <boite@exemple.invalid>' },
    ],
  });

  await service.sendMail({
    to: 'destinataire@exemple.invalid',
    subject: 'Banc',
    html: '<p>Banc</p>',
  });

  assert.strictEqual(
    transportsCrees.length, 1,
    'Une configuration complete doit ouvrir un transport.'
  );
  assert.deepStrictEqual(
    transportsCrees[0].auth,
    { user: 'boite@exemple.invalid', pass: 'valeur-de-banc-essai' },
    'Le service doit toujours savoir s\'authentifier quand les identifiants existent.'
  );

  /* Et l'affectation doit rester gardee par la presence des DEUX identifiants :
     c'est la regle, pas la syntaxe. Un bloc auth au mot de passe vide fait
     annoncer PLAIN a Nodemailer, d'ou « Missing credentials for "PLAIN" ». */
  const source = fs.readFileSync(CHEMIN_EMAIL, 'utf8');
  const bloc = (source.match(/function buildTransporter[\s\S]*?\n\}/) || [])[0] || '';
  assert(bloc, 'buildTransporter doit rester identifiable.');
  /* On ne decrit pas la condition par une expression reguliere : la mienne
     s'arretait au premier « ) » et ne traversait donc pas estRenseigne(...).
     On lit ce qui precede l'affectation, et on verifie que les deux
     identifiants y sont nommes — c'est la regle, quelle qu'en soit l'ecriture. */
  const iAuth = bloc.indexOf('.auth');
  assert(iAuth !== -1, 'buildTransporter doit poser une authentification.');
  const avantAuth = bloc.slice(0, iAuth);
  const iSi = avantAuth.lastIndexOf('if');
  const condition = iSi === -1 ? '' : avantAuth.slice(iSi);
  assert(
    /smtp_user/.test(condition) && /smtp_pass/.test(condition),
    'L authentification ne doit etre posee qu apres verification des deux identifiants.'
  );
}

// ── 6. Aucun identifiant en dur ───────────────────────────────────────────────

function aucunIdentifiantEnDur() {
  const source = fs.readFileSync(CHEMIN_EMAIL, 'utf8');
  const lignes = source.split(/\r?\n/);

  lignes.forEach((ligne, index) => {
    const suspecte = /(smtp_pass|pass|password|mot_de_passe)\s*[:=]\s*['"`][^'"`]+['"`]/i.test(ligne)
      && !/process\.env/.test(ligne)
      && !/\|\|\s*['"`]{2}/.test(ligne);
    assert(
      !suspecte,
      `backend/services/email.js:${index + 1} — un identifiant ne doit jamais être écrit `
      + 'en dur dans le code versionné.'
    );
  });
}

// ── Exécution ─────────────────────────────────────────────────────────────────

async function main() {
  const epreuves = [
    ['La configuration incomplète est détectée et nommée',      laConfigurationIncompleteEstNommee],
    ['Une configuration complète passe',                        laConfigurationCompletePasse],
    ['L\'envoi échoue vite en nommant le réglage manquant',     lEnvoiEchoueVitEtNommeLeReglage],
    ['Le test de connexion échoue de la même façon',            leTestDeConnexionEchoueDeLaMemeFacon],
    ['Le transport n\'annonce pas PLAIN sans mot de passe',     leTransportNAnnoncePasPlainAVide],
    ['Aucun identifiant en dur dans le service',                aucunIdentifiantEnDur],
  ];

  for (const [nom, epreuve] of epreuves) {
    await epreuve();
    console.log(`  ok — ${nom}`);
  }
  console.log('courriels_identifiants_manquants_test.js : OK');
}

main().catch(err => {
  console.error(`courriels_identifiants_manquants_test.js : ÉCHEC — ${err.message}`);
  process.exit(1);
});

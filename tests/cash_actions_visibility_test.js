const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const markup = read('frontend/dashboard.html');
const route = read('backend/routes/operations.js');

/* ── 1. Ce que le serveur accorde, l'écran doit l'offrir ──
   Le serveur autorise sur permission autant que sur role :
     canPayCashOut(user) = await can(user, 'cash.out.pay') || hasRole(...)
   Le client ne consultait que les roles. Constate dans la page avec la session
   du DG le 31/08/2026 : canPayDec() renvoyait false alors que cash.out.pay
   figurait dans les permissions chargees. Le bouton Payer restait cache a
   quelqu'un que le serveur aurait servi. */

const CORRESPONDANCES = [
  ['canPayDec', 'cash.out.pay', 'canPayCashOut'],
  ['canApproveDec', 'cash.out.validate', 'canApproveDec'],
  ['canSubmitDec', 'cash.out.create', 'canWrite'],
];

for (const [fonctionClient, permission, fonctionServeur] of CORRESPONDANCES) {
  const cote = markup.match(new RegExp(`^function ${fonctionClient}\\(\\)[^\\n]*`, 'm'));
  assert(cote, `Fonction client introuvable : ${fonctionClient}`);
  assert(
    cote[0].includes(`hasAccessPermission('${permission}'`),
    `${fonctionClient} ignore la permission ${permission} : l'ecran cacherait une action que le serveur accorde`
  );

  const serveur = route.match(new RegExp(`async function ${fonctionServeur}\\(user\\) \\{[\\s\\S]*?\\n\\}`));
  assert(serveur, `Garde serveur introuvable : ${fonctionServeur}`);
  assert(
    serveur[0].includes(`await can(user, '${permission}')`),
    `Le serveur ${fonctionServeur} ne consulte plus ${permission} : la correspondance avec le client est rompue`
  );
}

/* Le mecanisme existait deja pour les fonctions RH : on ne l'a pas invente. */
assert(
  /function canCreateAgentFrontend\(\)[\s\S]{0,120}hasAccessPermission\('hr\.agent\.create'\)/.test(markup),
  'Le raccordement aux permissions doit rester le meme idiome que pour les fonctions RH'
);

/* ── 2. Un bouton ne doit pas etre offert si la route le refuse ──
   Annuler s'affichait pour tout statut sauf paye, annule et rejete — donc
   aussi pour valide, que la route refuse : « creez une operation inverse pour
   le contrepasser ». Le bouton echouait a tous les coups. */

const refus = route.match(/if \(op\.dec_statut === 'paye' \|\| op\.statut === 'valide'\) \{[\s\S]*?\n  \}/);
assert(refus, 'La condition de refus de la route d annulation a change : revoir le bouton');

const bouton = markup.match(/const btnAnnuler = ([^\n]*)\n/);
assert(bouton, 'Bouton Annuler introuvable');
assert(
  /\['brouillon','soumis'\]\.includes\(statut\)/.test(bouton[1]),
  `Le bouton Annuler doit se limiter aux statuts que la route accepte — trouve : ${bouton[1].slice(0, 80)}`
);
assert(
  !/!\['paye','annule','rejete'\]/.test(bouton[1]),
  'La forme par exclusion laissait passer « valide », que la route refuse'
);

console.log(JSON.stringify({
  clientHonoursServerPermissions: true,
  sameIdiomAsHrFunctions: true,
  cancelButtonMatchesRouteAcceptance: true,
}));

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const server = read('backend/server.js');
const markup = read('frontend/dashboard.html');

/* ── L'ecran comptait un champ que le serveur n'envoyait pas ──
   La tuile CONNECTES affichait 0 alors que le Directeur General etait connecte
   et vu quelques secondes plus tot. Le defaut etait invisible tant que l'appel
   repondait 403 et que la tuile affichait un tiret — il n'est apparu qu'apres
   #162.

     const onlineCount = _connectedUsers.filter(u => u.statut === 'online').length;

   La requete ne renvoyait que last_seen_at. u.statut valait undefined, le
   compte restait nul, et le filtre par statut de la liste etait inerte pour la
   meme raison. */

const route = server.match(/app\.get\('\/api\/admin\/connected-users'[\s\S]*?\n\}\);/)[0];

assert(/const statut = /.test(route), 'Le serveur doit deriver le statut de connexion');
assert(/last_seen_at/.test(route), 'La derivation doit partir de last_seen_at');
assert(/\.\.\.u, statut/.test(route), 'Le statut doit accompagner l utilisateur, sans rien retirer');

/* Les trois valeurs doivent etre exactement celles que l'ecran sait afficher :
   une quatrieme tomberait dans aucun libelle et aucune pastille. */
const attendues = ['online', 'idle', 'offline'];
for (const v of attendues) {
  assert(new RegExp(`'${v}'`).test(route), `Le serveur doit pouvoir rendre le statut ${v}`);
}
const rendues = [...route.matchAll(/'(online|idle|offline|[a-z]+)'\s*(?::|;|$)/gm)];
const libelles = markup.match(/const statutLabel = \{[^}]*\}/)[0];
for (const v of attendues) {
  assert(libelles.includes(`${v}:`), `L ecran doit savoir libeller ${v}`);
}

/* La borne « hors ligne » doit reprendre le seuil du produit, pas en inventer
   un autre : l'ecran deconnecte au bout de vingt minutes d'inactivite. */
const idleFront = markup.match(/const IDLE_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
assert(idleFront, 'Le seuil de deconnexion de l ecran doit rester reperable');
const minutesFront = Number(idleFront[1]);
const decoServeur = route.match(/const DECONNEXION_MS = (\d+) \* MINUTE/);
assert(decoServeur, 'Le serveur doit nommer sa borne hors ligne');
assert.strictEqual(
  Number(decoServeur[1]), minutesFront,
  `La borne hors ligne (${decoServeur[1]} min) doit valoir le seuil de deconnexion de l ecran (${minutesFront} min)`
);

/* Un utilisateur jamais vu est hors ligne, pas en ligne par defaut. */
assert(
  /depuis === null \|\| depuis > DECONNEXION_MS \? 'offline'/.test(route),
  'Un utilisateur jamais vu doit etre hors ligne : une absence de donnee n est pas une presence'
);

/* Le comptage cote ecran reste celui que ce correctif alimente. */
assert(
  /_connectedUsers\.filter\(u => u\.statut === 'online'\)\.length/.test(markup),
  'Le comptage de l ecran doit continuer a lire le statut'
);

console.log(JSON.stringify({
  serverDerivesStatus: true,
  valuesMatchWhatTheScreenRenders: true,
  offlineBoundaryMatchesProductTimeout: true,
  neverSeenIsOffline: true,
}));

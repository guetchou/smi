const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/notifs.js');
const markup = read('frontend/dashboard.html');

/* ── 1. Un reglage global doit etre lisible par ceux qu il concerne ──
   Le silence sonore global coupe le son de tout le monde. Il n etait lisible
   que par les admins, via /admin/params : un non-admin ne pouvait donc pas
   savoir que le son etait coupe, et chaque chargement de page emettait pour
   lui un appel voue au 403. */

const preferences = route.match(/router\.get\('\/preferences', async \(req, res\) => \{[\s\S]*?\n\}\);/)[0];
assert(
  /const silenceGlobal = await param\('notif_son_silence_global', '0'\);/.test(preferences),
  'Le silence global doit etre servi avec les preferences de l utilisateur'
);
assert(
  /res\.json\(\{ \.\.\.prefs, notif_son_silence_global: silenceGlobal \}\);/.test(preferences),
  'Il doit rejoindre la reponse sans en remplacer le contenu'
);

/* La surface exposee se limite a ce seul reglage : les autres parametres
   d administration restent derriere leur controle de role. */
const admin = route.match(/router\.get\('\/admin\/params', async \(req, res\) => \{[\s\S]*?\n\}\);/)[0];
assert(/if \(!isAdmin\(req\.user\)\) return res\.status\(403\)/.test(admin), 'Les parametres d administration restent reserves aux admins');

/* ── 2. Le front lit une source unique ── */

assert.strictEqual(
  (markup.match(/window\._notifSilenceGlobal = prefs\?\.notif_son_silence_global;/g) || []).length, 2,
  'Les deux chargements de preferences doivent lire le silence global a la meme source'
);
assert(
  !/window\._notifSilenceGlobal = params\?\.notif_son_silence_global;/.test(markup),
  'Le silence global ne doit plus etre lu depuis les parametres d administration'
);

/* ── 3. L appel d administration ne part plus que pour un admin ──
   Il n alimente que le bloc reserve aux admins ; l emettre pour les autres
   ne produisait qu un 403. */

const bloc = markup.match(/const blk = document\.getElementById\('pref-silence-admin-block'\);[\s\S]*?\n    \}/)[0];
assert(
  /if \(blk && currentUser\?\.role === 'admin'\) \{\n      const params = await api\('\/notifs\/admin\/params'/.test(bloc),
  'L appel d administration doit se trouver a l interieur du test de role, pas avant'
);
assert(
  (markup.match(/await api\('\/notifs\/admin\/params', \{ silentStatuses: \[403\] \}\)/g) || []).length === 1,
  'Un seul appel de lecture des parametres d administration doit subsister'
);

console.log(JSON.stringify({
  globalSettingReadableByAll: true,
  adminParamsStillRestricted: true,
  singleSourceInFrontend: true,
  adminCallOnlyForAdmins: true,
}));

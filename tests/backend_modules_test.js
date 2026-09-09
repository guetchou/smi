'use strict';
/*
 * Garde — une route doit exiger au moins un module qui existe.
 *
 * Pendant du garde de pages_modules_test.js, côté serveur. Le 08/09/2026, la
 * navigation a été corrigée : PAGE_MODULES.dashboard citait « dashboard », un
 * module qui n'existe pas, et la page était refusée à tous sauf aux
 * administrateurs. L'entrée de menu est revenue.
 *
 * La même ligne, côté serveur, n'a pas été touchée :
 *
 *     app.use('/api/dashboard', protectedRoute(requireModule('dashboard')), …)
 *
 * Mesuré le 09/09/2026 dans les journaux d'accès, sur la session de la
 * personne qui s'en plaignait : « GET /api/dashboard/home 403 » pour elle,
 * « 200 » pour l'administrateur à la même minute. Elle voyait donc l'écran
 * revenu, et l'écran lui répondait une erreur.
 *
 * canAccessModule rend true d'emblée pour un administrateur, avant même de
 * regarder les modules : c'est ce raccourci qui rend ce défaut invisible
 * depuis un compte de direction. Cette garde est le seul filet pour les
 * autres rôles — elle vaut pour toutes les routes, pas seulement celle-ci.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const serveur = fs.readFileSync(path.join(racine, 'backend', 'server.js'), 'utf8');

/* Le catalogue des modules, lu à la source plutôt que recopié — même lecture
   que la garde des pages, pour que les deux disent la même chose. */
const sources = [
  fs.readFileSync(path.join(racine, 'backend', 'database.js'), 'utf8'),
  ...fs.readdirSync(path.join(racine, 'backend', 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => fs.readFileSync(path.join(racine, 'backend', 'migrations', f), 'utf8')),
].join('\n');

const modulesDeclares = new Set();
for (const m of sources.matchAll(/'[a-z_]+\.[a-z_.]+'\s*,\s*'([a-z_]+)'/gi)) {
  modulesDeclares.add(m[1]);
}
// « pointeuse » est accordé à tout le monde sans permission : canAccessModule
// le rend vrai d'office. Il est donc légitime sans exister en base.
modulesDeclares.add('pointeuse');

/* La garde doit échouer si elle compare contre une liste incomplète — sinon
   elle crierait au loup sur des modules parfaitement valides. */
assert(
  modulesDeclares.size >= 10,
  `Trop peu de modules relevés (${modulesDeclares.size}) : la définition des `
  + 'permissions a changé de forme, cette garde doit être revue avant d\'être crue'
);
['cash', 'hr', 'salary', 'purchase', 'audit', 'org'].forEach(attendu => {
  assert(
    modulesDeclares.has(attendu),
    `Le module « ${attendu} » doit être relevé : sinon la comparaison porte sur une liste incomplète`
  );
});

/* ── Le contrôle ── */
const inatteignables = [];
let gardesExaminees = 0;

for (const appel of serveur.matchAll(/requireModule\(\s*(\[[^\]]*\]|'[^']*')\s*\)/g)) {
  const modules = [...appel[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!modules.length) continue;
  gardesExaminees++;
  if (!modules.some(m => modulesDeclares.has(m))) {
    // La ligne concernée, pour que l'échec désigne la route et pas seulement le motif.
    const ligne = serveur.slice(0, appel.index).split('\n').length;
    inatteignables.push(
      `backend/server.js:${ligne} n'exige que ${modules.map(m => `« ${m} »`).join(', ')}`
    );
  }
}

assert(
  gardesExaminees >= 15,
  `Trop peu de gardes examinées (${gardesExaminees}) : le motif de lecture a changé`
);

assert.deepStrictEqual(
  inatteignables, [],
  'Route qu\'aucun module existant ne peut ouvrir — refusée à tous sauf aux '
  + 'administrateurs :\n  ' + inatteignables.join('\n  ')
);

/* ── Les deux cas mesurés ── */

// L'accueil choisit déjà la vue selon le rôle et retombe sur « operationnel » :
// il est fait pour tout compte connecté. Les agrégats de trésorerie et de paie
// que porte le même routeur gardent, eux, une exigence de module.
assert(
  /req\.path === '\/home'\) return next\(\)/.test(serveur),
  'GET /api/dashboard/home doit rester ouvert à tout compte connecté : '
  + 'la vue est déjà choisie selon le rôle côté routeur'
);

// Le bandeau affiche la raison sociale et le logo à tout le monde. Lire
// l'identité de l'entreprise n'est pas un réglage ; l'écrire en reste un.
assert(
  /req\.path === '\/'\) return next\(\)/.test(serveur),
  'GET /api/entreprise doit rester lisible par tout compte connecté : '
  + 'le bandeau de chaque écran affiche la raison sociale et le logo'
);
assert(
  /requireModule\(\['settings', 'access'\]\)\(req, res, next\)/.test(serveur),
  'Les écritures sur l\'entreprise doivent rester derrière « settings » ou « access »'
);

/* ── Le raccourci administrateur ne doit pas masquer la panne ── */
const controle = serveur.slice(
  serveur.indexOf('async function canAccessModule('),
  serveur.indexOf('function requireModule('));
assert(
  /hasRole\(user, 'admin'\)/.test(controle),
  'Le raccourci administrateur existe toujours : cette garde couvre ce qu\'il masque'
);

console.log(JSON.stringify({
  modulesReadFromSource: modulesDeclares.size,
  guardsChecked: gardesExaminees,
  unreachable: inatteignables.length,
}));

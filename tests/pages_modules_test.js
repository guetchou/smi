'use strict';

/*
 * Garde — une page doit exiger au moins un module qui existe.
 *
 * Constaté le 08/09/2026, en jouant le parcours d'une caissière à l'écran.
 * Louvouezo était connectée et active, mais aucune opération n'atteignait le
 * serveur et aucun refus n'était journalisé. Cause : elle arrivait sur la
 * Pointeuse, et son menu n'avait aucune entrée « Tableau de bord » — la page
 * qui porte Encaisser, Décaisser, Transfert et Clôture. Un clic impossible ne
 * laisse aucune trace : ni succès, ni refus, rien à chercher dans les journaux.
 *
 * PAGE_MODULES.dashboard valait ['dashboard']. Ce module n'existe pas et n'a
 * jamais existé. canAccessPage fait modules.some(canAccessModule) : aucun
 * module valide, donc aucune correspondance possible, donc page refusée — sauf
 * aux administrateurs, pour qui canAccessPage rend true avant même de regarder
 * les modules. C'est ce raccourci qui a rendu la panne invisible côté
 * direction, alors qu'elle bloquait tous les autres rôles.
 *
 * Même défaut sur produits, qui exigeait « stock » : c'est « purchase » qui
 * porte stock.manage.
 *
 * La garde vérifie qu'au moins un module cité existe. Une page qui en cite un
 * inconnu À CÔTÉ d'un module valide reste joignable — c'est le cas des deux
 * pages de comptabilité, qui citent « accounting » aux côtés de « cash » ; une
 * autre garde fige d'ailleurs cette forme. Le défaut visé ici, c'est la page
 * qu'aucun module valide ne peut ouvrir.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const navigation = fs.readFileSync(
  path.join(racine, 'frontend', 'js', 'core', 'navigation.js'), 'utf8');

/* Les modules qui existent réellement, lus à la source plutôt que recopiés :
   si un module est ajouté demain, la garde le voit sans être modifiée. Le
   catalogue vit dans database.js sous la forme
   ['cash.in.create','cash','in.create','Créer encaissement',0]. */
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
  `Trop peu de modules relevés (${modulesDeclares.size}) : la définition des ` +
  'permissions a changé de forme, cette garde doit être revue avant d\'être crue'
);
['cash', 'hr', 'salary', 'purchase', 'audit', 'org'].forEach(attendu => {
  assert(
    modulesDeclares.has(attendu),
    `Le module « ${attendu} » doit être relevé : sinon la comparaison porte sur une liste incomplète`
  );
});

/* ── Le contrôle ── */
const debut = navigation.indexOf('const PAGE_MODULES = {');
assert(debut !== -1, 'PAGE_MODULES doit exister');
const bloc = navigation.slice(debut, navigation.indexOf('};', debut));

const inatteignables = [];
let pagesExaminees = 0;
for (const entree of bloc.matchAll(/(?:^|\n)\s*('?[a-zA-Z0-9_-]+'?)\s*:\s*\[([^\]]*)\]/g)) {
  const page = entree[1].replace(/'/g, '');
  const modules = [...entree[2].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!modules.length) continue;
  pagesExaminees++;
  if (!modules.some(m => modulesDeclares.has(m))) {
    inatteignables.push(`${page} n'exige que ${modules.map(m => `« ${m} »`).join(', ')}`);
  }
}

assert(pagesExaminees >= 15, `Trop peu de pages examinées (${pagesExaminees}) : le motif de lecture a changé`);

assert.deepStrictEqual(
  inatteignables, [],
  'Page qu\'aucun module existant ne peut ouvrir — refusée à tous sauf aux ' +
  'administrateurs, et sans message :\n  ' + inatteignables.join('\n  ')
);

/* ── Les deux cas mesurés ── */
assert(
  /dashboard: \['cash'\]/.test(bloc),
  'Le tableau de bord doit relever de « cash » : il porte Encaisser, Décaisser, ' +
  'Transfert et Clôture, les gestes quotidiens de la caisse'
);
assert(
  /produits: \['purchase'\]/.test(bloc),
  'La page Stock/Produits doit relever de « purchase » — c\'est lui qui porte stock.manage'
);

/* ── Le raccourci administrateur ne doit pas masquer la panne ──
   canAccessPage rend true pour un administrateur avant d'examiner les modules :
   c'est pourquoi le défaut est resté invisible. Cette garde est le seul filet
   pour les autres rôles. */
const controle = navigation.slice(
  navigation.indexOf('function canAccessPage('),
  navigation.indexOf('function firstAllowedPage('));
assert(
  /hasExactRole\('admin'\)/.test(controle),
  'Le raccourci administrateur existe toujours : cette garde couvre ce qu\'il masque'
);

console.log(JSON.stringify({
  modulesReadFromSource: modulesDeclares.size,
  pagesChecked: pagesExaminees,
  everyPageHasAtLeastOneRealModule: true,
  dashboardReachableByCashiers: true,
  stockPageReachableByPurchasing: true,
  adminShortcutCoveredByThisGuard: true,
}));

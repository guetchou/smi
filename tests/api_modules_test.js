'use strict';
/*
 * Garde — le client et le serveur exigent les mêmes modules.
 *
 * Le client cesse de demander ce qu'il n'a pas le droit de lire, à partir
 * d'une table qui reflète les gardes de backend/server.js. Deux tables tenues
 * séparément finissent par diverger — c'est exactement ce qui a produit la
 * panne de septembre 2026, où le menu proposait des écrans que l'API refusait.
 *
 * Cette garde compare les deux, dans les deux sens :
 *   - une route gardée côté serveur doit figurer côté client, sinon l'agent
 *     redemande ce qui lui sera refusé et voit une erreur ;
 *   - une entrée côté client sans garde côté serveur ferait taire une requête
 *     parfaitement légitime.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const serveur = fs.readFileSync(path.join(racine, 'backend', 'server.js'), 'utf8');
const transport = fs.readFileSync(
  path.join(racine, 'frontend', 'js', 'core', 'transport.js'), 'utf8');

/* ── Ce que le serveur exige ── */
const cotéServeur = new Map();
for (const m of serveur.matchAll(
  /app\.use\(\s*'(\/api\/[^']*)'\s*,\s*protectedRoute\(([^\n]*)/g)) {
  const appel = m[2].match(/requireModule\(\s*(\[[^\]]*\]|'[^']*')\s*\)/);
  if (!appel) continue;
  const modules = [...appel[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  if (!cotéServeur.has(m[1])) cotéServeur.set(m[1], modules);
}

assert(
  cotéServeur.size >= 15,
  `Trop peu de gardes relevées côté serveur (${cotéServeur.size}) : le motif de lecture a changé`
);

/* ── Ce que le client s'interdit ── */
const debut = transport.indexOf('const API_MODULES = [');
assert(debut !== -1, 'API_MODULES doit exister dans transport.js');
const bloc = transport.slice(debut, transport.indexOf('];', debut));

const cotéClient = new Map();
for (const e of bloc.matchAll(/\[\s*'(\/api\/[^']+)'\s*,\s*\[([^\]]*)\]\s*\]/g)) {
  cotéClient.set(e[1], [...e[2].matchAll(/'([^']+)'/g)].map(x => x[1]).sort());
}

assert(
  cotéClient.size >= 15,
  `Trop peu d'entrées relevées côté client (${cotéClient.size}) : le motif de lecture a changé`
);

/* ── La comparaison ── */
const manquantes = [];
const surnuméraires = [];
const divergentes = [];

for (const [chemin, modules] of cotéServeur) {
  if (!cotéClient.has(chemin)) {
    manquantes.push(`${chemin} exige ${modules.join('|')} côté serveur, absent côté client`);
    continue;
  }
  const client = cotéClient.get(chemin);
  if (client.join('|') !== modules.join('|')) {
    divergentes.push(`${chemin} : serveur ${modules.join('|')} ≠ client ${client.join('|')}`);
  }
}

for (const chemin of cotéClient.keys()) {
  if (!cotéServeur.has(chemin)) {
    surnuméraires.push(`${chemin} restreint côté client sans garde côté serveur`);
  }
}

assert.deepStrictEqual(
  manquantes, [],
  'Route gardée côté serveur mais pas côté client — l\'agent la demande et '
  + 'reçoit une erreur qu\'il ne peut pas traiter :\n  ' + manquantes.join('\n  ')
);
assert.deepStrictEqual(
  surnuméraires, [],
  'Entrée cliente sans garde côté serveur — elle ferait taire une requête '
  + 'légitime :\n  ' + surnuméraires.join('\n  ')
);
assert.deepStrictEqual(
  divergentes, [],
  'Les deux tables n\'exigent pas la même chose :\n  ' + divergentes.join('\n  ')
);

/* ── L'administrateur n'est pas restreint ── */
assert(
  /hasExactRole\('admin'\) \? null : currentAccessModules/.test(
    fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8')),
  'Un administrateur ne doit pas être restreint côté client : canAccessModule '
  + 'le laisse passer d\'emblée côté serveur, les deux doivent dire pareil'
);

console.log(JSON.stringify({
  serverGuards: cotéServeur.size,
  clientEntries: cotéClient.size,
  mismatches: manquantes.length + surnuméraires.length + divergentes.length,
}));

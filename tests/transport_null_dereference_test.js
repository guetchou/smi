const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const markup = read('frontend/dashboard.html');
const transport = read('frontend/js/core/transport.js');

/* ── 1. Le contrat du transport ──
   Il notifie puis retourne null. Il ne leve pas. Tout le reste de ce test
   decoule de ce choix : si un jour le transport se met a lever, cette
   assertion tombe et le garde-fou ci-dessous doit etre revu. */

const echec = transport.match(/if \(!res\.ok\) \{[\s\S]*?\n          \}/)[0];
assert(/silentStatuses\.includes\(res\.status\)/.test(echec), 'Le transport doit offrir un moyen de taire un statut attendu');
assert(/notify\(formatErrorMessage\(data, res\.status\), 'error'\);/.test(echec), 'Le transport notifie l erreur lui-meme');
assert(/return null;/.test(echec), 'Le transport retourne null au lieu de lever');
assert(!/throw /.test(echec), 'Si le transport se met a lever, ce garde-fou doit etre revu');

/* ── 2. Aucun resultat d appel ne doit etre deference sans precaution ──
   Un catch place apres un api() ne rattrape pas l echec HTTP — rien n est
   leve a ce moment-la. Il rattrape le deferencement du null qui suit, ce qui
   interrompt le bloc au milieu : une liste deroulante reste vide, et le reste
   du bloc n est jamais atteint. Le symptome est muet.

   Un try imbrique ferait deborder la capture sur des fonctions voisines :
   on ne retient que les blocs sans imbrication. */

const MOTIF = /try\s*\{((?:(?!try\s*\{)[\s\S])*?)\}\s*catch\s*\(_\)\s*\{\s*\}/g;
const blocs = [...markup.matchAll(MOTIF)].map(m => m[1]);

assert(blocs.length >= 20, `Trop peu de blocs analyses (${blocs.length}) : le motif de detection a change`);
assert(Math.max(...blocs.map(b => b.length)) < 6000, 'Un bloc capture deborde : le motif ratisse trop large');

const fautes = [];
for (const bloc of blocs) {
  for (const m of bloc.matchAll(/const\s+(\w+)\s*=\s*await\s+(?:api|apiGet)\(/g)) {
    const nom = m[1];
    for (const d of bloc.matchAll(new RegExp(`\\b${nom}\\.(?!\\.)`, 'g'))) {
      if (bloc.slice(d.index - 1, d.index) === '?') continue;
      fautes.push(`${nom} : ${bloc.slice(d.index, d.index + 48).split('\n')[0]}`);
    }
  }
}

assert.deepStrictEqual(
  fautes, [],
  'Resultat d appel deference sans acces optionnel — le transport peut retourner null :\n  ' + fautes.join('\n  ')
);

/* ── 3. Le mecanisme prevu doit rester utilise pour les echecs attendus ── */

assert(
  /silentStatuses: \[403\]/.test(markup) && /silentStatuses: \[404\]/.test(markup),
  'Un statut attendu se declare silencieux a l appel, pas se rattrape apres coup'
);

/* ── 4. Un module ne doit pas reimplementer le transport pour lire ──
   Mesure en production : un chargement de page emettait 13 requetes vers les
   quatre referentiels d organisation, depuis quatre modules chargeant chacun
   les memes donnees. Trois avaient leur propre fetch : ils ignoraient le
   cache et la deduplication du transport, et s ignoraient entre eux.

   Les ecritures gardent le chemin direct — aucune n est concernee par le
   cache — mais les lectures doivent passer par la porte commune. */

for (const module of ['agent-organization', 'org-mutation-workflow-ui', 'org-departments-core']) {
  const src = read(`frontend/js/modules/${module}.js`);

  assert(
    /if \(String\(options\.method \|\| 'GET'\)\.toUpperCase\(\) === 'GET' && typeof window\.api === 'function'\) \{/.test(src),
    `${module} : les lectures doivent passer par le transport partage`
  );

  /* Le chemin se derive de la base du module, qui n est pas la meme partout
     (/api ici, /api/org ailleurs). Le coder en dur casserait l un des trois. */
  assert(
    /const donnees = await window\.api\(API_(?:ROOT|BASE)\.replace\(\/\^\\\/api\/, ''\) \+ path, options\);/.test(src),
    `${module} : le chemin doit se deriver de la base du module, pas etre code en dur`
  );

  /* Le transport notifie et rend null ; ces fonctions levent. La delegation
     ne doit pas changer ce que leurs appelants attendent. */
  assert(
    /if \(donnees === null\) throw new Error\('Erreur de chargement'\);/.test(src),
    `${module} : le contrat de levee doit etre conserve`
  );

  /* Le repli direct doit rester : ces modules peuvent se charger avant que
     la page n ait defini api. */
  assert(/await fetch\(/.test(src), `${module} : le repli direct doit subsister`);
}
console.log(JSON.stringify({
  transportContractUnchanged: true,
  blocksScanned: blocs.length,
  largestBlockBounded: true,
  noUnguardedDereference: true,
  silentStatusesUsedForExpectedFailures: true,
  readsGoThroughSharedTransport: true,
}));

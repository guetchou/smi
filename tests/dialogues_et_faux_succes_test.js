'use strict';

/*
 * Garde — deux dettes mesurées le 07/09/2026, et ce qui les empêche de revenir.
 *
 * ─── Dette 1 : le faux succès ───
 *
 * Le transport rend null quand une requête échoue (401, statut non-ok, panne
 * réseau) et notifie lui-même. Il ne lève jamais. Douze appelants ne lisaient
 * pas ce retour et annonçaient la réussite quoi qu'il arrive :
 *
 *     await apiPost('/api/factures-clients', body);
 *     showToast('Facture créée', 'success');   ← même quand rien n'est créé
 *
 * Le plus grave était une boucle de paiement de bulletins : sur dix salaires
 * dont trois refusés, l'écran affichait « 10 salaire(s) payé(s) ».
 *
 * Le contrat du transport n'est pas en cause et n'a pas été touché :
 * parseResponseJson rend {} sur corps vide, donc un succès rend TOUJOURS un
 * objet et un échec TOUJOURS null. L'échec était déjà distinguable — personne
 * ne le lisait. Le garde-fou tests/transport_null_dereference_test.js reste
 * donc valable tel quel.
 *
 * ─── Dette 2 : les dialogues natifs ───
 *
 * 42 appels à prompt(), confirm() et alert() subsistaient alors que le produit
 * a ses propres composants. Trois conséquences mesurées :
 *   — deux gestes identiques se comportaient différemment (deleteOp passait
 *     par le composant maison, annulerFacture par prompt natif) ;
 *   — un dialogue natif fige la page et bloque l'automatisation du navigateur,
 *     ce qui a empêché de tester l'annulation d'une facture en production ;
 *   — un appel s'écrivait « await confirm(...) » : l'await portait sur un
 *     booléen. Quelqu'un croyait déjà appeler le composant maison.
 *
 * Aucun texte affiché n'a été modifié : les chaînes existantes ont été reprises
 * telles quelles, seul le mécanisme d'affichage change.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const markup = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');
const lignes = markup.split('\n');

/* ── 1. Les composants maison existent et restent asynchrones ── */
['showConfirm', 'showPrompt'].forEach(nom => {
  assert(
    new RegExp(`async function ${nom}\\(`).test(markup),
    `${nom} doit exister et être asynchrone : les remplacements en dépendent`
  );
});
assert(/function showToast\(/.test(markup), 'showToast doit exister');

/* ── 2. Plus aucun dialogue natif ──
   Un dialogue natif fige la page : il bloque l'utilisateur comme il bloque
   toute vérification automatisée de l'écran. */
const NATIFS = {
  'prompt(': /(?<![.\w$])prompt\s*\(/,
  'confirm(': /(?<![.\w$])confirm\s*\(/,
  'alert(': /(?<![.\w$])alert\s*\(/,
};
const restants = [];
lignes.forEach((l, i) => {
  if (/^\s*(\/\/|\*|<!--)/.test(l)) return;
  if (/show(Prompt|Confirm|Alert)/.test(l)) return;
  for (const [nom, re] of Object.entries(NATIFS)) {
    if (re.test(l)) restants.push(`L${i + 1} ${nom} → ${l.trim().slice(0, 70)}`);
  }
});
assert.deepStrictEqual(
  restants, [],
  'Dialogue natif réintroduit — utiliser showConfirm / showPrompt / showToast :\n  ' +
  restants.join('\n  ')
);

/* ── 3. Une mutation ne s'annonce pas réussie sans avoir été lue ──
   C'est le motif exact des douze sites corrigés. */
const MUTATION = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*await\s+(?:api|apiPost|apiPut|apiPatch|apiDelete)\(/;
const MUTATION_NUE = /^\s*await\s+(?:api|apiPost|apiPut|apiPatch|apiDelete)\(/;
const SUCCES = /showToast\(\s*[^,]+,\s*['"]success['"]/;
const EST_MUTATION = /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\bapi(?:Post|Put|Patch|Delete)\(/;

const fauxSucces = [];
for (let i = 0; i < lignes.length; i++) {
  const l = lignes[i];
  const capture = l.match(MUTATION);
  if (!capture && !MUTATION_NUE.test(l)) continue;
  if (!EST_MUTATION.test(lignes.slice(i, i + 6).join('\n'))) continue;

  const suite = lignes.slice(i + 1, i + 14).join('\n');
  const place = suite.search(SUCCES);
  if (place === -1) continue;

  const avant = suite.slice(0, place);
  const nom = capture ? capture[1] : null;
  const lu = nom
    ? new RegExp(`(if\\s*\\(\\s*!?\\s*${nom}\\b|${nom}\\s*(?:===|!==|\\?\\?|&&|\\|\\|)|if\\s*\\([^)]*\\b${nom}\\b)`).test(avant)
    : false;
  if (!lu && !/catch\s*\(/.test(avant)) {
    fauxSucces.push(`L${i + 1} → ${l.trim().slice(0, 78)}`);
  }
}
assert.deepStrictEqual(
  fauxSucces, [],
  'Mutation annoncée réussie sans que son résultat soit lu — le transport rend ' +
  'null sur échec, donc l\'écran ment :\n  ' + fauxSucces.join('\n  ')
);

/* ── 4. Le décompte annoncé est celui des réussites ──
   La boucle de paiement comptait les bulletins soumis, pas ceux payés. */
assert(
  /if \(await api\(`\/salaires\/bulletin\/\$\{e\.bulletin\.id\}\/payer`[^)]*\)\) payes\+\+;/.test(markup),
  'Le paiement groupé doit compter les paiements qui aboutissent, pas ceux tentés'
);
assert(
  /if \(payes\) showToast\(`\$\{payes\} salaire\(s\) payé\(s\)`, 'success'\);/.test(markup),
  'Le nombre annoncé doit être celui des réussites, et rien ne doit être annoncé s\'il n\'y en a aucune'
);

/* ── 5. Les soumissions de modale rendent false sur échec ──
   Rendre autre chose ferme la fenêtre et perd la saisie alors que rien n'a été
   enregistré. */
[
  "if (!await apiPost('/api/factures-clients', body)) return false;",
  "if (!await apiPost('/api/factures-clients/'+facId+'/enregistrer-paiement', body)) return false;",
].forEach(attendu => {
  assert(
    markup.includes(attendu),
    `Une soumission de modale doit rendre false sur échec pour garder la saisie : ${attendu}`
  );
});

console.log(JSON.stringify({
  inHouseDialogHelpersPresent: true,
  noNativeDialogLeft: true,
  noMutationAnnouncedWithoutReadingIt: true,
  countReportsWhatActuallySucceeded: true,
  modalSubmissionsKeepTheirInputOnFailure: true,
}));

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/operations.js');
const markup = read('frontend/dashboard.html');

/* ── Une comparaison impossible n'est pas une variation nulle ──
   Le Bilan Dirigeant affichait « ▼ 0% vs mois préc. » : un triangle descendant
   rouge sur une comparaison qui n'avait pas pu etre faite.

   MySQL rend les colonnes DECIMAL sous forme de chaines. pct recevait « 0.00 »
   et non 0 :
     !prev -> !"0.00" -> faux, la chaine n'est pas vide
     puis Math.round((0 - 0) / 0 * 100) -> NaN
   NaN se serialise en null. Cote ecran, varLabel traitait le cas 0 mais pas
   null : null === 0 est faux, null > 0 est faux, Math.abs(null) vaut 0. */

/* ── 1. La cause : convertir avant de comparer ── */

const pctSrc = route.match(/function pct\(curr, prev\) \{[\s\S]*?\n  \}/)[0];
assert(/const c = Number\(curr\) \|\| 0;/.test(pctSrc), 'La valeur courante doit etre convertie en nombre');
assert(/const p = Number\(prev\) \|\| 0;/.test(pctSrc), 'La valeur precedente doit etre convertie en nombre');
assert(/if \(!p\) return c > 0 \? 100 : 0;/.test(pctSrc), 'Le test du diviseur nul doit porter sur le nombre, pas sur la chaine');
assert(!/if \(!prev\)/.test(pctSrc), 'Le test sur la valeur brute laissait passer « 0.00 »');

/* Le comportement, verifie sur les formes que MySQL renvoie reellement. */
const pct = new Function('curr', 'prev', pctSrc.replace(/^function pct\(curr, prev\) \{/, '').replace(/\}$/, ''));
for (const [curr, prev, attendu] of [
  ['0.00', '0.00', 0],
  ['0.00', '1000.00', -100],
  ['1500.00', '1000.00', 50],
  ['2000.00', '0.00', 100],
  [0, 0, 0],
]) {
  const obtenu = pct(curr, prev);
  assert.strictEqual(
    obtenu, attendu,
    `pct(${JSON.stringify(curr)}, ${JSON.stringify(prev)}) rend ${obtenu}, attendu ${attendu}`
  );
  assert(Number.isFinite(obtenu), `pct(${JSON.stringify(curr)}, ${JSON.stringify(prev)}) doit rester un nombre fini`);
}

/* ── 2. La defense : ne rien afficher plutot qu'une fausse stabilite ── */

const varLabel = markup.match(/const varLabel = \(pct, inverse = false\) => \{[\s\S]*?\n  \};/)[0];
assert(
  /if \(!Number\.isFinite\(pct\)\) return '';/.test(varLabel),
  'Une comparaison impossible ne doit rien afficher'
);
assert(
  /if \(pct === 0\) return '<span class="text-slate-500">= mois précédent<\/span>';/.test(varLabel),
  'Le cas « aucun changement » doit rester distinct, avec son libelle existant'
);

/* L'ordre compte : tester la finitude apres l'egalite a zero laisserait passer
   null, qui n'est pas egal a zero mais dont Math.abs vaut zero. */
const iFini = varLabel.indexOf('Number.isFinite');
const iZero = varLabel.indexOf('pct === 0');
assert(iFini !== -1 && iZero !== -1 && iFini < iZero, 'La finitude doit etre testee avant l egalite a zero');

/* Aucun nouveau libelle : « = mois précédent » preexistait. */
assert(
  (markup.match(/= mois précédent/g) || []).length >= 1,
  'Le libelle du cas sans changement doit rester celui du produit'
);

console.log(JSON.stringify({
  decimalStringsConvertedBeforeComparison: true,
  pctAlwaysFinite: true,
  impossibleComparisonShowsNothing: true,
  finitenessCheckedFirst: true,
  noNewCopy: true,
}));

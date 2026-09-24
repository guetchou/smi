const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/operations.js');
const migration = read('backend/migrations/050_operations_beneficiaire_et_piece.sql');
const markup = read('frontend/dashboard.html');

/* Compte les elements d'un litteral de tableau : les virgules de profondeur 0.
   Un decompte naif sur les virgules se tromperait des qu'une valeur contient un
   appel de fonction ou un ternaire entre parentheses. */
function elements(litteral) {
  let profondeur = 0, compte = 1, chaine = null;
  for (let i = 0; i < litteral.length; i++) {
    const c = litteral[i];
    if (chaine) { if (c === chaine && litteral[i - 1] !== '\\') chaine = null; continue; }
    if (c === "'" || c === '"' || c === '`') { chaine = c; continue; }
    if ('([{'.includes(c)) profondeur++;
    else if (')]}'.includes(c)) profondeur--;
    else if (c === ',' && profondeur === 0) compte++;
  }
  return compte;
}

/* ── 1. Les colonnes existent ──
   Elles n'avaient jamais existe, alors que le formulaire de decaissement
   proposait les deux listes depuis l'origine. Constate en production :
   ER_BAD_FIELD_ERROR - Unknown column 'beneficiaire_type' in 'field list'. */

assert(/ALTER TABLE operations/.test(migration), 'La migration doit porter sur la table operations');
for (const colonne of ['beneficiaire_type', 'type_piece']) {
  assert(
    new RegExp(`ADD COLUMN ${colonne} VARCHAR\\(32\\) NULL`).test(migration),
    `Colonne manquante dans la migration : ${colonne}`
  );
}

/* VARCHAR et non ENUM : l'import lit du texte libre saisi dans un tableur.
   Un ENUM rejetterait la ligne et casserait l'import que cette migration
   repare. */
/* Le mot figure dans le commentaire qui explique le choix : on ne teste que
   le SQL reellement execute. */
const sqlExecutable = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
assert(!/ENUM/.test(sqlExecutable), 'Un ENUM casserait l import, qui lit du texte libre');

/* ── 2. Le serveur connait exactement ce que le formulaire propose ──
   C'est l'invariant qui compte : ajouter une option dans la liste deroulante
   sans l'ajouter cote serveur la ferait silencieusement basculer en « autre ». */

function optionsDuSelect(id) {
  const bloc = markup.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))[0];
  return [...bloc.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean).sort();
}
function ensembleServeur(nom) {
  const bloc = route.match(new RegExp(`const ${nom} = new Set\\(\\[([^\\]]*)\\]\\)`))[1];
  return [...bloc.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
}

assert.deepStrictEqual(
  ensembleServeur('TYPES_BENEFICIAIRE'), optionsDuSelect('dec-benef-type'),
  'Les types de beneficiaire connus du serveur doivent etre exactement ceux du formulaire'
);
assert.deepStrictEqual(
  ensembleServeur('TYPES_PIECE'), optionsDuSelect('dec-type-piece'),
  'Les types de piece connus du serveur doivent etre exactement ceux du formulaire'
);

/* Une valeur vide n'est pas « autre » : elle est absente. */
const normalisation = route.match(/function valeurDeListe\(valeur, connues\) \{[\s\S]*?\n\}/)[0];
assert(/if \(!brut\) return null;/.test(normalisation), 'Une valeur vide doit rester nulle, pas devenir « autre »');
assert(/normalize\('NFD'\)/.test(normalisation), 'Les accents du tableau importe doivent etre reduits avant comparaison');
assert(/connues\.has\(normalise\) \? normalise : 'autre'/.test(normalisation), 'Une valeur inconnue doit etre rangee, pas perdue');

/* ── 3. Les deux champs traversent la saisie, la creation et la modification ── */

const normalisationEntree = route.match(/function normalizeOperationInput\(body, current = \{\}\) \{[\s\S]*?\n\}/)[0];
for (const champ of ['type_piece', 'beneficiaire_type']) {
  assert(
    new RegExp(`${champ}: valeurDeListe\\(body\\.${champ} \\?\\? current\\.${champ},`).test(normalisationEntree),
    `${champ} doit etre repris a la saisie, et conserve lors d une modification partielle`
  );
}

/* ── 4. Les colonnes et les valeurs doivent rester alignees ──
   C'est le defaut classique de ce genre d'insertion : ajouter une colonne sans
   ajouter la valeur correspondante decale toute la fin de la ligne. */

const colonnes = route.match(/const columns = \[([\s\S]*?)\];/)[1];
const valeurs = route.match(/const values = \[([\s\S]*?)\];\n  const legacy = legacyValues\(\{ libelle, num_piece, montant, type_op, solde_position: 0/)[1];
assert.strictEqual(
  elements(colonnes), elements(valeurs),
  `Creation : ${elements(colonnes)} colonnes pour ${elements(valeurs)} valeurs`
);
for (const champ of ['type_piece', 'beneficiaire_type']) {
  assert(colonnes.includes(`'${champ}'`), `Creation : ${champ} absent des colonnes`);
  assert(new RegExp(`\\b${champ}\\b`).test(valeurs), `Creation : ${champ} absent des valeurs`);
}

const assignations = route.match(/const assignments = \[([\s\S]*?)\];/)[1];
/* Il existe deux litteraux `const values` dans ce fichier, un par verbe. On
   part donc des assignations de la modification, qui n existent qu une fois. */
const apresAssignations = route.slice(route.indexOf('const assignments = ['));
const valeursMaj = apresAssignations.match(/const values = \[([\s\S]*?)\];/)[1];
/* updated_at=NOW() n'a pas de valeur liee : une assignation de plus est normale. */
assert.strictEqual(
  elements(assignations) - 1, elements(valeursMaj),
  `Modification : ${elements(assignations)} assignations pour ${elements(valeursMaj)} valeurs`
);
for (const champ of ['type_piece', 'beneficiaire_type']) {
  assert(assignations.includes(`'${champ}=?'`), `Modification : ${champ} absent des assignations`);
  assert(new RegExp(`\\b${champ}\\b`).test(valeursMaj), `Modification : ${champ} absent des valeurs`);
}

/* ── 5. L import cesse d echouer, et ce qu il ecrit est normalise ── */

assert(
  /const benef = valeurDeListe\(idxBenef !== null \? r\[idxBenef\] : null, TYPES_BENEFICIAIRE\);/.test(route),
  'L import doit normaliser la colonne du tableur avant de l ecrire'
);
/* L'import construisait son INSERT à la main, colonnes d'un côté et liste de « ? »
   de l'autre : une divergence entre les deux était possible, d'où le comptage qui
   suivait. Il les construit désormais ensemble, et engendre les placeholders à
   partir des colonnes — la divergence est devenue structurellement impossible.
   La garde vérifie donc cette construction, ce qui est plus fort que de compter
   des virgules, et elle vérifie toujours que beneficiaire_type est écrit. */
const colonnesImport = route.match(/const colonnes = \[([\s\S]*?)\];/);
assert(colonnesImport, "L'insertion de l'import doit nommer ses colonnes dans un tableau");
assert(
  colonnesImport[1].includes('beneficiaire_type'),
  "L import ecrit beneficiaire_type : la colonne doit rester nommee"
);
assert(
  /VALUES \(\$\{colonnes\.map\(\(\) => '\?'\)\.join\(','\)\}\)/.test(route),
  'Import : les valeurs doivent etre engendrees a partir des colonnes, '
  + 'pour que leur nombre ne puisse plus diverger'
);

console.log(JSON.stringify({
  columnsExist: true,
  varcharNotEnum: true,
  serverKnowsExactlyWhatTheFormOffers: true,
  emptyIsNotOther: true,
  fieldsSurviveCreateAndUpdate: true,
  columnsAndValuesAligned: true,
  csvImportNoLongerFails: true,
}));

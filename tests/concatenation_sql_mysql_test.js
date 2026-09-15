'use strict';
/*
 * Garde — le parapheur nomme qui a demandé quoi.
 *
 * Défaut du 15/09/2026, vu à l'écran puis prouvé en base. Chaque fiche du
 * parapheur — la file d'approbation du DG — affichait l'initiateur ainsi :
 *
 *     Décaissement · 0 · 2026-09-15 · 800 XAF
 *                    ^
 *
 * Cause : les requêtes concatènent avec ||.
 *
 *     TRIM(u.nom || CASE WHEN COALESCE(u.prenom,'') != ''
 *                        THEN ' ' || u.prenom ELSE '' END) AS initiateur_nom
 *
 * || concatène en SQLite et en PostgreSQL. En MySQL, c'est le OU LOGIQUE, sauf
 * si sql_mode contient PIPES_AS_CONCAT — ce qui n'est pas le cas ici :
 *
 *     ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,
 *     ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
 *
 * Les chaînes non numériques valent 0, 0 OR 0 vaut 0, et TRIM(0) rend '0'.
 * Mesuré sur la base de production :
 *
 *     id  nom          prenom       avec ||   avec CONCAT
 *      2  LOUVOUEZO    Dieuveille        0    LOUVOUEZO Dieuveille
 *      3  NGUIE        Gess              0    NGUIE Gess
 *    165  RECETTE      Agent             0    RECETTE Agent
 *
 * Le front écrit `${p.initiateur_nom || 'N/A'}` : la chaîne '0' étant vraie,
 * même le repli 'N/A' ne se déclenchait pas. La file d'approbation, qui est la
 * piste d'audit de qui a demandé quoi, ne nommait personne — y compris sur
 * l'offboarding d'une salariée, approuvé par le DG.
 *
 * Vingt requêtes étaient touchées : quinze dans parapheur.js, trois dans
 * agents.js, deux dans salaires.js.
 *
 * backend/database.js garde ses deux || : ce fichier sort dès sa sixième ligne
 * quand DB_DRIVER vaut mysql, et son code est le chemin SQLite, où || est la
 * bonne écriture. La garde ne l'inclut donc pas.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');

/* Les fichiers qui tournent sur MySQL. database.js en est exclu : il bascule
   sur mysql_sync_facade avant d'exécuter la moindre de ses requêtes. */
const CHEMIN_SQLITE = new Set(['backend/database.js']);

function fichiersJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fichiersJs(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/* Une chaîne gabarit qui contient un verbe SQL est une requête. */
function requetesDe(source) {
  const out = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    if (/\b(SELECT|UPDATE|INSERT INTO|DELETE FROM)\b/i.test(m[1])) out.push(m[1]);
  }
  return out;
}

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

verifier('aucune requete MySQL ne concatene avec ||', () => {
  const fautives = [];
  for (const f of fichiersJs(path.join(racine, 'backend'))) {
    const relatif = path.relative(racine, f).replace(/\\/g, '/');
    if (CHEMIN_SQLITE.has(relatif)) continue;
    const source = fs.readFileSync(f, 'utf8');
    for (const sql of requetesDe(source)) {
      if (!sql.includes('||')) continue;
      const ligne = sql.split('\n').find(l => l.includes('||')) || '';
      fautives.push(`${relatif} → ${ligne.trim().slice(0, 80)}`);
    }
  }
  assert.deepStrictEqual(
    fautives, [],
    'En MySQL, || est le OU logique : ces concatenations rendent 0, pas un nom.\n'
    + '        Utiliser CONCAT(). Fautives :\n        ' + fautives.join('\n        ')
  );
});

verifier('le parapheur compose bien le nom de l initiateur', () => {
  const source = fs.readFileSync(path.join(racine, 'backend/routes/parapheur.js'), 'utf8');
  const occurrences = source.match(/AS initiateur_nom/g) || [];
  assert.ok(occurrences.length >= 3,
    `seulement ${occurrences.length} requete(s) composent initiateur_nom`);
  assert.ok(
    /CONCAT\(\w+\.nom,\s*CASE WHEN COALESCE\(\w+\.prenom,''\) != '' THEN CONCAT\(' ', \w+\.prenom\) ELSE '' END\)/.test(source),
    'La composition nom + prenom doit passer par CONCAT, imbrique compris : '
    + 'le CONCAT interne remplace le second ||, qui etait tout aussi casse'
  );
});

verifier('un agent sans prenom garde son nom', () => {
  /* CONCAT rend NULL des qu un argument l est. Sans COALESCE, un agent sans
     prenom perdrait son nom entier — on aurait echange « 0 » contre « N/A ». */
  for (const f of ['backend/routes/agents.js', 'backend/routes/salaires.js']) {
    const source = fs.readFileSync(path.join(racine, f), 'utf8');
    for (const sql of requetesDe(source)) {
      for (const m of sql.matchAll(/CONCAT\(\w+\.nom, ' ', ([^)]*\)?)\)/g)) {
        assert.ok(
          /COALESCE\(/.test(m[1]),
          `${f} : CONCAT(nom, ' ', ${m[1]}) rendra NULL si le prenom est absent`
        );
      }
    }
  }
});

verifier('le chemin SQLite est laisse intact', () => {
  const source = fs.readFileSync(path.join(racine, 'backend/database.js'), 'utf8');
  assert.ok(
    /module\.exports = require\('\.\/mysql_sync_facade'\);/.test(source),
    'database.js doit continuer de ceder la main a MySQL avant toute requete'
  );
  assert.ok(
    source.includes("'user-' || id"),
    'Le || de database.js est correct sur SQLite : le corriger serait une regression'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — concatenation SQL`);
process.exit(echecs ? 1 : 0);

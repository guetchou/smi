const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const migration = read('backend/migrations/051_notif_rappels_unicite.sql');
const service = read('backend/services/notif.js');

/* ── Le code assumait une contrainte qui n'existait pas ──
   planifierRappel() se dit « idempotent sur type × src × J » et s'appuie sur
   une erreur de doublon pour l'etre :

     catch (e) { if (e.message.includes('Duplicate')) return null; }

   Aucun index unique n'existait sur notif_rappels : l'erreur n'etait jamais
   levee, et chaque passage du planificateur reinserait le meme rappel.
   Constate en production le 31/08/2026 — 95 rappels identiques pour la seule
   echeance DGI du 10/06, 400 lignes pour 97 rappels reels, et 2 123 messages
   pour 97 distincts. */

/* Le repli du code doit rester : c'est lui qui rend la contrainte utile. */
const planif = service.match(/async function planifierRappel\(opts\) \{[\s\S]*?\n\}/)[0];
assert(
  /includes\('Duplicate'\)/.test(planif),
  'planifierRappel doit continuer a traiter le doublon comme un cas normal'
);
assert(
  /INSERT INTO notif_rappels \(type, src_table, src_id, declenchement_j/.test(planif),
  'Les colonnes inserees doivent rester celles de la cle naturelle'
);

/* La contrainte doit exister, sur exactement cette cle. */
assert(
  /ADD UNIQUE KEY uk_notif_rappel \(type, src_table, src_id, declenchement_j\)/.test(migration),
  'La cle unique doit porter sur (type, src_table, src_id, declenchement_j)'
);

/* declenche_a se deduit des autres colonnes : l'inclure rendrait la contrainte
   inoperante, deux passages a des heures differentes creant deux lignes. */
assert(
  !/uk_notif_rappel \([^)]*declenche_a/.test(migration),
  'declenche_a ne doit pas figurer dans la cle : il en decoule'
);

/* La deduplication doit preceder la contrainte, sinon l'ALTER echoue. */
const iDedup = migration.indexOf('DELETE r FROM notif_rappels r');
const iAlter = migration.indexOf('ALTER TABLE notif_rappels');
const iMsg = migration.indexOf('DELETE m FROM notif_messages m');
assert(iDedup !== -1 && iAlter !== -1 && iMsg !== -1, 'Les trois etapes doivent etre presentes');
assert(iDedup < iAlter, 'La deduplication doit preceder la pose de la contrainte');

/* La purge des messages ne doit toucher que la famille rappel : les alertes et
   les notifications metier ne sont pas concernees. */
const purge = migration.slice(iMsg);
assert.strictEqual(
  (purge.match(/famille\s*=\s*'rappel'/g) || []).length, 2,
  'La purge doit filtrer sur famille=rappel dans la sous-requete et dans le DELETE'
);
assert(
  !/DELETE m FROM notif_messages m\s*\n\s*WHERE/.test(purge),
  'La purge ne doit pas s appliquer sans jointure de conservation'
);

/* Le texte du message porte le palier d'avance : il fait partie de la cle,
   sinon une escalade effacerait le rappel initial. */
assert(
  /GROUP BY type, user_id, src_table, src_id, message/.test(purge),
  'Le message doit figurer dans la cle de deduplication : une escalade est distincte du rappel'
);

/* Chaque suppression garde un exemplaire. */
for (const bloc of [migration.slice(iDedup, iAlter), purge]) {
  assert(/MIN\(id\) AS garde/.test(bloc), 'Chaque deduplication doit conserver le plus ancien');
  assert(/id <> g\.garde/.test(bloc), 'La suppression doit epargner l exemplaire conserve');
}

console.log(JSON.stringify({
  codeStillTreatsDuplicateAsNormal: true,
  constraintOnNaturalKey: true,
  derivedColumnExcluded: true,
  dedupBeforeConstraint: true,
  purgeLimitedToReminders: true,
  oneCopyAlwaysKept: true,
}));

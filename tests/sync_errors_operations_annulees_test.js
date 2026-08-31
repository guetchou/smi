const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/operations.js');
const migration = read('backend/migrations/053_sync_errors_operations_annulees.sql');

/* ── Une operation annulee n'a plus rien a ventiler ──
   L'ecran des mouvements affichait « ANOMALIES DE SYNCHRONISATION (8) », toutes
   rattachees aux ecritures de test neutralisees le 31/08/2026 : elles
   reclamaient une ventilation comptable, une imputation budgetaire et une
   affectation metier pour des operations qui n'existent plus.

   Verifie en base : les 18 anomalies ouvertes etaient toutes attachees a une
   operation annulee. Aucune n'etait legitime.

   ensureOperationSyncErrors refusait deja d'en creer pour une operation non
   validee, mais rien ne refermait celles deja ouvertes a l'annulation. */

/* Le garde de creation doit rester : c'est lui qui empeche la reapparition. */
const creation = route.match(/async function ensureOperationSyncErrors\(operation, userId = null, dbc = db\) \{[^\n]*\n[^\n]*/)[0];
assert(
  /if \(!operation \|\| operation\.statut !== 'valide'\) return;/.test(creation),
  'Seule une operation validee doit produire des anomalies de synchronisation'
);

/* La fermeture doit exister, et couvrir tous les types — pas seulement les
   comptables, contrairement a resolveAccountingSyncErrors. */
const fermeture = route.match(/async function resolveOperationSyncErrors\(operationId, userId = null, dbc = db\) \{[\s\S]*?\n\}/);
assert(fermeture, 'Une fonction de fermeture des anomalies doit exister');
assert(
  /SET status = 'resolved'/.test(fermeture[0]),
  'La fermeture doit marquer les anomalies resolues'
);
assert(
  !/error_type LIKE/.test(fermeture[0]),
  'La fermeture ne doit pas se limiter a un type : budget et affectation restaient ouverts'
);
assert(
  /AND status = 'open'/.test(fermeture[0]),
  'Seules les anomalies ouvertes doivent etre refermees'
);

/* L'annulation doit l'appeler, et en rendre compte dans l'audit. */
assert(
  /const anomaliesFermees = await resolveOperationSyncErrors\(op\.id, req\.user\.id\);/.test(route),
  'L annulation d un decaissement doit refermer ses anomalies'
);
assert(
  /anomalies_fermees: anomaliesFermees,/.test(route),
  'Le nombre d anomalies refermees doit figurer dans la piste d audit'
);

/* La migration ne touche que les anomalies ouvertes d operations annulees. */
assert(/AND se\.status = 'open'/.test(migration), 'La migration ne doit viser que les anomalies ouvertes');
assert(/AND o\.statut = 'annule'/.test(migration), 'La migration ne doit viser que les operations annulees');
assert(
  !/DELETE/.test(migration),
  'Les anomalies ne doivent pas etre supprimees : leur trace a une valeur d audit'
);
assert(
  !/resolved_by/.test(migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')),
  'resolved_by doit rester nul : personne ne les a traitees, elles sont devenues sans objet'
);

console.log(JSON.stringify({
  creationStillRestrictedToValidatedOperations: true,
  closureCoversAllErrorTypes: true,
  cancellationClosesAnomalies: true,
  auditRecordsHowManyWereClosed: true,
  migrationNarrowAndNonDestructive: true,
}));

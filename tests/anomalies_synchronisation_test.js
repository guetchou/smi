'use strict';
/*
 * Garde — les anomalies de synchronisation citent une opération qui existe.
 *
 * Le 10/09/2026, l'écran « Mouvements caisse/banque » annonçait six anomalies
 * de synchronisation. Trois portaient sur l'opération 1, supprimée depuis :
 *
 *     sync_errors 2, 3, 6  ->  source_record_id = 1  ->  aucune opération
 *
 * La requête les servait en LEFT JOIN : tous les champs de l'opération
 * revenaient nuls, et le gabarit les rendait « Opération #1 — Flux financier ·
 * 0 XAF · Position non renseignée ». Personne ne pouvait comprendre de quoi
 * il s'agissait, et le compteur annonçait le double du travail réel.
 *
 * Deux règles sont gardées ici :
 *   — la jointure est fermée, une anomalie sans opération ne sort pas ;
 *   — un montant absent n'est pas rendu « 0 XAF ». Absent n'est pas zéro :
 *     une anomalie sur une opération à 0 XAF et une anomalie dont le montant
 *     n'a pas été joint doivent rester distinguables à l'écran.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const racine = path.join(__dirname, '..');

const route = fs.readFileSync(path.join(racine, 'backend', 'routes', 'operations.js'), 'utf8');
const ecran = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

/* Le corps de la route des anomalies, isolé pour ne pas lire les jointures
   des routes voisines. */
function requeteDesAnomalies() {
  const debut = route.indexOf("FROM sync_errors se");
  assert.notStrictEqual(debut, -1, 'la requete des anomalies est introuvable');
  const fin = route.indexOf('`', debut);
  return route.slice(debut, fin);
}

verifier('une anomalie sans operation ne sort pas de la base', () => {
  const r = requeteDesAnomalies();
  assert.ok(
    !/LEFT\s+JOIN\s+operations\s+o/i.test(r),
    'LEFT JOIN operations : les anomalies orphelines reviennent avec tous '
    + 'les champs nuls, comme les trois fantomes du 10/09/2026'
  );
  assert.ok(
    /\bJOIN\s+operations\s+o\b/i.test(r),
    'la jointure sur operations doit etre fermee'
  );
});

verifier('un montant absent n est pas rendu comme un montant nul', () => {
  assert.ok(
    !/fmt\(err\.montant\s*\|\|\s*0\)/.test(ecran),
    'fmt(err.montant || 0) affiche « 0 XAF » quand le montant est absent : '
    + 'absent n est pas zero'
  );
  assert.ok(
    /err\.montant\s*==\s*null/.test(ecran),
    'le rendu doit distinguer explicitement le montant absent'
  );
});

verifier('le libelle existant de la position est conserve', () => {
  assert.ok(
    /Position non renseignée/.test(ecran),
    'ce libelle existait avant : il ne doit pas disparaitre au passage'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n3 gardes vertes — anomalies de synchronisation`);

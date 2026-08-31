const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const operations = read('backend/routes/operations.js');

/* ── Un statut de parcours absent n'est pas un brouillon ──
   Le Bilan Dirigeant annoncait « 667 decaissement(s) en attente —
   37 149 361 XAF », en se contredisant sur le meme ecran : le bandeau du haut
   affichait « Aucune demande en attente de validation DG » et
   « Decaissements a valider : 0 ».

   COALESCE(dec_statut, 'brouillon') inventait l'etat « brouillon » pour les
   667 decaissements importes, dont dec_statut est NULL — ils ne sont jamais
   entres dans le parcours de validation.

   Mesure en base le 31/08/2026 :
     comptage precedent            667 operations, 37 149 361 XAF
     reellement dans le parcours     0 operation,           0 XAF
     repartition                   667 dec_statut NULL / statut valide
                                     5 dec_statut annule / statut annule */

/* Chaque bloc est ancre sur un nom propre au comptage vise : plusieurs
   requetes de ce fichier commencent par SELECT COUNT(*) as c FROM operations. */
const comptages = [
  ['badge de la barre laterale', /const placeholders = statuses[\s\S]*?`, statuses\);/],
  ['tuile du bilan', /const decEnAttente = await db\.queryOne\(`[\s\S]*?`\);/],
  ['compteur mensuel', /const nbEnAttenteRow = await db\.queryOne\([\s\S]*?\[debut, fin\]/],
];

for (const [nom, motif] of comptages) {
  const bloc = operations.match(motif);
  assert(bloc, `Comptage introuvable : ${nom}`);
  assert(
    !/COALESCE\(dec_statut, 'brouillon'\)/.test(bloc[0]),
    `${nom} compte encore un dec_statut absent comme un brouillon : ` +
    'un import valide serait annonce comme en attente'
  );
  assert(
    /dec_statut IN \(/.test(bloc[0]),
    `${nom} doit exiger un statut de parcours explicite`
  );
  assert(
    /statut <> 'annule'/.test(bloc[0]),
    `${nom} doit exclure les operations annulees`
  );
}

/* Aucun comptage ne doit revenir au raccourci. */
assert.strictEqual(
  (operations.match(/COALESCE\(dec_statut, 'brouillon'\)/g) || []).length, 0,
  'Aucun COALESCE sur dec_statut ne doit subsister dans les comptages'
);

/* En revanche les gardes de transition le conservent : elles decident si UNE
   operation designee peut franchir une etape, et y traiter un import comme un
   brouillon est voulu. Le test les protege d'un zele mal place. */
for (const fichier of ['backend/routes/parapheur.js', 'backend/routes/parapheur_source_sync_safe.js']) {
  const src = read(fichier);
  assert(
    /COALESCE\(dec_statut, ?'brouillon'\)/.test(src),
    `${fichier} : les gardes de transition doivent conserver leur COALESCE — ` +
    'elles portent sur une operation designee, pas sur un comptage'
  );
  assert(
    /WHERE id=\?/.test(src),
    `${fichier} : ces requetes doivent bien viser une operation par son identifiant`
  );
}

console.log(JSON.stringify({
  countsRequireExplicitWorkflowStatus: true,
  cancelledExcluded: true,
  noCoalesceLeftInCounts: true,
  transitionGuardsUntouched: true,
}));

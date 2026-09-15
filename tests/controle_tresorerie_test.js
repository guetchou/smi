'use strict';
/*
 * Gardes — les trois écrans de contrôle de trésorerie.
 *
 * Recette du 15/09/2026, menée à l'écran avec les droits réels de
 * l'assistante de direction. Trois défauts, tous mesurés :
 *
 * 1. toast() n'existe pas.
 *    Huit appels dans dashboard.html, tous sur les écrans clôture de caisse,
 *    rapprochement bancaire et export. Vérifié en direct :
 *
 *        soumettreClotureeCaisse()
 *        -> ReferenceError: toast is not defined
 *
 *    Aucun message ne s'affiche : l'agent clique et il ne se passe rien.
 *    Pire, dans soumettreClotureeCaisse l'appel de succès PRÉCÈDE la remise à
 *    zéro du formulaire et le rechargement de l'historique. Une clôture
 *    réussie laissait donc l'écran strictement inchangé — et invitait à
 *    recommencer.
 *
 * 2. Un comptage physique absent était traité comme un comptage à zéro.
 *    Caisse à 2 500 XAF, champ « Solde physique compté » vide :
 *
 *        Solde logiciel   2 500 XAF
 *        Solde physique       0 XAF     <- rien n'avait été compté
 *        Écart           −2 500 XAF
 *
 *    et « Valider la clôture » restait actif. Un écart est une accusation :
 *    il dit que de l'argent manque. Celui-ci naissait d'un champ vide.
 *    Cinquième défaut de la famille « absent ≠ zéro ».
 *
 * 3. « Rapprochements à jour » était affirmé sans rien savoir.
 *    Le tableau de bord comptait les opérations via operations.rapprochement_id,
 *    colonne qui n'existe pas — le lien réel passe par
 *    rapprochements_lignes.operation_id. Vérifié en base :
 *
 *        ERROR 1054 (42S22): Unknown column 'rapprochement_id' in 'where clause'
 *
 *    Le catch remplaçait le compte par 0, et 0 s'affichait en vert
 *    « Rapprochements à jour » sur le tableau de bord du dirigeant — alors que
 *    rapprochements_bancaires, rapprochements_lignes, caisses_clotures et
 *    periodes_cloturees contiennent zéro ligne depuis toujours.
 *
 *    Un comptage impossible n'est pas un comptage à zéro.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(racine, 'backend', 'routes', 'dashboard.js'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. plus aucun appel à une fonction inexistante ────────────────────── */

verifier('aucun appel a toast(), qui n existe pas', () => {
  const restants = html.match(/(?<![.\w])toast\(/g) || [];
  assert.strictEqual(
    restants.length, 0,
    `${restants.length} appel(s) a toast() subsistent. Chacun leve `
    + 'ReferenceError au lieu d afficher un message : l agent clique et il ne '
    + 'se passe rien. Utiliser showToast().'
  );
});

verifier('les messages de ces ecrans sont conserves, pas supprimes', () => {
  for (const message of [
    'Date et position obligatoires',
    'Clôture enregistrée avec succès',
    'Rapprochement validé',
    'Session créée',
    'Aucune donnée à exporter',
  ]) {
    assert.ok(
      html.includes(message),
      `« ${message} » a disparu : le correctif devait rendre les messages `
      + 'visibles, pas les retirer'
    );
  }
});

verifier('la cloture reussie remet le formulaire a zero et recharge l historique', () => {
  const fonction = (html.match(/async function soumettreClotureeCaisse\(\)[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(fonction, 'soumettreClotureeCaisse introuvable');
  assert.ok(
    /loadHistoriqueClotures\(\)/.test(fonction),
    'Le rechargement de l historique doit rester dans la branche de succes : '
    + 'c est ce que l exception de toast() empechait'
  );
  assert.ok(
    /clt-date'\)\.value = ''/.test(fonction),
    'La remise a zero du formulaire doit rester dans la branche de succes'
  );
});

/* ── 2. un comptage absent n'est pas un comptage à zéro ────────────────── */

verifier('le comptage physique a une lecture nommee qui distingue vide et zero', () => {
  assert.ok(
    /function comptagePhysiqueSaisi\(\)/.test(html),
    'La distinction « pas compté » / « compté à zéro » doit etre nommee, pas '
    + 'enfouie dans un parseFloat(value || 0)'
  );
  const fonction = (html.match(/function comptagePhysiqueSaisi\(\)[\s\S]*?\n}/) || [])[0];
  assert.ok(
    /return null/.test(fonction),
    'Un champ vide doit rendre null, jamais 0'
  );
  assert.ok(
    /brut === ''/.test(fonction),
    'La chaine vide doit etre reconnue explicitement'
  );
});

verifier('parseFloat(value || 0) a disparu du comptage physique', () => {
  assert.ok(
    !/clt-solde-physique'\)\.value \|\| 0/.test(html),
    'C est exactement le defaut : une chaine vide devenait 0, et l ecart '
    + 'affichait −2 500 XAF sur une caisse jamais comptee'
  );
});

verifier('sans comptage, l ecart ne s affiche pas et la cloture est grisee', () => {
  const fonction = (html.match(/function calcEcartCloture\(\)[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(fonction, 'calcEcartCloture introuvable');
  assert.ok(
    /physique === null/.test(fonction),
    'calcEcartCloture doit traiter le cas « pas encore compte »'
  );
  assert.ok(
    /'—'/.test(fonction),
    'Un ecart inconnu s affiche en tiret, pas en chiffre'
  );
  assert.ok(
    /disabled = true/.test(fonction),
    'Sans comptage, « Valider la cloture » doit etre grise : un ecart fictif '
    + 'ne doit pas pouvoir etre enregistre'
  );
  assert.ok(
    /id="clt-valider"/.test(html) && /disabled>Valider la clôture/.test(html),
    'Le bouton doit naitre grise et porter un identifiant pour l etre'
  );
});

verifier('la soumission refuse une cloture sans comptage', () => {
  const fonction = (html.match(/async function soumettreClotureeCaisse\(\)[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(
    /solde_physique === null/.test(fonction),
    'Le garde-fou de l ecran ne suffit pas : la soumission doit refuser elle '
    + 'aussi, sinon un ecart egal au solde entier serait grave'
  );
});

/* ── 3. un comptage impossible ne s'annonce pas « à jour » ─────────────── */

verifier('le comptage des rapprochements interroge le schema reel', () => {
  assert.ok(
    !/operations\s*\n?\s*WHERE rapprochement_id IS NULL/.test(dashboard)
    && !/o\.rapprochement_id/.test(dashboard),
    'operations.rapprochement_id n existe pas : la requete echouait avec '
    + 'ERROR 1054 et le catch rendait 0'
  );
  assert.ok(
    /rapprochements_lignes/.test(dashboard),
    'Le lien reel passe par rapprochements_lignes.operation_id'
  );
});

verifier('un comptage impossible rend null, jamais zero', () => {
  /* Le bloc court du `let` jusqu'à la fermeture du catch : s'arrêter à la fin
     du try ferait passer la garde sans jamais lire la branche d'échec, qui est
     précisément celle qui rendait 0. */
  const bloc = (dashboard.match(/let rappro_pending[\s\S]*?catch \([\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(bloc, 'bloc rappro_pending introuvable');
  assert.ok(/catch \(/.test(bloc), 'le bloc lu ne contient pas la branche d echec');
  assert.ok(
    /let rappro_pending = null/.test(bloc),
    'La valeur initiale doit etre null : zero signifierait « rien a rapprocher »'
  );
  assert.ok(
    /rappro_pending = null/.test(bloc.split('catch')[1] || ''),
    'En cas d echec, le compte doit rester inconnu et non zero'
  );
  assert.ok(
    !/catch \(_\)/.test(bloc),
    'L erreur ne doit plus etre avalee en silence : elle doit etre tracee'
  );
  assert.ok(
    /console\.error/.test(bloc),
    'Un comptage impossible doit laisser une trace lisible cote serveur'
  );
});

verifier('l ecran n affirme rien quand il ne sait pas', () => {
  assert.ok(
    /rappro === null \? '' :/.test(html),
    'Quand le comptage est inconnu, aucune pastille : « Rapprochements a jour » '
    + 'serait une affirmation fausse'
  );
  assert.ok(
    html.includes('Rapprochements à jour'),
    'La pastille verte reste, pour le cas ou il n y a reellement rien a faire'
  );
  /* Un séparateur orphelin trahirait la pastille absente. */
  assert.ok(
    /rappro === null \? '' : `<span class="role-bar-dot"><\/span>`/.test(html),
    'Le separateur doit disparaitre avec la pastille'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — controle de tresorerie`);
process.exit(echecs ? 1 : 0);

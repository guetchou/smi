'use strict';

/*
 * Garde — le parcours réel de la trésorerie doit pouvoir s'enregistrer.
 *
 * Confronté le 04/09/2026 au parcours décrit par la direction : chèque reçu
 * d'un client, remis en banque, fonds retirés pour la caisse du bureau,
 * paiement Airtel, prêt d'un tiers en complément, et le chèque d'un autre
 * client rejeté par la banque avec motif.
 *
 * Quatre de ces six étapes passaient déjà. Deux ne passaient pas, et la
 * sixième — le rejet — a révélé un défaut que le reste masquait.
 *
 * 1. LA REMISE EN BANQUE N'EXISTAIT PAS COMME ÉTAPE. Saisir le chèque sur
 *    « Banque BCH » créditait le solde bancaire le jour de la réception,
 *    alors que l'argent n'y était pas. Le chèque rejeté l'a prouvé : le solde
 *    affichait comme acquis ce qui n'a jamais été encaissé.
 *
 * 2. UN PRÊT N'EST PAS UNE SUBVENTION. La seule rubrique disponible était
 *    « Subventions & financements » : un produit, là où un emprunt est une
 *    dette. Et rien pour le rembourser.
 *
 * 3. L'ANNULATION D'UNE OPÉRATION NE DEMANDAIT AUCUN MOTIF, alors que la
 *    colonne annule_motif existait et que toutes les autres annulations de
 *    l'application en exigent un. « Chèque rejeté — provision insuffisante »
 *    et « erreur de saisie » laissaient la même ligne muette.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(racine, 'backend', 'migrations', '056_cheques_et_emprunts.sql'), 'utf8');
const route = fs.readFileSync(path.join(racine, 'backend', 'routes', 'operations.js'), 'utf8');
const markup = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  const ouverture = source.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < source.length; j++) {
    if (source[j] === '{') profondeur++;
    else if (source[j] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. La position d'attente sépare la réception de l'encaissement ── */
assert(/CHQ_ENC/.test(migration), 'La position des chèques remis doit être créée');
assert(
  /'CHQ_ENC'[\s\S]{0,120}'autre'/.test(migration),
  "Le type doit être « autre » : ce n'est ni une caisse d'où l'on paie, ni un compte bancaire"
);

/* ── 2. L'emprunt a sa rubrique, et son remboursement aussi ──
   Une recette sans sa dépense symétrique renvoie le remboursement dans
   « Autres dépenses », où plus personne ne le retrouve. */
for (const [rubrique, sens] of [
  ['Emprunts & prêts reçus', 'encaissement'],
  ["Remboursement d''emprunt", 'decaissement'],
]) {
  assert(
    migration.includes(rubrique) && migration.includes(`'${sens}'`),
    `La rubrique « ${rubrique.replace("''", "'")} » doit exister en ${sens}`
  );
}

/* ── 3. La migration se rejoue sans créer de doublon ──
   Les migrations sont appliquées au démarrage ; une insertion sèche
   dupliquerait à chaque redéploiement. */
const insertions = (migration.match(/INSERT INTO/g) || []).length;
const gardes = (migration.match(/WHERE NOT EXISTS/g) || []).length;
assert.strictEqual(
  insertions, gardes,
  `Chaque insertion doit être gardée par WHERE NOT EXISTS (${insertions} insertions, ${gardes} gardes)`
);

/* ── 4. Annuler une opération exige un motif ── */
const suppression = corpsDe(route, "router.delete('/:id'");

assert(
  /Motif d\\'annulation obligatoire|Motif d'annulation obligatoire/.test(suppression),
  "L'annulation doit refuser sans motif, comme partout ailleurs dans l'application"
);
assert(
  /annule_motif\s*=\s*\?/.test(suppression),
  'Le motif doit être écrit dans annule_motif : une colonne qui existait déjà et que rien ne remplissait'
);
assert(
  /annule_by\s*=\s*\?/.test(suppression) && /annule_at\s*=\s*NOW\(\)/.test(suppression),
  "Qui annule et quand doivent être conservés avec le motif"
);

/* Le refus doit précéder l'écriture : sinon l'opération est annulée puis
   l'erreur rendue, et la ligne reste barrée sans motif. */
assert(
  suppression.indexOf('Motif d') < suppression.indexOf('UPDATE operations SET'),
  "Le refus doit être évalué AVANT la mise à jour, sinon l'annulation a déjà eu lieu"
);

/* La contre-écriture reste exigée pour une opération comptabilisée : le motif
   ne remplace pas cette règle. */
assert(
  /Annulation directe interdite/.test(suppression),
  'Une opération déjà comptabilisée doit toujours exiger une contre-écriture'
);

/* ── 5. L'écran demande le motif avant d'appeler ── */
const ecran = corpsDe(markup, 'async function deleteOp(id)');

assert(/showPrompt\(/.test(ecran), "L'écran doit demander le motif, pas se contenter d'une confirmation");
assert(
  !/showConfirm\(/.test(ecran),
  "Une confirmation oui/non ne recueille aucun motif : elle ne suffit plus"
);
assert(
  ecran.indexOf('showPrompt(') < ecran.indexOf('method: \'DELETE\''),
  "Le motif doit être saisi AVANT l'appel"
);
assert(
  /body: JSON\.stringify\(\{ motif \}\)/.test(ecran),
  'Le motif doit être transmis au serveur, pas seulement saisi'
);
assert(
  /if \(!motif\.trim\(\)\)/.test(ecran),
  'Un motif vide doit être refusé côté écran aussi, comme pour les autres annulations'
);

console.log(JSON.stringify({
  pendingChequePositionExists: true,
  loanHasItsCategoryAndItsRepayment: true,
  migrationReplaysWithoutDuplicating: true,
  cancellingDemandsAReason: true,
  reasonIsStoredWithWhoAndWhen: true,
  refusalPrecedesTheWrite: true,
  postedEntriesStillRequireAContraEntry: true,
  screenAsksBeforeItCalls: true,
}));

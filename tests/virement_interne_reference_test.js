'use strict';
/*
 * Garde — un transfert interne s'enregistre sans référence externe.
 *
 * Défaut du 15/09/2026, mesuré en production avec les droits réels de
 * l'assistante de direction :
 *
 *   POST /api/operations  {type_op:"virement", mode_reglement:"virement_bancaire"}
 *   → 400 « Référence externe obligatoire pour chèque, virement bancaire
 *           ou mobile money »
 *
 * Le front envoie mode_reglement="virement_bancaire" pour tout transfert
 * interne. La règle qui exige une référence pour un chèque, un virement
 * bancaire ou un mobile money s'appliquait donc à un mouvement qui n'a aucun
 * tiers en face. L'agent voyait un message parlant de chèque et de mobile
 * money alors qu'il déplaçait de l'argent de la caisse vers la banque — et le
 * champ que le serveur exigeait, « Référence externe », est présenté dans la
 * fenêtre SANS astérisque, donc facultatif.
 *
 * Mesure : sur les 727 opérations de l'historique complet sauvegardé avant la
 * remise à zéro du 02/09/2026 — 672 décaissements, 55 encaissements — il y a
 * ZÉRO virement. Le bouton « Transfert » est offert sur le tableau de bord à
 * côté d'« Encaisser » et de « Décaisser » ; il n'a jamais produit une ligne.
 *
 * Cette garde tient les deux bouts. Le transfert interne passe sans
 * référence ; le règlement à un tiers continue de l'exiger. Affaiblir la
 * seconde moitié rendrait le rapprochement bancaire impossible.
 *
 * Elle porte sur le CHEMIN RÉEL — la fonction qu'appelle POST /api/operations —
 * et pas seulement sur le module que le correctif introduit : une garde qui ne
 * teste que du code neuf passe par construction et ne garde rien.
 */
const assert = require('assert');
const {
  referenceExterneObligatoire,
  modeExigeReferenceExterne,
  estTransfertInterne,
  MESSAGE_REFERENCE_REQUISE,
} = require('../backend/services/reference-externe');

/* Charger la route tire la chaîne d'authentification, qui refuse de démarrer
   sans secret. Valeur de test sans aucune portée réelle. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'valeur-de-test-sans-portee-reelle-0000';
const { validateExternalReference } = require('../backend/routes/operations');
assert.strictEqual(
  typeof validateExternalReference, 'function',
  'La decision « faut-il une reference externe ? » doit etre exposee et '
  + 'testable sur le chemin reel de POST /api/operations.'
);

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── le défaut lui-même, sur le chemin réel ────────────────────────────── */

verifier('la route accepte un transfert interne sans reference externe', async () => {
  const erreur = await validateExternalReference({
    type_op: 'virement', mode_reglement: 'virement_bancaire', ref_externe: '',
  });
  assert.strictEqual(
    erreur, null,
    'C est exactement le defaut du 15/09/2026 : POST /api/operations rendait '
    + '400 sur un mouvement entre deux positions de l entreprise, et le bouton '
    + '« Transfert » n a jamais produit une seule ligne en 727 operations.'
  );
});

verifier('un transfert interne passe quel que soit le mode envoye', async () => {
  for (const mode of ['virement_bancaire', 'virement', 'cheque', 'mobile_money', 'especes']) {
    assert.strictEqual(
      await validateExternalReference({ type_op: 'virement', mode_reglement: mode, ref_externe: '' }),
      null,
      `Le mode ${mode} ne doit rien exiger d un mouvement sans tiers`
    );
  }
});

/* ── ce qu'on refuse d'affaiblir ───────────────────────────────────────── */

verifier('la route exige toujours la reference d un reglement a un tiers', async () => {
  for (const [type, mode] of [
    ['encaissement', 'cheque'],
    ['decaissement', 'virement_bancaire'],
    ['decaissement', 'mobile_money'],
    ['decaissement', 'virement'],
  ]) {
    assert.strictEqual(
      await validateExternalReference({ type_op: type, mode_reglement: mode, ref_externe: '' }),
      MESSAGE_REFERENCE_REQUISE,
      `${type} par ${mode} sans reference doit rester refuse : sans elle, le `
      + 'rapprochement bancaire est impossible'
    );
  }
});

verifier('les especes passent sans reference, comme avant', async () => {
  assert.strictEqual(
    await validateExternalReference({ type_op: 'decaissement', mode_reglement: 'especes', ref_externe: '' }),
    null
  );
});

/* ── la décision, lue sur le module partagé ────────────────────────────── */

verifier('le module partage dit la meme chose que la route', () => {
  assert.strictEqual(referenceExterneObligatoire({ type_op: 'virement', mode_reglement: 'virement_bancaire' }), false);
  assert.strictEqual(referenceExterneObligatoire({ type_op: 'encaissement', mode_reglement: 'cheque' }), true);
  assert.strictEqual(referenceExterneObligatoire({ type_op: 'decaissement', mode_reglement: 'virement' }), true,
    'La normalisation ne doit pas ouvrir une porte derobee sur l ancien libelle');
  assert.strictEqual(referenceExterneObligatoire({ type_op: 'decaissement', mode_reglement: 'especes' }), false);
});

verifier('le type virement est reconnu quelle que soit la casse', () => {
  for (const t of ['virement', 'VIREMENT', ' Virement ']) {
    assert.strictEqual(estTransfertInterne(t), true, `non reconnu : ${JSON.stringify(t)}`);
  }
  for (const t of ['encaissement', 'decaissement', '', null, undefined]) {
    assert.strictEqual(estTransfertInterne(t), false, `reconnu a tort : ${JSON.stringify(t)}`);
  }
});

verifier('le predicat de mode reste intact, tiers ou pas', () => {
  assert.strictEqual(modeExigeReferenceExterne('cheque'), true);
  assert.strictEqual(modeExigeReferenceExterne('especes'), false);
});

/* ── la règle n'est plus écrite qu'une fois ────────────────────────────── */

verifier('les trois fichiers lisent le meme module, aucun ne redefinit la regle', () => {
  const fs = require('fs');
  const path = require('path');
  const racine = path.join(__dirname, '..');
  for (const f of [
    'backend/routes/operations.js',
    'backend/services/finance-operation-canonical.js',
    'backend/services/cash-receipt-workflow.js',
  ]) {
    const source = fs.readFileSync(path.join(racine, f), 'utf8');
    assert.ok(
      /require\([^)]*reference-externe[^)]*\)/.test(source),
      `${f} ne lit pas le module partage : la regle va rediverger`
    );
    /* Une copie locale de la liste des trois modes est ce qui a permis aux
       trois exemplaires de diverger. On refuse qu'elle revienne. */
    assert.ok(
      !/\[\s*'cheque'\s*,\s*'virement_bancaire'\s*,\s*'mobile_money'\s*\]/.test(source),
      `${f} redefinit la liste des modes au lieu de lire le module partage`
    );
  }
});

verifier('le message reste celui que la production affiche', () => {
  assert.strictEqual(
    MESSAGE_REFERENCE_REQUISE,
    'Référence externe obligatoire pour chèque, virement bancaire ou mobile money'
  );
});

(async () => {
  let echecs = 0;
  for (const [nom, fn] of cas) {
    try { await fn(); console.log(`  ok   ${nom}`); }
    catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
  }
  console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes`);
  process.exit(echecs ? 1 : 0);
})();

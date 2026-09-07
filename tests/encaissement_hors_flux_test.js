'use strict';

/*
 * Garde — le flux contrôlé ne gouverne que ce qu'il a pris en charge.
 *
 * Constaté le 07/09/2026 en production, pas en lisant le code : corriger la
 * date de l'encaissement REC-2026-000001 (1 200 000 XAF saisis au 13 janvier
 * au lieu du 3 septembre) était impossible. PUT /api/operations/1 rendait :
 *
 *     409 — « Modification interdite après soumission.
 *            Utiliser le retour en brouillon contrôlé. »
 *            code: CASH_RECEIPT_IMMUTABLE_AFTER_SUBMISSION
 *
 * Or l'opération n'avait jamais été soumise. En base, au même instant :
 *
 *     business_status = NULL   submitted_at = NULL
 *     approval_status = NULL   validated_at = NULL
 *     payment_status  = NULL   paid_at      = NULL
 *
 * Cause : asymétrie entre création et modification dans
 * cash_receipt_workflow_router.js. La CRÉATION passe la main (`next()`) quand
 * la position n'est pas prête — l'opération naît alors par la voie historique,
 * sans business_status. La MODIFICATION, elle, interrogeait tout encaissement
 * sans vérifier qu'il relevait du flux. Le routeur refusait donc de laisser
 * modifier ce qu'il avait lui-même refusé de créer, en invoquant une
 * soumission qui n'avait jamais eu lieu.
 *
 * C'est « absent ≠ zéro » sous une autre forme, la quatrième de cette famille :
 * un business_status absent n'est pas un dossier soumis, c'est un dossier que
 * ce flux n'a jamais vu. Le message trompait sur la cause, ce qui rendait la
 * panne indiagnosticable depuis l'écran.
 */

const assert = require('assert');

// Charger le routeur tire la chaîne d'authentification, qui refuse de démarrer
// sans secret. Valeur de test sans aucune valeur réelle : elle ne sert qu'à
// laisser le module se charger, et cède la place à celle de l'environnement.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'valeur-de-test-sans-portee-reelle-0000';

const routeur = require('../backend/routes/cash_receipt_workflow_router');

const { gouverneParLeFluxControle, modifiableEnLEtat } = routeur;

assert.strictEqual(
  typeof gouverneParLeFluxControle, 'function',
  'La décision « cette opération relève-t-elle du flux ? » doit être nommée et testable, ' +
  'pas enfouie dans une condition de handler'
);
assert.strictEqual(typeof modifiableEnLEtat, 'function');

/* ── 1. Le cas mesuré en production ──
   Une opération née par la voie historique n'a pas de business_status.
   Le flux ne la gouverne pas : il doit passer la main, pas rendre 409. */
const historique = {
  id: 1,
  business_status: null,
  payment_status: null,
  submitted_at: null,
  validated_at: null,
  paid_at: null,
};
assert.strictEqual(
  gouverneParLeFluxControle(historique), false,
  'Un encaissement sans business_status n\'a jamais été pris en charge par le flux : ' +
  'le refuser à la modification revient à invoquer une soumission qui n\'a pas eu lieu'
);

/* Les autres formes d'absence valent absence, pas « soumis ». */
[undefined, '', null].forEach(valeur => {
  assert.strictEqual(
    gouverneParLeFluxControle({ business_status: valeur }), false,
    `business_status ${JSON.stringify(valeur)} doit valoir « hors flux », jamais « soumis »`
  );
});

/* ── 2. Ce que le flux gouverne, il continue de le tenir ──
   Le correctif ne doit pas ouvrir une brèche : un dossier réellement entré
   dans le flux reste sous son autorité. */
assert.strictEqual(gouverneParLeFluxControle({ business_status: 'draft' }), true);
assert.strictEqual(gouverneParLeFluxControle({ business_status: 'submitted' }), true);
assert.strictEqual(gouverneParLeFluxControle({ business_status: 'approved' }), true);
assert.strictEqual(gouverneParLeFluxControle({ business_status: 'confirmed' }), true);

/* ── 3. L'immuabilité après soumission reste entière ──
   C'est la raison d'être du verrou : elle ne doit pas être affaiblie. */
assert.strictEqual(
  modifiableEnLEtat({ business_status: 'draft', payment_status: 'unpaid' }), true,
  'Au brouillon et non payé, les routes historiques restent la voie normale'
);
[
  { business_status: 'submitted', payment_status: 'unpaid' },
  { business_status: 'approved', payment_status: 'unpaid' },
  { business_status: 'confirmed', payment_status: 'paid' },
  { business_status: 'draft', payment_status: 'paid' },
].forEach(operation => {
  assert.strictEqual(
    modifiableEnLEtat(operation), false,
    `${operation.business_status}/${operation.payment_status} doit rester immuable`
  );
});

/* ── 4. Création et modification jugent le même périmètre ──
   L'asymétrie était la cause. Si la création passe la main dans un cas, la
   modification doit passer la main dans ce même cas. */
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'routes', 'cash_receipt_workflow_router.js'), 'utf8');

const gardesPosees = (source.match(/if \(!gouverneParLeFluxControle\(operation\)\) return next\(\);/g) || []).length;
assert.strictEqual(
  gardesPosees, 2,
  'Les deux routes historiques — modification ET suppression — doivent poser la garde ' +
  `(${gardesPosees} trouvée(s) sur 2 attendues)`
);

console.log(JSON.stringify({
  theRouterOnlyGovernsWhatItTookOn: true,
  aMissingStatusIsNotASubmittedFile: true,
  everyFormOfAbsenceCounted: true,
  realFlowFilesStillHeld: true,
  immutabilityAfterSubmissionIntact: true,
  creationAndUpdateJudgeTheSameScope: true,
}));

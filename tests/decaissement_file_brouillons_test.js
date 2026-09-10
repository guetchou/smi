'use strict';
/*
 * Garde — un compte voit toujours ses propres brouillons de décaissement.
 *
 * Le défaut du 10/09/2026 : les brouillons n'étaient listés que si le compte
 * ne pouvait NI approuver NI payer.
 *
 *     if (canWrite && !canApprove && !canPay) { statusFilter.push('brouillon'); }
 *
 * Les trois comptes actifs de la production portent cash.out.pay et
 * cash.out.validate par profil : les trois étaient exclus. Chacun pouvait
 * saisir un décaissement — l'écriture partait en base — puis la ligne
 * disparaissait de son écran, sans message, définitivement non soumise.
 *
 * Vu de l'agent, « rien ne s'enregistre ». C'est la plainte qui a ouvert
 * l'enquête.
 *
 * Les trois droits s'additionnent, ils ne s'excluent pas. Cette garde le dit.
 */
const assert = require('assert');
const {
  criteresFileActionnable,
  criteresFileComplete,
} = require('../backend/services/decaissement-file');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* Un brouillon n'est visible qu'à travers une clause qui exige à la fois le
   statut brouillon ET le propriétaire. On lit la paire dans les paramètres. */
function couvreSesBrouillons(critere, utilisateurId) {
  if (!critere) return false;
  const { sql, params } = critere;
  if (!/created_by = \?/.test(sql)) return false;
  const i = params.indexOf('brouillon');
  return i !== -1 && params[i + 1] === utilisateurId;
}

const couvre = (critere, statut) =>
  !!critere && critere.params.includes(statut);

verifier('un compte qui peut tout voit quand meme ses propres brouillons', () => {
  const c = criteresFileActionnable({
    peutEcrire: true, peutApprouver: true, peutPayer: true, utilisateurId: 2,
  });
  assert.ok(
    couvreSesBrouillons(c, 2),
    'Le compte qui peut approuver et payer ne voit plus ses brouillons : '
    + 'c est exactement le defaut du 10/09/2026'
  );
  assert.ok(couvre(c, 'soumis'), 'il doit aussi voir les soumis');
  assert.ok(couvre(c, 'valide'), 'il doit aussi voir les valides');
});

verifier('un compte qui ne fait que saisir voit ses brouillons, et rien d autre', () => {
  const c = criteresFileActionnable({
    peutEcrire: true, peutApprouver: false, peutPayer: false, utilisateurId: 7,
  });
  assert.ok(couvreSesBrouillons(c, 7));
  assert.ok(!couvre(c, 'soumis'), 'il n approuve pas');
  assert.ok(!couvre(c, 'valide'), 'il ne paie pas');
});

verifier('un compte qui approuve sans saisir ne voit aucun brouillon', () => {
  const c = criteresFileActionnable({
    peutEcrire: false, peutApprouver: true, peutPayer: false, utilisateurId: 9,
  });
  assert.ok(!couvreSesBrouillons(c, 9), 'les brouillons d autrui ne le regardent pas');
  assert.ok(couvre(c, 'soumis'));
});

verifier('les brouillons restent attaches a leur createur', () => {
  const c = criteresFileActionnable({
    peutEcrire: true, peutApprouver: true, peutPayer: true, utilisateurId: 42,
  });
  assert.ok(
    /created_by = \?/.test(c.sql),
    'sans la restriction au createur, chacun verrait les brouillons des autres'
  );
  assert.ok(!couvreSesBrouillons(c, 43), 'le brouillon d un autre compte ne doit pas passer');
});

verifier('aucun droit, aucune requete', () => {
  const c = criteresFileActionnable({
    peutEcrire: false, peutApprouver: false, peutPayer: false, utilisateurId: 1,
  });
  assert.strictEqual(c, null, 'sans droit, on ne doit pas interroger la base');
});

verifier('la file complete porte les trois statuts', () => {
  const c = criteresFileComplete();
  for (const s of ['brouillon', 'soumis', 'valide']) {
    assert.ok(couvre(c, s), `la file complete doit porter ${s}`);
  }
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
}
if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n${cas.length} gardes vertes — file des decaissements`);

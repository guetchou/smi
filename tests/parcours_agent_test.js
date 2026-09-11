'use strict';
/*
 * Garde — une fiche preparee n'est pas une fiche active.
 *
 * Le defaut que cette garde ferme est silencieux : une fiche creee pour une
 * arrivee a venir comptait immediatement dans l'effectif et dans la masse
 * salariale. Rien a l'ecran ne le signalait, et le chiffre etait faux tant
 * que la personne n'etait pas arrivee.
 *
 * Mesure du 10/09/2026 sur MAT-0018 : fiche creee le 14/07 pour une arrivee
 * le 01/08. Dix-huit jours de comptage errone.
 *
 * Deux pieges que les cas ci-dessous couvrent :
 *
 *   — l'arrivee du jour meme. Comparer une date sans heure a un instant fait
 *     basculer la reponse a midi : la fiche serait active le matin et en
 *     preparation l'apres-midi, ou l'inverse. Quelqu'un qui commence
 *     aujourd'hui travaille aujourd'hui.
 *
 *   — le statut demande explicitement. Une reprise d'historique cree parfois
 *     une fiche deja sortie. La deduction ne doit pas ecraser une intention.
 */
const assert = require('assert');
const {
  etatALaCreation, transitionPermise, PREPARATION, ACTIF, JAMAIS_ARRIVE,
} = require('../backend/services/parcours-agent');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

const LE_10_SEPTEMBRE = new Date('2026-09-10T14:30:00Z').getTime();

verifier('une arrivee a venir ouvre une preparation', () => {
  const e = etatALaCreation({ dateEmbauche: '2026-09-22', maintenant: LE_10_SEPTEMBRE });
  assert.strictEqual(e.statut_dossier, PREPARATION);
  assert.strictEqual(e.actif, 0, 'actif = 0 est ce qui la tient hors de l effectif');
});

verifier('une arrivee passee ouvre une fiche active', () => {
  const e = etatALaCreation({ dateEmbauche: '2026-08-01', maintenant: LE_10_SEPTEMBRE });
  assert.strictEqual(e.statut_dossier, ACTIF);
  assert.strictEqual(e.actif, 1);
});

verifier('une arrivee le jour meme est active, quelle que soit l heure', () => {
  for (const h of ['T00:05:00Z', 'T08:00:00Z', 'T14:30:00Z', 'T23:50:00Z']) {
    const t = new Date('2026-09-10' + h).getTime();
    const e = etatALaCreation({ dateEmbauche: '2026-09-10', maintenant: t });
    assert.strictEqual(
      e.statut_dossier, ACTIF,
      `a ${h} la fiche du jour meme doit etre active : sans quoi la reponse `
      + 'change au fil de la journee'
    );
  }
});

verifier('une arrivee du jour portant une heure reste active', () => {
  /* Le cas qui separe les deux comparaisons possibles. Une fiche saisie le
     matin pour une prise de poste l'apres-midi decrit quelqu'un qui commence
     aujourd'hui, pas une arrivee a preparer. Comparer l'arrivee a l'instant
     courant la classerait en preparation jusqu'a quinze heures, puis en
     active apres : la reponse changerait au fil de la journee. */
  const matin = new Date('2026-09-10T08:00:00Z').getTime();
  const e = etatALaCreation({ dateEmbauche: '2026-09-10T15:00:00Z', maintenant: matin });
  assert.strictEqual(
    e.statut_dossier, ACTIF,
    'une prise de poste dans la journee est une arrivee du jour, pas une preparation'
  );
  assert.strictEqual(e.actif, 1);
});

verifier('une date absente ou illisible n ouvre pas de preparation', () => {
  assert.strictEqual(etatALaCreation({ maintenant: LE_10_SEPTEMBRE }).statut_dossier, ACTIF);
  assert.strictEqual(
    etatALaCreation({ dateEmbauche: 'pas une date', maintenant: LE_10_SEPTEMBRE }).statut_dossier,
    ACTIF, 'une date illisible ne doit pas produire un etat inattendu'
  );
  assert.strictEqual(etatALaCreation({ dateEmbauche: '', maintenant: LE_10_SEPTEMBRE }).statut_dossier, ACTIF);
});

verifier('un statut demande explicitement prime sur la deduction', () => {
  const e = etatALaCreation({
    dateEmbauche: '2026-12-01', statutDemande: 'sorti', maintenant: LE_10_SEPTEMBRE,
  });
  assert.strictEqual(e.statut_dossier, 'sorti', 'une reprise d historique ne doit pas etre reinterpretee');
  assert.strictEqual(e.actif, 0);
  assert.strictEqual(e.deduit, false);
});

verifier('les passages depuis la preparation sont bornes', () => {
  assert.ok(transitionPermise(PREPARATION, ACTIF), 'l arrivee est confirmee');
  assert.ok(transitionPermise(PREPARATION, JAMAIS_ARRIVE), 'personne ne s est presente');
  assert.ok(
    !transitionPermise(PREPARATION, 'sorti'),
    'on ne sort pas quelqu un qui n est jamais entre : ce passage fabriquerait '
    + 'une sortie sans embauche, et un solde de tout compte avec elle'
  );
  assert.ok(!transitionPermise(PREPARATION, 'suspendu'));
});

verifier('une reembauche rouvre la fiche au lieu d en creer une seconde', () => {
  assert.ok(
    transitionPermise('sorti', PREPARATION) && transitionPermise('archive', PREPARATION),
    'c est ce passage qui aurait evite le doublon MAT-0013 / MAT-0017'
  );
});

verifier('une fiche active ne retombe pas en preparation', () => {
  assert.ok(
    !transitionPermise(ACTIF, PREPARATION),
    'quelqu un qui travaille ne redevient pas une arrivee a preparer'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n9 gardes vertes — parcours de la fiche agent`);

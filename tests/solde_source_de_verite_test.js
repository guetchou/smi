'use strict';
/*
 * Garde — le cache des soldes ne fait foi que là où il est tenu à jour.
 *
 * Mesuré en production le 21/09/2026 :
 *
 *   cashbox_balances : caisse_id=1, solde_courant = 0.00, figée au 02/09
 *   caisse réelle    : 2 402 000 XAF d'encaissements validés
 *
 * Le prochain paiement de décaissement sur la caisse principale aurait été
 * refusé sur « solde insuffisant — disponible 0 » avec 2,4 millions dedans.
 * Les décaissements 13 et 14 (930 075 XAF cumulés) attendaient à l'étape
 * précédente.
 *
 * Cause : les trois seuls écrivains de `cashbox_balances` sont des chemins de
 * décaissement. Aucun encaissement ne l'alimente. Sur une position « legacy »,
 * où le grand livre canonique dort, elle ne peut donc que baisser — jamais
 * remonter. Ce n'est pas un oubli ponctuel, c'est une asymétrie permanente.
 *
 * Le verrou pessimiste `FOR UPDATE` était une bonne intention : il empêche le
 * double paiement concurrent (commit f454a63). Le défaut est d'avoir fait du
 * cache à la fois l'OBJET du verrou et la SOURCE du solde. Les deux sont
 * séparés : le verrou passe sur `positions`, qui existe toujours et sérialise
 * aussi bien ; le solde ne vient du cache que si la position est « ready ».
 *
 * Ce qui est gardé est la règle, pas l'écriture : « le solde ne se lit dans le
 * cache que là où le cache fait foi, et le verrou reste pris avant la lecture ».
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const operations = lire('backend/routes/operations.js');
const avances = lire('backend/routes/agents_ecosystem_safe.js');

let vertes = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
};

/* Découpe la transaction de paiement : une garde qui nomme un passage doit
   lire CE passage, pas balayer 2 000 lignes jusqu'à un homonyme. */
const paiement = (operations.match(/Verrou pessimiste sur cashbox_balances[\s\S]{0,2500}/) || [])[0] || '';

verifier('le passage de paiement reste identifiable', () => {
  assert.ok(paiement, 'La transaction de paiement doit rester repérable');
  assert.ok(/SOLDE_INSUFFISANT/.test(paiement), 'La garde de solde doit y être');
});

verifier('le verrou est pris sur la position, pas sur le cache', () => {
  const iVerrou = paiement.search(/FROM positions WHERE id = \? FOR UPDATE/);
  assert.ok(iVerrou !== -1,
    'Le verrou doit porter sur une ligne qui existe toujours : sinon il ne verrouille rien');
  const iSolde = paiement.indexOf('const soldeBefore =');
  assert.ok(iSolde !== -1 && iVerrou < iSolde,
    'Pris après la lecture, le verrou n empêche plus le double paiement');
});

verifier('le cache n est lu que s il fait foi', () => {
  const iCondition = paiement.indexOf("ledger_status === 'ready'");
  const iLecture = paiement.indexOf('FROM cashbox_balances');
  assert.ok(iCondition !== -1,
    'Sans cette condition, une table figée décide du paiement — elle annonçait 0 pour 2 402 000 XAF');
  assert.ok(iLecture !== -1 && iCondition < iLecture,
    'La condition doit précéder la lecture, sinon elle ne la commande pas');
});

verifier('le calcul sur les operations reste le recours', () => {
  assert.ok(/getSoldePosition\(op\.position_id, op\.id\)/.test(paiement),
    'Hors du chemin canonique, le solde se calcule sur les opérations — c est la seule source complète');
});

verifier('l avance sur salaire suit la meme regle', () => {
  const iCondition = avances.indexOf("ledger_status === 'ready'");
  const iLecture = avances.indexOf('FROM cashbox_balances');
  assert.ok(iCondition !== -1 && iLecture !== -1 && iCondition < iLecture,
    'Le décaissement d une avance lisait le même cache figé, sans la même précaution');
});

verifier('et n ecrit pas le cache la ou il ne fait pas foi', () => {
  /* C est ce chemin qui a très probablement fait survivre la ligne empoisonnée
     à la remise à zéro du 02/09 : il recrée la ligne si la mise à jour ne
     touche rien. Une ligne posée sur une position « legacy » deviendrait
     autoritaire le jour où elle passerait en « ready ». */
  const iGarde = avances.indexOf('if (soldeFaitFoi) {');
  const iEcriture = avances.indexOf('INSERT INTO cashbox_balances');
  assert.ok(iGarde !== -1,
    'L écriture du cache doit être conditionnée, sinon la ligne empoisonnée revient');
  assert.ok(iEcriture !== -1 && iGarde < iEcriture,
    'La condition doit englober l écriture, pas la suivre');
});

console.log(vertes + '/6 gardes vertes — source de vérité du solde');

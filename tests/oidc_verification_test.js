'use strict';
/*
 * Garde — un jeton signe ne suffit pas a entrer.
 *
 * Une signature valide prouve seulement qu'un serveur d'identite a emis le
 * jeton. Elle ne dit ni pour quelle application, ni pour quel realm, ni pour
 * quelle demande. Ces trois questions decident de l'acces.
 *
 * Le risque est concret : Keycloak a vocation a servir Odoo, Dolibarr,
 * Chatwoot et les autres applications de la maison. Le jour ou l'une d'elles
 * est compromise, son jeton ne doit pas ouvrir la caisse.
 */
const assert = require('assert');
const { verifierRevendications, REFUS } = require('../backend/services/oidc-verification');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

const ISS = 'https://auth.topcenter.cg/realms/topcenter';
const T = 1789050000;
const attendu = { issuer: ISS, clientId: 'tala-smi', nonce: 'n-abc', maintenant: T };
const bon = { iss: ISS, aud: 'tala-smi', exp: T + 900, nonce: 'n-abc' };

verifier('un jeton conforme passe', () => {
  assert.ok(verifierRevendications(bon, attendu).ok);
});

verifier('le jeton d une autre application est refuse', () => {
  const r = verifierRevendications({ ...bon, aud: 'dolibarr' }, attendu);
  assert.strictEqual(r.motif, REFUS.AUDIENCE,
    'un jeton emis pour une autre application du meme realm ne doit pas ouvrir SMI');
});

verifier('le jeton d un autre realm est refuse', () => {
  const r = verifierRevendications(
    { ...bon, iss: 'https://auth.topcenter.cg/realms/autre' }, attendu);
  assert.strictEqual(r.motif, REFUS.EMETTEUR);
});

verifier('une audience en liste est acceptee', () => {
  assert.ok(verifierRevendications({ ...bon, aud: ['compte', 'tala-smi'] }, attendu).ok,
    'la forme liste est licite : la refuser rejetterait des jetons valides');
});

verifier('un jeton expire est refuse', () => {
  const r = verifierRevendications({ ...bon, exp: T - 3600 }, attendu);
  assert.strictEqual(r.motif, REFUS.EXPIRE);
});

verifier('une expiration absente est refusee', () => {
  const sansExp = { ...bon }; delete sansExp.exp;
  assert.strictEqual(verifierRevendications(sansExp, attendu).motif, REFUS.EXPIRE,
    'sans date d expiration, un jeton vaudrait indefiniment');
});

verifier('un ecart d horloge de quelques secondes ne casse pas la connexion', () => {
  assert.ok(verifierRevendications({ ...bon, exp: T - 30 }, attendu).ok,
    'deux machines n ont jamais la meme heure a la seconde pres');
  assert.ok(verifierRevendications({ ...bon, nbf: T + 30 }, attendu).ok);
});

verifier('un nonce different est refuse', () => {
  const r = verifierRevendications({ ...bon, nonce: 'autre' }, attendu);
  assert.strictEqual(r.motif, REFUS.NONCE, 'c est ce qui ferme le rejeu');
});

verifier('un nonce demande mais absent est refuse', () => {
  const sansNonce = { ...bon }; delete sansNonce.nonce;
  assert.strictEqual(
    verifierRevendications(sansNonce, attendu).motif, REFUS.NONCE_ABSENT,
    'l absence ne doit pas valoir acceptation'
  );
});

verifier('sans nonce demande, le controle ne s applique pas', () => {
  const sansNonce = { ...bon }; delete sansNonce.nonce;
  assert.ok(verifierRevendications(sansNonce, { ...attendu, nonce: null }).ok);
});

verifier('un jeton vide ou absent est refuse', () => {
  assert.strictEqual(verifierRevendications(null, attendu).ok, false);
  assert.strictEqual(verifierRevendications({}, attendu).ok, false);
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n11 gardes vertes — verification du jeton`);

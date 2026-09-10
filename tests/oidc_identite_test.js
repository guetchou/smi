'use strict';
/*
 * Garde — Keycloak authentifie, SMI autorise.
 *
 * Le risque que cette garde couvre est simple a enoncer et lourd a subir :
 * qu'un compte existant dans Keycloak ouvre SMI sans y avoir de compte, ou
 * qu'un compte desactive dans SMI continue d'entrer parce que Keycloak, lui,
 * l'accepte encore.
 *
 * Le compte 165 du 10/09/2026 en est l'illustration : desactive dans SMI, il
 * s'est vu refuser en 401 a la requete suivante. Ce comportement doit tenir
 * apres la migration -- desactiver un compte dans SMI doit continuer de
 * fermer la porte, sans dependre d'une action dans Keycloak.
 *
 * Elle garde aussi la provenance des roles : ils viennent de la base SMI, pas
 * du jeton. Un jeton porte des roles qu'un attaquant ne choisit pas, mais que
 * l'administrateur d'un autre realm pourrait, lui, modifier -- et Keycloak a
 * vocation a servir d'autres applications que celle-ci.
 */
const assert = require('assert');
const {
  identitePourSession, rolesDuCompte, emailRecherche, REFUS,
} = require('../backend/services/oidc-identite');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

const compteActif = {
  id: 2, email: 'princilia.louvouezo@topcenter.cg', nom: 'LOUVOUEZO', prenom: '',
  role: 'assistante_direction', roles: '["assistante_direction"]', actif: 1,
};
const jetonValide = { email: 'princilia.louvouezo@topcenter.cg', email_verified: true };

verifier('un compte connu et actif ouvre une session', () => {
  const r = identitePourSession(jetonValide, compteActif);
  assert.ok(r.ok);
  assert.strictEqual(r.identite.id, 2);
  assert.strictEqual(r.identite.role, 'assistante_direction');
});

verifier('un compte absent de SMI n ouvre rien', () => {
  const r = identitePourSession(jetonValide, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motif, REFUS.COMPTE_INCONNU,
    'exister dans Keycloak ne suffit pas : Keycloak servira d autres applications');
});

verifier('un compte desactive dans SMI reste ferme', () => {
  const r = identitePourSession(jetonValide, { ...compteActif, actif: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motif, REFUS.COMPTE_DESACTIVE,
    'desactiver un compte dans SMI doit fermer la porte sans passer par Keycloak');
});

verifier('une adresse non verifiee est refusee', () => {
  const r = identitePourSession({ email: 'x@topcenter.cg', email_verified: false }, compteActif);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motif, REFUS.EMAIL_NON_VERIFIE);
});

verifier('un jeton sans adresse est refuse', () => {
  assert.strictEqual(identitePourSession({}, compteActif).motif, REFUS.JETON_SANS_EMAIL);
  assert.strictEqual(identitePourSession(null, compteActif).motif, REFUS.JETON_SANS_EMAIL);
});

verifier('les roles viennent de la base, jamais du jeton', () => {
  const jetonMenteur = {
    ...jetonValide,
    realm_access: { roles: ['admin', 'dg'] },
    roles: ['admin'],
    role: 'admin',
  };
  const r = identitePourSession(jetonMenteur, compteActif);
  assert.ok(r.ok);
  assert.strictEqual(
    r.identite.role, 'assistante_direction',
    'le role du jeton ne doit jamais primer sur celui de la base'
  );
  assert.ok(
    !r.identite.roles.includes('admin'),
    'un role present dans le jeton mais absent de la base ne doit pas passer'
  );
});

verifier('le role principal figure toujours dans la liste', () => {
  const r = identitePourSession(jetonValide, { ...compteActif, roles: '["finance"]' });
  assert.ok(r.identite.roles.includes('assistante_direction'),
    'les gardes historiques interrogent le role principal : il doit etre dans la liste');
  assert.strictEqual(r.identite.roles[0], 'assistante_direction');
});

verifier('une colonne roles illisible ne fait pas tomber la session', () => {
  const r = identitePourSession(jetonValide, { ...compteActif, roles: 'pas du json' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.identite.roles, ['assistante_direction']);
});

verifier('l adresse cherchee est normalisee', () => {
  assert.strictEqual(emailRecherche({ email: '  Princilia.LOUVOUEZO@TopCenter.CG ' }),
    'princilia.louvouezo@topcenter.cg');
  assert.strictEqual(emailRecherche({}), '');
});

verifier('rolesDuCompte ne rend jamais de valeur vide', () => {
  assert.deepStrictEqual(rolesDuCompte({ role: 'rh', roles: null }), ['rh']);
  assert.deepStrictEqual(rolesDuCompte({ role: 'rh', roles: '[]' }), ['rh']);
  assert.deepStrictEqual(rolesDuCompte({ role: 'rh', roles: '["rh", null]' }), ['rh']);
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n10 gardes vertes — identite OIDC`);

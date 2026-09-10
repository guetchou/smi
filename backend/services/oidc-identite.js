'use strict';
/*
 * Ce que Keycloak prouve, et ce que SMI decide.
 *
 * Keycloak authentifie : il etablit qui se presente. SMI autorise : il decide
 * ce que cette personne peut faire, a partir de son compte et de ses profils
 * en base.
 *
 * La tentation etait de porter les roles dans Keycloak et de les lire depuis
 * le jeton. Elle est ecartee : SMI garde deja les roles, les profils et les
 * permissions nommees en base, et les deux jeux auraient diverge. La journee
 * du 10/09/2026 l'a montre deux fois -- une sortie validee dont la demande
 * restait ouverte au parapheur, un badge qui comptait autre chose que sa
 * liste. Deux sources tenues separement finissent toujours par diverger, et
 * sur des droits d'acces le prix est plus lourd qu'un compteur faux.
 *
 * Consequence pratique : un compte peut exister dans Keycloak sans ouvrir
 * SMI. L'inverse aussi. C'est voulu -- Keycloak servira d'autres applications
 * que celle-ci.
 */

/** Les motifs de refus, nommes pour que le journal serve a quelque chose. */
const REFUS = {
  JETON_SANS_EMAIL: 'jeton_sans_email',
  EMAIL_NON_VERIFIE: 'email_non_verifie',
  COMPTE_INCONNU: 'compte_inconnu',
  COMPTE_DESACTIVE: 'compte_desactive',
};

/**
 * L'identite a signer dans la session SMI, ou le refus motive.
 *
 * @param {object} claims   revendications du jeton Keycloak, deja verifiees
 * @param {object|null} compte  la ligne users de SMI, ou null si introuvable
 * @returns {{ok:true, identite:object}|{ok:false, motif:string}}
 */
function identitePourSession(claims, compte) {
  const email = String((claims && claims.email) || '').trim().toLowerCase();
  if (!email) return { ok: false, motif: REFUS.JETON_SANS_EMAIL };

  /* Une adresse non verifiee n'identifie personne : n'importe qui peut
     declarer l'adresse d'un autre a l'inscription. */
  if (claims.email_verified === false) {
    return { ok: false, motif: REFUS.EMAIL_NON_VERIFIE };
  }

  if (!compte) return { ok: false, motif: REFUS.COMPTE_INCONNU };
  if (!compte.actif) return { ok: false, motif: REFUS.COMPTE_DESACTIVE };

  return { ok: true, identite: {
    id: compte.id,
    email: compte.email,
    role: compte.role,
    roles: rolesDuCompte(compte),
    nom: compte.nom,
    prenom: compte.prenom || '',
  } };
}

/**
 * Les roles tels que SMI les connait.
 * Le role principal figure toujours en tete, meme si la colonne roles ne le
 * cite pas : c'est lui que les gardes historiques interrogent.
 */
function rolesDuCompte(compte) {
  let roles;
  try {
    roles = compte.roles ? JSON.parse(compte.roles) : [compte.role];
  } catch (_) {
    roles = [compte.role];
  }
  if (!Array.isArray(roles)) roles = [compte.role];
  roles = roles.filter(Boolean);
  if (!roles.includes(compte.role)) roles.unshift(compte.role);
  return roles;
}

/**
 * L'adresse a chercher dans SMI. Rendue separement pour que l'appelant
 * n'ait pas a redire la regle de normalisation dans sa requete.
 */
function emailRecherche(claims) {
  return String((claims && claims.email) || '').trim().toLowerCase();
}

module.exports = { identitePourSession, rolesDuCompte, emailRecherche, REFUS };

'use strict';
/*
 * Ce qu'un jeton doit prouver avant d'ouvrir une session.
 *
 * La signature est verifiee ailleurs, par la cle publique du serveur
 * d'identite. Ce qui est verifie ici est aussi important et plus facile a
 * oublier : qu'un jeton signe pour une autre application, un autre realm ou
 * une autre demande ne serve pas a entrer.
 *
 * Trois attaques que ces controles ferment :
 *
 *   — le jeton d'a cote. Keycloak servira d'autres applications ; un jeton
 *     valide emis pour l'une d'elles ne doit pas ouvrir SMI. C'est ce que
 *     verifie l'audience.
 *
 *   — le realm voisin. Un realm dont on ne maitrise pas l'administration
 *     signerait des jetons tout aussi valides. C'est ce que verifie l'emetteur.
 *
 *   — le rejeu. Un jeton intercepte, meme non expire, ne doit pas servir a une
 *     seconde connexion. C'est ce que verifie le nonce, tire a chaque demande.
 *
 * Les durees sont comparees avec une tolerance : deux machines n'ont jamais
 * exactement la meme heure, et refuser un jeton pour deux secondes d'ecart
 * produirait des echecs de connexion inexplicables.
 */

const TOLERANCE_SECONDES = 60;

const REFUS = {
  EMETTEUR: 'emetteur_inattendu',
  AUDIENCE: 'audience_inattendue',
  EXPIRE: 'jeton_expire',
  PAS_ENCORE_VALIDE: 'jeton_pas_encore_valide',
  NONCE: 'nonce_different',
  NONCE_ABSENT: 'nonce_absent',
};

/**
 * @param {object} claims  revendications du jeton, signature deja verifiee
 * @param {object} attendu { issuer, clientId, nonce, maintenant? }
 * @returns {{ok:true}|{ok:false, motif:string}}
 */
function verifierRevendications(claims, attendu) {
  if (!claims || typeof claims !== 'object') return { ok: false, motif: REFUS.EMETTEUR };
  const maintenant = Number.isFinite(attendu.maintenant)
    ? attendu.maintenant
    : Math.floor(Date.now() / 1000);

  if (claims.iss !== attendu.issuer) return { ok: false, motif: REFUS.EMETTEUR };

  /* L'audience peut etre une chaine ou une liste : les deux formes sont
     licites, et n'en accepter qu'une refuserait des jetons valides. */
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(attendu.clientId)) return { ok: false, motif: REFUS.AUDIENCE };

  if (!Number.isFinite(claims.exp) || claims.exp + TOLERANCE_SECONDES < maintenant) {
    return { ok: false, motif: REFUS.EXPIRE };
  }
  if (Number.isFinite(claims.nbf) && claims.nbf - TOLERANCE_SECONDES > maintenant) {
    return { ok: false, motif: REFUS.PAS_ENCORE_VALIDE };
  }

  /* Le nonce n'est verifie que s'il a ete demande -- mais alors il est
     obligatoire : l'absence ne vaut pas acceptation. */
  if (attendu.nonce) {
    if (!claims.nonce) return { ok: false, motif: REFUS.NONCE_ABSENT };
    if (claims.nonce !== attendu.nonce) return { ok: false, motif: REFUS.NONCE };
  }

  return { ok: true };
}

module.exports = { verifierRevendications, REFUS, TOLERANCE_SECONDES };

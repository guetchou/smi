'use strict';
/*
 * Le dialogue avec Keycloak : decouverte, cles publiques, echange du code.
 *
 * Aucune dependance ajoutee. Node 22 sait construire une cle publique a
 * partir d'un JWK, et jsonwebtoken sait verifier une signature RS256 avec
 * cette cle -- de quoi valider un jeton sans bibliotheque supplementaire.
 *
 * Deux caches, pour deux raisons differentes :
 *   — la decouverte change rarement : la relire a chaque connexion ajouterait
 *     un aller-retour reseau sur le chemin critique ;
 *   — les cles publiques tournent. Le cache est donc invalide des qu'un
 *     identifiant de cle inconnu se presente, plutot qu'a intervalle fixe :
 *     une rotation ne doit pas couper les connexions le temps d'une peremption.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = process.env.OIDC_ISSUER || '';
const CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || '';

/** L'integration est-elle configuree ? Sans cela, les routes restent fermees. */
function estConfigure() {
  return Boolean(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

let _decouverte = null;
let _cles = null; // kid -> KeyObject

async function decouverte() {
  if (_decouverte) return _decouverte;
  const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`decouverte OIDC indisponible (${r.status})`);
  _decouverte = await r.json();
  return _decouverte;
}

async function chargerCles() {
  const d = await decouverte();
  const r = await fetch(d.jwks_uri);
  if (!r.ok) throw new Error(`cles publiques indisponibles (${r.status})`);
  const { keys } = await r.json();
  const table = new Map();
  for (const jwk of keys || []) {
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      table.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (_) { /* une cle illisible ne doit pas empecher les autres */ }
  }
  _cles = table;
  return table;
}

async function clePour(kid) {
  if (!_cles) await chargerCles();
  if (_cles.has(kid)) return _cles.get(kid);
  // Identifiant inconnu : les cles ont probablement tourne.
  await chargerCles();
  return _cles.get(kid) || null;
}

/** L'URL vers laquelle envoyer la personne, avec PKCE et nonce. */
async function urlAutorisation({ state, nonce, codeVerifier }) {
  const d = await decouverte();
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // La langue de l'ecran suit celle du produit, pas celle du navigateur.
  u.searchParams.set('ui_locales', 'fr');
  return u.toString();
}

/** Le code recu contre les jetons. Le secret ne quitte pas le serveur. */
async function echangerCode(code, codeVerifier) {
  const d = await decouverte();
  const corps = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
  });
  const r = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corps,
  });
  if (!r.ok) {
    let motif = '';
    try { motif = (await r.json()).error_description || ''; } catch (_) {}
    throw new Error(`echange du code refuse (${r.status})${motif ? ' — ' + motif : ''}`);
  }
  return r.json();
}

/** La signature du jeton d'identite, verifiee par la cle publique du realm. */
async function verifierSignature(idToken) {
  const entete = JSON.parse(
    Buffer.from(String(idToken).split('.')[0] || '', 'base64url').toString('utf8')
  );
  if (entete.alg !== 'RS256') {
    // « none » et les algorithmes symetriques n'ont rien a faire ici.
    throw new Error(`algorithme de signature refuse : ${entete.alg}`);
  }
  const cle = await clePour(entete.kid);
  if (!cle) throw new Error('cle de signature inconnue');
  return jwt.verify(idToken, cle, { algorithms: ['RS256'] });
}

/** Ce qui a ete demande a Keycloak, pour confronter le jeton recu. */
function attenduPour(nonce) {
  return { issuer: ISSUER, clientId: CLIENT_ID, nonce };
}

module.exports = {
  estConfigure, decouverte, urlAutorisation, echangerCode,
  verifierSignature, attenduPour, CLIENT_ID, ISSUER, REDIRECT_URI,
};

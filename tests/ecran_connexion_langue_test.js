'use strict';
/*
 * Garde — l'écran de connexion parle français, et le thème est versionné.
 *
 * Constaté le 15/09/2026 en production : après expiration de session, l'agent
 * atterrit sur Keycloak, en anglais — « Username or email », « Password »,
 * « Sign In », « Forgot Password ».
 *
 * Le realm est pourtant configuré comme il faut :
 *
 *     loginTheme: topcenter      emailTheme: topcenter
 *     internationalizationEnabled: true
 *     supportedLocales: [en, fr]  defaultLocale: fr
 *
 * Keycloak choisit la langue dans cet ordre : ui_locales, puis l'attribut du
 * compte, puis le cookie kc_locale, puis l'en-tête Accept-Language, puis le
 * défaut du realm. L'Accept-Language du navigateur passe donc AVANT le défaut
 * du realm : un poste configuré en anglais voit un écran anglais.
 *
 * Mesuré sur la production, même URL, Accept-Language: en-US :
 *
 *     sans ui_locales   Username or email · Password · Sign In · Forgot Password
 *     avec ui_locales=fr  Mot de passe · Mot de passe oublié ? · Se connecter
 *
 * Le produit doit donc nommer sa langue au lieu de la laisser deviner.
 *
 * Second volet : le thème vit dans /opt/keycloak/themes, monté en lecture
 * seule dans le conteneur. Rien ne le versionnait — une reconstruction du
 * serveur l'aurait effacé sans trace, et l'écran serait revenu au thème
 * Keycloak par défaut. Cette garde exige que l'arbre du dépôt soit complet,
 * volet courriel compris : les messages « mot de passe oublié » suivent la
 * locale du destinataire et passent par le thème email, pas par ui_locales.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. le produit nomme sa langue ─────────────────────────────────────── */

verifier('la demande d autorisation porte ui_locales', () => {
  const source = fs.readFileSync(
    path.join(racine, 'backend/services/oidc-client.js'), 'utf8');
  const fonction = (source.match(/async function urlAutorisation[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(fonction, 'urlAutorisation introuvable');
  assert.ok(
    /searchParams\.set\('ui_locales',\s*'fr'\)/.test(fonction),
    'Sans ui_locales, Keycloak suit l Accept-Language du navigateur et rend un '
    + 'ecran anglais — mesure le 15/09/2026 sur la production.'
  );
  /* Le reste de la requete d autorisation ne doit pas avoir bouge. */
  for (const p of ['state', 'nonce', 'code_challenge', 'code_challenge_method']) {
    assert.ok(
      new RegExp(`searchParams\\.set\\('${p}'`).test(fonction),
      `${p} a disparu de la demande d autorisation`
    );
  }
});

/* ── 2. le thème est versionné, et complet ─────────────────────────────── */

const RACINE_THEME = 'deploy/keycloak/themes/topcenter';

verifier('le theme est versionne, volet connexion et volet courriel', () => {
  const attendus = [
    'login/theme.properties',
    'login/messages/messages_fr.properties',
    'login/resources/css/topcenter.css',
    'login/resources/img/logo.svg',
    'email/theme.properties',
    'email/messages/messages_fr.properties',
  ];
  const manquants = attendus.filter(
    f => !fs.existsSync(path.join(racine, RACINE_THEME, f)));
  assert.deepStrictEqual(
    manquants, [],
    'Le theme vit dans /opt/keycloak/themes, hors du depot. Ce qui n est pas '
    + 'versionne disparait a la premiere reconstruction :\n        ' + manquants.join('\n        ')
  );
});

verifier('le volet courriel declare le francais', () => {
  const p = fs.readFileSync(
    path.join(racine, RACINE_THEME, 'email/theme.properties'), 'utf8');
  assert.ok(/locales\s*=.*\bfr\b/.test(p),
    'Sans fr dans les locales, le theme courriel ne servira jamais le francais');
  assert.ok(/parent\s*=/.test(p), 'le theme courriel doit declarer son parent');
});

verifier('le volet connexion declare le francais', () => {
  const p = fs.readFileSync(
    path.join(racine, RACINE_THEME, 'login/theme.properties'), 'utf8');
  assert.ok(/locales\s*=.*\bfr\b/.test(p),
    'Sans fr dans les locales, ui_locales=fr ne trouvera aucune traduction');
});

verifier('les libelles francais de l ecran sont bien traduits', () => {
  const messages = fs.readFileSync(
    path.join(racine, RACINE_THEME, 'login/messages/messages_fr.properties'), 'utf8');
  /* Les quatre libelles vus en anglais le 15/09/2026 doivent avoir une
     traduction. On verifie la cle, pas la formulation : le texte visible
     appartient au produit, pas a cette garde. */
  for (const cle of ['usernameOrEmail', 'password', 'doLogIn', 'doForgotPassword']) {
    assert.ok(
      new RegExp(`^\\s*${cle}\\s*=\\s*\\S`, 'm').test(messages),
      `La cle ${cle} n a pas de traduction : ce libelle restera en anglais`
    );
  }
});

/* ── 3. la documentation dit comment le poser ──────────────────────────── */

verifier('le README dit ou le theme doit etre monte', () => {
  const readme = fs.readFileSync(
    path.join(racine, 'deploy/keycloak/README.md'), 'utf8');
  assert.ok(
    /themes/.test(readme),
    'Un theme versionne mais non deployable ne sert a rien : le README doit '
    + 'dire ou le monter'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — ecran de connexion`);
process.exit(echecs ? 1 : 0);

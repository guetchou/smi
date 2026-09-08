'use strict';

/*
 * Garde — l'écran de connexion doit dire la vraie cause du refus, et le
 * limiteur doit compter par agent.
 *
 * Constaté le 08/09/2026, une heure après la mise en service du journal des
 * refus. Louvouezo devait commencer la saisie quotidienne. Le journal montrait
 * cinq refus et zéro opération : elle n'avait pas échoué à saisir, elle
 * n'était jamais entrée.
 *
 *   13:58:11  code de sécurité inconnu      (redémarrage du serveur à 13h27)
 *   13:58:24  code de sécurité incorrect
 *   14:10:01  code de sécurité incorrect
 *   14:10:05  code de sécurité incorrect
 *   14:10:12  code de sécurité incorrect
 *
 * Cause du blocage : sur mauvaise réponse au calcul, le serveur rend
 * { error: 'Code de sécurité incorrect', captchaExpired: true } — les deux à
 * la fois, puisqu'il détruit le code au passage. L'écran testait
 * captchaExpired en premier et affichait « Code de sécurité rechargé ».
 * L'agent voyait donc un message d'incident technique alors qu'elle s'était
 * trompée de calcul : rien ne lui disait de recalculer. Quatre fois de suite.
 *
 * Second défaut, trouvé au passage : le limiteur comptait sur req.body.email
 * alors que l'écran envoie « identifier ». La clé était toujours indéfinie et
 * le comptage retombait sur l'adresse IP — un bureau entier partageait les
 * vingt tentatives, et l'échec d'un agent rapprochait le verrouillage de ses
 * collègues.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const connexion = fs.readFileSync(path.join(racine, 'frontend', 'index.html'), 'utf8');
const serveur = fs.readFileSync(path.join(racine, 'backend', 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(racine, 'backend', 'routes', 'auth.js'), 'utf8');

/* ── 1. Le serveur rend bien les deux signaux ensemble ──
   C'est l'invariant dont tout le reste découle. S'il changeait, cette garde
   devrait être revue avec l'écran. */
assert(
  /error: 'Code de sécurité incorrect', captchaExpired: true/.test(auth),
  'Le serveur signale une réponse fausse par error + captchaExpired ensemble : ' +
  'si cela change, l\'affichage doit être revu'
);

/* ── 2. L'écran montre la cause réelle, pas seulement le rechargement ──
   Un message qui parle d'incident technique là où l'agent s'est trompée de
   calcul la laisse sans moyen de se corriger. */
const brancheRechargement = connexion.slice(
  connexion.indexOf('if (data.captchaExpired) {'),
  connexion.indexOf('if (data.captchaExpired) {') + 900);

assert(
  /errText\.textContent = data\.error/.test(brancheRechargement),
  'Quand le serveur donne un motif, il doit être affiché : sans lui, l\'agent ' +
  'ne sait pas qu\'elle doit recalculer'
);
assert(
  /:\s*'Code de sécurité rechargé/.test(brancheRechargement),
  'Le message de rechargement reste le repli quand le serveur ne donne aucun motif'
);

/* Aucun texte nouveau : les deux libellés existaient déjà, seul change celui
   que l'on montre selon le cas. */
assert(
  connexion.includes('Code de sécurité rechargé — entrez le nouveau résultat et réessayez.'),
  'Le libellé de rechargement existant doit être conservé tel quel'
);

/* ── 3. Le limiteur compte par agent, pas par bureau ── */
const limiteur = serveur.slice(
  serveur.indexOf('const loginLimiter = rateLimit({'),
  serveur.indexOf('const apiLimiter'));

assert(
  /req\.body\?\.identifier/.test(limiteur),
  'La clé doit lire « identifier » — c\'est le champ que l\'écran de connexion envoie'
);
assert(
  /req\.socket\.remoteAddress/.test(limiteur),
  'L\'adresse doit rester le repli pour une requête sans identifiant'
);

const positionIdentifier = limiteur.indexOf('identifier');
const positionAdresse = limiteur.indexOf('remoteAddress');
assert(
  positionIdentifier !== -1 && positionIdentifier < positionAdresse,
  'L\'identifiant doit être lu AVANT l\'adresse : sinon tous les agents d\'un ' +
  'même bureau partagent le même quota'
);

/* Le champ que l'écran envoie réellement — l'invariant qui a été manqué. */
assert(
  /identifier:\s*document\.getElementById\('email'\)\.value/.test(connexion),
  'L\'écran envoie « identifier » : si ce nom change, la clé du limiteur doit suivre'
);

console.log(JSON.stringify({
  serverStillSignalsBothAtOnce: true,
  screenShowsTheRealCause: true,
  reloadMessageKeptAsFallback: true,
  noNewUserFacingText: true,
  limiterCountsPerAgent: true,
  addressRemainsTheFallback: true,
  identifierReadBeforeAddress: true,
  screenAndLimiterAgreeOnTheField: true,
}));

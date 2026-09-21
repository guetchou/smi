'use strict';
/*
 * Garde — l'application doit laisser une trace de ses requêtes, et cette
 * trace doit survivre au conteneur.
 *
 * Constaté le 18/09/2026, en enquêtant sur deux décaissements bloqués :
 *
 *   docker logs --since 72h caisse-topcenter | wc -l   ->  59 lignes
 *
 * et ces 59 lignes ne contenaient QUE la sortie des migrations. Aucune
 * requête, aucun 403, aucune erreur sur /api/operations. Le conteneur ayant
 * en outre été recréé à 13:59:32, la fenêtre 13:28–13:32 où les deux
 * décaissements ont été saisis était détruite. L'incident s'est donc enquêté
 * à l'aveugle, uniquement sur l'état final en base.
 *
 * Ce qui existait déjà et qu'on ne refait pas : « validationDiagnostic »
 * (backend/server.js) écrit « [VALIDATION-DIAG] » et une ligne « refus_saisie »
 * dans audit_logs — mais seulement pour les 4xx/5xx des POST/PUT/PATCH/DELETE,
 * 401 exclu, et seulement quand la réponse passe par res.json. Les GET, les
 * succès, les 401, les réponses hors res.json et les requêtes arrêtées avant
 * tout gestionnaire ne laissent rien.
 *
 * Deux exigences distinctes, gardées séparément :
 *   1. une ligne par requête, avec de quoi enquêter (méthode, chemin, statut,
 *      durée, agent) ;
 *   2. écrite dans le SEUL volume monté — /app/backend/data — car la sortie
 *      standard meurt avec le conteneur, et c'est exactement ce qui est arrivé.
 *
 * Et une interdiction : ce journal ne doit jamais faire fuiter ce que le
 * journal des refus prend soin de ne pas écrire. Pas de corps de requête, pas
 * d'en-tête d'autorisation, pas de chaîne de requête — un mot de passe part
 * dans le corps de /api/auth/login, un jeton dans l'en-tête.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const lire = f => fs.readFileSync(path.join(racine, f), 'utf8');

let vertes = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
};

const CHEMIN = 'backend/middleware/journal-http.js';

verifier('le journal existe', () => {
  assert.ok(fs.existsSync(path.join(racine, CHEMIN)),
    'Sans lui, le prochain incident de production s enquete a l aveugle, comme le 18/09/2026');
});

const journal = fs.existsSync(path.join(racine, CHEMIN)) ? lire(CHEMIN) : '';
const serveur = lire('backend/server.js');

verifier('il est monte dans le serveur', () => {
  assert.ok(/journal-http/.test(serveur), 'Le serveur doit charger le journal');
  assert.ok(/app\.use\([^)]*journalHttp/.test(serveur.replace(/\s+/g, ' ')),
    'Le journal doit etre monte comme intergiciel, sinon il n observe rien');
});

verifier('il ecrit dans le seul volume qui survit au conteneur', () => {
  /* docker inspect caisse-topcenter : un seul montage,
     /var/lib/docker/volumes/caisse-topcenter_caisse_data/_data -> /app/backend/data.
     Tout le reste est detruit quand le conteneur est recree. */
  assert.ok(/backend[\\/]?'?,?\s*'?data'|'data'/.test(journal),
    'Le fichier doit vivre dans backend/data : c est le seul volume monte');
  assert.ok(!/\/tmp\//.test(journal),
    'Ni /tmp ni aucun chemin ephemere : c est precisement ce qui a fait perdre la trace du 18/09');
});

verifier('il observe la fin de la reponse, pas seulement res.json', () => {
  /* validationDiagnostic n habille que res.json : une reponse rendue par
     res.send, res.end ou une erreur non rattrapee lui echappe. */
  assert.ok(/res\.on\(\s*'finish'/.test(journal),
    'Ecouter « finish » attrape toutes les reponses, quelle que soit la methode qui les rend');
});

verifier('il note de quoi enqueter', () => {
  for (const [champ, pourquoi] of [
    ['method', 'sans la methode on ne sait pas si l agent lisait ou ecrivait'],
    ['status', 'le statut est ce qui distingue un refus d un succes'],
    ['duree', 'une requete lente et une requete refusee ne se soignent pas pareil'],
    ['user', 'sans l agent on ne sait pas a qui c est arrive'],
  ]) {
    assert.ok(new RegExp(champ, 'i').test(journal), `Le journal doit porter ${champ} : ${pourquoi}`);
  }
});

verifier('il ne fait fuiter ni corps, ni jeton, ni chaine de requete', () => {
  /* Un mot de passe part dans le corps de /api/auth/login, un jeton dans
     l en-tete Authorization. Le journal des refus s en garde deja
     (safeBodyShape ne rend que des formes) ; celui-ci ne doit pas defaire
     cette precaution par la porte de derriere. */
  assert.ok(!/req\.body/.test(journal),
    'Le corps de la requete ne doit jamais entrer dans le journal : le mot de passe y passe');
  assert.ok(!/req\.headers\s*\[|\.get\(\s*'[Aa]uthorization/.test(journal),
    'Aucun en-tete ne doit etre journalise : le jeton y passe');
  assert.ok(/split\(\s*'\?'\s*\)\[0\]/.test(journal),
    'Le chemin doit perdre sa chaine de requete : une donnee personnelle peut s y trouver');
});

verifier('son echec ne casse jamais la requete qu il observe', () => {
  /* Le principe est deja pose dans server.js, au-dessus de journaliserRefus :
     « L'ecriture ne doit jamais faire echouer la requete qu'elle observe ». */
  assert.ok(/try\s*\{/.test(journal) && /catch/.test(journal),
    'L ecriture doit etre protegee : un disque plein ne doit pas rendre l application indisponible');
});

verifier('il ne remplit pas le disque', () => {
  /* Un journal qui grossit sans fin finit par saturer le volume, et c est
     l application qui tombe — un remede pire que le mal. */
  assert.ok(/rename|rotation|TAILLE|taille/i.test(journal),
    'Le journal doit tourner sur lui-meme : sans rotation il sature le volume');
});

verifier('il n avale pas le trafic des fichiers statiques', () => {
  /* L application sert aussi frontend/ : journaliser chaque image et chaque
     feuille de style noierait les appels d API, qui sont ce qu on vient lire. */
  assert.ok(/\/api/.test(journal),
    'Le journal doit savoir distinguer un appel d API du reste');
});

console.log(vertes + '/9 gardes vertes — journal HTTP');

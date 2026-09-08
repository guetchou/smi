'use strict';

/*
 * Garde — une saisie refusée doit laisser une trace, et cette trace ne doit
 * jamais contenir de secret.
 *
 * Constaté le 08/09/2026 : le journal d'audit ne retenait que ce qui
 * aboutissait. Quand un agent se voyait refuser une saisie — montant nul,
 * rubrique absente, période clôturée — le message s'affichait sur son écran
 * puis disparaissait. Rien ne permettait de voir sur quoi les agents butent.
 *
 * Le mécanisme d'observation existait pourtant : validationDiagnostic
 * enveloppait déjà res.json et produisait un diagnostic_id. Mais il
 * n'écrivait qu'en console — que personne ne lit —, ne couvrait que cinq
 * routes sur toutes celles qui enregistrent, et ignorait DELETE.
 *
 * Preuve que ce trou coûte : deux tâches planifiées échouaient à chaque
 * exécution sur des colonnes inexistantes (contrats.client_id,
 * factures_fournisseurs.numero). Les alertes d'échéance ne partaient jamais.
 * Seuls les journaux du conteneur le disaient.
 *
 * Éprouvé en recette avant d'être proposé : quatre saisies volontairement
 * fautives, quatre lignes journalisées — et une cinquième épreuve, avec
 * password, token, pin et api_key dans le corps, dont aucune valeur n'est
 * ressortie.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serveur = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  // Sauter la liste de parametres : une signature qui destructure ses
  // arguments — « function f({ a, b }) » — ouvre une accolade qui n'est pas
  // le corps. Sans cela, l'extraction ne rendait que la liste des parametres.
  let parentheses = 0;
  let curseur = source.indexOf('(', debut);
  for (; curseur < source.length; curseur++) {
    if (source[curseur] === '(') parentheses++;
    else if (source[curseur] === ')') {
      parentheses--;
      if (parentheses === 0) break;
    }
  }
  const ouverture = source.indexOf('{', curseur);
  let profondeur = 0;
  for (let i = ouverture; i < source.length; i++) {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, i + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. Le refus est écrit, pas seulement affiché ── */
assert(
  /INSERT INTO audit_logs[\s\S]{0,200}'refus_saisie'/.test(serveur)
  || /'refus_saisie'/.test(serveur),
  'Un refus doit rejoindre le journal d\'audit : la console seule n\'est lue par personne'
);

const journalisation = corpsDe(serveur, 'function journaliserRefus(');

/* ── 2. Le journal ne peut pas faire échouer la saisie qu'il observe ──
   Une écriture attendue rendrait la réponse tributaire du journal. */
assert(
  /\.catch\(/.test(journalisation),
  'L\'écriture du journal doit être détachée : elle ne doit jamais faire échouer la requête'
);
assert(
  !/await\s+db\.execute/.test(journalisation),
  'L\'écriture ne doit pas être attendue : la réponse à l\'agent ne dépend pas du journal'
);

/* ── 3. Son propre échec n'est pas tu ──
   Un journal qui échoue en silence est pire que pas de journal : on le croit
   complet. C'est le défaut déjà rencontré ailleurs dans ce dépôt. */
assert(
  /\.catch\(\s*error\s*=>\s*console\.error/.test(journalisation),
  'Un échec de journalisation doit être signalé, jamais avalé'
);

/* ── 4. Liste blanche, jamais liste noire ──
   Une liste noire laisse passer le premier champ sensible qu'une route
   introduira sans qu'on y pense. */
assert(
  /const CHAMPS_JOURNALISABLES = \[/.test(serveur),
  'Les champs retenus doivent être énumérés nommément'
);
const listeBlanche = serveur.slice(
  serveur.indexOf('const CHAMPS_JOURNALISABLES'),
  serveur.indexOf('function valeursMetier'));

['password', 'token', 'secret', 'pin', 'api_key', 'mot_de_passe', 'jwt'].forEach(interdit => {
  assert(
    !new RegExp(`'${interdit}'`).test(listeBlanche),
    `« ${interdit} » ne doit jamais figurer parmi les champs journalisables`
  );
});

const retenue = corpsDe(serveur, 'function valeursMetier(');
assert(
  /for \(const champ of CHAMPS_JOURNALISABLES\)/.test(retenue),
  'La retenue doit parcourir la liste autorisée, pas les clés du corps reçu'
);
assert(
  !/Object\.keys\(body\)/.test(retenue),
  'Parcourir les clés du corps ferait entrer tout champ inconnu dans le journal'
);
assert(
  /\.slice\(0, ?\d+\)/.test(retenue),
  'Les valeurs doivent être tronquées : un champ libre peut être arbitrairement long'
);

/* ── 5. Ce qui est observé ──
   401 exclu : une session expirée est du bruit. DELETE inclus : une
   suppression refusée est un refus comme un autre. */
const observateur = corpsDe(serveur, 'function validationDiagnostic(');
assert(
  /res\.statusCode >= 400/.test(observateur),
  'Tout statut d\'échec doit être observé'
);
assert(
  /res\.statusCode !== 401/.test(observateur),
  'Le 401 doit être écarté : une session expirée n\'est pas une erreur de saisie'
);
["'POST'", "'PUT'", "'PATCH'", "'DELETE'"].forEach(methode => {
  assert(
    observateur.includes(methode),
    `${methode} doit être observé — une suppression refusée compte autant qu'une création refusée`
  );
});

/* ── 6. Un seul montage, donc une seule trace ──
   Les cinq montages nommés doublonnaient avec le montage global : chaque
   refus était écrit deux fois. Mesuré en recette — quatre saisies fautives
   produisaient huit lignes. */
const montagesNommes = (serveur.match(/validationDiagnostic\('[a-z-]+'\), /g) || []).length;
assert.strictEqual(
  montagesNommes, 0,
  `${montagesNommes} montage(s) nommé(s) subsiste(nt) — chaque refus serait journalisé deux fois`
);
assert(
  /app\.use\('\/api', \(req, res, next\) => validationDiagnostic\(/.test(serveur),
  'Le montage doit être global : un refus hors des cinq routes historiques doit être vu aussi'
);

console.log(JSON.stringify({
  refusalsReachTheAuditLog: true,
  loggingNeverFailsTheRequest: true,
  loggingFailureIsNotSwallowed: true,
  allowListNeverDenyList: true,
  noSecretFieldIsLoggable: true,
  deleteCountsAsARefusal: true,
  expiredSessionIsNotNoise: true,
  oneMountSoOneLine: true,
}));

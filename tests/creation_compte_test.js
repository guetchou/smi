'use strict';

/*
 * Garde — le formulaire ne doit offrir que ce que le serveur accepte.
 *
 * Constaté en production le 03/09/2026, sur le code déployé.
 *
 * La route POST /agents/:id/create-user exige « profile_code » depuis que
 * j'ai posé la règle « jamais de compte sans profil actif ». Le formulaire
 * d'onboarding, lui, n'envoie que « role » et « email ». Toute création de
 * compte agent répondait donc 400, « Le profil est requis ».
 *
 * C'est ma régression : j'ai livré le serveur sans le formulaire. La leçon
 * n'est pas « ne pas oublier », c'est que le formulaire doit être vérifié
 * contre ce que la route exige.
 *
 * Second défaut trouvé en le réparant : le sélecteur offrait « Délégué »,
 * un rôle sans profil correspondant en base. Cette option ne pouvait pas
 * aboutir — elle aurait rendu « Profil inconnu ou inactif : delegue ».
 * Aucun compte n'a jamais été créé avec, la délégation ayant son propre
 * mécanisme et sa propre table.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const route = fs.readFileSync(path.join(racine, 'backend', 'routes', 'agents.js'), 'utf8');

function corpsDe(source, nom) {
  const debut = source.indexOf(nom);
  assert(debut !== -1, `${nom} doit exister`);
  const ouverture = source.indexOf('{', debut);
  let profondeur = 0;
  for (let j = ouverture; j < source.length; j++) {
    if (source[j] === '{') profondeur++;
    else if (source[j] === '}') {
      profondeur--;
      if (profondeur === 0) return source.slice(debut, j + 1);
    }
  }
  throw new Error(`Accolades non refermées pour ${nom}`);
}

/* ── 1. Ce que la route exige, le formulaire l'envoie ──
   L'invariant n'est pas « profile_code figure quelque part », c'est que le
   champ exigé par le serveur soit effectivement transmis. */
assert(
  /if \(!profile_code\) return res\.status\(400\)/.test(route),
  'La route doit toujours exiger un profil : c est la règle « jamais de compte sans profil actif »'
);

const envoi = corpsDe(markup, 'async function obCreateUser()');
assert(
  /profile_code/.test(envoi),
  'Le formulaire doit envoyer profile_code : sans lui la route répond 400 et aucun compte ne se crée'
);
assert(
  /body: JSON\.stringify\(\{[^}]*profile_code[^}]*\}\)/.test(envoi),
  'profile_code doit figurer dans le corps envoyé, pas seulement être lu quelque part'
);

/* ── 2. Le formulaire n'offre rien d'irréalisable ──
   « Délégué » n'avait pas de profil en base : l option ne pouvait pas
   aboutir. Une option qui échoue toujours est un défaut, pas une
   fonctionnalité. */
const selecteur = markup.match(/<select id="ob-role-select"[\s\S]*?<\/select>/)[0];
const optionsOffertes = [...selecteur.matchAll(/value="([^"]+)"/g)].map(m => m[1]);

assert(
  !optionsOffertes.includes('delegue'),
  'Le rôle « delegue » n a pas de profil correspondant : l offrir garantit un échec à la création'
);
assert(
  optionsOffertes.length >= 6,
  `Le sélecteur doit garder ses autres options (${optionsOffertes.length} trouvée(s)) : réparer n est pas amputer`
);

/* Les options restantes sont exactement celles qui portent un profil.
   La liste est figée ici volontairement : si un profil disparaît de la base,
   c est cette garde qui doit le dire, pas l utilisateur au moment de créer
   un compte. */
const AVEC_PROFIL = ['lecteur', 'caissier', 'finance', 'rh', 'assistante_direction', 'dg'];
for (const code of AVEC_PROFIL) {
  assert(
    optionsOffertes.includes(code),
    `« ${code} » porte un profil actif en base : il doit rester offert`
  );
}
for (const code of optionsOffertes) {
  assert(
    AVEC_PROFIL.includes(code),
    `« ${code} » est offert sans profil connu : la création échouerait`
  );
}

/* ── 3. Le profil envoyé est celui que l'utilisateur a choisi ──
   Un profil codé en dur reviendrait à ignorer le sélecteur. */
assert(
  !/profile_code:\s*'[a-z_]+'/.test(envoi),
  'Le profil ne doit pas être codé en dur : il vient du choix fait dans le sélecteur'
);

console.log(JSON.stringify({
  routeStillRequiresAProfile: true,
  formSendsWhatTheRouteRequires: true,
  noOptionOfferedThatCannotSucceed: true,
  everyProfiledRoleStillOffered: true,
  chosenProfileIsTheOneSent: true,
}));

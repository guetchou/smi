const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root    = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'backend/services/user_provisioning.js'), 'utf8');
const route   = fs.readFileSync(path.join(root, 'backend/routes/agents.js'), 'utf8');
const perms   = fs.readFileSync(path.join(root, 'backend/services/permissions.js'), 'utf8');

/* ── Un compte sans profil n'a aucun droit ──
   Releve du 01/09/2026. Les permissions viennent des profils : can() consulte
   la permission directe, la delegation, PUIS le profil, et ne retombe sur les
   roles qu'en dernier recours, via une table codee en dur qui ne couvre qu'une
   partie des 100 permissions.

   createUserAccess appelle deja syncUserProfilesFromRoles, qui attache les
   profils portant le nom d'un role. Mais cette derivation ne peut atteindre
   que huit profils sur dix-neuf : onze profils metier — agent et superviseur
   call center, agent commercial, commercial & marketing, manager technique,
   assistant IT, moyens generaux, achats/logistique, technicien de surface,
   stagiaire, audit/controle, chargee de projet — n'ont aucun role homonyme.

   Pire, la derivation ecarte explicitement 'lecteur', qui etait le role par
   defaut du provisionnement : un agent provisionne par defaut recevait donc un
   compte sans aucun profil actif. Verifie en production — le compte
   lecteur@topcenter.cg portait sa seule ligne user_profiles en active=0.

   Le profil est donc rendu obligatoire et choisi. Il n'est pas rendu implicite :
   le profil 'lecteur' donne salary.report.view et cash.report.view, et en faire
   le defaut donnerait a un technicien de surface la vue sur les salaires. */

/* ── 1. Le profil est exige, et validé contre la table des profils ── */

assert(
  /if \(!opts\.profile_code\) throw new Error\(/.test(service),
  'Le provisionnement doit refuser un compte sans profil : sans profil, le compte n a aucun droit'
);
assert(
  /SELECT id, code, libelle FROM profiles WHERE code = \? AND actif = 1/.test(service),
  'Le profil doit etre valide contre la table des profils, et non contre la liste des huit roles'
);
assert(
  /Profil inconnu ou inactif/.test(service),
  'Un profil inexistant ou desactive doit etre refuse nommement'
);

/* R2 s'etend au profil : ce que le role admin ne peut pas obtenir par ce
   chemin, le profil admin ne doit pas l'obtenir non plus. */
assert(
  /if \(opts\.profile_code === 'admin'\) throw new Error\(/.test(service),
  'Le profil admin doit etre interdit par ce chemin, comme le role admin l est deja'
);
assert(
  /R1b/.test(service),
  'L invariant doit etre enonce dans l en-tete du service, comme R1 a R7'
);

/* ── 2. Le profil est ecrit avec source='manual' ──
   syncUserProfilesFromRoles ne touche que les lignes source='legacy_role' et
   preserve explicitement les lignes manuelles. C'est le point d'extension
   prevu par le modele : le profil choisi ne doit pas etre efface par la
   derivation depuis les roles. */

const syncro = perms.match(/async function syncUserProfilesFromRoles\([\s\S]*?\n\}/)[0];
assert(
  /source='legacy_role'/.test(syncro),
  'La derivation depuis les roles doit continuer de ne toucher que ses propres lignes'
);
assert(
  /source=CASE WHEN source='manual' THEN source ELSE 'legacy_role' END/.test(syncro),
  'La derivation doit continuer de preserver les attributions manuelles — c est ce qui rend le choix durable'
);
assert(
  /INSERT INTO user_profiles[\s\S]{0,220}'manual'/.test(service),
  "Le profil choisi doit etre ecrit avec source='manual', sinon la derivation par role l effacera"
);

/* L'ecriture doit se faire dans la transaction qui cree deja le compte : un
   compte cree sans son profil serait exactement le defaut corrige ici. */
const iTransaction = service.indexOf('await db.transaction(async (tx) => {');
const iProfil      = service.indexOf('INSERT INTO user_profiles');
const iFinTx       = service.indexOf('  });', iTransaction);
assert(iTransaction !== -1 && iProfil !== -1, 'Structure du provisionnement introuvable');
assert(
  iTransaction < iProfil && iProfil < iFinTx,
  'Le profil doit etre attache dans la transaction qui cree le compte, pas apres'
);

/* ── 3. La creation reste tracee, profil compris ── */
assert(
  /JSON\.stringify\(\{ user_id, email, role, profil: profil\.code \}\)/.test(service),
  "L evenement d onboarding doit nommer le profil attribue : c est ce qu un controle viendra lire"
);

/* ── 4. Le Directeur General peut faire entrer un agent ──
   La route exigeait le role admin en dur. Le DG ne pouvait donc pas creer de
   compte, alors que faire entrer l equipe releve de sa fonction. La garde
   porte desormais sur la permission, que la table de repli de can() accorde a
   admin et dg. */

const routeCreation = route.match(/router\.post\('\/:id\/create-user'[\s\S]*?\n\}\);/)[0];
assert(
  !/hasRole\(req\.user, 'admin'\)/.test(routeCreation),
  'La garde ne doit plus etre un role admin en dur : le DG doit pouvoir faire entrer un agent'
);
assert(
  /await can\(req\.user, 'access\.manage'\)/.test(routeCreation),
  'La garde doit porter sur la permission access.manage'
);
assert(
  /LEGACY_PERMISSION_ROLES = \{[\s\S]*?'access\.manage':\s*\['admin', 'dg'\]/.test(perms),
  'access.manage doit rester accordee a admin et dg par la table de repli, sinon le DG reste bloque'
);

/* R2 tient toujours au niveau de la route. */
assert(
  /role === 'admin'/.test(routeCreation) && /profile_code === 'admin'/.test(routeCreation),
  'Ni le role ni le profil admin ne doivent pouvoir etre attribues par ce chemin'
);
assert(
  /if \(!profile_code\) return res\.status\(400\)/.test(routeCreation),
  'La route doit exiger le profil avant d appeler le service'
);

/* ── 5. Les dix-neuf profils sont proposables ──
   Le choix doit venir de la table des profils, pas d une liste figee dans le
   code — sinon les onze profils metier resteraient hors de portee. */
assert(
  /async function profilsDisponibles\(\)/.test(service),
  'Le service doit exposer les profils attribuables, lus depuis la base'
);
assert(
  /WHERE pr\.actif = 1 AND pr\.code <> 'admin'/.test(service),
  'La liste proposee doit exclure le profil admin et les profils desactives'
);
assert(
  /router\.get\('\/profils-disponibles'/.test(route),
  'Une route doit exposer les profils attribuables a l ecran de creation'
);

console.log(JSON.stringify({
  profileRequiredAtCreation: true,
  profileValidatedAgainstProfilesTable: true,
  adminProfileForbiddenLikeAdminRole: true,
  writtenAsManualSoRoleSyncCannotEraseIt: true,
  writtenInsideTheAccountTransaction: true,
  onboardingEventNamesTheProfile: true,
  directorCanOnboard: true,
  allNineteenProfilesReachable: true,
}));

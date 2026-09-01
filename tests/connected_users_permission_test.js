const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const server = read('backend/server.js');
const markup = read('frontend/dashboard.html');

/* ── Les deux bouts doivent juger sur le meme critere ──
   L'ecran des habilitations affichait « Erreur — Admin requis » au Directeur
   General, et la tuile CONNECTES restait vide :
   GET /api/admin/connected-users -> 403, repete toutes les 30 secondes.

   Le front decidait d'appeler sur canManageAccessFrontend(), qui teste les
   permissions d'administration des habilitations — le DG les detient. Le
   serveur exigeait le role admin. Le desaccord se voyait a chaque chargement. */

const route = server.match(/app\.get\('\/api\/admin\/connected-users'[\s\S]*?\n\}\);/)[0];

assert(
  /if \(!await can\(req\.user, 'access\.manage'\)\)/.test(route),
  'La route doit juger sur la permission d administration des habilitations, pas sur un role'
);
assert(
  !/hasRole\(req\.user, 'admin'\)/.test(route),
  'Le controle par role seul excluait le DG, qui detient pourtant la permission'
);
assert(/await can\(/.test(route), 'can() est asynchrone : l oublier rendrait le garde toujours vrai');

/* La permission choisie doit etre l'une de celles sur lesquelles l'ecran decide
   d'appeler : sinon le desaccord reapparait, dans un sens ou dans l'autre. */
const gardeFront = markup.match(/function canManageAccessFrontend\(\) \{[\s\S]*?\n\}/)[0];
const permissionServeur = route.match(/can\(req\.user, '([^']+)'\)/)[1];
assert(
  gardeFront.includes(`'${permissionServeur}'`),
  `Le serveur exige ${permissionServeur}, que l ecran ne teste pas pour decider d appeler : ` +
  'les deux bouts doivent juger sur le meme critere'
);

/* can() traite le role admin en superutilisateur : l acces des admins est
   conserve sans avoir a le nommer. */
const service = read('backend/services/permissions.js');
assert(
  /if \(adminSuperuser && hasRole\(user, 'admin'\)\) return true;/.test(service),
  'Le role admin doit rester admis par can(), sinon ce correctif lui retire l acces'
);

console.log(JSON.stringify({
  serverJudgesOnPermission: true,
  sameCriterionAsTheScreen: true,
  adminStillAdmittedViaSuperuser: true,
  canIsAwaited: true,
}));

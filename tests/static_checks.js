// Contrôles statiques anti-dette exécutables sans dépendances externes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function checkFrontendModuleMapping() {
  const html = read('frontend/dashboard.html');
  const navPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(match => match[1]);
  const uniqueNavPages = [...new Set(navPages)].sort();

  const pageModulesMatch = html.match(/const PAGE_MODULES = \{([\s\S]*?)\n\};/);
  assert(pageModulesMatch, 'PAGE_MODULES introuvable dans frontend/dashboard.html');

  const mappedPages = [...pageModulesMatch[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)]
    .map(match => match[1]);

  const missing = uniqueNavPages.filter(page => !mappedPages.includes(page));
  assert.deepStrictEqual(missing, [], `Pages sans mapping PAGE_MODULES: ${missing.join(', ')}`);

  return { navPages: uniqueNavPages.length, mappedPages: mappedPages.length };
}

function checkComposeNoObsoleteVersion() {
  const compose = read('docker-compose.yml');
  assert(
    !/^\s*version\s*:/m.test(compose),
    'docker-compose.yml contient encore la clé obsolète version:'
  );
  return { composeVersionKey: false };
}

function checkAgentExitInvariant() {
  const offboarding = read('backend/routes/offboarding.js');
  assert(
    /UPDATE\s+employes[\s\S]*SET[\s\S]*actif\s*=\s*0[\s\S]*statut_dossier\s*=\s*'sorti'/m.test(offboarding),
    "La validation de sortie doit forcer employes.actif=0 avec statut_dossier='sorti'"
  );

  const migration = read('backend/migrations/019_mark_sortis_inactive.sql');
  assert(
    /WHERE\s+actif\s*=\s*1[\s\S]*statut_dossier\s+IN\s*\(\s*'sorti'\s*,\s*'archive'\s*\)/m.test(migration),
    "La migration 019 doit reparer les agents sortis/archives encore actifs"
  );

  return { exitSetsInactive: true, repairMigration: true };
}

function checkUserAgentLinkInvariant() {
  const usersRoute = read('backend/routes/users.js');
  assert(
    /return\s+allRoles\.some\(r\s*=>\s*r\s*!==\s*'admin'\s*\)/m.test(usersRoute),
    "Seul le role admin peut rester sans fiche agent; DG/RH/finance/lecteur doivent etre lies"
  );

  const migration = read('backend/migrations/020_enforce_non_admin_agent_links.sql');
  assert(
    /WHERE\s+actif\s*=\s*1[\s\S]*employe_id\s+IS\s+NULL[\s\S]*role\s*<>\s*'admin'/m.test(migration),
    "La migration 020 doit neutraliser les comptes actifs non-admin sans fiche agent"
  );

  return { onlyAdminCanBeUnlinked: true, repairMigration: true };
}

function checkAgentProvisioningUiVisible() {
  const html = read('frontend/dashboard.html');
  assert(
    html.includes('openAgentOnboarding') && html.includes('Compte / Onboarding'),
    "La liste agents doit exposer un acces direct au provisioning compte utilisateur"
  );
  assert(
    /if\s*\(\s*isAdmin\s*\|\|\s*hasTask\s*\|\|\s*employe\.besoin_acces_systeme\s*\|\|\s*user_account\s*\)/m.test(html),
    "Le bloc Compte systeme doit rester visible pour Admin meme sans checklist onboarding"
  );

  const onboarding = read('backend/services/onboarding.js');
  assert(
    /user_account:\s*userAccount\s*\|\|\s*null/m.test(onboarding),
    "L'onboarding doit exposer le compte utilisateur deja lie"
  );

  return { directAction: true, adminVisible: true, accountReturned: true };
}

function checkSalaryUpdateFalsePositiveGuard() {
  const agentsRoute = read('backend/routes/agents.js');
  assert(
    /const\s+hasSalaryChange\s*=\s*salaryFields\.some\(f\s*=>[\s\S]*numberOrZero\(req\.body\[f\]\)\s*!==\s*numberOrZero\(agent\[f\]\)/m.test(agentsRoute),
    "PUT /agents/:id ne doit pas traiter la presence des champs salaire comme une modification sans comparer les valeurs"
  );
  assert(
    /salaire_base\s*===\s*undefined\s*\?\s*numberOrZero\(agent\.salaire_base\)/m.test(agentsRoute),
    "PUT /agents/:id doit conserver le salaire existant si le champ n'est pas envoye"
  );

  return { comparesValues: true, preservesExistingSalary: true };
}

function checkFrontendSilentBreakGuards() {
  const html = read('frontend/dashboard.html');
  assert(
    /function\s+openModal\(id\)\s*\{[\s\S]*typeof\s+id\s*===\s*'object'[\s\S]*openGenericModal\(id\)/m.test(html),
    "openModal doit accepter les objets de configuration utilises par ventes/achats/contrats"
  );
  assert(
    /function\s+openGenericModal\(\{[\s\S]*onConfirm[\s\S]*generic-modal-confirm/m.test(html),
    "openGenericModal doit executer onConfirm et afficher des boutons de validation"
  );
  assert(
    !/localStorage\.getItem\(['"]token['"]\)/m.test(html),
    "Le frontend ne doit plus utiliser l'ancien token localStorage 'token'; utiliser tc_token"
  );
  const staticHtml = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const ids = [...staticHtml.matchAll(/\bid=(["'])([^"']+)\1/g)].map(m => m[2]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepStrictEqual([...new Set(duplicateIds)], [], `IDs HTML statiques dupliques: ${[...new Set(duplicateIds)].join(', ')}`);
  assert(
    !/showPage\(['"]rapprochements['"]\)/m.test(html),
    "Le bouton cloture doit pointer vers la page existante rapprochement"
  );
  assert(
    /parapheur:\s*'Parapheur'/m.test(html),
    "La page parapheur doit avoir un titre topbar explicite"
  );
  assert(
    /document\.getElementById\('parapheur-demande-titre'\)\.value/m.test(html),
    "La soumission parapheur doit lire le champ titre dedie, sans collision avec le drawer periode"
  );

  return { genericModal: true, canonicalToken: true, noStaticDuplicateIds: true, validTopbarTargets: true };
}

function checkOnboardingSchemaMigration() {
  const migration = read('backend/migrations/021_onboarding_schema.sql');
  const provisioningMigration = read('backend/migrations/022_user_provisioning_schema.sql');
  assert(
    /ADD COLUMN onboarding_status/m.test(migration) &&
    /ADD COLUMN besoin_acces_systeme/m.test(migration),
    "La migration onboarding doit ajouter les colonnes employes utilisees par le service"
  );
  assert(
    /CREATE TABLE IF NOT EXISTS onboarding_tasks/m.test(migration) &&
    /CREATE TABLE IF NOT EXISTS onboarding_events/m.test(migration),
    "La migration onboarding doit creer les tables lues/ecrites par le service"
  );

  const onboarding = read('backend/services/onboarding.js');
  assert(
    /SELECT id, nom, prenom, matricule, onboarding_status, besoin_acces_systeme/m.test(onboarding),
    "Le service onboarding doit rester couvert par une migration MySQL versionnee"
  );

  const provisioning = read('backend/services/user_provisioning.js');
  assert(
    /ADD COLUMN temp_password_hash/m.test(provisioningMigration) &&
    /ADD COLUMN provisioned_by/m.test(provisioningMigration) &&
    /ADD COLUMN provisioned_at/m.test(provisioningMigration) &&
    /ADD COLUMN date_premier_login/m.test(provisioningMigration),
    "La migration provisioning doit ajouter les colonnes users utilisees par le service"
  );
  assert(
    /temp_password_hash[\s\S]*provisioned_by[\s\S]*provisioned_at/m.test(provisioning),
    "Le service provisioning doit rester couvert par une migration MySQL versionnee"
  );

  return { employeColumns: true, workflowTables: true, userProvisioningColumns: true };
}

function checkAccessOverviewGuard() {
  const accessRoute = read('backend/routes/access.js');
  const overview = accessRoute.match(/router\.get\('\/overview'[\s\S]*?router\.get\('\/users\/:id\/effective'/);
  assert(overview, 'Route /api/access/overview introuvable');
  assert(
    /if\s*\(!canOv\)\s*return\s+res\.status\(403\)/m.test(overview[0]),
    "/api/access/overview doit refuser avant de charger les utilisateurs/profils si l'utilisateur n'a pas les droits access.*"
  );
  assert(
    !/canAudit/.test(overview[0]),
    "/api/access/overview ne doit pas autoriser audit.view, car il expose les utilisateurs et permissions"
  );

  return { overviewRequiresAccessRights: true };
}

function checkPointeuseAgentModeGuards() {
  const pointeuseRoute = read('backend/routes/pointeuse.js');
  const html = read('frontend/dashboard.html');

  assert(
    /CASE WHEN pin_pointage IS NULL OR pin_pointage = '' THEN 0 ELSE 1 END AS has_pin/m.test(pointeuseRoute) &&
    /res\.json\(\{ employe, pointage: pointage \|\| null, date, has_pin: hasPin \}\)/m.test(pointeuseRoute),
    "/api/pointeuse/me doit exposer has_pin sans exposer le hash PIN"
  );
  assert(
    /if\s*\(congeActif\)\s*\{/m.test(pointeuseRoute) &&
    !/if\s*\(congeActif\s*&&\s*!canWrite\(user\)\)/m.test(pointeuseRoute),
    "Le pointage personnel doit etre refuse pendant un conge approuve pour tous les roles"
  );
  assert(
    /async function _syncHeuresSuppAuto/m.test(pointeuseRoute) &&
    /await _syncHeuresSuppAuto\(p\.employe_id, p\.date, duree/m.test(pointeuseRoute),
    "La pointeuse doit synchroniser les heures sup auto a la sortie et apres correction RH"
  );
  assert(
    /function _ptNeedsPin\(\)\s*\{[\s\S]*_ptSelfContext\?\.has_pin/m.test(html),
    "Le frontend pointeuse doit demander le PIN si le parametre global ou l'agent courant l'exige"
  );
  assert(
    /id="btn-pt-export"/m.test(html) &&
    /_ptSetVisible\('btn-pt-export', isManager\)/m.test(html),
    "L'export CSV pointeuse doit rester cache en vue agent"
  );
  assert(
    /Compteur : \$\{duree\}/m.test(html) &&
    /data-pt-live-duration/m.test(html),
    "La vue agent pointeuse doit afficher un compteur de temps vivant"
  );

  return { pinContext: true, leaveGuard: true, overtimeSync: true, agentCounter: true };
}

const result = {
  frontendModuleMapping: checkFrontendModuleMapping(),
  compose: checkComposeNoObsoleteVersion(),
  agentExitInvariant: checkAgentExitInvariant(),
  userAgentLinkInvariant: checkUserAgentLinkInvariant(),
  agentProvisioningUi: checkAgentProvisioningUiVisible(),
  salaryUpdateFalsePositiveGuard: checkSalaryUpdateFalsePositiveGuard(),
  frontendSilentBreakGuards: checkFrontendSilentBreakGuards(),
  onboardingSchemaMigration: checkOnboardingSchemaMigration(),
  accessOverviewGuard: checkAccessOverviewGuard(),
  pointeuseAgentModeGuards: checkPointeuseAgentModeGuards(),
};

console.log(JSON.stringify({ ok: true, ...result }));

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

  return { genericModal: true, canonicalToken: true };
}

function checkOnboardingSchemaMigration() {
  const migration = read('backend/migrations/021_onboarding_schema.sql');
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

  return { employeColumns: true, workflowTables: true };
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
};

console.log(JSON.stringify({ ok: true, ...result }));

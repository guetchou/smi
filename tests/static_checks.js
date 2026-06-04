// Contrôles statiques anti-dette exécutables sans dépendances externes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function walkFiles(relDir) {
  const root = path.join(__dirname, '..', relDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(abs);
      } else {
        out.push(path.relative(path.join(__dirname, '..'), abs).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

function objectKeysFromLiteral(source, declarationPattern, label) {
  const match = source.match(declarationPattern);
  assert(match, `${label} introuvable dans frontend/dashboard.html`);
  return [...match[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)].map(m => m[1]);
}

function checkFrontendModuleMapping() {
  const html = read('frontend/dashboard.html');
  const navPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(match => match[1]);
  const uniqueNavPages = [...new Set(navPages)].sort();
  const pageIds = [...html.matchAll(/\bid=(["'])page-([^"']+)\1/g)].map(match => match[2]);

  const mappedPages = objectKeysFromLiteral(html, /const PAGE_MODULES = \{([\s\S]*?)\n\};/, 'PAGE_MODULES');
  const titlePages = objectKeysFromLiteral(html, /const titles = \{([\s\S]*?)\n  \};/, 'titles showPage');
  const subtitlePages = objectKeysFromLiteral(html, /const subs = \{([\s\S]*?)\n  \};/, 'subs showPage');

  const missing = uniqueNavPages.filter(page => !mappedPages.includes(page));
  assert.deepStrictEqual(missing, [], `Pages sans mapping PAGE_MODULES: ${missing.join(', ')}`);
  const missingPageDivs = uniqueNavPages.filter(page => !pageIds.includes(page));
  assert.deepStrictEqual(missingPageDivs, [], `Pages nav sans conteneur #page-*: ${missingPageDivs.join(', ')}`);
  const missingTitles = uniqueNavPages.filter(page => !titlePages.includes(page));
  assert.deepStrictEqual(missingTitles, [], `Pages nav sans titre showPage: ${missingTitles.join(', ')}`);
  const missingSubtitles = uniqueNavPages.filter(page => !subtitlePages.includes(page));
  assert.deepStrictEqual(missingSubtitles, [], `Pages nav sans sous-titre showPage: ${missingSubtitles.join(', ')}`);

  const literalShowPages = [...html.matchAll(/showPage\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  const badShowPages = [...new Set(literalShowPages.filter(page => !pageIds.includes(page)))].sort();
  assert.deepStrictEqual(badShowPages, [], `showPage() vers pages inexistantes: ${badShowPages.join(', ')}`);

  const topbarMap = html.match(/const _TOPBAR_ACTIONS_MAP = \{([\s\S]*?)\n\};/);
  assert(topbarMap, '_TOPBAR_ACTIONS_MAP introuvable');
  const mappedTopbarZones = [...topbarMap[1].matchAll(/:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  const htmlIds = [...html.matchAll(/\bid=(["'])([^"']+)\1/g)].map(match => match[2]);
  const missingTopbarZones = [...new Set(mappedTopbarZones.filter(id => !htmlIds.includes(id)))].sort();
  assert.deepStrictEqual(missingTopbarZones, [], `Zones topbar mappees inexistantes: ${missingTopbarZones.join(', ')}`);

  return {
    navPages: uniqueNavPages.length,
    mappedPages: mappedPages.length,
    showPageTargets: [...new Set(literalShowPages)].length,
    topbarZones: [...new Set(mappedTopbarZones)].length,
  };
}

function checkComposeNoObsoleteVersion() {
  const compose = read('docker-compose.yml');
  assert(
    !/^\s*version\s*:/m.test(compose),
    'docker-compose.yml contient encore la clé obsolète version:'
  );
  assert(
    /^name:\s*caisse-topcenter\s*$/m.test(compose),
    'docker-compose.yml doit figer name: caisse-topcenter pour conserver les volumes Docker apres renommage du dossier'
  );
  return { composeVersionKey: false, stableProjectName: true };
}

function checkCanonicalProjectPath() {
  const files = [
    '.github/workflows/deploy.yml',
    'scripts/deploy.sh',
    'scripts/rollback.sh',
    'scripts/health_check.sh',
    'scripts/backup_db.sh',
    'scripts/test_backup.sh',
    'scripts/export_daily.js',
    'scripts/logview.sh',
    'scripts/import_excel.py',
    'ecosystem.config.js',
    'README.md',
  ];
  const legacy = [];
  for (const file of files) {
    const content = read(file);
    if (/\/opt\/(?:frappe_docker\/caisse-topcenter|caisse-topcenter)\b/.test(content)) legacy.push(file);
  }
  assert.deepStrictEqual(legacy, [], `Chemins projet obsoletes detectes: ${legacy.join(', ')}`);

  const workflow = read('.github/workflows/deploy.yml');
  const deploy = read('scripts/deploy.sh');
  assert(/cd \/opt\/projet-smi/.test(workflow), 'Le CI/CD doit deployer depuis /opt/projet-smi');
  assert(/PROJECT_DIR="\/opt\/projet-smi"/.test(deploy), 'scripts/deploy.sh doit utiliser /opt/projet-smi');

  return { canonicalPath: '/opt/projet-smi' };
}

function checkMysqlOperationalDocs() {
  const envExample = read('.env.example');
  const backup = read('scripts/backup_db.sh');
  const testBackup = read('scripts/test_backup.sh');
  const health = read('scripts/health_check.sh');
  const danger = read('DANGER.md');
  const exportDaily = read('scripts/export_daily.js');
  const adminSecours = read('scripts/create_admin_secours.js');

  assert(/DB_DRIVER=mysql/m.test(envExample) && /MYSQL_ROOT_PASSWORD=/m.test(envExample), '.env.example doit documenter MySQL production');
  assert(backup.includes('mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD"'), 'backup_db.sh doit sauvegarder MySQL avec mysqldump');
  assert(backup.includes('mysql_${DATE}.sql.gz'), 'backup_db.sh doit produire des backups mysql_*.sql.gz');
  assert(testBackup.includes('Format mysqldump détecté') && testBackup.includes('*.sql.gz) test_mysql_backup'), 'test_backup.sh doit valider les dumps MySQL');
  assert(health.includes('caisse-topcenter_mysql_data') && health.includes('MySQL ${DB_MB} MB'), 'health_check.sh doit surveiller le volume MySQL');
  assert(/caisse-topcenter_mysql_data/m.test(danger) && /base de données de production est MySQL/m.test(danger), 'DANGER.md doit décrire MySQL comme base production');
  assert(exportDaily.includes("require(path.join(PROJECT_DIR, 'backend', 'db'))") && !exportDaily.includes('better-sqlite3'), 'export_daily.js doit passer par backend/db.js, pas better-sqlite3');
  assert(adminSecours.includes("require(path.join(PROJECT_DIR, 'backend', 'db'))") && !adminSecours.includes('better-sqlite3'), 'create_admin_secours.js doit ecrire via backend/db.js, pas SQLite direct');

  return { mysqlEnv: true, mysqlBackup: true, mysqlHealth: true, mysqlDangerDoc: true, mysqlUtilityScripts: true };
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
  const identityAccess = read('backend/services/identity_access.js');
  const provisioning = read('backend/services/user_provisioning.js');

  assert(
    /const\s+identityAccess\s*=\s*require\('\.\.\/services\/identity_access'\)/m.test(usersRoute) &&
    /identityAccess\.createUserAccess\(req\.body,\s*req\.user\.id\)/m.test(usersRoute) &&
    /identityAccess\.updateUserAccess\(req\.params\.id,\s*req\.body,\s*req\.user\.id\)/m.test(usersRoute),
    "Les routes users doivent passer par IdentityAccessService pour creer/modifier les acces"
  );
  assert(
    !/syncUserProfilesFromRoles/.test(usersRoute) &&
    !/INSERT INTO users/.test(usersRoute) &&
    !/UPDATE users SET nom=.*role=.*employe_id/s.test(usersRoute),
    "Les routes users ne doivent plus ecrire users/profils directement"
  );
  assert(
    /EMPLOYEE_LINK_EXEMPT_ROLES\s*=\s*\['admin'\]/m.test(identityAccess) &&
    /return\s+allRoles\.some\(r\s*=>\s*!EMPLOYEE_LINK_EXEMPT_ROLES\.includes\(r\)\)/m.test(identityAccess),
    "Seul le role admin peut rester sans fiche agent; DG/RH/finance/lecteur doivent etre lies"
  );
  assert(
    /async function createUserAccess/m.test(identityAccess) &&
    /await syncUserProfilesFromRoles\(userId/m.test(identityAccess),
    "IdentityAccessService doit synchroniser les profils dans le flux de creation"
  );
  assert(
    /async function updateUserAccess/m.test(identityAccess) &&
    /await syncUserProfilesFromRoles\(id/m.test(identityAccess),
    "IdentityAccessService doit synchroniser les profils dans le flux de modification"
  );
  assert(
    /function\s+normalizeLoginIdentifier\(value\)/m.test(identityAccess) &&
    /login_identifier/m.test(identityAccess) &&
    /SELECT u\.id, u\.nom, u\.prenom, u\.email, u\.login_identifier/m.test(usersRoute),
    "La gestion utilisateurs doit exposer et persister un identifiant de connexion distinct de l'email"
  );
  assert(
    /identityAccess\.createUserAccess/m.test(provisioning) &&
    /identityAccess\.revokeEmployeeAccess/m.test(provisioning),
    "Le provisioning RH doit reutiliser IdentityAccessService pour creation et revocation"
  );

  const migration = read('backend/migrations/020_enforce_non_admin_agent_links.sql');
  assert(
    /WHERE\s+actif\s*=\s*1[\s\S]*employe_id\s+IS\s+NULL[\s\S]*role\s*<>\s*'admin'/m.test(migration),
    "La migration 020 doit neutraliser les comptes actifs non-admin sans fiche agent"
  );
  const authRoute = read('backend/routes/auth.js');
  const loginMigration = read('backend/migrations/023_user_login_identifier.sql');
  assert(
    /identifier,\s*login,\s*password/m.test(authRoute) &&
    /LOWER\(email\)\s*=\s*\? OR LOWER\(COALESCE\(login_identifier/m.test(authRoute),
    "La connexion doit accepter identifiant ou email"
  );
  assert(
    /ADD COLUMN login_identifier/m.test(loginMigration) &&
    /CREATE UNIQUE INDEX uq_users_login_identifier/m.test(loginMigration),
    "La migration 023 doit ajouter un identifiant utilisateur unique"
  );

  return { onlyAdminCanBeUnlinked: true, repairMigration: true, loginIdentifier: true };
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

function checkAgentAuditTraceabilityGuard() {
  const agentsRoute = read('backend/routes/agents.js');
  const html = read('frontend/dashboard.html');
  const permissionsSvc = read('backend/services/permissions.js');
  const usersRoute = read('backend/routes/users.js');
  assert(
    /const\s+\{\s*can\s*\}\s*=\s*require\('\.\.\/services\/permissions'\)/m.test(agentsRoute) &&
    /function\s+requireAgentPermission\(permission,\s*error\)/m.test(agentsRoute) &&
    /router\.post\('\/',\s*requireAgentPermission\('hr\.agent\.create'/m.test(agentsRoute) &&
    /router\.put\('\/:id',\s*requireAgentPermission\('hr\.agent\.update'/m.test(agentsRoute),
    "POST/PUT /agents doivent utiliser les permissions hr.agent.create/update, pas seulement les roles legacy"
  );
  assert(
    /'hr\.agent\.create':\s*\['admin',\s*'dg',\s*'rh'\]/m.test(permissionsSvc) &&
    /'hr\.agent\.update':\s*\['admin',\s*'dg',\s*'rh'\]/m.test(permissionsSvc),
    "Le fallback legacy des permissions RH doit couvrir admin/dg/rh pendant la transition RBAC"
  );
  assert(
    /function\s+canManageEmployeeRegistry\(user\)[\s\S]*hasRole\(user,\s*'admin',\s*'dg',\s*'rh'\)/m.test(usersRoute) &&
    !/router\.post\('\/employes'[\s\S]{0,220}canWrite\(req\.user\)/m.test(usersRoute) &&
    !/router\.put\('\/employes\/:id'[\s\S]{0,220}canWrite\(req\.user\)/m.test(usersRoute),
    "/config/employes ne doit plus ouvrir la creation/modification agent aux roles larges canWrite"
  );
  assert(
    /function\s+canCreateAgentFrontend\(\)[\s\S]*hr\.agent\.create/m.test(html) &&
    /class="agent-create-action[^"]*btn btn-primary/m.test(html) &&
    /document\.querySelectorAll\('\.agent-create-action'\)[\s\S]*canCreateAgentFrontend\(\)/m.test(html),
    "Le bouton Nouvel agent doit etre masque par permission hr.agent.create cote UI"
  );
  assert(
    /audit\('employes',\s*agent\.id,\s*'create'/m.test(agentsRoute),
    "POST /agents doit tracer la creation dans audit_logs"
  );
  assert(
    /const\s+beforeAgent\s*=\s*db\.prepare\('SELECT \* FROM employes WHERE id = \?'\)\.get\(req\.params\.id\)/m.test(agentsRoute) &&
    /changedAgentFields\(beforeAgent,\s*updatedAgent\)/m.test(agentsRoute) &&
    /audit\('employes',\s*empIdN,\s*'update'/m.test(agentsRoute),
    "PUT /agents/:id doit tracer les champs modifies dans audit_logs"
  );
  assert(
    /updated_at=datetime\('now'\)/m.test(agentsRoute),
    "PUT /agents/:id doit horodater la fiche agent modifiee"
  );
  assert(
    /async function savePendingAgentSubforms\(agentId\)/m.test(html) &&
    /await savePendingAgentSubforms\(agentId\)/m.test(html) &&
    /function _agentSubformDraft\(type\)/m.test(html) &&
    /_agentSubformDraft\('enfant'\)[\s\S]*\/agents\/' \+ agentId \+ '\/enfants/m.test(html) &&
    /_agentSubformDraft\('document'\)[\s\S]*\/agents\/' \+ agentId \+ '\/documents/m.test(html) &&
    /_agentSubformDraft\('diplome'\)[\s\S]*\/agents\/' \+ agentId \+ '\/diplomes/m.test(html) &&
    /_agentSubformDraft\('experience'\)[\s\S]*\/agents\/' \+ agentId \+ '\/experiences/m.test(html),
    "Enregistrer l'agent doit sauvegarder les sous-fiches RH brouillon, meme si l'onglet n'est plus visible"
  );
  assert(
    /function hasOpenAgentWorkInProgress\(\)/m.test(html) &&
    /\['enfant','document','diplome','experience','avance','conge'\]\.some\(_agentSubformDraft\)/m.test(html) &&
    /document\.querySelectorAll\('\[id\^="rmb-form-"\]'\)/m.test(html) &&
    /function closeAgentModal\(force = false\)[\s\S]*hasOpenAgentWorkInProgress\(\)[\s\S]*showToast\('Sous-formulaire ouvert/m.test(html) &&
    /closeAgentModal\(true\)/m.test(html),
    "La fermeture manuelle du modal agent doit bloquer les sous-formulaires ouverts non sauvegardes"
  );
  assert(
    /audit\('employes_enfants',[\s\S]*'create'/m.test(agentsRoute) &&
    /audit\('employes_documents',[\s\S]*'create'/m.test(agentsRoute) &&
    /audit\('employes_diplomes',[\s\S]*'create'/m.test(agentsRoute) &&
    /audit\('employes_experiences',[\s\S]*'create'/m.test(agentsRoute),
    "Les sous-fiches RH doivent etre auditees a la creation"
  );

  return { createAudit: true, updateAudit: true, updatedAt: true, pendingSubforms: true, subrecordAudit: true };
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
  assert(
    /id="form-user"[\s\S]*Identité de connexion[\s\S]*Rattachement agent[\s\S]*Rôles d'accès/m.test(html) &&
    /id="form-user-edit"[\s\S]*Identité de connexion[\s\S]*Rattachement agent[\s\S]*Rôles d'accès/m.test(html),
    "Les formulaires utilisateur doivent etre structures par sections, pas en longue colonne illisible"
  );
  assert(
    /id="u-login"/m.test(html) &&
    /id="ue-login"/m.test(html) &&
    /login_identifier:\s*document\.getElementById\('u-login'\)\.value/m.test(html) &&
    /login_identifier:\s*document\.getElementById\('ue-login'\)\.value/m.test(html),
    "Les formulaires utilisateur doivent saisir l'identifiant de connexion"
  );
  assert(
    /id="u-agent-search"/m.test(html) &&
    /id="ue-agent-search"/m.test(html) &&
    /function\s+bindUserAgentPicker\(prefix\)/m.test(html) &&
    /new URLSearchParams\(\{\s*statut:\s*'actif',\s*limit:\s*'50'\s*\}\)/m.test(html),
    "Le rattachement agent doit etre recherchable et limite, pas une liste brute illisible"
  );
  assert(
    /function\s+autofillUserFromAgent\(prefix,\s*agent/m.test(html) &&
    /setIfEmpty\(`\$\{prefix\}-nom`,\s*agent\.nom/m.test(html) &&
    /setIfEmpty\(`\$\{prefix\}-login`,\s*proposedAgentLogin\(agent\)\)/m.test(html),
    "La selection d'un agent doit pre-remplir nom, prenom, email et identifiant"
  );
  assert(
    !/id="u-nom"[^>]*placeholder=/m.test(html) &&
    !/id="u-prenom"[^>]*placeholder=/m.test(html) &&
    !/id="ue-nom"[^>]*placeholder=/m.test(html) &&
    !/id="ue-prenom"[^>]*placeholder=/m.test(html),
    "Les formulaires utilisateur ne doivent pas afficher de placeholders Jean/Dupont en production"
  );
  assert(
    /renderRolesGrid\('u-roles-grid',\s*\[\]\)/m.test(html) &&
    !/renderRolesGrid\('u-roles-grid',\s*\['lecteur'\]\)/m.test(html) &&
    !/return\s+\['lecteur'\]/m.test(html),
    "La creation utilisateur ne doit pas cocher Lecteur implicitement"
  );
  assert(
    /function\s+enforceRoleBusinessRules\(grid,\s*changedInput\)[\s\S]*changedInput\.value\s*===\s*'lecteur'[\s\S]*input\.checked\s*=\s*false/m.test(html),
    "Le role Lecteur doit rester exclusif dans les grilles de roles"
  );
  assert(
    /if\s*\(!roles\.length\)\s*\{[\s\S]*Sélectionnez au moins un rôle/m.test(html) &&
    /roles\.every\(role\s*=>\s*role\s*===\s*'admin'\)[\s\S]*fiche agent active est obligatoire/m.test(html),
    "Le formulaire utilisateur doit valider selection role et rattachement agent non-admin avant envoi"
  );

  return {
    genericModal: true,
    canonicalToken: true,
    noStaticDuplicateIds: true,
    validTopbarTargets: true,
    userAccessForm: true,
  };
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
  assert(
    /function\s+runWhenAvailable\(fnName\)[\s\S]*window\.addEventListener\('load',\s*retry,\s*\{\s*once:\s*true\s*\}\)/m.test(html) &&
    /if\s*\(name\s*===\s*'pointeuse'\)\s*runWhenAvailable\('initPointeuse'\)/m.test(html),
    "showPage('pointeuse') ne doit pas appeler initPointeuse avant que tous les scripts soient charges"
  );

  return { pinContext: true, leaveGuard: true, overtimeSync: true, agentCounter: true, deferredInit: true };
}

function checkMysqlCronCompatibility() {
  const server = read('backend/server.js');
  assert(
    /const\s+IS_MYSQL_DRIVER\s*=\s*\(process\.env\.DB_DRIVER\s*\|\|\s*'sqlite'\)\.toLowerCase\(\)\s*===\s*'mysql'/m.test(server),
    'server.js doit detecter explicitement le driver DB pour les requetes cron specifiques'
  );
  assert(
    /TIMESTAMPDIFF\(HOUR,\s*updated_at,\s*NOW\(\)\)\s*>=\s*\?/m.test(server),
    'Le cron relance achats doit utiliser TIMESTAMPDIFF en MySQL'
  );
  assert(
    /julianday\('now'\)\s*-\s*julianday\(updated_at\)/m.test(server),
    'Le cron relance achats doit conserver le fallback SQLite en developpement local'
  );
  assert(
    !/NULLS\s+LAST/i.test(server),
    'server.js ne doit pas utiliser NULLS LAST, non compatible MySQL'
  );

  return { mysqlTimestampDiff: true, sqliteFallback: true, noMysqlNullsLast: true };
}

function checkNoActiveTempArtifacts() {
  const activeDirs = ['backend', 'frontend', 'tests', 'scripts'];
  const offenders = activeDirs
    .flatMap(walkFiles)
    .filter(file => /(?:\.tmp(?:\.|$)|\.bak$|~$)/.test(file));
  assert.deepStrictEqual(offenders, [], `Fichiers temporaires actifs interdits: ${offenders.join(', ')}`);

  const audit = read('AUDIT_INDUSTRIEL_MODULES.md');
  assert(
    /Propreté dépôt actif/.test(audit) &&
    /checkNoActiveTempArtifacts/.test(audit) &&
    !/fichier temporaire ignoré existe/m.test(audit),
    "AUDIT_INDUSTRIEL_MODULES.md doit refléter l'état réel des fichiers temporaires actifs"
  );

  return { activeTempArtifacts: 0 };
}

function checkTreasuryTransferIndustrialGuard() {
  const html = read('frontend/dashboard.html');
  const operationsRoute = read('backend/routes/operations.js');

  assert(
    /id="vir-source-search"/m.test(html) &&
    /id="vir-destination-search"/m.test(html) &&
    /function\s+filterPositionSelect\(id,\s*query\)/m.test(html),
    'Le virement interne doit avoir une recherche de position source/destination'
  );
  assert(
    /id="vir-source-solde"/m.test(html) &&
    /id="vir-destination-solde"/m.test(html) &&
    /function\s+updateVirementImpact\(\)/m.test(html),
    'Le virement interne doit afficher les soldes et calculer l’impact avant enregistrement'
  );
  assert(
    /id="vir-submit"[\s\S]*disabled/m.test(html) &&
    /submit\.disabled\s*=\s*!valid/m.test(html),
    'Le bouton virement doit rester desactive tant que les controles metier ne sont pas valides'
  );
  assert(
    /fillPositions\('vir-source',\s*op\?\.position_source_id\s*\|\|\s*''\)/m.test(html) &&
    /fillPositions\('vir-destination',\s*op\?\.position_id\s*\|\|\s*''\)/m.test(html),
    'Un nouveau virement ne doit plus preselectionner source/destination'
  );
  assert(
    !/id="vir-piece"[^>]*placeholder=/m.test(html) &&
    !/id="vir-libelle"[^>]*placeholder=/m.test(html) &&
    !/id="vir-ref"[^>]*placeholder=/m.test(html),
    'Le formulaire virement ne doit pas contenir de placeholders exemple en production'
  );
  assert(
    /\/operations\/next-ref\?type=virement/m.test(html) &&
    /prefix:\s*'VIR'/m.test(operationsRoute),
    'Les virements internes doivent utiliser une reference interne VIR generee'
  );
  assert(
    /Nouveau transfert interne de trésorerie/m.test(html) &&
    /Enregistrer le transfert/m.test(html) &&
    /function\s+openTreasurySettingsFromModal\(\)/m.test(html) &&
    /Gérer les positions/m.test(html),
    'Le formulaire doit utiliser le vocabulaire metier transfert interne de tresorerie et exposer la gestion des positions'
  );
  assert(
    /async function validateInternalTransfer/m.test(operationsRoute) &&
    /getActivePosition\(position_source_id\)/m.test(operationsRoute) &&
    /getActivePosition\(position_id\)/m.test(operationsRoute) &&
    /getSoldePosition\(Number\(position_source_id\)\)/m.test(operationsRoute) &&
    /Solde insuffisant/m.test(operationsRoute),
    'Le back-end doit valider positions actives, source/destination et solde source du virement'
  );

  return { searchablePositions: true, impactPreview: true, noAutoSelection: true, backendTransferGuard: true };
}

function checkTreasuryOperationFormsIndustrialGuard() {
  const html = read('frontend/dashboard.html');
  const operationModal = html.match(/<!-- MODAL: Encaissement -->([\s\S]*?)<!-- MODAL: Employé -->/);
  assert(operationModal, 'Bloc modals opérations introuvable');
  const modals = operationModal[1];

  assert(
    /id="enc-position-search"/m.test(modals) &&
    /id="dec-position-search"/m.test(modals) &&
    /function\s+updateSimpleOperationImpact\(kind\)/m.test(html),
    'Encaissement et decaissement doivent avoir recherche position + impact'
  );
  assert(
    /id="enc-position-solde"/m.test(modals) &&
    /id="dec-position-solde"/m.test(modals) &&
    /id="enc-impact-summary"/m.test(modals) &&
    /id="dec-impact-summary"/m.test(modals),
    'Encaissement et decaissement doivent afficher solde et resume avant enregistrement'
  );
  assert(
    /id="enc-submit"[\s\S]*disabled/m.test(modals) &&
    /id="dec-submit"[\s\S]*disabled/m.test(modals) &&
    /updateSimpleOperationImpact\('enc'\)/m.test(html) &&
    /updateSimpleOperationImpact\('dec'\)/m.test(html),
    'Les boutons encaissement/decaissement doivent etre controles par validation front'
  );
  assert(
    /fillPositions\('enc-position',\s*op\?\.position_id\s*\|\|\s*''\)/m.test(html) &&
    /fillPositions\('dec-position',\s*op\?\.position_id\s*\|\|\s*''\)/m.test(html),
    'Les nouveaux encaissements/decaissements ne doivent plus preselectionner une position'
  );
  assert(
    /\/operations\/next-ref\?type=encaissement/m.test(html) &&
    /\/operations\/next-ref\?type=decaissement/m.test(html),
    'Les formulaires encaissement/decaissement doivent demander une reference typee'
  );
  assert(
    !/id="(?:enc|dec)-[^"]+"[^>]*placeholder="(?:Ex:|ex:|Optionnel|0|Client, partenaire|Nom du bénéficiaire|N° facture)/m.test(modals),
    'Les modals operations ne doivent plus contenir de placeholders exemple ou valeurs test'
  );
  assert(
    !/<svg[\s\S]*?<\/svg>/m.test(modals.match(/<!-- MODAL: Encaissement -->([\s\S]*?)<!-- MODAL: Transfert interne de trésorerie -->/)?.[1] || ''),
    'Les icones inline SVG des modals encaissement/decaissement doivent etre retirees'
  );

  return { encaissementGuard: true, decaissementGuard: true, noExamplePlaceholders: true };
}

function checkTreasuryPositionsCrudGuard() {
  const html = read('frontend/dashboard.html');

  assert(
    /Positions de trésorerie/m.test(html) &&
    /openPosCreateModal\(\)/m.test(html) &&
    /Ajouter une position/m.test(html),
    'Parametres > Tresorerie doit exposer clairement la creation de positions banque/caisse'
  );
  assert(
    /id="pos-code"[\s\S]*maxlength="20"/m.test(html) &&
    /api\('\/config\/positions',\s*\{\s*method:\s*'POST'/m.test(html) &&
    /api\(`\/config\/positions\/\$\{id\}`,\s*\{\s*method:\s*'PUT'/m.test(html),
    'Le formulaire position doit gerer creation POST avec code et edition PUT'
  );

  return { positionsCreate: true, positionsEdit: true };
}

function checkTreasurySettingsIndustrialUiGuard() {
  const html = read('frontend/dashboard.html');
  const block = html.match(/<div id="ptab-content-tresorerie"[\s\S]*?<!-- ═══ Onglet Tiers ═══ -->/);
  assert(block, 'Bloc Parametres > Tresorerie introuvable');
  const section = block[0];

  assert(
    /treasury-settings-hero/m.test(section) &&
    /treasury-settings-metrics/m.test(section) &&
    /treasury-table-head/m.test(section) &&
    /treasury-panel-header/m.test(section),
    'Parametres > Tresorerie doit utiliser le layout industriel pilote'
  );
  assert(
    /id="treasury-positions-count"/m.test(section) &&
    /id="treasury-categories-count"/m.test(section) &&
    /id="treasury-modes-count"/m.test(section),
    'Parametres > Tresorerie doit afficher les compteurs operationnels'
  );
  assert(
    !/FCFA XAF/m.test(section) &&
    !/fmt\(p\.solde_initial\)\}\s*XAF/m.test(html) &&
    !/fmt\(p\.solde\|\|0\)\}\s*XAF/m.test(html) &&
    !/<span class="text-xs text-slate-400 w-32 font-mono">\$\{m\.key\}<\/span>/m.test(html),
    'Parametres > Tresorerie ne doit pas afficher devise redondante ni cles techniques des modes'
  );
  assert(
    /description:\s*'Paiement en caisse physique'/m.test(html) &&
    /aria-label="\$\{m\.label\}"/m.test(html),
    'Modes de paiement doivent exposer des libelles metier accessibles'
  );

  return { industrialLayout: true, noTechnicalModeKeys: true, noCurrencyDuplication: true };
}

function checkFinanceFlowControlGuards() {
  const operations = read('backend/routes/operations.js');
  assert(
    /function modeRequiresExternalReference\(mode\)/m.test(operations) &&
    /\['cheque', 'virement_bancaire', 'mobile_money'\]\.includes\(normalizeMode\(mode\)\)/m.test(operations),
    'Les flux banque, cheque et mobile money doivent exiger une reference externe'
  );
  assert(
    /async function validateExternalReference/m.test(operations) &&
    /LOWER\(TRIM\(ref_externe\)\) = LOWER\(TRIM\(\?\)\)/m.test(operations) &&
    /Référence externe déjà utilisée/m.test(operations),
    'Les encaissements/decaissements doivent bloquer les doublons de reference externe'
  );
  assert(
    /const soldeDisponible = await getSoldePosition\(op\.position_id, op\.id\)/m.test(operations) &&
    /Paiement impossible : solde insuffisant/m.test(operations),
    'Le paiement d un decaissement valide doit verifier le solde disponible'
  );

  return { requiredExternalReference: true, duplicateExternalReference: true, paymentBalanceGuard: true };
}

function checkFinanceSyncStatusGuards() {
  const migration = read('backend/migrations/024_finance_sync_status.sql');
  const sqlite = read('backend/database.js');
  const operations = read('backend/routes/operations.js');
  const html = read('frontend/dashboard.html');

  ['treasury_status', 'accounting_status', 'budget_status', 'allocation_status'].forEach(column => {
    assert(migration.includes(`ADD COLUMN ${column}`), `Migration MySQL manquante pour ${column}`);
    assert(sqlite.includes(`'${column}'`) || sqlite.includes(`${column}       TEXT`), `Fallback SQLite manquant pour ${column}`);
    assert(operations.includes(column), `Route operations ne renseigne pas ${column}`);
  });
  assert(
    /CREATE TABLE IF NOT EXISTS sync_errors/m.test(migration) &&
    /CREATE TABLE IF NOT EXISTS sync_errors/m.test(sqlite),
    'La table sync_errors doit exister en MySQL et SQLite pour tracer les omissions de synchronisation'
  );
  assert(
    /function flowStatusesForOperation\(typeOp, statut\)/m.test(operations) &&
    /treasury_status:\s*statut === 'annule' \? 'cancelled' : isTreasurySynced \? 'synced' : 'pending'/m.test(operations) &&
    /treasury_status = 'synced'/m.test(operations),
    'Les operations doivent initialiser et mettre a jour les statuts de flux'
  );
  assert(
    /const syncLabels = \{ synced: 'Synchronisé', pending: 'À traiter', error: 'Erreur', cancelled: 'Annulé' \}/m.test(html) &&
    /syncBadge\(o\.treasury_status\)/m.test(html) &&
    /syncBadge\(o\.accounting_status\)/m.test(html) &&
    /syncBadge\(o\.budget_status\)/m.test(html),
    'Le journal operations doit afficher les statuts de synchronisation'
  );

  return { migration: true, sqliteFallback: true, operationStatusWrites: true, visibleJournalBadges: true };
}

function checkFinanceSyncErrorGuards() {
  const operations = read('backend/routes/operations.js');
  const html = read('frontend/dashboard.html');

  assert(
    /const FLOW_SYNC_ERROR_TYPES = \{/m.test(operations) &&
    /ACCOUNTING_SYNC_PENDING/m.test(operations) &&
    /BUDGET_SYNC_PENDING/m.test(operations) &&
    /ALLOCATION_SYNC_PENDING/m.test(operations),
    'Les flux incomplets doivent avoir des types d anomalies synchronisation explicites'
  );
  assert(
    /async function ensureSyncError/m.test(operations) &&
    /WHERE source_module = 'operations'[\s\S]*AND source_record_id = \?[\s\S]*AND error_type = \?[\s\S]*AND status = 'open'/m.test(operations),
    'La creation sync_errors doit etre dedupliquee par operation et type'
  );
  assert(
    /async function ensureOperationSyncErrors/m.test(operations) &&
    /await ensureOperationSyncErrors\(op, req\.user\.id\)/m.test(operations) &&
    /await ensureOperationSyncErrors\(paidOperation, req\.user\.id\)/m.test(operations) &&
    /await ensureOperationSyncErrors\(\{\s*\.\.\.op,[\s\S]*?\}, req\.user\.id, tx\)/m.test(operations) &&
    /await closeOperationSyncErrors\(req\.params\.id, 'ignored', req\.user\.id\)/m.test(operations),
    'Les creations, imports, paiements et annulations doivent brancher la tracabilite sync_errors'
  );
  assert(
    /router\.get\('\/sync-errors'/m.test(operations) &&
    /router\.put\('\/sync-errors\/:id\/resolve'/m.test(operations),
    'Les anomalies de synchronisation doivent etre consultables et cloturables par API'
  );
  assert(
    /id="ops-sync-errors-panel"/m.test(html) &&
    /async function loadOperationSyncErrors\(\)/m.test(html) &&
    /\/operations\/sync-errors\?status=open&limit=8/m.test(html) &&
    /async function resolveOperationSyncError\(id\)/m.test(html),
    'Le module Operations doit afficher les anomalies de synchronisation ouvertes'
  );

  return { dedupedOpenErrors: true, lifecycleHooks: true, api: true, operationsPanel: true };
}

function checkAccountingMappingFoundationGuards() {
  const migration = read('backend/migrations/025_accounting_mapping_rules.sql');
  const sqlite = read('backend/database.js');
  const server = read('backend/server.js');
  const route = read('backend/routes/accounting.js');
  const service = read('backend/services/accounting.js');

  assert(
    /CREATE TABLE IF NOT EXISTS accounting_accounts/m.test(migration) &&
    /CREATE TABLE IF NOT EXISTS accounting_mapping_rules/m.test(migration) &&
    /UNIQUE KEY uq_accounting_mapping_rule/m.test(migration),
    'La migration MySQL doit creer accounting_accounts et accounting_mapping_rules avec unicite metier'
  );
  assert(
    /CREATE TABLE IF NOT EXISTS accounting_accounts/m.test(sqlite) &&
    /CREATE TABLE IF NOT EXISTS accounting_mapping_rules/m.test(sqlite) &&
    /INSERT OR IGNORE INTO accounting_accounts/m.test(sqlite),
    'Le fallback SQLite doit creer et alimenter le socle comptable OHADA'
  );
  assert(
    /const accountingRouter\s*=\s*require\('\.\/routes\/accounting'\)/m.test(server) &&
    /app\.use\('\/api\/accounting', protectedRoute\(requireModule\('cash'\)\), accountingRouter\)/m.test(server),
    'Le serveur doit exposer /api/accounting via le module cash'
  );
  assert(
    /router\.get\('\/accounts'/m.test(route) &&
    /router\.get\('\/mapping-rules'/m.test(route) &&
    /router\.post\('\/mapping-rules'/m.test(route) &&
    /router\.get\('\/mapping-rules\/for-operation\/:id'/m.test(route),
    'Les APIs comptables de base doivent exposer comptes, regles et test de correspondance operation'
  );
  assert(
    /function canManageAccounting\(user\)/m.test(route) &&
    /hasRole\(user, 'admin', 'finance', 'dg'\)/m.test(route) &&
    /Compte débit et crédit doivent être différents/m.test(route),
    'Le parametrage comptable doit etre limite et valider les comptes debit\/credit'
  );
  assert(
    /async function findAccountingMappingForOperation/m.test(service) &&
    /r\.operation_nature IN \(\?, \?\)/m.test(service) &&
    /ORDER BY[\s\S]*CASE WHEN r\.operation_nature = \?/m.test(service),
    'Le service comptable doit faire un matching specifique puis wildcard'
  );

  return { schema: true, sqliteFallback: true, mountedApi: true, securedMappingRules: true, operationMatching: true };
}

function checkOhadaReferenceAccountsGuard() {
  const migration = read('backend/migrations/026_seed_ohada_reference_accounts.sql');
  const sqlite = read('backend/database.js');
  const docs = read('docs/ARCHITECTURE_DB.md');

  [
    '421', '422', '425', '4011', '4111', '5211', '571001',
    '6011', '6051', '6052', '6222', '6228', '6288', '6385',
    '6588', '6812', '7011',
  ].forEach(code => {
    assert(migration.includes(`('${code}'`), `Migration OHADA 026 manquante pour le compte ${code}`);
    assert(sqlite.includes(`['${code}'`), `Fallback SQLite OHADA manquant pour le compte ${code}`);
  });
  assert(
    /\/opt\/frappe_docker\/docs\/CONFIGURATION-COMPTES-OHADA\.md/m.test(migration) &&
    /\/opt\/frappe_docker\/docs\/GUIDE-COMPTES-OHADA-CONFIGURATION\.md/m.test(migration) &&
    /\/opt\/frappe_docker\/docs\/OHADA-COMPTES-LOYER-EAU-ELECTRICITE\.md/m.test(migration),
    'La migration 026 doit citer les sources Frappe locales auditees'
  );
  assert(
    /INSERT OR IGNORE INTO accounting_accounts/m.test(sqlite),
    'Le fallback SQLite doit seeder les comptes OHADA de facon idempotente'
  );
  assert(
    /La production SMI utilise MySQL/m.test(docs) &&
    /fallback SQLite uniquement pour le developpement local/m.test(docs) &&
    /ne doivent pas etre activees automatiquement sans validation comptable/m.test(docs),
    'La distinction MySQL production vs SQLite dev et la validation comptable doivent etre documentees'
  );

  return { frappeSources: true, enrichedAccounts: true, sqliteIdempotent: true, dbArchitectureDoc: true };
}

function checkOhadaDraftMappingRulesGuard() {
  const migration = read('backend/migrations/027_seed_ohada_draft_mapping_rules.sql');
  const sqlite = read('backend/database.js');
  const service = read('backend/services/accounting.js');

  [
    "'encaissement', '*', 'virement_bancaire', 'banque', 'tiers'",
    "'encaissement', '*', 'especes', 'caisse', 'tiers'",
    "'decaissement', '*', 'virement_bancaire', 'banque', 'tiers'",
    "'decaissement', '*', 'especes', 'caisse', 'tiers'",
    "'virement', '*', '*', 'caisse', '*'",
    "'virement', '*', '*', 'banque', '*'",
  ].forEach(signature => {
    assert(migration.includes(signature), `Migration 027 manquante pour mapping brouillon ${signature}`);
  });
  assert(
    /is_active\)\s*SELECT[\s\S]*'BQ', 0/m.test(migration) &&
    /'CA', 0/m.test(migration) &&
    /'VIR', 0/m.test(migration),
    'Les mappings OHADA seeds doivent etre inactifs par defaut'
  );
  assert(
    /const draftRules = \[/m.test(sqlite) &&
    /INSERT OR IGNORE INTO accounting_mapping_rules[\s\S]*VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,0\)/m.test(sqlite),
    'Le fallback SQLite doit seeder les mappings brouillon de facon inactive et idempotente'
  );
  assert(
    /WHERE r\.is_active = 1/m.test(service),
    'Le matching comptable ne doit jamais utiliser les mappings brouillon inactifs'
  );

  return { inactiveMysqlSeeds: true, inactiveSqliteSeeds: true, matchingIgnoresDrafts: true };
}

function checkAccountingEntriesLedgerGuard() {
  const migration = read('backend/migrations/028_accounting_entries_ledger.sql');
  const sqlite = read('backend/database.js');
  const route = read('backend/routes/accounting.js');
  const service = read('backend/services/accounting.js');
  const html = read('frontend/dashboard.html');

  assert(
    /CREATE TABLE IF NOT EXISTS accounting_entries/m.test(migration) &&
    /CREATE TABLE IF NOT EXISTS accounting_entry_lines/m.test(migration) &&
    /UNIQUE KEY uq_accounting_entry_source/m.test(migration) &&
    /chk_acct_line_one_side/m.test(migration),
    'La migration MySQL doit creer le journal comptable append-only et ses lignes controlees'
  );
  assert(
    /CREATE TABLE IF NOT EXISTS accounting_entries/m.test(sqlite) &&
    /CREATE TABLE IF NOT EXISTS accounting_entry_lines/m.test(sqlite) &&
    /UNIQUE\(source_module, source_record_id, status\)/m.test(sqlite),
    'Le fallback SQLite doit creer les tables journal comptable sans confusion production'
  );
  assert(
    /async function listAccountingEntryLines/m.test(service) &&
    /WITH filtered_entries AS/m.test(service) &&
    /FROM filtered_entries e[\s\S]*JOIN accounting_entry_lines l/m.test(service) &&
    /ORDER BY e\.entry_date ASC, e\.entry_no ASC, l\.id ASC/m.test(service),
    'Le service comptable doit lire les vraies lignes du journal comptable sans couper une piece en deux'
  );
  assert(
    /router\.get\('\/entries'/m.test(route) &&
    /balanced: Math\.abs\(totals\.debit - totals\.credit\) < 0\.01/m.test(route),
    'API /api/accounting/entries doit exposer le journal avec controle total debit credit'
  );
  assert(
    /api\(`\/accounting\/entries\?\$\{params\.toString\(\)\}`\)/m.test(html) &&
    !/api\(`\/operations\?debut=\$\{debut\}&fin=\$\{fin\}&limit=2000`\)/m.test(html) &&
    /Aucune écriture comptable générée sur cette période/m.test(html),
    'Le journal comptable UI ne doit plus reconstruire de pseudo-ecritures depuis les flux metier'
  );

  return { mysqlLedger: true, sqliteLedger: true, accountingEntriesApi: true, frontendUsesLedger: true };
}

function checkAccessWorkspaceIndustrialUiGuard() {
  const html = read('frontend/dashboard.html');
  const block = html.match(/<div id="ptab-content-acces"[\s\S]*?<!-- ═══ Onglet Localisation ═══ -->/);
  assert(block, 'Bloc Parametres > Acces introuvable');
  const section = block[0];

  assert(
    /access-workspace/m.test(section) &&
    /access-hero/m.test(section) &&
    /access-grid-main/m.test(section) &&
    /access-panel-header/m.test(section),
    'Parametres > Acces doit utiliser le layout industriel pilote'
  );
  assert(
    /id="access-users-count"/m.test(section) &&
    /id="access-connected-count"/m.test(section) &&
    /id="access-profiles-count"/m.test(section),
    'Parametres > Acces doit afficher les compteurs operationnels'
  );
  assert(
    /class="modal access-modal-shell fade-in"/m.test(html) &&
    /access-modal-body/m.test(html) &&
    /access-modal-footer/m.test(html) &&
    /access-role-grid-compact/m.test(html),
    'Les modals utilisateur doivent avoir hauteur controlee, corps scrollable et roles compacts'
  );
  assert(
    /\[\.\.\.new Set\(\(Array\.isArray\(u\.roles\)/m.test(html) &&
    /access-role-pill access-role-\$\{r\}/m.test(html) &&
    /function accessProfileLabel\(code\)/m.test(html),
    'La liste utilisateurs doit dedupliquer les roles et utiliser des libelles metier'
  );

  return { accessWorkspace: true, userModalControlledHeight: true, deduplicatedRoles: true };
}

function checkDashboardOperationFilterGuards() {
  const operations = read('backend/routes/operations.js');
  const dashboard = read('backend/routes/dashboard.js');
  const html = read('frontend/dashboard.html');

  assert(
    /scope,\s*\n\s*limit\s*=\s*50/m.test(operations) &&
    /scope\s*===\s*'today_or_latest'/m.test(operations) &&
    /activeScope\s*=\s*'today'/m.test(operations) &&
    /activeScope\s*=\s*'latest'/m.test(operations),
    "GET /operations doit supporter le scope today_or_latest avec fallback dernieres operations"
  );
  assert(
    /Number\.isInteger\(monthNumber\)/m.test(operations) &&
    /effectiveDebut\s*=\s*`\$\{yearNumber\}-\$\{monthStr\}-01`/m.test(operations),
    "GET /operations doit convertir mois/annee en filtre date reel"
  );
  assert(
    /const todayOpsCount = await db\.queryOne/m.test(operations) &&
    /dernieres_ops_scope:\s*recentOpsScope/m.test(operations) &&
    /COUNT\(CASE WHEN type_op != 'virement' THEN 1 END\) as nb_ops/m.test(operations),
    "Le resume KPI doit prioriser les operations du jour puis exposer le scope et nb_ops"
  );
  assert(
    /params\.set\('scope', 'today_or_latest'\)/m.test(html) &&
    /_opsUseDefaultScope\s*&&[\s\S]*params\.set\('scope', 'today_or_latest'\)/m.test(html) &&
    /_opsUseDefaultScope\s*=\s*false/m.test(html) &&
    /Opérations d'aujourd'hui/m.test(html) &&
    /Dernières opérations disponibles/m.test(html),
    "Le frontend operations/dashboard doit demander le fallback jour puis dernieres operations uniquement au chargement par defaut"
  );
  assert(
    /data\.totaux\?\.total_enc/m.test(html) &&
    /data\.totaux\?\.total_dec/m.test(html) &&
    /ops-scope-note/m.test(html) &&
    /ops-filter-grid/m.test(html) &&
    /ops-kpi-grid/m.test(html) &&
    /ops-table-scroll/m.test(html) &&
    /ops-flt-btn\.is-active/m.test(html) &&
    /classList\.add\('is-active'\)/m.test(html) &&
    /Totaux calculés sur/m.test(html),
    "La vue operations doit afficher les totaux filtres serveur, expliquer le scope et utiliser des styles responsives explicites"
  );
  assert(
    /_sidebarApply\(window\.innerWidth <= 768 \? 'hidden' : _sidebarState\);/m.test(html) &&
    /if \(window\.innerWidth <= 768\) closeSidebar\(\);/m.test(html) &&
    /#notif-bell-btn,\s*\n\s*#theme-toggle,\s*\n\s*#user-dropdown-wrap/m.test(html) &&
    /function esc\(s\) \{ return _esc\(s\); \}/m.test(html),
    "La navigation mobile doit demarrer sidebar fermee, fermer apres navigation et disposer de l'echappement HTML esc"
  );
  assert(
    /\/operations\?debut=\$\{debutMois\}&fin=\$\{finMois\}&limit=1000/m.test(html) &&
    !/\/operations\?mois=\$\{moisCourant\}&annee=\$\{anneeCourante\}&limit=1000/m.test(html),
    "Les charts etendus doivent utiliser des bornes de date explicites, pas un filtre mois ignore"
  );
  assert(
    /COALESCE\(o\.dec_statut,'brouillon'\) = 'soumis'/m.test(dashboard) &&
    /\/operations\/decaissements\/pending\?scope=actionable/m.test(html) &&
    /const statuses = \[\];[\s\S]*statuses\.push\('soumis'\)/m.test(operations) &&
    /ownerOnly\s*=\s*true/m.test(operations) &&
    /AND o\.created_by = \?/m.test(operations),
    "La file DG doit afficher les demandes soumises actionnables, sans brouillons melanges"
  );

  return { todayFallback: true, monthDateFilter: true, dgSubmittedApprovalsOnly: true, ownDraftsOnly: true };
}

const result = {
  frontendModuleMapping: checkFrontendModuleMapping(),
  compose: checkComposeNoObsoleteVersion(),
  canonicalProjectPath: checkCanonicalProjectPath(),
  mysqlOperationalDocs: checkMysqlOperationalDocs(),
  agentExitInvariant: checkAgentExitInvariant(),
  userAgentLinkInvariant: checkUserAgentLinkInvariant(),
  agentProvisioningUi: checkAgentProvisioningUiVisible(),
  salaryUpdateFalsePositiveGuard: checkSalaryUpdateFalsePositiveGuard(),
  agentAuditTraceabilityGuard: checkAgentAuditTraceabilityGuard(),
  frontendSilentBreakGuards: checkFrontendSilentBreakGuards(),
  onboardingSchemaMigration: checkOnboardingSchemaMigration(),
  accessOverviewGuard: checkAccessOverviewGuard(),
  pointeuseAgentModeGuards: checkPointeuseAgentModeGuards(),
  mysqlCronCompatibility: checkMysqlCronCompatibility(),
  activeTempArtifacts: checkNoActiveTempArtifacts(),
  treasuryTransferIndustrialGuard: checkTreasuryTransferIndustrialGuard(),
  treasuryOperationFormsIndustrialGuard: checkTreasuryOperationFormsIndustrialGuard(),
  treasuryPositionsCrudGuard: checkTreasuryPositionsCrudGuard(),
  treasurySettingsIndustrialUiGuard: checkTreasurySettingsIndustrialUiGuard(),
  financeFlowControlGuards: checkFinanceFlowControlGuards(),
  financeSyncStatusGuards: checkFinanceSyncStatusGuards(),
  financeSyncErrorGuards: checkFinanceSyncErrorGuards(),
  accountingMappingFoundationGuards: checkAccountingMappingFoundationGuards(),
  ohadaReferenceAccountsGuard: checkOhadaReferenceAccountsGuard(),
  ohadaDraftMappingRulesGuard: checkOhadaDraftMappingRulesGuard(),
  accountingEntriesLedgerGuard: checkAccountingEntriesLedgerGuard(),
  accessWorkspaceIndustrialUiGuard: checkAccessWorkspaceIndustrialUiGuard(),
  dashboardOperationFilterGuards: checkDashboardOperationFilterGuards(),
};

console.log(JSON.stringify({ ok: true, ...result }));

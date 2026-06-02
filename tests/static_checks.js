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
    /enfant-form[\s\S]*document-form[\s\S]*diplome-form[\s\S]*experience-form[\s\S]*avance-form[\s\S]*conge-form/m.test(html),
    "Enregistrer l'agent doit sauvegarder les sous-formulaires RH ouverts avant fermeture du modal"
  );
  assert(
    /function hasOpenAgentWorkInProgress\(\)/m.test(html) &&
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
    /id="form-user"[\s\S]*Identité de connexion[\s\S]*Rôles d'accès[\s\S]*Rattachement agent/m.test(html) &&
    /id="form-user-edit"[\s\S]*Identité de connexion[\s\S]*Rôles d'accès[\s\S]*Rattachement agent/m.test(html),
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

  return { mysqlTimestampDiff: true, sqliteFallback: true };
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
};

console.log(JSON.stringify({ ok: true, ...result }));

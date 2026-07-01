// Contrôles statiques anti-dette exécutables sans dépendances externes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  const navigation = read('frontend/js/core/navigation.js');
  const navSource = `${html}\n${navigation}`;
  const navPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(match => match[1]);
  const uniqueNavPages = [...new Set(navPages)].sort();
  const pageIds = [...html.matchAll(/\bid=(["'])page-([^"']+)\1/g)].map(match => match[2]);

  const mappedPages = objectKeysFromLiteral(navSource, /const PAGE_MODULES = \{([\s\S]*?)\n  \};/, 'PAGE_MODULES');
  const routedPages = objectKeysFromLiteral(navSource, /const PAGE_ROUTES = \{([\s\S]*?)\n  \};/, 'PAGE_ROUTES');
  const titlePages = objectKeysFromLiteral(html, /const titles = \{([\s\S]*?)\n  \};/, 'titles showPage');
  const subtitlePages = objectKeysFromLiteral(html, /const subs = \{([\s\S]*?)\n  \};/, 'subs showPage');

  const missing = uniqueNavPages.filter(page => !mappedPages.includes(page));
  assert.deepStrictEqual(missing, [], `Pages sans mapping PAGE_MODULES: ${missing.join(', ')}`);
  const missingRoutes = uniqueNavPages.filter(page => !routedPages.includes(page));
  assert.deepStrictEqual(missingRoutes, [], `Pages sans URL canonique PAGE_ROUTES: ${missingRoutes.join(', ')}`);
  const missingPageDivs = uniqueNavPages.filter(page => !pageIds.includes(page));
  assert.deepStrictEqual(missingPageDivs, [], `Pages nav sans conteneur #page-*: ${missingPageDivs.join(', ')}`);
  const missingTitles = uniqueNavPages.filter(page => !titlePages.includes(page));
  assert.deepStrictEqual(missingTitles, [], `Pages nav sans titre showPage: ${missingTitles.join(', ')}`);
  const missingSubtitles = uniqueNavPages.filter(page => !subtitlePages.includes(page));
  assert.deepStrictEqual(missingSubtitles, [], `Pages nav sans sous-titre showPage: ${missingSubtitles.join(', ')}`);

  const literalShowPages = [...html.matchAll(/showPage\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  const badShowPages = [...new Set(literalShowPages.filter(page => !pageIds.includes(page)))].sort();
  assert.deepStrictEqual(badShowPages, [], `showPage() vers pages inexistantes: ${badShowPages.join(', ')}`);

  const topbarMap = navSource.match(/const TOPBAR_ACTIONS_MAP = \{([\s\S]*?)\n  \};/);
  assert(topbarMap, '_TOPBAR_ACTIONS_MAP introuvable');
  const mappedTopbarZones = [...topbarMap[1].matchAll(/:\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  const htmlIds = [...html.matchAll(/\bid=(["'])([^"']+)\1/g)].map(match => match[2]);
  const missingTopbarZones = [...new Set(mappedTopbarZones.filter(id => !htmlIds.includes(id)))].sort();
  assert.deepStrictEqual(missingTopbarZones, [], `Zones topbar mappees inexistantes: ${missingTopbarZones.join(', ')}`);

  return {
    navPages: uniqueNavPages.length,
    mappedPages: mappedPages.length,
    routedPages: routedPages.length,
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
  assert(
    /git checkout -B main origin\/main/m.test(workflow) &&
    /git checkout -B "\$BRANCH" "origin\/\$BRANCH"/m.test(deploy) &&
    !/git reset --hard/m.test(workflow) &&
    !/git reset --hard/m.test(deploy),
    'Le déploiement doit normaliser la branche main sans git reset --hard'
  );
  assert(
    /BACKUP_PATH="\$MYSQL_BACKUP"/m.test(deploy) &&
    /echo "  Backup : \$BACKUP_PATH"/m.test(deploy),
    'Le rapport de déploiement doit afficher le backup réellement produit'
  );
  assert(
    /uses:\s*actions\/setup-node@v4/m.test(workflow) &&
    /node-version:\s*'20'/m.test(workflow) &&
    /npm ci --prefix backend/m.test(workflow) &&
    /cache-dependency-path:\s*backend\/package-lock\.json/m.test(workflow),
    'Le CI doit installer les dépendances backend verrouillées avant les tests SQLite'
  );

  return {
    canonicalPath: '/opt/projet-smi',
    canonicalDeployBranch: 'main',
    accurateBackupReport: true,
    backendDependenciesInstalledInCi: true,
  };
}

function checkCanonicalFrontendRouting() {
  const html = read('frontend/dashboard.html');
  const navigation = read('frontend/js/core/navigation.js');
  const navSource = `${html}\n${navigation}`;
  const login = read('frontend/index.html');
  const server = read('backend/server.js');
  const serviceWorker = read('frontend/sw.js');
  const manifest = JSON.parse(read('frontend/manifest.json'));
  const notifications = read('backend/services/notif.js');
  const parapheur = read('backend/routes/parapheur.js');
  const operations = read('backend/routes/operations.js');

  const routesBlock = navSource.match(/const PAGE_ROUTES = \{([\s\S]*?)\n  \};/);
  assert(routesBlock, 'PAGE_ROUTES introuvable dans le module de navigation frontend');
  const routes = [...routesBlock[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)];
  const routeValues = routes.map(match => match[2]);
  assert.strictEqual(
    new Set(routeValues).size,
    routeValues.length,
    'Chaque page doit avoir une URL canonique unique'
  );
  routeValues.forEach(route => {
    assert(route.startsWith('/app/'), `URL de vue non canonique: ${route}`);
  });

  assert(
    /app\.get\(\['\/app', '\/app\/\*'\]/m.test(server) &&
    /frontend', 'dashboard\.html'/m.test(server),
    'Express doit servir dashboard.html pour toutes les routes /app/*'
  );
  assert(
    /<script src="\/js\/core\/navigation\.js"><\/script>/m.test(html) &&
    /window\.TalaNavigation\s*=\s*\{/m.test(navigation) &&
    /function pageFromLocation\(\)/m.test(navSource) &&
    /function updatePageRoute\(page, historyMode = 'push'\)/m.test(navSource) &&
    /window\.history\[method\]\(\{ page \}, '', target\)/m.test(navSource) &&
    /window\.addEventListener\('popstate'/m.test(html) &&
    /showPage\(requestedPage, \{ historyMode: 'none' \}\)/m.test(html) &&
    /syncNavigationHrefs\(\)/m.test(html) &&
    !/history\.replaceState\(null, '', hash\)/m.test(html),
    'Le routeur frontend doit gérer URL canonique, liens, historique et retour navigateur'
  );
  assert(
    /const SETTINGS_TAB_ROUTES = \{[\s\S]*entreprise:\s*'\/app\/parametres\/entreprise'[\s\S]*acces:\s*'\/app\/parametres\/acces-utilisateurs'[\s\S]*notifications:\s*'\/app\/parametres\/notifications'/m.test(navigation) &&
    /if \(settingsRouteTabs\.has\(path\)\) return 'parametres'/m.test(navigation) &&
    /function settingsTabFromLocation\(\)/m.test(navigation) &&
    /function updateSettingsTabRoute\(tab, historyMode = 'push'\)/m.test(navigation) &&
    /showParamTab\(settingsTabFromLocation\(\), \{ historyMode: historyMode === 'none' \? 'none' : 'replace' \}\)/m.test(html) &&
    /requestedPage === 'parametres' && _activePage === 'parametres'/m.test(html),
    'Chaque sous-vue Parametres doit avoir une URL stable, rechargeable et compatible avec retour navigateur'
  );
  assert(
    (login.match(/\/app\/tableau-de-bord/g) || []).length >= 2 &&
    manifest.start_url === '/app/tableau-de-bord',
    'Connexion et PWA doivent démarrer sur /app/tableau-de-bord'
  );
  assert(
    /url\.pathname === '\/app' \|\| url\.pathname\.startsWith\('\/app\/'\)/m.test(serviceWorker),
    'Le service worker ne doit pas mettre en cache les routes HTML /app/*'
  );
  assert(
    /\/app\/tableau-de-bord/m.test(notifications) &&
    /\/app\/direction\/parapheur/m.test(parapheur) &&
    /\/app\/finance\/operations/m.test(operations),
    'Les notifications externes doivent ouvrir la vue metier correspondante'
  );

  return { uniqueRoutes: routeValues.length, historyNavigation: true, directReload: true, externalLinks: true };
}

function checkUsersUpdatedAtMigration() {
  const migration = read('backend/migrations/030_users_updated_at_backfill.sql');
  const identityAccess = read('backend/services/identity_access.js');

  assert(
    /ALTER TABLE users[\s\S]*ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/m.test(migration),
    'La migration utilisateurs doit ajouter updated_at requis par IdentityAccessService'
  );
  assert(
    /UPDATE users[\s\S]*updated_at = \?/m.test(identityAccess),
    'La modification utilisateur doit conserver la tracabilite updated_at'
  );

  return { usersUpdatedAtBackfilled: true, identityUpdateTraceable: true };
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
    /async function auditPermission\([\s\S]*executor\s*=\s*db[\s\S]*await executor\.execute/m.test(read('backend/services/permissions.js')) &&
    (identityAccess.match(/await auditPermission\(\{[\s\S]*?\}, tx\);/g) || []).length >= 3,
    "Les audits identite doivent utiliser la meme transaction pour eviter les lock waits MySQL"
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
  const html = read('frontend/dashboard.html');
  const agentModule = read('frontend/js/modules/agents.js');
  assert(
    /const\s+hasSalaryChange\s*=\s*salaryFields\.some\(f\s*=>[\s\S]*numberOrZero\(req\.body\[f\]\)\s*!==\s*numberOrZero\(agent\[f\]\)/m.test(agentsRoute),
    "PUT /agents/:id ne doit pas traiter la presence des champs salaire comme une modification sans comparer les valeurs"
  );
  assert(
    /salaire_base\s*===\s*undefined\s*\?\s*numberOrZero\(agent\.salaire_base\)/m.test(agentsRoute),
    "PUT /agents/:id doit conserver le salaire existant si le champ n'est pas envoye"
  );
  assert(
    /salaryChanged\(form\.salary\)[\s\S]*requestSalaryRevision\(\)/m.test(agentModule) &&
    /payload\.motif\s*=\s*motif/m.test(agentModule) &&
    /payload\.type_revision\s*=\s*'correction'/m.test(agentModule) &&
    /requestSalaryRevision:\s*\(\)\s*=>\s*showPrompt\(/m.test(html),
    "Le bouton Enregistrer l'agent doit demander un motif et transmettre type_revision si la remuneration change"
  );
  assert(
    /code:\s*'SALARY_MOTIF_REQUIRED'/m.test(agentsRoute) &&
    /auditSalaryRevision\(empIdN,\s*agent,\s*salaryRevision\.values,\s*req\.user\.id\)/m.test(agentsRoute) &&
    !/return\s+handleSalaireUpdate\(req,\s*res,\s*agent\)/m.test(agentsRoute),
    "PUT /agents/:id doit sauvegarder la fiche complete avec trace salaire, pas abandonner vers la route salaire seule"
  );

  return { comparesValues: true, preservesExistingSalary: true, salaryMotifPrompt: true, combinedTrace: true };
}

function checkAgentPayloadBuilders() {
  const source = read('frontend/js/modules/agents.js');
  const html = read('frontend/dashboard.html');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'frontend/js/modules/agents.js' });

  const elements = new Map();
  const document = {
    getElementById(id) { return elements.get(id); },
    querySelectorAll() { return []; },
  };
  const setField = (id, value = '', checked = false) => {
    elements.set(id, { value, checked });
  };
  const dossier = context.window.TalaAgentDossier.create({ document });

  setField('ag-nom', '');
  setField('ag-prenom', 'Caley');
  let form = dossier.buildAgentPayload();
  assert.strictEqual(form.ok, false, 'Une fiche agent sans nom doit etre refusee');

  setField('ag-nom', '  BAYI  ');
  setField('ag-prenom', ' Caley ');
  setField('ag-salaire-base', '125000');
  setField('ag-prime-transport', '15000.50');
  setField('ag-prime-logement', '');
  form = dossier.buildAgentPayload();
  assert.strictEqual(form.ok, true, 'Une fiche agent minimale valide doit produire un payload');
  assert.strictEqual(form.payload.nom, 'BAYI');
  assert.strictEqual(form.payload.prenom, 'Caley');
  assert.strictEqual(form.payload.salaire_base, 125000);
  assert.strictEqual(form.payload.prime_transport, 15000.5);
  assert.strictEqual(form.payload.prime_logement, 0);

  dossier.setInitialSalarySnapshot(form.salary);
  assert.strictEqual(dossier.salaryChanged(dossier.readSalaryForm()), false);
  setField('ag-prime-logement', '10000');
  assert.strictEqual(dossier.salaryChanged(dossier.readSalaryForm()), true);

  setField('enf-prenom', '  Alix ');
  setField('enf-nom', 'Bayi');
  setField('enf-charge', '', true);
  setField('enf-sco', '', false);
  form = dossier.buildSubformPayload('enfant');
  assert.strictEqual(form.ok, true);
  assert.strictEqual(form.payload.prenom, 'Alix');
  assert.strictEqual(form.payload.est_charge, 1);

  setField('dip-intitule', '   ');
  form = dossier.buildSubformPayload('diplome');
  assert.strictEqual(form.ok, false, 'Un brouillon diplome sans intitule doit etre refuse');

  setField('av-date', '2026-06-13');
  setField('av-montant', '-1');
  form = dossier.buildSubformPayload('avance');
  assert.strictEqual(form.ok, false, 'Une avance negative doit etre refusee');
  setField('av-montant', '50000');
  setField('av-echeances', '0');
  form = dossier.buildSubformPayload('avance');
  assert.strictEqual(form.ok, true);
  assert.strictEqual(form.payload.nb_echeances, 1, 'Zero echeance doit conserver le fallback historique a une echeance');

  setField('cg-type', 'annuel');
  setField('cg-debut', '2026-06-15');
  setField('cg-fin', '2026-06-13');
  form = dossier.buildSubformPayload('conge');
  assert.strictEqual(form.ok, false, 'Une periode de conge inversee doit etre refusee');
  setField('cg-fin', '2026-06-17');
  form = dossier.buildSubformPayload('conge', { forceCreation: true });
  assert.strictEqual(form.ok, true);
  assert.strictEqual(form.days, 3);
  assert.strictEqual(form.payload.force_creation, true);

  assert(
    /async function persistAgentSubform\(type, agentId\)[\s\S]*saveSubform\(type, agentId\)/m.test(html) &&
    /async function saveEnfant\(\)[\s\S]*persistAgentSubform\('enfant', agentId\)/m.test(html) &&
    /async function saveDocument\(\)[\s\S]*persistAgentSubform\('document', agentId\)/m.test(html) &&
    /async function saveDiplome\(\)[\s\S]*persistAgentSubform\('diplome', agentId\)/m.test(html) &&
    /async function saveExperience\(\)[\s\S]*persistAgentSubform\('experience', agentId\)/m.test(html) &&
    /async function saveAvance\(\)[\s\S]*persistAgentSubform\('avance', agentId\)/m.test(html) &&
    /async function saveConge\(\)[\s\S]*persistAgentSubform\('conge', agentId\)/m.test(html),
    'Tous les flux de sous-fiches Agent doivent utiliser le constructeur central'
  );
  assert(
    !/api\('\/agents\/' \+ agentId \+ '\/(?:enfants|documents|diplomes|experiences|avances|conges)', \{ method:\s*'POST'/m.test(html),
    'Le shell ne doit pas reconstruire les requetes POST des sous-fiches Agent'
  );

  return { mainAgent: true, salarySnapshot: true, subforms: true, shellDelegation: true };
}

function checkPaidPayrollCorrectionUiGuard() {
  const html = read('frontend/dashboard.html');
  const rectificationsModule = read('frontend/js/modules/payroll-rectifications.js');
  const salairesRoute = read('backend/routes/salaires.js');
  assert(
    /<script src="\/js\/modules\/payroll-rectifications\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollRectifications = \{ create \};/m.test(rectificationsModule),
    "La Paie doit exposer une action de rectification contrôlée pour les bulletins payés"
  );
  assert(!/window\.prompt/.test(rectificationsModule),
    "La rectification d'un bulletin payé doit utiliser un vrai formulaire, pas window.prompt"
  );
  assert(
    /\/salaires\/bulletin\/\$\{currentBulletinId\}\/rectification/m.test(rectificationsModule),
    "La rectification UI doit appeler l'endpoint backend existant /salaires/bulletin/:id/rectification"
  );
  assert(
    /window\.TalaPayrollRectifications\.create\(\{[\s\S]*?getRows: \(\) => salairesRows,[\s\S]*?request: api,[\s\S]*?reload: loadSalaires/m.test(html) &&
    /function ouvrirRectificationBulletin\(bulletinId\) \{[\s\S]*?getPayrollRectifications\(\)\.open\(bulletinId\)/m.test(html),
    "Le shell doit monter le module Paie via une interface courte et garder uniquement les adapters HTML"
  );
  assert(
    !/function rectificationBulletinRow\(/m.test(html) &&
    !/let rectificationBulletinId = null;/m.test(html),
    "L'implémentation de rectification ne doit plus rester dupliquée dans dashboard.html"
  );
  assert(
    /id="modal-rectification-bulletin"/m.test(html) &&
    /id="rectif-type"/m.test(html) &&
    /id="rectif-sens"/m.test(html) &&
    /id="rectif-montant"/m.test(html) &&
    /id="rectif-motif"/m.test(html),
    "La rectification doit exposer une modale formulaire complete"
  );
  assert(
    /id="modal-rectification-bulletin"[\s\S]*class="modal w-full max-w-md max-h-\[88vh\]/m.test(html) &&
    /class="rectif-summary/m.test(html) &&
    /class="number-input rectif-amount-input" style="width: 180px; max-width: 100%;"/m.test(html) &&
    !/id="modal-rectification-bulletin"[\s\S]{0,1800}sm:grid-cols-3/m.test(html),
    "Le formulaire de rectification doit rester compact et ne pas reprendre toute la largeur"
  );
  assert(
    /Bulletin payé — action de masse verrouillée/m.test(html) &&
    /canRectifyPaidPayroll\(\) \? `<button onclick="ouvrirRectificationBulletin\(\$\{b\.id\}\)/m.test(html),
    "Une ligne payée doit rester verrouillée mais afficher une action Corriger explicite"
  );
  assert(
    /function canRectifyPaidPayroll\(\) \{ return hasRole\('finance', 'dg', 'rh'\); \}/m.test(html) &&
    /hasRole\(req\.user, 'admin', 'finance', 'dg', 'rh'\)/m.test(salairesRoute),
    "Les droits rectification doivent être alignés UI/backend: admin, dg, finance, rh"
  );
  assert(
    /Seul un bulletin payé peut faire l\\'objet d\\'une rectification/m.test(salairesRoute) &&
    /Le bulletin payé restera verrouillé/m.test(html),
    "La correction doit conserver le bulletin paye verrouille"
  );
  return { paidCorrectionButton: true, paidLockExplained: true, realForm: true, rightsAligned: true };
}

function checkPayrollCycleModuleGuard() {
  const html = read('frontend/dashboard.html');
  const cycleModule = read('frontend/js/modules/payroll-cycle.js');
  assert(
    /<script src="\/js\/modules\/payroll-cycle\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollCycle = \{ create \};/m.test(cycleModule),
    'Le cycle Paie doit être chargé comme module frontend dédié'
  );
  assert(
    /window\.TalaPayrollCycle\.create\(\{[\s\S]*?request: api,[\s\S]*?canPayPeriod: salaryPeriodCanPay,[\s\S]*?renderPeriodGate: renderSalaryPeriodGate/m.test(html),
    'Le shell doit monter le cycle Paie avec ses adapters explicites'
  );
  assert(
    /\/salaires\/bulletins\/valider-selection/m.test(cycleModule) &&
    /\/salaires\/bulletins\/payer-selection/m.test(cycleModule) &&
    /\/salaires\/generer/m.test(cycleModule) &&
    /\/salaires\/bulletin\/\$\{bulletinId\}\/payer/m.test(cycleModule),
    'Le module cycle Paie doit concentrer génération, validation et paiement'
  );
  assert(
    !/let salairesSelection = new Set\(\)/m.test(html) &&
    !/salairesSelection\.clear\(\)/m.test(html) &&
    !/salairesSelection\.add\(/m.test(html),
    'L’état de sélection Paie ne doit plus fuir dans dashboard.html'
  );
  assert(
    /row\.bulletin\.statut === 'paye'[\s\S]*?return false/m.test(cycleModule) &&
    /if \(!await requirePayablePeriod\(\)\) return false/m.test(cycleModule),
    'Le module doit verrouiller les bulletins payés et le paiement avant validation DG'
  );
  return { dedicatedModule: true, explicitAdapters: true, workflowLocality: true, paidLock: true, dgGate: true };
}

function checkPayrollDocumentsModuleGuard() {
  const html = read('frontend/dashboard.html');
  const documentsModule = read('frontend/js/modules/payroll-documents.js');
  assert(
    /<script src="\/js\/modules\/payroll-documents\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollDocuments = \{ create \};/m.test(documentsModule),
    'Les documents Paie doivent être chargés comme module frontend dédié'
  );
  assert(
    /window\.TalaPayrollDocuments\.create\(\{[\s\S]*?request: api,[\s\S]*?fetchImpl: fetch,[\s\S]*?getToken:[\s\S]*?reload: loadSalaires/m.test(html),
    'Le shell doit monter les documents Paie avec des adapters explicites'
  );
  assert(
    /\/salaires\/envoyer-groupe/m.test(documentsModule) &&
    /\/salaires\/bulletin\/\$\{bulletinId\}\/email/m.test(documentsModule) &&
    /\/salaires\/bulletin\/\$\{bulletinId\}\/pdf/m.test(documentsModule) &&
    /\/salaires\/export-csv/m.test(documentsModule),
    'Le module documents Paie doit concentrer envoi groupé, email, PDF et CSV'
  );
  assert(
    /function envoyerBulletinsGroupe\(opts = \{\}\) \{[\s\S]*?getPayrollDocuments\(\)\.sendGroup\(opts\)/m.test(html) &&
    /function exportSalairesCSV\(\) \{[\s\S]*?getPayrollDocuments\(\)\.exportCsv\(\)/m.test(html) &&
    /function envoyerBulletinEmail\(bulletinId, emailActuel, nomEmploye\) \{[\s\S]*?getPayrollDocuments\(\)\.sendEmail/m.test(html),
    'Le shell doit conserver uniquement les adapters de compatibilité des actions documentaires'
  );
  assert(
    !/api\('\/salaires\/envoyer-groupe'/m.test(html) &&
    !/fetch\(API \+ `\/salaires\/bulletin\/\$\{bulletinId\}\/pdf`/m.test(html) &&
    !/\/api\/salaires\/export-csv\?mois=/m.test(html),
    'Les appels documentaires Paie ne doivent plus être dupliqués dans dashboard.html'
  );
  return { dedicatedModule: true, explicitAdapters: true, endpointLocality: true, compatibilityAdapters: true };
}

function checkPayrollPeriodsModuleGuard() {
  const html = read('frontend/dashboard.html');
  const periodsModule = read('frontend/js/modules/payroll-periods.js');
  const periodsRoute = read('backend/routes/periodes_paie.js');
  assert(
    /<script src="\/js\/modules\/payroll-periods\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollPeriods = \{ create, MONTH_NAMES, STATUS_LABELS, STATUS_COLORS \};/m.test(periodsModule),
    'Les périodes de paie doivent être chargées comme module frontend dédié'
  );
  assert(
    /window\.TalaPayrollPeriods\.create\(\{[\s\S]*?request: api,[\s\S]*?hasAnyRole: hasExactRole,[\s\S]*?refreshDgBanner:[\s\S]*?formatMoney: fmtXAF/m.test(html),
    'Le shell doit monter les périodes avec des adapters explicites'
  );
  assert(
    /\/paie\/periodes\/\$\{id\}\/\$\{actionName\}/m.test(periodsModule) &&
    /bloquant[\s\S]*?disabled/m.test(periodsModule) &&
    /rouvrir-exception/m.test(periodsModule),
    'Le module Périodes doit concentrer transitions, anomalies bloquantes et réouverture'
  );
  assert(
    /function loadPeriodes\(\) \{[\s\S]*?getPayrollPeriods\(\)\.load\(\)/m.test(html) &&
    /function periodeAction\(id, action, body = \{\}\) \{[\s\S]*?getPayrollPeriods\(\)\.action\(id, action, body\)/m.test(html) &&
    /function loadDgPeriodeBanner\(\) \{[\s\S]*?getPayrollPeriods\(\)\.loadDgBanner\(\)/m.test(html),
    'Le shell doit conserver les adapters historiques appelés par le HTML'
  );
  assert(
    !/let _periodesData = \[\];/m.test(html) &&
    !/api\('\/paie\/periodes'/m.test(html) &&
    !/api\(`\/paie\/periodes\/\$\{id\}\/\$\{action\}`/m.test(html),
    'L’état et les appels Périodes ne doivent plus être dupliqués dans dashboard.html'
  );
  assert(
    /if \(!\(await canSubmitPayrollPeriod\(req\.user\)\)\)/m.test(periodsRoute) &&
    /if \(!\(await canApprovePayrollPeriod\(req\.user\)\)\)/m.test(periodsRoute) &&
    /if \(!hasRole\(req\.user, 'admin'\)\)/m.test(periodsRoute),
    'Les contrôles backend Finance, DG et Admin doivent rester actifs'
  );
  return {
    dedicatedModule: true,
    explicitAdapters: true,
    workflowLocality: true,
    blockingAnomalies: true,
    backendRights: true,
  };
}

function checkPayrollGridsModuleGuard() {
  const html = read('frontend/dashboard.html');
  const gridsModule = read('frontend/js/modules/payroll-grids.js');
  const gridsRoute = read('backend/routes/grilles.js');
  assert(
    /<script src="\/js\/modules\/payroll-grids\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollGrids = \{ create, STATUS_LABELS, STATUS_COLORS \};/m.test(gridsModule),
    'Les grilles salariales doivent être chargées comme module frontend dédié'
  );
  assert(
    /window\.TalaPayrollGrids\.create\(\{[\s\S]*?request: api,[\s\S]*?notify: showToast,[\s\S]*?hasAnyRole: hasExactRole,[\s\S]*?reloadAgentGrid/m.test(html),
    'Le shell doit monter les grilles avec des adapters explicites'
  );
  assert(
    /\/grilles\/\$\{id\}\/\$\{actionName\}/m.test(gridsModule) &&
    /\/grilles\/categories\/\$\{categoryId\}\/echelons/m.test(gridsModule) &&
    /\/grilles\/agent\/\$\{agentId\}\/affecter/m.test(gridsModule) &&
    /\/grilles\?statut=valide/m.test(gridsModule),
    'Le module Grilles doit concentrer workflow, catégories, échelons et affectation agent'
  );
  assert(
    /function loadGrilles\(\) \{ return getPayrollGrids\(\)\.load\(\); \}/m.test(html) &&
    /function saveAffectationGrille\(\) \{ return getPayrollGrids\(\)\.saveAssignment\(\); \}/m.test(html) &&
    /function loadAgentGrilleInfo\(agentId\) \{ return getPayrollGrids\(\)\.loadAgentGridInfo\(agentId\); \}/m.test(html),
    'Le shell doit conserver uniquement les adapters historiques Grilles'
  );
  assert(
    !/let _grillesData = \[\];/m.test(html) &&
    !/let _agentGrillesCache = null;/m.test(html) &&
    !/api\('\/grilles'/m.test(html) &&
    !/api\(`\/grilles\/\$\{id\}\/\$\{action\}`/m.test(html),
    'L’état et les appels Grilles ne doivent plus être dupliqués dans dashboard.html'
  );
  assert(
    /requireModule\('salary'\)/m.test(read('backend/server.js')) &&
    /function canWrite\(user\)\s*\{\s*return hasRole\(user, 'admin', 'rh', 'finance', 'dg'\); \}/m.test(gridsRoute) &&
    /function canApprove\(user\)\s*\{\s*return hasRole\(user, 'admin', 'dg'\); \}/m.test(gridsRoute) &&
    /function canAffecter\(user\)\s*\{\s*return hasRole\(user, 'admin', 'rh', 'finance'\); \}/m.test(gridsRoute),
    'Les contrôles backend module salary et workflow DG doivent rester actifs'
  );
  return {
    dedicatedModule: true,
    explicitAdapters: true,
    referenceLocality: true,
    assignmentLocality: true,
    backendRights: true,
  };
}

function checkPayrollRevisionsModuleGuard() {
  const html = read('frontend/dashboard.html');
  const revisionsModule = read('frontend/js/modules/payroll-revisions.js');
  const gridsModule = read('frontend/js/modules/payroll-grids.js');
  const periodsModule = read('frontend/js/modules/payroll-periods.js');
  const revisionsRoute = read('backend/routes/revisions_salaire.js');
  assert(
    /<script src="\/js\/modules\/payroll-revisions\.js"><\/script>/m.test(html) &&
    /window\.TalaPayrollRevisions = \{ create, STATUS_LABELS, STATUS_COLORS, TYPE_LABELS \};/m.test(revisionsModule),
    'Les révisions salariales doivent être chargées comme module frontend dédié'
  );
  assert(
    /window\.TalaPayrollRevisions\.create\(\{[\s\S]*?request: api,[\s\S]*?notify: showToast,[\s\S]*?hasAnyRole: hasExactRole,[\s\S]*?setBadge: setNavBadge/m.test(html),
    'Le shell doit monter les révisions avec des adapters explicites'
  );
  assert(
    /\/revisions-salaire\/\$\{id\}\/\$\{actionName\}/m.test(revisionsModule) &&
    /\/revisions-salaire\/en-attente/m.test(revisionsModule) &&
    /\/agents\/\$\{agentId\}\/historique-salaires/m.test(revisionsModule) &&
    /\/revisions-salaire\/\$\{result\.id\}\/soumettre-rh/m.test(revisionsModule),
    'Le module Révisions doit concentrer workflow, création, historique agent et bandeau DG'
  );
  assert(
    /function loadRevisions\(\) \{ return getPayrollRevisions\(\)\.load\(\); \}/m.test(html) &&
    /function saveRevision\(mode\) \{ return getPayrollRevisions\(\)\.save\(mode\); \}/m.test(html) &&
    /function loadDgRevisionsBanner\(\) \{ return getPayrollRevisions\(\)\.loadDgBanner\(\); \}/m.test(html),
    'Le shell doit conserver uniquement les adapters historiques Révisions'
  );
  assert(
    !/let _revisionsData = \[\];/m.test(html) &&
    !/let _revisionDrawerData = null;/m.test(html) &&
    !/api\('\/revisions-salaire/m.test(html) &&
    !/api\(`\/revisions-salaire\/\$\{id\}\/\$\{action\}`/m.test(html) &&
    !/api\(`\/agents\/\$\{agentId\}\/historique-salaires`/m.test(html),
    'L’état et les appels Révisions ne doivent plus être dupliqués dans dashboard.html'
  );
  assert(
    /requireModule\(\['salary', 'hr'\]\)/m.test(read('backend/server.js')) &&
    /function canWrite\(user\)\s*\{\s*return hasRole\(user, \.\.\.WRITE_ROLES\); \}/m.test(revisionsRoute) &&
    /function canRH\(user\)\s*\{\s*return hasRole\(user, \.\.\.RH_ROLES\); \}/m.test(revisionsRoute) &&
    /function canApprove\(user\)\s*\{\s*return hasRole\(user, \.\.\.APPROVE_ROLES\); \}/m.test(revisionsRoute),
    'Les contrôles backend module salary/hr, RH et DG doivent rester actifs'
  );
  assert(
    /ACTIVE_EMPLOYEE_SQL = "COALESCE\(actif, 1\) = 1 AND COALESCE\(statut_dossier, 'actif'\) NOT IN \('sorti', 'archive'\)"/m.test(revisionsRoute) &&
    /SELECT r\.\* FROM demandes_revision_salaire r JOIN employes e ON e\.id = r\.employe_id WHERE 1=1/m.test(revisionsRoute) &&
    /if \(!wantsInactiveRows\(req\)\) sql \+= ` AND \$\{ACTIVE_EMPLOYEE_JOIN_SQL\}`;/m.test(revisionsRoute) &&
    /const agent = getActiveEmployee\(employe_id\);/m.test(revisionsRoute) &&
    /Agent inactif, sorti ou introuvable — révision salariale impossible/m.test(revisionsRoute) &&
    /Agent inactif ou sorti — application de la révision impossible/m.test(revisionsRoute),
    'Les révisions salariales opérationnelles doivent exclure les agents inactifs ou sortis'
  );
  assert(
    /function numberOrZero\(value\)[\s\S]*?Number\.isFinite\(parsed\) \? parsed : 0;[\s\S]*?function fmt\(n\)[\s\S]*?format\(numberOrZero\(n\)\)/m.test(html) &&
    /function fmtXAF\(n\)[\s\S]*?Math\.round\(numberOrZero\(n\)\)/m.test(html) &&
    /function numberValue\(value\)[\s\S]*?Number\.isFinite\(parsed\) \? parsed : 0;[\s\S]*?function money\(value\)[\s\S]*?numberValue\(value\)\.toLocaleString/m.test(revisionsModule) &&
    /function numberValue\(value\)[\s\S]*?Number\.isFinite\(parsed\) \? parsed : 0;[\s\S]*?function money\(value\)[\s\S]*?numberValue\(value\)\.toLocaleString/m.test(gridsModule) &&
    /function numberValue\(value\)[\s\S]*?Number\.isFinite\(parsed\) \? parsed : 0;[\s\S]*?const formatMoney = options\.formatMoney \|\| \(value =>[\s\S]*?numberValue\(value\)\.toLocaleString/m.test(periodsModule),
    'Les helpers monétaires Paie/RH doivent convertir les montants invalides pour éviter NaN XAF'
  );
  return {
    dedicatedModule: true,
    explicitAdapters: true,
    workflowLocality: true,
    historyLocality: true,
    backendRights: true,
    activeEmployeeGuard: true,
    finiteMoneyGuard: true,
  };
}

function checkGlobalFormWidthGuard() {
  const html = read('frontend/dashboard.html');
  assert(
    /input, select, textarea \{[\s\S]*?width: auto;[\s\S]*?max-width: 100%;[\s\S]*?min-width: 0;/m.test(html),
    'Les champs natifs ne doivent plus heriter globalement width:100%'
  );
  assert(
    /\.form-control,[\s\S]*?\.form-full,[\s\S]*?\.input-field,[\s\S]*?input\.w-full,[\s\S]*?select\.w-full,[\s\S]*?textarea\.w-full/m.test(html),
    'La pleine largeur doit passer par une classe intentionnelle'
  );
  assert(
    !/\.modal select,\s*\.modal input\[type="text"\],\s*\.modal textarea/m.test(html) &&
    !/\[id\$="-drawer"\] select,\s*\[id\$="-drawer"\] input/m.test(html),
    'Les modales et drawers ne doivent pas forcer tous les champs par type en pleine largeur'
  );
  assert(
    /button:not\(\.w-full\):not\(\[class\*="w-full"\]\):not\(\.flex-1\),[\s\S]*?a\.btn:not\(\.w-full\):not\(\[class\*="w-full"\]\):not\(\.flex-1\)/m.test(html),
    'Les boutons et liens .btn doivent rester compacts sauf pleine largeur explicite'
  );
  return { nativeControlsCompact: true, explicitFullWidth: true, modalTypeSelectorRemoved: true, linksCompact: true };
}

function checkPayrollWorkspaceArchitecture() {
  const html = read('frontend/dashboard.html');
  const navigation = read('frontend/js/core/navigation.js');
  const navSource = `${html}\n${navigation}`;
  const rhBlock = html.match(/<!-- MODULE RH -->([\s\S]*?)<!-- MODULE COMPTABILITÉ -->/);
  assert(rhBlock, 'Bloc navigation RH introuvable');
  const rhNav = rhBlock[1];

  assert(
    /data-page="salaires"[\s\S]*<span>Paie<\/span>/m.test(rhNav),
    'La navigation RH doit exposer un seul point d entree Paie'
  );
  const hiddenPayrollPages = ['periodes', 'grilles', 'cnss', 'dgi'];
  const leakedPayrollPages = hiddenPayrollPages.filter(page => new RegExp(`data-page="${page}"`).test(rhNav));
  assert.deepStrictEqual(
    leakedPayrollPages,
    [],
    `Sous-vues Paie encore exposees comme modules RH separes: ${leakedPayrollPages.join(', ')}`
  );
  assert(
    /PAYROLL_WORKSPACE_PAGES\s*=\s*new Set\(\['salaires', 'periodes', 'cnss', 'dgi', 'grilles', 'revisions'\]\)/m.test(html) &&
    /PAYROLL_WORKSPACE_TABS\s*=\s*\[[\s\S]*Périodes[\s\S]*Bulletins[\s\S]*CNSS \/ CAMU[\s\S]*DGI \/ IRPP[\s\S]*Grilles[\s\S]*Révisions[\s\S]*Paramètres/m.test(html),
    'Le cockpit Paie doit regrouper periodes, bulletins, declarations, grilles, revisions et parametres'
  );
  for (const slot of ['bulletins', 'cycle', 'declarations-cnss', 'declarations-dgi', 'referentiels', 'revisions']) {
    assert(
      new RegExp(`data-payroll-workspace-nav="${slot}"`).test(html),
      `Point de montage cockpit Paie manquant: ${slot}`
    );
  }
  assert(
    /function activeNavPage\(page\)[\s\S]*return PAYROLL_WORKSPACE_PAGES\.has\(page\) \? 'salaires' : page/m.test(navigation) &&
    /function activeNavPage\(page\)[\s\S]*return _Navigation\.activeNavPage\(page\)/m.test(html) &&
    /el\.classList\.toggle\('active', el\.dataset\.page === navPage\)/m.test(html),
    'Les sous-vues Paie doivent activer la meme entree sidebar Paie'
  );
  assert(
    /salaires:\s*'\/app\/rh\/paie'/m.test(navSource) &&
    /periodes:\s*'\/app\/rh\/paie\/periodes'/m.test(navSource) &&
    /grilles:\s*'\/app\/rh\/paie\/grilles'/m.test(navSource) &&
    /cnss:\s*'\/app\/rh\/paie\/cnss-camu'/m.test(navSource) &&
    /dgi:\s*'\/app\/rh\/paie\/dgi-fiscalite'/m.test(navSource) &&
    /const LEGACY_ROUTE_PAGES = \{/m.test(navigation) &&
    /'\/app\/rh\/periodes-paie': 'periodes'/m.test(navigation),
    'Les routes Paie consolidees doivent garder les anciennes URL en compatibilite'
  );
  assert(
    /salaires:\s*'tba-salaires'[\s\S]*periodes:\s*'tba-salaires'[\s\S]*grilles:\s*'tba-salaires'[\s\S]*revisions:\s*'tba-salaires'[\s\S]*cnss:\s*'tba-salaires'[\s\S]*dgi:\s*'tba-salaires'/m.test(navigation),
    'Toutes les sous-vues Paie doivent utiliser la meme action bar Paie'
  );
  assert(
    /const DesignSystem\s*=\s*\{[\s\S]*PageHeader\(\{[\s\S]*ActionBar\(items[\s\S]*StatusBadge\(label[\s\S]*PeriodSelector\(\{/m.test(html),
    'Le design system minimal doit exposer PageHeader, ActionBar, StatusBadge et PeriodSelector'
  );

  return { singleRhEntry: true, cockpitTabs: true, legacyRoutes: true, sharedTopbar: true };
}

function checkAgentAuditTraceabilityGuard() {
  const agentsRoute = read('backend/routes/agents.js');
  const html = read('frontend/dashboard.html');
  const agentModule = read('frontend/js/modules/agents.js');
  const transport = read('frontend/js/core/transport.js');
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
    /function\s+rejectLegacyEmployeeMutation\(_req,\s*res\)/m.test(usersRoute) &&
    /LEGACY_EMPLOYEE_MUTATION_DISABLED/m.test(usersRoute) &&
    /router\.post\('\/employes',\s*rejectLegacyEmployeeMutation\)/m.test(usersRoute) &&
    /router\.put\('\/employes\/:id',\s*rejectLegacyEmployeeMutation\)/m.test(usersRoute) &&
    /router\.delete\('\/employes\/:id',\s*rejectLegacyEmployeeMutation\)/m.test(usersRoute) &&
    !/INSERT INTO employes \(nom, prenom, poste, type, salaire_base/m.test(usersRoute) &&
    !/UPDATE employes SET nom=\?, prenom=\?, poste=\?, type=\?, salaire_base=\?/m.test(usersRoute),
    "/config/employes doit rester en lecture seule: creation/modification/desactivation passent par le module Agents"
  );
  assert(
    !/id="modal-emp"/m.test(html) &&
    !/id="modal-emp-edit"/m.test(html) &&
    !/id="form-emp"/m.test(html) &&
    !/id="form-emp-edit"/m.test(html) &&
    !/function\s+openEmpModal\(/m.test(html) &&
    !/function\s+openEmpEditModal\(/m.test(html) &&
    !/function\s+deleteEmp\(/m.test(html) &&
    !/api\(`\/config\/employes\/\$\{id\}`/m.test(html) &&
    /openAgentModal\(\$\{e\.id\}\)/m.test(html),
    "La UI ne doit plus exposer de modal employe minimal: ouvrir la fiche Agent complete"
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
    /async function savePendingSubforms\(agentId\)/m.test(agentModule) &&
    /for \(const type of SUBFORM_TYPES\)/m.test(agentModule) &&
    /if \(!hasSubformDraft\(type\)\) continue/m.test(agentModule) &&
    /const result = await saveSubform\(type, agentId\)/m.test(agentModule) &&
    /const SUBFORM_ENDPOINTS = \{[\s\S]*enfant: 'enfants'[\s\S]*document: 'documents'[\s\S]*diplome: 'diplomes'[\s\S]*experience: 'experiences'/m.test(agentModule) &&
    /getAgentDossierModule\(\)\.saveAgent\(\)/m.test(html),
    "Enregistrer l'agent doit sauvegarder les sous-fiches RH brouillon, meme si l'onglet n'est plus visible"
  );
  assert(
    /function hasOpenAgentWorkInProgress\(\)/m.test(html) &&
    /window\.TalaAgentDossier\.create/m.test(html) &&
    /const SUBFORM_TYPES = \['enfant', 'document', 'diplome', 'experience', 'avance', 'conge'\]/m.test(agentModule) &&
    /doc\.querySelectorAll\('\[id\^="rmb-form-"\]'\)/m.test(agentModule) &&
    /async function closeAgentModal\(force = false\)[\s\S]*hasOpenAgentWorkInProgress\(\)[\s\S]*await showConfirm\(/m.test(html) &&
    /function hasSubformDraft\(type\)[\s\S]*type === 'document'[\s\S]*doc-observation/m.test(agentModule) &&
    !/_agentSubformVisible\('document-form'\)/m.test(html) &&
    /closeAgentModal\(true\)/m.test(html),
    "La fermeture du dossier agent doit confirmer uniquement les sous-formulaires contenant un vrai brouillon"
  );
  assert(
    /async function request\(path, opts = \{\}\)[\s\S]*silentStatuses[\s\S]*silentStatuses\.includes\(res\.status\)/m.test(transport) &&
    /loadAgentSortie\(agentId\)[\s\S]*\/sortie`, \{ silentStatuses: \[404\] \}/m.test(html),
    "L'absence normale de dossier de sortie doit rester un etat vide sans toast d'erreur"
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
  const transport = read('frontend/js/core/transport.js');
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
  assert(
    /const newSW = reg\.installing;\s*\n\s*if \(!newSW\) return;[\s\S]*\.catch\(err => console\.warn\('\[SW\] Enregistrement impossible:'/m.test(html),
    "Le service worker doit tolerer reg.installing absent et les erreurs d'enregistrement"
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
  assert(
    /<script src="\/js\/core\/transport\.js"><\/script>/m.test(html) &&
    /window\.TalaTransport\s*=\s*\{/m.test(transport) &&
    /function getTransport\(\)[\s\S]*window\.TalaTransport\.create/m.test(html) &&
    /async function api\(path, opts = \{\}\)[\s\S]*return getTransport\(\)\.request\(path, opts\)/m.test(html) &&
    /async function _apiFetch\(path, method, body\)[\s\S]*return getTransport\(\)\.fetchApi\(path, method, body\)/m.test(html),
    "Le transport HTTP frontend doit etre un module profond avec aliases globaux compatibles"
  );
  assert(
    /Authorization: 'Bearer ' \+ getToken\(\)/m.test(transport) &&
    /'X-Client-Build': getBuildId\(\)/m.test(transport) &&
    /if \(res\.status === 401\)[\s\S]*onUnauthorized\(\)/m.test(transport) &&
    /diagnostic_id/m.test(transport) &&
    /Erreur de connexion au serveur/m.test(transport),
    "Le module transport doit centraliser auth, build id, 401, diagnostics et erreurs reseau"
  );

  return {
    genericModal: true,
    canonicalToken: true,
    serviceWorkerGuard: true,
    noStaticDuplicateIds: true,
    validTopbarTargets: true,
    transportModule: true,
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

function checkRhPayrollUpdatedAtMigration() {
  const migration = read('backend/migrations/029_rh_payroll_updated_at_backfill.sql');
  assert(
    /ALTER TABLE grille_categories[\s\S]*ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/m.test(migration) &&
    /ALTER TABLE grille_echelons[\s\S]*ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/m.test(migration) &&
    /ALTER TABLE employes_heures_sup[\s\S]*ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/m.test(migration) &&
    /ALTER TABLE historique_salaires[\s\S]*ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/m.test(migration),
    'La migration RH/Paie doit ajouter updated_at aux tables historiques utilisées par les workflows modernes'
  );
  return { grilleCategories: true, grilleEchelons: true, heuresSup: true, historiqueSalaires: true };
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
  assert(
    /async function runScheduledTask\(label, task\)/m.test(server) &&
    /return await task\(\)/m.test(server) &&
    /setImmediate\(async \(\) => \{[\s\S]*await runScheduledTask\('NOTIF initial soldes'/m.test(server) &&
    !/try \{ notifSvc\.evaluerAlerteSoldes\(\);\s*\} catch/m.test(server),
    'Les crons async doivent attendre et capturer les rejets sans lancer de transactions concurrentes au demarrage'
  );

  return { mysqlTimestampDiff: true, sqliteFallback: true, noMysqlNullsLast: true, asyncCronErrorsCaught: true };
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
  const operationModal = html.match(/<!-- MODAL: Encaissement -->([\s\S]*?)<!-- MODAL: Utilisateur -->/);
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
    /syncStep\('Trésorerie', o\.treasury_status\)/m.test(html) &&
    /syncStep\('Comptabilité', o\.accounting_status\)/m.test(html) &&
    /syncStep\('Budget', o\.budget_status\)/m.test(html),
    'Le journal operations doit afficher les statuts de synchronisation avec des etapes nommees'
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
    /function selectAccountingMapping/m.test(service) &&
    /function mappingSpecificity/m.test(service) &&
    /ruleMatchesCriteria\(rule, criteria\)/m.test(service),
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
  const navigation = read('frontend/js/core/navigation.js');

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
    /id="page-journal-comptable"/m.test(html) &&
    /data-page="journal-comptable"/m.test(html) &&
    /'comptabilite-dashboard':\s*'\/app\/comptabilite'/m.test(navigation) &&
    /'\/app\/comptabilite\/tableau-de-bord':\s*'comptabilite-dashboard'/m.test(navigation) &&
    /'comptabilite-dashboard':\s*\['cash', 'accounting'\]/m.test(navigation) &&
    /'journal-comptable':\s*\['cash', 'accounting'\]/m.test(navigation) &&
    /id="page-comptabilite-dashboard"/m.test(html) &&
    /data-page="comptabilite-dashboard"/m.test(html) &&
    /nav-group-header nav-link[\s\S]*showPage\('comptabilite-dashboard'\)/m.test(html) &&
    !/<span>Tableau comptabilité<\/span>/m.test(html) &&
    !/>Branchements</m.test(html) &&
    !/Attention comptabilité : mappings manquants/m.test(html) &&
    !/id="cpta-dashboard-alert"/m.test(html) &&
    /Contrôles comptables/m.test(html) &&
    /Comptabilité non prête/m.test(html) &&
    /Prêt à clôturer/m.test(html) &&
    /Mappings manquants/m.test(html) &&
    /Écritures en attente/m.test(html) &&
    /Règles comptables à compléter/m.test(html) &&
    /Écritures à traiter/m.test(html) &&
    /cpta-top-grid/m.test(html) &&
    /cpta-kpi-grid/m.test(html) &&
    /cpta-main-grid/m.test(html) &&
    /cpta-work-grid/m.test(html) &&
    /Corriger les règles comptables/m.test(html) &&
    /Corriger les écritures/m.test(html) &&
    /Journal comptable/m.test(html) &&
    /cpta-dashboard-workflow-chart/m.test(html) &&
    /cpta-dashboard-priority-actions/m.test(html) &&
    /cpta-dashboard-balance-status/m.test(html) &&
    /cpta-dashboard-mapping-status/m.test(html) &&
    /cpta-dashboard-queue-status/m.test(html) &&
    /router\.get\('\/dashboard'/m.test(route) &&
    /SELECT id, annee, mois, cloture_at/m.test(route) &&
    !/SELECT id, annee, mois, created_at[\s\S]*FROM periodes_cloturees/m.test(route) &&
    /api\('\/accounting\/dashboard'\)/m.test(html) &&
    /if \(name === 'comptabilite-dashboard'\)/m.test(html) &&
    /'journal-comptable':'Journal comptable OHADA'/m.test(html) &&
    /if \(name === 'journal-comptable'\)/m.test(html) &&
    /renderJournalComptableTotals\(data\)/m.test(html) &&
    /ACCOUNTING_SOURCE_LABELS/m.test(html) &&
    /Comptabilité générale/m.test(html) &&
    /Ledger comptable distinct du journal de trésorerie/m.test(html) &&
    /cpta-ledger-shell/m.test(html) &&
    /cpta-ledger-filter-grid/m.test(html) &&
    /cpta-ledger-total-grid/m.test(html) &&
    /Journal de trésorerie — mouvements caisse\/banque validés/m.test(html) &&
    /jnl-hero-grid/m.test(html) &&
    /jnl-filter-grid/m.test(html) &&
    /jnl-total-grid/m.test(html) &&
    /jnl-table-scroll/m.test(html) &&
    !/Format SYSCOHADA/m.test(html) &&
    !/JOURNAL OHADA/m.test(html) &&
    !/Journal OHADA/m.test(html) &&
    !/rpt-section-journal-cpta/m.test(html) &&
    !/rtab-journal-cpta/m.test(html) &&
    !/jcpta-/m.test(html) &&
    /Aucune écriture comptable générée sur cette période/m.test(html),
    'Le journal comptable UI doit etre une page Comptabilite distincte, branchée au ledger reel et separee du journal tresorerie'
  );

  return { mysqlLedger: true, sqliteLedger: true, accountingEntriesApi: true, frontendUsesLedger: true };
}

function checkAccountingWorkflowGuard() {
  const route = read('backend/routes/accounting.js');
  const service = read('backend/services/accounting.js');
  const operations = read('backend/routes/operations.js');
  const sqlite = read('backend/database.js');
  const html = read('frontend/dashboard.html');

  assert(
    /router\.post\('\/entries\/generate'/m.test(route) &&
    /router\.post\('\/entries\/:id\/validate'/m.test(route) &&
    /router\.post\('\/entries\/:id\/reverse'/m.test(route) &&
    /router\.get\('\/anomalies'/m.test(route),
    'Le workflow comptable doit exposer génération, validation, contre-écriture et anomalies'
  );
  assert(
    /router\.patch\('\/mapping-rules\/:id\/status'/m.test(route) &&
    /Confirmation explicite requise/m.test(route) &&
    /accounting_mapping_activated/m.test(route),
    'L’activation d’un mapping doit être explicite, sécurisée et auditée'
  );
  assert(
    /async function generateAccountingEntryForOperation/m.test(service) &&
    /async function createAccountingReversal/m.test(service) &&
    /async function validateAccountingEntry/m.test(service) &&
    /ACCOUNTING_ENTRY_UNBALANCED/m.test(service) &&
    /ACCOUNTING_PERIOD_CLOSED/m.test(service) &&
    /postedReversal \? 'cancelled' : 'synced'/m.test(service) &&
    /const accountingStatus = entry\.source_module === REVERSAL_SOURCE_MODULE \? 'cancelled' : 'synced'/m.test(service) &&
    /source_module = \? AND source_record_id = \?/m.test(service) &&
    /ACCOUNTING_REVERSAL_REASON_REQUIRED/m.test(service) &&
    /source_module = \?[\s\S]*source_record_id = \?[\s\S]*status IN \('posted', 'draft'\)/m.test(service),
    'Le module comptable doit garantir idempotence, équilibre, période ouverte, contre-écriture et synchronisation'
  );
  assert(
    /attemptAutomaticAccountingForOperation/m.test(operations) &&
    /operationId: op\.id/m.test(operations) &&
    /operationId: result\.insertId/m.test(operations),
    'Les nouveaux encaissements, virements et décaissements payés doivent tenter la génération comptable'
  );
  assert(
    /async function hasPostedAccountingEntry/m.test(operations) &&
    /Modification interdite : opération déjà comptabilisée/m.test(operations) &&
    /Annulation directe interdite : opération déjà comptabilisée/m.test(operations),
    'Une opération comptabilisée doit être immuable et corrigée par contre-écriture'
  );
  assert(
    /CREATE TABLE IF NOT EXISTS periodes_cloturees/m.test(sqlite) &&
    /ALTER TABLE "\$\{legacyTable\}" RENAME TO \$\{canonicalTable\}/m.test(sqlite),
    'Le fallback SQLite doit utiliser le même nom de table de clôture que MySQL et migrer le nom historique'
  );
  assert(
    /id="cpta-panel-entries"/m.test(html) &&
    /id="cpta-panel-anomalies"/m.test(html) &&
    /id="cpta-anomalies-pagination"/m.test(html) &&
    /id="cpta-panel-mappings"/m.test(html) &&
    /async function loadAccountingWorkspace/m.test(html) &&
    /async function loadAccountingAnomalies/m.test(html) &&
    /function changeAccountingAnomalyPage/m.test(html) &&
    /ACCOUNTING_ANOMALY_PAGE_SIZE = 50/m.test(html) &&
    /accounting\/anomalies\?limit=\$\{ACCOUNTING_ANOMALY_PAGE_SIZE\}&offset=\$\{_accountingAnomalyOffset\}/m.test(html) &&
    /async function loadAccountingMappings/m.test(html) &&
    /async function generateAccountingOperation/m.test(html) &&
    /async function validateAccountingEntryUi/m.test(html) &&
    /async function reverseAccountingEntryUi/m.test(html) &&
    /async function toggleAccountingMapping/m.test(html),
    'L’espace comptable doit relier écritures, file à comptabiliser et règles sans page dupliquée'
  );
  assert(
    /limit: req\.query\.limit,[\s\S]*offset: req\.query\.offset/m.test(route) &&
    /LIMIT \? OFFSET \?/m.test(service) &&
    /pagination:\s*\{[\s\S]*has_previous:[\s\S]*has_next:/m.test(service),
    'La file comptable doit être paginée côté serveur avec un total global'
  );
  assert(
    /id="app-page-container"/m.test(html) &&
    /#app-page-container\s*\{[\s\S]*overflow-x:\s*hidden/m.test(html) &&
    /#page-journal-comptable \[role="tablist"\],[\s\S]*\.accounting-table-scroll\s*\{[\s\S]*overflow-x:\s*auto/m.test(html) &&
    (html.match(/class="accounting-table-scroll"/g) || []).length >= 4 &&
    /class="accounting-summary-grid gap-3 mb-4"/m.test(html) &&
    /\.accounting-summary-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,/m.test(html) &&
    /class="w-full text-sm accounting-entries-table"/m.test(html) &&
    /\.accounting-entries-table\s*\{[\s\S]*table-layout:\s*fixed/m.test(html),
    'Le contenu principal mobile doit rester fixe et limiter le défilement horizontal aux onglets et tableaux comptables'
  );

  return {
    generationApi: true,
    validationApi: true,
    anomaliesApi: true,
    explicitMappingActivation: true,
    automaticLifecycleHook: true,
    canonicalClosedPeriodsTable: true,
    postedSourceImmutable: true,
    accountingWorkspace: true,
    accountingAnomalyPagination: true,
    accountingMobileOverflowIsolated: true,
    accountingReversal: true,
  };
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
    /\.access-modal-shell\s*>\s*form\s*\{[\s\S]*flex:\s*1 1 auto[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/m.test(html) &&
    /\.access-modal-body\s*\{[\s\S]*overflow-y:\s*auto/m.test(html) &&
    /\.user-role-grid\.access-role-grid-compact\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/m.test(html) &&
    /@media \(max-width:\s*900px\)[\s\S]*\.user-role-grid\.access-role-grid-compact\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/m.test(html) &&
    /@media \(max-width:\s*760px\)[\s\S]*\.user-role-grid\.access-role-grid-compact\s*\{[\s\S]*grid-template-columns:\s*1fr/m.test(html),
    'Le formulaire utilisateur doit contraindre sa hauteur, garder le footer visible et compacter les roles desktop/tablette/mobile'
  );
  assert(
    /id="ue-submit"/m.test(html) &&
    /ueSubmit\.disabled\s*=\s*true/m.test(html) &&
    /ueSubmit\.disabled\s*=\s*false/m.test(html),
    'La modification utilisateur doit verrouiller puis restaurer le bouton pendant l’enregistrement'
  );
  assert(
    /id="u-submit"/m.test(html) &&
    /uSubmit\.disabled\s*=\s*true/m.test(html) &&
    /uSubmit\.disabled\s*=\s*false/m.test(html) &&
    /uSubmit\.textContent\s*=\s*'Création\.\.\.'/m.test(html),
    'La creation utilisateur doit verrouiller puis restaurer le bouton pendant l’enregistrement'
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
    /ops-hero-grid/m.test(html) &&
    /ops-command-card/m.test(html) &&
    /ops-filter-card/m.test(html) &&
    /ops-filter-grid/m.test(html) &&
    /ops-kpi-grid/m.test(html) &&
    /ops-table-scroll/m.test(html) &&
    /ops-flt-btn\.is-active/m.test(html) &&
    /classList\.add\('is-active'\)/m.test(html) &&
    /Totaux calculés sur/m.test(html),
    "La vue operations doit afficher les totaux filtres serveur, expliquer le scope et utiliser des styles responsives explicites"
  );
  assert(
    /Mouvements caisse\/banque/m.test(html) &&
    /Filtres du journal validé/m.test(html) &&
    /Journal des mouvements validés/m.test(html) &&
    /File décaissements/m.test(html) &&
    /ops-workspace-switcher/m.test(html) &&
    /showPage\('rapprochement'\)/m.test(html) &&
    /showPage\('journal-comptable'\)/m.test(html) &&
    /ouvrirModalImport\(\)/m.test(html) &&
    /Cycle de validation/m.test(html) &&
    /const operationFlow = \(o\) =>/m.test(html) &&
    /syncStep\('Trésorerie', o\.treasury_status\)/m.test(html) &&
    /syncStep\('Comptabilité', o\.accounting_status\)/m.test(html) &&
    /syncStep\('Budget', o\.budget_status\)/m.test(html) &&
    /const operationAmount = \(o\) =>/m.test(html) &&
    /ops-amount-cell/m.test(html) &&
    /ops-journal-state/m.test(html) &&
    !/<th class="text-right px-5 py-3\.5">Recette<\/th>/m.test(html) &&
    !/<th class="text-right px-5 py-3\.5">Dépense<\/th>/m.test(html) &&
    !/<th class="text-left px-5 py-3\.5">Sync<\/th>/m.test(html),
    "La vue mouvements caisse/banque doit separer journal, decaissements, rapprochement, comptabilite et import"
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

function checkCashExcelImportGuard() {
  const importer = read('scripts/import_cash_excel_mysql.js');

  assert(
    /DEFAULT_FILE\s*=\s*'\/mnt\/c\/Users\/Gess\/OneDrive\/Documents\/GESTION CAISSE-TOP-CENTER 2025 \(2\)\.xlsx'/m.test(importer) &&
    /DEFAULT_USER_EMAIL\s*=\s*'princilia\.louvouezo@topcenter\.cg'/m.test(importer) &&
    /DEFAULT_POSITION_CODE\s*=\s*'CAISSE'/m.test(importer),
    'L import caisse Excel doit cibler explicitement le fichier source, Louvouezo et la position CAISSE'
  );
  assert(
    /XLSX\.utils\.decode_range\(sheet\['!ref'\]/m.test(importer) &&
    /XLSX\.utils\.encode_cell\(\{ r: row, c: col \}\)/m.test(importer) &&
    /const excelRow = rowIndex \+ 1/m.test(importer) &&
    !/sheet_to_json\(sheet,\s*\{\s*header:\s*1,\s*raw:\s*false,\s*blankrows:\s*false/m.test(importer),
    'L import caisse Excel doit conserver les vrais numeros de ligne Excel, sans compression des lignes vides'
  );
  assert(
    /dateText === 'date'/m.test(importer) &&
    !/date\|d\[ée\]tail\|etat\|total/i.test(importer),
    'L import caisse Excel ne doit pas confondre les operations Etat financier avec des lignes entete'
  );
  assert(
    /const apply = hasFlag\('apply'\)/m.test(importer) &&
    /const replaceExisting = hasFlag\('replace-existing'\)/m.test(importer) &&
    /const confirmed = hasFlag\('i-understand-this-replaces-production-cash'\)/m.test(importer) &&
    /Application refusee: flags de remplacement production manquants/m.test(importer),
    'L import caisse Excel ne doit jamais remplacer la production sans confirmation explicite'
  );
  assert(
    /balanceBreaks\.length && !trustSoldeColumn/m.test(importer) &&
    /Application refusee: ecarts de solde non arbitres/m.test(importer) &&
    /trust-solde-column-for-balance-breaks/m.test(importer),
    'L import caisse Excel doit bloquer les ecarts entre solde et recette/depense tant qu ils ne sont pas arbitres'
  );
  assert(
    /async function referenceCounts\(\)/m.test(importer) &&
    /demandes_achat/m.test(importer) &&
    /bulletins_salaire/m.test(importer) &&
    /accounting_entries/m.test(importer) &&
    /Remplacement refuse: des tables referencent deja operations/m.test(importer),
    'L import caisse Excel doit refuser le remplacement si des flux aval referencent les operations'
  );
  assert(
    /async function backupCurrentOperations/m.test(importer) &&
    /DEFAULT_BACKUP_DIR\s*=\s*process\.env\.CASH_IMPORT_BACKUP_DIR\s*\|\|\s*'\/app\/backend\/data\/backups'/m.test(importer) &&
    /fs\.mkdirSync\(path\.dirname\(filePath\), \{ recursive: true \}\)/m.test(importer) &&
    /fs\.writeFileSync\(filePath, JSON\.stringify\(payload, null, 2\)\)/m.test(importer) &&
    /UPDATE positions SET solde_initial = \?/m.test(importer),
    'L import caisse Excel doit sauvegarder durablement les operations et utiliser solde_initial pour le report a nouveau'
  );
  assert(
    /detachPayrollOperationLinks = hasFlag\('detach-payroll-operation-links'\)/m.test(importer) &&
    /bulletins_salaire_operation_links/m.test(importer) &&
    /UPDATE bulletins_salaire SET operation_id = NULL/m.test(importer),
    'L import caisse Excel doit detacher les liens bulletins uniquement avec un flag explicite et les inclure dans le backup'
  );

  return { dryRunDefault: true, louvoeuzoActor: true, destructiveFlags: true, balanceGuard: true, backup: true, payrollDetachGuard: true };
}

function checkTreasuryOperationModalLayoutGuard() {
  const html = read('frontend/dashboard.html');
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  assert(style, 'Bloc CSS principal introuvable dans dashboard.html');
  const css = style[1];
  const encModal = html.match(/<div id="modal-encaissement"[\s\S]*?<\/form>\s*<\/div>\s*<\/div>/);
  const decModal = html.match(/<div id="modal-decaissement"[\s\S]*?<\/form>\s*<\/div>\s*<\/div>/);
  assert(encModal, 'Modal Nouvel encaissement introuvable');
  assert(decModal, 'Modal Nouveau decaissement introuvable');

  assert(
    /\.operation-modal-shell\s*\{[\s\S]*width:\s*min\(900px,\s*calc\(100vw - 48px\)\);[\s\S]*max-height:\s*calc\(100vh - 32px\);/m.test(css),
    'Les modals encaissement/decaissement doivent avoir une largeur max 900px et une hauteur max viewport'
  );
  assert(
    /\.operation-modal-body\s*\{[\s\S]*overflow-y:\s*auto;/m.test(css),
    'Le corps des modals encaissement/decaissement doit etre scrollable'
  );
  assert(
    /\.operation-modal-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(260px,\s*1fr\)\);/m.test(css) &&
    /@media \(max-width:\s*720px\)\s*\{[\s\S]*\.operation-modal-grid\s*\{[\s\S]*grid-template-columns:\s*1fr;/m.test(css),
    'La grille des modals encaissement/decaissement doit etre responsive 2 colonnes puis 1 colonne sous 720px'
  );
  assert(
    /\.operation-modal-shell input:not\(\[type="checkbox"\]\),\s*\n\s*\.operation-modal-shell select,\s*\n\s*\.operation-modal-shell textarea\s*\{[\s\S]*width:\s*100%;[\s\S]*min-height:\s*42px;[\s\S]*font-size:\s*14px;[\s\S]*padding:\s*10px 12px;/m.test(css),
    'Les controles des modals encaissement/decaissement doivent rester saisissables et dimensionnes'
  );
  assert(
    /\.operation-modal-footer\s*\{[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*0;/m.test(css) &&
    /\.operation-modal-footer \.btn\[type="submit"\]\s*\{[\s\S]*min-height:\s*42px;[\s\S]*min-width:\s*190px;/m.test(css),
    'Le footer des modals encaissement/decaissement doit rester accessible avec bouton principal dimensionne'
  );

  for (const [label, modal] of [['encaissement', encModal[0]], ['decaissement', decModal[0]]]) {
    assert(/operation-modal-shell/.test(modal), `Modal ${label}: shell layout absent`);
    assert(/operation-modal-body/.test(modal), `Modal ${label}: body scrollable absent`);
    assert(/operation-modal-footer/.test(modal), `Modal ${label}: footer sticky absent`);
    assert(!/max-w-3xl/.test(modal), `Modal ${label}: ancienne largeur max-w-3xl encore presente`);
    assert(!/style="height:92vh;max-height:92vh"/.test(modal), `Modal ${label}: ancien style inline 92vh encore present`);
    assert(!/style=["'][^"']*width:\s*(?:1?\d\d)px/i.test(modal), `Modal ${label}: largeur fixe inferieure a 200px detectee`);
  }

  assert(/id="enc-libelle"[\s\S]{0,120}operation-field-full|operation-field-full[\s\S]{0,180}id="enc-libelle"/m.test(encModal[0]), 'Le libelle encaissement doit etre pleine largeur');
  assert(/operation-field-full[\s\S]{0,180}id="enc-ref"/m.test(encModal[0]), 'La reference externe encaissement doit etre pleine largeur');
  assert(/id="dec-libelle"[\s\S]{0,120}operation-field-full|operation-field-full[\s\S]{0,180}id="dec-libelle"/m.test(decModal[0]), 'Le libelle decaissement doit etre pleine largeur');
  assert(/operation-field-full[\s\S]{0,220}id="dec-ref"/m.test(decModal[0]), 'La reference externe decaissement doit etre pleine largeur');
  assert(/id="dec-impact-box" class="operation-field-full/m.test(decModal[0]), 'Le controle decaissement doit etre pleine largeur');
  assert(/id="enc-impact-box" class="operation-field-full/m.test(encModal[0]), 'Le controle encaissement doit etre pleine largeur');

  return { maxWidth: true, responsiveGrid: true, controlMinHeight: true, noTinyFixedFieldWidth: true };
}

const result = {
  frontendModuleMapping: checkFrontendModuleMapping(),
  compose: checkComposeNoObsoleteVersion(),
  canonicalProjectPath: checkCanonicalProjectPath(),
  canonicalFrontendRouting: checkCanonicalFrontendRouting(),
  mysqlOperationalDocs: checkMysqlOperationalDocs(),
  agentExitInvariant: checkAgentExitInvariant(),
  userAgentLinkInvariant: checkUserAgentLinkInvariant(),
  agentProvisioningUi: checkAgentProvisioningUiVisible(),
  salaryUpdateFalsePositiveGuard: checkSalaryUpdateFalsePositiveGuard(),
  agentPayloadBuilders: checkAgentPayloadBuilders(),
  payrollWorkspaceArchitecture: checkPayrollWorkspaceArchitecture(),
  paidPayrollCorrectionUi: checkPaidPayrollCorrectionUiGuard(),
  payrollCycleModule: checkPayrollCycleModuleGuard(),
  payrollDocumentsModule: checkPayrollDocumentsModuleGuard(),
  payrollGridsModule: checkPayrollGridsModuleGuard(),
  payrollPeriodsModule: checkPayrollPeriodsModuleGuard(),
  payrollRevisionsModule: checkPayrollRevisionsModuleGuard(),
  globalFormWidthGuard: checkGlobalFormWidthGuard(),
  agentAuditTraceabilityGuard: checkAgentAuditTraceabilityGuard(),
  frontendSilentBreakGuards: checkFrontendSilentBreakGuards(),
  onboardingSchemaMigration: checkOnboardingSchemaMigration(),
  rhPayrollUpdatedAtMigration: checkRhPayrollUpdatedAtMigration(),
  usersUpdatedAtMigration: checkUsersUpdatedAtMigration(),
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
  accountingWorkflowGuard: checkAccountingWorkflowGuard(),
  accessWorkspaceIndustrialUiGuard: checkAccessWorkspaceIndustrialUiGuard(),
  dashboardOperationFilterGuards: checkDashboardOperationFilterGuards(),
  cashExcelImportGuard: checkCashExcelImportGuard(),
  treasuryOperationModalLayoutGuard: checkTreasuryOperationModalLayoutGuard(),
};

console.log(JSON.stringify({ ok: true, ...result }));

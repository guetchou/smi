const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migrationBase = fs.readFileSync(path.join(root, 'backend/migrations/033_department_functions.sql'), 'utf8');
const migrationWorkflow = fs.readFileSync(path.join(root, 'backend/migrations/034_department_functions_workflow.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/department_function_workflow.js'), 'utf8');
const hierarchy = fs.readFileSync(path.join(root, 'backend/services/organization_department_hierarchy.js'), 'utf8');
const mutationBridge = fs.readFileSync(path.join(root, 'backend/services/organization_mutation_department_functions.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_department_functions.js'), 'utf8');
const parentRouter = fs.readFileSync(path.join(root, 'backend/routes/organization_mutation_workflow.js'), 'utf8');
const permissions = fs.readFileSync(path.join(root, 'backend/services/permissions.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-department-functions-ui.js'), 'utf8');
const mutationUi = fs.readFileSync(path.join(root, 'frontend/js/modules/org-mutation-workflow-ui.js'), 'utf8');
const deploy = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
const smoke = fs.readFileSync(path.join(root, 'scripts/check_department_functions_mysql.js'), 'utf8');
const backfill = fs.readFileSync(path.join(root, 'scripts/backfill_department_functions_mysql.js'), 'utf8');

for (const source of [service, hierarchy, mutationBridge, routes, parentRouter, permissions, loader, ui, mutationUi, smoke, backfill]) {
  new Function(source);
}

assert(migrationBase.includes('CREATE TABLE org_departement_fonctions'));
assert(migrationBase.includes('ENGINE=InnoDB'));
assert(migrationBase.includes('AUTO_INCREMENT'));
assert(!migrationBase.includes('AUTOINCREMENT'));
assert(migrationBase.includes("'Reprise du responsable historique'"));

for (const column of ['statut', 'version', 'document_url', 'document_hash', 'submitted_by', 'approved_at', 'effective_at', 'closed_at', 'singleton_key']) {
  assert(migrationWorkflow.includes(column), `missing workflow column ${column}`);
}
assert(migrationWorkflow.includes('CREATE TABLE org_departement_fonction_events'));
assert(migrationWorkflow.includes('uq_org_df_singleton_active'));
assert(migrationWorkflow.includes('GENERATED ALWAYS AS'));
assert(migrationWorkflow.includes('JSON_OBJECT'));

const permissionCodes = [
  'hr.department_function.view',
  'hr.department_function.create',
  'hr.department_function.submit',
  'hr.department_function.approve',
  'hr.department_function.activate',
  'hr.department_function.close',
  'hr.department_function.attach_document',
  'hr.department_function.report',
];
for (const code of permissionCodes) {
  assert(migrationWorkflow.includes(code), `migration missing ${code}`);
  assert(permissions.includes(code), `legacy fallback missing ${code}`);
}

for (const type of ['chef', 'premier_adjoint', 'adjoint', 'interimaire', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur']) {
  assert(service.includes(`${type}:`) || service.includes(`'${type}'`), `missing function type ${type}`);
}
for (const status of ['brouillon', 'soumis', 'approuve', 'refuse', 'actif', 'a_corriger', 'annule', 'cloture']) {
  assert(service.includes(`'${status}'`), `missing status ${status}`);
}
assert(service.includes("const db = require('../db')"));
assert(!service.includes("require('../database')"));
assert(service.includes('db.transaction(async tx =>'));
assert(service.includes('FOR UPDATE'));
assert(service.includes('FUNCTION_VERSION_CONFLICT'));
assert(service.includes('SELF_APPROVAL_FORBIDDEN'));
assert(service.includes('SIGNED_DOCUMENT_REQUIRED'));
assert(service.includes('writeEvent(tx'));
assert(service.includes("INSERT INTO audit_logs"));
assert(service.includes('org_departement_fonction_events'));
assert(service.includes('processDue'));
assert(service.includes('departmentOverview'));
assert(service.includes('async function report'));
assert(service.includes('department_without_active_chief'));
assert(service.includes('sensitive_function_without_document'));

for (const notification of ['ORG_FUNCTION_SUBMITTED', 'ORG_FUNCTION_APPROVED', 'ORG_FUNCTION_REFUSED', 'ORG_FUNCTION_EFFECTIVE', 'ORG_FUNCTION_EXPIRING', 'ORG_FUNCTION_ENDED']) {
  assert(migrationWorkflow.includes(notification), `missing notification rule ${notification}`);
  assert(service.includes(notification), `missing notification delivery ${notification}`);
}

assert(routes.includes("router.post('/fonctions/:id/soumettre'"));
assert(routes.includes("router.post('/fonctions/:id/approuver'"));
assert(routes.includes("router.post('/fonctions/:id/refuser'"));
assert(routes.includes("router.post('/fonctions/:id/activer'"));
assert(routes.includes("router.post('/fonctions/:id/cloturer'"));
assert(routes.includes("router.post('/fonctions/:id/annuler'"));
assert(routes.includes("router.post('/fonctions/:id/document'"));
assert(routes.includes("router.get('/fonctions-rapport'"));
assert(routes.includes('MAX_DOCUMENT_BYTES'));
assert(routes.includes('sha256'));
assert(routes.includes('workflow.processDue'));
assert(!routes.includes("require('../database')"));

assert(parentRouter.includes("require('./organization_department_functions')"));
assert(parentRouter.includes('router.use(departmentFunctionsRouter)'));
assert(hierarchy.includes('AsyncLocalStorage'));
assert(hierarchy.includes('withRequestedSupervisor'));
assert(hierarchy.includes('assertWorkflowGuard(payload, options)'));
assert(hierarchy.includes('USE_ORGANIZATION_MUTATION_WORKFLOW'));
assert(mutationBridge.includes('workflow.applyDue ='));

assert(loader.includes('/js/modules/org-department-functions-ui.js'));
assert(ui.includes('Brouillon → soumission → approbation → prise d’effet → clôture'));
assert(ui.includes('hr.department_function.approve'));
assert(ui.includes('hr.department_function.attach_document'));
assert(ui.includes('org-function-document'));
assert(ui.includes('fileToBase64'));
assert(ui.includes('data-action="history"'));
assert(ui.includes("api('/fonctions-rapport')"));
assert(ui.includes('org-functions-anomalies'));
assert(ui.includes('FUNCTION_VERSION_CONFLICT') || ui.includes('row.version'));
assert(mutationUi.includes('org-mutation-supervisor'));
assert(mutationUi.includes('nouveau_sup_id:'));

assert(deploy.includes('backfill_department_functions_mysql.js'));
assert(deploy.includes('check_department_functions_mysql.js'));
assert(deploy.indexOf('check_department_functions_mysql.js') < deploy.indexOf('docker compose up -d --wait --wait-timeout 120 caisse'));
assert(smoke.includes('INFORMATION_SCHEMA.COLUMNS'));
assert(smoke.includes('uq_org_df_singleton_active'));
assert(smoke.includes('transaction_rollback'));
assert(smoke.includes('FOR UPDATE'));
assert(backfill.includes('NOT EXISTS'));
assert(backfill.includes('legacy_import'));

console.log('OK - complete MySQL department functions module contracts');

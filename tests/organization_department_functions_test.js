const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('./organization_sqlite_startup_schema_test');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/034_department_functions_workflow.sql'), 'utf8');
const sqliteSchema = fs.readFileSync(path.join(root, 'backend/database.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/department_function_workflow.js'), 'utf8');
const createDraftFix = fs.readFileSync(path.join(root, 'backend/services/department_function_create_draft_fix.js'), 'utf8');
const notificationGuard = fs.readFileSync(path.join(root, 'backend/services/department_function_notification_guard.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_department_functions.js'), 'utf8');
const permissions = fs.readFileSync(path.join(root, 'backend/services/permissions.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-department-functions-ui.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const documentUi = fs.readFileSync(path.join(root, 'frontend/js/modules/org-doc-upload.js'), 'utf8');

for (const source of [service, createDraftFix, notificationGuard, routes, permissions, ui, loader, documentUi]) new Function(source);

for (const status of ['brouillon','soumis','approuve','refuse','actif','a_corriger','annule','cloture']) {
  assert(service.includes(`'${status}'`), `missing status ${status}`);
}
for (const code of [
  'hr.department_function.view','hr.department_function.create','hr.department_function.submit',
  'hr.department_function.approve','hr.department_function.activate','hr.department_function.close',
  'hr.department_function.attach_document','hr.department_function.report',
]) {
  assert(migration.includes(code), `migration missing ${code}`);
  assert(permissions.includes(code), `fallback missing ${code}`);
}
assert(migration.includes('org_departement_fonction_events'));
assert(migration.includes('uq_org_df_singleton_active'));
assert(migration.includes('GENERATED ALWAYS AS'));
for (const table of ['org_unites', 'org_departement_fonctions', 'org_departement_fonction_events']) {
  assert(sqliteSchema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `SQLite schema missing ${table}`);
}
assert(sqliteSchema.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_org_df_singleton_active'));
assert(sqliteSchema.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_org_dfe_version_event'));
assert(sqliteSchema.includes("addColumnIfMissing('employes', 'poste_id'"));
assert(service.includes("const db = require('../db')"));
assert(service.includes('db.transaction(async tx =>'));
assert(service.includes('FOR UPDATE'));
assert(service.includes('FUNCTION_VERSION_CONFLICT'));
assert(service.includes('SELF_APPROVAL_FORBIDDEN'));
assert(service.includes('SIGNED_DOCUMENT_REQUIRED'));
assert(service.includes('writeEvent(tx'));
assert(service.includes('INSERT INTO audit_logs'));
assert(service.includes('processDue'));
assert(service.includes('department_without_active_chief'));
assert(service.includes('sensitive_function_without_document'));
assert(createDraftFix.includes("VALUES (?,?,?,?, 'brouillon', 1, ?,?,?,?,?,?,0,?,?,NOW(),NOW())"));
assert(!createDraftFix.includes("VALUES (?,?,?,?, 'brouillon', 1, ?,?,?,?,?,?,?,0,?,?,NOW(),NOW())"));
assert(createDraftFix.includes('installDepartmentFunctionCreateDraftFix'));
assert(notificationGuard.includes('installDepartmentFunctionCreateDraftFix()'));
for (const type of ['ORG_FUNCTION_SUBMITTED','ORG_FUNCTION_APPROVED','ORG_FUNCTION_REFUSED','ORG_FUNCTION_EFFECTIVE','ORG_FUNCTION_EXPIRING','ORG_FUNCTION_ENDED']) {
  assert(migration.includes(type));
  assert(service.includes(type));
}
for (const action of ['soumettre','approuver','refuser','activer','cloturer','annuler','document']) {
  assert(routes.includes(`/fonctions/:id/${action}`), `missing route ${action}`);
}
assert(routes.includes('MAX_DOCUMENT_BYTES'));
assert(routes.includes('sha256'));
assert(ui.includes('Brouillon → soumission → approbation → prise d’effet → clôture'));
assert(ui.includes('data-action="history"'));
assert(ui.includes("api('/fonctions-rapport')"));
assert(documentUi.includes('data-action="document"'));
assert(documentUi.includes('content_base64'));

// Le sous-module Fonctions ne doit pas démarrer sur toutes les pages RH : il effectue
// plusieurs lectures /api/org en arrière-plan et polluait les E2E des contrats.
assert(loader.includes("normalizedPath() !== '/app/rh/organigramme'"), 'department functions UI must be route-gated');
assert(loader.includes("const departmentFunctionsScript = '/js/modules/org-department-functions-ui.js'"));
assert(!/const scripts = \[[\s\S]*org-department-functions-ui\.js/.test(loader), 'department functions UI must not be part of the unconditional loader list');
assert(loader.includes("window.addEventListener('popstate', notify)"), 'lazy loader must follow browser navigation');
assert(loader.includes("for (const method of ['pushState', 'replaceState'])"), 'lazy loader must follow SPA history navigation');

console.log('OK - complete department function workflow');

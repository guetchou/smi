const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/034_department_functions_workflow.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/department_function_workflow.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_department_functions.js'), 'utf8');
const permissions = fs.readFileSync(path.join(root, 'backend/services/permissions.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-department-functions-ui.js'), 'utf8');
const documentUi = fs.readFileSync(path.join(root, 'frontend/js/modules/org-doc-upload.js'), 'utf8');

for (const source of [service, routes, permissions, ui, documentUi]) new Function(source);

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

console.log('OK - complete department function workflow');

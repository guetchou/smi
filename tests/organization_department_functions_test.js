const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/033_department_functions.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend/services/organization_department_functions_schema.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_department_functions.js'), 'utf8');
const hierarchy = fs.readFileSync(path.join(root, 'backend/services/organization_department_hierarchy.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_department_functions.js'), 'utf8');
const parentRouter = fs.readFileSync(path.join(root, 'backend/routes/organization_mutation_workflow.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-department-functions-ui.js'), 'utf8');

for (const source of [schema, service, hierarchy, routes, parentRouter, loader, ui]) {
  new Function(source);
}

assert(migration.includes('CREATE TABLE org_departement_fonctions'));
assert(migration.includes("'Reprise du responsable historique'"));
assert(migration.includes("'chef'"));
assert(schema.includes('CREATE TABLE IF NOT EXISTS org_departement_fonctions'));

for (const type of ['chef', 'premier_adjoint', 'adjoint', 'interimaire', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur']) {
  assert(service.includes(`${type}:`) || service.includes(`'${type}'`), `missing department function ${type}`);
}
assert(service.includes('responsable_poste'));
assert(service.includes('responsable_fonction'));
assert(service.includes('adjoints: deputies'));
assert(service.includes('TEMPORARY_FUNCTION_END_REQUIRED'));
assert(service.includes('FUNCTION_EMPLOYEE_DEPARTMENT_MISMATCH'));
assert(service.includes('ACTIVE_CHIEF_REPLACEMENT_REQUIRED'));
assert(service.includes("type !== 'chef' && type !== 'interimaire'"));

assert(hierarchy.includes('ALLOWED_SUPERVISOR_FUNCTIONS'));
assert(hierarchy.includes('activeFunction(department.id, requestedManagerId)'));
assert(hierarchy.includes('reconcileEffectiveManagers'));
assert(hierarchy.includes("WHEN 'interimaire' THEN 1"));
assert(hierarchy.includes('assertWorkflowGuard(payload, options)'));
assert(hierarchy.indexOf('assertWorkflowGuard(payload, options)') < hierarchy.indexOf('const departmentLabel'));
assert(hierarchy.includes('USE_ORGANIZATION_MUTATION_WORKFLOW'));

assert(routes.includes("router.get('/departements'"));
assert(routes.includes("router.get('/departements/:id/fonctions'"));
assert(routes.includes("router.post('/departements/:id/fonctions'"));
assert(routes.includes("router.delete('/departements/:departmentId/fonctions/:functionId'"));
assert(routes.includes('reconcileEffectiveManagers'));
assert(routes.includes('FUNCTION_EMPLOYEE_IMMUTABLE'));
assert(routes.includes('FUNCTION_TYPE_IMMUTABLE'));
assert(parentRouter.includes("require('./organization_department_functions')"));
assert(parentRouter.includes('router.use(departmentFunctionsRouter)'));

assert(loader.includes('/js/modules/org-department-functions-ui.js'));
assert(ui.includes('Poste non renseigné'));
assert(ui.includes('Premier adjoint'));
assert(ui.includes('Responsable intérimaire'));
assert(ui.includes('data-close-function'));
assert(ui.includes('Référence de décision'));
assert(ui.includes("api('/departements')"));
assert(ui.includes('org-dept-functions-summary'));

console.log('OK - department titles, deputies and interim functions');

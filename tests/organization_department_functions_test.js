const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/033_department_functions.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend/services/organization_department_functions_schema.js'), 'utf8');
const safety = fs.readFileSync(path.join(root, 'backend/services/organization_department_functions_safety.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_department_functions.js'), 'utf8');
const hierarchy = fs.readFileSync(path.join(root, 'backend/services/organization_department_hierarchy.js'), 'utf8');
const mutationBridge = fs.readFileSync(path.join(root, 'backend/services/organization_mutation_department_functions.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_department_functions.js'), 'utf8');
const parentRouter = fs.readFileSync(path.join(root, 'backend/routes/organization_mutation_workflow.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-department-functions-ui.js'), 'utf8');
const mutationUi = fs.readFileSync(path.join(root, 'frontend/js/modules/org-mutation-workflow-ui.js'), 'utf8');

for (const source of [schema, safety, service, hierarchy, mutationBridge, routes, parentRouter, loader, ui, mutationUi]) {
  new Function(source);
}

assert(migration.includes('CREATE TABLE org_departement_fonctions'));
assert(migration.includes("'Reprise du responsable historique'"));
assert(migration.includes("'chef'"));
assert(schema.includes('CREATE TABLE IF NOT EXISTS org_departement_fonctions'));
assert(schema.includes('installDepartmentFunctionSafety'));
assert(safety.includes('db.transaction'));
assert(safety.includes('FUTURE_CHIEF_EFFECTIVE_DATE_REQUIRED'));
assert(safety.includes("type === 'chef' && start > today()"));

for (const type of ['chef', 'premier_adjoint', 'adjoint', 'interimaire', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur']) {
  assert(service.includes(`${type}:`) || service.includes(`'${type}'`), `missing department function ${type}`);
}
assert(service.includes("premier_adjoint: 'Premier adjoint'"));
assert(service.includes("interimaire: 'Responsable intérimaire'"));
assert(service.includes('responsable_poste'));
assert(service.includes('responsable_fonction'));
assert(service.includes('adjoints: deputies'));
assert(service.includes('TEMPORARY_FUNCTION_END_REQUIRED'));
assert(service.includes('FUNCTION_EMPLOYEE_DEPARTMENT_MISMATCH'));
assert(service.includes('ACTIVE_CHIEF_REPLACEMENT_REQUIRED'));
assert(service.includes("type !== 'chef' && type !== 'interimaire'"));

assert(hierarchy.includes('AsyncLocalStorage'));
assert(hierarchy.includes('withRequestedSupervisor'));
assert(hierarchy.includes('requestedSupervisorId'));
assert(hierarchy.includes('ALLOWED_SUPERVISOR_FUNCTIONS'));
assert(hierarchy.includes('activeFunction(department.id, requestedManagerId)'));
assert(hierarchy.includes('reconcileEffectiveManagers'));
assert(hierarchy.includes("WHEN 'interimaire' THEN 1"));
assert(hierarchy.includes('assertWorkflowGuard(payload, options)'));
assert(hierarchy.indexOf('assertWorkflowGuard(payload, options)') < hierarchy.indexOf('const departmentLabel'));
assert(hierarchy.includes('USE_ORGANIZATION_MUTATION_WORKFLOW'));

assert(mutationBridge.includes('installMutationDepartmentFunctions'));
assert(mutationBridge.includes('withRequestedSupervisor'));
assert(mutationBridge.includes('workflow.createDraft ='));
assert(mutationBridge.includes('workflow.approve ='));
assert(mutationBridge.includes('workflow.apply ='));
assert(mutationBridge.includes('workflow.applyDue ='));
assert(mutationBridge.includes("workflow.listMutations({ statut: workflow.STATUS.APPROVED, date_to: today() })"));

assert(routes.includes("router.get('/departements'"));
assert(routes.includes("router.get('/departements/:id/fonctions'"));
assert(routes.includes("router.post('/departements/:id/fonctions'"));
assert(routes.includes("router.delete('/departements/:departmentId/fonctions/:functionId'"));
assert(routes.includes('installMutationDepartmentFunctions'));
assert(routes.includes('reconcileEffectiveManagers'));
assert(routes.includes('FUNCTION_EMPLOYEE_IMMUTABLE'));
assert(routes.includes('FUNCTION_TYPE_IMMUTABLE'));
assert(routes.includes('ACTIVE_CHIEF_REPLACEMENT_REQUIRED'));
assert(routes.includes("fonction_type = 'chef' AND actif = 1"));
assert(parentRouter.includes("require('./organization_department_functions')"));
assert(parentRouter.includes('router.use(departmentFunctionsRouter)'));

assert(loader.includes('/js/modules/org-department-functions-ui.js'));
assert(ui.includes('state.types[row.fonction_type]'));
assert(ui.includes('Object.entries(state.types)'));
assert(ui.includes('Poste non renseigné'));
assert(ui.includes('data-close-function'));
assert(ui.includes('Référence de décision'));
assert(ui.includes("api('/departements')"));
assert(ui.includes('org-dept-functions-summary'));
assert(ui.includes("observe(cards, { childList: true })"));
assert(!ui.includes('subtree: true'));
assert(ui.includes('if (summary.innerHTML !== html)'));

assert(mutationUi.includes('SUPERVISOR_TYPES'));
assert(mutationUi.includes('org-mutation-supervisor'));
assert(mutationUi.includes('Responsable effectif automatique'));
assert(mutationUi.includes('nouveau_sup_id:'));
assert(mutationUi.includes('row?.nouveau_sup_id'));
assert(mutationUi.includes('Array.isArray(dept?.fonctions)'));

console.log('OK - department titles, deputies and interim functions');

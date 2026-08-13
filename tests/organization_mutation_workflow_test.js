const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_mutation_workflow.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_mutation_workflow.js'), 'utf8');
const guard = fs.readFileSync(path.join(root, 'backend/services/organization_mutation_guard.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend/services/organization_mutation_schema.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/032_org_mutation_workflow.sql'), 'utf8');
const permissions = fs.readFileSync(path.join(root, 'backend/services/permissions.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-mutation-workflow-ui.js'), 'utf8');
const agentLock = fs.readFileSync(path.join(root, 'frontend/js/modules/agent-organization-workflow-lock.js'), 'utf8');
const departmentWorkflowIntegration = fs.readFileSync(path.join(root, 'scripts/test_department_function_workflow_mysql.js'), 'utf8');

for (const source of [server, routes, service, guard, schema, permissions, loader, ui, agentLock]) {
  new Function(source);
}

const workflowMount = server.indexOf("validationDiagnostic('organization'), organizationMutationWorkflowRouter");
const integrityMount = server.indexOf("validationDiagnostic('organization'), organizationIntegrityRouter");
const legacyMount = server.indexOf("protectedRoute(requireModule(['org', 'hr'])), orgRouter");
assert(workflowMount >= 0, 'workflow router must be mounted');
assert(integrityMount > workflowMount, 'integrity router must follow workflow router');
assert(legacyMount > integrityMount, 'legacy organization router must be last');
assert(server.includes('organizationMutationWorkflow.applyDue(null)'));
assert(server.includes('ORG mutations échéances'));

assert(routes.includes("router.post('/mutations'"));
assert(routes.includes("router.post('/mutations/:id/soumettre'"));
assert(routes.includes("router.post('/mutations/:id/approuver'"));
assert(routes.includes("router.post('/mutations/:id/refuser'"));
assert(routes.includes("router.post('/mutations/:id/annuler'"));
assert(routes.includes("router.post('/mutations/:id/appliquer'"));
assert(routes.includes("router.put('/:id/superieur'"));
assert(routes.includes('USE_ORGANIZATION_MUTATION_WORKFLOW'));
assert(routes.includes('canReadMutations(req.user)'));
assert(routes.includes('mutation.statut === workflow.STATUS.NEEDS_CORRECTION'));

for (const status of ['brouillon', 'soumis', 'approuve', 'refuse', 'a_corriger', 'effectif', 'annule']) {
  assert(service.includes(`'${status}'`), `missing workflow status ${status}`);
}
assert(service.includes('SELF_APPROVAL_FORBIDDEN'));
assert(service.includes('MUTATION_SNAPSHOT_STALE'));
assert(service.includes('ACTIVE_MUTATION_EXISTS'));
assert(service.includes('snapshotMatches(employee, mutation)'));
assert(service.includes('applyDue(actorUserId = null)'));
assert(!service.includes("hasRole(req.user, 'admin', 'dg')"));

assert(guard.includes('USE_ORGANIZATION_MUTATION_WORKFLOW'));
assert(guard.includes('options.employeeId && options.current'));
assert(guard.includes('!options.allowMutationWorkflow'));

assert(migration.includes("UPDATE employes_mutations SET statut='soumis' WHERE statut='propose'"));
assert(!migration.includes("WHERE statut='annule' AND motif_refus"));
assert(!schema.includes("WHERE statut='annule' AND motif_refus"));
for (const code of ['hr.mutation.create', 'hr.mutation.submit', 'hr.mutation.approve', 'hr.mutation.apply', 'hr.mutation.cancel']) {
  assert(migration.includes(code));
  assert(permissions.includes(code));
}

assert(loader.includes('/js/modules/org-mutation-workflow-ui.js'));
assert(loader.includes('/js/modules/agent-organization-workflow-lock.js'));
assert(ui.includes("api('/mutations/capabilities')"));
assert(ui.includes("api('/mutations')"));
assert(ui.includes('data-action="approve"'));
assert(ui.includes('À corriger'));
assert(ui.includes('Le responsable du département cible sera imposé automatiquement.'));
assert(ui.includes('function activeMutationForEmployee(employeeId)'));
assert(ui.includes('async function openForEmployee(employeeId)'));
assert(ui.includes('function dateInputValue(value)'));
assert(ui.includes("dateInputValue(row?.date_effective || row?.date_effet)"));
assert(ui.includes("document.addEventListener('org:mutation:open'"));
assert(ui.includes('error.code = payload.code'));
assert(ui.includes('error.details = payload.details'));
assert(agentLock.includes("const FIELD_IDS = ['ag-poste', 'ag-departement', 'ag-site', 'ag-superieur']"));
assert(agentLock.includes("control.dataset.workflowLocked = 'true'"));
assert(agentLock.includes('Modification organisationnelle contrôlée'));
assert(agentLock.includes("document.getElementById('org-mutation-open')"));
assert(agentLock.includes("new CustomEvent('org:mutation:open'"));
assert(!agentLock.includes("document.getElementById('org-mutation-new')"));
assert(departmentWorkflowIntegration.includes("process.env.ORG_FUNCTION_NOTIFICATIONS_DISABLED = '1'"));
assert(
  departmentWorkflowIntegration.indexOf("process.env.ORG_FUNCTION_NOTIFICATIONS_DISABLED = '1'")
    < departmentWorkflowIntegration.indexOf("require('../backend/services/department_function_notification_guard')"),
  'integration notification guard must be configured before services load',
);
assert(departmentWorkflowIntegration.includes('async function cleanupFixture(ctx)'));
for (const cleanupTable of ['org_departement_fonction_events', 'org_departement_fonctions', 'org_unites']) {
  assert(departmentWorkflowIntegration.includes(`DELETE FROM ${cleanupTable}`), `missing cleanup for ${cleanupTable}`);
}
assert(departmentWorkflowIntegration.includes('await cleanupFixture(fixtures[index])'));

const { STATUS, createOrganizationMutationWorkflow, snapshotMatches } = require('../backend/services/organization_mutation_workflow');
assert.strictEqual(STATUS.DRAFT, 'brouillon');
assert.strictEqual(STATUS.SUBMITTED, 'soumis');
assert.strictEqual(STATUS.EFFECTIVE, 'effectif');
assert.strictEqual(snapshotMatches(
  { poste: 'Comptable', departement: 'Finance', site: 'Siège', superieur_id: 7 },
  { ancien_poste: 'Comptable', ancien_dept: 'Finance', ancien_site: 'Siège', ancien_sup_id: 7 },
), true);
assert.strictEqual(snapshotMatches(
  { poste: 'Chef comptable', departement: 'Finance', site: 'Siège', superieur_id: 7 },
  { ancien_poste: 'Comptable', ancien_dept: 'Finance', ancien_site: 'Siège', ancien_sup_id: 7 },
), false);

let insertedMutationParams = null;
const employee = {
  id: 3,
  nom: 'Louvouezo Nkonta',
  prenom: 'Dieuveille',
  poste: 'Assistante de direction',
  departement: 'Direction Générale',
  site: 'Brazzaville',
  superieur_id: null,
  superieur_hierarchique: null,
  actif: 1,
  statut_dossier: 'actif',
};
const fakeDb = {
  prepare(sql) {
    if (sql.includes('SELECT * FROM employes')) return { get: () => employee };
    if (sql.includes('SELECT id, statut FROM employes_mutations')) return { get: () => undefined };
    if (sql.includes('INSERT INTO employes_mutations')) return { run: (...params) => { insertedMutationParams = params; return { lastInsertRowid: 99 }; } };
    if (sql.includes('FROM employes_mutations m')) return { get: () => ({ id: 99, employe_id: 3, statut: 'brouillon', date_effet: '2026-07-13T23:00:00.000Z', date_effective: '2026-07-13T23:00:00.000Z' }) };
    throw new Error(`Unexpected SQL in mutation test: ${sql}`);
  },
};
const fakeOrganization = {
  activeDepartmentByLabel: () => ({ id: 1, libelle: 'Direction Générale', responsable_id: 15 }),
  assertManagerActive: () => ({ id: 15, nom: 'Manager', prenom: 'Direction' }),
  assertNoCycle: () => {},
};
const createdDraft = createOrganizationMutationWorkflow(fakeDb, fakeOrganization).createDraft({
  employe_id: 3,
  nouveau_poste: '',
  nouveau_dept: 'Direction Générale',
  nouveau_site: '',
  date_effective: '2026-07-14',
  motif: 'Correction',
}, 1);
assert.strictEqual(insertedMutationParams[5], 'Assistante de direction', 'blank target job must preserve current job');
assert.strictEqual(insertedMutationParams[9], 'Brazzaville', 'blank target site must preserve current site');
assert.strictEqual(createdDraft.date_effective, '2026-07-14', 'civil effective date must not shift with UTC serialization');

console.log('OK - canonical organization mutation workflow');

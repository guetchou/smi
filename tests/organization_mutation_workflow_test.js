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
assert(agentLock.includes("const FIELD_IDS = ['ag-poste', 'ag-departement', 'ag-site', 'ag-superieur']"));
assert(agentLock.includes("control.dataset.workflowLocked = 'true'"));
assert(agentLock.includes('Modification organisationnelle contrôlée'));
assert(agentLock.includes("document.getElementById('org-mutation-open')"));
assert(agentLock.includes("document.getElementById('org-mutation-agent')"));

const { STATUS, snapshotMatches } = require('../backend/services/organization_mutation_workflow');
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

console.log('OK - canonical organization mutation workflow');

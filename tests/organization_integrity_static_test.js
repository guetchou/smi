const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('./organization_assignment_async_test');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_assignment.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'backend/routes/organization_integrity_safe.js'), 'utf8');
const agentBridge = fs.readFileSync(path.join(root, 'frontend/js/modules/agent-organization.js'), 'utf8');

const integrityMount = server.indexOf("validationDiagnostic('organization'), organizationIntegrityRouter");
const legacyMount = server.indexOf("orgRouter);");
assert(integrityMount >= 0 && legacyMount >= 0 && integrityMount < legacyMount);

assert(service.includes('assertNoCycle(employeeId, manager.id)'));
assert(service.includes('assertDepartmentCanDeactivate'));
assert(service.includes('synchronizeDepartmentManager'));
assert(routes.includes("code: 'DEPARTMENT_MANAGER_REQUIRED'"));
assert(routes.includes('organizationSvc.assertDepartmentCanDeactivate(id)'));
assert(routes.includes('organizationSvc.synchronizeDepartmentManager'));
assert(routes.includes('organizationSvc.assertSupervisorChange'));
assert(!agentBridge.includes("method: 'PUT', body: JSON.stringify({ superieur_id"));
assert(!agentBridge.includes('Responsable hiérarchique appliqué automatiquement :'));

console.log('OK - organization integrity static invariants');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'frontend/js/modules/agent-organization.js'), 'utf8');
const safeWrite = fs.readFileSync(path.join(root, 'backend/routes/agents_safe_write.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_assignment.js'), 'utf8');
const integrityRoute = fs.readFileSync(path.join(root, 'backend/routes/organization_integrity_safe.js'), 'utf8');

assert(bridge.includes('installAgentWriteObserver'));
assert(bridge.includes('refreshAfterAgentWrite'));
assert(bridge.includes('loadAgents'));
assert(bridge.includes('loadOrgArbre'));
assert(bridge.includes('syncAgentFields'));
assert(safeWrite.includes('organizationSvc.resolveAgentAssignment'));
assert(safeWrite.includes('department_manager_applied'));
assert(service.includes('DEPARTMENT_MANAGER_REQUIRED'));
assert(service.includes('payload.superieur_id = Number(manager.id)'));
assert(integrityRoute.includes('synchronizeDepartmentManager'));
assert(integrityRoute.includes('agents_synchronises'));

console.log('OK - agent department refresh through central service');

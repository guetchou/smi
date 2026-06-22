const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'frontend/js/modules/agent-organization.js'), 'utf8');
const safeWrite = fs.readFileSync(path.join(root, 'backend/routes/agents_safe_write.js'), 'utf8');

assert(bridge.includes('installAgentWriteObserver'));
assert(bridge.includes('refreshAfterAgentWrite'));
assert(bridge.includes('loadAgents'));
assert(bridge.includes('loadOrgArbre'));
assert(bridge.includes('syncAgentFields'));
assert(safeWrite.includes('resolveDepartmentManager'));
assert(safeWrite.includes('DEPARTMENT_MANAGER_REQUIRED'));
assert(safeWrite.includes('payload.superieur_id = Number(manager.id)'));
assert(safeWrite.includes('department_manager_applied'));

console.log('OK - agent department refresh');

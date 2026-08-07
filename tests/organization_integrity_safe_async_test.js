'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'organization_integrity_safe.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'organization integrity safe route must use backend/db.js');
assert(!source.includes("require('../database')"), 'organization integrity safe route must not use legacy database.js');
assert(!source.includes('.prepare('), 'organization integrity safe route must not use synchronous prepare()');
assert(source.includes('await db.transaction(async tx =>'), 'supervisor change must use async transaction');
assert(source.includes('await tx.execute(`\n        UPDATE employes'), 'supervisor change must write through transaction');
assert(source.includes('async function normalizeMutationHierarchy'), 'mutation hierarchy middleware must be async');
for (const call of ['assertSupervisorChange', 'assertManagerActive', 'synchronizeDepartmentManager', 'assertDepartmentCanDeactivate', 'departmentAgentCount', 'activeDepartmentByLabel', 'assertNoCycle']) {
  assert(source.includes(`await organizationSvc.${call}(`), `organization service call ${call} must be await-compatible`);
}

console.log('organization_integrity_safe_async_test: OK');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'services', 'organization_mutation_workflow.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'organization mutation service must use backend/db.js');
assert(!source.includes("require('../database')"), 'organization mutation service must not use legacy database.js');
assert(!source.includes('.prepare('), 'organization mutation service must not use synchronous prepare()');
for (const fn of ['createDraft', 'updateDraft', 'submit', 'approve', 'refuse', 'cancel', 'apply', 'applyDue']) {
  assert(source.includes(`async function ${fn}(`), `${fn} must be async`);
}
assert(source.includes('await db.transaction(async tx =>'), 'mutation application must use real async transaction');
assert(source.includes('await tx.execute(`UPDATE employes SET'), 'employee mutation must execute through transaction handle');
assert(source.includes('await tx.execute(`UPDATE employes_mutations SET'), 'workflow state must execute through transaction handle');
assert(source.includes('ORG_MUTATION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE'), 'rollback test hook must remain available');

console.log('organization_mutation_service_async_test: OK');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'organization_mutation_workflow.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'organization mutation route must use backend/db.js');
assert(!source.includes("require('../database')"), 'organization mutation route must not use legacy database.js');
assert(!source.includes('.prepare('), 'organization mutation route must not use synchronous prepare()');
assert(source.includes('async function auditTransition'), 'mutation audit must be asynchronous');
assert(source.includes('await db.execute(`\n      INSERT INTO audit_logs'), 'mutation audit must use async execute');
for (const call of ['listMutations', 'getMutation', 'createDraft', 'updateDraft', 'submit', 'approve', 'refuse', 'cancel', 'apply', 'applyDue']) {
  assert(source.includes(`await workflow.${call}(`), `workflow call ${call} must be await-compatible`);
}

console.log('organization_mutation_route_async_test: OK');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'services', 'organization_mutation_workflow.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'organization mutation service must use backend/db.js');
assert(!source.includes("require('../database')"), 'organization mutation service must not use legacy database.js');
assert(!source.includes('.prepare('), 'organization mutation service must not use synchronous prepare()');
assert(source.includes('async function createDraft('));
assert(source.includes('async function approve('));
assert(source.includes('async function apply('));
assert(source.includes('async function applyDue('));
assert(source.includes('await db.transaction(async tx =>'));
assert(source.includes('await tx.execute(`\n        UPDATE employes'));
assert(source.includes('ORG_MUTATION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE'));
assert(source.includes('await workflow') === false, 'service must not accidentally reference route-level workflow variable');

console.log('organization_mutation_service_async_test: OK');

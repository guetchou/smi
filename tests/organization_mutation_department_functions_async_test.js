const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend/services/organization_mutation_department_functions.js'),
  'utf8',
);

new Function(source);

assert(source.includes('workflow.applyDue = async function applyDueWithDepartmentFunctions'));
assert(source.includes('const rows = await workflow.listMutations('));
assert(source.includes('const mutation = await workflow.apply(row.id, actorUserId)'));

for (const fn of ['updateDraftWithDepartmentFunction', 'submitWithDepartmentFunction', 'approveWithDepartmentFunction', 'applyWithDepartmentFunction']) {
  assert(source.includes(`async function ${fn}`), `${fn} must remain async`);
}

const awaitedLookups = source.match(/const current = await workflow\.getMutation\(id\);/g) || [];
assert.strictEqual(awaitedLookups.length, 4, 'all mutation wrappers must await getMutation');
assert(!source.includes('const rows = workflow.listMutations('), 'scheduler must not treat listMutations Promise as an array');
assert(!source.includes('const mutation = workflow.apply(row.id, actorUserId)'), 'scheduler must await mutation application');

console.log('OK - organization mutation department wrappers await async workflow');

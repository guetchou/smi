'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const route = read('backend/routes/agent_parapheur_required_safe.js');
const leave = read('backend/services/leave_workflow.js');
const advance = read('backend/services/salary_advance_workflow.js');

assert(route.includes("require('../db')"), 'route must use backend/db.js');
assert(!route.includes("require('../database')"), 'route must not use legacy database.js');
assert(!route.includes('.prepare('), 'route must not use synchronous prepare()');
assert(route.includes("require('../services/leave_workflow')"), 'leave service not mounted');
assert(route.includes("require('../services/salary_advance_workflow')"), 'advance service not mounted');

for (const [name, source] of [['leave', leave], ['advance', advance]]) {
  assert(source.includes("require('../db')"), `${name} workflow must use backend/db.js`);
  assert(!source.includes("require('../database')"), `${name} workflow must not use legacy database.js`);
  assert(!source.includes('.prepare('), `${name} workflow must not use synchronous prepare()`);
  assert(!source.includes('db.transaction(() =>'), `${name} workflow must not use pseudo transaction`);
  assert(source.includes('await dbc.transaction(async (tx) =>'), `${name} workflow must use async transaction`);
  assert(source.includes('creerEntreeParapheurDansTransaction'), `${name} workflow must create parapheur in transaction`);
  assert(source.includes('await notifierParapheurTarget'), `${name} workflow must notify after commit`);
}

assert(leave.includes('YEAR(date_debut)'), 'leave balance must use MySQL YEAR()');
assert(leave.includes('failAfterLeave'), 'leave rollback hook missing');
assert(advance.includes('FOR UPDATE'), 'advance row must be locked');
assert(advance.includes('failAfterStatus'), 'advance rollback hook missing');

console.log('agent_decision_atomicity_test: OK');

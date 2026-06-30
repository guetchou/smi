'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', name), 'utf8');
const entry = read('parapheur_source_sync_safe.js');
const leave = read('parapheur_leave_source_sync_safe.js');
const other = read('parapheur_source_sync_other.js');

assert(entry.includes("require('./parapheur_leave_source_sync_safe')"), 'entry router must mount leave decisions');
assert(entry.indexOf('router.use(leaveRouter)') < entry.indexOf('router.use(otherRouter)'), 'leave router must run before other source decisions');

assert(leave.includes("require('../db')"), 'leave decision route must use async db adapter');
assert(leave.includes('await db.transaction(async (tx) =>'), 'leave decision must run in one transaction');
assert(leave.includes('FOR UPDATE'), 'leave decision flow must lock rows on MySQL');
assert(leave.includes('leave_transition_workflow'), 'leave decisions must use the shared workflow service');
assert(leave.indexOf('INSERT INTO notif_messages') > leave.indexOf('await db.transaction(async (tx) =>'), 'leave notification must run after transaction');

assert(other.includes("require('../db')"), 'other decision route must use async db adapter');
assert(other.includes("require('../services/numeric')"), 'other decision route must reuse shared numeric parser');
assert(other.includes('await db.transaction(async (tx) =>'), 'other decisions must run in one transaction');
assert(other.includes('FOR UPDATE'), 'other decision flow must lock rows on MySQL');
assert(other.includes('isBlockingSourceSync'), 'unsafe source sync skips must be blocked');
assert(other.includes('source_sync: e.source_sync'), 'blocked sync details must be returned');

console.log('parapheur_decision_atomicity_test: OK');

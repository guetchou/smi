'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'parapheur_source_sync_safe.js'), 'utf8');

assert(source.includes("require('../db')"), 'decision route must use async db adapter');
assert(source.includes("require('../services/numeric')"), 'decision route must reuse shared numeric parser');
assert(source.includes('await db.transaction(async (tx) =>'), 'decision must run in one transaction');
assert(source.includes('FOR UPDATE'), 'decision flow must lock rows on MySQL');
assert(source.includes('isBlockingSourceSync'), 'unsafe source sync skips must be blocked');
assert(source.includes('source_sync: e.source_sync'), 'blocked sync details must be returned');
assert(source.indexOf('await notif(result.p.initiateur_id') > source.indexOf('await db.transaction(async (tx) =>'), 'notification must run after transaction');

console.log('parapheur_decision_atomicity_test: OK');

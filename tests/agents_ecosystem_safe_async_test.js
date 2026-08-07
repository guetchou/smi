'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'agents_ecosystem_safe.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"));
assert(!source.includes("require('../database')"));
assert(!source.includes('.prepare('));
assert(source.includes('async function agentOr404'));
assert(source.includes('async function congeSolde'));
assert(source.includes('async function setLeaveCounters'));
assert(source.includes('async function hsRates'));
assert(source.includes('await db.transaction(async tx =>'));
assert(source.includes("router.post('/:id/avances/:aid/decaisser', async"));
assert(source.includes("router.post('/:id/conges', async"));
assert(source.includes("router.put('/:id/conges/:cid/approuver', async"));
assert(source.includes("router.put('/:id/conges/:cid/annuler', async"));
assert(source.includes("router.post('/:id/sanctions', async"));
assert(source.includes("router.post('/:id/heures-sup', async"));
assert(source.includes('cash_ledger'));
assert(source.includes('cashbox_balances'));

console.log('agents_ecosystem_safe_async_test: OK');

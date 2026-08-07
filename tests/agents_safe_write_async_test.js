'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'agents_safe_write.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'agents safe write must use backend/db.js');
assert(!source.includes("require('../database')"), 'agents safe write must not use legacy database.js');
assert(!source.includes('.prepare('), 'agents safe write must not use synchronous prepare()');
assert(source.includes('async function nextMatricule()'));
assert(source.includes('const payload = await safeCreatePayload(req.body || {})'));
assert(source.includes('await organizationSvc.resolveAgentAssignment(payload)'));
assert(source.includes('await organizationSvc.resolveAgentAssignment(payload, { employeeId: id, current })'));
assert(source.includes('const r = await db.execute(sql, values)'));
assert(source.includes('const agentId = r.insertId'));
assert(source.includes("router.use(agentParapheurRequiredRouter)"));
assert(source.includes("router.use(offboardingParapheurRequiredRouter)"));
assert(source.includes("router.use(agentsEcosystemSafeRouter)"));

console.log('agents_safe_write_async_test: OK');

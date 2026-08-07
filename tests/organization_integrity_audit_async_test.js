'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'backend/services/organization_integrity_audit.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'backend/routes/organization_integrity_audit.js'), 'utf8');

new Function(service);
new Function(route);

assert(service.includes("require('../db')"), 'integrity audit must use backend/db.js');
assert(!service.includes("require('../database')"), 'integrity audit must not use legacy database.js directly');
assert(!service.includes('.prepare('), 'integrity audit must not use synchronous prepare()');
assert(service.includes('async function scanIntegrity()'), 'integrity scan must be async');
assert(service.includes('async function repairIntegrity('), 'integrity repair must be async');
assert(service.includes('await db.transaction(async tx =>'), 'integrity repair must use a real async transaction');
assert(service.includes('ORG_INTEGRITY_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE'), 'integrity repair must expose the rollback test hook');
assert(route.includes('await integrityAudit.scanIntegrity()'), 'integrity route must await scan');
assert(route.includes('await integrityAudit.repairIntegrity({'), 'integrity route must await repair');

console.log('organization_integrity_audit_async_test: OK');

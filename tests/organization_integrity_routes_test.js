const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const parentRouter = fs.readFileSync(path.join(root, 'backend/routes/organization_integrity_safe.js'), 'utf8');
const auditRouter = fs.readFileSync(path.join(root, 'backend/routes/organization_integrity_audit.js'), 'utf8');
const auditService = fs.readFileSync(path.join(root, 'backend/services/organization_integrity_audit.js'), 'utf8');

new Function(parentRouter);
new Function(auditRouter);
new Function(auditService);

assert(parentRouter.includes("require('./organization_integrity_audit')"));
assert(parentRouter.includes('router.use(integrityAuditRouter)'));
assert(auditRouter.includes("router.get('/anomalies'"));
assert(auditRouter.includes("router.post('/reparer-integrite'"));
assert(auditRouter.includes("expected_confirmation: 'REPARER'"));
assert(auditRouter.includes('req.body?.dry_run !== false'));
assert(auditService.includes('CONCURRENT_CHANGE_DETECTED'));
assert(auditService.includes("'organization_integrity_repair'"));
assert(auditService.includes("'repair_run'"));
assert(auditService.includes('projected_cycles'));

console.log('OK - organization integrity API contract');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const integration = fs.readFileSync(path.join(root, 'backend', 'services', 'dolibarr_integration.js'), 'utf8');
const legacyOperations = fs.readFileSync(path.join(root, 'backend', 'routes', 'operations.js'), 'utf8');
const canonicalOperations = fs.readFileSync(path.join(root, 'backend', 'routes', 'operations_parapheur_required_safe.js'), 'utf8');
const receiptWorkflow = fs.readFileSync(path.join(root, 'backend', 'routes', 'cash_receipt_workflow_router.js'), 'utf8');

assert(integration.includes('async function enqueueOperationSyncIfEnabled'));
assert(integration.includes('rawEnvEnabled(env)'));
assert(/const plan = buildOperationSyncPlan\(operation\);[\s\S]*?service\.enqueueSync\(plan\.localType, plan\.localId, plan\.jobType, actor\)/m.test(integration));
assert(!integration.includes('createDolibarrClient({'), 'Local enqueue must not build a Dolibarr HTTP client');

for (const route of [legacyOperations, canonicalOperations]) {
  assert(route.includes("const { enqueueOperationSyncIfEnabled } = require('../services/dolibarr_integration');"));
  assert(route.includes('async function enqueueDolibarrOperation(operation, actor)'));
  assert(route.includes('dolibarr_enqueue_skipped'));
  assert(route.includes('await enqueueDolibarrOperation('));
  assert(!route.includes('createDolibarrClient'));
  assert(!route.includes('DOLAPIKEY'));
  assert(!route.includes('DOLIBARR_API_KEY'));
}

assert(/attemptAutomaticAccountingForOperation\([\s\S]*?\);[\s\S]*?await enqueueDolibarrOperation\(operationWithAccountingStatus, req\.user\);/m.test(legacyOperations));
assert(/const paidOperation = await db\.queryOne\('SELECT \* FROM operations WHERE id = \?', \[op\.id\]\);[\s\S]*?await enqueueDolibarrOperation\(paidOperation, req\.user\);/m.test(legacyOperations));
assert(/operation\.statut === 'valide'[\s\S]*?attemptAutomaticAccountingForOperation\([\s\S]*?\);[\s\S]*?await enqueueDolibarrOperation\(operation, req\.user\);/m.test(canonicalOperations));
assert(/const paidOperation = await db\.queryOne\('SELECT \* FROM operations WHERE id = \?', \[operation\.id\]\);[\s\S]*?await enqueueDolibarrOperation\(paidOperation \|\| operation, req\.user\);/m.test(canonicalOperations));
assert(receiptWorkflow.includes("const { enqueueOperationSyncIfEnabled } = require('../services/dolibarr_integration');"));
assert(receiptWorkflow.includes('async function enqueueDolibarrOperation(operation, actor)'));
assert(/if \(result\.confirmed\) \{[\s\S]*?await enqueueDolibarrOperation\(result\.operation, req\.user\);/m.test(receiptWorkflow));
assert(!receiptWorkflow.includes('createDolibarrClient'));
assert(!receiptWorkflow.includes('DOLIBARR_API_KEY'));

console.log('dolibarr_operation_enqueue_test: OK');

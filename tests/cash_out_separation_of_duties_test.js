const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(
  path.join(root, 'backend/services/cash-out-separation.js'),
  'utf8',
);
const safeRouterSource = fs.readFileSync(
  path.join(root, 'backend/routes/operations_parapheur_required_safe.js'),
  'utf8',
);
const legacyRouterSource = fs.readFileSync(
  path.join(root, 'backend/routes/operations.js'),
  'utf8',
);
const serverSource = fs.readFileSync(
  path.join(root, 'backend/server.js'),
  'utf8',
);

new Function(serviceSource);
new Function(safeRouterSource);

function loadService() {
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(module,exports){${serviceSource}\n})(module,module.exports);`,
    { module },
  );
  return module.exports;
}

function expectCode(action, code) {
  try {
    action();
    assert.fail(`Erreur ${code} attendue`);
  } catch (error) {
    assert.strictEqual(error.code, code, error.message);
  }
}

const service = loadService();

expectCode(
  () => service.assertApprovalSeparation({ created_by: 7, submitted_by: 8 }, 7),
  'CASH_OUT_SELF_APPROVAL_FORBIDDEN',
);
expectCode(
  () => service.assertApprovalSeparation({ created_by: 7, submitted_by: 8 }, 8),
  'CASH_OUT_SELF_APPROVAL_FORBIDDEN',
);
expectCode(
  () => service.assertApprovalSeparation({ created_by: 7, submitted_by: 8 }, null),
  'CASH_OUT_APPROVER_REQUIRED',
);
assert.strictEqual(
  service.assertApprovalSeparation({ created_by: 7, submitted_by: 8 }, 9),
  true,
);

assert(safeRouterSource.includes("require('../services/cash-out-separation')"));
assert(safeRouterSource.includes("router.put('/:id/valider', requireApprovalSeparation)"));
assert(safeRouterSource.includes("'dec_auto_validation_bloquee'"));
assert(safeRouterSource.includes('assertApprovalSeparation(operation, req.user?.id)'));
assert(safeRouterSource.includes('if (error instanceof CashOutSeparationError)'));
assert(safeRouterSource.includes('code: error.code'));
assert(!safeRouterSource.includes('dec_soumis_auto_valide'));
assert(!safeRouterSource.includes('auto_validated: true'));

assert(safeRouterSource.includes("router.put('/:id/soumettre', requireWritePermission)"));

assert(legacyRouterSource.includes("router.put('/:id/valider'"));
assert(
  serverSource.indexOf('operationsParapheurRequiredRouter')
    < serverSource.indexOf('operationsRouter'),
);

console.log('OK - cash-out submitter and creator cannot approve their own disbursement');

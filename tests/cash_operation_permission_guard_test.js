const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(root, 'backend/services/cash-operation-permissions.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(root, 'backend/routes/operations_parapheur_required_safe.js'), 'utf8');
const legacySource = fs.readFileSync(path.join(root, 'backend/routes/operations.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');

new Function(serviceSource);
new Function(routerSource);

async function loadService({ permissionResult = false, roleResult = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  const fakeRequire = request => {
    if (request === './permissions') {
      return {
        can: async (_user, permission, context) => {
          calls.push({ permission, context });
          await Promise.resolve();
          return permissionResult;
        },
      };
    }
    if (request === '../routes/auth') {
      return { hasRole: () => roleResult };
    }
    throw new Error(`Unexpected require: ${request}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports){${serviceSource}\n})(fakeRequire,module,module.exports);`,
    { fakeRequire, module },
  );
  return { service: module.exports, calls };
}

(async () => {
  const denied = await loadService();
  assert.strictEqual(await denied.service.canWriteOperation({ id: 9 }, { amount: 700000 }), false);
  assert.strictEqual(await denied.service.canPayCashOut({ id: 9 }, { amount: 700000 }), false);
  assert.deepStrictEqual(
    denied.calls.map(call => call.permission),
    ['cash.out.create', 'cash.out.pay'],
  );
  assert.strictEqual(denied.calls[0].context.amount, 700000);

  const directPermission = await loadService({ permissionResult: true });
  assert.strictEqual(await directPermission.service.canWriteOperation({ id: 4 }, { amount: 1 }), true);
  assert.strictEqual(await directPermission.service.canPayCashOut({ id: 4 }, { amount: 1 }), true);

  const legacyRole = await loadService({ roleResult: true });
  assert.strictEqual(await legacyRole.service.canWriteOperation({ id: 2 }), true);
  assert.strictEqual(await legacyRole.service.canPayCashOut({ id: 2 }), true);

  assert(serviceSource.includes("await can(user, 'cash.out.create', context)"));
  assert(serviceSource.includes("await can(user, 'cash.out.pay', context)"));
  assert(routerSource.includes("require('../services/cash-operation-permissions')"));
  assert(routerSource.includes("router.post('/', requireWritePermission)"));
  assert(routerSource.includes("router.put('/:id', requireWritePermission)"));
  assert(routerSource.includes("router.put('/:id/soumettre', requireWritePermission)"));
  assert(routerSource.includes("router.put('/:id/resoumettre', requireWritePermission)"));
  assert(routerSource.includes("router.post('/:id/payer', requirePayPermission)"));
  assert(routerSource.includes('await canWriteOperation(req.user'));
  assert(routerSource.includes('await canPayCashOut(req.user'));
  assert(!routerSource.includes('function canWrite(user)'));
  assert(!routerSource.includes('async function canPay(user)'));
  assert(
    routerSource.indexOf("router.post('/', requireWritePermission)")
      < routerSource.indexOf("router.post('/', async"),
  );
  assert(
    serverSource.indexOf('operationsParapheurRequiredRouter')
      < serverSource.indexOf('operationsRouter'),
  );
  assert(legacySource.includes("await can(user, 'cash.out.pay')"));
  assert(legacySource.includes("await can(user, 'cash.out.create')"));

  console.log('OK - async cash-out permissions guard canonical and legacy routes');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

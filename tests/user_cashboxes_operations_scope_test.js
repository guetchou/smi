const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'backend', 'routes', 'operations.js');
const src = fs.readFileSync(file, 'utf8');

function includes(fragment, message) {
  assert(src.includes(fragment), message);
}

includes("function hasGlobalCashboxAccess(user)", "global cashbox access helper missing");
includes("return hasRole(user, 'admin', 'dg', 'finance');", "global finance roles must remain unrestricted");
includes("function hasScopedCashboxAccess(user)", "cashier scoping helper missing");
includes("hasRole(user, 'caissier')", "cashier role must be explicitly scoped");
includes("SELECT caisse_id FROM user_cashboxes", "user_cashboxes assignments must be read server-side");
includes("const flag = write ? 'can_write' : 'can_read';", "read/write assignment flags must be distinct");
includes("function appendCashboxScope(where, params, allowedIds)", "SQL scope helper missing");
includes("AND o.position_id IN", "destination position must be scoped");
includes("o.position_source_id IS NULL OR o.position_source_id IN", "transfer source must be scoped too");

const positionsRoute = src.slice(
  src.indexOf("router.get('/positions'"),
  src.indexOf("// ─── GET /next-ref")
);
includes("const allowedIds = await assignedCashboxIds(req.user, { write: false });", "positions endpoint must load readable assignments");
assert(positionsRoute.includes("visiblePositions"), "positions response must filter unassigned cashboxes");

const listRoute = src.slice(
  src.indexOf("router.get('/', async (req, res) =>"),
  src.indexOf("// ─── POST / — Créer une opération")
);
assert(listRoute.includes("appendCashboxScope(where, params, allowedCashboxIds)"), "operation list must apply server-side cashbox scope");

const createRoute = src.slice(
  src.indexOf("router.post('/', async (req, res) =>"),
  src.indexOf("// ─── PUT /:id — Modifier")
);
assert(createRoute.includes("canAccessCashbox(req.user, position_id, { write: true })"), "operation creation must check destination write access");
assert(createRoute.includes("canAccessCashbox(req.user, position_source_id, { write: true })"), "internal transfer creation must check source write access");

const updateRoute = src.slice(
  src.indexOf("router.put('/:id', async (req, res) =>"),
  src.indexOf("// ─── DELETE /:id")
);
assert(updateRoute.includes("requireOperationCashboxAccess(req.user, op, res, { write: true })"), "existing operation update must check current cashbox access");
assert(updateRoute.includes("canAccessCashbox(req.user, position_id, { write: true })"), "operation update must check target destination");
assert(updateRoute.includes("canAccessCashbox(req.user, position_source_id, { write: true })"), "operation update must check target source");

const pendingCount = src.slice(
  src.indexOf("router.get('/decaissements/pending-count'"),
  src.indexOf("router.get('/decaissements/pending'")
);
assert(pendingCount.includes("appendCashboxScope(countWhere, countParams, allowedCashboxIds)"), "pending counter must be cashbox-scoped");

const pending = src.slice(
  src.indexOf("router.get('/decaissements/pending'"),
  src.indexOf("// ─── PUT /:id/soumettre")
);
assert(pending.includes("appendCashboxScope(pendingWhere, filterParams, allowedCashboxIds)"), "pending list must be cashbox-scoped");

const history = src.slice(
  src.indexOf("router.get('/:id/historique'"),
  src.indexOf("// ─── PUT /:id/annuler")
);
assert(history.includes("requireOperationCashboxAccess(req.user, op, res, { write: false })"), "history must not leak unassigned cashbox operations");

const importRoute = src.slice(
  src.indexOf("router.post('/import'"),
  src.indexOf("module.exports = router")
);
assert(importRoute.includes("assignedCashboxIds(req.user, { write: true })"), "import must restrict position referential to writable cashboxes");
assert(importRoute.includes("allPositions.filter"), "import must filter out unassigned positions");

console.log('user_cashboxes_operations_scope_test: OK');

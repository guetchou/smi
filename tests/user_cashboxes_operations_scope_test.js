const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'backend', 'routes', 'operations.js');
const src = fs.readFileSync(file, 'utf8');
/* La classification des rôles a quitté la route pour services/perimetre-caisse.js,
   afin d'être nommée en trois groupes plutôt que déduite d'un « else » implicite,
   et d'être lisible par le script d'audit. La garde suit la règle là où elle vit :
   ce qui relève du périmètre SQL reste vérifié dans la route. */
const perimetre = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'services', 'perimetre-caisse.js'), 'utf8',
);

function includes(fragment, message) {
  assert(src.includes(fragment), message);
}

assert(
  /ROLES_GLOBAUX\s*=\s*\[[^\]]*\]/.test(perimetre),
  "la liste des rôles globaux doit être nommée dans services/perimetre-caisse.js"
);
/* Ces deux exigences portaient sur le texte exact d'une instruction, point-virgule
   compris. Reformater la ligne les faisait rougir sur du code juste — et une garde
   qui accuse du code juste cesse d'être lue. C'est ce qui vient d'arriver au
   comptage du badge, dont l'ancre exigeait « , criteres.params); ».
   On épingle donc la règle : quels rôles échappent au périmètre, et que les deux
   droits d'affectation soient distingués. La preuve de comportement, elle, vit
   dans scripts/test_perimetre_caisse_isolated.js, qui interroge l'API. */
const global = perimetre.match(/ROLES_GLOBAUX\s*=\s*\[[^\]]*\]/);
assert(global, "la liste des rôles globaux doit exister");
for (const role of ['admin', 'dg', 'finance']) {
  assert(
    new RegExp("'" + role + "'").test(global[0]),
    `le rôle ${role} doit échapper au périmètre caisse`
  );
}
assert(
  !/'caissier'/.test(global[0]),
  "le caissier ne doit pas figurer parmi les rôles non restreints"
);
assert(
  /ROLES_SOUMIS_A_AFFECTATION\s*=\s*\[[^\]]*\]/.test(perimetre),
  "la liste des rôles soumis à affectation doit être nommée"
);
assert(
  /ROLES_EN_TRANSITION\s*=\s*\[[^\]]*\]/.test(perimetre),
  "les rôles en transition doivent être nommés, et non laissés à une retombée implicite"
);
assert(
  /ROLES_SOUMIS_A_AFFECTATION\s*=\s*\[[^\]]*'caissier'/.test(perimetre),
  "le caissier doit rester soumis au périmètre"
);
includes("SELECT caisse_id FROM user_cashboxes", "user_cashboxes assignments must be read server-side");
const affectations = src.match(/async function assignedCashboxIds\([\s\S]{0,600}?\n\}/);
assert(affectations, "assignment reader missing");
assert(
  /can_write/.test(affectations[0]) && /can_read/.test(affectations[0]),
  "la lecture des affectations doit distinguer le droit de lire du droit d'écrire"
);
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

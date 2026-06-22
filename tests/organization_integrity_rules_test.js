const assert = require('assert');
const { createsCycleFromMap } = require('../backend/services/organization_assignment');

const hierarchy = new Map([
  [1, null],
  [2, 1],
  [3, 2],
  [4, 2],
]);

assert.strictEqual(createsCycleFromMap(1, 3, hierarchy), true);
assert.strictEqual(createsCycleFromMap(4, 1, hierarchy), false);
assert.strictEqual(createsCycleFromMap(2, 2, hierarchy), true);
assert.strictEqual(createsCycleFromMap(3, null, hierarchy), false);

const overrides = new Map([[3, null]]);
assert.strictEqual(createsCycleFromMap(2, 3, hierarchy, overrides), false);

const closedLoop = new Map([[1, 2], [2, 1]]);
assert.strictEqual(createsCycleFromMap(3, 1, closedLoop), true);

console.log('OK - organization hierarchy rules');

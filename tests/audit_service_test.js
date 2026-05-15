const assert = require('assert');
const { createAuditLogger, serializeDetails } = require('../backend/services/audit');

const calls = [];
const fakeDb = {
  prepare(sql) {
    calls.push({ type: 'prepare', sql });
    return {
      run(...args) {
        calls.push({ type: 'run', args });
      },
    };
  },
};

assert.strictEqual(serializeDetails(null), null);
assert.strictEqual(serializeDetails(undefined), null);
assert.strictEqual(serializeDetails(''), null);
assert.strictEqual(serializeDetails('texte'), 'texte');
assert.strictEqual(serializeDetails({ a: 1 }), '{"a":1}');

const audit = createAuditLogger(fakeDb);
assert.strictEqual(
  audit.logAudit({
    tableName: 'periodes_paie',
    recordId: 12,
    action: 'valider_dg',
    details: { mois: 1, annee: 2026 },
    userId: 3,
  }),
  true
);

const scoped = audit.createScopedAudit('employes_sanctions');
assert.strictEqual(scoped(7, 'clore', null, 2), true);
assert.strictEqual(audit.logAudit({ tableName: '', action: 'noop' }), false);

assert.strictEqual(calls.filter(c => c.type === 'prepare').length, 1);
assert.deepStrictEqual(calls.filter(c => c.type === 'run')[0].args, [
  'periodes_paie',
  12,
  'valider_dg',
  '{"mois":1,"annee":2026}',
  3,
]);
assert.deepStrictEqual(calls.filter(c => c.type === 'run')[1].args, [
  'employes_sanctions',
  7,
  'clore',
  null,
  2,
]);

console.log('audit_service_test OK');

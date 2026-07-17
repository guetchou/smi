'use strict';

const assert = require('assert');
const {
  calculateContractRemuneration,
  calculateContractEndDate,
  validatePayrollRules,
} = require('../backend/services/contract_remuneration');

const components = [
  { code: 'BASE', label: 'Salaire de base', category: 'salaire_base', amount: 130000, socialSubject: true, taxSubject: true },
  { code: 'TRANSPORT', label: 'Transport', category: 'indemnite', amount: 20000, socialSubject: false, taxSubject: false },
];

const incomplete = calculateContractRemuneration({ components });
assert.strictEqual(incomplete.grossTotal, 150000);
assert.strictEqual(incomplete.socialBase, 130000);
assert.strictEqual(incomplete.employeeSocial, null);
assert.strictEqual(incomplete.incomeTax, null);
assert.strictEqual(incomplete.netPayable, null);
assert.deepStrictEqual(incomplete.missingInputs, ['regles_sociales_publiees', 'bareme_fiscal_publie']);

const calculated = calculateContractRemuneration({
  components,
  employeeTaxProfile: { maritalStatus: 'marie', dependents: 2, fiscalParts: 2 },
  rules: {
    social: { employeeRate: 4, employerRate: 8 },
    tax: {
      mode: 'progressive',
      deductEmployeeSocial: true,
      divideByFiscalParts: true,
      requiredPersonalFields: ['maritalStatus', 'dependents', 'fiscalParts'],
      brackets: [
        { from: 0, to: 50000, rate: 0 },
        { from: 50000, to: null, rate: 10 },
      ],
    },
  },
});
assert.strictEqual(calculated.status, 'calcule');
assert.strictEqual(calculated.grossTotal, 150000);
assert.strictEqual(calculated.socialBase, 130000);
assert.strictEqual(calculated.employeeSocial, 5200);
assert.strictEqual(calculated.employerSocial, 10400);
assert.strictEqual(calculated.fiscalBase, 124800);
assert.strictEqual(calculated.incomeTax, 2480);
assert.strictEqual(calculated.netPayable, 142320);

const fiscalTransport = calculateContractRemuneration({
  components: components.map(item => item.code === 'TRANSPORT' ? { ...item, taxSubject: true } : item),
  employeeTaxProfile: { fiscalParts: 1 },
  rules: {
    social: { employeeRate: 0, employerRate: 0 },
    tax: { mode: 'progressive', brackets: [{ from: 0, to: null, rate: 10 }] },
  },
});
assert.strictEqual(fiscalTransport.socialBase, 130000, 'Exoneration sociale distincte');
assert.strictEqual(fiscalTransport.fiscalBase, 150000, 'Soumission fiscale independante');

assert.throws(() => calculateContractRemuneration({
  components: [components[0], { ...components[0] }],
}), /code de rubrique duplique/);
assert.throws(() => calculateContractRemuneration({
  components,
  employeeTaxProfile: { fiscalParts: 1 },
  rules: {
    social: { employeeRate: 0, employerRate: 0 },
    tax: {
      mode: 'progressive',
      brackets: [
        { from: 0, to: 100000, rate: 5 },
        { from: 50000, to: null, rate: 10 },
      ],
    },
  },
}), /Tranches fiscales chevauchantes/);
assert.throws(() => calculateContractRemuneration({
  components: [
    components[0],
    { code: 'RETENUE', label: 'Retenue', category: 'retenue', amount: 200000 },
  ],
  employeeTaxProfile: { fiscalParts: 1 },
  rules: {
    social: { employeeRate: 0, employerRate: 0 },
    tax: { mode: 'progressive', brackets: [{ from: 0, to: null, rate: 0 }] },
  },
}), /retenues ne peuvent pas depasser/);

assert.strictEqual(calculateContractEndDate('2026-07-02', 6, 'mois', 'exclusive'), '2027-01-02');
assert.strictEqual(calculateContractEndDate('2026-07-02', 6, 'mois', 'inclusive'), '2027-01-01');
assert.strictEqual(calculateContractEndDate('2024-02-29', 1, 'annee', 'exclusive'), '2025-02-28');
assert.throws(() => calculateContractEndDate('2026-07-02', 6, 'mois'), /convention/);
assert.throws(() => calculateContractEndDate('2026-02-31', 1, 'mois', 'exclusive'), /date_debut invalide/);

assert.deepStrictEqual(validatePayrollRules(
  { employeeRate: 4, employerRate: 8 },
  { mode: 'progressive', brackets: [{ from: 0, to: null, rate: 10 }] },
), []);
assert(validatePayrollRules(
  { employeeRate: 101, employerRate: -1 },
  { mode: 'progressive', brackets: [{ from: 0, to: 100000, rate: 5 }, { from: 50000, to: null, rate: 10 }] },
).length >= 3);

console.log('contract_remuneration_test: OK');

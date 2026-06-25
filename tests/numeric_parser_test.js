'use strict';

const assert = require('assert');
const { parseAmount, normalizeNumericFieldsInPlace } = require('../backend/services/numeric');

assert.strictEqual(parseAmount(500000), 500000);
assert.strictEqual(parseAmount('500000'), 500000);
assert.strictEqual(parseAmount('500 000'), 500000);
assert.strictEqual(parseAmount('500000 FCFA'), 500000);
assert.strictEqual(parseAmount('1.000.000'), 1000000);
assert.strictEqual(parseAmount('1,000,000'), 1000000);
assert.strictEqual(parseAmount('1 234 567,89'), 1234567.89);
assert.strictEqual(parseAmount('1,234,567.89'), 1234567.89);
assert.strictEqual(parseAmount('1.234.567,89'), 1234567.89);
assert.strictEqual(parseAmount('500,5'), 500.5);
assert.strictEqual(parseAmount('500.50'), 500.5);
assert.strictEqual(parseAmount('', 0), 0);
assert(Number.isNaN(parseAmount('12abc34', NaN)));
assert(Number.isNaN(parseAmount('1 2 3x', NaN)));
assert(Number.isNaN(parseAmount('1,23,45', NaN)));
assert(Number.isNaN(parseAmount('100000000000000', NaN)));

const body = {
  montant: '500 000 FCFA',
  recette: '1.000.000',
  depense: '',
  cash_receipt_attachment_threshold: '250 000',
  libelle: 'Cotisation client',
};
normalizeNumericFieldsInPlace(body);
assert.strictEqual(body.montant, 500000);
assert.strictEqual(body.recette, 1000000);
assert.strictEqual(body.depense, 0);
assert.strictEqual(body.cash_receipt_attachment_threshold, 250000);
assert.strictEqual(body.libelle, 'Cotisation client');

console.log('numeric_parser_test: OK');

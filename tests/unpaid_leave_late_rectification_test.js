'use strict';

const assert = require('assert');
const {
  monthsBetween,
} = require(
  '../backend/services/unpaid_leave_late_rectification'
);

assert.deepStrictEqual(
  monthsBetween('2026-07-05', '2026-07-10'),
  [
    { month: 7, year: 2026, key: '2026-07' },
  ],
);

assert.deepStrictEqual(
  monthsBetween('2026-12-29', '2027-02-02'),
  [
    { month: 12, year: 2026, key: '2026-12' },
    { month: 1, year: 2027, key: '2027-01' },
    { month: 2, year: 2027, key: '2027-02' },
  ],
);

assert.deepStrictEqual(
  monthsBetween('2026-08-10', '2026-08-01'),
  [],
);

console.log(
  'unpaid_leave_late_rectification_test: OK'
);

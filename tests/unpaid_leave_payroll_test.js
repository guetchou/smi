'use strict';

const assert = require('assert');
const {
  intersectDates,
  monthBounds,
  normalizeSqlDate,
  roundMoney,
} = require('../backend/services/unpaid_leave_payroll');

assert.deepStrictEqual(
  monthBounds(2, 2028),
  { start: '2028-02-01', end: '2028-02-29' },
);

assert.deepStrictEqual(
  monthBounds(2, 2027),
  { start: '2027-02-01', end: '2027-02-28' },
);

assert.deepStrictEqual(
  intersectDates(
    '2026-06-28',
    '2026-07-04',
    '2026-07-01',
    '2026-07-31',
  ),
  { start: '2026-07-01', end: '2026-07-04' },
);

assert.strictEqual(
  intersectDates(
    '2026-05-01',
    '2026-05-05',
    '2026-06-01',
    '2026-06-30',
  ),
  null,
);


assert.strictEqual(
  normalizeSqlDate(new Date(2036, 6, 7)),
  '2036-07-07',
);

assert.strictEqual(
  normalizeSqlDate('2036-07-07T00:00:00.000Z'),
  '2036-07-07',
);

assert.strictEqual(
  normalizeSqlDate('2036-07-07'),
  '2036-07-07',
);

assert.strictEqual(roundMoney(13636.36), 13636);
assert.strictEqual(roundMoney(13636.56), 13637);
assert.strictEqual(roundMoney(13636.567, 'centime'), 13636.57);

console.log('unpaid_leave_payroll_test: OK');

'use strict';

const assert = require('assert');
const {
  calculateLeaveDays,
  weekdayInTimezone,
} = require('../backend/services/leave_calendar');

function calc(options) {
  return calculateLeaveDays({
    timezone: 'Africa/Brazzaville',
    weekendDays: [6, 0],
    holidays: [],
    mode: 'ouvres',
    ...options,
  });
}

let result = calc({ startDate: '2026-07-06', endDate: '2026-07-10' });
assert.strictEqual(result.total, 5, 'lundi → vendredi = 5 jours ouvrés');
assert.strictEqual(result.calendarDays, 5);
assert.deepStrictEqual(result.dates, [
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
]);

result = calc({ startDate: '2026-07-10', endDate: '2026-07-13' });
assert.strictEqual(result.total, 2, 'vendredi → lundi = 2 jours ouvrés');
assert.strictEqual(result.excludedWeekends, 2);
assert.deepStrictEqual(result.dates, ['2026-07-10', '2026-07-13']);

result = calc({ startDate: '2026-07-11', endDate: '2026-07-12' });
assert.strictEqual(result.total, 0, 'samedi → dimanche = 0 jour ouvré');
assert.strictEqual(result.excludedWeekends, 2);

result = calc({
  startDate: '2026-07-06',
  endDate: '2026-07-10',
  holidays: ['2026-07-08'],
});
assert.strictEqual(result.total, 4, 'jour férié en semaine exclu');
assert.strictEqual(result.excludedHolidays, 1);
assert(!result.dates.includes('2026-07-08'));

result = calc({
  startDate: '2026-07-10',
  endDate: '2026-07-13',
  holidays: ['2026-07-12'],
});
assert.strictEqual(result.total, 2, 'jour férié dimanche non déduit deux fois');
assert.strictEqual(result.excludedWeekends, 2);
assert.strictEqual(result.excludedHolidays, 0);

result = calc({
  startDate: '2026-07-10',
  endDate: '2026-07-13',
  holidays: ['2026-07-10', '2026-07-12'],
  mode: 'calendaires',
});
assert.strictEqual(result.total, 4, 'congé calendaire conserve week-ends et fériés');
assert.strictEqual(result.excludedWeekends, 0);
assert.strictEqual(result.excludedHolidays, 0);
assert.deepStrictEqual(result.dates, ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']);

result = calc({ startDate: '2026-07-06', endDate: '2026-07-06' });
assert.strictEqual(result.total, 1, 'date unique ouvrée = 1');

result = calc({ startDate: '2026-07-11', endDate: '2026-07-11' });
assert.strictEqual(result.total, 0, 'date unique samedi = 0');

result = calc({ startDate: '2026-12-31', endDate: '2027-01-04' });
assert.strictEqual(result.total, 3, 'changement année');
assert.deepStrictEqual(result.dates, ['2026-12-31', '2027-01-01', '2027-01-04']);

result = calc({ startDate: '2028-02-28', endDate: '2028-03-01' });
assert.strictEqual(result.total, 3, 'année bissextile');
assert.deepStrictEqual(result.dates, ['2028-02-28', '2028-02-29', '2028-03-01']);

assert.strictEqual(weekdayInTimezone('2026-07-06', 'Africa/Brazzaville'), 1, 'timezone Africa/Brazzaville');

const sqliteLike = calc({ startDate: '2026-07-06', endDate: '2026-07-12', holidays: ['2026-07-08'] });
const mysqlLike = calc({ startDate: '2026-07-06', endDate: '2026-07-12', holidays: ['2026-07-08'] });
assert.deepStrictEqual(sqliteLike, mysqlLike, 'résultat identique SQLite/MySQL');

console.log('leave_calendar_test: OK');

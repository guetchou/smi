'use strict';

const assert = require('assert');

const {
  DAILY_STATUSES,
  ATTENDANCE_ANOMALIES,
  minutesBetween,
  classifyAttendanceDay,
} = require('../backend/services/attendance_daily_engine');

function testStatusCatalog() {
  assert(DAILY_STATUSES.includes('present'));
  assert(DAILY_STATUSES.includes('absent_justifie'));
  assert(DAILY_STATUSES.includes('absent_injustifie'));
  assert(DAILY_STATUSES.includes('conge_paye'));
  assert(DAILY_STATUSES.includes('conge_non_paye'));
  assert(DAILY_STATUSES.includes('maladie'));
  assert(DAILY_STATUSES.includes('mission'));
  assert(DAILY_STATUSES.includes('repos'));
  assert(DAILY_STATUSES.includes('jour_ferie'));
  assert(DAILY_STATUSES.includes('teletravail'));
  assert(DAILY_STATUSES.includes('suspension'));
  assert(DAILY_STATUSES.includes('pointage_incomplet'));
}

function testMinutesAcrossMidnight() {
  assert.strictEqual(
    minutesBetween('22:00', '06:00'),
    480,
    'Une journée de nuit doit traverser minuit',
  );
}

function testPresent() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    punches: [
      { type: 'entry', time: '07:58' },
      { type: 'exit', time: '17:03' },
    ],
  });

  assert.strictEqual(result.status, 'present');
  assert.strictEqual(result.workedMinutes, 545);
  assert.deepStrictEqual(result.anomalies, []);
}

function testLateArrival() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    lateToleranceMinutes: 15,
    punches: [
      { type: 'entry', time: '08:22' },
      { type: 'exit', time: '17:00' },
    ],
  });

  assert.strictEqual(result.status, 'present');
  assert.strictEqual(result.lateMinutes, 22);
  assert(result.anomalies.includes(ATTENDANCE_ANOMALIES.LATE_ARRIVAL));
}

function testMissingExit() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    punches: [
      { type: 'entry', time: '08:00' },
    ],
  });

  assert.strictEqual(result.status, 'pointage_incomplet');
  assert(result.anomalies.includes(ATTENDANCE_ANOMALIES.MISSING_EXIT));
}

function testUnjustifiedAbsence() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    punches: [],
  });

  assert.strictEqual(result.status, 'absent_injustifie');
  assert(result.anomalies.includes(ATTENDANCE_ANOMALIES.NO_PUNCH));
}

function testApprovedLeaveWins() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    punches: [],
    approvedEvent: {
      type: 'conge_paye',
    },
  });

  assert.strictEqual(result.status, 'conge_paye');
  assert.deepStrictEqual(result.anomalies, []);
}

function testRestDay() {
  const result = classifyAttendanceDay({
    scheduled: false,
    punches: [],
  });

  assert.strictEqual(result.status, 'repos');
  assert.deepStrictEqual(result.anomalies, []);
}

function testRemoteWork() {
  const result = classifyAttendanceDay({
    scheduled: true,
    punches: [],
    approvedEvent: {
      type: 'teletravail',
    },
  });

  assert.strictEqual(result.status, 'teletravail');
}

function testEarlyDeparture() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    earlyDepartureToleranceMinutes: 10,
    punches: [
      { type: 'entry', time: '08:00' },
      { type: 'exit', time: '16:30' },
    ],
  });

  assert.strictEqual(result.earlyDepartureMinutes, 30);
  assert(
    result.anomalies.includes(
      ATTENDANCE_ANOMALIES.EARLY_DEPARTURE,
    ),
  );
}

function testDuplicatePunch() {
  const result = classifyAttendanceDay({
    scheduled: true,
    expectedStart: '08:00',
    expectedEnd: '17:00',
    punches: [
      { type: 'entry', time: '08:00' },
      { type: 'entry', time: '08:02' },
      { type: 'exit', time: '17:00' },
    ],
  });

  assert(
    result.anomalies.includes(
      ATTENDANCE_ANOMALIES.DUPLICATE_PUNCH,
    ),
  );
}

testStatusCatalog();
testMinutesAcrossMidnight();
testPresent();
testLateArrival();
testMissingExit();
testUnjustifiedAbsence();
testApprovedLeaveWins();
testRestDay();
testRemoteWork();
testEarlyDeparture();
testDuplicatePunch();

console.log('attendance_daily_engine_test: OK');

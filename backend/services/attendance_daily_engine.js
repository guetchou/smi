'use strict';

const DAILY_STATUSES = Object.freeze([
  'present',
  'absent_justifie',
  'absent_injustifie',
  'conge_paye',
  'conge_non_paye',
  'maladie',
  'mission',
  'repos',
  'jour_ferie',
  'teletravail',
  'suspension',
  'pointage_incomplet',
]);

const ATTENDANCE_ANOMALIES = Object.freeze({
  NO_PUNCH: 'no_punch',
  MISSING_ENTRY: 'missing_entry',
  MISSING_EXIT: 'missing_exit',
  LATE_ARRIVAL: 'late_arrival',
  EARLY_DEPARTURE: 'early_departure',
  DUPLICATE_PUNCH: 'duplicate_punch',
  INVALID_SEQUENCE: 'invalid_sequence',
});

function timeToMinutes(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(String(value))) {
    return null;
  }

  const [hours, minutes] = String(value).split(':').map(Number);

  if (
    !Number.isInteger(hours)
    || !Number.isInteger(minutes)
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
}

function minutesBetween(start, end) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  if (endMinutes >= startMinutes) {
    return endMinutes - startMinutes;
  }

  return (24 * 60 - startMinutes) + endMinutes;
}

function normalizePunches(punches = []) {
  return [...punches]
    .filter(punch => (
      punch
      && ['entry', 'exit'].includes(punch.type)
      && timeToMinutes(punch.time) !== null
    ))
    .sort((a, b) => (
      timeToMinutes(a.time) - timeToMinutes(b.time)
    ));
}

function hasDuplicatePunches(punches) {
  for (let index = 1; index < punches.length; index += 1) {
    if (punches[index].type === punches[index - 1].type) {
      return true;
    }
  }

  return false;
}

function classifyAttendanceDay(input = {}) {
  const {
    scheduled = true,
    expectedStart = null,
    expectedEnd = null,
    lateToleranceMinutes = 15,
    earlyDepartureToleranceMinutes = 10,
    approvedEvent = null,
  } = input;

  const punches = normalizePunches(input.punches);
  const anomalies = [];

  if (approvedEvent?.type) {
    if (!DAILY_STATUSES.includes(approvedEvent.type)) {
      throw new Error(
        `Unsupported approved attendance event: ${approvedEvent.type}`,
      );
    }

    return {
      status: approvedEvent.type,
      firstEntry: null,
      lastExit: null,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      anomalies,
    };
  }

  if (!scheduled) {
    return {
      status: 'repos',
      firstEntry: null,
      lastExit: null,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      anomalies,
    };
  }

  if (punches.length === 0) {
    return {
      status: 'absent_injustifie',
      firstEntry: null,
      lastExit: null,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      anomalies: [ATTENDANCE_ANOMALIES.NO_PUNCH],
    };
  }

  if (hasDuplicatePunches(punches)) {
    anomalies.push(ATTENDANCE_ANOMALIES.DUPLICATE_PUNCH);
  }

  const entries = punches.filter(punch => punch.type === 'entry');
  const exits = punches.filter(punch => punch.type === 'exit');

  const firstEntry = entries[0]?.time || null;
  const lastExit = exits[exits.length - 1]?.time || null;

  if (!firstEntry) {
    anomalies.push(ATTENDANCE_ANOMALIES.MISSING_ENTRY);
  }

  if (!lastExit) {
    anomalies.push(ATTENDANCE_ANOMALIES.MISSING_EXIT);
  }

  if (!firstEntry || !lastExit) {
    return {
      status: 'pointage_incomplet',
      firstEntry,
      lastExit,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      anomalies,
    };
  }

  const expectedStartMinutes = timeToMinutes(expectedStart);
  const expectedEndMinutes = timeToMinutes(expectedEnd);
  const firstEntryMinutes = timeToMinutes(firstEntry);
  const lastExitMinutes = timeToMinutes(lastExit);

  const lateMinutes = (
    expectedStartMinutes !== null
    && firstEntryMinutes > expectedStartMinutes
  )
    ? firstEntryMinutes - expectedStartMinutes
    : 0;

  if (lateMinutes > lateToleranceMinutes) {
    anomalies.push(ATTENDANCE_ANOMALIES.LATE_ARRIVAL);
  }

  let earlyDepartureMinutes = 0;

  if (
    expectedEndMinutes !== null
    && lastExitMinutes !== null
  ) {
    const expectedDuration = minutesBetween(
      expectedStart || firstEntry,
      expectedEnd,
    );

    const actualDurationFromExpectedStart = minutesBetween(
      expectedStart || firstEntry,
      lastExit,
    );

    if (
      expectedDuration !== null
      && actualDurationFromExpectedStart !== null
      && actualDurationFromExpectedStart < expectedDuration
    ) {
      earlyDepartureMinutes = (
        expectedDuration - actualDurationFromExpectedStart
      );
    }
  }

  if (earlyDepartureMinutes > earlyDepartureToleranceMinutes) {
    anomalies.push(ATTENDANCE_ANOMALIES.EARLY_DEPARTURE);
  }

  return {
    status: 'present',
    firstEntry,
    lastExit,
    workedMinutes: minutesBetween(firstEntry, lastExit) || 0,
    lateMinutes,
    earlyDepartureMinutes,
    anomalies,
  };
}

module.exports = {
  DAILY_STATUSES,
  ATTENDANCE_ANOMALIES,
  timeToMinutes,
  minutesBetween,
  classifyAttendanceDay,
};

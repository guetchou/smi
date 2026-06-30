'use strict';

const {
  calculateLeaveDays,
  normalizeWeekendDays,
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKEND_DAYS,
} = require('./leave_calendar');

function payrollError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function roundMoney(value, mode = 'franc') {
  const number = Number(value) || 0;

  if (mode === 'centime') {
    return Math.round(number * 100) / 100;
  }

  return Math.round(number);
}

function monthBounds(month, year) {
  const normalizedMonth = Number(month);
  const normalizedYear = Number(year);

  if (
    !Number.isInteger(normalizedMonth)
    || normalizedMonth < 1
    || normalizedMonth > 12
    || !Number.isInteger(normalizedYear)
  ) {
    throw payrollError('Période de paie invalide');
  }

  const start = `${normalizedYear}-${String(normalizedMonth).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(normalizedYear, normalizedMonth, 0));
  const end = endDate.toISOString().slice(0, 10);

  return { start, end };
}

function normalizeSqlDate(value, timezone = DEFAULT_TIMEZONE) {
  const text = String(value || '').trim();

  if (!(value instanceof Date)) {
    const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);

  const values = Object.fromEntries(
    parts
      .filter(part => ['year', 'month', 'day'].includes(part.type))
      .map(part => [part.type, part.value])
  );

  if (!values.year || !values.month || !values.day) return null;

  return `${values.year}-${values.month}-${values.day}`;
}

function intersectDates(startA, endA, startB, endB) {
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;

  return start <= end ? { start, end } : null;
}

function getParam(dbc, key, fallback) {
  const row = dbc.prepare(
    'SELECT valeur FROM parametres WHERE cle = ?',
  ).get(key);

  return row?.valeur ?? fallback;
}

function getRows(dbc, sql, params) {
  return dbc.prepare(sql).all(...params);
}

function getUnpaidLeavePayrollSettings(dbc) {
  const activeRaw = String(
    getParam(dbc, 'paie_sans_solde_actif', '1'),
  ).toLowerCase();

  const diviseur = String(
    getParam(
      dbc,
      'paie_sans_solde_diviseur',
      'jours_ouvres_mois',
    ),
  ).trim();

  const weekendDays = normalizeWeekendDays(
    getParam(
      dbc,
      'conges_weekend',
      DEFAULT_WEEKEND_DAYS.join(','),
    ),
  );

  const timezone = String(
    getParam(dbc, 'conges_timezone', DEFAULT_TIMEZONE),
  ).trim() || DEFAULT_TIMEZONE;

  const holidays = String(
    getParam(dbc, 'conges_jours_feries', ''),
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const rounding = String(
    getParam(dbc, 'paie_sans_solde_arrondi', 'franc'),
  ).trim();

  return {
    active: ['1', 'true', 'oui', 'yes'].includes(activeRaw),
    divisorMode: diviseur,
    weekendDays,
    timezone,
    holidays,
    rounding,
  };
}

function calculateUnpaidLeavePayrollImpact({
  employeeId,
  month,
  year,
  contractualBase,
  dbc,
}) {
  if (!employeeId) {
    throw payrollError('Employé obligatoire');
  }

  const base = Math.max(0, Number(contractualBase) || 0);
  const bounds = monthBounds(month, year);
  const settings = getUnpaidLeavePayrollSettings(dbc);

  const monthCalendar = calculateLeaveDays({
    startDate: bounds.start,
    endDate: bounds.end,
    mode: 'ouvres',
    holidays: settings.holidays,
    weekendDays: settings.weekendDays,
    timezone: settings.timezone,
  });

  const payableDatesInMonth = monthCalendar?.dates || [];
  const payableDaysInMonth = payableDatesInMonth.length;

  if (!settings.active || !base || !payableDaysInMonth) {
    return {
      contractualBase: base,
      payableBase: base,
      payableDaysInMonth,
      unpaidLeaveDays: 0,
      dailyRate: 0,
      deduction: 0,
      leaveIds: [],
      dates: [],
      calculationMode: settings.divisorMode,
      timezone: settings.timezone,
    };
  }

  const rows = getRows(
    dbc,
    `
      SELECT
        id,
        CAST(date_debut AS CHAR) AS date_debut,
        CAST(date_fin AS CHAR) AS date_fin,
        nb_jours,
        statut
      FROM employes_conges
      WHERE employe_id = ?
        AND type_conge = 'sans_solde'
        AND statut IN ('approuve', 'termine')
        AND date_debut <= ?
        AND date_fin >= ?
      ORDER BY date_debut, id
    `,
    [employeeId, bounds.end, bounds.start],
  );

  const dates = new Set();
  const leaveIds = [];

  for (const leave of rows) {
    const leaveStart = normalizeSqlDate(
      leave.date_debut,
      settings.timezone
    );
    const leaveEnd = normalizeSqlDate(
      leave.date_fin,
      settings.timezone
    );

    if (!leaveStart || !leaveEnd) continue;

    const overlap = intersectDates(
      leaveStart,
      leaveEnd,
      bounds.start,
      bounds.end,
    );

    if (!overlap) continue;

    const calculation = calculateLeaveDays({
      startDate: overlap.start,
      endDate: overlap.end,
      mode: 'ouvres',
      holidays: settings.holidays,
      weekendDays: settings.weekendDays,
      timezone: settings.timezone,
    });

    if (!calculation) continue;

    for (const date of calculation.dates || []) {
      dates.add(date);
    }

    leaveIds.push(Number(leave.id));
  }

  const unpaidLeaveDays = Math.min(dates.size, payableDaysInMonth);

  let divisor;

  if (settings.divisorMode === '30_calendaires') {
    divisor = 30;
  } else if (settings.divisorMode === '26_forfaitaires') {
    divisor = 26;
  } else {
    divisor = payableDaysInMonth;
  }

  const dailyRate = divisor > 0 ? base / divisor : 0;
  const rawDeduction = dailyRate * unpaidLeaveDays;
  const deduction = Math.min(
    base,
    Math.max(0, roundMoney(rawDeduction, settings.rounding)),
  );

  return {
    contractualBase: base,
    payableBase: Math.max(0, base - deduction),
    payableDaysInMonth,
    unpaidLeaveDays,
    dailyRate,
    deduction,
    leaveIds: [...new Set(leaveIds)],
    dates: [...dates].sort(),
    calculationMode: settings.divisorMode,
    timezone: settings.timezone,
    periodStart: bounds.start,
    periodEnd: bounds.end,
  };
}

module.exports = {
  calculateUnpaidLeavePayrollImpact,
  getUnpaidLeavePayrollSettings,
  intersectDates,
  monthBounds,
  normalizeSqlDate,
  roundMoney,
};

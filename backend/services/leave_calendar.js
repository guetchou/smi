'use strict';

const DAY_MS = 86400000;
const DEFAULT_WEEKEND_DAYS = [6, 0];
const DEFAULT_TIMEZONE = 'Africa/Brazzaville';

function normalizeMode(mode = 'ouvres') {
  const value = String(mode || 'ouvres').trim().toLowerCase();
  if (['calendaire', 'calendaires', 'calendar', 'calendar_days'].includes(value)) return 'calendaires';
  if (['ouvre', 'ouvres', 'ouvré', 'ouvrés', 'ouvrable', 'ouvrables', 'business'].includes(value)) return 'ouvres';
  return 'ouvres';
}

function parseDateOnly(value) {
  const text = String(value || '').slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return { text, timestamp };
}

function formatDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeWeekendDays(value = DEFAULT_WEEKEND_DAYS) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const days = source
    .map(day => Number(String(day).trim()))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return days.length ? [...new Set(days)] : DEFAULT_WEEKEND_DAYS;
}

function normalizeHolidays(holidays = []) {
  const source = Array.isArray(holidays) ? holidays : String(holidays || '').split(',');
  return new Set(source.map(item => parseDateOnly(item)?.text).filter(Boolean));
}

function weekdayInTimezone(dateText, timezone = DEFAULT_TIMEZONE) {
  const parsed = parseDateOnly(dateText);
  if (!parsed) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    weekday: 'short',
  });
  const weekday = formatter.format(new Date(parsed.timestamp + 12 * 60 * 60 * 1000));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
}

function calculateLeaveDays({
  startDate,
  endDate,
  mode = 'ouvres',
  holidays = [],
  weekendDays = DEFAULT_WEEKEND_DAYS,
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (!start || !end || end.timestamp < start.timestamp) return null;

  const calculationMode = normalizeMode(mode);
  const holidaySet = normalizeHolidays(holidays);
  const weekendSet = new Set(normalizeWeekendDays(weekendDays));
  const dates = [];
  let excludedWeekends = 0;
  let excludedHolidays = 0;
  let calendarDays = 0;

  for (let timestamp = start.timestamp; timestamp <= end.timestamp; timestamp += DAY_MS) {
    const dateText = formatDate(timestamp);
    calendarDays += 1;

    if (calculationMode === 'calendaires') {
      dates.push(dateText);
      continue;
    }

    const weekday = weekdayInTimezone(dateText, timezone);
    const isWeekend = weekendSet.has(weekday);
    const isHoliday = holidaySet.has(dateText);

    if (isWeekend) {
      excludedWeekends += 1;
      continue;
    }
    if (isHoliday) {
      excludedHolidays += 1;
      continue;
    }

    dates.push(dateText);
  }

  return {
    total: dates.length,
    calendarDays,
    excludedWeekends,
    excludedHolidays,
    dates,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKEND_DAYS,
  calculateLeaveDays,
  normalizeMode,
  normalizeWeekendDays,
  weekdayInTimezone,
};

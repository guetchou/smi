'use strict';

const db = require('../db');
const engine = require('./pointeuse_v3_engine');
const policy = require('./pointeuse_v3_policy');
const daily = require('./pointeuse_v3_daily_service');

const IMMUTABLE_STATUSES = ['closed', 'approved'];

async function findStaleOpenDays(executor, { now, cutoffMinutes }) {
  const rows = await executor.query(
    `SELECT e.employe_id, e.work_date, MAX(e.occurred_at_utc) AS last_event_utc
     FROM pointeuse_events e
     LEFT JOIN pointeuse_daily_summaries s
       ON s.employe_id = e.employe_id AND s.work_date = e.work_date
     WHERE COALESCE(s.status, 'open') NOT IN (?, ?)
     GROUP BY e.employe_id, e.work_date
     HAVING SUM(CASE WHEN e.event_type = 'clock_out' THEN 1 ELSE 0 END) = 0
     ORDER BY e.work_date`,
    IMMUTABLE_STATUSES
  );
  return rows.filter(row => {
    const elapsed = engine.elapsedMinutesSince(row.last_event_utc, now);
    return elapsed !== null && elapsed > cutoffMinutes;
  });
}

async function sweepStaleOpenDays({ now = new Date(), executor = db, cutoffMinutes } = {}) {
  const cutoff = cutoffMinutes ?? await policy.getDayCutoffMinutes(executor);
  const stale = await findStaleOpenDays(executor, { now, cutoffMinutes: cutoff });
  const report = { cutoff_minutes: cutoff, scanned: stale.length, recalculated: 0, skipped: 0, failed: 0 };
  for (const row of stale) {
    try {
      await daily.recalculateDay(row.employe_id, row.work_date);
      report.recalculated += 1;
    } catch (error) {
      if (error?.code === 'DAY_CLOSED') report.skipped += 1;
      else {
        report.failed += 1;
        console.error('[pointeuse-v3-day-closure]', row.employe_id, row.work_date, error.message);
      }
    }
  }
  return report;
}

module.exports = { IMMUTABLE_STATUSES, findStaleOpenDays, sweepStaleOpenDays };

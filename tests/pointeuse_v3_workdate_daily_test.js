const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');
const daily = require('../backend/services/pointeuse_v3_daily_service');

assert.strictEqual(
  engine.resolveWorkDate({ event_type: 'clock_in', work_date: '2026-08-18', local_date: '2026-08-18' }, '2026-08-19'),
  '2026-08-18',
  'Un shift ouvert doit rester rattaché à sa date de travail après minuit'
);
assert.strictEqual(
  engine.resolveWorkDate({ event_type: 'clock_out', work_date: '2026-08-18' }, '2026-08-19'),
  '2026-08-19',
  'Après clôture du shift, une nouvelle entrée doit utiliser la nouvelle date'
);

const overnight = daily.scheduleMetrics([
  { id: 1, event_type: 'clock_in', local_time: '22:05:00', occurred_at_utc: '2026-08-18 21:05:00.000' },
  { id: 2, event_type: 'clock_out', local_time: '06:10:00', occurred_at_utc: '2026-08-19 05:10:00.000' },
], {
  heure_debut: '22:00:00',
  heure_fin: '06:00:00',
  pause_minutes: 0,
  tolerance_retard_minutes: 10,
  tolerance_depart_minutes: 0,
  nuit_traverse_minuit: 1,
}, {
  workedMinutes: 485,
  anomalies: [],
});
assert.strictEqual(overnight.lateMinutes, 0, 'La tolérance de retard doit être respectée');
assert.strictEqual(overnight.earlyLeaveMinutes, 0, 'Une sortie après 06:00 ne doit pas être départ anticipé');
assert.strictEqual(overnight.overtimeMinutes, 5, '5 minutes supplémentaires attendues sur shift 22h-06h');

const migration = fs.readFileSync(path.join(__dirname, '../backend/migrations/044_pointeuse_v3_work_date.sql'), 'utf8');
assert(/ADD COLUMN work_date DATE/.test(migration), 'work_date doit être matérialisé en base');
assert(/idx_pointeuse_events_work_date/.test(migration), 'Index work_date requis');

const engineSource = fs.readFileSync(path.join(__dirname, '../backend/services/pointeuse_v3_engine.js'), 'utf8');
assert(/SELECT id, employe_id, event_type[\s\S]*work_date/.test(engineSource), 'Le moteur doit lire work_date');
assert(/INSERT INTO pointeuse_events[\s\S]*work_date/.test(engineSource), 'Le moteur doit écrire work_date');
assert(/getLatestEvent/.test(engineSource), 'La transition doit suivre le dernier événement global, pas seulement la date civile');

const route = fs.readFileSync(path.join(__dirname, '../backend/routes/pointeuse_v3.js'), 'utf8');
assert(/daily\.recalculateDay\(employeId, result\.event\.work_date\)/.test(route), 'Chaque nouvel événement doit recalculer sa journée de travail');
assert(/work_date BETWEEN \? AND \?/.test(route), 'L’historique doit filtrer sur work_date');
assert(/PERIOD_STATE_RACE/.test(route), 'La clôture doit détecter une course de changement d’état');

const dailySource = fs.readFileSync(path.join(__dirname, '../backend/services/pointeuse_v3_daily_service.js'), 'utf8');
assert(/status === 'closed'/.test(dailySource), 'Une journée clôturée doit être immuable');
assert(/pointeuse_anomalies/.test(dailySource), 'Le recalcul doit matérialiser les anomalies');
assert(/excessive_duration/.test(dailySource), 'Durée excessive doit être détectée');

console.log(JSON.stringify({
  pointeuseV3WorkDate: true,
  overnightShift: true,
  dailyRecalculation: true,
  automaticAnomalies: true,
  closedDayImmutable: true,
  periodRaceGuard: true,
}));

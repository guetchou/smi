const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');

assert.deepStrictEqual(engine.TRANSITIONS.empty, ['clock_in']);
assert.deepStrictEqual(engine.TRANSITIONS.clock_in, ['break_start', 'clock_out']);
assert.deepStrictEqual(engine.TRANSITIONS.break_start, ['break_end']);
assert.deepStrictEqual(engine.TRANSITIONS.break_end, ['break_start', 'clock_out']);
assert.deepStrictEqual(engine.TRANSITIONS.clock_out, []);

assert.throws(
  () => engine.assertTransition('empty', 'clock_out'),
  err => err.code === 'INVALID_ATTENDANCE_TRANSITION' && err.status === 409,
  'Une sortie sans entrée doit être rejetée'
);

const day = engine.calculateDay([
  { id: 1, event_type: 'clock_in', occurred_at_utc: '2026-08-18 07:00:00.000' },
  { id: 2, event_type: 'break_start', occurred_at_utc: '2026-08-18 11:00:00.000' },
  { id: 3, event_type: 'break_end', occurred_at_utc: '2026-08-18 12:00:00.000' },
  { id: 4, event_type: 'clock_out', occurred_at_utc: '2026-08-18 16:00:00.000' },
]);
assert.strictEqual(day.workedMinutes, 480, '8h travaillées attendues');
assert.strictEqual(day.breakMinutes, 60, '1h de pause attendue');
assert.strictEqual(day.anomalies.length, 0, 'Aucune anomalie attendue');

const incomplete = engine.calculateDay([
  { id: 1, event_type: 'clock_in', occurred_at_utc: '2026-08-18 07:00:00.000' },
]);
assert(incomplete.anomalies.some(a => a.type === 'missing_out'), 'Une entrée sans sortie doit produire une anomalie');

const migration = fs.readFileSync(path.join(__dirname, '../backend/migrations/043_pointeuse_industrial_v3.sql'), 'utf8');
for (const table of [
  'pointeuse_events',
  'pointeuse_work_schedules',
  'pointeuse_schedule_assignments',
  'pointeuse_daily_summaries',
  'pointeuse_anomalies',
  'pointeuse_correction_requests',
  'pointeuse_periods',
]) {
  assert(migration.includes(`CREATE TABLE ${table}`), `Table industrielle manquante: ${table}`);
}
assert(/UNIQUE KEY uq_pointeuse_event_idempotency/.test(migration), 'Idempotence DB requise');
assert(/occurred_at_utc DATETIME\(3\) NOT NULL/.test(migration), 'Horodatage UTC milliseconde requis');
assert(/timezone_name VARCHAR\(64\)/.test(migration), 'Fuseau horaire explicite requis');
assert(/status ENUM\('detected','to_justify','submitted','approved','rejected','regularized','dismissed'\)/.test(migration), 'Workflow anomalie incomplet');
assert(/status ENUM\('open','calculated','review','approved','closed','reopened'\)/.test(migration), 'Workflow de clôture incomplet');

const route = fs.readFileSync(path.join(__dirname, '../backend/routes/pointeuse_v3.js'), 'utf8');
assert(/Idempotency-Key requis/.test(route), 'L’API événementielle doit exiger une clé idempotente');
assert(/ATTENDANCE_MODE_NOT_AUTHORIZED/.test(route), 'Les modes distants doivent dépendre du planning');
assert(/pointeuse_correction_requests/.test(route), 'Le workflow de correction doit être exposé');
assert(/UNRESOLVED_ANOMALIES/.test(route), 'La clôture doit être bloquée par les anomalies non résolues');
assert(!/router\.(put|patch|delete)\([^\n]*events/.test(route), 'Aucune mutation destructive des événements physiques ne doit être exposée');

console.log(JSON.stringify({
  pointeuseIndustrialV3: true,
  appendOnlyEvents: true,
  idempotency: true,
  transitionStateMachine: true,
  breaks: true,
  anomalyWorkflow: true,
  correctionWorkflow: true,
  periodClosure: true,
  isoTimeModel: true,
}));

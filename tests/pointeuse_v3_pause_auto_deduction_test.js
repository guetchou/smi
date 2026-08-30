const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');
const daily = require('../backend/services/pointeuse_v3_daily_service');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('backend/migrations/048_pointeuse_v3_pause_auto_deduction.sql');
const dailySource = read('backend/services/pointeuse_v3_daily_service.js');
const policySource = read('backend/services/pointeuse_v3_policy.js');
const sqliteSource = read('backend/services/pointeuse_v3_sqlite_bootstrap.js');

/* ── Schéma ── */

assert(/ALTER TABLE pointeuse_work_schedules/.test(migration), 'Les réglages vivent sur le planning');
assert(/pause_auto_deduction TINYINT\(1\) NOT NULL DEFAULT 1/.test(migration), 'La déduction doit être activable par planning');
assert(/pause_seuil_minutes INT NOT NULL DEFAULT 360/.test(migration), 'Un seuil de déclenchement est requis');
assert(/ADD COLUMN break_auto_minutes INT NOT NULL DEFAULT 0/.test(migration), 'Le montant déduit doit rester auditable');

for (const col of ['pause_auto_deduction', 'pause_seuil_minutes']) {
  assert(policySource.includes(`s.${col}`), `Le planning actif doit remonter ${col}`);
  assert(sqliteSource.includes(col), `Parité SQLite manquante pour ${col}`);
}
assert(dailySource.includes('break_auto_minutes=VALUES(break_auto_minutes)'), 'Le montant déduit doit être persisté au recalcul');
assert(
  dailySource.includes('metrics.workedNetMinutes ?? base.workedMinutes'),
  'Le temps enregistré doit être le temps net de pause'
);

/* ── Règle métier ── */

const SCHEDULE = {
  heure_debut: '08:00:00', heure_fin: '17:00:00',
  pause_minutes: 60, pause_auto_deduction: 1, pause_seuil_minutes: 360,
  tolerance_retard_minutes: 0, tolerance_depart_minutes: 0,
  nuit_traverse_minuit: 0, max_duree_minutes: 960,
};
const WORKDAY = { day_type: 'workday', scheduled_minutes_override: null };

const ev = (id, type, hhmm) => ({
  id, event_type: type, local_time: `${hhmm}:00`,
  occurred_at_utc: `2026-08-31 ${String(Number(hhmm.slice(0, 2)) - 1).padStart(2, '0')}${hhmm.slice(2)}:00.000`,
  utc_offset_minutes: 60,
});

function run(events, schedule = SCHEDULE, calendar = WORKDAY) {
  const base = engine.calculateDay(events);
  const metrics = daily.scheduleMetrics(events, schedule, base, calendar);
  return { brut: base.workedMinutes, declaree: base.breakMinutes, ...metrics };
}

const JOURNEE_COMPLETE = [ev(1, 'clock_in', '08:00'), ev(2, 'clock_out', '17:00')];
const AVEC_PAUSE = [ev(1, 'clock_in', '08:00'), ev(2, 'break_start', '12:00'), ev(3, 'break_end', '13:00'), ev(4, 'clock_out', '17:00')];
const PAUSE_PARTIELLE = [ev(1, 'clock_in', '08:00'), ev(2, 'break_start', '12:00'), ev(3, 'break_end', '12:20'), ev(4, 'clock_out', '17:00')];
const DEMI_JOURNEE = [ev(1, 'clock_in', '08:00'), ev(2, 'clock_out', '12:00')];
const JOURNEE_LONGUE = [ev(1, 'clock_in', '08:00'), ev(2, 'clock_out', '19:00')];

const declaree = run(AVEC_PAUSE);
assert.strictEqual(declaree.breakAutoMinutes, 0, 'Une pause déclarée ne doit pas être déduite deux fois');
assert.strictEqual(declaree.workedNetMinutes, 480, 'Temps net attendu sur une journée avec pause déclarée');
assert.strictEqual(declaree.overtimeMinutes, 0, 'Aucune heure supplémentaire sur une journée nominale');

const nonDeclaree = run(JOURNEE_COMPLETE);
assert.strictEqual(nonDeclaree.breakAutoMinutes, 60, 'Une pause non déclarée doit être déduite');
assert.strictEqual(nonDeclaree.workedNetMinutes, 480, 'Le temps net doit être identique à la pause déclarée');
assert.strictEqual(
  nonDeclaree.overtimeMinutes, 0,
  'Ne pas déclarer sa pause ne doit plus produire d’heures supplémentaires'
);
assert.strictEqual(
  nonDeclaree.workedNetMinutes, declaree.workedNetMinutes,
  'La même journée physique doit être payée pareil, pause déclarée ou non'
);

const partielle = run(PAUSE_PARTIELLE);
assert.strictEqual(partielle.breakAutoMinutes, 40, 'Seul le complément de pause doit être déduit');
assert.strictEqual(partielle.workedNetMinutes, 480, 'Le complément doit ramener au temps nominal');

const demi = run(DEMI_JOURNEE);
assert.strictEqual(demi.breakAutoMinutes, 0, 'Sous le seuil, aucune pause ne doit être amputée');
assert.strictEqual(demi.workedNetMinutes, 240, 'Une demi-journée doit rester intacte');

const longue = run(JOURNEE_LONGUE);
assert.strictEqual(longue.breakAutoMinutes, 60, 'La déduction s’applique aussi aux journées longues');
assert.strictEqual(longue.overtimeMinutes, 120, 'Les heures supplémentaires réelles doivent être préservées');

/* ── Désactivation et bornes ── */

assert.strictEqual(
  run(JOURNEE_COMPLETE, { ...SCHEDULE, pause_auto_deduction: 0 }).breakAutoMinutes, 0,
  'La déduction doit être désactivable par planning'
);
assert.strictEqual(
  run(JOURNEE_COMPLETE, { ...SCHEDULE, pause_minutes: 0 }).breakAutoMinutes, 0,
  'Sans pause configurée, rien ne doit être déduit'
);
assert.strictEqual(
  run(JOURNEE_COMPLETE, SCHEDULE, { day_type: 'rest', scheduled_minutes_override: null }).breakAutoMinutes, 0,
  'Aucune déduction un jour non travaillé'
);
assert.strictEqual(
  daily.autoDeductedBreakMinutes(null, { workedMinutes: 540, breakMinutes: 0 }, true), 0,
  'Sans planning affecté, aucune déduction'
);
assert.strictEqual(
  daily.autoDeductedBreakMinutes(SCHEDULE, { workedMinutes: 400, breakMinutes: 120 }, true), 0,
  'Une pause déclarée supérieure à la pause prévue ne doit jamais créer de crédit'
);
assert.strictEqual(daily.DEFAULT_PAUSE_SEUIL_MINUTES, 360, 'Le seuil par défaut doit rester explicite');

console.log(JSON.stringify({
  unpaidBreakAutoDeducted: true,
  declaredBreakNotDoubleCounted: true,
  partialBreakTopUp: true,
  shortShiftProtected: true,
  realOvertimePreserved: true,
  disableable: true,
  auditableAmount: true,
}));

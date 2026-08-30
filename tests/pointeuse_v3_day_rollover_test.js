const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');
const policy = require('../backend/services/pointeuse_v3_policy');
const dayClosure = require('../backend/services/pointeuse_v3_day_closure');

const root = path.join(__dirname, '..');
const engineSource = fs.readFileSync(path.join(root, 'backend/services/pointeuse_v3_engine.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'backend/routes/pointeuse_v3.js'), 'utf8');
const dailySource = fs.readFileSync(path.join(root, 'backend/services/pointeuse_v3_daily_service.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');
const closureSource = fs.readFileSync(path.join(root, 'backend/services/pointeuse_v3_day_closure.js'), 'utf8');

/* ── 1. Bascule de journée : un shift resté ouvert ne séquestre plus l'agent ── */

const openShift = {
  event_type: 'clock_in',
  work_date: '2026-08-18',
  local_date: '2026-08-18',
  occurred_at_utc: '2026-08-18 15:47:00.000',
};

assert.strictEqual(
  engine.resolveWorkDate(openShift, '2026-08-19', { now: new Date('2026-08-19T03:00:00Z'), cutoffMinutes: 960 }),
  '2026-08-18',
  'Un shift de nuit encore dans la fenêtre doit rester rattaché à sa date de travail'
);

assert.strictEqual(
  engine.resolveWorkDate(openShift, '2026-08-30', { now: new Date('2026-08-30T13:00:00Z'), cutoffMinutes: 960 }),
  '2026-08-30',
  'Une journée ouverte au-delà du cutoff ne doit plus capturer les événements suivants'
);

assert.strictEqual(
  engine.resolveWorkDate(openShift, '2026-08-19'),
  '2026-08-18',
  'Sans horodatage de référence, le comportement historique doit être préservé'
);

assert.strictEqual(
  engine.resolveWorkDate(
    { event_type: 'clock_out', work_date: '2026-08-18' },
    '2026-08-19',
    { now: new Date('2026-08-19T09:00:00Z'), cutoffMinutes: 960 }
  ),
  '2026-08-19',
  'Après clôture du shift, une nouvelle entrée doit utiliser la nouvelle date'
);

assert.strictEqual(engine.elapsedMinutesSince(null, new Date()), null, 'Un horodatage absent ne doit pas produire de durée');
assert.strictEqual(engine.elapsedMinutesSince('2026-08-18 15:47:00.000', null), null, 'Une horloge absente ne doit pas produire de durée');
assert.strictEqual(
  engine.elapsedMinutesSince('2026-08-18 15:00:00.000', new Date('2026-08-18T17:30:00Z')),
  150,
  'La durée écoulée doit être calculée en minutes UTC'
);
assert.strictEqual(engine.DEFAULT_DAY_CUTOFF_MINUTES, 960, 'Le cutoff par défaut doit rester aligné sur la durée maximale de journée');

/* ── 2. Le moteur doit repartir d'un état vierge après bascule ── */

assert.throws(
  () => engine.assertTransition('clock_in', 'clock_in'),
  err => err.code === 'INVALID_ATTENDANCE_TRANSITION',
  'Une double entrée dans la même journée reste interdite'
);
engine.assertTransition(undefined, 'clock_in');

assert(
  engineSource.includes('const sameDayPrevious = openPrevious && openWorkDate(openPrevious, time.localDate) === workDate ? openPrevious : null;'),
  'La transition doit être évaluée contre la journée réellement retenue'
);
assert(
  engineSource.indexOf('const workDate = resolveWorkDate(openPrevious') < engineSource.indexOf('assertTransition(sameDayPrevious?.event_type, eventType)'),
  'La journée doit être résolue avant le contrôle de transition'
);
assert(
  !/assertTransition\(effectivePrevious\?\.event_type, eventType\)/.test(engineSource),
  'L ancienne évaluation de transition ne doit plus subsister'
);

/* ── 3. Absence d'affectation : invariant conservé, diagnostic rendu exact ── */

assert.strictEqual(policy.modeAllowed(null, 'bureau'), false, 'Aucun pointage V3 sans affectation planning');
assert.strictEqual(policy.modeAllowed({ mode_autorise: 'bureau' }, 'teletravail'), false, 'Une affectation explicite reste prioritaire');
assert.strictEqual(policy.modeAllowed({ mode_autorise: 'hybride' }, 'terrain'), true, 'Une affectation hybride couvre les trois modes');

assert(
  routeSource.includes("code: 'ATTENDANCE_NO_ACTIVE_ASSIGNMENT'"),
  'Une absence d affectation doit être signalée pour elle-même, pas comme un mode refusé'
);
assert(
  routeSource.indexOf("ATTENDANCE_NO_ACTIVE_ASSIGNMENT") < routeSource.indexOf('ATTENDANCE_MODE_NOT_AUTHORIZED'),
  'Le contrôle d affectation doit précéder le contrôle de mode'
);
assert(
  dailySource.includes("if (!schedule && events.length) metrics.anomalies.push({ type: 'missing_assignment' });"),
  'Un pointage sans affectation doit produire missing_assignment'
);
assert(
  dailySource.includes("if (schedule && event.mode && !policy.modeAllowed(schedule, event.mode))"),
  'remote_not_authorized ne doit plus être émis en l absence d affectation'
);
assert.strictEqual(
  require('../backend/services/pointeuse_v3_daily_service').severityFor('missing_assignment'),
  'critical',
  'Une journée sans planning affecté doit être bloquante'
);

/* ── 5. Câblage des appelants ── */

assert(routeSource.includes('const cutoffMinutes = await policy.getDayCutoffMinutes();'), 'Les routes doivent lire le cutoff paramétré');
assert(routeSource.includes('dayCutoffMinutes: cutoffMinutes,'), 'Le moteur doit recevoir le cutoff depuis la route');
assert(
  !/const workDate = previous && previous\.event_type !== 'clock_out' \? previous\.work_date : nowParts\.localDate;/.test(routeSource),
  'L ancienne résolution de journée ne doit plus subsister sur le pointage'
);
assert(
  !/const workDate = latest && latest\.event_type !== 'clock_out' \? latest\.work_date : parts\.localDate;/.test(routeSource),
  'Le statut doit utiliser la résolution avec cutoff'
);
assert(serverSource.includes('runScheduledTask(\'POINTEUSE cron journées ouvertes\''), 'Le balayage doit être planifié');
assert(serverSource.includes('require(\'./services/pointeuse_v3_day_closure\')'), 'Le service de balayage doit être chargé par le serveur');
assert(!/INSERT INTO pointeuse_events/.test(closureSource), 'Le balayage ne doit jamais fabriquer un événement physique');

/* ── 4. Tout type d'anomalie émis doit exister dans l'ENUM en base ── */

const migrationSource = fs.readFileSync(path.join(root, 'backend/migrations/047_pointeuse_v3_missing_assignment_anomaly.sql'), 'utf8');
const originSource = fs.readFileSync(path.join(root, 'backend/migrations/043_pointeuse_industrial_v3.sql'), 'utf8');

assert(/ALTER TABLE pointeuse_anomalies/.test(migrationSource), 'La migration doit cibler pointeuse_anomalies');
assert(/MODIFY COLUMN anomaly_type ENUM\(/.test(migrationSource), 'La migration doit redéfinir l ENUM anomaly_type');

const enumValues = new Set(
  (migrationSource.match(/ENUM\(([\s\S]*?)\)/)[1].match(/'([a-z_]+)'/g) || []).map(v => v.replace(/'/g, ''))
);
const originValues = (originSource.match(/anomaly_type ENUM\(([^)]*)\)/)[1].match(/'([a-z_]+)'/g) || []).map(v => v.replace(/'/g, ''));

for (const value of originValues) {
  assert(enumValues.has(value), `La migration supprime une valeur existante de l ENUM : ${value}`);
}
assert(enumValues.has('missing_assignment'), 'missing_assignment doit être ajouté à l ENUM');

const emitted = new Set(
  [...dailySource.matchAll(/anomalies\.push\(\{\s*type:\s*'([a-z_]+)'/g)].map(m => m[1])
    .concat([...engineSource.matchAll(/anomalies\.push\(\{\s*type:\s*'([a-z_]+)'/g)].map(m => m[1]))
);
assert(emitted.size >= 8, `Extraction des types d anomalie trop pauvre : ${[...emitted].join(',')}`);
for (const type of emitted) {
  assert(enumValues.has(type), `Type d anomalie émis mais absent de l ENUM en base : ${type}`);
  assert(
    ['critical', 'warning', 'info'].includes(require('../backend/services/pointeuse_v3_daily_service').severityFor(type)),
    `Gravité non définie pour ${type}`
  );
}

(async () => {
  /* ── 5. Paramétrage ── */

  const emptyExecutor = { queryOne: async () => null };
  assert.strictEqual(await policy.getDayCutoffMinutes(emptyExecutor), 960, 'Le cutoff par défaut doit retomber sur 960 minutes');
  assert.strictEqual(await policy.getDayCutoffMinutes({ queryOne: async () => ({ valeur: '0' }) }), 960, 'Un cutoff nul doit être rejeté');
  assert.strictEqual(await policy.getDayCutoffMinutes({ queryOne: async () => ({ valeur: '600' }) }), 600, 'Un cutoff valide doit être respecté');

  /* ── 6. Balayage des journées restées ouvertes ── */

  const rows = [
    { employe_id: 15, work_date: '2026-08-18', last_event_utc: '2026-08-18 15:47:00.000' },
    { employe_id: 22, work_date: '2026-08-30', last_event_utc: '2026-08-30 06:00:00.000' },
  ];
  let capturedSql = '';
  let capturedParams = null;
  const executor = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return rows;
    },
  };
  const stale = await dayClosure.findStaleOpenDays(executor, { now: new Date('2026-08-30T13:00:00Z'), cutoffMinutes: 960 });
  assert.strictEqual(stale.length, 1, 'Seules les journées au-delà du cutoff doivent être retenues');
  assert.strictEqual(stale[0].work_date, '2026-08-18', 'La journée abandonnée doit être retenue');
  assert(/HAVING SUM\(CASE WHEN e\.event_type = 'clock_out'/.test(capturedSql), 'Le balayage doit cibler les journées sans sortie');
  assert.deepStrictEqual(capturedParams, ['closed', 'approved'], 'Les journées clôturées ou approuvées doivent être exclues en base');
  assert.deepStrictEqual(dayClosure.IMMUTABLE_STATUSES, ['closed', 'approved'], 'Le balayage ne doit jamais toucher une journée figée');

  console.log(JSON.stringify({
    dayRolloverAfterCutoff: true,
    overnightShiftPreserved: true,
    transitionResetOnNewDay: true,
    assignmentInvariantPreserved: true,
    exactAssignmentDiagnosis: true,
    anomalyEnumCoversEmittedTypes: true,
    configurableCutoff: true,
    staleOpenDaySweep: true,
    appendOnlyPreserved: true,
  }));
})().catch(error => {
  console.error(error);
  process.exit(1);
});

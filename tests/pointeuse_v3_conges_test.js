const assert = require('assert');
const fs = require('fs');
const path = require('path');
const policy = require('../backend/services/pointeuse_v3_policy');
const daily = require('../backend/services/pointeuse_v3_daily_service');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const routeV2 = read('backend/routes/pointeuse.js');
const routeV3 = read('backend/routes/pointeuse_v3.js');
const dailySource = read('backend/services/pointeuse_v3_daily_service.js');

/* ── 1. Même définition du congé qu'en V2 ── */

let sql = '';
let params = null;
const executor = { queryOne: async (q, p) => { sql = q; params = p; return null; } };

(async () => {
  await policy.activeLeave(executor, 15, '2026-08-30');

  assert(/FROM employes_conges/.test(sql), 'La garde V3 doit lire la même table que la V2');
  assert(/statut IN \('approuve','termine'\)/.test(sql), 'Mêmes statuts de congé retenus qu’en V2');
  assert(/date_debut <= \?/.test(sql) && /date_fin >= \?/.test(sql), 'La date doit être encadrée par le congé');
  assert.deepStrictEqual(
    params, [15, '2026-08-30', '2026-08-30'],
    'Agent et date doivent être passés en paramètres liés, la date encadrant début et fin'
  );

  const v2Guard = routeV2.match(/async function congeActifPourDate[\s\S]*?\n\}/)[0];
  for (const fragment of ["statut IN ('approuve','termine')", 'date_debut <= ?', 'date_fin >= ?']) {
    assert(v2Guard.includes(fragment), `Référence V2 introuvable : ${fragment}`);
    assert(sql.includes(fragment), `La V3 doit reprendre la règle V2 : ${fragment}`);
  }

  console.log(JSON.stringify({
    sameLeaveDefinitionAsV2: true,
    punchRefusedOnLeave: true,
    leaveExposedInStatus: true,
    noFalseMissingInOnLeave: true,
    punchDuringLeaveFlagged: true,
    leaveIsIndividualNotCalendar: true,
  }));
})().catch(e => { console.error(e); process.exit(1); });

/* ── 2. Le pointage est refusé, avec le même code d'erreur qu'en V2 ── */

assert(/code: 'AGENT_EN_CONGE'/.test(routeV2), 'Le code d’erreur V2 doit exister');
assert(/code: 'AGENT_EN_CONGE'/.test(routeV3), 'La V3 doit refuser avec le même code que la V2');
assert(
  routeV3.indexOf("code: 'AGENT_EN_CONGE'") < routeV3.indexOf("code: 'ATTENDANCE_NO_ACTIVE_ASSIGNMENT'"),
  'Le congé doit être vérifié avant l’affectation : un agent en congé n’a pas à se voir reprocher son planning'
);
assert(/const leave = await policy\.activeLeave\(db, employeId, workDate\);/.test(routeV3), 'La route doit interroger le congé sur la journée retenue');
assert(/\n      leave,\n    \}\);/.test(routeV3), 'Le statut doit exposer le congé courant');

/* ── 3. Le recalcul ne doit pas reprocher une absence pendant un congé ── */

assert(
  /const leave = await policy\.activeLeave\(tx, employeId, workDate\);/.test(dailySource),
  'Le recalcul doit charger le congé dans sa transaction'
);
assert(
  /scheduleMetrics\(events, schedule, base, calendar, leave\)/.test(dailySource),
  'Le congé doit être transmis au calcul'
);

const SCHEDULE = {
  heure_debut: '08:00:00', heure_fin: '17:00:00', pause_minutes: 60,
  pause_auto_deduction: 1, pause_seuil_minutes: 360,
  tolerance_retard_minutes: 0, tolerance_depart_minutes: 0,
  nuit_traverse_minuit: 0, max_duree_minutes: 960,
};
const WORKDAY = { day_type: 'workday', libelle: null, scheduled_minutes_override: null };
const CONGE = { id: 9, type_conge: 'annuel', date_debut: '2026-08-24', date_fin: '2026-09-04', statut: 'approuve' };
const VIDE = { anomalies: [], workedMinutes: 0, breakMinutes: 0, lastOutUtc: null };
const EVENTS = [{ id: 1, event_type: 'clock_in', local_time: '08:00:00', occurred_at_utc: '2026-08-31 07:00:00.000', utc_offset_minutes: 60 }];

const types = m => m.anomalies.map(a => a.type);

const sansConge = daily.scheduleMetrics([], SCHEDULE, VIDE, WORKDAY, null);
assert(types(sansConge).includes('missing_in'), 'Une absence non justifiée doit rester détectée');

const enConge = daily.scheduleMetrics([], SCHEDULE, VIDE, WORKDAY, CONGE);
assert.strictEqual(enConge.isWorkingDay, false, 'Un jour de congé n’est pas un jour travaillé');
assert.deepStrictEqual(types(enConge), [], 'Aucune anomalie ne doit être créée pendant un congé approuvé');

const pointageEnConge = daily.scheduleMetrics(EVENTS, SCHEDULE, { ...VIDE, workedMinutes: 120 }, WORKDAY, CONGE);
const horsPlanning = pointageEnConge.anomalies.find(a => a.type === 'outside_schedule');
assert(horsPlanning, 'Un pointage pendant un congé doit être signalé');
assert.strictEqual(horsPlanning.day_type, 'conge', 'L’anomalie doit nommer le congé comme cause');
assert.strictEqual(horsPlanning.label, 'annuel', 'Le type de congé doit être tracé');

assert.strictEqual(
  daily.scheduleMetrics([], SCHEDULE, VIDE, null, CONGE).isWorkingDay, false,
  'Un congé doit primer même sans calendrier affecté'
);
assert.doesNotThrow(
  () => daily.scheduleMetrics(EVENTS, SCHEDULE, { ...VIDE, workedMinutes: 120 }, null, CONGE),
  'L’absence de calendrier ne doit pas faire échouer le calcul en congé'
);

/* ── 4. Le congé est individuel : il ne passe pas par le calendrier partagé ── */

const policySource = read('backend/services/pointeuse_v3_policy.js');
assert(
  !/pointeuse_calendar_days[\s\S]{0,200}employes_conges/.test(policySource),
  'Le congé ne doit pas être écrit dans le calendrier, qui est partagé entre agents'
);
assert(
  /activeLeave\(executor, employeId, workDate\)/.test(policySource),
  'La recherche de congé doit être indexée sur l’agent, pas sur un calendrier'
);

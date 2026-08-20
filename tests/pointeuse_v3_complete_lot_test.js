'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('backend/migrations/046_pointeuse_v3_workforce_policy.sql');
for (const table of ['pointeuse_sites','pointeuse_work_calendars','pointeuse_calendar_days']) {
  assert(migration.includes(`CREATE TABLE ${table}`), `Table V3 manquante: ${table}`);
}
assert(/ADD COLUMN calendar_id INT NULL/.test(migration), 'Affectation calendrier requise');
assert(/ADD COLUMN nuit_debut TIME/.test(migration) && /ADD COLUMN nuit_fin TIME/.test(migration), 'Fenêtre de nuit configurable requise');
assert(/pointeuse_v3_mode/.test(migration) && /'shadow'/.test(migration), 'Bascule shadow par défaut requise');

const policySource = read('backend/services/pointeuse_v3_policy.js');
assert(/function haversineMeters/.test(policySource), 'Géofence serveur requise');
assert(/if \(!assignment\) return false/.test(policySource), 'Aucun pointage V3 sans affectation planning');
assert(/utcOffsetMinutes/.test(policySource) && /Intl\.DateTimeFormat/.test(policySource), 'Décalage UTC doit être dérivé du fuseau');

const route = read('backend/routes/pointeuse_v3.js');
assert(/policy\.evaluateLocation/.test(route), 'Le périmètre doit être recalculé côté serveur');
assert(!/horsPerimetre:\s*req\.body/.test(route), 'Le client ne doit jamais imposer hors_perimetre');
assert(/Idempotency-Key/.test(route), 'Clé idempotente obligatoire');
assert(/ATTENDANCE_V3_DISABLED/.test(route), 'Kill-switch V3 requis');
assert(/daily\.recalculateDay/.test(route), 'Recalcul journalier après événement requis');

const dailySource = read('backend/services/pointeuse_v3_daily_service.js');
assert(/governance\.effectiveEvents/.test(dailySource), 'Les corrections approuvées doivent alimenter le calcul effectif');
assert(/minutesInNightWindow/.test(dailySource) && /nightMinutes/.test(dailySource), 'Calcul des heures de nuit requis');
assert(/no_attendance_on_scheduled_day/.test(dailySource), 'Absence planifiée sans pointage doit être détectée');
assert(/DAY_CLOSED/.test(dailySource), 'Une journée clôturée doit être immuable');

const daily = require('../backend/services/pointeuse_v3_daily_service');
assert.strictEqual(
  daily.minutesInNightWindow('2026-08-19 20:00:00.000','2026-08-20 05:00:00.000',60,'22:00','05:00'),
  420,
  '22h-05h doit produire 420 minutes de nuit'
);
const absentMetrics = daily.scheduleMetrics([], { heure_debut:'08:00', heure_fin:'17:00', pause_minutes:60 }, { anomalies:[], workedMinutes:0, lastOutUtc:null }, { day_type:'workday' });
assert(absentMetrics.anomalies.some(a => a.type === 'missing_in'), 'Absence automatique attendue un jour ouvré planifié');
const restMetrics = daily.scheduleMetrics([], { heure_debut:'08:00', heure_fin:'17:00' }, { anomalies:[], workedMinutes:0, lastOutUtc:null }, { day_type:'rest' });
assert(!restMetrics.anomalies.some(a => a.type === 'missing_in'), 'Pas d’absence automatique un jour de repos');

const admin = read('backend/routes/pointeuse_v3_admin.js');
for (const invariant of ['ANOMALY_STATE_RACE','UNRESOLVED_ANOMALIES','PERIOD_SELF_APPROVAL_FORBIDDEN','UNAPPROVED_DAYS','PAYROLL_ALREADY_CONSUMED']) {
  assert(admin.includes(invariant), `Invariant gouvernance manquant: ${invariant}`);
}
assert(/runtime-mode/.test(admin), 'Bascule shadow/active/disabled requise');
assert(/isoDateDaysAgo\(60\)/.test(admin), 'La fenêtre calendrier doit être calculée de façon portable côté serveur');
assert(!/DATE_SUB\s*\(\s*CURDATE/i.test(admin), 'La lecture de configuration V3 ne doit pas dépendre d’une syntaxe date MySQL');
assert(/WHERE d\.work_date >= \?/.test(admin), 'La borne calendrier doit être passée en paramètre SQL');

const gov = read('backend/services/pointeuse_v3_governance.js');
assert(/pointeuse_adjustments/.test(gov), 'Corrections non destructives requises');
assert(/previous_hash/.test(gov) && /event_hash/.test(gov), 'Audit chaîné requis');
assert(/tala\.pointeuse\.payroll-feed\.v1/.test(gov), 'Contrat snapshot paie versionné requis');
assert(/PERIOD_NOT_CLOSED/.test(gov), 'Snapshot paie uniquement après clôture');

const reconcile = read('backend/services/pointeuse_v3_reconciliation.js');
assert(/v2_only/.test(reconcile) && /v3_only/.test(reconcile) && /match_rate/.test(reconcile), 'Rapprochement V2/V3 incomplet');
const shadow = read('backend/services/pointeuse_v3_shadow_sync.js');
assert(/legacy:\$\{row\.id\}/.test(shadow), 'Shadow sync doit être idempotent par pointage V2');
assert(/source,mode/.test(shadow) && /'import'/.test(shadow), 'Shadow sync doit tracer sa source import');

const server = read('backend/server.js');
assert(/pointeuseV3Router/.test(server) && /pointeuseV3GovernanceRouter/.test(server) && /pointeuseV3AdminRouter/.test(server), 'Routeurs V3 doivent être montés');
assert(/pointeuseV3WriteLimiter/.test(server), 'Rate limit métier V3 requis');
assert(/ipKeyGenerator/.test(server), 'Le fallback IP du rate limiter V3 doit normaliser IPv6');
assert(/pointeuse-v3:ip:\$\{ipKeyGenerator\(req\.ip\)\}/.test(server), 'Le rate limiter V3 ne doit pas utiliser req.ip brut');
assert(!/pointeuse-v3:\$\{req\.user\?\.id \|\| req\.ip\}/.test(server), 'Ancien keyGenerator IPv6 vulnérable interdit');
assert(/app\.use\('\/api\/pointeuse\/v3'/.test(server), 'Préfixe API V3 absent');
assert(/app\.use\('\/api\/pointeuse', protectedRoute\(\), pointeuseRouter\)/.test(server), 'V2 doit rester disponible pendant la transition');

const sqliteBootstrap = read('backend/services/pointeuse_v3_sqlite_bootstrap.js');
for (const table of [
  'pointeuse_events',
  'pointeuse_daily_summaries',
  'pointeuse_anomalies',
  'pointeuse_correction_requests',
  'pointeuse_adjustments',
  'pointeuse_audit_events',
  'pointeuse_payroll_snapshots',
]) {
  assert(sqliteBootstrap.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Bootstrap SQLite V3 incomplet: ${table}`);
}
assert(/applied_adjustment_id INTEGER/.test(sqliteBootstrap) && /correlation_id TEXT/.test(sqliteBootstrap), 'Bootstrap corrections SQLite doit couvrir la gouvernance 045');

const ui = read('frontend/js/pages/pointeuse-v3.js');
assert(/aria-live/.test(ui) && /role=\\?"tablist/.test(ui), 'Socle accessibilité cockpit requis');
assert(/Idempotency-Key/.test(ui), 'UI doit fournir une clé idempotente');
const eventBlock = ui.match(/async function sendEvent[\s\S]*?function bindBody/)?.[0] || '';
assert(!/heure_entree|heure_sortie|occurred_at_utc/.test(eventBlock), 'UI de pointage ne doit jamais envoyer un horaire client');
assert(/navigator\.geolocation/.test(ui), 'Support GPS navigateur requis');
assert(/mode !== 'active'/.test(ui) && /removeV3Ui/.test(ui), 'Le nouveau cockpit doit rester invisible tant que le moteur n’est pas actif');
for (const forbidden of ['Mode observation','actions V2 maintenues','Rapprochement','Parallèle V2 / V3','Cycle industriel','Événements immuables']) {
  assert(!ui.includes(forbidden), `Vocabulaire technique interdit dans l’UI métier: ${forbidden}`);
}
assert(ui.includes('Pointeuse') && ui.includes('Présences, pauses, retards et corrections'), 'Le vocabulaire visible doit rester métier');

const adminUi = read('frontend/js/pages/pointeuse-v3-admin-ui.js');
for (const forbidden of ['/admin/sites','/admin/schedules','/admin/calendars','/admin/assignments','/admin/periods','/admin/runtime-mode','Bascule contrôlée','Mode V3']) {
  assert(!adminUi.includes(forbidden), `La console technique ne doit pas être injectée dans la page métier: ${forbidden}`);
}
assert(/volontairement neutre/.test(adminUi), 'Le bundle admin doit rester neutre sur la page métier');

const transport = read('frontend/js/core/transport.js');
assert(/pointeuse-v3\.js/.test(transport) && /pointeuse-v3-admin-ui\.js/.test(transport), 'Bundles UI Pointeuse V3 non chargés');

console.log(JSON.stringify({
  pointeuseV3CompleteLot:true,
  serverAuthority:true,
  appendOnly:true,
  concurrency:true,
  calendars:true,
  nightWork:true,
  geofence:true,
  corrections:true,
  auditChain:true,
  payrollSnapshot:true,
  shadowReconciliation:true,
  accessibleCockpit:true,
  rollbackMode:true,
  businessLanguageUi:true,
  technicalUiHiddenUntilActivation:true,
  crossDriverAdminConfig:true,
  ipv6SafeRateLimit:true,
  sqliteBrowserBootstrap:true
}));

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../backend/services/pointeuse_v3_engine');

const root = path.join(__dirname, '..');
const engineSource = fs.readFileSync(path.join(root, 'backend/services/pointeuse_v3_engine.js'), 'utf8');
const shadowSource = fs.readFileSync(path.join(root, 'backend/services/pointeuse_v3_shadow_sync.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(root, 'backend/routes/pointeuse_v3.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'backend/routes/pointeuse_v3_admin.js'), 'utf8');

assert(engineSource.includes('assertWorkDateOpen(tx, employeId, workDate)'), 'recordEvent doit vérifier la clôture dans sa transaction');
assert(engineSource.indexOf('assertWorkDateOpen(tx, employeId, workDate)') < engineSource.indexOf('INSERT INTO pointeuse_events'), 'la clôture doit être vérifiée avant insertion physique');
assert(engineSource.includes("status = 'closed'"), 'le moteur doit reconnaître les journées/périodes clôturées');
assert(engineSource.includes("'PERIOD_CLOSED'"), 'une période clôturée doit bloquer un événement physique');

assert(shadowSource.includes('engine.assertWorkDateOpen'), 'shadow-sync doit utiliser le même invariant de clôture');
assert(shadowSource.includes('skipped_closed_rows'), 'shadow-sync doit rendre visibles les lignes ignorées car clôturées');
assert(!/if \(error\.code !== 'DAY_CLOSED'\) throw error/.test(shadowSource), 'shadow-sync ne doit plus insérer puis ignorer DAY_CLOSED au recalcul');

assert(routeSource.includes('CORRECTION_WORK_DATE_MISMATCH'), 'une heure corrigée hors work_date doit être refusée');
assert(routeSource.includes('INVALID_CORRECTION_DATETIME'), 'un requested_at_utc invalide doit être refusé');
assert(routeSource.includes('engine.utcParts(requestedAt, timezone).localDate'), 'la cohérence correction/journée doit être évaluée dans le fuseau métier');

assert(adminSource.includes('ASSIGNMENT_DATE_OVERLAP'), 'les affectations chevauchantes doivent être refusées');
assert(adminSource.includes('SELECT id FROM employes WHERE id=?${forUpdate}'), 'la création d’affectation doit sérialiser par agent');
assert(adminSource.includes('SELECT employe_id,date_debut,date_fin FROM pointeuse_schedule_assignments'), 'le calcul de période doit charger les fenêtres d’affectation');
assert(adminSource.includes('workDates.add(`${employeId}:${d}`)'), 'le calcul doit être borné aux couples agent/date réellement couverts');
assert(!adminSource.includes('SELECT DISTINCT employe_id FROM pointeuse_schedule_assignments WHERE date_debut<=?'), 'l’ancien calcul sur toute la période ne doit pas subsister');

(async () => {
  const dayClosedExecutor = {
    queryOne: async sql => sql.includes('pointeuse_daily_summaries') ? { id: 1 } : null,
  };
  await assert.rejects(
    () => engine.assertWorkDateOpen(dayClosedExecutor, 42, '2026-08-20'),
    err => err.code === 'DAY_CLOSED' && err.status === 409,
    'une journée clôturée doit bloquer avant écriture'
  );

  const periodClosedExecutor = {
    queryOne: async sql => sql.includes('pointeuse_daily_summaries') ? null : { id: 9 },
  };
  await assert.rejects(
    () => engine.assertWorkDateOpen(periodClosedExecutor, 42, '2026-08-20'),
    err => err.code === 'PERIOD_CLOSED' && err.status === 409,
    'une période clôturée doit bloquer avant écriture'
  );

  const openExecutor = { queryOne: async () => null };
  await engine.assertWorkDateOpen(openExecutor, 42, '2026-08-20');

  console.log(JSON.stringify({
    closedDatePhysicalWriteGuard: true,
    shadowClosedDateGuard: true,
    correctionWorkDateGuard: true,
    assignmentOverlapGuard: true,
    assignmentWindowPeriodCalculation: true,
  }));
})().catch(error => {
  console.error(error);
  process.exit(1);
});

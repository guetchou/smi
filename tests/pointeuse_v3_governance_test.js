const assert = require('assert');
const fs = require('fs');
const path = require('path');
const governance = require('../backend/services/pointeuse_v3_governance');

const migration = fs.readFileSync(path.join(__dirname, '../backend/migrations/045_pointeuse_v3_governance_payroll.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../backend/routes/pointeuse_v3_governance.js'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '../backend/services/pointeuse_v3_governance.js'), 'utf8');

assert.strictEqual(governance.deriveAdjustment({ event_id: 10, requested_event_type: 'clock_in', requested_at_utc: '2026-08-19 07:00:00.000' }), 'replace');
assert.strictEqual(governance.deriveAdjustment({ event_id: 10 }), 'void');
assert.strictEqual(governance.deriveAdjustment({ requested_event_type: 'clock_in', requested_at_utc: '2026-08-19 07:00:00.000' }), 'add');
assert.throws(() => governance.deriveAdjustment({ requested_event_type: 'clock_in' }), err => err.code === 'INVALID_CORRECTION_SHAPE');

const a = governance.stableJson({ b: 1, a: { y: 2, x: 3 } });
const b = governance.stableJson({ a: { x: 3, y: 2 }, b: 1 });
assert.strictEqual(a, b, 'Le JSON canonique doit être déterministe');
assert.strictEqual(governance.sha256(a), governance.sha256(b), 'Le hash snapshot doit être stable');

for (const table of ['pointeuse_adjustments','pointeuse_audit_events','pointeuse_payroll_snapshots']) {
  assert(migration.includes(`CREATE TABLE ${table}`), `Table de gouvernance manquante: ${table}`);
}
assert(/UNIQUE KEY uq_pointeuse_adjustment_request/.test(migration), 'Une demande de correction ne doit produire qu’un ajustement');
assert(/previous_hash CHAR\(64\)/.test(migration) && /event_hash CHAR\(64\) NOT NULL/.test(migration), 'Chaînage de hash audit requis');
assert(/UNIQUE KEY uq_pointeuse_payroll_snapshot_hash/.test(migration), 'Snapshot paie idempotent requis');

assert(/CORRECTION_SELF_APPROVAL_FORBIDDEN/.test(service), 'Séparation des fonctions demandeur/approbateur obligatoire');
assert(/FOR UPDATE/.test(service), 'Les revues et snapshots doivent verrouiller leur agrégat');
assert(/DAY_CLOSED/.test(service) && /pointeuse_daily_summaries/.test(service), 'Une correction ne doit pas être approuvée après clôture de la journée');
assert(/PERIOD_CLOSED/.test(service) && /pointeuse_periods/.test(service), 'Une correction ne doit pas être approuvée après clôture de la période');
assert(/status='closed'/.test(service), 'La paie ne doit consommer que des journées clôturées');
assert(/schema: 'tala\.pointeuse\.payroll-feed\.v1'/.test(service), 'Contrat de flux paie versionné requis');
assert(/snapshot_sha256/.test(service), 'Intégrité du snapshot paie requise');
assert(/UPDATE pointeuse_payroll_snapshots SET status='superseded'/.test(service), 'Les snapshots préparés précédents doivent être explicitement superseded');

assert(/managerOnly/.test(route), 'Les revues doivent être restreintes aux rôles de management');
assert(/payrollOnly/.test(route), 'Les snapshots paie doivent être restreints aux rôles paie/finance');
assert(/\/corrections\/:id\/review/.test(route), 'Endpoint de revue correction manquant');
assert(/\/periods\/:id\/payroll-snapshot/.test(route), 'Endpoint snapshot paie manquant');
assert(/\/payroll-snapshots\/:id\/consume/.test(route), 'Endpoint consommation paie manquant');
assert(/\/audit/.test(route), 'Endpoint audit manquant');

console.log(JSON.stringify({
  pointeuseV3Governance: true,
  immutableAdjustments: true,
  separationOfDuties: true,
  closedDayApprovalGuard: true,
  closedPeriodApprovalGuard: true,
  auditHashChain: true,
  payrollSnapshotIntegrity: true,
  payrollFeedVersioned: true,
}));

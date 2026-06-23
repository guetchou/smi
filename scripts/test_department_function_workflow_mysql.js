'use strict';

process.env.DB_DRIVER = 'mysql';
const assert = require('assert');
const db = require('../backend/db');
require('../backend/services/department_function_notification_guard').installDepartmentFunctionNotificationGuard();
const workflow = require('../backend/services/department_function_workflow');
const units = require('../backend/services/organization_units');
const structure = require('../backend/services/department_function_structure');

const stage = process.env.TEST_STAGE || 'all';

async function expectCode(promise, code) {
  try {
    await promise;
    assert.fail(`Erreur ${code} attendue`);
  } catch (error) {
    assert.strictEqual(error.code, code, error.message);
  }
}

async function fixture(label) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let enterprise = await db.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
  if (!enterprise) {
    const result = await db.execute(
      'INSERT INTO entreprise (raison_sociale, nom_commercial, actif) VALUES (?,?,1)',
      [`CI ${suffix}`, `CI ${suffix}`],
    );
    enterprise = { id: result.insertId };
  }

  const rhUser = await db.execute(
    'INSERT INTO users (nom,email,password_hash,role,actif) VALUES (?,?,?,?,1)',
    [`RH CI ${suffix}`, `rh-${suffix}@test.local`, 'ci-hash', 'rh'],
  );
  const dgUser = await db.execute(
    'INSERT INTO users (nom,email,password_hash,role,actif) VALUES (?,?,?,?,1)',
    [`DG CI ${suffix}`, `dg-${suffix}@test.local`, 'ci-hash', 'dg'],
  );
  const post = await db.execute(
    'INSERT INTO org_postes (libelle,description,actif) VALUES (?,?,1)',
    [`Poste CI ${suffix}`, 'Test intégration'],
  );
  const dept = await db.execute(
    'INSERT INTO org_departements (libelle,code,actif) VALUES (?,?,1)',
    [`Département CI ${suffix}`, `CI-${suffix}`],
  );
  const chief = await db.execute(`
    INSERT INTO employes
      (nom,prenom,poste,poste_id,departement,site,matricule,actif,statut_dossier,date_embauche)
    VALUES (?,?,?,?,?,?,?,?,?,CURDATE())
  `, [`Chef-${suffix}`, 'Test', `Poste CI ${suffix}`, post.insertId,
      `Département CI ${suffix}`, 'CI', `CH-${suffix}`, 1, 'actif']);
  const deputy = await db.execute(`
    INSERT INTO employes
      (nom,prenom,poste,poste_id,departement,site,matricule,actif,statut_dossier,date_embauche)
    VALUES (?,?,?,?,?,?,?,?,?,CURDATE())
  `, [`Adjoint-${suffix}`, 'Test', `Poste CI ${suffix}`, post.insertId,
      `Département CI ${suffix}`, 'CI', `AD-${suffix}`, 1, 'actif']);

  return { suffix, enterprise, rhUser, dgUser, post, dept, chief, deputy };
}

async function chiefPhase() {
  const ctx = await fixture('chief');
  await db.execute('UPDATE org_departements SET responsable_id=? WHERE id=?', [ctx.chief.insertId, ctx.dept.insertId]);

  const draft = await workflow.createDraft({
    departement_id: ctx.dept.insertId,
    employe_id: ctx.chief.insertId,
    fonction_type: 'chef',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Nomination CI du chef',
    decision_reference: `DEC-CHEF-${ctx.suffix}`,
  }, ctx.rhUser.insertId);
  const documented = await workflow.attachDocument(draft.id, {
    version: draft.version,
    document_nom: 'decision-chef.pdf',
    document_url: `/ci/decision-chef-${ctx.suffix}.pdf`,
    document_hash: 'a'.repeat(64),
  }, ctx.rhUser.insertId);
  const submitted = await workflow.submit(documented.id, documented.version, ctx.rhUser.insertId);
  await expectCode(
    workflow.approve(submitted.id, submitted.version, ctx.rhUser.insertId),
    'SELF_APPROVAL_FORBIDDEN',
  );
  const active = await workflow.approve(submitted.id, submitted.version, ctx.dgUser.insertId);
  assert.strictEqual(active.statut, workflow.STATUS.ACTIVE);
  const detail = await workflow.get(active.id);
  assert(detail.events.some(event => event.event_type === 'activated'));
  return { chief_status: active.statut, chief_events: detail.events.length };
}

async function unitsPhase() {
  const ctx = await fixture('units');
  const draft = await workflow.createDraft({
    departement_id: ctx.dept.insertId,
    employe_id: ctx.deputy.insertId,
    fonction_type: 'adjoint',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Nomination CI de l’adjoint',
    decision_reference: `DEC-ADJ-${ctx.suffix}`,
  }, ctx.rhUser.insertId);

  const serviceUnit = await units.create(ctx.dept.insertId, {
    type_unite: 'service',
    code: `SRV-${ctx.suffix}`,
    libelle: `Service CI ${ctx.suffix}`,
    description: 'Unité de test',
  }, ctx.rhUser.insertId);
  const sectionUnit = await units.create(ctx.dept.insertId, {
    type_unite: 'section',
    code: `SEC-${ctx.suffix}`,
    libelle: `Section CI ${ctx.suffix}`,
    parent_id: serviceUnit.id,
  }, ctx.rhUser.insertId);
  await expectCode(units.update(serviceUnit.id, {
    version: serviceUnit.version,
    parent_id: sectionUnit.id,
    type_unite: serviceUnit.type_unite,
    libelle: serviceUnit.libelle,
  }, ctx.rhUser.insertId), 'UNIT_CYCLE_FORBIDDEN');

  const structured = await structure.setStructure(draft.id, {
    version: draft.version,
    unite_id: serviceUnit.id,
    poste_id: ctx.post.insertId,
  }, ctx.rhUser.insertId);
  assert.strictEqual(Number(structured.unite_id), Number(serviceUnit.id));
  await expectCode(workflow.updateDraft(draft.id, {
    version: draft.version,
    date_debut: draft.date_debut,
    motif: 'Version obsolète',
  }, ctx.rhUser.insertId), 'FUNCTION_VERSION_CONFLICT');

  const submitted = await workflow.submit(structured.id, structured.version, ctx.rhUser.insertId);
  const active = await workflow.approve(submitted.id, submitted.version, ctx.dgUser.insertId);
  assert.strictEqual(active.statut, workflow.STATUS.ACTIVE);
  const detail = await workflow.get(active.id);
  assert(detail.events.some(event => event.event_type === 'structure_updated'));
  assert(detail.events.some(event => event.event_type === 'activated'));
  return { deputy_status: active.statut, unit_cycle_blocked: true, stale_version_blocked: true };
}

async function refusalPhase() {
  const ctx = await fixture('refusal');
  const draft = await workflow.createDraft({
    departement_id: ctx.dept.insertId,
    employe_id: ctx.deputy.insertId,
    fonction_type: 'coordonnateur',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Demande CI à refuser',
    decision_reference: `DEC-REF-${ctx.suffix}`,
  }, ctx.rhUser.insertId);
  const submitted = await workflow.submit(draft.id, draft.version, ctx.rhUser.insertId);
  const refused = await workflow.refuse(
    submitted.id,
    submitted.version,
    'Refus CI contrôlé',
    ctx.dgUser.insertId,
  );
  assert.strictEqual(refused.statut, workflow.STATUS.REFUSED);
  const detail = await workflow.get(refused.id);
  assert(detail.events.some(event => event.event_type === 'submitted'));
  assert(detail.events.some(event => event.event_type === 'refused'));
  const audit = await db.queryOne(
    "SELECT COUNT(*) AS total FROM audit_logs WHERE table_name='org_departement_fonctions' AND record_id=?",
    [refused.id],
  );
  assert(Number(audit.total) >= 3);
  return { refused_status: refused.statut, audit_events: Number(audit.total) };
}

async function main() {
  console.log(`[integration-stage] ${stage}`);
  const result = { ok: true, stage };
  if (stage === 'chief' || stage === 'all') Object.assign(result, await chiefPhase());
  if (stage === 'units' || stage === 'all') Object.assign(result, await unitsPhase());
  if (stage === 'refusal' || stage === 'all') Object.assign(result, await refusalPhase());
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => db._pool.end()).catch(async error => {
  console.error(`[department-function-workflow-integration:${stage}]`, error.stack || error.message);
  try { await db._pool.end(); } catch (_) {}
  process.exitCode = 1;
});

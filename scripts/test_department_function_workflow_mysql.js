'use strict';

process.env.DB_DRIVER = 'mysql';
const assert = require('assert');
const db = require('../backend/db');
require('../backend/services/department_function_notification_guard').installDepartmentFunctionNotificationGuard();
const workflow = require('../backend/services/department_function_workflow');
const units = require('../backend/services/organization_units');
const structure = require('../backend/services/department_function_structure');

async function expectCode(promise, code) {
  try {
    await promise;
    assert.fail(`Erreur ${code} attendue`);
  } catch (error) {
    assert.strictEqual(error.code, code, error.message);
  }
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let enterprise = await db.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
  if (!enterprise) {
    const result = await db.execute('INSERT INTO entreprise (raison_sociale, nom_commercial, actif) VALUES (?,?,1)', [`CI ${suffix}`, `CI ${suffix}`]);
    enterprise = { id: result.insertId };
  }

  const rhUser = await db.execute('INSERT INTO users (nom,email,password_hash,role,actif) VALUES (?,?,?,?,1)', [`RH CI ${suffix}`, `rh-${suffix}@test.local`, 'ci-hash', 'rh']);
  const dgUser = await db.execute('INSERT INTO users (nom,email,password_hash,role,actif) VALUES (?,?,?,?,1)', [`DG CI ${suffix}`, `dg-${suffix}@test.local`, 'ci-hash', 'dg']);
  const post = await db.execute('INSERT INTO org_postes (libelle,description,actif) VALUES (?,?,1)', [`Poste CI ${suffix}`, 'Test intégration']);
  const dept = await db.execute('INSERT INTO org_departements (libelle,code,actif) VALUES (?,?,1)', [`Département CI ${suffix}`, `CI-${Date.now()}`]);

  const chief = await db.execute(`
    INSERT INTO employes (nom,prenom,poste,poste_id,departement,site,matricule,actif,statut_dossier,date_embauche)
    VALUES (?,?,?,?,?,?,?,?,?,CURDATE())
  `, [`Chef-${suffix}`, 'Test', `Poste CI ${suffix}`, post.insertId, `Département CI ${suffix}`, 'CI', `CH-${suffix}`, 1, 'actif']);
  const deputy = await db.execute(`
    INSERT INTO employes (nom,prenom,poste,poste_id,departement,site,matricule,actif,statut_dossier,date_embauche)
    VALUES (?,?,?,?,?,?,?,?,?,CURDATE())
  `, [`Adjoint-${suffix}`, 'Test', `Poste CI ${suffix}`, post.insertId, `Département CI ${suffix}`, 'CI', `AD-${suffix}`, 1, 'actif']);
  await db.execute('UPDATE org_departements SET responsable_id=? WHERE id=?', [chief.insertId, dept.insertId]);

  const chiefFunction = await workflow.createDraft({
    departement_id: dept.insertId,
    employe_id: chief.insertId,
    fonction_type: 'chef',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Nomination CI du chef',
    decision_reference: `DEC-CHEF-${suffix}`,
  }, rhUser.insertId);
  const chiefDoc = await workflow.attachDocument(chiefFunction.id, {
    version: chiefFunction.version,
    document_nom: 'decision-chef.pdf',
    document_url: `/ci/decision-chef-${suffix}.pdf`,
    document_hash: 'a'.repeat(64),
  }, rhUser.insertId);
  const chiefSubmitted = await workflow.submit(chiefDoc.id, chiefDoc.version, rhUser.insertId);
  await expectCode(workflow.approve(chiefSubmitted.id, chiefSubmitted.version, rhUser.insertId), 'SELF_APPROVAL_FORBIDDEN');
  const chiefActive = await workflow.approve(chiefSubmitted.id, chiefSubmitted.version, dgUser.insertId);
  assert.strictEqual(chiefActive.statut, workflow.STATUS.ACTIVE);

  const deputyDraft = await workflow.createDraft({
    departement_id: dept.insertId,
    employe_id: deputy.insertId,
    fonction_type: 'adjoint',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Nomination CI de l’adjoint',
    decision_reference: `DEC-ADJ-${suffix}`,
  }, rhUser.insertId);

  const serviceUnit = await units.create(dept.insertId, {
    type_unite: 'service',
    code: `SRV-${Date.now()}`,
    libelle: `Service CI ${suffix}`,
    description: 'Unité de test',
  }, rhUser.insertId);
  const sectionUnit = await units.create(dept.insertId, {
    type_unite: 'section',
    code: `SEC-${Date.now()}`,
    libelle: `Section CI ${suffix}`,
    parent_id: serviceUnit.id,
  }, rhUser.insertId);
  await expectCode(units.update(serviceUnit.id, {
    version: serviceUnit.version,
    parent_id: sectionUnit.id,
    type_unite: serviceUnit.type_unite,
    libelle: serviceUnit.libelle,
  }, rhUser.insertId), 'UNIT_CYCLE_FORBIDDEN');

  const structured = await structure.setStructure(deputyDraft.id, {
    version: deputyDraft.version,
    unite_id: serviceUnit.id,
    poste_id: post.insertId,
  }, rhUser.insertId);
  assert.strictEqual(Number(structured.unite_id), Number(serviceUnit.id));
  await expectCode(workflow.updateDraft(deputyDraft.id, {
    version: deputyDraft.version,
    date_debut: deputyDraft.date_debut,
    motif: 'Version obsolète',
  }, rhUser.insertId), 'FUNCTION_VERSION_CONFLICT');

  const deputySubmitted = await workflow.submit(structured.id, structured.version, rhUser.insertId);
  const deputyActive = await workflow.approve(deputySubmitted.id, deputySubmitted.version, dgUser.insertId);
  assert.strictEqual(deputyActive.statut, workflow.STATUS.ACTIVE);

  const refusalDraft = await workflow.createDraft({
    departement_id: dept.insertId,
    employe_id: deputy.insertId,
    fonction_type: 'coordonnateur',
    date_debut: new Date().toISOString().slice(0, 10),
    motif: 'Demande CI à refuser',
    decision_reference: `DEC-REF-${suffix}`,
  }, rhUser.insertId);
  const refusalSubmitted = await workflow.submit(refusalDraft.id, refusalDraft.version, rhUser.insertId);
  const refused = await workflow.refuse(refusalSubmitted.id, refusalSubmitted.version, 'Refus CI contrôlé', dgUser.insertId);
  assert.strictEqual(refused.statut, workflow.STATUS.REFUSED);

  const detail = await workflow.get(deputyActive.id);
  assert(detail.events.some(event => event.event_type === 'submitted'));
  assert(detail.events.some(event => event.event_type === 'approved'));
  assert(detail.events.some(event => event.event_type === 'activated'));

  const audit = await db.queryOne("SELECT COUNT(*) AS total FROM audit_logs WHERE table_name='org_departement_fonctions' AND record_id=?", [deputyActive.id]);
  assert(Number(audit.total) >= 4);

  console.log(JSON.stringify({
    ok: true,
    chief_status: chiefActive.statut,
    deputy_status: deputyActive.statut,
    refused_status: refused.statut,
    unit_cycle_blocked: true,
    stale_version_blocked: true,
    events: detail.events.length,
  }, null, 2));
}

main().then(() => db._pool.end()).catch(async error => {
  console.error('[department-function-workflow-integration]', error.stack || error.message);
  try { await db._pool.end(); } catch (_) {}
  process.exitCode = 1;
});

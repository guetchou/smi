'use strict';

const db = require('../db');
const workflow = require('./department_function_workflow');

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function fail(message, code, status = 400, details = null) {
  throw new workflow.DepartmentFunctionWorkflowError(message, code, status, details);
}

function validate(input = {}) {
  const data = {
    departement_id: positiveInt(input.departement_id),
    employe_id: positiveInt(input.employe_id),
    fonction_type: clean(input.fonction_type),
    rang: Number.isFinite(Number(input.rang)) ? Math.max(0, Number(input.rang)) : 0,
    perimetre: clean(input.perimetre) || null,
    motif: clean(input.motif),
    date_debut: clean(input.date_debut),
    date_fin: clean(input.date_fin) || null,
    titulaire: input.titulaire === false || Number(input.titulaire) === 0 ? 0 : 1,
    decision_reference: clean(input.decision_reference) || null,
  };

  if (!data.departement_id || !data.employe_id) fail('Département et agent sont obligatoires.', 'FUNCTION_IDENTITY_REQUIRED');
  if (!Object.prototype.hasOwnProperty.call(workflow.FUNCTION_LABELS, data.fonction_type)) fail('Type de fonction invalide.', 'INVALID_FUNCTION_TYPE');
  if (!validDate(data.date_debut)) fail('Date de début invalide.', 'INVALID_START_DATE');
  if (data.date_fin && !validDate(data.date_fin)) fail('Date de fin invalide.', 'INVALID_END_DATE');
  if (data.date_fin && data.date_fin < data.date_debut) fail('La date de fin ne peut pas précéder la date de début.', 'INVALID_DATE_RANGE');
  if (['interimaire', 'suppleant'].includes(data.fonction_type) && !data.date_fin) fail('Une fonction temporaire doit avoir une date de fin.', 'TEMPORARY_END_REQUIRED');
  if (!data.motif) fail('Le motif est obligatoire.', 'MOTIVE_REQUIRED');
  return data;
}

async function createDraft(input, actorUserId) {
  const data = validate(input);
  return db.transaction(async tx => {
    const dept = await tx.queryOne('SELECT id, libelle, actif FROM org_departements WHERE id=? FOR UPDATE', [data.departement_id]);
    if (!dept || !dept.actif) fail('Département introuvable ou inactif.', 'DEPARTMENT_NOT_ACTIVE', 404);

    const agent = await tx.queryOne(`
      SELECT id, nom, prenom, poste, departement, email, actif, statut_dossier
      FROM employes WHERE id=? FOR UPDATE
    `, [data.employe_id]);
    if (!agent || !agent.actif || ['sorti', 'archive'].includes(String(agent.statut_dossier || '').toLowerCase())) {
      fail('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_ACTIVE', 409);
    }
    if (clean(agent.departement) !== clean(dept.libelle)) {
      fail(`L’agent doit appartenir au département « ${dept.libelle} ».`, 'EMPLOYEE_DEPARTMENT_MISMATCH', 409, {
        employee_department: agent.departement || null,
        expected_department: dept.libelle,
      });
    }

    const duplicate = await tx.queryOne(`
      SELECT id, statut FROM org_departement_fonctions
      WHERE departement_id=? AND employe_id=? AND fonction_type=?
        AND statut IN ('brouillon','soumis','approuve','actif','a_corriger')
      LIMIT 1 FOR UPDATE
    `, [dept.id, agent.id, data.fonction_type]);
    if (duplicate) fail('Une demande active existe déjà pour cet agent et cette fonction.', 'ACTIVE_FUNCTION_REQUEST_EXISTS', 409, duplicate);

    const enterprise = await tx.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
    const inserted = await tx.execute(`
      INSERT INTO org_departement_fonctions
        (entreprise_id, departement_id, employe_id, fonction_type, statut, version,
         rang, perimetre, motif, date_debut, date_fin, titulaire, actif,
         decision_reference, created_by, created_at, updated_at)
      VALUES (?,?,?,?, 'brouillon', 1, ?,?,?,?,?,?,0,?,?,NOW(),NOW())
    `, [
      enterprise?.id || null,
      dept.id,
      agent.id,
      data.fonction_type,
      data.rang,
      data.perimetre,
      data.motif,
      data.date_debut,
      data.date_fin,
      data.titulaire,
      data.decision_reference,
      actorUserId || null,
    ]);

    const row = await tx.queryOne(`
      SELECT f.*,
             e.nom AS employe_nom, e.prenom AS employe_prenom, e.poste AS employe_poste,
             e.departement AS employe_departement, e.email AS employe_email,
             d.libelle AS departement_libelle, d.responsable_id AS departement_responsable_id
      FROM org_departement_fonctions f
      JOIN employes e ON e.id=f.employe_id
      JOIN org_departements d ON d.id=f.departement_id
      WHERE f.id=?
    `, [inserted.insertId]);

    await tx.execute(`
      INSERT INTO org_departement_fonction_events
        (entreprise_id, fonction_id, event_type, statut_avant, statut_apres,
         version_avant, version_apres, details, actor_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, [
      row.entreprise_id || null,
      row.id,
      'draft_created',
      null,
      row.statut,
      null,
      row.version,
      JSON.stringify({ input: data, source: 'create_draft_fix' }),
      actorUserId || null,
    ]);
    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES ('org_departement_fonctions', ?, 'draft_created', ?, ?, NOW())
    `, [row.id, JSON.stringify({ statut_apres: row.statut, version_apres: row.version }), actorUserId || null]);

    return row;
  });
}

function installDepartmentFunctionCreateDraftFix() {
  if (workflow.__createDraftFixInstalled) return workflow;
  workflow.createDraft = createDraft;
  workflow.__createDraftFixInstalled = true;
  return workflow;
}

module.exports = { installDepartmentFunctionCreateDraftFix };

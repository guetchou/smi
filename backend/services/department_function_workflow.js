'use strict';

const db = require('../db');
const notifSvc = require('./notif');

const STATUS = Object.freeze({
  DRAFT: 'brouillon',
  SUBMITTED: 'soumis',
  APPROVED: 'approuve',
  REFUSED: 'refuse',
  ACTIVE: 'actif',
  NEEDS_CORRECTION: 'a_corriger',
  CANCELLED: 'annule',
  CLOSED: 'cloture',
});

const FUNCTION_LABELS = Object.freeze({
  chef: 'Chef de département',
  premier_adjoint: 'Premier adjoint',
  adjoint: 'Adjoint',
  interimaire: 'Responsable intérimaire',
  suppleant: 'Suppléant',
  chef_service: 'Chef de service',
  chef_section: 'Chef de section',
  coordonnateur: 'Coordonnateur',
});

const TEMPORARY_TYPES = new Set(['interimaire', 'suppleant']);
const DOCUMENT_REQUIRED_TYPES = new Set(['chef', 'premier_adjoint', 'interimaire', 'suppleant']);
const ACTIVE_SINGLETON_TYPES = new Set(['chef', 'premier_adjoint', 'interimaire']);
const EDITABLE_STATUSES = new Set([STATUS.DRAFT, STATUS.REFUSED, STATUS.NEEDS_CORRECTION]);
const CANCELLABLE_STATUSES = new Set([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.APPROVED, STATUS.REFUSED, STATUS.NEEDS_CORRECTION]);

class DepartmentFunctionWorkflowError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'DepartmentFunctionWorkflowError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function asInt(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function fullName(row, prefix = '') {
  const nom = row?.[`${prefix}nom`] || row?.nom || '';
  const prenom = row?.[`${prefix}prenom`] || row?.prenom || '';
  return `${nom} ${prenom}`.trim();
}

function requireVersion(input) {
  const version = Number(input?.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new DepartmentFunctionWorkflowError('La version du dossier est obligatoire.', 'VERSION_REQUIRED', 409);
  }
  return version;
}

async function activeEnterprise(executor = db) {
  return executor.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
}

async function department(id, executor = db, lock = false) {
  return executor.queryOne(`
    SELECT id, libelle, code, responsable_id, actif
    FROM org_departements
    WHERE id=? ${lock ? 'FOR UPDATE' : ''}
  `, [Number(id)]);
}

async function employee(id, executor = db, lock = false) {
  return executor.queryOne(`
    SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique,
           email, actif, statut_dossier
    FROM employes
    WHERE id=? ${lock ? 'FOR UPDATE' : ''}
  `, [Number(id)]);
}

async function functionRow(id, executor = db, lock = false) {
  return executor.queryOne(`
    SELECT f.*,
           e.nom AS employe_nom, e.prenom AS employe_prenom, e.poste AS employe_poste,
           e.departement AS employe_departement, e.email AS employe_email,
           d.libelle AS departement_libelle, d.responsable_id AS departement_responsable_id
    FROM org_departement_fonctions f
    JOIN employes e ON e.id=f.employe_id
    JOIN org_departements d ON d.id=f.departement_id
    WHERE f.id=? ${lock ? 'FOR UPDATE' : ''}
  `, [Number(id)]);
}

function assertEmployeeAvailable(row, dept) {
  if (!row || !row.actif || ['sorti', 'archive'].includes(String(row.statut_dossier || '').toLowerCase())) {
    throw new DepartmentFunctionWorkflowError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_ACTIVE', 409);
  }
  if (clean(row.departement) !== clean(dept.libelle)) {
    throw new DepartmentFunctionWorkflowError(
      `L’agent doit appartenir au département « ${dept.libelle} ».`,
      'EMPLOYEE_DEPARTMENT_MISMATCH',
      409,
      { employee_department: row.departement || null, expected_department: dept.libelle },
    );
  }
}

function validateInput(input, { requireIdentity = true } = {}) {
  const out = {
    departement_id: asInt(input?.departement_id),
    employe_id: asInt(input?.employe_id),
    fonction_type: clean(input?.fonction_type),
    rang: Number.isFinite(Number(input?.rang)) ? Math.max(0, Number(input.rang)) : 0,
    perimetre: clean(input?.perimetre) || null,
    date_debut: clean(input?.date_debut),
    date_fin: clean(input?.date_fin) || null,
    motif: clean(input?.motif),
    decision_reference: clean(input?.decision_reference) || null,
    titulaire: input?.titulaire === false || Number(input?.titulaire) === 0 ? 0 : 1,
  };

  if (requireIdentity && (!out.departement_id || !out.employe_id)) {
    throw new DepartmentFunctionWorkflowError('Département et agent sont obligatoires.', 'FUNCTION_IDENTITY_REQUIRED');
  }
  if (!Object.prototype.hasOwnProperty.call(FUNCTION_LABELS, out.fonction_type)) {
    throw new DepartmentFunctionWorkflowError('Type de fonction invalide.', 'INVALID_FUNCTION_TYPE');
  }
  if (!validDate(out.date_debut)) {
    throw new DepartmentFunctionWorkflowError('Date de début invalide.', 'INVALID_START_DATE');
  }
  if (out.date_fin && !validDate(out.date_fin)) {
    throw new DepartmentFunctionWorkflowError('Date de fin invalide.', 'INVALID_END_DATE');
  }
  if (out.date_fin && out.date_fin < out.date_debut) {
    throw new DepartmentFunctionWorkflowError('La date de fin ne peut pas précéder la date de début.', 'INVALID_DATE_RANGE');
  }
  if (TEMPORARY_TYPES.has(out.fonction_type) && !out.date_fin) {
    throw new DepartmentFunctionWorkflowError('Une fonction temporaire doit avoir une date de fin.', 'TEMPORARY_END_REQUIRED');
  }
  if (!out.motif) {
    throw new DepartmentFunctionWorkflowError('Le motif est obligatoire.', 'MOTIVE_REQUIRED');
  }
  return out;
}

async function writeEvent(tx, row, eventType, before, after, actorUserId, details = {}) {
  await tx.execute(`
    INSERT INTO org_departement_fonction_events
      (entreprise_id, fonction_id, event_type, statut_avant, statut_apres,
       version_avant, version_apres, details, actor_user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `, [
    row.entreprise_id || null,
    Number(row.id),
    eventType,
    before?.statut || null,
    after?.statut || null,
    before?.version || null,
    after?.version || null,
    JSON.stringify(details || {}),
    actorUserId || null,
  ]);

  await tx.execute(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
    VALUES ('org_departement_fonctions', ?, ?, ?, ?, NOW())
  `, [Number(row.id), eventType, JSON.stringify({
    statut_avant: before?.statut || null,
    statut_apres: after?.statut || null,
    version_avant: before?.version || null,
    version_apres: after?.version || null,
    ...details,
  }), actorUserId || null]);
}

async function notify(type, row, options = {}) {
  const label = FUNCTION_LABELS[row.fonction_type] || row.fonction_type;
  const person = fullName(row, 'employe_');
  const dept = row.departement_libelle || 'département';
  const messages = {
    ORG_FUNCTION_SUBMITTED: [`Fonction soumise — ${dept}`, `${label} pour ${person} attend une approbation.`],
    ORG_FUNCTION_APPROVED: [`Fonction approuvée — ${dept}`, `${label} pour ${person} a été approuvée pour le ${row.date_debut}.`],
    ORG_FUNCTION_REFUSED: [`Fonction refusée — ${dept}`, `${label} pour ${person} a été refusée : ${row.motif_refus || 'motif non précisé'}.`],
    ORG_FUNCTION_EFFECTIVE: [`Fonction effective — ${dept}`, `${label} de ${person} est désormais effective.`],
    ORG_FUNCTION_EXPIRING: [`Fonction bientôt expirée — ${dept}`, `${label} de ${person} prend fin le ${row.date_fin}.`],
    ORG_FUNCTION_ENDED: [`Fonction clôturée — ${dept}`, `${label} de ${person} est clôturée.`],
  };
  const [titre, message] = messages[type] || [type, `${label} — ${person}`];
  await notifSvc.creerNotification({
    type,
    titre,
    message,
    srcTable: 'org_departement_fonctions',
    srcId: Number(row.id),
    roles: options.roles || null,
    userIds: options.userIds || null,
    createdBy: options.createdBy || null,
  });
}

async function createDraft(input, actorUserId) {
  const data = validateInput(input);
  const result = await db.transaction(async tx => {
    const dept = await department(data.departement_id, tx, true);
    if (!dept || !dept.actif) throw new DepartmentFunctionWorkflowError('Département introuvable ou inactif.', 'DEPARTMENT_NOT_ACTIVE', 404);
    const agent = await employee(data.employe_id, tx, true);
    assertEmployeeAvailable(agent, dept);
    const enterprise = await activeEnterprise(tx);

    const duplicate = await tx.queryOne(`
      SELECT id, statut FROM org_departement_fonctions
      WHERE departement_id=? AND employe_id=? AND fonction_type=?
        AND statut IN ('brouillon','soumis','approuve','actif','a_corriger')
      LIMIT 1 FOR UPDATE
    `, [dept.id, agent.id, data.fonction_type]);
    if (duplicate) {
      throw new DepartmentFunctionWorkflowError('Une demande active existe déjà pour cet agent et cette fonction.', 'ACTIVE_FUNCTION_REQUEST_EXISTS', 409, duplicate);
    }

    const inserted = await tx.execute(`
      INSERT INTO org_departement_fonctions
        (entreprise_id, departement_id, employe_id, fonction_type, statut, version,
         rang, perimetre, motif, date_debut, date_fin, titulaire, actif,
         decision_reference, created_by, created_at, updated_at)
      VALUES (?,?,?,?, 'brouillon', 1, ?,?,?,?,?,?,?,0,?,?,NOW(),NOW())
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
    const row = await functionRow(inserted.insertId, tx);
    await writeEvent(tx, row, 'draft_created', null, row, actorUserId, { input: data });
    return row;
  });
  return result;
}

async function updateDraft(id, input, actorUserId) {
  const expectedVersion = requireVersion(input);
  return db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (!EDITABLE_STATUSES.has(current.statut)) {
      throw new DepartmentFunctionWorkflowError('Cette fonction ne peut plus être modifiée.', 'FUNCTION_NOT_EDITABLE', 409, { statut: current.statut });
    }
    if (Number(current.version) !== expectedVersion) {
      throw new DepartmentFunctionWorkflowError('La fonction a été modifiée par un autre utilisateur.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }

    const data = validateInput({
      ...current,
      ...input,
      departement_id: current.departement_id,
      employe_id: current.employe_id,
      fonction_type: current.fonction_type,
      motif: input.motif === undefined ? current.motif : input.motif,
    });
    const dept = await department(current.departement_id, tx, true);
    const agent = await employee(current.employe_id, tx, true);
    assertEmployeeAvailable(agent, dept);

    const nextVersion = expectedVersion + 1;
    const updated = await tx.execute(`
      UPDATE org_departement_fonctions
      SET rang=?, perimetre=?, motif=?, date_debut=?, date_fin=?, titulaire=?,
          decision_reference=?, motif_refus=NULL, statut='brouillon', version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [
      data.rang, data.perimetre, data.motif, data.date_debut, data.date_fin,
      data.titulaire, data.decision_reference, nextVersion, Number(id), expectedVersion,
    ]);
    if (updated.affectedRows !== 1) {
      throw new DepartmentFunctionWorkflowError('Conflit de modification.', 'FUNCTION_VERSION_CONFLICT', 409);
    }
    const row = await functionRow(id, tx);
    await writeEvent(tx, row, 'draft_updated', current, row, actorUserId, { changed_fields: Object.keys(input || {}) });
    return row;
  });
}

async function attachDocument(id, document, actorUserId) {
  const expectedVersion = requireVersion(document);
  const name = clean(document?.document_nom);
  const url = clean(document?.document_url);
  const hash = clean(document?.document_hash);
  if (!name || !url || !hash) {
    throw new DepartmentFunctionWorkflowError('Nom, URL et empreinte du document sont obligatoires.', 'DOCUMENT_METADATA_REQUIRED');
  }
  return db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (![STATUS.DRAFT, STATUS.REFUSED, STATUS.NEEDS_CORRECTION, STATUS.SUBMITTED].includes(current.statut)) {
      throw new DepartmentFunctionWorkflowError('Le document ne peut plus être remplacé à ce stade.', 'DOCUMENT_LOCKED', 409);
    }
    if (Number(current.version) !== expectedVersion) {
      throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }
    const nextVersion = expectedVersion + 1;
    await tx.execute(`
      UPDATE org_departement_fonctions
      SET document_nom=?, document_url=?, document_hash=?, version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [name, url, hash, nextVersion, Number(id), expectedVersion]);
    const row = await functionRow(id, tx);
    await writeEvent(tx, row, 'document_attached', current, row, actorUserId, { document_nom: name, document_hash: hash });
    return row;
  });
}

async function submit(id, version, actorUserId) {
  const expectedVersion = Number(version);
  const result = await db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (!EDITABLE_STATUSES.has(current.statut)) {
      throw new DepartmentFunctionWorkflowError('Seul un brouillon corrigible peut être soumis.', 'FUNCTION_NOT_SUBMITTABLE', 409);
    }
    if (Number(current.version) !== expectedVersion) {
      throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }
    if (!current.decision_reference) {
      throw new DepartmentFunctionWorkflowError('La référence de décision est obligatoire avant soumission.', 'DECISION_REFERENCE_REQUIRED', 409);
    }
    const dept = await department(current.departement_id, tx, true);
    const agent = await employee(current.employe_id, tx, true);
    assertEmployeeAvailable(agent, dept);

    const nextVersion = expectedVersion + 1;
    await tx.execute(`
      UPDATE org_departement_fonctions
      SET statut='soumis', submitted_by=?, submitted_at=NOW(), motif_refus=NULL,
          version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [actorUserId || null, nextVersion, Number(id), expectedVersion]);
    const row = await functionRow(id, tx);
    await writeEvent(tx, row, 'submitted', current, row, actorUserId, {});
    return row;
  });
  await notify('ORG_FUNCTION_SUBMITTED', result, { roles: ['admin', 'dg'], createdBy: actorUserId });
  return result;
}

async function activeChief(tx, departmentId, lock = false) {
  return tx.queryOne(`
    SELECT f.*, e.nom AS employe_nom, e.prenom AS employe_prenom
    FROM org_departement_fonctions f
    JOIN employes e ON e.id=f.employe_id
    WHERE f.departement_id=? AND f.fonction_type='chef' AND f.actif=1 AND f.statut='actif'
    ORDER BY f.date_debut DESC, f.id DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}
  `, [Number(departmentId)]);
}

async function activeInterim(tx, departmentId, lock = false) {
  return tx.queryOne(`
    SELECT f.*, e.nom AS employe_nom, e.prenom AS employe_prenom
    FROM org_departement_fonctions f
    JOIN employes e ON e.id=f.employe_id
    WHERE f.departement_id=? AND f.fonction_type='interimaire' AND f.actif=1 AND f.statut='actif'
    ORDER BY f.date_debut DESC, f.id DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}
  `, [Number(departmentId)]);
}

async function activeFunctionEmployeeIds(tx, departmentId) {
  const rows = await tx.query(`
    SELECT DISTINCT employe_id
    FROM org_departement_fonctions
    WHERE departement_id=? AND actif=1 AND statut='actif'
  `, [Number(departmentId)]);
  return rows.map(row => Number(row.employe_id));
}

async function syncDepartmentManager(tx, dept, newManager, oldManagerId = null) {
  await tx.execute('UPDATE org_departements SET responsable_id=?, updated_at=NOW() WHERE id=?', [newManager.id, dept.id]);
  const protectedIds = await activeFunctionEmployeeIds(tx, dept.id);
  const params = [newManager.id, fullName(newManager), dept.libelle];
  let condition = `departement=? AND actif=1 AND COALESCE(statut_dossier,'actif') NOT IN ('sorti','archive') AND id<>?`;
  params.push(newManager.id);
  if (protectedIds.length) {
    condition += ` AND id NOT IN (${protectedIds.map(() => '?').join(',')})`;
    params.push(...protectedIds);
  }
  if (oldManagerId) {
    condition += ' AND (superieur_id IS NULL OR superieur_id=?)';
    params.push(Number(oldManagerId));
  } else {
    condition += ' AND superieur_id IS NULL';
  }
  await tx.execute(`
    UPDATE employes
    SET superieur_id=?, superieur_hierarchique=?, updated_at=NOW()
    WHERE ${condition}
  `, params);
}

async function activateInTransaction(tx, current, actorUserId) {
  const dept = await department(current.departement_id, tx, true);
  const agent = await employee(current.employe_id, tx, true);
  if (!dept || !dept.actif) throw new DepartmentFunctionWorkflowError('Département inactif.', 'DEPARTMENT_NOT_ACTIVE', 409);
  assertEmployeeAvailable(agent, dept);
  if (current.date_debut > today()) {
    throw new DepartmentFunctionWorkflowError('La date d’effet n’est pas encore atteinte.', 'EFFECTIVE_DATE_NOT_REACHED', 409, { date_debut: current.date_debut });
  }
  if (DOCUMENT_REQUIRED_TYPES.has(current.fonction_type) && !current.document_url) {
    throw new DepartmentFunctionWorkflowError('La décision signée est obligatoire avant activation.', 'SIGNED_DOCUMENT_REQUIRED', 409);
  }

  let oldEffectiveManagerId = dept.responsable_id || null;
  if (ACTIVE_SINGLETON_TYPES.has(current.fonction_type)) {
    const conflict = await tx.queryOne(`
      SELECT id, employe_id FROM org_departement_fonctions
      WHERE departement_id=? AND fonction_type=? AND actif=1 AND id<>?
      LIMIT 1 FOR UPDATE
    `, [dept.id, current.fonction_type, current.id]);
    if (conflict && current.fonction_type !== 'chef') {
      throw new DepartmentFunctionWorkflowError('Une fonction active de ce type existe déjà.', 'ACTIVE_SINGLETON_EXISTS', 409, conflict);
    }
    if (conflict && current.fonction_type === 'chef') {
      await tx.execute(`
        UPDATE org_departement_fonctions
        SET statut='cloture', actif=0, date_fin=COALESCE(date_fin, ?), closed_by=?, closed_at=NOW(), version=version+1, updated_at=NOW()
        WHERE id=?
      `, [current.date_debut, actorUserId || null, conflict.id]);
      const oldRow = await functionRow(conflict.id, tx);
      await writeEvent(tx, oldRow, 'replaced_by_new_chief', { ...oldRow, statut: STATUS.ACTIVE, actif: 1 }, oldRow, actorUserId, { replacement_function_id: current.id });
      oldEffectiveManagerId = conflict.employe_id;
    }
  }

  await tx.execute(`
    UPDATE org_departement_fonctions
    SET statut='actif', actif=1, effective_at=NOW(), version=version+1, updated_at=NOW()
    WHERE id=?
  `, [current.id]);
  const active = await functionRow(current.id, tx);

  if (['chef', 'interimaire'].includes(current.fonction_type)) {
    await syncDepartmentManager(tx, dept, { id: agent.id, nom: agent.nom, prenom: agent.prenom }, oldEffectiveManagerId);
  }
  await writeEvent(tx, active, 'activated', current, active, actorUserId, {});
  return active;
}

async function approve(id, version, actorUserId) {
  const expectedVersion = Number(version);
  let activated = false;
  const result = await db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (current.statut !== STATUS.SUBMITTED) {
      throw new DepartmentFunctionWorkflowError('Seule une demande soumise peut être approuvée.', 'FUNCTION_NOT_APPROVABLE', 409);
    }
    if (Number(current.version) !== expectedVersion) {
      throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }
    if ([current.created_by, current.submitted_by].filter(Boolean).some(idValue => Number(idValue) === Number(actorUserId))) {
      throw new DepartmentFunctionWorkflowError('L’initiateur ne peut pas approuver sa propre demande.', 'SELF_APPROVAL_FORBIDDEN', 409);
    }
    if (DOCUMENT_REQUIRED_TYPES.has(current.fonction_type) && !current.document_url) {
      throw new DepartmentFunctionWorkflowError('La décision signée est obligatoire avant approbation.', 'SIGNED_DOCUMENT_REQUIRED', 409);
    }

    const nextVersion = expectedVersion + 1;
    await tx.execute(`
      UPDATE org_departement_fonctions
      SET statut='approuve', approved_by=?, approved_at=NOW(), version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [actorUserId || null, nextVersion, current.id, expectedVersion]);
    let row = await functionRow(current.id, tx);
    await writeEvent(tx, row, 'approved', current, row, actorUserId, {});
    if (row.date_debut <= today()) {
      row = await activateInTransaction(tx, row, actorUserId);
      activated = true;
    }
    return row;
  });
  await notify(activated ? 'ORG_FUNCTION_EFFECTIVE' : 'ORG_FUNCTION_APPROVED', result, {
    userIds: result.created_by ? [Number(result.created_by)] : null,
    roles: result.created_by ? null : ['admin', 'rh', 'dg'],
    createdBy: actorUserId,
  });
  return result;
}

async function refuse(id, version, reason, actorUserId) {
  const expectedVersion = Number(version);
  const motif = clean(reason);
  if (!motif) throw new DepartmentFunctionWorkflowError('Le motif du refus est obligatoire.', 'REFUSAL_REASON_REQUIRED');
  const result = await db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (current.statut !== STATUS.SUBMITTED) throw new DepartmentFunctionWorkflowError('Demande non soumise.', 'FUNCTION_NOT_REFUSABLE', 409);
    if (Number(current.version) !== expectedVersion) throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    if ([current.created_by, current.submitted_by].filter(Boolean).some(idValue => Number(idValue) === Number(actorUserId))) {
      throw new DepartmentFunctionWorkflowError('L’initiateur ne peut pas refuser sa propre demande.', 'SELF_REFUSAL_FORBIDDEN', 409);
    }
    await tx.execute(`
      UPDATE org_departement_fonctions
      SET statut='refuse', motif_refus=?, refused_by=?, refused_at=NOW(), version=version+1, updated_at=NOW()
      WHERE id=? AND version=?
    `, [motif, actorUserId || null, current.id, expectedVersion]);
    const row = await functionRow(current.id, tx);
    await writeEvent(tx, row, 'refused', current, row, actorUserId, { motif_refus: motif });
    return row;
  });
  await notify('ORG_FUNCTION_REFUSED', result, { userIds: result.created_by ? [Number(result.created_by)] : null, createdBy: actorUserId });
  return result;
}

async function activate(id, version, actorUserId) {
  const expectedVersion = Number(version);
  const result = await db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (current.statut !== STATUS.APPROVED) throw new DepartmentFunctionWorkflowError('Fonction non approuvée.', 'FUNCTION_NOT_ACTIVATABLE', 409);
    if (Number(current.version) !== expectedVersion) throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    return activateInTransaction(tx, current, actorUserId);
  });
  await notify('ORG_FUNCTION_EFFECTIVE', result, { roles: ['admin', 'rh', 'dg'], createdBy: actorUserId });
  return result;
}

async function effectiveManager(tx, departmentId) {
  const interim = await activeInterim(tx, departmentId, true);
  if (interim) return interim;
  return activeChief(tx, departmentId, true);
}

async function close(id, version, reason, actorUserId) {
  const expectedVersion = Number(version);
  const motif = clean(reason);
  if (!motif) throw new DepartmentFunctionWorkflowError('Le motif de clôture est obligatoire.', 'CLOSE_REASON_REQUIRED');
  const result = await db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (current.statut !== STATUS.ACTIVE) throw new DepartmentFunctionWorkflowError('Seule une fonction active peut être clôturée.', 'FUNCTION_NOT_CLOSABLE', 409);
    if (Number(current.version) !== expectedVersion) throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    const dept = await department(current.departement_id, tx, true);

    if (current.fonction_type === 'chef') {
      throw new DepartmentFunctionWorkflowError('Activez d’abord le nouveau chef : l’ancien sera clôturé automatiquement.', 'CHIEF_REPLACEMENT_REQUIRED', 409);
    }

    await tx.execute(`
      UPDATE org_departement_fonctions
      SET statut='cloture', actif=0, date_fin=COALESCE(date_fin, CURDATE()),
          motif_refus=?, closed_by=?, closed_at=NOW(), version=version+1, updated_at=NOW()
      WHERE id=? AND version=?
    `, [motif, actorUserId || null, current.id, expectedVersion]);

    if (Number(dept.responsable_id || 0) === Number(current.employe_id)) {
      const manager = await activeChief(tx, dept.id, true);
      if (!manager) throw new DepartmentFunctionWorkflowError('Aucun chef titulaire actif pour reprendre le département.', 'ACTIVE_CHIEF_REQUIRED', 409);
      await syncDepartmentManager(tx, dept, { id: manager.employe_id, nom: manager.employe_nom, prenom: manager.employe_prenom }, current.employe_id);
    } else {
      const manager = await effectiveManager(tx, dept.id);
      if (manager) {
        await tx.execute(`
          UPDATE employes
          SET superieur_id=?, superieur_hierarchique=?, updated_at=NOW()
          WHERE superieur_id=? AND actif=1 AND COALESCE(statut_dossier,'actif') NOT IN ('sorti','archive')
        `, [manager.employe_id, fullName(manager, 'employe_'), current.employe_id]);
      }
    }

    const row = await functionRow(current.id, tx);
    await writeEvent(tx, row, 'closed', current, row, actorUserId, { motif });
    return row;
  });
  await notify('ORG_FUNCTION_ENDED', result, { roles: ['admin', 'rh', 'dg'], createdBy: actorUserId });
  return result;
}

async function cancel(id, version, reason, actorUserId) {
  const expectedVersion = Number(version);
  const motif = clean(reason);
  if (!motif) throw new DepartmentFunctionWorkflowError('Le motif d’annulation est obligatoire.', 'CANCEL_REASON_REQUIRED');
  return db.transaction(async tx => {
    const current = await functionRow(id, tx, true);
    if (!current) throw new DepartmentFunctionWorkflowError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (!CANCELLABLE_STATUSES.has(current.statut)) throw new DepartmentFunctionWorkflowError('Cette fonction ne peut plus être annulée.', 'FUNCTION_NOT_CANCELLABLE', 409);
    if (Number(current.version) !== expectedVersion) throw new DepartmentFunctionWorkflowError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    await tx.execute(`
      UPDATE org_departement_fonctions
      SET statut='annule', actif=0, motif_refus=?, cancelled_by=?, cancelled_at=NOW(), version=version+1, updated_at=NOW()
      WHERE id=? AND version=?
    `, [motif, actorUserId || null, current.id, expectedVersion]);
    const row = await functionRow(current.id, tx);
    await writeEvent(tx, row, 'cancelled', current, row, actorUserId, { motif });
    return row;
  });
}

async function list(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.departement_id) { where.push('f.departement_id=?'); params.push(Number(filters.departement_id)); }
  if (filters.statut) { where.push('f.statut=?'); params.push(String(filters.statut)); }
  if (filters.fonction_type) { where.push('f.fonction_type=?'); params.push(String(filters.fonction_type)); }
  if (filters.historique !== '1') where.push("f.statut NOT IN ('annule')");
  return db.query(`
    SELECT f.*, d.libelle AS departement_libelle,
           e.nom AS employe_nom, e.prenom AS employe_prenom, e.poste AS employe_poste,
           e.email AS employe_email,
           CONCAT(e.nom, ' ', COALESCE(e.prenom,'')) AS employe_nom_complet,
           uc.nom AS createur_nom, us.nom AS soumetteur_nom, ua.nom AS approbateur_nom
    FROM org_departement_fonctions f
    JOIN org_departements d ON d.id=f.departement_id
    JOIN employes e ON e.id=f.employe_id
    LEFT JOIN users uc ON uc.id=f.created_by
    LEFT JOIN users us ON us.id=f.submitted_by
    LEFT JOIN users ua ON ua.id=f.approved_by
    WHERE ${where.join(' AND ')}
    ORDER BY CASE f.statut
               WHEN 'soumis' THEN 1 WHEN 'a_corriger' THEN 2 WHEN 'approuve' THEN 3
               WHEN 'brouillon' THEN 4 WHEN 'actif' THEN 5 WHEN 'refuse' THEN 6
               WHEN 'cloture' THEN 7 WHEN 'annule' THEN 8 ELSE 9
             END,
             f.date_debut DESC, f.id DESC
    LIMIT 1000
  `, params);
}

async function get(id) {
  const row = await functionRow(id);
  if (!row) return null;
  const events = await db.query(`
    SELECT ev.*, u.nom AS actor_nom, u.email AS actor_email
    FROM org_departement_fonction_events ev
    LEFT JOIN users u ON u.id=ev.actor_user_id
    WHERE ev.fonction_id=? ORDER BY ev.created_at DESC, ev.id DESC
  `, [Number(id)]);
  return { ...row, events };
}

async function departmentOverview() {
  const departments = await db.query(`
    SELECT d.id, d.libelle, d.code, d.description, d.responsable_id, d.actif,
           COUNT(DISTINCT CASE WHEN e.actif=1 AND COALESCE(e.statut_dossier,'actif') NOT IN ('sorti','archive') THEN e.id END) AS nb_agents
    FROM org_departements d
    LEFT JOIN employes e ON e.departement=d.libelle
    WHERE d.actif=1
    GROUP BY d.id, d.libelle, d.code, d.description, d.responsable_id, d.actif
    ORDER BY d.libelle
  `);
  const rows = await list({ historique: '1' });
  const activeRows = rows.filter(row => row.statut === STATUS.ACTIVE && Number(row.actif) === 1);
  return departments.map(dept => {
    const functions = activeRows.filter(row => Number(row.departement_id) === Number(dept.id));
    const head = functions.find(row => row.fonction_type === 'interimaire') || functions.find(row => row.fonction_type === 'chef') || null;
    return {
      ...dept,
      responsable_nom: head?.employe_nom_complet || '',
      responsable_poste: head?.employe_poste || '',
      responsable_fonction: head ? FUNCTION_LABELS[head.fonction_type] : '',
      fonctions: functions.map(row => ({ ...row, fonction_libelle: FUNCTION_LABELS[row.fonction_type] || row.fonction_type })),
      adjoints: functions.filter(row => ['premier_adjoint', 'adjoint', 'suppleant'].includes(row.fonction_type)),
    };
  });
}

async function report() {
  const [summary, expiring, anomalies] = await Promise.all([
    db.query(`
      SELECT statut, fonction_type, COUNT(*) AS total
      FROM org_departement_fonctions
      GROUP BY statut, fonction_type
      ORDER BY statut, fonction_type
    `),
    db.query(`
      SELECT f.id, f.fonction_type, f.date_fin, d.libelle AS departement_libelle,
             CONCAT(e.nom,' ',COALESCE(e.prenom,'')) AS employe_nom_complet
      FROM org_departement_fonctions f
      JOIN org_departements d ON d.id=f.departement_id
      JOIN employes e ON e.id=f.employe_id
      WHERE f.statut='actif' AND f.date_fin IS NOT NULL
        AND f.date_fin BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      ORDER BY f.date_fin
    `),
    db.query(`
      SELECT 'department_without_active_chief' AS code, d.id AS departement_id, d.libelle, NULL AS fonction_id
      FROM org_departements d
      WHERE d.actif=1 AND NOT EXISTS (
        SELECT 1 FROM org_departement_fonctions f
        WHERE f.departement_id=d.id AND f.fonction_type='chef' AND f.statut='actif' AND f.actif=1
      )
      UNION ALL
      SELECT 'active_function_employee_inactive', f.departement_id, d.libelle, f.id
      FROM org_departement_fonctions f
      JOIN employes e ON e.id=f.employe_id
      JOIN org_departements d ON d.id=f.departement_id
      WHERE f.statut='actif' AND f.actif=1
        AND (e.actif=0 OR COALESCE(e.statut_dossier,'actif') IN ('sorti','archive'))
      UNION ALL
      SELECT 'active_function_department_mismatch', f.departement_id, d.libelle, f.id
      FROM org_departement_fonctions f
      JOIN employes e ON e.id=f.employe_id
      JOIN org_departements d ON d.id=f.departement_id
      WHERE f.statut='actif' AND f.actif=1 AND COALESCE(e.departement,'')<>d.libelle
      UNION ALL
      SELECT 'sensitive_function_without_document', f.departement_id, d.libelle, f.id
      FROM org_departement_fonctions f
      JOIN org_departements d ON d.id=f.departement_id
      WHERE f.statut IN ('soumis','approuve','actif')
        AND f.fonction_type IN ('chef','premier_adjoint','interimaire','suppleant')
        AND COALESCE(f.document_url,'')=''
    `),
  ]);
  return { summary, expiring, anomalies };
}

async function processDue(actorUserId = null) {
  const approved = await db.query(`
    SELECT id, version FROM org_departement_fonctions
    WHERE statut='approuve' AND date_debut<=CURDATE()
    ORDER BY date_debut, id LIMIT 200
  `);
  const expiring = await db.query(`
    SELECT id, version FROM org_departement_fonctions
    WHERE statut='actif' AND actif=1 AND date_fin IS NOT NULL AND date_fin<CURDATE()
    ORDER BY date_fin, id LIMIT 200
  `);
  const reminders = await db.query(`
    SELECT f.*, d.libelle AS departement_libelle,
           e.nom AS employe_nom, e.prenom AS employe_prenom
    FROM org_departement_fonctions f
    JOIN org_departements d ON d.id=f.departement_id
    JOIN employes e ON e.id=f.employe_id
    WHERE f.statut='actif' AND f.date_fin=DATE_ADD(CURDATE(), INTERVAL 7 DAY)
    LIMIT 200
  `);

  const result = { activated: [], closed: [], failed: [] };
  for (const row of approved) {
    try { const activated = await activate(row.id, row.version, actorUserId); result.activated.push(activated.id); }
    catch (error) { result.failed.push({ id: row.id, action: 'activate', code: error.code || 'ERROR', error: error.message }); }
  }
  for (const row of expiring) {
    try { const closed = await close(row.id, row.version, 'Échéance automatique atteinte', actorUserId); result.closed.push(closed.id); }
    catch (error) { result.failed.push({ id: row.id, action: 'close', code: error.code || 'ERROR', error: error.message }); }
  }
  for (const row of reminders) {
    await notify('ORG_FUNCTION_EXPIRING', row, { roles: ['admin', 'rh', 'dg'], createdBy: actorUserId });
  }
  return result;
}

module.exports = {
  STATUS,
  FUNCTION_LABELS,
  DepartmentFunctionWorkflowError,
  createDraft,
  updateDraft,
  attachDocument,
  submit,
  approve,
  refuse,
  activate,
  close,
  cancel,
  list,
  get,
  departmentOverview,
  report,
  processDue,
};

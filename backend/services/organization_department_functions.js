'use strict';

const defaultDb = require('../database');
const organization = require('./organization_assignment');

const FUNCTION_TYPES = Object.freeze({
  chef: 'Chef de département',
  premier_adjoint: 'Premier adjoint',
  adjoint: 'Adjoint',
  interimaire: 'Responsable intérimaire',
  suppleant: 'Suppléant',
  chef_service: 'Chef de service',
  chef_section: 'Chef de section',
  coordonnateur: 'Coordonnateur',
});

const MANAGEMENT_TYPES = new Set(Object.keys(FUNCTION_TYPES));
const SINGLETON_TYPES = new Set(['chef', 'premier_adjoint', 'interimaire']);
const TEMPORARY_TYPES = new Set(['interimaire', 'suppleant']);

class DepartmentFunctionError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'DepartmentFunctionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function dateValue(value, fallback = '') {
  const date = clean(value, fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new DepartmentFunctionError('Date invalide. Format attendu : AAAA-MM-JJ.', 'INVALID_FUNCTION_DATE');
  }
  return date;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fullName(employee) {
  return `${employee?.nom || ''} ${employee?.prenom || ''}`.trim();
}

function createDepartmentFunctionsService(db = defaultDb) {
  function department(id) {
    return db.prepare(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE id = ?
    `).get(Number(id)) || null;
  }

  function requireDepartment(id) {
    const row = department(id);
    if (!row || !row.actif) {
      throw new DepartmentFunctionError('Département introuvable ou inactif.', 'DEPARTMENT_NOT_FOUND', 404);
    }
    return row;
  }

  function employee(id) {
    return db.prepare(`
      SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes
      WHERE id = ? AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).get(Number(id)) || null;
  }

  function requireEmployee(id) {
    const row = employee(id);
    if (!row) {
      throw new DepartmentFunctionError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_FOUND', 404);
    }
    return row;
  }

  function listFunctions(departmentId, { includeInactive = false } = {}) {
    const whereActive = includeInactive
      ? ''
      : `AND f.actif = 1
         AND f.date_debut <= CURRENT_DATE
         AND (f.date_fin IS NULL OR f.date_fin >= CURRENT_DATE)`;
    return db.prepare(`
      SELECT f.*,
             e.nom AS employe_nom,
             e.prenom AS employe_prenom,
             e.poste AS employe_poste,
             e.departement AS employe_departement,
             e.superieur_id,
             e.superieur_hierarchique
      FROM org_departement_fonctions f
      JOIN employes e ON e.id = f.employe_id
      WHERE f.departement_id = ? ${whereActive}
      ORDER BY
        CASE f.fonction_type
          WHEN 'chef' THEN 1
          WHEN 'interimaire' THEN 2
          WHEN 'premier_adjoint' THEN 3
          WHEN 'adjoint' THEN 4
          WHEN 'suppleant' THEN 5
          WHEN 'chef_service' THEN 6
          WHEN 'chef_section' THEN 7
          ELSE 8
        END,
        f.rang,
        e.nom,
        e.prenom
    `).all(Number(departmentId)).map(row => ({
      ...row,
      fonction_libelle: FUNCTION_TYPES[row.fonction_type] || row.fonction_type,
      employe_nom_complet: fullName({ nom: row.employe_nom, prenom: row.employe_prenom }),
    }));
  }

  function listAllActive() {
    const departments = db.prepare(`
      SELECT d.id, d.libelle, d.code, d.description, d.responsable_id, d.actif,
             COUNT(e.id) AS nb_agents,
             r.nom AS responsable_nom_famille,
             r.prenom AS responsable_prenom,
             r.poste AS responsable_poste
      FROM org_departements d
      LEFT JOIN employes e ON e.departement = d.libelle AND e.actif = 1
        AND COALESCE(e.statut_dossier, 'actif') NOT IN ('sorti', 'archive')
      LEFT JOIN employes r ON r.id = d.responsable_id AND r.actif = 1
      WHERE d.actif = 1
      GROUP BY d.id, d.libelle, d.code, d.description, d.responsable_id, d.actif,
               r.nom, r.prenom, r.poste
      ORDER BY d.libelle
    `).all();

    return departments.map(row => {
      const functions = listFunctions(row.id);
      const official = functions.find(item => item.fonction_type === 'interimaire')
        || functions.find(item => item.fonction_type === 'chef')
        || null;
      const deputies = functions.filter(item => ['premier_adjoint', 'adjoint', 'suppleant'].includes(item.fonction_type));
      return {
        ...row,
        responsable_nom: fullName({ nom: row.responsable_nom_famille, prenom: row.responsable_prenom }),
        responsable_poste: official?.employe_poste || row.responsable_poste || '',
        responsable_fonction: official?.fonction_libelle || (row.responsable_id ? FUNCTION_TYPES.chef : ''),
        fonctions: functions,
        adjoints: deputies,
      };
    });
  }

  function currentChief(departmentId) {
    const functions = listFunctions(departmentId);
    return functions.find(item => item.fonction_type === 'interimaire')
      || functions.find(item => item.fonction_type === 'chef')
      || null;
  }

  function employeeHasManagementFunction(departmentId, employeeId) {
    if (!departmentId || !employeeId) return null;
    return db.prepare(`
      SELECT f.id, f.fonction_type, f.rang, f.perimetre
      FROM org_departement_fonctions f
      WHERE f.departement_id = ? AND f.employe_id = ? AND f.actif = 1
        AND f.date_debut <= CURRENT_DATE
        AND (f.date_fin IS NULL OR f.date_fin >= CURRENT_DATE)
      ORDER BY f.rang, f.id
      LIMIT 1
    `).get(Number(departmentId), Number(employeeId)) || null;
  }

  function validateAssignment(dept, agent, input) {
    const type = clean(input.fonction_type);
    if (!MANAGEMENT_TYPES.has(type)) {
      throw new DepartmentFunctionError('Type de fonction départementale invalide.', 'INVALID_DEPARTMENT_FUNCTION_TYPE');
    }
    if (clean(agent.departement) !== clean(dept.libelle)) {
      throw new DepartmentFunctionError(
        `L’agent doit d’abord être affecté au département « ${dept.libelle} » par une mutation RH.`,
        'FUNCTION_EMPLOYEE_DEPARTMENT_MISMATCH',
        409,
        { employee_department: agent.departement || null, expected_department: dept.libelle },
      );
    }

    const start = dateValue(input.date_debut || today());
    const end = input.date_fin ? dateValue(input.date_fin) : null;
    if (end && end < start) {
      throw new DepartmentFunctionError('La date de fin ne peut pas précéder la date de début.', 'INVALID_FUNCTION_DATE_RANGE');
    }
    if (TEMPORARY_TYPES.has(type) && !end) {
      throw new DepartmentFunctionError(
        'Une fonction intérimaire ou de suppléance doit avoir une date de fin.',
        'TEMPORARY_FUNCTION_END_REQUIRED',
      );
    }

    const duplicate = db.prepare(`
      SELECT id FROM org_departement_fonctions
      WHERE departement_id = ? AND employe_id = ? AND fonction_type = ? AND actif = 1
        AND date_debut <= ? AND (date_fin IS NULL OR date_fin >= ?)
      LIMIT 1
    `).get(Number(dept.id), Number(agent.id), type, end || '9999-12-31', start);
    if (duplicate) {
      throw new DepartmentFunctionError('Cette fonction est déjà active pour cet agent.', 'DEPARTMENT_FUNCTION_DUPLICATE', 409);
    }

    if (SINGLETON_TYPES.has(type)) {
      const existing = db.prepare(`
        SELECT id, employe_id FROM org_departement_fonctions
        WHERE departement_id = ? AND fonction_type = ? AND actif = 1
          AND date_debut <= ? AND (date_fin IS NULL OR date_fin >= ?)
        ORDER BY id DESC LIMIT 1
      `).get(Number(dept.id), type, end || '9999-12-31', start);
      if (existing && Number(existing.employe_id) !== Number(agent.id) && type !== 'chef') {
        throw new DepartmentFunctionError(
          `Une fonction « ${FUNCTION_TYPES[type]} » est déjà active dans ce département.`,
          'SINGLETON_DEPARTMENT_FUNCTION_EXISTS',
          409,
          { function_id: Number(existing.id), employee_id: Number(existing.employe_id) },
        );
      }
    }

    if (type !== 'chef' && type !== 'interimaire') {
      const chief = currentChief(dept.id);
      if (!chief && !dept.responsable_id) {
        throw new DepartmentFunctionError(
          'Désignez d’abord un chef de département avant d’ajouter des adjoints ou responsables internes.',
          'DEPARTMENT_CHIEF_REQUIRED',
          409,
        );
      }
      const chiefId = chief?.employe_id || dept.responsable_id;
      if (Number(chiefId) === Number(agent.id)) {
        throw new DepartmentFunctionError('Le chef ne peut pas être son propre adjoint.', 'CHIEF_CANNOT_BE_DEPUTY', 409);
      }
    }

    return { type, start, end };
  }

  function createFunction(departmentId, input, actorUserId = null) {
    const dept = requireDepartment(departmentId);
    const agent = requireEmployee(input.employe_id);
    const validated = validateAssignment(dept, agent, input || {});
    const rank = Number.isFinite(Number(input.rang)) ? Number(input.rang) : 0;
    const perimeter = clean(input.perimetre);
    const reference = clean(input.decision_reference);
    const titular = input.titulaire === false || Number(input.titulaire) === 0 ? 0 : 1;

    const result = db.prepare(`
      INSERT INTO org_departement_fonctions
        (departement_id, employe_id, fonction_type, rang, perimetre,
         date_debut, date_fin, titulaire, actif, decision_reference,
         created_by, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      Number(dept.id), Number(agent.id), validated.type, rank, perimeter || null,
      validated.start, validated.end, titular, reference || null,
      actorUserId || null, actorUserId || null,
    );
    const functionId = Number(result.lastInsertRowid);

    try {
      if (validated.type === 'chef') {
        organization.synchronizeDepartmentManager({
          departmentId: dept.id,
          managerId: agent.id,
          actorUserId,
          motif: 'Nomination du chef de département',
        });
        db.prepare(`
          UPDATE org_departement_fonctions
          SET actif = 0, date_fin = COALESCE(date_fin, ?), updated_at = CURRENT_TIMESTAMP
          WHERE departement_id = ? AND fonction_type = 'chef' AND actif = 1 AND id != ?
        `).run(validated.start, Number(dept.id), functionId);
      }

      db.prepare(`
        UPDATE org_departement_fonctions
        SET actif = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(functionId);
    } catch (error) {
      try { db.prepare('DELETE FROM org_departement_fonctions WHERE id = ?').run(functionId); } catch (_) {}
      throw error;
    }

    const created = listFunctions(dept.id, { includeInactive: true }).find(row => Number(row.id) === functionId);
    const chief = currentChief(dept.id);
    const hierarchyWarning = ['premier_adjoint', 'adjoint', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur'].includes(validated.type)
      && chief
      && Number(agent.superieur_id || 0) !== Number(chief.employe_id || 0)
      ? `La fonction est enregistrée, mais ${fullName(agent)} n’est pas encore rattaché hiérarchiquement à ${chief.employe_nom_complet}. Créez une mutation RH si ce rattachement est attendu.`
      : null;

    return { function: created, hierarchy_warning: hierarchyWarning };
  }

  function updateFunction(departmentId, functionId, input) {
    const dept = requireDepartment(departmentId);
    const current = db.prepare(`
      SELECT * FROM org_departement_fonctions
      WHERE id = ? AND departement_id = ?
    `).get(Number(functionId), Number(dept.id));
    if (!current) {
      throw new DepartmentFunctionError('Fonction départementale introuvable.', 'DEPARTMENT_FUNCTION_NOT_FOUND', 404);
    }
    const agent = requireEmployee(current.employe_id);
    const validated = validateAssignment(dept, agent, {
      ...current,
      ...input,
      fonction_type: input.fonction_type || current.fonction_type,
      date_debut: input.date_debut || current.date_debut,
      date_fin: input.date_fin === undefined ? current.date_fin : input.date_fin,
    });

    db.prepare(`
      UPDATE org_departement_fonctions
      SET fonction_type = ?, rang = ?, perimetre = ?, date_debut = ?, date_fin = ?,
          titulaire = ?, decision_reference = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      validated.type,
      Number.isFinite(Number(input.rang)) ? Number(input.rang) : Number(current.rang || 0),
      input.perimetre === undefined ? current.perimetre : clean(input.perimetre) || null,
      validated.start,
      validated.end,
      input.titulaire === undefined ? Number(current.titulaire || 0) : (input.titulaire ? 1 : 0),
      input.decision_reference === undefined ? current.decision_reference : clean(input.decision_reference) || null,
      Number(current.id),
    );
    return listFunctions(dept.id, { includeInactive: true }).find(row => Number(row.id) === Number(current.id));
  }

  function deactivateFunction(departmentId, functionId, actorUserId = null) {
    const dept = requireDepartment(departmentId);
    const current = db.prepare(`
      SELECT * FROM org_departement_fonctions
      WHERE id = ? AND departement_id = ?
    `).get(Number(functionId), Number(dept.id));
    if (!current) {
      throw new DepartmentFunctionError('Fonction départementale introuvable.', 'DEPARTMENT_FUNCTION_NOT_FOUND', 404);
    }
    if (!current.actif) return { ok: true, unchanged: true };
    if (current.fonction_type === 'chef' && Number(dept.responsable_id || 0) === Number(current.employe_id || 0)) {
      throw new DepartmentFunctionError(
        'Nommez d’abord un nouveau chef avant de clôturer la fonction du chef actuel.',
        'ACTIVE_CHIEF_REPLACEMENT_REQUIRED',
        409,
      );
    }

    db.prepare(`
      UPDATE org_departement_fonctions
      SET actif = 0, date_fin = COALESCE(date_fin, CURRENT_DATE),
          approved_by = COALESCE(approved_by, ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actorUserId || null, Number(current.id));
    return { ok: true };
  }

  return {
    FUNCTION_TYPES,
    MANAGEMENT_TYPES,
    DepartmentFunctionError,
    createFunction,
    currentChief,
    deactivateFunction,
    employeeHasManagementFunction,
    listAllActive,
    listFunctions,
    updateFunction,
  };
}

const service = createDepartmentFunctionsService();

module.exports = {
  ...service,
  FUNCTION_TYPES,
  MANAGEMENT_TYPES,
  DepartmentFunctionError,
  createDepartmentFunctionsService,
};

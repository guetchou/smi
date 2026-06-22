'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const db = require('../database');
const organization = require('./organization_assignment');

const supervisorContext = new AsyncLocalStorage();
const ALLOWED_SUPERVISOR_FUNCTIONS = [
  'chef',
  'interimaire',
  'premier_adjoint',
  'adjoint',
  'suppleant',
  'chef_service',
  'chef_section',
  'coordonnateur',
];
const ORGANIZATION_FIELDS = ['poste', 'departement', 'site', 'superieur_id', 'superieur_hierarchique'];

function fullName(employee) {
  return `${employee?.nom || ''} ${employee?.prenom || ''}`.trim();
}

function normalize(field, value) {
  if (field === 'superieur_id') return value === undefined || value === null || value === '' ? null : Number(value);
  return String(value ?? '').trim();
}

function withRequestedSupervisor(supervisorId, callback) {
  const parsed = supervisorId ? Number(supervisorId) : null;
  return supervisorContext.run({ requestedSupervisorId: Number.isInteger(parsed) && parsed > 0 ? parsed : null }, callback);
}

function requestedSupervisorId() {
  return supervisorContext.getStore()?.requestedSupervisorId || null;
}

function assertWorkflowGuard(payload, options) {
  if (!options.employeeId || !options.current || options.allowMutationWorkflow) return;
  const changedFields = ORGANIZATION_FIELDS.filter(field => (
    normalize(field, payload?.[field]) !== normalize(field, options.current?.[field])
  ));
  if (!changedFields.length) return;
  throw new organization.OrganizationRuleError(
    'Les modifications de poste, département, site ou supérieur doivent passer par une mutation RH.',
    'USE_ORGANIZATION_MUTATION_WORKFLOW',
    409,
    { changed_fields: changedFields, workflow_endpoint: '/api/org/mutations' },
  );
}

function activeFunction(departmentId, employeeId) {
  try {
    const placeholders = ALLOWED_SUPERVISOR_FUNCTIONS.map(() => '?').join(',');
    return db.prepare(`
      SELECT id, fonction_type, rang, perimetre
      FROM org_departement_fonctions
      WHERE departement_id = ? AND employe_id = ? AND actif = 1
        AND date_debut <= CURRENT_DATE
        AND (date_fin IS NULL OR date_fin >= CURRENT_DATE)
        AND fonction_type IN (${placeholders})
      ORDER BY
        CASE fonction_type
          WHEN 'interimaire' THEN 1
          WHEN 'chef' THEN 2
          WHEN 'premier_adjoint' THEN 3
          WHEN 'adjoint' THEN 4
          ELSE 5
        END,
        rang,
        id
      LIMIT 1
    `).get(Number(departmentId), Number(employeeId), ...ALLOWED_SUPERVISOR_FUNCTIONS) || null;
  } catch (_) {
    return null;
  }
}

function effectiveManager(department) {
  if (!department?.id) return null;
  try {
    const row = db.prepare(`
      SELECT f.employe_id, f.fonction_type, e.nom, e.prenom, e.poste,
             e.departement, e.site, e.superieur_id, e.superieur_hierarchique
      FROM org_departement_fonctions f
      JOIN employes e ON e.id = f.employe_id
      WHERE f.departement_id = ? AND f.actif = 1 AND e.actif = 1
        AND COALESCE(e.statut_dossier, 'actif') NOT IN ('sorti', 'archive')
        AND f.date_debut <= CURRENT_DATE
        AND (f.date_fin IS NULL OR f.date_fin >= CURRENT_DATE)
        AND f.fonction_type IN ('interimaire', 'chef')
      ORDER BY CASE f.fonction_type WHEN 'interimaire' THEN 1 ELSE 2 END, f.rang, f.id DESC
      LIMIT 1
    `).get(Number(department.id));
    if (!row) return null;
    return {
      id: Number(row.employe_id),
      nom: row.nom,
      prenom: row.prenom,
      poste: row.poste,
      departement: row.departement,
      site: row.site,
      superieur_id: row.superieur_id,
      superieur_hierarchique: row.superieur_hierarchique,
      fonction_type: row.fonction_type,
    };
  } catch (_) {
    return null;
  }
}

function reconcileEffectiveManagers(actorUserId = null) {
  let departments;
  try {
    departments = db.prepare(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE actif = 1
      ORDER BY id
    `).all();
  } catch (_) {
    return { scanned: 0, changed: [], failed: [] };
  }

  const result = { scanned: departments.length, changed: [], failed: [] };
  for (const department of departments) {
    const manager = effectiveManager(department);
    if (!manager || Number(manager.id) === Number(department.responsable_id || 0)) continue;
    try {
      organization.synchronizeDepartmentManager({
        departmentId: department.id,
        managerId: manager.id,
        actorUserId,
        motif: manager.fonction_type === 'interimaire'
          ? 'Prise d’effet de l’intérim départemental'
          : 'Rétablissement du chef titulaire après intérim',
      });
      result.changed.push({ department_id: Number(department.id), manager_id: Number(manager.id), fonction_type: manager.fonction_type });
    } catch (error) {
      result.failed.push({ department_id: Number(department.id), error: error.message, code: error.code || 'ERROR' });
    }
  }
  return result;
}

function installDepartmentHierarchyRules() {
  if (organization.__departmentFunctionsHierarchyInstalled) return;

  const originalDepartmentByLabel = organization.activeDepartmentByLabel.bind(organization);
  const originalResolve = organization.resolveAgentAssignment.bind(organization);
  const originalSupervisorChange = organization.assertSupervisorChange.bind(organization);

  organization.activeDepartmentByLabel = function activeDepartmentWithEffectiveManager(label) {
    const department = originalDepartmentByLabel(label);
    if (!department) return null;

    const requestedId = requestedSupervisorId();
    if (requestedId && activeFunction(department.id, requestedId)) {
      return {
        ...department,
        responsable_titulaire_id: department.responsable_id || null,
        responsable_id: requestedId,
        responsable_effectif_type: 'fonction_departementale',
      };
    }

    const manager = effectiveManager(department);
    if (!manager) return department;
    return {
      ...department,
      responsable_titulaire_id: department.responsable_id || null,
      responsable_id: manager.id,
      responsable_effectif_type: manager.fonction_type,
    };
  };

  organization.resolveAgentAssignment = function resolveWithDepartmentFunctions(payload, options = {}) {
    assertWorkflowGuard(payload, options);

    const departmentLabel = String(payload.departement || '').trim();
    if (!departmentLabel) return originalResolve(payload, { ...options, allowMutationWorkflow: true });

    const department = organization.activeDepartmentByLabel(departmentLabel);
    if (!department) return originalResolve(payload, { ...options, allowMutationWorkflow: true });

    const employeeId = options.employeeId ? Number(options.employeeId) : null;
    const requestedManagerId = payload.superieur_id ? Number(payload.superieur_id) : null;
    const effective = department.responsable_id ? organization.assertManagerActive(department.responsable_id) : null;

    if (employeeId && effective && Number(effective.id) === employeeId) {
      return originalResolve(payload, { ...options, allowMutationWorkflow: true });
    }

    if (requestedManagerId) {
      const functionRow = activeFunction(department.id, requestedManagerId);
      if (functionRow) {
        const manager = organization.assertManagerActive(requestedManagerId);
        if (employeeId) organization.assertNoCycle(employeeId, manager.id);
        payload.superieur_id = Number(manager.id);
        payload.superieur_hierarchique = fullName(manager);
        return { department, manager, selfManager: false, departmentFunction: functionRow };
      }
    }

    if (effective) {
      if (employeeId) organization.assertNoCycle(employeeId, effective.id);
      payload.superieur_id = Number(effective.id);
      payload.superieur_hierarchique = fullName(effective);
      return { department, manager: effective, selfManager: false };
    }

    return originalResolve(payload, { ...options, allowMutationWorkflow: true });
  };

  organization.assertSupervisorChange = function assertSupervisorWithDepartmentFunctions(employeeId, requestedManagerId) {
    const employee = organization.activeEmployee(employeeId);
    if (!employee) return originalSupervisorChange(employeeId, requestedManagerId);
    const department = organization.activeDepartmentByLabel(employee.departement);
    const requestedId = requestedManagerId ? Number(requestedManagerId) : null;

    if (department && requestedId && activeFunction(department.id, requestedId)) {
      const manager = organization.assertManagerActive(requestedId);
      organization.assertNoCycle(employee.id, manager.id);
      return { employee, manager, department };
    }

    return originalSupervisorChange(employeeId, requestedManagerId);
  };

  organization.__departmentFunctionsHierarchyInstalled = true;
}

module.exports = {
  ALLOWED_SUPERVISOR_FUNCTIONS,
  activeFunction,
  effectiveManager,
  installDepartmentHierarchyRules,
  reconcileEffectiveManagers,
  withRequestedSupervisor,
};

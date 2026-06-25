'use strict';

const defaultDb = require('../database');

class OrganizationRuleError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'OrganizationRuleError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function employeeName(employee) {
  return `${employee?.nom || ''} ${employee?.prenom || ''}`.trim();
}

function createsCycleFromMap(employeeId, managerId, hierarchyMap, overrides = new Map()) {
  const employee = Number(employeeId);
  let current = managerId ? Number(managerId) : null;
  if (!current) return false;
  if (current === employee) return true;

  const visited = new Set();
  for (let depth = 0; depth < 100; depth += 1) {
    if (!current) return false;
    if (current === employee || visited.has(current)) return true;
    visited.add(current);
    current = overrides.has(current)
      ? overrides.get(current)
      : hierarchyMap.get(current) || null;
  }
  return true;
}

function createOrganizationAssignmentService(db = defaultDb) {
  function activeHierarchyMap() {
    const rows = db.prepare(`
      SELECT id, superieur_id
      FROM employes
      WHERE actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).all();
    return new Map(rows.map(row => [Number(row.id), row.superieur_id ? Number(row.superieur_id) : null]));
  }

  function activeEmployee(id) {
    if (!id) return null;
    return db.prepare(`
      SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes
      WHERE id = ? AND actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).get(Number(id)) || null;
  }

  function activeDepartmentByLabel(label) {
    const clean = String(label || '').trim();
    if (!clean) return null;
    return db.prepare(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE libelle = ? AND actif = 1
    `).get(clean) || null;
  }

  function departmentById(id) {
    return db.prepare(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE id = ?
    `).get(Number(id)) || null;
  }

  function assertManagerActive(managerId) {
    const manager = activeEmployee(managerId);
    if (!manager) {
      throw new OrganizationRuleError(
        'Le responsable sélectionné est introuvable ou inactif.',
        'DEPARTMENT_MANAGER_INVALID',
        400,
      );
    }
    return manager;
  }

  function assertNoCycle(employeeId, managerId, hierarchyMap = null, overrides = new Map()) {
    if (!managerId) return;
    const map = hierarchyMap || activeHierarchyMap();
    if (createsCycleFromMap(employeeId, managerId, map, overrides)) {
      throw new OrganizationRuleError(
        'Cette affectation créerait une boucle hiérarchique.',
        'CYCLE_HIERARCHIQUE',
        409,
        { employee_id: Number(employeeId), manager_id: Number(managerId) },
      );
    }
  }

  function resolveAgentAssignment(payload, { employeeId = null, current = null } = {}) {
    const departmentLabel = String(payload.departement || '').trim();
    const previousLabel = String(current?.departement || '').trim();

    if (!departmentLabel) {
      if (previousLabel !== departmentLabel) {
        payload.superieur_id = null;
        payload.superieur_hierarchique = '';
      }
      return { department: null, manager: null, selfManager: false };
    }

    const department = activeDepartmentByLabel(departmentLabel);
    if (!department) {
      throw new OrganizationRuleError(
        `Département actif introuvable : ${departmentLabel}`,
        'DEPARTMENT_NOT_FOUND',
      );
    }
    if (!department.responsable_id) {
      throw new OrganizationRuleError(
        `Le département « ${department.libelle} » ne possède aucun responsable.`,
        'DEPARTMENT_MANAGER_REQUIRED',
      );
    }

    const manager = assertManagerActive(department.responsable_id);
    if (employeeId && Number(manager.id) === Number(employeeId)) {
      const requestedManagerId = payload.superieur_id ? Number(payload.superieur_id) : null;
      if (requestedManagerId === Number(employeeId)) {
        payload.superieur_id = null;
        payload.superieur_hierarchique = '';
        return { department, manager, selfManager: true, ownManager: null };
      }
      if (!requestedManagerId) {
        payload.superieur_id = null;
        payload.superieur_hierarchique = '';
        return { department, manager, selfManager: true, ownManager: null };
      }
      const ownManager = assertManagerActive(requestedManagerId);
      assertNoCycle(employeeId, ownManager.id);
      payload.superieur_id = Number(ownManager.id);
      payload.superieur_hierarchique = employeeName(ownManager);
      return { department, manager, selfManager: true, ownManager };
    }

    if (employeeId) assertNoCycle(employeeId, manager.id);
    payload.superieur_id = Number(manager.id);
    payload.superieur_hierarchique = employeeName(manager);
    return { department, manager, selfManager: false };
  }

  function assertSupervisorChange(employeeId, requestedManagerId) {
    const employee = activeEmployee(employeeId);
    if (!employee) {
      throw new OrganizationRuleError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_FOUND', 404);
    }

    const department = activeDepartmentByLabel(employee.departement);
    const requestedId = requestedManagerId ? Number(requestedManagerId) : null;

    if (department?.responsable_id && Number(department.responsable_id) !== Number(employee.id)) {
      if (requestedId !== Number(department.responsable_id)) {
        throw new OrganizationRuleError(
          'Le supérieur de cet agent est imposé par le responsable de son département.',
          'DEPARTMENT_MANAGER_ENFORCED',
          409,
          { expected_manager_id: Number(department.responsable_id) },
        );
      }
    }

    if (!requestedId) return { employee, manager: null, department };
    const manager = assertManagerActive(requestedId);
    assertNoCycle(employee.id, manager.id);
    return { employee, manager, department };
  }

  function departmentAgentCount(label) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS total
      FROM employes
      WHERE departement = ? AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).get(String(label || '').trim())?.total || 0);
  }

  function recordSupervisorMutation(employee, manager, actorUserId, motif) {
    try {
      db.prepare(`
        INSERT INTO employes_mutations
          (employe_id, date_effet, type_mutation,
           ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
           ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
           nouveau_sup_id, nouveau_sup_nom, motif, statut, created_by)
        VALUES (?, ?, 'modification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'effectif', ?)
      `).run(
        Number(employee.id), new Date().toISOString().slice(0, 10),
        employee.poste || null, employee.poste || null,
        employee.departement || null, employee.departement || null,
        employee.site || null, employee.site || null,
        employee.superieur_id || null, employee.superieur_hierarchique || null,
        manager?.id || null, manager ? employeeName(manager) : null,
        motif || 'Synchronisation du responsable de département',
        actorUserId || null,
      );
    } catch (_) {}
  }

  function synchronizeDepartmentManager({ departmentId, managerId, actorUserId = null, motif = '' }) {
    const department = departmentById(departmentId);
    if (!department) {
      throw new OrganizationRuleError('Département introuvable.', 'DEPARTMENT_NOT_FOUND', 404);
    }
    if (!managerId) {
      throw new OrganizationRuleError(
        'Le responsable du département est obligatoire.',
        'DEPARTMENT_MANAGER_REQUIRED',
      );
    }

    const manager = assertManagerActive(managerId);
    const employees = db.prepare(`
      SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes
      WHERE departement = ? AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
      ORDER BY id
    `).all(department.libelle);

    const hierarchyMap = activeHierarchyMap();
    const departmentIds = new Set(employees.map(employee => Number(employee.id)));
    let managerAncestor = hierarchyMap.get(Number(manager.id)) || null;
    let managerMustDetach = false;
    const inspected = new Set();
    while (managerAncestor && !inspected.has(managerAncestor)) {
      if (departmentIds.has(Number(managerAncestor))) {
        managerMustDetach = true;
        break;
      }
      inspected.add(managerAncestor);
      managerAncestor = hierarchyMap.get(Number(managerAncestor)) || null;
    }

    const overrides = new Map();
    if (managerMustDetach) overrides.set(Number(manager.id), null);
    for (const employee of employees) {
      if (Number(employee.id) === Number(manager.id)) continue;
      assertNoCycle(employee.id, manager.id, hierarchyMap, overrides);
    }

    const execute = db.transaction(() => {
      db.prepare(`
        UPDATE org_departements
        SET responsable_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(Number(manager.id), Number(department.id));

      let managerDetached = false;
      if (managerMustDetach && manager.superieur_id) {
        const before = db.prepare('SELECT * FROM employes WHERE id = ?').get(manager.id);
        db.prepare(`
          UPDATE employes
          SET superieur_id = NULL, superieur_hierarchique = '', updated_at = datetime('now')
          WHERE id = ?
        `).run(manager.id);
        recordSupervisorMutation(before, null, actorUserId, motif || 'Responsable de département détaché de sa propre chaîne');
        managerDetached = true;
      }

      let changedAgents = 0;
      for (const employee of employees) {
        if (Number(employee.id) === Number(manager.id)) continue;
        if (Number(employee.superieur_id) === Number(manager.id) && employee.superieur_hierarchique === employeeName(manager)) continue;
        db.prepare(`
          UPDATE employes
          SET superieur_id = ?, superieur_hierarchique = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(Number(manager.id), employeeName(manager), Number(employee.id));
        recordSupervisorMutation(employee, manager, actorUserId, motif);
        changedAgents += 1;
      }

      return { department, manager, changedAgents, managerDetached };
    });

    return execute();
  }

  function assertDepartmentCanDeactivate(departmentId) {
    const department = departmentById(departmentId);
    if (!department) {
      throw new OrganizationRuleError('Département introuvable.', 'DEPARTMENT_NOT_FOUND', 404);
    }
    const count = departmentAgentCount(department.libelle);
    if (count > 0) {
      throw new OrganizationRuleError(
        `Désactivation impossible : ${count} agent(s) sont encore rattachés à ce département.`,
        'DEPARTMENT_IN_USE',
        409,
        { agent_count: count },
      );
    }
    return department;
  }

  return {
    OrganizationRuleError,
    activeDepartmentByLabel,
    activeEmployee,
    activeHierarchyMap,
    assertDepartmentCanDeactivate,
    assertManagerActive,
    assertNoCycle,
    assertSupervisorChange,
    createsCycleFromMap,
    departmentAgentCount,
    resolveAgentAssignment,
    synchronizeDepartmentManager,
  };
}

const service = createOrganizationAssignmentService();

module.exports = {
  ...service,
  OrganizationRuleError,
  createOrganizationAssignmentService,
  createsCycleFromMap,
};

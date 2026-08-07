'use strict';

const defaultDb = require('../db');

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
  async function activeHierarchyMap(dbc = db) {
    const rows = await dbc.query(`
      SELECT id, superieur_id
      FROM employes
      WHERE actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `);
    return new Map(rows.map(row => [Number(row.id), row.superieur_id ? Number(row.superieur_id) : null]));
  }

  async function activeEmployee(id, dbc = db) {
    if (!id) return null;
    return dbc.queryOne(`
      SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes
      WHERE id = ? AND actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `, [Number(id)]);
  }

  async function activeDepartmentByLabel(label, dbc = db) {
    const clean = String(label || '').trim();
    if (!clean) return null;
    return dbc.queryOne(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE libelle = ? AND actif = 1
    `, [clean]);
  }

  async function departmentById(id, dbc = db) {
    return dbc.queryOne(`
      SELECT id, libelle, responsable_id, actif
      FROM org_departements
      WHERE id = ?
    `, [Number(id)]);
  }

  async function assertManagerActive(managerId, dbc = db) {
    const manager = await activeEmployee(managerId, dbc);
    if (!manager) {
      throw new OrganizationRuleError(
        'Le responsable sélectionné est introuvable ou inactif.',
        'DEPARTMENT_MANAGER_INVALID',
        400,
      );
    }
    return manager;
  }

  async function assertNoCycle(employeeId, managerId, hierarchyMap = null, overrides = new Map(), dbc = db) {
    if (!managerId) return;
    const map = hierarchyMap || await activeHierarchyMap(dbc);
    if (createsCycleFromMap(employeeId, managerId, map, overrides)) {
      throw new OrganizationRuleError(
        'Cette affectation créerait une boucle hiérarchique.',
        'CYCLE_HIERARCHIQUE',
        409,
        { employee_id: Number(employeeId), manager_id: Number(managerId) },
      );
    }
  }

  async function resolveAgentAssignment(payload, { employeeId = null, current = null, allowMutationWorkflow = false } = {}) {
    void allowMutationWorkflow;
    const departmentLabel = String(payload.departement || '').trim();
    const previousLabel = String(current?.departement || '').trim();

    if (!departmentLabel) {
      if (previousLabel !== departmentLabel) {
        payload.superieur_id = null;
        payload.superieur_hierarchique = '';
      }
      return { department: null, manager: null, selfManager: false };
    }

    const department = await activeDepartmentByLabel(departmentLabel);
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

    const manager = await assertManagerActive(department.responsable_id);
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
      const ownManager = await assertManagerActive(requestedManagerId);
      await assertNoCycle(employeeId, ownManager.id);
      payload.superieur_id = Number(ownManager.id);
      payload.superieur_hierarchique = employeeName(ownManager);
      return { department, manager, selfManager: true, ownManager };
    }

    if (employeeId) await assertNoCycle(employeeId, manager.id);
    payload.superieur_id = Number(manager.id);
    payload.superieur_hierarchique = employeeName(manager);
    return { department, manager, selfManager: false };
  }

  async function assertSupervisorChange(employeeId, requestedManagerId) {
    const employee = await activeEmployee(employeeId);
    if (!employee) {
      throw new OrganizationRuleError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_FOUND', 404);
    }

    const department = await activeDepartmentByLabel(employee.departement);
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
    const manager = await assertManagerActive(requestedId);
    await assertNoCycle(employee.id, manager.id);
    return { employee, manager, department };
  }

  async function departmentAgentCount(label, dbc = db) {
    const row = await dbc.queryOne(`
      SELECT COUNT(*) AS total
      FROM employes
      WHERE departement = ? AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `, [String(label || '').trim()]);
    return Number(row?.total || 0);
  }

  async function recordSupervisorMutation(dbc, employee, manager, actorUserId, motif) {
    await dbc.execute(`
      INSERT INTO employes_mutations
        (employe_id, date_effet, type_mutation,
         ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
         ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
         nouveau_sup_id, nouveau_sup_nom, motif, statut, created_by)
      VALUES (?, ?, 'modification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'effectif', ?)
    `, [
      Number(employee.id), new Date().toISOString().slice(0, 10),
      employee.poste || null, employee.poste || null,
      employee.departement || null, employee.departement || null,
      employee.site || null, employee.site || null,
      employee.superieur_id || null, employee.superieur_hierarchique || null,
      manager?.id || null, manager ? employeeName(manager) : null,
      motif || 'Synchronisation du responsable de département',
      actorUserId || null,
    ]);
  }

  async function synchronizeDepartmentManager({
    departmentId,
    managerId,
    actorUserId = null,
    motif = '',
    failAfterDepartmentUpdate = false,
  }) {
    const department = await departmentById(departmentId);
    if (!department) {
      throw new OrganizationRuleError('Département introuvable.', 'DEPARTMENT_NOT_FOUND', 404);
    }
    if (!managerId) {
      throw new OrganizationRuleError(
        'Le responsable du département est obligatoire.',
        'DEPARTMENT_MANAGER_REQUIRED',
      );
    }

    const manager = await assertManagerActive(managerId);
    const employees = await db.query(`
      SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique
      FROM employes
      WHERE departement = ? AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
      ORDER BY id
    `, [department.libelle]);

    const hierarchyMap = await activeHierarchyMap();
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
      await assertNoCycle(employee.id, manager.id, hierarchyMap, overrides);
    }

    return db.transaction(async tx => {
      await tx.execute(`
        UPDATE org_departements
        SET responsable_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [Number(manager.id), Number(department.id)]);

      if (failAfterDepartmentUpdate) {
        throw new Error('ORG_ASSIGNMENT_TEST_FAILURE_AFTER_DEPARTMENT_UPDATE');
      }

      let managerDetached = false;
      if (managerMustDetach && manager.superieur_id) {
        const before = await tx.queryOne('SELECT * FROM employes WHERE id = ?', [manager.id]);
        await tx.execute(`
          UPDATE employes
          SET superieur_id = NULL, superieur_hierarchique = '', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [manager.id]);
        await recordSupervisorMutation(tx, before, null, actorUserId, motif || 'Responsable de département détaché de sa propre chaîne');
        managerDetached = true;
      }

      let changedAgents = 0;
      for (const employee of employees) {
        if (Number(employee.id) === Number(manager.id)) continue;
        if (Number(employee.superieur_id) === Number(manager.id) && employee.superieur_hierarchique === employeeName(manager)) continue;
        await tx.execute(`
          UPDATE employes
          SET superieur_id = ?, superieur_hierarchique = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [Number(manager.id), employeeName(manager), Number(employee.id)]);
        await recordSupervisorMutation(tx, employee, manager, actorUserId, motif);
        changedAgents += 1;
      }

      return { department, manager, changedAgents, managerDetached };
    });
  }

  async function assertDepartmentCanDeactivate(departmentId) {
    const department = await departmentById(departmentId);
    if (!department) {
      throw new OrganizationRuleError('Département introuvable.', 'DEPARTMENT_NOT_FOUND', 404);
    }
    const count = await departmentAgentCount(department.libelle);
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

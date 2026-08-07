'use strict';

const defaultDb = require('../db');
const { createsCycleFromMap } = require('./organization_assignment');

const FIX_PRIORITY = {
  AGENT_MANAGER_MISMATCH: 100,
  AGENT_SELF_SUPERVISION: 90,
  AGENT_SUPERVISOR_INVALID: 80,
  AGENT_MANAGER_NAME_STALE: 70,
  AGENT_SUPERVISOR_NAME_STALE: 10,
};

function activeEmployee(row) {
  return Number(row?.actif) === 1 && !['sorti', 'archive'].includes(String(row?.statut_dossier || 'actif'));
}

function fullName(row) {
  return `${row?.nom || ''} ${row?.prenom || ''}`.trim();
}

function canonicalCycle(cycle) {
  if (!cycle.length) return [];
  const minIndex = cycle.reduce((best, value, index) => Number(value) < Number(cycle[best]) ? index : best, 0);
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)].map(Number);
}

function findCycles(hierarchyMap) {
  const completed = new Set();
  const unique = new Map();
  for (const start of hierarchyMap.keys()) {
    if (completed.has(start)) continue;
    const path = [];
    const position = new Map();
    let current = start;
    while (current && hierarchyMap.has(current)) {
      if (position.has(current)) {
        const cycle = canonicalCycle(path.slice(position.get(current)));
        unique.set(cycle.join('>'), cycle);
        break;
      }
      if (completed.has(current)) break;
      position.set(current, path.length);
      path.push(current);
      current = hierarchyMap.get(current) || null;
    }
    path.forEach(id => completed.add(id));
  }
  return [...unique.values()];
}

function summarize(anomalies, fixes) {
  const byCode = {};
  const bySeverity = { critical: 0, error: 0, warning: 0 };
  for (const anomaly of anomalies) {
    byCode[anomaly.code] = (byCode[anomaly.code] || 0) + 1;
    bySeverity[anomaly.severity] = (bySeverity[anomaly.severity] || 0) + 1;
  }
  return {
    total_anomalies: anomalies.length,
    repairable_anomalies: anomalies.filter(item => item.repairable).length,
    manual_anomalies: anomalies.filter(item => !item.repairable).length,
    planned_employee_changes: fixes.length,
    by_severity: bySeverity,
    by_code: byCode,
  };
}

function analyzeOrganizationRows({ employees = [], departments = [] }) {
  const activeEmployees = employees.filter(activeEmployee);
  const employeesById = new Map(activeEmployees.map(row => [Number(row.id), row]));
  const departmentsByLabel = new Map(departments.map(row => [String(row.libelle || '').trim(), row]));
  const anomalies = [];
  const candidates = new Map();

  const addAnomaly = anomaly => anomalies.push({ repairable: false, ...anomaly });
  const propose = (employee, newSupervisor, reason) => {
    const employeeId = Number(employee.id);
    const priority = FIX_PRIORITY[reason] || 0;
    const targetId = newSupervisor ? Number(newSupervisor.id) : null;
    const targetName = newSupervisor ? fullName(newSupervisor) : null;
    const existing = candidates.get(employeeId) || {
      employee_id: employeeId,
      employee_name: fullName(employee),
      department: String(employee.departement || '').trim() || null,
      old_supervisor_id: employee.superieur_id ? Number(employee.superieur_id) : null,
      old_supervisor_name: employee.superieur_hierarchique || null,
      new_supervisor_id: targetId,
      new_supervisor_name: targetName,
      reasons: [],
      _priority: -1,
    };
    if (priority >= existing._priority) {
      existing.new_supervisor_id = targetId;
      existing.new_supervisor_name = targetName;
      existing._priority = priority;
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    candidates.set(employeeId, existing);
  };

  for (const department of departments) {
    if (Number(department.actif) !== 1) continue;
    const managerId = department.responsable_id ? Number(department.responsable_id) : null;
    if (!managerId) {
      addAnomaly({ code: 'DEPARTMENT_MANAGER_MISSING', severity: 'critical', entity_type: 'department', entity_id: Number(department.id), label: department.libelle, message: 'Département actif sans responsable.' });
      continue;
    }
    const manager = employeesById.get(managerId);
    if (!manager) {
      addAnomaly({ code: 'DEPARTMENT_MANAGER_INACTIVE', severity: 'critical', entity_type: 'department', entity_id: Number(department.id), label: department.libelle, message: 'Le responsable du département est introuvable, sorti, archivé ou inactif.', details: { responsable_id: managerId } });
      continue;
    }
    const managerDepartment = String(manager.departement || '').trim();
    if (managerDepartment && managerDepartment !== String(department.libelle || '').trim()) {
      addAnomaly({ code: 'DEPARTMENT_MANAGER_OUTSIDE_DEPARTMENT', severity: 'warning', entity_type: 'department', entity_id: Number(department.id), label: department.libelle, message: 'Le responsable est rattaché à un autre département. Vérification RH nécessaire.', details: { responsable_id: managerId, responsable_nom: fullName(manager), responsable_departement: managerDepartment } });
    }
  }

  for (const employee of activeEmployees) {
    const employeeId = Number(employee.id);
    const departmentLabel = String(employee.departement || '').trim();
    const currentSupervisorId = employee.superieur_id ? Number(employee.superieur_id) : null;
    const currentSupervisor = currentSupervisorId ? employeesById.get(currentSupervisorId) : null;

    if (!departmentLabel) {
      addAnomaly({ code: 'AGENT_WITHOUT_DEPARTMENT', severity: 'warning', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Agent actif sans département.' });
    } else {
      const department = departmentsByLabel.get(departmentLabel);
      if (!department) {
        addAnomaly({ code: 'AGENT_DEPARTMENT_UNKNOWN', severity: 'error', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Le département de l’agent n’existe pas.', details: { departement: departmentLabel } });
      } else if (Number(department.actif) !== 1) {
        addAnomaly({ code: 'AGENT_DEPARTMENT_INACTIVE', severity: 'error', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'L’agent est rattaché à un département désactivé.', details: { departement: departmentLabel } });
      } else if (department.responsable_id) {
        const manager = employeesById.get(Number(department.responsable_id));
        if (manager && Number(manager.id) !== employeeId) {
          const expectedName = fullName(manager);
          if (currentSupervisorId !== Number(manager.id)) {
            addAnomaly({ code: 'AGENT_MANAGER_MISMATCH', severity: 'error', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Le supérieur ne correspond pas au responsable du département.', details: { departement: departmentLabel, actuel_id: currentSupervisorId, attendu_id: Number(manager.id), attendu_nom: expectedName }, repair_key: employeeId });
            propose(employee, manager, 'AGENT_MANAGER_MISMATCH');
          } else if (String(employee.superieur_hierarchique || '') !== expectedName) {
            addAnomaly({ code: 'AGENT_MANAGER_NAME_STALE', severity: 'warning', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Le nom enregistré du supérieur est obsolète.', details: { actuel: employee.superieur_hierarchique || null, attendu: expectedName }, repair_key: employeeId });
            propose(employee, manager, 'AGENT_MANAGER_NAME_STALE');
          }
        }
      }
    }

    if (currentSupervisorId === employeeId) {
      addAnomaly({ code: 'AGENT_SELF_SUPERVISION', severity: 'critical', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'L’agent est son propre supérieur.', repair_key: employeeId });
      const department = departmentLabel ? departmentsByLabel.get(departmentLabel) : null;
      const manager = department?.responsable_id ? employeesById.get(Number(department.responsable_id)) : null;
      if (manager && Number(manager.id) !== employeeId) propose(employee, manager, 'AGENT_SELF_SUPERVISION');
      else propose(employee, null, 'AGENT_SELF_SUPERVISION');
    } else if (currentSupervisorId && !currentSupervisor) {
      addAnomaly({ code: 'AGENT_SUPERVISOR_INVALID', severity: 'error', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Le supérieur enregistré est introuvable ou inactif.', details: { superieur_id: currentSupervisorId }, repair_key: employeeId });
      const department = departmentLabel ? departmentsByLabel.get(departmentLabel) : null;
      const manager = department?.responsable_id ? employeesById.get(Number(department.responsable_id)) : null;
      if (manager && Number(manager.id) !== employeeId) propose(employee, manager, 'AGENT_SUPERVISOR_INVALID');
      else propose(employee, null, 'AGENT_SUPERVISOR_INVALID');
    } else if (currentSupervisor && String(employee.superieur_hierarchique || '') !== fullName(currentSupervisor)) {
      addAnomaly({ code: 'AGENT_SUPERVISOR_NAME_STALE', severity: 'warning', entity_type: 'employee', entity_id: employeeId, label: fullName(employee), message: 'Le nom enregistré du supérieur ne correspond plus à sa fiche.', repair_key: employeeId, details: { actuel: employee.superieur_hierarchique || null, attendu: fullName(currentSupervisor) } });
      propose(employee, currentSupervisor, 'AGENT_SUPERVISOR_NAME_STALE');
    }
  }

  const currentHierarchy = new Map(activeEmployees.map(row => [Number(row.id), row.superieur_id ? Number(row.superieur_id) : null]));
  const currentCycles = findCycles(currentHierarchy);
  currentCycles.forEach((cycle, index) => {
    addAnomaly({ code: 'HIERARCHY_CYCLE', severity: 'critical', entity_type: 'hierarchy', entity_id: index + 1, label: `Cycle ${index + 1}`, message: 'Une boucle hiérarchique est présente.', details: { employee_ids: cycle, employee_names: cycle.map(id => fullName(employeesById.get(id))) }, cycle_members: cycle });
  });

  let safeCandidates = new Map(candidates);
  let changed = true;
  while (changed) {
    changed = false;
    const projected = new Map(currentHierarchy);
    safeCandidates.forEach(fix => projected.set(fix.employee_id, fix.new_supervisor_id));
    for (const [employeeId, fix] of [...safeCandidates.entries()]) {
      const graphChanges = Number(fix.old_supervisor_id || 0) !== Number(fix.new_supervisor_id || 0);
      if (graphChanges && fix.new_supervisor_id && createsCycleFromMap(employeeId, fix.new_supervisor_id, projected)) {
        safeCandidates.delete(employeeId);
        changed = true;
      }
    }
  }

  const projectedHierarchy = new Map(currentHierarchy);
  safeCandidates.forEach(fix => projectedHierarchy.set(fix.employee_id, fix.new_supervisor_id));
  const projectedCycles = findCycles(projectedHierarchy);
  const projectedCycleMembers = new Set(projectedCycles.flat());
  for (const anomaly of anomalies) {
    if (anomaly.repair_key) anomaly.repairable = safeCandidates.has(Number(anomaly.repair_key));
    if (anomaly.code === 'HIERARCHY_CYCLE') anomaly.repairable = (anomaly.cycle_members || []).every(id => !projectedCycleMembers.has(Number(id)));
    delete anomaly.repair_key;
    delete anomaly.cycle_members;
  }
  const fixes = [...safeCandidates.values()].sort((a, b) => a.employee_id - b.employee_id).map(({ _priority, ...fix }) => fix);
  return {
    generated_at: new Date().toISOString(),
    summary: summarize(anomalies, fixes),
    anomalies,
    planned_changes: fixes,
    projected_cycles: projectedCycles,
  };
}

function createOrganizationIntegrityAuditService(db = defaultDb) {
  async function loadRows() {
    const [employees, departments] = await Promise.all([
      db.query(`SELECT id, nom, prenom, poste, departement, site, superieur_id, superieur_hierarchique, actif, statut_dossier FROM employes ORDER BY id`),
      db.query(`SELECT id, libelle, code, responsable_id, actif FROM org_departements ORDER BY id`),
    ]);
    return { employees, departments };
  }

  async function scanIntegrity() {
    return analyzeOrganizationRows(await loadRows());
  }

  async function recordMutation(tx, employee, fix, actorUserId, runId) {
    await tx.execute(`
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
      fix.new_supervisor_id, fix.new_supervisor_name,
      `Réparation d’intégrité organisationnelle ${runId}: ${fix.reasons.join(', ')}`,
      actorUserId || null,
    ]);
  }

  async function recordAudit(tx, employee, fix, actorUserId, runId) {
    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES ('employes', ?, 'organization_integrity_repair', ?, ?, CURRENT_TIMESTAMP)
    `, [Number(employee.id), JSON.stringify({
      run_id: runId,
      ancien_superieur_id: employee.superieur_id || null,
      ancien_superieur_nom: employee.superieur_hierarchique || null,
      nouveau_superieur_id: fix.new_supervisor_id,
      nouveau_superieur_nom: fix.new_supervisor_name,
      raisons: fix.reasons,
    }), actorUserId || null]);
  }

  async function repairIntegrity({ dryRun = true, actorUserId = null, failAfterEmployeeUpdate = false } = {}) {
    const before = await scanIntegrity();
    if (dryRun) return { dry_run: true, run_id: null, before, applied_changes: [], skipped_changes: [], after: null };

    const runId = `org-repair-${Date.now().toString(36)}`;
    const appliedChanges = [];
    const skippedChanges = [];
    await db.transaction(async tx => {
      for (const fix of before.planned_changes) {
        const employee = await tx.queryOne('SELECT * FROM employes WHERE id = ?', [Number(fix.employee_id)]);
        if (!employee || !activeEmployee(employee)) {
          skippedChanges.push({ ...fix, reason: 'EMPLOYEE_CHANGED_OR_INACTIVE' });
          continue;
        }
        const currentId = employee.superieur_id ? Number(employee.superieur_id) : null;
        const currentName = employee.superieur_hierarchique || null;
        if (currentId !== fix.old_supervisor_id || String(currentName || '') !== String(fix.old_supervisor_name || '')) {
          skippedChanges.push({ ...fix, reason: 'CONCURRENT_CHANGE_DETECTED' });
          continue;
        }
        if (currentId === fix.new_supervisor_id && String(currentName || '') === String(fix.new_supervisor_name || '')) continue;

        await tx.execute(`
          UPDATE employes
          SET superieur_id = ?, superieur_hierarchique = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [fix.new_supervisor_id, fix.new_supervisor_name || '', Number(fix.employee_id)]);

        if (failAfterEmployeeUpdate) throw new Error('ORG_INTEGRITY_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE');

        await recordMutation(tx, employee, fix, actorUserId, runId);
        await recordAudit(tx, employee, fix, actorUserId, runId);
        appliedChanges.push({ ...fix, applied: true });
      }

      await tx.execute(`
        INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
        VALUES ('organization_integrity', 0, 'repair_run', ?, ?, CURRENT_TIMESTAMP)
      `, [JSON.stringify({
        run_id: runId,
        anomalies_before: before.summary.total_anomalies,
        planned_changes: before.planned_changes.length,
        applied_changes: appliedChanges.length,
        skipped_changes: skippedChanges.length,
      }), actorUserId || null]);
    });

    return {
      dry_run: false,
      run_id: runId,
      before,
      applied_changes: appliedChanges,
      skipped_changes: skippedChanges,
      after: await scanIntegrity(),
    };
  }

  return { scanIntegrity, repairIntegrity };
}

const service = createOrganizationIntegrityAuditService();
module.exports = { ...service, activeEmployee, analyzeOrganizationRows, createOrganizationIntegrityAuditService, findCycles };

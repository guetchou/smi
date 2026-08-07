'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const organizationSvc = require('../services/organization_assignment');
const integrityAuditRouter = require('./organization_integrity_audit');

const router = express.Router();
router.use(integrityAuditRouter);

async function canManage(req) {
  if (hasRole(req.user, 'admin', 'rh', 'dg')) return true;
  return can(req.user, 'hr.agent.update');
}

async function audit(dbc, table, recordId, action, details, userId) {
  try {
    await dbc.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [table, recordId, action, JSON.stringify(details || {}), userId || null]);
  } catch (_) {}
}

function sendRuleError(res, error) {
  if (!(error instanceof organizationSvc.OrganizationRuleError) && !error?.code) return false;
  res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
    details: error.details || undefined,
  });
  return true;
}

function fullName(employee) {
  return `${employee?.nom || ''} ${employee?.prenom || ''}`.trim();
}

async function recordSupervisorMutation(dbc, employee, manager, actorUserId, motif) {
  try {
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
      manager?.id || null, manager ? fullName(manager) : null,
      motif || 'Changement du supérieur hiérarchique',
      actorUserId || null,
    ]);
  } catch (_) {}
}

router.put('/:id/superieur', async (req, res, next) => {
  try {
    if (!(await canManage(req))) return res.status(403).json({ error: 'Permission RH requise' });

    const employeeId = Number(req.params.id);
    const requestedManagerId = req.body?.superieur_id ? Number(req.body.superieur_id) : null;
    const { employee, manager } = await organizationSvc.assertSupervisorChange(employeeId, requestedManagerId);
    const managerName = manager ? fullName(manager) : null;

    if (Number(employee.superieur_id || 0) === Number(requestedManagerId || 0)
      && String(employee.superieur_hierarchique || '') === String(managerName || '')) {
      return res.json({ ok: true, unchanged: true, superieur_id: requestedManagerId, superieur_nom: managerName });
    }

    await db.transaction(async tx => {
      await tx.execute(`
        UPDATE employes
        SET superieur_id = ?, superieur_hierarchique = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [requestedManagerId, managerName, employeeId]);
      await recordSupervisorMutation(tx, employee, manager, req.user?.id, req.body?.motif);
      await audit(tx, 'employes', employeeId, 'superieur_modifie', {
        ancien: employee.superieur_id || null,
        nouveau: requestedManagerId,
        nom: managerName,
      }, req.user?.id);
    });

    res.json({ ok: true, superieur_id: requestedManagerId, superieur_nom: managerName });
  } catch (error) {
    if (sendRuleError(res, error)) return;
    next(error);
  }
});

router.post('/departements', async (req, res, next) => {
  let createdDepartmentId = null;
  try {
    if (!(await canManage(req))) return res.status(403).json({ error: 'Permission RH requise' });

    const libelle = String(req.body?.libelle || '').trim();
    const code = String(req.body?.code || '').trim();
    const description = String(req.body?.description || '').trim();
    const managerId = req.body?.responsable_id ? Number(req.body.responsable_id) : null;
    if (!libelle) return res.status(400).json({ error: 'Libellé requis', code: 'DEPARTMENT_LABEL_REQUIRED' });
    if (!managerId) return res.status(400).json({ error: 'Le responsable du département est obligatoire.', code: 'DEPARTMENT_MANAGER_REQUIRED' });

    await organizationSvc.assertManagerActive(managerId);
    const existing = await db.queryOne('SELECT id FROM org_departements WHERE libelle = ?', [libelle]);
    if (existing) return res.status(409).json({ error: 'Ce département existe déjà', code: 'DEPARTMENT_DUPLICATE' });

    const result = await db.execute(`
      INSERT INTO org_departements (libelle, code, responsable_id, description, actif)
      VALUES (?, ?, ?, ?, 1)
    `, [libelle, code, managerId, description]);
    createdDepartmentId = Number(result.insertId);

    const sync = await organizationSvc.synchronizeDepartmentManager({
      departmentId: createdDepartmentId,
      managerId,
      actorUserId: req.user?.id,
      motif: 'Création du département et synchronisation hiérarchique',
    });
    await audit(db, 'org_departements', createdDepartmentId, 'create', {
      libelle,
      responsable_id: managerId,
      agents_synchronises: sync.changedAgents,
    }, req.user?.id);

    res.status(201).json({
      id: createdDepartmentId,
      libelle,
      responsable_id: managerId,
      agents_synchronises: sync.changedAgents,
    });
  } catch (error) {
    if (createdDepartmentId) {
      try { await db.execute('DELETE FROM org_departements WHERE id = ?', [createdDepartmentId]); } catch (_) {}
    }
    if (sendRuleError(res, error)) return;
    next(error);
  }
});

router.put('/departements/:id', async (req, res, next) => {
  try {
    if (!(await canManage(req))) return res.status(403).json({ error: 'Permission RH requise' });

    const id = Number(req.params.id);
    const current = await db.queryOne('SELECT * FROM org_departements WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Département introuvable', code: 'DEPARTMENT_NOT_FOUND' });

    const requestedActive = req.body?.actif === undefined ? Boolean(current.actif) : Boolean(req.body.actif);
    if (!requestedActive) {
      await organizationSvc.assertDepartmentCanDeactivate(id);
      await db.execute(`
        UPDATE org_departements
        SET actif = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [id]);
      await audit(db, 'org_departements', id, 'deactivate', { libelle: current.libelle }, req.user?.id);
      return res.json({ ok: true, actif: false });
    }

    const libelle = req.body?.libelle === undefined ? current.libelle : String(req.body.libelle || '').trim();
    const code = req.body?.code === undefined ? current.code : String(req.body.code || '').trim();
    const description = req.body?.description === undefined ? current.description : String(req.body.description || '').trim();
    const managerId = req.body?.responsable_id === undefined
      ? Number(current.responsable_id || 0) || null
      : (req.body.responsable_id ? Number(req.body.responsable_id) : null);

    if (!libelle) return res.status(400).json({ error: 'Libellé requis', code: 'DEPARTMENT_LABEL_REQUIRED' });
    if (!managerId) return res.status(400).json({ error: 'Le responsable du département est obligatoire.', code: 'DEPARTMENT_MANAGER_REQUIRED' });
    await organizationSvc.assertManagerActive(managerId);

    const count = await organizationSvc.departmentAgentCount(current.libelle);
    if (count > 0 && libelle !== current.libelle) {
      return res.status(409).json({
        error: 'Renommage impossible tant que des agents sont rattachés au département.',
        code: 'DEPARTMENT_RENAME_IN_USE',
        details: { agent_count: count },
      });
    }

    const duplicate = await db.queryOne('SELECT id FROM org_departements WHERE libelle = ? AND id != ?', [libelle, id]);
    if (duplicate) return res.status(409).json({ error: 'Ce département existe déjà', code: 'DEPARTMENT_DUPLICATE' });

    const sync = await organizationSvc.synchronizeDepartmentManager({
      departmentId: id,
      managerId,
      actorUserId: req.user?.id,
      motif: 'Changement du responsable de département',
    });

    await db.execute(`
      UPDATE org_departements
      SET libelle = ?, code = ?, description = ?, actif = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [libelle, code, description, id]);

    await audit(db, 'org_departements', id, 'update', {
      libelle,
      ancien_responsable_id: current.responsable_id || null,
      responsable_id: managerId,
      agents_synchronises: sync.changedAgents,
      responsable_detache: sync.managerDetached,
    }, req.user?.id);

    res.json({
      ok: true,
      responsable_id: managerId,
      agents_synchronises: sync.changedAgents,
      responsable_detache: sync.managerDetached,
    });
  } catch (error) {
    if (sendRuleError(res, error)) return;
    next(error);
  }
});

async function normalizeMutationHierarchy(req, res, next) {
  try {
    const employeeId = Number(req.body?.employe_id);
    if (!employeeId) return next();
    const employee = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);
    if (!employee) return next();

    const targetDepartment = String(req.body?.nouveau_dept ?? employee.departement ?? '').trim();
    if (!targetDepartment) return next();
    const department = await organizationSvc.activeDepartmentByLabel(targetDepartment);
    if (!department?.responsable_id) {
      throw new organizationSvc.OrganizationRuleError(
        `Le département « ${targetDepartment} » ne possède aucun responsable actif.`,
        'DEPARTMENT_MANAGER_REQUIRED',
      );
    }

    if (Number(department.responsable_id) !== employeeId) {
      await organizationSvc.assertNoCycle(employeeId, department.responsable_id);
      req.body.nouveau_sup_id = Number(department.responsable_id);
    } else if (req.body?.nouveau_sup_id) {
      await organizationSvc.assertSupervisorChange(employeeId, req.body.nouveau_sup_id);
    }
    next();
  } catch (error) {
    if (sendRuleError(res, error)) return;
    next(error);
  }
}

router.post('/mutations', normalizeMutationHierarchy);

router.put('/mutations/:id/approuver', async (req, res, next) => {
  try {
    const mutation = await db.queryOne('SELECT * FROM employes_mutations WHERE id = ?', [Number(req.params.id)]);
    if (!mutation || mutation.statut !== 'propose') return next();
    const targetDepartment = String(mutation.nouveau_dept || mutation.ancien_dept || '').trim();
    if (!targetDepartment) return next();

    const department = await organizationSvc.activeDepartmentByLabel(targetDepartment);
    if (!department?.responsable_id) {
      throw new organizationSvc.OrganizationRuleError(
        `Le département « ${targetDepartment} » ne possède aucun responsable actif.`,
        'DEPARTMENT_MANAGER_REQUIRED',
      );
    }

    if (Number(department.responsable_id) === Number(mutation.employe_id)) {
      if (mutation.nouveau_sup_id) await organizationSvc.assertSupervisorChange(mutation.employe_id, mutation.nouveau_sup_id);
      return next();
    }

    await organizationSvc.assertNoCycle(mutation.employe_id, department.responsable_id);
    const manager = await organizationSvc.assertManagerActive(department.responsable_id);
    await db.execute(`
      UPDATE employes_mutations
      SET nouveau_sup_id = ?, nouveau_sup_nom = ?
      WHERE id = ?
    `, [Number(manager.id), fullName(manager), Number(mutation.id)]);
    next();
  } catch (error) {
    if (sendRuleError(res, error)) return;
    next(error);
  }
});

module.exports = router;

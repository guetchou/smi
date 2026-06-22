'use strict';

const defaultDb = require('../database');
const organizationSvc = require('./organization_assignment');

class MutationWorkflowError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'MutationWorkflowError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const EDITABLE_STATUSES = new Set(['brouillon', 'refuse', 'a_corriger']);
const CANCELLABLE_STATUSES = new Set(['brouillon', 'soumis', 'approuve', 'refuse', 'a_corriger']);
const FINAL_STATUSES = new Set(['effectif', 'annule']);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function nullableId(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function fullName(employee) {
  return `${employee?.nom || ''} ${employee?.prenom || ''}`.trim();
}

function sameValue(a, b) {
  return String(a ?? '') === String(b ?? '');
}

function createOrganizationMutationWorkflow(db = defaultDb) {
  function getMutation(id) {
    return db.prepare(`
      SELECT m.*,
             e.nom AS employe_nom, e.prenom AS employe_prenom, e.matricule AS employe_matricule,
             uc.nom AS created_by_nom, us.nom AS submitted_by_nom,
             ua.nom AS approuve_par_nom, ur.nom AS refused_by_nom,
             ux.nom AS cancelled_by_nom, up.nom AS applied_by_nom
      FROM employes_mutations m
      JOIN employes e ON e.id = m.employe_id
      LEFT JOIN users uc ON uc.id = m.created_by
      LEFT JOIN users us ON us.id = m.submitted_by
      LEFT JOIN users ua ON ua.id = m.approuve_par
      LEFT JOIN users ur ON ur.id = m.refused_by
      LEFT JOIN users ux ON ux.id = m.cancelled_by
      LEFT JOIN users up ON up.id = m.applied_by
      WHERE m.id = ?
    `).get(Number(id)) || null;
  }

  function requireMutation(id) {
    const mutation = getMutation(id);
    if (!mutation) throw new MutationWorkflowError('Mutation introuvable.', 'MUTATION_NOT_FOUND', 404);
    return mutation;
  }

  function requireActiveEmployee(id) {
    const employee = db.prepare(`
      SELECT * FROM employes
      WHERE id = ? AND actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).get(Number(id));
    if (!employee) throw new MutationWorkflowError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_FOUND', 404);
    return employee;
  }

  function listMutations(filters = {}) {
    const where = [];
    const params = [];
    if (filters.statut) { where.push('m.statut = ?'); params.push(clean(filters.statut)); }
    if (filters.employe_id) { where.push('m.employe_id = ?'); params.push(Number(filters.employe_id)); }
    if (filters.date_from) { where.push('COALESCE(m.date_effective, m.date_effet) >= ?'); params.push(clean(filters.date_from)); }
    if (filters.date_to) { where.push('COALESCE(m.date_effective, m.date_effet) <= ?'); params.push(clean(filters.date_to)); }

    return db.prepare(`
      SELECT m.*,
             e.nom AS employe_nom, e.prenom AS employe_prenom, e.matricule AS employe_matricule,
             uc.nom AS created_by_nom, us.nom AS submitted_by_nom,
             ua.nom AS approuve_par_nom, ur.nom AS refused_by_nom,
             ux.nom AS cancelled_by_nom, up.nom AS applied_by_nom
      FROM employes_mutations m
      JOIN employes e ON e.id = m.employe_id
      LEFT JOIN users uc ON uc.id = m.created_by
      LEFT JOIN users us ON us.id = m.submitted_by
      LEFT JOIN users ua ON ua.id = m.approuve_par
      LEFT JOIN users ur ON ur.id = m.refused_by
      LEFT JOIN users ux ON ux.id = m.cancelled_by
      LEFT JOIN users up ON up.id = m.applied_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE m.statut
          WHEN 'soumis' THEN 1 WHEN 'a_corriger' THEN 2 WHEN 'brouillon' THEN 3
          WHEN 'approuve' THEN 4 WHEN 'refuse' THEN 5 WHEN 'effectif' THEN 6 ELSE 7
        END,
        COALESCE(m.date_effective, m.date_effet) ASC,
        m.id DESC
      LIMIT 500
    `).all(...params);
  }

  function resolveTarget(employee, input) {
    const target = {
      poste: clean(input.nouveau_poste, employee.poste || ''),
      departement: clean(input.nouveau_dept, employee.departement || ''),
      site: clean(input.nouveau_site, employee.site || ''),
      superieur_id: nullableId(input.nouveau_sup_id),
      superieur_nom: clean(input.nouveau_sup_nom),
    };

    if (target.departement) {
      const department = organizationSvc.activeDepartmentByLabel(target.departement);
      if (!department) {
        throw new MutationWorkflowError(
          `Département actif introuvable : ${target.departement}`,
          'DEPARTMENT_NOT_FOUND',
        );
      }
      if (!department.responsable_id) {
        throw new MutationWorkflowError(
          `Le département « ${department.libelle} » ne possède aucun responsable actif.`,
          'DEPARTMENT_MANAGER_REQUIRED',
        );
      }

      if (Number(department.responsable_id) !== Number(employee.id)) {
        const manager = organizationSvc.assertManagerActive(department.responsable_id);
        organizationSvc.assertNoCycle(employee.id, manager.id);
        target.superieur_id = Number(manager.id);
        target.superieur_nom = fullName(manager);
      } else if (target.superieur_id) {
        const manager = organizationSvc.assertManagerActive(target.superieur_id);
        organizationSvc.assertNoCycle(employee.id, manager.id);
        target.superieur_nom = fullName(manager);
      } else {
        target.superieur_id = null;
        target.superieur_nom = '';
      }
    } else if (target.superieur_id) {
      const manager = organizationSvc.assertManagerActive(target.superieur_id);
      organizationSvc.assertNoCycle(employee.id, manager.id);
      target.superieur_nom = fullName(manager);
    } else {
      target.superieur_nom = '';
    }

    return target;
  }

  function assertMeaningfulChange(employee, target) {
    const changed = !sameValue(employee.poste, target.poste)
      || !sameValue(employee.departement, target.departement)
      || !sameValue(employee.site, target.site)
      || Number(employee.superieur_id || 0) !== Number(target.superieur_id || 0);
    if (!changed) throw new MutationWorkflowError('Aucun changement organisationnel détecté.', 'NO_ORGANIZATION_CHANGE');
  }

  function createDraft(input, actorUserId) {
    const employee = requireActiveEmployee(input.employe_id);
    const target = resolveTarget(employee, input || {});
    assertMeaningfulChange(employee, target);

    const dateEffective = clean(input.date_effective || input.date_effet);
    if (!dateEffective) throw new MutationWorkflowError('La date d’effet est obligatoire.', 'EFFECTIVE_DATE_REQUIRED');
    const motif = clean(input.motif);
    if (!motif) throw new MutationWorkflowError('Le motif de la mutation est obligatoire.', 'MUTATION_REASON_REQUIRED');

    const result = db.prepare(`
      INSERT INTO employes_mutations
        (employe_id, date_effet, date_effective, type_mutation,
         ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
         ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
         nouveau_sup_id, nouveau_sup_nom, motif, statut, created_by, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, 1)
    `).run(
      Number(employee.id), dateEffective, dateEffective, clean(input.type_mutation, 'modification'),
      employee.poste || null, target.poste || null,
      employee.departement || null, target.departement || null,
      employee.site || null, target.site || null,
      employee.superieur_id || null, employee.superieur_hierarchique || null,
      target.superieur_id, target.superieur_nom || null,
      motif, actorUserId || null,
    );

    return requireMutation(result.lastInsertRowid);
  }

  function updateDraft(id, input, actorUserId) {
    const mutation = requireMutation(id);
    if (!EDITABLE_STATUSES.has(mutation.statut)) {
      throw new MutationWorkflowError('Seules les mutations à préparer ou à corriger peuvent être modifiées.', 'MUTATION_NOT_EDITABLE', 409);
    }
    if (Number(mutation.created_by || 0) !== Number(actorUserId || 0) && mutation.statut === 'brouillon') {
      throw new MutationWorkflowError('Seul l’initiateur peut modifier ce brouillon.', 'MUTATION_OWNER_REQUIRED', 403);
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    const target = resolveTarget(employee, {
      nouveau_poste: input.nouveau_poste ?? mutation.nouveau_poste,
      nouveau_dept: input.nouveau_dept ?? mutation.nouveau_dept,
      nouveau_site: input.nouveau_site ?? mutation.nouveau_site,
      nouveau_sup_id: input.nouveau_sup_id ?? mutation.nouveau_sup_id,
      nouveau_sup_nom: input.nouveau_sup_nom ?? mutation.nouveau_sup_nom,
    });
    assertMeaningfulChange(employee, target);

    const dateEffective = clean(input.date_effective || input.date_effet, mutation.date_effective || mutation.date_effet || '');
    if (!dateEffective) throw new MutationWorkflowError('La date d’effet est obligatoire.', 'EFFECTIVE_DATE_REQUIRED');
    const motif = clean(input.motif, mutation.motif || '');
    if (!motif) throw new MutationWorkflowError('Le motif de la mutation est obligatoire.', 'MUTATION_REASON_REQUIRED');

    db.prepare(`
      UPDATE employes_mutations
      SET date_effet=?, date_effective=?, type_mutation=?,
          ancien_poste=?, nouveau_poste=?, ancien_dept=?, nouveau_dept=?,
          ancien_site=?, nouveau_site=?, ancien_sup_id=?, ancien_sup_nom=?,
          nouveau_sup_id=?, nouveau_sup_nom=?, motif=?, motif_refus=NULL,
          statut='brouillon', revision=revision+1, updated_at=datetime('now')
      WHERE id=?
    `).run(
      dateEffective, dateEffective, clean(input.type_mutation, mutation.type_mutation || 'modification'),
      employee.poste || null, target.poste || null,
      employee.departement || null, target.departement || null,
      employee.site || null, target.site || null,
      employee.superieur_id || null, employee.superieur_hierarchique || null,
      target.superieur_id, target.superieur_nom || null, motif, Number(id),
    );
    return requireMutation(id);
  }

  function submit(id, actorUserId) {
    const mutation = requireMutation(id);
    if (!EDITABLE_STATUSES.has(mutation.statut)) {
      throw new MutationWorkflowError('Cette mutation ne peut pas être soumise dans son état actuel.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) !== Number(actorUserId || 0)) {
      throw new MutationWorkflowError('Seul l’initiateur peut soumettre cette mutation.', 'MUTATION_OWNER_REQUIRED', 403);
    }
    if (!mutation.date_effective && !mutation.date_effet) {
      throw new MutationWorkflowError('La date d’effet est obligatoire.', 'EFFECTIVE_DATE_REQUIRED');
    }

    db.prepare(`
      UPDATE employes_mutations
      SET statut='soumis', submitted_by=?, submitted_at=datetime('now'),
          motif_refus=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function approve(id, actorUserId) {
    const mutation = requireMutation(id);
    if (mutation.statut !== 'soumis') {
      throw new MutationWorkflowError('Seule une mutation soumise peut être approuvée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) === Number(actorUserId || 0)
      || Number(mutation.submitted_by || 0) === Number(actorUserId || 0)) {
      throw new MutationWorkflowError('L’initiateur ne peut pas approuver sa propre mutation.', 'SELF_APPROVAL_FORBIDDEN', 403);
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    const target = resolveTarget(employee, mutation);
    assertMeaningfulChange(employee, target);

    db.prepare(`
      UPDATE employes_mutations
      SET nouveau_sup_id=?, nouveau_sup_nom=?, statut='approuve',
          approuve_par=?, approuve_at=datetime('now'), date_effective=COALESCE(date_effective,date_effet),
          updated_at=datetime('now')
      WHERE id=?
    `).run(target.superieur_id, target.superieur_nom || null, actorUserId || null, Number(id));

    const approved = requireMutation(id);
    if (clean(approved.date_effective || approved.date_effet) <= today()) {
      return apply(id, actorUserId, { allowApprovedOnly: true });
    }
    return approved;
  }

  function refuse(id, actorUserId, reason) {
    const mutation = requireMutation(id);
    if (mutation.statut !== 'soumis') {
      throw new MutationWorkflowError('Seule une mutation soumise peut être refusée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) === Number(actorUserId || 0)) {
      throw new MutationWorkflowError('L’initiateur ne peut pas statuer sur sa propre mutation.', 'SELF_APPROVAL_FORBIDDEN', 403);
    }
    const motif = clean(reason);
    if (!motif) throw new MutationWorkflowError('Le motif du refus est obligatoire.', 'REFUSAL_REASON_REQUIRED');

    db.prepare(`
      UPDATE employes_mutations
      SET statut='refuse', motif_refus=?, refused_by=?, refused_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(motif, actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function cancel(id, actorUserId, reason = '') {
    const mutation = requireMutation(id);
    if (!CANCELLABLE_STATUSES.has(mutation.statut)) {
      throw new MutationWorkflowError('Cette mutation ne peut plus être annulée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    db.prepare(`
      UPDATE employes_mutations
      SET statut='annule', motif_refus=?, cancelled_by=?, cancelled_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(clean(reason, 'Annulation du workflow'), actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function snapshotMatches(employee, mutation) {
    return sameValue(employee.poste, mutation.ancien_poste)
      && sameValue(employee.departement, mutation.ancien_dept)
      && sameValue(employee.site, mutation.ancien_site)
      && Number(employee.superieur_id || 0) === Number(mutation.ancien_sup_id || 0);
  }

  function apply(id, actorUserId = null, options = {}) {
    const mutation = requireMutation(id);
    if (mutation.statut !== 'approuve') {
      throw new MutationWorkflowError('Seule une mutation approuvée peut être appliquée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    const effectiveDate = clean(mutation.date_effective || mutation.date_effet);
    if (!options.ignoreDate && effectiveDate > today()) {
      throw new MutationWorkflowError('La date d’effet n’est pas encore atteinte.', 'EFFECTIVE_DATE_NOT_REACHED', 409, { date_effective: effectiveDate });
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    if (!snapshotMatches(employee, mutation)) {
      db.prepare(`
        UPDATE employes_mutations
        SET statut='a_corriger', motif_refus=?, updated_at=datetime('now')
        WHERE id=?
      `).run('La fiche agent a changé depuis la soumission. Le brouillon doit être recalculé.', Number(id));
      return requireMutation(id);
    }

    const target = resolveTarget(employee, mutation);
    const execute = db.transaction(() => {
      db.prepare(`
        UPDATE employes
        SET poste=?, departement=?, site=?, superieur_id=?, superieur_hierarchique=?, updated_at=datetime('now')
        WHERE id=?
      `).run(
        target.poste || '', target.departement || '', target.site || '',
        target.superieur_id, target.superieur_nom || '', Number(employee.id),
      );
      db.prepare(`
        UPDATE employes_mutations
        SET nouveau_sup_id=?, nouveau_sup_nom=?, statut='effectif',
            date_effective=?, applied_by=?, applied_at=datetime('now'), updated_at=datetime('now')
        WHERE id=?
      `).run(target.superieur_id, target.superieur_nom || null, effectiveDate, actorUserId || null, Number(id));
      try {
        db.prepare(`
          INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
          VALUES ('employes_mutations', ?, 'mutation_effective', ?, ?, datetime('now'))
        `).run(Number(id), JSON.stringify({ employe_id: employee.id, date_effective: effectiveDate }), actorUserId || null);
      } catch (_) {}
    });
    execute();
    return requireMutation(id);
  }

  function applyDue(actorUserId = null) {
    const due = db.prepare(`
      SELECT id FROM employes_mutations
      WHERE statut='approuve' AND COALESCE(date_effective,date_effet) <= ?
      ORDER BY COALESCE(date_effective,date_effet), id
      LIMIT 200
    `).all(today());
    const result = { scanned: due.length, applied: [], needs_correction: [], failed: [] };
    for (const row of due) {
      try {
        const mutation = apply(row.id, actorUserId, { allowApprovedOnly: true });
        if (mutation.statut === 'effectif') result.applied.push(Number(row.id));
        else result.needs_correction.push(Number(row.id));
      } catch (error) {
        result.failed.push({ id: Number(row.id), code: error.code || 'ERROR', error: error.message });
      }
    }
    return result;
  }

  return {
    MutationWorkflowError,
    EDITABLE_STATUSES,
    CANCELLABLE_STATUSES,
    FINAL_STATUSES,
    apply,
    applyDue,
    approve,
    cancel,
    createDraft,
    getMutation,
    listMutations,
    refuse,
    submit,
    updateDraft,
  };
}

const workflow = createOrganizationMutationWorkflow();

module.exports = {
  ...workflow,
  MutationWorkflowError,
  createOrganizationMutationWorkflow,
};

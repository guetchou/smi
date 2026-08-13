'use strict';

const defaultDb = require('../database');
const defaultOrganization = require('./organization_assignment');

class MutationWorkflowError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'MutationWorkflowError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const STATUS = Object.freeze({
  DRAFT: 'brouillon',
  SUBMITTED: 'soumis',
  APPROVED: 'approuve',
  REFUSED: 'refuse',
  NEEDS_CORRECTION: 'a_corriger',
  EFFECTIVE: 'effectif',
  CANCELLED: 'annule',
});

const EDITABLE_STATUSES = new Set([STATUS.DRAFT, STATUS.REFUSED, STATUS.NEEDS_CORRECTION]);
const CANCELLABLE_STATUSES = new Set([
  STATUS.DRAFT,
  STATUS.SUBMITTED,
  STATUS.APPROVED,
  STATUS.REFUSED,
  STATUS.NEEDS_CORRECTION,
]);
const ACTIVE_STATUSES = [STATUS.DRAFT, STATUS.SUBMITTED, STATUS.APPROVED, STATUS.NEEDS_CORRECTION];

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

function sameText(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function civilDate(value) {
  const text = String(value || '');
  if (validDate(text)) return text;
  const date = value instanceof Date ? value : new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: process.env.ORGANIZATION_TIME_ZONE || 'Africa/Brazzaville',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeMutationDates(mutation) {
  if (!mutation) return mutation;
  return {
    ...mutation,
    date_effet: civilDate(mutation.date_effet),
    date_effective: civilDate(mutation.date_effective || mutation.date_effet),
  };
}

function snapshotMatches(employee, mutation) {
  return sameText(employee.poste, mutation.ancien_poste)
    && sameText(employee.departement, mutation.ancien_dept)
    && sameText(employee.site, mutation.ancien_site)
    && Number(employee.superieur_id || 0) === Number(mutation.ancien_sup_id || 0);
}

function createOrganizationMutationWorkflow(db = defaultDb, organization = defaultOrganization) {
  function mutationSelect(whereClause = 'm.id = ?') {
    return `
      SELECT m.*,
             e.nom AS employe_nom,
             e.prenom AS employe_prenom,
             e.matricule AS employe_matricule,
             creator.nom AS created_by_nom,
             submitter.nom AS submitted_by_nom,
             approver.nom AS approuve_par_nom,
             refuser.nom AS refused_by_nom,
             canceller.nom AS cancelled_by_nom,
             applier.nom AS applied_by_nom
      FROM employes_mutations m
      JOIN employes e ON e.id = m.employe_id
      LEFT JOIN users creator ON creator.id = m.created_by
      LEFT JOIN users submitter ON submitter.id = m.submitted_by
      LEFT JOIN users approver ON approver.id = m.approuve_par
      LEFT JOIN users refuser ON refuser.id = m.refused_by
      LEFT JOIN users canceller ON canceller.id = m.cancelled_by
      LEFT JOIN users applier ON applier.id = m.applied_by
      WHERE ${whereClause}
    `;
  }

  function getMutation(id) {
    return normalizeMutationDates(db.prepare(mutationSelect()).get(Number(id)) || null);
  }

  function requireMutation(id) {
    const mutation = getMutation(id);
    if (!mutation) throw new MutationWorkflowError('Mutation introuvable.', 'MUTATION_NOT_FOUND', 404);
    return mutation;
  }

  function requireActiveEmployee(id) {
    const employee = db.prepare(`
      SELECT * FROM employes
      WHERE id = ?
        AND actif = 1
        AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')
    `).get(Number(id));
    if (!employee) throw new MutationWorkflowError('Agent introuvable ou inactif.', 'EMPLOYEE_NOT_FOUND', 404);
    return employee;
  }

  function listMutations(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.statut) {
      where.push('m.statut = ?');
      params.push(clean(filters.statut));
    }
    if (filters.employe_id) {
      where.push('m.employe_id = ?');
      params.push(Number(filters.employe_id));
    }
    if (filters.date_from) {
      where.push('COALESCE(m.date_effective, m.date_effet) >= ?');
      params.push(clean(filters.date_from));
    }
    if (filters.date_to) {
      where.push('COALESCE(m.date_effective, m.date_effet) <= ?');
      params.push(clean(filters.date_to));
    }

    return db.prepare(`${mutationSelect(where.join(' AND '))}
      ORDER BY
        CASE m.statut
          WHEN 'soumis' THEN 1
          WHEN 'a_corriger' THEN 2
          WHEN 'brouillon' THEN 3
          WHEN 'approuve' THEN 4
          WHEN 'refuse' THEN 5
          WHEN 'effectif' THEN 6
          ELSE 7
        END,
        COALESCE(m.date_effective, m.date_effet) ASC,
        m.id DESC
      LIMIT 500
    `).all(...params).map(normalizeMutationDates);
  }

  function activeMutationForEmployee(employeeId, excludeId = null) {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const params = [Number(employeeId), ...ACTIVE_STATUSES];
    let sql = `
      SELECT id, statut FROM employes_mutations
      WHERE employe_id = ? AND statut IN (${placeholders})
    `;
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(Number(excludeId));
    }
    sql += ' ORDER BY id DESC LIMIT 1';
    return db.prepare(sql).get(...params) || null;
  }

  function assertNoParallelMutation(employeeId, excludeId = null) {
    const existing = activeMutationForEmployee(employeeId, excludeId);
    if (existing) {
      throw new MutationWorkflowError(
        'Une mutation organisationnelle est déjà active pour cet agent.',
        'ACTIVE_MUTATION_EXISTS',
        409,
        { mutation_id: Number(existing.id), statut: existing.statut },
      );
    }
  }

  function resolveTarget(employee, input) {
    const target = {
      poste: clean(input.nouveau_poste) || clean(employee.poste),
      departement: clean(input.nouveau_dept) || clean(employee.departement),
      site: clean(input.nouveau_site) || clean(employee.site),
      superieur_id: nullableId(input.nouveau_sup_id),
      superieur_nom: clean(input.nouveau_sup_nom),
    };

    if (!target.departement) {
      throw new MutationWorkflowError(
        'Le département cible est obligatoire pour un agent actif.',
        'TARGET_DEPARTMENT_REQUIRED',
      );
    }

    const department = organization.activeDepartmentByLabel(target.departement);
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
      const manager = organization.assertManagerActive(department.responsable_id);
      organization.assertNoCycle(employee.id, manager.id);
      target.superieur_id = Number(manager.id);
      target.superieur_nom = fullName(manager);
    } else if (target.superieur_id) {
      const manager = organization.assertManagerActive(target.superieur_id);
      organization.assertNoCycle(employee.id, manager.id);
      target.superieur_nom = fullName(manager);
    } else {
      target.superieur_id = null;
      target.superieur_nom = '';
    }

    return target;
  }

  function assertMeaningfulChange(employee, target) {
    const changed = !sameText(employee.poste, target.poste)
      || !sameText(employee.departement, target.departement)
      || !sameText(employee.site, target.site)
      || Number(employee.superieur_id || 0) !== Number(target.superieur_id || 0);
    if (!changed) {
      throw new MutationWorkflowError('Aucun changement organisationnel détecté.', 'NO_ORGANIZATION_CHANGE');
    }
  }

  function normalizedEffectiveDate(input, fallback = '') {
    const value = clean(input.date_effective || input.date_effet, fallback);
    if (!validDate(value)) {
      throw new MutationWorkflowError('La date d’effet est obligatoire au format AAAA-MM-JJ.', 'EFFECTIVE_DATE_REQUIRED');
    }
    return value;
  }

  function markNeedsCorrection(id, reason) {
    db.prepare(`
      UPDATE employes_mutations
      SET statut=?, motif_refus=?, revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(STATUS.NEEDS_CORRECTION, reason, Number(id));
    return requireMutation(id);
  }

  function createDraft(input, actorUserId) {
    const employee = requireActiveEmployee(input.employe_id);
    assertNoParallelMutation(employee.id);
    const target = resolveTarget(employee, input || {});
    assertMeaningfulChange(employee, target);

    const effectiveDate = normalizedEffectiveDate(input || {});
    const reason = clean(input.motif);
    if (!reason) throw new MutationWorkflowError('Le motif de la mutation est obligatoire.', 'MUTATION_REASON_REQUIRED');

    const result = db.prepare(`
      INSERT INTO employes_mutations
        (employe_id, date_effet, date_effective, type_mutation,
         ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
         ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
         nouveau_sup_id, nouveau_sup_nom, motif, statut, created_by, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      Number(employee.id), effectiveDate, effectiveDate, clean(input.type_mutation, 'modification'),
      employee.poste || null, target.poste || null,
      employee.departement || null, target.departement || null,
      employee.site || null, target.site || null,
      employee.superieur_id || null, employee.superieur_hierarchique || null,
      target.superieur_id, target.superieur_nom || null,
      reason, STATUS.DRAFT, actorUserId || null,
    );

    return requireMutation(result.lastInsertRowid);
  }

  function updateDraft(id, input, actorUserId) {
    const mutation = requireMutation(id);
    if (!EDITABLE_STATUSES.has(mutation.statut)) {
      throw new MutationWorkflowError(
        'Seules les mutations en brouillon, refusées ou à corriger peuvent être modifiées.',
        'MUTATION_NOT_EDITABLE',
        409,
      );
    }
    if (Number(mutation.created_by || 0) !== Number(actorUserId || 0)) {
      throw new MutationWorkflowError('Seul l’initiateur peut modifier cette mutation.', 'MUTATION_OWNER_REQUIRED', 403);
    }

    assertNoParallelMutation(mutation.employe_id, mutation.id);
    const employee = requireActiveEmployee(mutation.employe_id);
    const target = resolveTarget(employee, {
      nouveau_poste: input.nouveau_poste ?? mutation.nouveau_poste,
      nouveau_dept: input.nouveau_dept ?? mutation.nouveau_dept,
      nouveau_site: input.nouveau_site ?? mutation.nouveau_site,
      nouveau_sup_id: input.nouveau_sup_id ?? mutation.nouveau_sup_id,
      nouveau_sup_nom: input.nouveau_sup_nom ?? mutation.nouveau_sup_nom,
    });
    assertMeaningfulChange(employee, target);

    const effectiveDate = normalizedEffectiveDate(input, mutation.date_effective || mutation.date_effet || '');
    const reason = clean(input.motif, mutation.motif || '');
    if (!reason) throw new MutationWorkflowError('Le motif de la mutation est obligatoire.', 'MUTATION_REASON_REQUIRED');

    db.prepare(`
      UPDATE employes_mutations
      SET date_effet=?, date_effective=?, type_mutation=?,
          ancien_poste=?, nouveau_poste=?, ancien_dept=?, nouveau_dept=?,
          ancien_site=?, nouveau_site=?, ancien_sup_id=?, ancien_sup_nom=?,
          nouveau_sup_id=?, nouveau_sup_nom=?, motif=?, motif_refus=NULL,
          statut=?, submitted_by=NULL, submitted_at=NULL,
          approuve_par=NULL, approuve_at=NULL,
          refused_by=NULL, refused_at=NULL,
          revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      effectiveDate, effectiveDate, clean(input.type_mutation, mutation.type_mutation || 'modification'),
      employee.poste || null, target.poste || null,
      employee.departement || null, target.departement || null,
      employee.site || null, target.site || null,
      employee.superieur_id || null, employee.superieur_hierarchique || null,
      target.superieur_id, target.superieur_nom || null, reason,
      STATUS.DRAFT, Number(id),
    );
    return requireMutation(id);
  }

  function submit(id, actorUserId) {
    const mutation = requireMutation(id);
    if (mutation.statut !== STATUS.DRAFT) {
      throw new MutationWorkflowError('Seul un brouillon peut être soumis.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) !== Number(actorUserId || 0)) {
      throw new MutationWorkflowError('Seul l’initiateur peut soumettre cette mutation.', 'MUTATION_OWNER_REQUIRED', 403);
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    if (!snapshotMatches(employee, mutation)) {
      markNeedsCorrection(id, 'La fiche agent a changé avant la soumission. Recalculez le brouillon.');
      throw new MutationWorkflowError(
        'La fiche agent a changé. La mutation doit être recalculée.',
        'MUTATION_SNAPSHOT_STALE',
        409,
      );
    }
    resolveTarget(employee, mutation);

    db.prepare(`
      UPDATE employes_mutations
      SET statut=?, submitted_by=?, submitted_at=CURRENT_TIMESTAMP,
          motif_refus=NULL, revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(STATUS.SUBMITTED, actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function approve(id, actorUserId) {
    const mutation = requireMutation(id);
    if (mutation.statut !== STATUS.SUBMITTED) {
      throw new MutationWorkflowError('Seule une mutation soumise peut être approuvée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) === Number(actorUserId || 0)
      || Number(mutation.submitted_by || 0) === Number(actorUserId || 0)) {
      throw new MutationWorkflowError('L’initiateur ne peut pas approuver sa propre mutation.', 'SELF_APPROVAL_FORBIDDEN', 403);
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    if (!snapshotMatches(employee, mutation)) {
      markNeedsCorrection(id, 'La fiche agent a changé avant l’approbation. Recalculez la mutation.');
      throw new MutationWorkflowError(
        'La fiche agent a changé. La mutation doit être recalculée.',
        'MUTATION_SNAPSHOT_STALE',
        409,
      );
    }
    const target = resolveTarget(employee, mutation);

    db.prepare(`
      UPDATE employes_mutations
      SET nouveau_sup_id=?, nouveau_sup_nom=?, statut=?,
          approuve_par=?, approuve_at=CURRENT_TIMESTAMP,
          date_effective=COALESCE(date_effective, date_effet),
          revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      target.superieur_id, target.superieur_nom || null,
      STATUS.APPROVED, actorUserId || null, Number(id),
    );

    const approved = requireMutation(id);
    if (clean(approved.date_effective || approved.date_effet) <= today()) {
      return apply(id, actorUserId);
    }
    return approved;
  }

  function refuse(id, actorUserId, reason) {
    const mutation = requireMutation(id);
    if (mutation.statut !== STATUS.SUBMITTED) {
      throw new MutationWorkflowError('Seule une mutation soumise peut être refusée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    if (Number(mutation.created_by || 0) === Number(actorUserId || 0)
      || Number(mutation.submitted_by || 0) === Number(actorUserId || 0)) {
      throw new MutationWorkflowError('L’initiateur ne peut pas statuer sur sa propre mutation.', 'SELF_APPROVAL_FORBIDDEN', 403);
    }
    const refusalReason = clean(reason);
    if (!refusalReason) throw new MutationWorkflowError('Le motif du refus est obligatoire.', 'REFUSAL_REASON_REQUIRED');

    db.prepare(`
      UPDATE employes_mutations
      SET statut=?, motif_refus=?, refused_by=?, refused_at=CURRENT_TIMESTAMP,
          revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(STATUS.REFUSED, refusalReason, actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function cancel(id, actorUserId, reason = '') {
    const mutation = requireMutation(id);
    if (!CANCELLABLE_STATUSES.has(mutation.statut)) {
      throw new MutationWorkflowError('Cette mutation ne peut plus être annulée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    db.prepare(`
      UPDATE employes_mutations
      SET statut=?, motif_refus=?, cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP,
          revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(STATUS.CANCELLED, clean(reason, 'Annulation du workflow'), actorUserId || null, Number(id));
    return requireMutation(id);
  }

  function apply(id, actorUserId = null) {
    const mutation = requireMutation(id);
    if (mutation.statut !== STATUS.APPROVED) {
      throw new MutationWorkflowError('Seule une mutation approuvée peut être appliquée.', 'INVALID_MUTATION_TRANSITION', 409);
    }
    const effectiveDate = clean(mutation.date_effective || mutation.date_effet);
    if (effectiveDate > today()) {
      throw new MutationWorkflowError(
        'La date d’effet n’est pas encore atteinte.',
        'EFFECTIVE_DATE_NOT_REACHED',
        409,
        { date_effective: effectiveDate },
      );
    }

    const employee = requireActiveEmployee(mutation.employe_id);
    if (!snapshotMatches(employee, mutation)) {
      return markNeedsCorrection(id, 'La fiche agent a changé depuis l’approbation. Recalculez la mutation.');
    }
    const target = resolveTarget(employee, mutation);

    const execute = db.transaction(() => {
      db.prepare(`
        UPDATE employes
        SET poste=?, departement=?, site=?, superieur_id=?, superieur_hierarchique=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        target.poste || '', target.departement || '', target.site || '',
        target.superieur_id, target.superieur_nom || '', Number(employee.id),
      );
      db.prepare(`
        UPDATE employes_mutations
        SET nouveau_sup_id=?, nouveau_sup_nom=?, statut=?,
            date_effective=?, applied_by=?, applied_at=CURRENT_TIMESTAMP,
            revision=COALESCE(revision, 1)+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        target.superieur_id, target.superieur_nom || null,
        STATUS.EFFECTIVE, effectiveDate, actorUserId || null, Number(id),
      );
      try {
        db.prepare(`
          INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
          VALUES ('employes_mutations', ?, 'mutation_effective', ?, ?, CURRENT_TIMESTAMP)
        `).run(
          Number(id),
          JSON.stringify({ employe_id: employee.id, date_effective: effectiveDate }),
          actorUserId || null,
        );
      } catch (_) {}
    });
    execute();
    return requireMutation(id);
  }

  function applyDue(actorUserId = null) {
    const due = db.prepare(`
      SELECT id FROM employes_mutations
      WHERE statut=? AND COALESCE(date_effective, date_effet) <= ?
      ORDER BY COALESCE(date_effective, date_effet), id
      LIMIT 200
    `).all(STATUS.APPROVED, today());

    const result = { scanned: due.length, applied: [], needs_correction: [], failed: [] };
    for (const row of due) {
      try {
        const mutation = apply(row.id, actorUserId);
        if (mutation.statut === STATUS.EFFECTIVE) result.applied.push(Number(row.id));
        else result.needs_correction.push(Number(row.id));
      } catch (error) {
        result.failed.push({ id: Number(row.id), code: error.code || 'ERROR', error: error.message });
      }
    }
    return result;
  }

  return {
    STATUS,
    MutationWorkflowError,
    activeMutationForEmployee,
    apply,
    applyDue,
    approve,
    cancel,
    createDraft,
    getMutation,
    listMutations,
    refuse,
    snapshotMatches,
    submit,
    updateDraft,
  };
}

const workflow = createOrganizationMutationWorkflow();

module.exports = {
  ...workflow,
  STATUS,
  MutationWorkflowError,
  createOrganizationMutationWorkflow,
  snapshotMatches,
};

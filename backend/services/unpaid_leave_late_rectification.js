'use strict';

const {
  calculateUnpaidLeavePayrollImpact,
  monthBounds,
  normalizeSqlDate,
} = require('./unpaid_leave_payroll');

function monthsBetween(startDate, endDate) {
  const start = normalizeSqlDate(startDate);
  const end = normalizeSqlDate(endDate);

  if (!start || !end || end < start) return [];

  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);

  const periods = [];
  let year = startYear;
  let month = startMonth;

  while (
    year < endYear
    || (year === endYear && month <= endMonth)
  ) {
    periods.push({
      month,
      year,
      key: `${year}-${String(month).padStart(2, '0')}`,
    });

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return periods;
}

function getBulletin(dbc, employeeId, month, year) {
  return dbc.prepare(`
    SELECT *
    FROM bulletins_salaire
    WHERE employe_id = ?
      AND mois = ?
      AND annee = ?
      AND type = 'normal'
    LIMIT 1
  `).get(employeeId, month, year);
}

function existingRectification(dbc, leaveId, periodKey) {
  return dbc.prepare(`
    SELECT id, statut, montant
    FROM rectifications_bulletins
    WHERE source_type = 'conge_sans_solde'
      AND source_id = ?
      AND source_period = ?
    LIMIT 1
  `).get(leaveId, periodKey);
}

function createLateUnpaidLeaveRectifications({
  leave,
  actorId,
  dbc,
}) {
  if (!leave || leave.type_conge !== 'sans_solde') {
    return {
      created: [],
      skipped: [],
    };
  }

  if (!['approuve', 'termine'].includes(leave.statut)) {
    return {
      created: [],
      skipped: [{
        reason: 'leave_not_approved',
        leaveId: Number(leave.id),
      }],
    };
  }

  const employee = dbc.prepare(`
    SELECT id, salaire_base
    FROM employes
    WHERE id = ?
  `).get(leave.employe_id);

  if (!employee) {
    throw new Error(
      `Employé introuvable pour le congé ${leave.id}`
    );
  }

  const periods = monthsBetween(
    leave.date_debut,
    leave.date_fin,
  );

  const created = [];
  const skipped = [];

  for (const period of periods) {
    const bulletin = getBulletin(
      dbc,
      employee.id,
      period.month,
      period.year,
    );

    if (!bulletin) {
      skipped.push({
        period: period.key,
        reason: 'no_bulletin',
      });
      continue;
    }

    if (bulletin.statut === 'brouillon') {
      skipped.push({
        period: period.key,
        reason: 'draft_recalculation_required',
        bulletinId: Number(bulletin.id),
      });
      continue;
    }

    if (!['valide', 'paye'].includes(bulletin.statut)) {
      skipped.push({
        period: period.key,
        reason: 'bulletin_status_not_locked',
        bulletinId: Number(bulletin.id),
        status: bulletin.statut,
      });
      continue;
    }

    const duplicate = existingRectification(
      dbc,
      leave.id,
      period.key,
    );

    if (duplicate) {
      skipped.push({
        period: period.key,
        reason: 'already_created',
        rectificationId: Number(duplicate.id),
      });
      continue;
    }

    const expectedImpact =
      calculateUnpaidLeavePayrollImpact({
        employeeId: employee.id,
        month: period.month,
        year: period.year,
        contractualBase: employee.salaire_base,
        dbc,
      });

    const alreadyApplied =
      Math.max(0, Number(bulletin.retenue_sans_solde) || 0);

    const missingDeduction = Math.max(
      0,
      Math.round(expectedImpact.deduction - alreadyApplied),
    );

    if (missingDeduction <= 0) {
      skipped.push({
        period: period.key,
        reason: 'no_missing_deduction',
        expectedDeduction: expectedImpact.deduction,
        alreadyApplied,
      });
      continue;
    }

    const overlapBounds = monthBounds(
      period.month,
      period.year,
    );

    const motif = [
      `Congé sans solde approuvé après verrouillage de la paie`,
      `période ${period.key}`,
      `congé #${leave.id}`,
      `${expectedImpact.unpaidLeaveDays} jour(s) ouvré(s)`,
    ].join(' — ');

    const result = dbc.prepare(`
      INSERT INTO rectifications_bulletins (
        bulletin_id,
        employe_id,
        periode_id,
        type,
        sens,
        montant,
        motif,
        statut,
        created_by,
        created_at,
        updated_at,
        source_type,
        source_id,
        source_period
      )
      VALUES (
        ?, ?, ?, 'erreur_retenue', 'debit_agent',
        ?, ?, 'approuve', ?, datetime('now'),
        datetime('now'), 'conge_sans_solde', ?, ?
      )
    `).run(
      bulletin.id,
      employee.id,
      bulletin.periode_id || null,
      missingDeduction,
      motif,
      actorId || null,
      leave.id,
      period.key,
    );

    const rectificationId = Number(
      result.lastInsertRowid
    );

    dbc.prepare(`
      INSERT INTO audit_logs (
        table_name,
        record_id,
        action,
        details,
        user_id
      )
      VALUES (
        'rectifications_bulletins',
        ?,
        'auto_create_unpaid_leave',
        ?,
        ?
      )
    `).run(
      rectificationId,
      JSON.stringify({
        leave_id: Number(leave.id),
        bulletin_id: Number(bulletin.id),
        bulletin_status: bulletin.statut,
        source_period: period.key,
        period_bounds: overlapBounds,
        expected_deduction: expectedImpact.deduction,
        already_applied: alreadyApplied,
        missing_deduction: missingDeduction,
        unpaid_leave_days:
          expectedImpact.unpaidLeaveDays,
        dates: expectedImpact.dates,
      }),
      actorId || null,
    );

    created.push({
      id: rectificationId,
      bulletinId: Number(bulletin.id),
      period: period.key,
      amount: missingDeduction,
      days: expectedImpact.unpaidLeaveDays,
    });
  }

  return {
    created,
    skipped,
  };
}

module.exports = {
  createLateUnpaidLeaveRectifications,
  monthsBetween,
};

'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/database');
const {
  calculateUnpaidLeavePayrollImpact,
} = require('../backend/services/unpaid_leave_payroll');

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function scalar(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function main() {
  const suffix = unique('unpaid_leave');
  let userId = null;
  let employeeId = null;
  let leaveId = null;

  try {
    const user = db.prepare(`
      INSERT INTO users
        (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, 'unused', 'rh', 1, NOW())
    `).run(
      'Test congé sans solde',
      `${suffix}@example.test`,
    );

    userId = Number(user.lastInsertRowid);

    const employee = db.prepare(`
      INSERT INTO employes
        (
          matricule, nom, prenom, date_embauche,
          salaire_base, statut_dossier, actif,
          created_at, updated_at
        )
      VALUES
        (?, 'Agent', 'Sans Solde', '2020-01-01',
         300000, 'actif', 1, NOW(), NOW())
    `).run(suffix);

    employeeId = Number(employee.lastInsertRowid);

    const leave = db.prepare(`
      INSERT INTO employes_conges
        (
          employe_id, type_conge, date_debut, date_fin,
          nb_jours, statut, created_by, created_at
        )
      VALUES
        (?, 'sans_solde', '2036-07-07', '2036-07-09',
         3, 'approuve', ?, NOW())
    `).run(employeeId, userId);

    leaveId = Number(leave.lastInsertRowid);

    const impact = calculateUnpaidLeavePayrollImpact({
      employeeId,
      month: 7,
      year: 2036,
      contractualBase: 300000,
      dbc: db,
    });

    assert.strictEqual(impact.contractualBase, 300000);
    assert.strictEqual(impact.unpaidLeaveDays, 3);
    assert.strictEqual(impact.leaveIds.length, 1);
    assert.strictEqual(impact.leaveIds[0], leaveId);
    assert.deepStrictEqual(
      impact.dates,
      ['2036-07-07', '2036-07-08', '2036-07-09'],
    );

    assert(impact.payableDaysInMonth > 0);
    assert(impact.dailyRate > 0);
    assert(impact.deduction > 0);
    assert(impact.deduction < 300000);
    assert.strictEqual(
      impact.payableBase,
      300000 - impact.deduction,
    );

    db.prepare(`
      UPDATE employes_conges
      SET statut='demande'
      WHERE id=?
    `).run(leaveId);

    const ignored = calculateUnpaidLeavePayrollImpact({
      employeeId,
      month: 7,
      year: 2036,
      contractualBase: 300000,
      dbc: db,
    });

    assert.strictEqual(ignored.unpaidLeaveDays, 0);
    assert.strictEqual(ignored.deduction, 0);
    assert.strictEqual(ignored.payableBase, 300000);

    const columns = db.prepare(`
      SELECT
        salaire_base_contractuel,
        jours_payables_mois,
        jours_sans_solde,
        taux_journalier_sans_solde,
        retenue_sans_solde,
        details_sans_solde
      FROM bulletins_salaire
      LIMIT 1
    `).all();

    assert(Array.isArray(columns));

    const params = scalar(`
      SELECT COUNT(*) AS total
      FROM parametres
      WHERE cle IN (
        'paie_sans_solde_actif',
        'paie_sans_solde_diviseur',
        'paie_sans_solde_arrondi'
      )
    `);

    assert.strictEqual(Number(params.total), 3);

    console.log('test_unpaid_leave_payroll_mysql: OK');
  } finally {
    if (leaveId) {
      db.prepare(
        'DELETE FROM employes_conges WHERE id=?',
      ).run(leaveId);
    }

    if (employeeId) {
      db.prepare(
        'DELETE FROM employes WHERE id=?',
      ).run(employeeId);
    }

    if (userId) {
      db.prepare(
        'DELETE FROM notif_messages WHERE user_id=?',
      ).run(userId);

      db.prepare(
        'DELETE FROM users WHERE id=?',
      ).run(userId);
    }

    if (typeof db.close === 'function') {
      db.close();
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

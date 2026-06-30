'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-unpaid-leave-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../backend/database');
const {
  calculateUnpaidLeavePayrollImpact,
} = require('../backend/services/unpaid_leave_payroll');

function insertParam(key, value) {
  db.prepare(`
    INSERT INTO parametres (cle, valeur)
    VALUES (?, ?)
    ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur
  `).run(key, String(value));
}

insertParam('paie_sans_solde_actif', '1');
insertParam('paie_sans_solde_diviseur', 'jours_ouvres_mois');
insertParam('paie_sans_solde_arrondi', 'franc');
insertParam('conges_weekend', '6,0');
insertParam('conges_timezone', 'Africa/Brazzaville');
insertParam('conges_jours_feries', '');

const user = db.prepare(`
  INSERT INTO users (nom, email, password, role, actif)
  VALUES ('Test Admin', 'test-unpaid@example.com', 'x', 'admin', 1)
`).run();

const employee = db.prepare(`
  INSERT INTO employes (
    nom, prenom, matricule, salaire_base,
    actif, statut_dossier, created_at
  )
  VALUES (
    'Test', 'Sans Solde', 'TEST-SS-001', 300000,
    1, 'actif', datetime('now')
  )
`).run();

const employeeId = employee.lastInsertRowid;
const userId = user.lastInsertRowid;

db.prepare(`
  INSERT INTO employes_conges (
    employe_id, type_conge, date_debut, date_fin,
    nb_jours, statut, created_by, created_at
  )
  VALUES (?, 'sans_solde', '2026-07-06', '2026-07-08',
          3, 'approuve', ?, datetime('now'))
`).run(employeeId, userId);

const impact = calculateUnpaidLeavePayrollImpact({
  employeeId,
  month: 7,
  year: 2026,
  contractualBase: 300000,
  dbc: db,
});

assert.strictEqual(impact.contractualBase, 300000);
assert.strictEqual(impact.unpaidLeaveDays, 3);
assert.strictEqual(impact.leaveIds.length, 1);
assert.deepStrictEqual(
  impact.dates,
  ['2026-07-06', '2026-07-07', '2026-07-08'],
);

assert.ok(impact.payableDaysInMonth > 0);
assert.ok(impact.dailyRate > 0);
assert.ok(impact.deduction > 0);
assert.ok(impact.deduction < 300000);
assert.strictEqual(
  impact.payableBase,
  300000 - impact.deduction,
);

db.prepare(`
  UPDATE employes_conges
  SET statut='demande'
  WHERE employe_id=?
`).run(employeeId);

const ignoredImpact = calculateUnpaidLeavePayrollImpact({
  employeeId,
  month: 7,
  year: 2026,
  contractualBase: 300000,
  dbc: db,
});

assert.strictEqual(ignoredImpact.unpaidLeaveDays, 0);
assert.strictEqual(ignoredImpact.deduction, 0);
assert.strictEqual(ignoredImpact.payableBase, 300000);

console.log('unpaid_leave_payroll_integration_test: OK');

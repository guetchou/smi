'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'tala-late-unpaid-')
);

process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../backend/database');
const {
  createLateUnpaidLeaveRectifications,
} = require('../backend/services/unpaid_leave_late_rectification');

function createUser() {
  return db.prepare(`
    INSERT INTO users (
      nom, email, password_hash, role, actif
    )
    VALUES (
      'Test RH',
      'late-unpaid@example.test',
      'unused',
      'rh',
      1
    )
  `).run().lastInsertRowid;
}

function createEmployee() {
  return db.prepare(`
    INSERT INTO employes (
      nom,
      prenom,
      matricule,
      salaire_base,
      actif,
      statut_dossier,
      created_at
    )
    VALUES (
      'Agent',
      'Rectification',
      'RECT-SS-001',
      300000,
      1,
      'actif',
      datetime('now')
    )
  `).run().lastInsertRowid;
}

function createLeave(employeeId, userId) {
  return db.prepare(`
    INSERT INTO employes_conges (
      employe_id,
      type_conge,
      date_debut,
      date_fin,
      nb_jours,
      statut,
      created_by,
      created_at
    )
    VALUES (
      ?,
      'sans_solde',
      '2026-07-06',
      '2026-07-08',
      3,
      'approuve',
      ?,
      datetime('now')
    )
  `).run(employeeId, userId).lastInsertRowid;
}

function createBulletin(employeeId, status) {
  return db.prepare(`
    INSERT INTO bulletins_salaire (
      employe_id,
      mois,
      annee,
      salaire_base,
      brut,
      net_a_payer,
      statut,
      type,
      retenue_sans_solde,
      created_at
    )
    VALUES (
      ?,
      7,
      2026,
      300000,
      300000,
      300000,
      ?,
      'normal',
      0,
      datetime('now')
    )
  `).run(employeeId, status).lastInsertRowid;
}

const userId = createUser();
const employeeId = createEmployee();
const leaveId = createLeave(employeeId, userId);

const leave = db.prepare(`
  SELECT *
  FROM employes_conges
  WHERE id=?
`).get(leaveId);

/*
 * Cas 1 : aucun bulletin
 */
let result = createLateUnpaidLeaveRectifications({
  leave,
  actorId: userId,
  dbc: db,
});

assert.strictEqual(result.created.length, 0);
assert.strictEqual(result.skipped.length, 1);
assert.strictEqual(
  result.skipped[0].reason,
  'no_bulletin'
);

/*
 * Cas 2 : bulletin brouillon
 */
const draftBulletinId = createBulletin(
  employeeId,
  'brouillon'
);

result = createLateUnpaidLeaveRectifications({
  leave,
  actorId: userId,
  dbc: db,
});

assert.strictEqual(result.created.length, 0);
assert.strictEqual(
  result.skipped[0].reason,
  'draft_recalculation_required'
);

db.prepare(`
  DELETE FROM bulletins_salaire
  WHERE id=?
`).run(draftBulletinId);

/*
 * Cas 3 : bulletin validé
 */
const validatedBulletinId = createBulletin(
  employeeId,
  'valide'
);

result = createLateUnpaidLeaveRectifications({
  leave,
  actorId: userId,
  dbc: db,
});

assert.strictEqual(result.created.length, 1);
assert.strictEqual(result.created[0].bulletinId, Number(validatedBulletinId));
assert.strictEqual(result.created[0].period, '2026-07');
assert.strictEqual(result.created[0].days, 3);
assert(result.created[0].amount > 0);

const rectification = db.prepare(`
  SELECT *
  FROM rectifications_bulletins
  WHERE source_type='conge_sans_solde'
    AND source_id=?
    AND source_period='2026-07'
`).get(leaveId);

assert(rectification);
assert.strictEqual(rectification.statut, 'approuve');
assert.strictEqual(rectification.sens, 'debit_agent');
assert.strictEqual(
  Number(rectification.bulletin_id),
  Number(validatedBulletinId)
);

/*
 * Cas 4 : idempotence
 */
result = createLateUnpaidLeaveRectifications({
  leave,
  actorId: userId,
  dbc: db,
});

assert.strictEqual(result.created.length, 0);
assert.strictEqual(
  result.skipped[0].reason,
  'already_created'
);

const count = db.prepare(`
  SELECT COUNT(*) AS total
  FROM rectifications_bulletins
  WHERE source_type='conge_sans_solde'
    AND source_id=?
    AND source_period='2026-07'
`).get(leaveId);

assert.strictEqual(Number(count.total), 1);

console.log(
  'unpaid_leave_late_rectification_integration_test: OK'
);

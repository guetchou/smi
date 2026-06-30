'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/database');

const {
  createLateUnpaidLeaveRectifications,
} = require('../backend/services/unpaid_leave_late_rectification');

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function main() {
  const suffix = unique('late_unpaid');

  let userId;
  let employeeId;
  let leaveId;
  let bulletinId;
  let rectificationId;

  try {
    const user = db.prepare(`
      INSERT INTO users (
        nom, email, password_hash, role, actif, created_at
      )
      VALUES (?, ?, 'unused', 'rh', 1, NOW())
    `).run(
      'Test rectification congé',
      `${suffix}@example.test`,
    );

    userId = Number(user.lastInsertRowid);

    const employee = db.prepare(`
      INSERT INTO employes (
        matricule,
        nom,
        prenom,
        date_embauche,
        salaire_base,
        statut_dossier,
        actif,
        created_at,
        updated_at
      )
      VALUES (
        ?,
        'Agent',
        'Rectification',
        '2020-01-01',
        300000,
        'actif',
        1,
        NOW(),
        NOW()
      )
    `).run(suffix);

    employeeId = Number(employee.lastInsertRowid);

    const leaveResult = db.prepare(`
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
        '2036-07-07',
        '2036-07-09',
        3,
        'approuve',
        ?,
        NOW()
      )
    `).run(employeeId, userId);

    leaveId = Number(leaveResult.lastInsertRowid);

    const bulletinResult = db.prepare(`
      INSERT INTO bulletins_salaire (
        employe_id,
        mois,
        annee,
        salaire_base,
        salaire_base_contractuel,
        brut,
        net_a_payer,
        net_a_verser,
        statut,
        type,
        retenue_sans_solde,
        created_by,
        created_at,
        updated_at
      )
      VALUES (
        ?,
        7,
        2036,
        300000,
        300000,
        300000,
        300000,
        300000,
        'valide',
        'normal',
        0,
        ?,
        NOW(),
        NOW()
      )
    `).run(employeeId, userId);

    bulletinId = Number(bulletinResult.lastInsertRowid);

    const leave = db.prepare(`
      SELECT
        id,
        employe_id,
        type_conge,
        CAST(date_debut AS CHAR) AS date_debut,
        CAST(date_fin AS CHAR) AS date_fin,
        nb_jours,
        statut
      FROM employes_conges
      WHERE id=?
    `).get(leaveId);

    const first = createLateUnpaidLeaveRectifications({
      leave,
      actorId: userId,
      dbc: db,
    });

    assert.strictEqual(first.created.length, 1);
    assert.strictEqual(first.skipped.length, 0);
    assert.strictEqual(first.created[0].bulletinId, bulletinId);
    assert.strictEqual(first.created[0].period, '2036-07');
    assert.strictEqual(first.created[0].days, 3);
    assert(first.created[0].amount > 0);

    rectificationId = Number(first.created[0].id);

    const rectification = db.prepare(`
      SELECT *
      FROM rectifications_bulletins
      WHERE id=?
    `).get(rectificationId);

    assert(rectification);
    assert.strictEqual(rectification.source_type, 'conge_sans_solde');
    assert.strictEqual(Number(rectification.source_id), leaveId);
    assert.strictEqual(rectification.source_period, '2036-07');
    assert.strictEqual(rectification.sens, 'debit_agent');
    assert.strictEqual(rectification.statut, 'approuve');
    assert.strictEqual(Number(rectification.bulletin_id), bulletinId);

    const second = createLateUnpaidLeaveRectifications({
      leave,
      actorId: userId,
      dbc: db,
    });

    assert.strictEqual(second.created.length, 0);
    assert.strictEqual(second.skipped.length, 1);
    assert.strictEqual(second.skipped[0].reason, 'already_created');

    const count = db.prepare(`
      SELECT COUNT(*) AS total
      FROM rectifications_bulletins
      WHERE source_type='conge_sans_solde'
        AND source_id=?
        AND source_period='2036-07'
    `).get(leaveId);

    assert.strictEqual(Number(count.total), 1);

    console.log(
      'test_unpaid_leave_late_rectification_mysql: OK'
    );
  } finally {
    if (rectificationId) {
      db.prepare(`
        DELETE FROM audit_logs
        WHERE table_name='rectifications_bulletins'
          AND record_id=?
      `).run(rectificationId);

      db.prepare(`
        DELETE FROM rectifications_bulletins
        WHERE id=?
      `).run(rectificationId);
    }

    if (bulletinId) {
      db.prepare(`
        DELETE FROM bulletins_salaire
        WHERE id=?
      `).run(bulletinId);
    }

    if (leaveId) {
      db.prepare(`
        DELETE FROM audit_logs
        WHERE table_name='employes_conges'
          AND record_id=?
      `).run(leaveId);

      db.prepare(`
        DELETE FROM employes_conges
        WHERE id=?
      `).run(leaveId);
    }

    if (employeeId) {
      db.prepare(`
        DELETE FROM employes
        WHERE id=?
      `).run(employeeId);
    }

    if (userId) {
      db.prepare(`
        DELETE FROM notif_messages
        WHERE user_id=?
      `).run(userId);

      db.prepare(`
        DELETE FROM users
        WHERE id=?
      `).run(userId);
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

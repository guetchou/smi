'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../backend/db');
const { createLeaveRequest } = require('../backend/services/leave_workflow');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const suffix = uniq('leave_cert');
  let userId;
  let employeeId;
  let leaveId;
  let storageKey;

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'rh', 1, NOW())
    `, ['Test certificat médical', `${suffix}@example.test`, 'unused']);
    userId = user.insertId;

    const employee = await db.execute(`
      INSERT INTO employes
        (matricule, nom, prenom, date_embauche, salaire_base, statut_dossier, actif, created_at, updated_at)
      VALUES (?, 'Agent', 'Certificat', '2020-01-01', 300000, 'actif', 1, NOW(), NOW())
    `, [suffix]);
    employeeId = employee.insertId;
    const agent = await db.queryOne('SELECT * FROM employes WHERE id = ?', [employeeId]);

    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const created = await createLeaveRequest({
      employee: agent,
      payload: {
        type_conge: 'maladie',
        date_debut: '2035-03-10',
        date_fin: '2035-03-11',
        motif: 'Test certificat MySQL',
        certificat_medical: {
          originalName: 'certificat.pdf',
          mimeType: 'application/pdf',
          base64: pdf.toString('base64'),
        },
      },
      actorId: userId,
    });
    leaveId = created.id;

    const document = await db.queryOne(`
      SELECT * FROM employes_conges_documents
      WHERE conge_id = ? AND type_document = 'certificat_medical' AND statut = 'actif'
    `, [leaveId]);
    assert(document, 'medical certificate row missing');
    assert.strictEqual(document.version, 1);
    assert.strictEqual(document.sha256, created.certificat_medical.sha256);
    storageKey = document.storage_key;

    const audit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'employes_conges_documents'
        AND record_id = ?
        AND action = 'deposit'
    `, [document.id]);
    assert(audit, 'medical certificate audit missing');

    let missingError;
    try {
      await createLeaveRequest({
        employee: agent,
        payload: {
          type_conge: 'maladie',
          date_debut: '2035-04-10',
          date_fin: '2035-04-11',
          motif: 'Sans certificat',
        },
        actorId: userId,
      });
    } catch (error) {
      missingError = error;
    }
    assert(missingError, 'missing certificate was accepted');
    assert.strictEqual(missingError.status, 400);

    console.log('test_leave_medical_certificate_mysql: OK');
  } finally {
    if (leaveId) {
      const docs = await db.query(
        'SELECT id, storage_key FROM employes_conges_documents WHERE conge_id = ?',
        [leaveId],
      );
      for (const document of docs) {
        await db.execute(
          "DELETE FROM audit_logs WHERE table_name = 'employes_conges_documents' AND record_id = ?",
          [document.id],
        );
      }
      await db.execute('DELETE FROM employes_conges_documents WHERE conge_id = ?', [leaveId]);
      const parapheurs = await db.query(
        "SELECT id FROM parapheur WHERE ref_source_table = 'employes_conges' AND ref_source_id = ?",
        [leaveId],
      );
      for (const item of parapheurs) {
        await db.execute('DELETE FROM parapheur_actions WHERE parapheur_id = ?', [item.id]);
        await db.execute("DELETE FROM audit_logs WHERE table_name = 'parapheur' AND record_id = ?", [item.id]);
        await db.execute('DELETE FROM parapheur WHERE id = ?', [item.id]);
      }
      await db.execute("DELETE FROM audit_logs WHERE table_name = 'employes_conges' AND record_id = ?", [leaveId]);
      await db.execute('DELETE FROM employes_conges WHERE id = ?', [leaveId]);
    }
    if (storageKey) {
      const absolute = path.resolve(
        process.env.LEAVE_DOCUMENTS_DIR
          || path.join(__dirname, '..', 'backend', 'data', 'private', 'leave-documents'),
        storageKey.replace(/^leave-documents\//, ''),
      );
      fs.rmSync(absolute, { force: true });
    }
    if (employeeId) await db.execute('DELETE FROM employes WHERE id = ?', [employeeId]);
    if (userId) {
      await db.execute('DELETE FROM notif_messages WHERE user_id = ?', [userId]);
      await db.execute('DELETE FROM users WHERE id = ?', [userId]);
    }
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

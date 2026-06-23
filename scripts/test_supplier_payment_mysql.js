'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { paySupplierInvoice } = require('../backend/services/supplier_payment_workflow');

function uniq(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(ids) {
  if (ids.invoiceId) {
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'factures_fournisseurs' AND record_id = ?", [ids.invoiceId]);
    await db.execute('DELETE FROM factures_fournisseurs WHERE id = ?', [ids.invoiceId]);
  }
  if (ids.operationId) {
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'operations' AND record_id = ?", [ids.operationId]);
    await db.execute('DELETE FROM operations WHERE id = ?', [ids.operationId]);
  }
  if (ids.supplierId) await db.execute('DELETE FROM fournisseurs WHERE id = ?', [ids.supplierId]);
  if (ids.categoryId) await db.execute('DELETE FROM categories WHERE id = ?', [ids.categoryId]);
  if (ids.positionId) await db.execute('DELETE FROM positions WHERE id = ?', [ids.positionId]);
  if (ids.userId) await db.execute('DELETE FROM users WHERE id = ?', [ids.userId]);
}

async function main() {
  const suffix = uniq('supplier_payment_atomicity');
  const ids = {};

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'finance', 1, NOW())
    `, ['Test paiement fournisseur', `${suffix}@example.test`, 'not-used-in-test']);
    ids.userId = user.insertId;

    const position = await db.execute(`
      INSERT INTO positions (code, libelle, type, solde_initial, actif, ordre)
      VALUES (?, ?, 'banque', 500000, 1, 999)
    `, [`POS-${suffix}`, 'Banque test fournisseur']);
    ids.positionId = position.insertId;

    const category = await db.execute(`
      INSERT INTO categories (nom, type, couleur, icone)
      VALUES (?, 'depense', '#000000', 'test')
    `, [`Achat fournisseur ${suffix}`]);
    ids.categoryId = category.insertId;

    const supplier = await db.execute(`
      INSERT INTO fournisseurs (nom, telephone, reference, actif, created_at)
      VALUES (?, '000000000', ?, 1, NOW())
    `, [`Fournisseur ${suffix}`, suffix]);
    ids.supplierId = supplier.insertId;

    const invoice = await db.execute(`
      INSERT INTO factures_fournisseurs
        (numero_facture_fournisseur, fournisseur_id, statut, montant_ht, montant_ttc,
         date_facture, montant_paye, reste_a_payer, rapprochement_statut,
         created_by, created_at, updated_at)
      VALUES (?, ?, 'validee', 100000, 100000, '2026-06-20', 0, 100000,
              'non_rapproche', ?, NOW(), NOW())
    `, [`FF-${suffix}`, ids.supplierId, ids.userId]);
    ids.invoiceId = invoice.insertId;

    const successReference = `PAY-${suffix}`;
    const success = await paySupplierInvoice({
      invoiceId: ids.invoiceId,
      payload: {
        montant: 40000,
        date_paiement: '2026-06-23',
        position_id: ids.positionId,
        mode_reglement: 'virement_bancaire',
        ref_paiement: successReference,
      },
      actorId: ids.userId,
    });
    ids.operationId = success.operationId;

    const storedInvoice = await db.queryOne(
      'SELECT statut, montant_paye, reste_a_payer, operation_id FROM factures_fournisseurs WHERE id = ?',
      [ids.invoiceId],
    );
    const storedOperation = await db.queryOne(
      'SELECT id, type_op, statut, dec_statut, montant, ref_externe FROM operations WHERE id = ?',
      [ids.operationId],
    );
    const paymentAudit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'factures_fournisseurs' AND record_id = ? AND action = 'PAIEMENT'
    `, [ids.invoiceId]);

    assert.strictEqual(storedInvoice.statut, 'partiellement_payee');
    assert.strictEqual(Number(storedInvoice.montant_paye), 40000);
    assert.strictEqual(Number(storedInvoice.reste_a_payer), 60000);
    assert.strictEqual(Number(storedInvoice.operation_id), Number(ids.operationId));
    assert.strictEqual(storedOperation.type_op, 'decaissement');
    assert.strictEqual(storedOperation.statut, 'valide');
    assert.strictEqual(storedOperation.dec_statut, 'paye');
    assert.strictEqual(Number(storedOperation.montant), 40000);
    assert.strictEqual(storedOperation.ref_externe, successReference);
    assert(paymentAudit, 'payment audit missing');

    await db.execute("DELETE FROM audit_logs WHERE table_name = 'factures_fournisseurs' AND record_id = ?", [ids.invoiceId]);
    await db.execute(`
      UPDATE factures_fournisseurs
      SET statut = 'validee', montant_paye = 0, reste_a_payer = 100000,
          operation_id = NULL, updated_at = NOW()
      WHERE id = ?
    `, [ids.invoiceId]);
    await db.execute('DELETE FROM operations WHERE id = ?', [ids.operationId]);
    ids.operationId = null;

    const rollbackReference = `ROLLBACK-${suffix}`;
    let forcedError;
    try {
      await paySupplierInvoice({
        invoiceId: ids.invoiceId,
        payload: {
          montant: 25000,
          date_paiement: '2026-06-24',
          position_id: ids.positionId,
          mode_reglement: 'virement_bancaire',
          ref_paiement: rollbackReference,
        },
        actorId: ids.userId,
        failAfterOperation: true,
      });
    } catch (error) {
      forcedError = error;
    }

    assert(forcedError, 'forced supplier payment failure did not throw');
    assert.strictEqual(forcedError.message, 'SUPPLIER_PAYMENT_TEST_FAILURE_AFTER_OPERATION');

    const rolledBackInvoice = await db.queryOne(
      'SELECT statut, montant_paye, reste_a_payer, operation_id FROM factures_fournisseurs WHERE id = ?',
      [ids.invoiceId],
    );
    const orphanOperation = await db.queryOne('SELECT id FROM operations WHERE ref_externe = ?', [rollbackReference]);
    const orphanAudit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'factures_fournisseurs' AND record_id = ? AND action = 'PAIEMENT'
    `, [ids.invoiceId]);

    assert.strictEqual(rolledBackInvoice.statut, 'validee');
    assert.strictEqual(Number(rolledBackInvoice.montant_paye), 0);
    assert.strictEqual(Number(rolledBackInvoice.reste_a_payer), 100000);
    assert.strictEqual(rolledBackInvoice.operation_id, null);
    assert.strictEqual(orphanOperation, null, 'operation remained after rollback');
    assert.strictEqual(orphanAudit, null, 'payment audit remained after rollback');

    console.log('test_supplier_payment_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

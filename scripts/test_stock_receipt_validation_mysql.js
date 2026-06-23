'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { validateStockReceipt } = require('../backend/services/stock_receipt_validation_workflow');

function shortId(prefix) {
  return `${prefix}${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
}

async function cleanup(ids) {
  if (ids.receiptId) {
    await db.execute("DELETE FROM stock_mouvements WHERE reference_type = 'reception' AND reference_id = ?", [ids.receiptId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'receptions' AND record_id = ?", [ids.receiptId]);
    await db.execute('DELETE FROM receptions_lignes WHERE reception_id = ?', [ids.receiptId]);
    await db.execute('DELETE FROM receptions WHERE id = ?', [ids.receiptId]);
  }
  if (ids.purchaseOrderId) {
    await db.execute('DELETE FROM bons_commandes_lignes WHERE bc_id = ?', [ids.purchaseOrderId]);
    await db.execute('DELETE FROM bons_commandes_fournisseurs WHERE id = ?', [ids.purchaseOrderId]);
  }
  if (ids.productId) await db.execute('DELETE FROM produits WHERE id = ?', [ids.productId]);
  if (ids.productCategoryId) await db.execute('DELETE FROM categories_produits WHERE id = ?', [ids.productCategoryId]);
  if (ids.supplierId) await db.execute('DELETE FROM fournisseurs WHERE id = ?', [ids.supplierId]);
  if (ids.userId) await db.execute('DELETE FROM users WHERE id = ?', [ids.userId]);
}

async function main() {
  const token = shortId('SR');
  const ids = {};

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'finance', 1, NOW())
    `, ['Test réception stock', `${token}@example.test`, 'not-used-in-test']);
    ids.userId = user.insertId;

    const category = await db.execute(`
      INSERT INTO categories_produits (nom, description, actif, created_at)
      VALUES (?, 'Catégorie test transaction stock', 1, NOW())
    `, [`Cat-${token}`]);
    ids.productCategoryId = category.insertId;

    const product = await db.execute(`
      INSERT INTO produits
        (code_produit, designation, categorie_id, unite, prix_achat, prix_vente,
         stock_disponible, stock_reserve, stock_minimum, statut, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'piece', 1000, 1500, 10, 0, 0, 'actif', ?, NOW(), NOW())
    `, [`P-${token}`, `Produit ${token}`, ids.productCategoryId, ids.userId]);
    ids.productId = product.insertId;

    const supplier = await db.execute(`
      INSERT INTO fournisseurs (nom, telephone, reference, actif, created_at)
      VALUES (?, '000000000', ?, 1, NOW())
    `, [`Fournisseur ${token}`, token]);
    ids.supplierId = supplier.insertId;

    const purchaseOrder = await db.execute(`
      INSERT INTO bons_commandes_fournisseurs
        (numero, fournisseur_id, statut, montant_ht, montant_taxes, montant_ttc,
         responsable_achat_id, created_by, created_at, updated_at)
      VALUES (?, ?, 'partiellement_livre', 5000, 0, 5000, ?, ?, NOW(), NOW())
    `, [`BC-${token}`, ids.supplierId, ids.userId, ids.userId]);
    ids.purchaseOrderId = purchaseOrder.insertId;

    const orderLine = await db.execute(`
      INSERT INTO bons_commandes_lignes
        (bc_id, produit_id, designation, quantite, quantite_recue,
         prix_unitaire, taux_taxe, montant_ht, montant_ttc, ordre)
      VALUES (?, ?, ?, 5, 5, 1000, 0, 5000, 5000, 1)
    `, [ids.purchaseOrderId, ids.productId, `Produit ${token}`]);
    ids.orderLineId = orderLine.insertId;

    const receipt = await db.execute(`
      INSERT INTO receptions
        (numero, bc_id, statut, date_reception, notes, created_by, created_at, updated_at)
      VALUES (?, ?, 'reception_totale', '2026-06-23', 'Test transaction stock', ?, NOW(), NOW())
    `, [`REC-${token}`, ids.purchaseOrderId, ids.userId]);
    ids.receiptId = receipt.insertId;

    await db.execute(`
      INSERT INTO receptions_lignes
        (reception_id, bc_ligne_id, quantite_commandee, quantite_recue,
         quantite_conforme, ecart, statut_ligne)
      VALUES (?, ?, 5, 5, 5, 0, 'conforme')
    `, [ids.receiptId, ids.orderLineId]);

    const success = await validateStockReceipt({
      receiptId: ids.receiptId,
      actorId: ids.userId,
    });

    assert.strictEqual(success.status, 'accepte');
    assert.strictEqual(success.movementIds.length, 1);

    const storedProduct = await db.queryOne('SELECT stock_disponible FROM produits WHERE id = ?', [ids.productId]);
    const storedReceipt = await db.queryOne('SELECT statut FROM receptions WHERE id = ?', [ids.receiptId]);
    const movement = await db.queryOne(`
      SELECT type, quantite, quantite_avant, quantite_apres
      FROM stock_mouvements
      WHERE reference_type = 'reception' AND reference_id = ?
    `, [ids.receiptId]);
    const audit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'receptions' AND record_id = ? AND action = 'VALIDER'
    `, [ids.receiptId]);

    assert.strictEqual(Number(storedProduct.stock_disponible), 15);
    assert.strictEqual(storedReceipt.statut, 'accepte');
    assert.strictEqual(movement.type, 'entree');
    assert.strictEqual(Number(movement.quantite), 5);
    assert.strictEqual(Number(movement.quantite_avant), 10);
    assert.strictEqual(Number(movement.quantite_apres), 15);
    assert(audit, 'receipt validation audit missing');

    await db.execute("DELETE FROM stock_mouvements WHERE reference_type = 'reception' AND reference_id = ?", [ids.receiptId]);
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'receptions' AND record_id = ?", [ids.receiptId]);
    await db.execute('UPDATE produits SET stock_disponible = 10, updated_at = NOW() WHERE id = ?', [ids.productId]);
    await db.execute("UPDATE receptions SET statut = 'reception_totale', updated_at = NOW() WHERE id = ?", [ids.receiptId]);

    let forcedError;
    try {
      await validateStockReceipt({
        receiptId: ids.receiptId,
        actorId: ids.userId,
        failAfterMovement: true,
      });
    } catch (error) {
      forcedError = error;
    }

    assert(forcedError, 'forced stock receipt failure did not throw');
    assert.strictEqual(forcedError.message, 'STOCK_RECEIPT_TEST_FAILURE_AFTER_MOVEMENT');

    const rolledBackProduct = await db.queryOne('SELECT stock_disponible FROM produits WHERE id = ?', [ids.productId]);
    const rolledBackReceipt = await db.queryOne('SELECT statut FROM receptions WHERE id = ?', [ids.receiptId]);
    const orphanMovement = await db.queryOne(`
      SELECT id FROM stock_mouvements
      WHERE reference_type = 'reception' AND reference_id = ?
    `, [ids.receiptId]);
    const orphanAudit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'receptions' AND record_id = ? AND action = 'VALIDER'
    `, [ids.receiptId]);

    assert.strictEqual(Number(rolledBackProduct.stock_disponible), 10);
    assert.strictEqual(rolledBackReceipt.statut, 'reception_totale');
    assert.strictEqual(orphanMovement, null, 'stock movement remained after rollback');
    assert.strictEqual(orphanAudit, null, 'receipt audit remained after rollback');

    console.log('test_stock_receipt_validation_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

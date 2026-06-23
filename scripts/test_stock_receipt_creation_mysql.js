'use strict';

process.env.DB_DRIVER = 'mysql';

const assert = require('assert');
const db = require('../backend/db');
const { createStockReceipt } = require('../backend/services/stock_receipt_creation_workflow');

function shortId(prefix) {
  return `${prefix}${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
}

async function removeReceipts(purchaseOrderId) {
  const receipts = await db.query('SELECT id FROM receptions WHERE bc_id = ?', [purchaseOrderId]);
  for (const receipt of receipts) {
    await db.execute("DELETE FROM audit_logs WHERE table_name = 'receptions' AND record_id = ?", [receipt.id]);
    await db.execute('DELETE FROM receptions_lignes WHERE reception_id = ?', [receipt.id]);
    await db.execute('DELETE FROM receptions WHERE id = ?', [receipt.id]);
  }
}

async function cleanup(ids) {
  if (ids.purchaseOrderId) {
    await removeReceipts(ids.purchaseOrderId);
    await db.execute('DELETE FROM bons_commandes_lignes WHERE bc_id = ?', [ids.purchaseOrderId]);
    await db.execute('DELETE FROM bons_commandes_fournisseurs WHERE id = ?', [ids.purchaseOrderId]);
  }
  if (ids.productId) await db.execute('DELETE FROM produits WHERE id = ?', [ids.productId]);
  if (ids.productCategoryId) await db.execute('DELETE FROM categories_produits WHERE id = ?', [ids.productCategoryId]);
  if (ids.supplierId) await db.execute('DELETE FROM fournisseurs WHERE id = ?', [ids.supplierId]);
  if (ids.userId) await db.execute('DELETE FROM users WHERE id = ?', [ids.userId]);
}

async function main() {
  const token = shortId('RC');
  const ids = {};

  try {
    const user = await db.execute(`
      INSERT INTO users (nom, email, password_hash, role, actif, created_at)
      VALUES (?, ?, ?, 'finance', 1, NOW())
    `, ['Test création réception', `${token}@example.test`, 'not-used-in-test']);
    ids.userId = user.insertId;

    const category = await db.execute(`
      INSERT INTO categories_produits (nom, description, actif, created_at)
      VALUES (?, 'Catégorie test création réception', 1, NOW())
    `, [`Cat-${token}`]);
    ids.productCategoryId = category.insertId;

    const product = await db.execute(`
      INSERT INTO produits
        (code_produit, designation, categorie_id, unite, prix_achat, prix_vente,
         stock_disponible, stock_reserve, stock_minimum, statut, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'piece', 1000, 1500, 0, 0, 0, 'actif', ?, NOW(), NOW())
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
      VALUES (?, ?, 'valide', 5000, 0, 5000, ?, ?, NOW(), NOW())
    `, [`BC-${token}`, ids.supplierId, ids.userId, ids.userId]);
    ids.purchaseOrderId = purchaseOrder.insertId;

    const orderLine = await db.execute(`
      INSERT INTO bons_commandes_lignes
        (bc_id, produit_id, designation, quantite, quantite_recue,
         prix_unitaire, taux_taxe, montant_ht, montant_ttc, ordre)
      VALUES (?, ?, ?, 5, 0, 1000, 0, 5000, 5000, 1)
    `, [ids.purchaseOrderId, ids.productId, `Produit ${token}`]);
    ids.orderLineId = orderLine.insertId;

    const success = await createStockReceipt({
      purchaseOrderId: ids.purchaseOrderId,
      payload: {
        date_reception: '2026-06-23',
        notes: 'Réception partielle atomique',
        lignes: [{ bc_ligne_id: ids.orderLineId, quantite_recue: 3, quantite_conforme: 3 }],
      },
      actorId: ids.userId,
    });

    assert.match(success.receiptNumber, /^REC-2026-\d{4,}$/);
    assert.strictEqual(success.receiptStatus, 'reception_partielle');
    assert.strictEqual(success.purchaseOrderStatus, 'partiellement_livre');
    assert.strictEqual(success.lines.length, 1);

    const storedReceipt = await db.queryOne('SELECT statut FROM receptions WHERE id = ?', [success.receiptId]);
    const storedLine = await db.queryOne('SELECT quantite_recue, quantite_conforme FROM receptions_lignes WHERE reception_id = ?', [success.receiptId]);
    const storedOrderLine = await db.queryOne('SELECT quantite_recue FROM bons_commandes_lignes WHERE id = ?', [ids.orderLineId]);
    const storedOrder = await db.queryOne('SELECT statut FROM bons_commandes_fournisseurs WHERE id = ?', [ids.purchaseOrderId]);
    const audit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'receptions' AND record_id = ? AND action = 'CREATE'
    `, [success.receiptId]);

    assert.strictEqual(storedReceipt.statut, 'reception_partielle');
    assert.strictEqual(Number(storedLine.quantite_recue), 3);
    assert.strictEqual(Number(storedLine.quantite_conforme), 3);
    assert.strictEqual(Number(storedOrderLine.quantite_recue), 3);
    assert.strictEqual(storedOrder.statut, 'partiellement_livre');
    assert(audit, 'receipt creation audit missing');

    await removeReceipts(ids.purchaseOrderId);
    await db.execute('UPDATE bons_commandes_lignes SET quantite_recue = 0 WHERE id = ?', [ids.orderLineId]);
    await db.execute("UPDATE bons_commandes_fournisseurs SET statut = 'valide', updated_at = NOW() WHERE id = ?", [ids.purchaseOrderId]);

    let forcedError;
    try {
      await createStockReceipt({
        purchaseOrderId: ids.purchaseOrderId,
        payload: {
          date_reception: '2026-06-24',
          lignes: [{ bc_ligne_id: ids.orderLineId, quantite_recue: 2, quantite_conforme: 2 }],
        },
        actorId: ids.userId,
        failAfterLine: true,
      });
    } catch (error) {
      forcedError = error;
    }

    assert(forcedError, 'forced receipt creation failure did not throw');
    assert.strictEqual(forcedError.message, 'STOCK_RECEIPT_CREATION_TEST_FAILURE_AFTER_LINE');

    const remainingReceipts = await db.query('SELECT id FROM receptions WHERE bc_id = ?', [ids.purchaseOrderId]);
    const rolledBackOrderLine = await db.queryOne('SELECT quantite_recue FROM bons_commandes_lignes WHERE id = ?', [ids.orderLineId]);
    const rolledBackOrder = await db.queryOne('SELECT statut FROM bons_commandes_fournisseurs WHERE id = ?', [ids.purchaseOrderId]);
    const orphanAudit = await db.queryOne(`
      SELECT id FROM audit_logs
      WHERE table_name = 'receptions' AND action = 'CREATE' AND user_id = ?
    `, [ids.userId]);

    assert.strictEqual(remainingReceipts.length, 0, 'receipt header remained after rollback');
    assert.strictEqual(Number(rolledBackOrderLine.quantite_recue), 0);
    assert.strictEqual(rolledBackOrder.statut, 'valide');
    assert.strictEqual(orphanAudit, null, 'receipt creation audit remained after rollback');

    console.log('test_stock_receipt_creation_mysql: OK');
  } finally {
    await cleanup(ids);
    await db._pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

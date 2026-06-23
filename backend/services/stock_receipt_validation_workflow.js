'use strict';

const db = require('../db');

function workflowError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function validateStockReceipt({
  receiptId,
  actorId,
  dbc = db,
  failAfterMovement = false,
}) {
  if (!receiptId) throw workflowError('Réception obligatoire');
  if (!actorId) throw workflowError('Auteur obligatoire');

  const result = await dbc.transaction(async (tx) => {
    const receipt = await tx.queryOne(
      'SELECT * FROM receptions WHERE id = ? FOR UPDATE',
      [receiptId],
    );
    if (!receipt) throw workflowError('Réception introuvable', 404);
    if (receipt.statut === 'accepte') {
      throw workflowError('Réception déjà validée');
    }

    const lines = await tx.query(`
      SELECT rl.*, bcl.produit_id, bcl.designation
      FROM receptions_lignes rl
      LEFT JOIN bons_commandes_lignes bcl ON bcl.id = rl.bc_ligne_id
      WHERE rl.reception_id = ?
      ORDER BY rl.id
    `, [receipt.id]);

    const movements = [];
    for (const line of lines) {
      const productId = Number(line.produit_id || 0);
      const compliantQuantity = Number(line.quantite_conforme || 0);
      if (!productId || compliantQuantity <= 0) continue;

      const product = await tx.queryOne(
        'SELECT id, stock_disponible FROM produits WHERE id = ? FOR UPDATE',
        [productId],
      );
      if (!product) continue;

      const quantityBefore = Number(product.stock_disponible || 0);
      const quantityAfter = Math.round((quantityBefore + compliantQuantity) * 1000) / 1000;
      await tx.execute(
        'UPDATE produits SET stock_disponible = ?, updated_at = NOW() WHERE id = ?',
        [quantityAfter, product.id],
      );

      const movement = await tx.execute(`
        INSERT INTO stock_mouvements
          (produit_id, type, quantite, quantite_avant, quantite_apres,
           reference_id, reference_type, motif, created_by, created_at)
        VALUES (?, 'entree', ?, ?, ?, ?, 'reception', ?, ?, NOW())
      `, [
        product.id,
        compliantQuantity,
        quantityBefore,
        quantityAfter,
        receipt.id,
        `Réception ${receipt.numero}`,
        actorId,
      ]);
      if (!movement.insertId) throw new Error('Mouvement de stock sans identifiant');
      movements.push(movement.insertId);

      if (failAfterMovement) {
        throw new Error('STOCK_RECEIPT_TEST_FAILURE_AFTER_MOVEMENT');
      }
    }

    await tx.execute(
      "UPDATE receptions SET statut = 'accepte', updated_at = NOW() WHERE id = ?",
      [receipt.id],
    );
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      [
        'receptions',
        receipt.id,
        'VALIDER',
        JSON.stringify({ stock_mis_a_jour: true, mouvements_ids: movements }),
        actorId,
      ],
    );

    return {
      receiptId: receipt.id,
      status: 'accepte',
      movementIds: movements,
    };
  });

  return {
    ...result,
    receipt: await dbc.queryOne('SELECT * FROM receptions WHERE id = ?', [result.receiptId]),
  };
}

module.exports = { validateStockReceipt };

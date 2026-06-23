'use strict';

const db = require('../db');

function workflowError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function dateOrNull(value) {
  return value ? String(value).slice(0, 10) : null;
}

function toQuantity(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw workflowError(`${field} invalide`);
  }
  return Math.round(number * 1000) / 1000;
}

async function nextReceiptNumber(tx, dateReception) {
  const year = Number(String(dateReception).slice(0, 4));
  const currentYear = Number.isInteger(year) && year >= 2000 ? year : new Date().getFullYear();
  const prefix = `REC-${currentYear}-%`;
  const last = await tx.queryOne(`
    SELECT numero
    FROM receptions
    WHERE numero LIKE ?
    ORDER BY numero DESC
    LIMIT 1
    FOR UPDATE
  `, [prefix]);
  const lastSequence = last?.numero ? Number.parseInt(String(last.numero).split('-').pop(), 10) || 0 : 0;
  return `REC-${currentYear}-${String(lastSequence + 1).padStart(4, '0')}`;
}

async function createStockReceipt({
  purchaseOrderId,
  payload,
  actorId,
  dbc = db,
  failAfterLine = false,
}) {
  if (!purchaseOrderId) throw workflowError('bc_id requis');
  if (!actorId) throw workflowError('Auteur obligatoire');

  const receiptDate = dateOrNull(payload?.date_reception);
  const lines = Array.isArray(payload?.lignes) ? payload.lignes : [];
  const notes = payload?.notes ? String(payload.notes).trim() : null;
  if (!receiptDate) throw workflowError('date_reception requise');
  if (!lines.length) throw workflowError('Au moins une ligne requise');

  const result = await dbc.transaction(async (tx) => {
    const purchaseOrder = await tx.queryOne(
      'SELECT * FROM bons_commandes_fournisseurs WHERE id = ? FOR UPDATE',
      [purchaseOrderId],
    );
    if (!purchaseOrder) throw workflowError('Bon de commande introuvable', 404);
    if (['annule', 'cloture'].includes(purchaseOrder.statut)) {
      throw workflowError(`Réception impossible sur BC ${purchaseOrder.statut}`);
    }

    const receiptNumber = await nextReceiptNumber(tx, receiptDate);
    const insertedReceipt = await tx.execute(`
      INSERT INTO receptions
        (numero, bc_id, statut, date_reception, notes, created_by, created_at, updated_at)
      VALUES (?, ?, 'en_cours', ?, ?, ?, NOW(), NOW())
    `, [receiptNumber, purchaseOrder.id, receiptDate, notes, actorId]);
    const receiptId = insertedReceipt.insertId;
    if (!receiptId) throw new Error('Création de la réception sans identifiant');

    let receiptOrderedTotal = 0;
    let receiptReceivedTotal = 0;
    const createdLineIds = [];

    for (const input of lines) {
      const orderLineId = Number(input?.bc_ligne_id || 0);
      if (!orderLineId) throw workflowError('bc_ligne_id requis pour chaque ligne');

      const orderLine = await tx.queryOne(`
        SELECT *
        FROM bons_commandes_lignes
        WHERE id = ? AND bc_id = ?
        FOR UPDATE
      `, [orderLineId, purchaseOrder.id]);
      if (!orderLine) {
        throw workflowError(`Ligne BC #${orderLineId} introuvable`, 400, { bc_ligne_id: orderLineId });
      }

      const receivedQuantity = toQuantity(input.quantite_recue, 'quantite_recue');
      const compliantQuantity = input.quantite_conforme === undefined || input.quantite_conforme === null || input.quantite_conforme === ''
        ? receivedQuantity
        : toQuantity(input.quantite_conforme, 'quantite_conforme');
      if (compliantQuantity > receivedQuantity) {
        throw workflowError('quantite_conforme ne peut pas dépasser quantite_recue', 400, { bc_ligne_id: orderLineId });
      }

      const orderedQuantity = Number(orderLine.quantite || 0);
      const previousReceived = Number(orderLine.quantite_recue || 0);
      const cumulativeReceived = Math.round((previousReceived + receivedQuantity) * 1000) / 1000;
      const difference = Math.round((receivedQuantity - orderedQuantity) * 1000) / 1000;
      const lineStatus = compliantQuantity <= 0
        ? 'non_conforme'
        : compliantQuantity < receivedQuantity || compliantQuantity < orderedQuantity
          ? 'ecart'
          : 'conforme';

      const insertedLine = await tx.execute(`
        INSERT INTO receptions_lignes
          (reception_id, bc_ligne_id, quantite_commandee, quantite_recue,
           quantite_conforme, ecart, motif_ecart, statut_ligne)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        receiptId,
        orderLine.id,
        orderedQuantity,
        receivedQuantity,
        compliantQuantity,
        difference,
        input?.motif_ecart ? String(input.motif_ecart).trim() : null,
        lineStatus,
      ]);
      if (!insertedLine.insertId) throw new Error('Création d’une ligne de réception sans identifiant');
      createdLineIds.push(insertedLine.insertId);

      await tx.execute(
        'UPDATE bons_commandes_lignes SET quantite_recue = ? WHERE id = ?',
        [cumulativeReceived, orderLine.id],
      );

      receiptOrderedTotal += orderedQuantity;
      receiptReceivedTotal += receivedQuantity;

      if (failAfterLine) {
        throw new Error('STOCK_RECEIPT_CREATION_TEST_FAILURE_AFTER_LINE');
      }
    }

    const receiptStatus = receiptReceivedTotal <= 0
      ? 'non_conforme'
      : receiptReceivedTotal + 0.001 < receiptOrderedTotal
        ? 'reception_partielle'
        : 'reception_totale';

    const orderTotals = await tx.queryOne(`
      SELECT
        COALESCE(SUM(quantite), 0) AS ordered_total,
        COALESCE(SUM(quantite_recue), 0) AS received_total
      FROM bons_commandes_lignes
      WHERE bc_id = ?
    `, [purchaseOrder.id]);
    const purchaseOrderStatus = Number(orderTotals?.received_total || 0) + 0.001 >= Number(orderTotals?.ordered_total || 0)
      ? 'livre'
      : 'partiellement_livre';

    await tx.execute(
      'UPDATE receptions SET statut = ?, updated_at = NOW() WHERE id = ?',
      [receiptStatus, receiptId],
    );
    await tx.execute(
      'UPDATE bons_commandes_fournisseurs SET statut = ?, updated_at = NOW() WHERE id = ?',
      [purchaseOrderStatus, purchaseOrder.id],
    );
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      [
        'receptions',
        receiptId,
        'CREATE',
        JSON.stringify({
          numero: receiptNumber,
          bc_id: purchaseOrder.id,
          statut: receiptStatus,
          bc_statut: purchaseOrderStatus,
          lignes_ids: createdLineIds,
        }),
        actorId,
      ],
    );

    return { receiptId, receiptNumber, receiptStatus, purchaseOrderStatus };
  });

  return {
    ...result,
    receipt: await dbc.queryOne('SELECT * FROM receptions WHERE id = ?', [result.receiptId]),
    lines: await dbc.query('SELECT * FROM receptions_lignes WHERE reception_id = ? ORDER BY id', [result.receiptId]),
  };
}

module.exports = {
  createStockReceipt,
  nextReceiptNumber,
};

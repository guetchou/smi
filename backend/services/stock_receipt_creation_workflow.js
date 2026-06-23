'use strict';

const db = require('../db');

function fail(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}
function qty(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw fail(`${field} invalide`);
  return Math.round(number * 1000) / 1000;
}
async function nextReceiptNumber(tx, date) {
  const parsedYear = Number(String(date || '').slice(0, 4));
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 ? parsedYear : new Date().getFullYear();
  const last = await tx.queryOne(`
    SELECT numero FROM receptions
    WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1 FOR UPDATE
  `, [`REC-${year}-%`]);
  const sequence = last?.numero ? Number.parseInt(String(last.numero).split('-').pop(), 10) || 0 : 0;
  return `REC-${year}-${String(sequence + 1).padStart(4, '0')}`;
}

async function createStockReceipt({ purchaseOrderId, payload, actorId, dbc = db, failAfterLine = false }) {
  if (!purchaseOrderId) throw fail('bc_id requis');
  if (!actorId) throw fail('Auteur obligatoire');
  const receiptDate = payload?.date_reception ? String(payload.date_reception).slice(0, 10) : null;
  const inputs = Array.isArray(payload?.lignes) ? payload.lignes : [];
  if (!receiptDate) throw fail('date_reception requise');
  if (!inputs.length) throw fail('Au moins une ligne requise');

  const result = await dbc.transaction(async tx => {
    const order = await tx.queryOne(
      'SELECT * FROM bons_commandes_fournisseurs WHERE id = ? FOR UPDATE',
      [purchaseOrderId],
    );
    if (!order) throw fail('Bon de commande introuvable', 404);
    if (['annule', 'cloture'].includes(order.statut)) throw fail(`Réception impossible sur BC ${order.statut}`);

    const number = await nextReceiptNumber(tx, receiptDate);
    const inserted = await tx.execute(`
      INSERT INTO receptions
        (numero, bc_id, statut, date_reception, notes, created_by, created_at, updated_at)
      VALUES (?, ?, 'en_cours', ?, ?, ?, NOW(), NOW())
    `, [number, order.id, receiptDate, payload?.notes || null, actorId]);
    const receiptId = inserted.insertId;
    if (!receiptId) throw new Error('Création de la réception sans identifiant');

    const seen = new Set();
    const createdLineIds = [];
    let orderedTotal = 0;
    let receivedTotal = 0;

    for (const input of inputs) {
      const orderLineId = Number(input?.bc_ligne_id || 0);
      if (!orderLineId) throw fail('bc_ligne_id requis pour chaque ligne');
      if (seen.has(orderLineId)) throw fail(`Ligne BC #${orderLineId} dupliquée`, 400, { bc_ligne_id: orderLineId });
      seen.add(orderLineId);

      const line = await tx.queryOne(`
        SELECT * FROM bons_commandes_lignes
        WHERE id = ? AND bc_id = ? FOR UPDATE
      `, [orderLineId, order.id]);
      if (!line) throw fail(`Ligne BC #${orderLineId} introuvable`, 400, { bc_ligne_id: orderLineId });

      const received = qty(input.quantite_recue, 'quantite_recue');
      const compliant = input.quantite_conforme === undefined || input.quantite_conforme === null || input.quantite_conforme === ''
        ? received : qty(input.quantite_conforme, 'quantite_conforme');
      if (compliant > received) throw fail('quantite_conforme ne peut pas dépasser quantite_recue', 400, { bc_ligne_id: orderLineId });

      const ordered = Number(line.quantite || 0);
      const cumulative = Math.round((Number(line.quantite_recue || 0) + received) * 1000) / 1000;
      const status = compliant <= 0 ? 'non_conforme' : Math.abs(compliant - received) <= 0.001 ? 'conforme' : 'ecart';
      const lineResult = await tx.execute(`
        INSERT INTO receptions_lignes
          (reception_id, bc_ligne_id, quantite_commandee, quantite_recue,
           quantite_conforme, ecart, motif_ecart, statut_ligne)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [receiptId, line.id, ordered, received, compliant,
        Math.round((received - ordered) * 1000) / 1000,
        input?.motif_ecart || null, status]);
      if (!lineResult.insertId) throw new Error('Création d’une ligne de réception sans identifiant');
      createdLineIds.push(lineResult.insertId);
      await tx.execute('UPDATE bons_commandes_lignes SET quantite_recue = ? WHERE id = ?', [cumulative, line.id]);
      orderedTotal += ordered;
      receivedTotal += received;
      if (failAfterLine) throw new Error('STOCK_RECEIPT_CREATION_TEST_FAILURE_AFTER_LINE');
    }

    const receiptStatus = receivedTotal <= 0 ? 'non_conforme'
      : receivedTotal + 0.001 < orderedTotal ? 'reception_partielle' : 'reception_totale';
    const totals = await tx.queryOne(`
      SELECT COALESCE(SUM(quantite),0) ordered_total,
             COALESCE(SUM(quantite_recue),0) received_total
      FROM bons_commandes_lignes WHERE bc_id = ?
    `, [order.id]);
    const orderStatus = Number(totals.received_total) + 0.001 >= Number(totals.ordered_total)
      ? 'livre' : 'partiellement_livre';

    await tx.execute('UPDATE receptions SET statut = ?, updated_at = NOW() WHERE id = ?', [receiptStatus, receiptId]);
    await tx.execute('UPDATE bons_commandes_fournisseurs SET statut = ?, updated_at = NOW() WHERE id = ?', [orderStatus, order.id]);
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['receptions', receiptId, 'CREATE', JSON.stringify({ numero: number, bc_id: order.id,
        statut: receiptStatus, bc_statut: orderStatus, lignes_ids: createdLineIds }), actorId],
    );
    return { receiptId, receiptNumber: number, receiptStatus, purchaseOrderStatus: orderStatus };
  });

  return {
    ...result,
    receipt: await dbc.queryOne('SELECT * FROM receptions WHERE id = ?', [result.receiptId]),
    lines: await dbc.query('SELECT * FROM receptions_lignes WHERE reception_id = ? ORDER BY id', [result.receiptId]),
  };
}

module.exports = { createStockReceipt, nextReceiptNumber };

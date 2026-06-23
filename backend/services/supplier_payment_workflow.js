'use strict';

const db = require('../db');

function workflowError(message, status = 400, code = null, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizeMode(value) {
  if (value === 'virement') return 'virement_bancaire';
  if (value === 'carte') return 'autres';
  const allowed = ['especes', 'cheque', 'virement_bancaire', 'mobile_money', 'compensation', 'autres'];
  return allowed.includes(value) ? value : 'virement_bancaire';
}

async function audit(tx, recordId, action, details, userId) {
  await tx.execute(
    'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
    ['factures_fournisseurs', recordId, action, JSON.stringify(details || {}), userId || null],
  );
}

async function getReconciliationThreshold(tx) {
  const row = await tx.queryOne(
    "SELECT valeur FROM parametres WHERE cle = 'rapprochement_seuil_pct'",
  );
  const percentage = Number.parseFloat(row?.valeur || '2');
  return Number.isFinite(percentage) ? percentage / 100 : 0.02;
}

async function calculateReconciliation(invoice, tx) {
  const result = {
    statut: 'conforme',
    ecart_montant: 0,
    ecart_quantite: 0,
    details: [],
  };

  if (!invoice.bc_id) {
    result.statut = 'ecart_bloquant';
    result.details.push('Aucun bon de commande associé à cette facture.');
    return result;
  }

  const purchaseOrder = await tx.queryOne(
    'SELECT * FROM bons_commandes_fournisseurs WHERE id = ?',
    [invoice.bc_id],
  );
  if (!purchaseOrder) {
    result.statut = 'ecart_bloquant';
    result.details.push(`BC #${invoice.bc_id} introuvable.`);
    return result;
  }

  const receptions = await tx.query(
    'SELECT * FROM receptions WHERE bc_id = ?',
    [invoice.bc_id],
  );
  if (!receptions.length) {
    result.statut = 'ecart_bloquant';
    result.details.push('Aucune réception enregistrée pour ce bon de commande — paiement impossible sans réception.');
    return result;
  }

  if (invoice.reception_id) {
    const reception = await tx.queryOne(
      'SELECT * FROM receptions WHERE id = ?',
      [invoice.reception_id],
    );
    if (!reception) {
      result.statut = 'ecart_bloquant';
      result.details.push(`Réception #${invoice.reception_id} référencée mais introuvable.`);
      return result;
    }
    if (reception.statut === 'non_conforme') {
      result.statut = 'ecart_bloquant';
      result.details.push(`La réception #${invoice.reception_id} est marquée non conforme.`);
    }
  }

  const lines = await tx.query(
    'SELECT * FROM bons_commandes_lignes WHERE bc_id = ? ORDER BY ordre, id',
    [invoice.bc_id],
  );
  let totalQuantityDifference = 0;
  let compliantReceivedAmount = 0;

  for (const line of lines) {
    const received = await tx.queryOne(`
      SELECT COALESCE(SUM(rl.quantite_conforme), 0) AS total_conforme
      FROM receptions_lignes rl
      JOIN receptions r ON r.id = rl.reception_id
      WHERE rl.bc_ligne_id = ? AND r.bc_id = ?
    `, [line.id, invoice.bc_id]);

    const compliantQuantity = Number(received?.total_conforme || 0);
    const orderedQuantity = Number(line.quantite || 0);
    const difference = orderedQuantity - compliantQuantity;
    totalQuantityDifference += Math.abs(difference);
    const unitPriceWithTax = Number(line.prix_unitaire || 0) * (1 + Number(line.taux_taxe || 0) / 100);
    compliantReceivedAmount += compliantQuantity * unitPriceWithTax;

    if (difference > 0.001) {
      result.details.push(
        `"${line.designation}" : commandé ${orderedQuantity}, reçu conforme ${compliantQuantity} (-${difference.toFixed(2)} unité(s)).`,
      );
    }
  }

  result.ecart_quantite = money(totalQuantityDifference);
  compliantReceivedAmount = money(compliantReceivedAmount);
  const partialReception = totalQuantityDifference > 0.001;

  if (partialReception) {
    if (Number(invoice.montant_ttc) <= compliantReceivedAmount + 1) {
      result.details.push(`Réception partielle acceptable : facture ${invoice.montant_ttc} XAF, reçu conforme ${compliantReceivedAmount} XAF.`);
      if (result.statut === 'conforme') result.statut = 'ecart_acceptable';
    } else {
      result.statut = 'ecart_bloquant';
      result.details.push(`Réception partielle bloquante : facture ${invoice.montant_ttc} XAF, reçu conforme ${compliantReceivedAmount} XAF.`);
    }
  }

  const comparisonAmount = partialReception ? compliantReceivedAmount : Number(purchaseOrder.montant_ttc || 0);
  const amountDifference = Number(invoice.montant_ttc || 0) - comparisonAmount;
  const differenceRate = comparisonAmount > 0 ? Math.abs(amountDifference) / comparisonAmount : 0;
  result.ecart_montant = money(amountDifference);

  if (Math.abs(amountDifference) > 1) {
    result.details.push(`Écart de montant : ${money(amountDifference)} XAF (${(differenceRate * 100).toFixed(2)} %).`);
    const threshold = await getReconciliationThreshold(tx);
    if (differenceRate > threshold && result.statut !== 'ecart_bloquant') {
      result.statut = 'ecart_bloquant';
    } else if (result.statut === 'conforme') {
      result.statut = 'ecart_acceptable';
    }
  }

  return result;
}

async function selectPosition(tx, requestedId) {
  if (requestedId) {
    const requested = await tx.queryOne(
      'SELECT id FROM positions WHERE id = ? AND actif = 1',
      [Number(requestedId)],
    );
    if (requested) return requested;
  }
  return tx.queryOne(`
    SELECT id FROM positions
    WHERE actif = 1 AND type IN ('caisse', 'banque')
    ORDER BY ordre, id
    LIMIT 1
  `);
}

async function selectExpenseCategory(tx) {
  const preferred = await tx.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('depense', 'decaissement') AND COALESCE(actif, 1) = 1
      AND (LOWER(nom) LIKE '%achat%' OR LOWER(nom) LIKE '%fournisseur%' OR LOWER(nom) LIKE '%charge%')
    ORDER BY id LIMIT 1
  `);
  if (preferred) return preferred;
  return tx.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('depense', 'decaissement') AND COALESCE(actif, 1) = 1
    ORDER BY id LIMIT 1
  `);
}

async function paySupplierInvoice({
  invoiceId,
  payload,
  actorId,
  canOverride = false,
  dbc = db,
  failAfterOperation = false,
}) {
  if (!invoiceId) throw workflowError('Facture fournisseur obligatoire');
  if (!actorId) throw workflowError('Auteur obligatoire');

  const amount = money(payload?.montant);
  const paymentDate = payload?.date_paiement ? String(payload.date_paiement).slice(0, 10) : null;
  const overrideRequested = payload?.override_rapprochement === true || payload?.override_rapprochement === 'true';
  const overrideReason = String(payload?.motif_override || '').trim();
  if (amount <= 0) throw workflowError('Montant invalide');
  if (!paymentDate) throw workflowError('date_paiement requise');

  const result = await dbc.transaction(async (tx) => {
    const invoice = await tx.queryOne(`
      SELECT ff.*, f.nom AS fournisseur_nom
      FROM factures_fournisseurs ff
      LEFT JOIN fournisseurs f ON f.id = ff.fournisseur_id
      WHERE ff.id = ?
      FOR UPDATE
    `, [invoiceId]);
    if (!invoice) throw workflowError('Facture fournisseur introuvable', 404);
    if (!['validee', 'partiellement_payee'].includes(invoice.statut)) {
      throw workflowError(`Paiement impossible — facture doit être validée (statut : ${invoice.statut})`);
    }

    if (['ecart_bloquant', 'conteste'].includes(invoice.rapprochement_statut)) {
      if (!overrideRequested) {
        throw workflowError(
          invoice.rapprochement_statut === 'conteste'
            ? 'Paiement bloqué — facture contestée.'
            : 'Paiement bloqué — rapprochement 3 voies : écart bloquant.',
          400,
          invoice.rapprochement_statut === 'conteste' ? 'RAPPROCHEMENT_CONTESTE' : 'RAPPROCHEMENT_ECART_BLOQUANT',
          { ecart_montant: invoice.ecart_montant, ecart_quantite: invoice.ecart_quantite, ecart_motif: invoice.ecart_motif },
        );
      }
      if (!canOverride) throw workflowError('Override réservé au DG ou à l’Admin', 403, 'OVERRIDE_NON_AUTORISE');
      if (!overrideReason) throw workflowError('Override rapprochement : motif obligatoire.', 400, 'OVERRIDE_MOTIF_REQUIS');
      await audit(tx, invoice.id,
        invoice.rapprochement_statut === 'conteste' ? 'OVERRIDE_RAPPROCHEMENT_CONTESTE' : 'OVERRIDE_RAPPROCHEMENT',
        { rapprochement_statut: invoice.rapprochement_statut, motif_override: overrideReason }, actorId);
    }

    if (invoice.rapprochement_statut === 'non_rapproche' && invoice.bc_id) {
      const reconciliation = await calculateReconciliation(invoice, tx);
      await tx.execute(`
        UPDATE factures_fournisseurs
        SET rapprochement_statut = ?, ecart_montant = ?, ecart_quantite = ?,
            ecart_motif = ?, rapprochement_at = NOW(), rapprochement_by = ?, updated_at = NOW()
        WHERE id = ?
      `, [
        reconciliation.statut,
        reconciliation.ecart_montant,
        reconciliation.ecart_quantite,
        reconciliation.details.join(' | '),
        actorId,
        invoice.id,
      ]);
      await audit(tx, invoice.id, 'RAPPROCHEMENT_AUTO', reconciliation, actorId);
      if (reconciliation.statut === 'ecart_bloquant') {
        return { blocked: true, reconciliation };
      }
    }

    const remaining = money(invoice.reste_a_payer);
    if (amount > remaining + 0.01) {
      throw workflowError(`Montant (${amount}) supérieur au reste à payer (${remaining})`);
    }

    const position = await selectPosition(tx, payload?.position_id);
    if (!position) throw workflowError('Aucune position de trésorerie active disponible pour le paiement fournisseur');
    const category = await selectExpenseCategory(tx);
    const mode = normalizeMode(payload?.mode_reglement);
    const externalReference = String(payload?.ref_paiement || `FF-${invoice.id}`).trim();

    const operation = await tx.execute(`
      INSERT INTO operations
        (date, libelle, tiers, montant, type_op, position_id, categorie_id,
         mode_reglement, ref_externe, statut, dec_statut,
         created_by, submitted_by, submitted_at, validated_by, validated_at, paid_by, paid_at)
      VALUES (?, ?, ?, ?, 'decaissement', ?, ?, ?, ?, 'valide', 'paye',
              ?, ?, NOW(), ?, NOW(), ?, NOW())
    `, [
      paymentDate,
      `Paiement facture fournisseur ${invoice.numero_facture_fournisseur}`,
      invoice.fournisseur_nom || 'Fournisseur',
      amount,
      position.id,
      category?.id || null,
      mode,
      externalReference,
      actorId,
      actorId,
      actorId,
      actorId,
    ]);
    const operationId = operation.insertId;
    if (!operationId) throw new Error('Création de l’opération de paiement sans identifiant');
    if (failAfterOperation) throw new Error('SUPPLIER_PAYMENT_TEST_FAILURE_AFTER_OPERATION');

    const newPaid = money(Number(invoice.montant_paye || 0) + amount);
    const newRemaining = money(Math.max(0, Number(invoice.montant_ttc || 0) - newPaid));
    const newStatus = newRemaining <= 0.01 ? 'payee' : 'partiellement_payee';
    await tx.execute(`
      UPDATE factures_fournisseurs
      SET montant_paye = ?, reste_a_payer = ?, statut = ?, operation_id = ?, updated_at = NOW()
      WHERE id = ?
    `, [newPaid, newRemaining, newStatus, operationId, invoice.id]);

    await audit(tx, invoice.id, 'PAIEMENT', {
      montant: amount,
      nouveau_statut: newStatus,
      operation_id: operationId,
    }, actorId);

    return {
      blocked: false,
      operationId,
      invoiceId: invoice.id,
      status: newStatus,
    };
  });

  if (result.blocked) {
    throw workflowError(
      'Paiement bloqué — rapprochement automatique : écart bloquant détecté.',
      400,
      'RAPPROCHEMENT_ECART_BLOQUANT',
      result.reconciliation,
    );
  }

  return {
    ...result,
    invoice: await dbc.queryOne('SELECT * FROM factures_fournisseurs WHERE id = ?', [result.invoiceId]),
  };
}

module.exports = {
  calculateReconciliation,
  paySupplierInvoice,
};

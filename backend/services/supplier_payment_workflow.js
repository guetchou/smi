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

async function calculateReconciliation(invoice, tx) {
  const out = { statut: 'conforme', ecart_montant: 0, ecart_quantite: 0, details: [] };
  if (!invoice.bc_id) {
    out.statut = 'ecart_bloquant';
    out.details.push('Aucun bon de commande associé à cette facture.');
    return out;
  }

  const order = await tx.queryOne('SELECT * FROM bons_commandes_fournisseurs WHERE id = ?', [invoice.bc_id]);
  if (!order) {
    out.statut = 'ecart_bloquant';
    out.details.push(`BC #${invoice.bc_id} introuvable.`);
    return out;
  }

  const receptions = await tx.query('SELECT id, statut FROM receptions WHERE bc_id = ?', [invoice.bc_id]);
  if (!receptions.length) {
    out.statut = 'ecart_bloquant';
    out.details.push('Aucune réception enregistrée pour ce bon de commande.');
    return out;
  }

  if (invoice.reception_id) {
    const reception = receptions.find(row => Number(row.id) === Number(invoice.reception_id));
    if (!reception || reception.statut === 'non_conforme') {
      out.statut = 'ecart_bloquant';
      out.details.push(!reception
        ? `Réception #${invoice.reception_id} introuvable.`
        : `La réception #${invoice.reception_id} est non conforme.`);
    }
  }

  const lines = await tx.query('SELECT * FROM bons_commandes_lignes WHERE bc_id = ? ORDER BY ordre, id', [invoice.bc_id]);
  let quantityDifference = 0;
  let compliantAmount = 0;
  for (const line of lines) {
    const received = await tx.queryOne(`
      SELECT COALESCE(SUM(rl.quantite_conforme), 0) AS qty
      FROM receptions_lignes rl
      JOIN receptions r ON r.id = rl.reception_id
      WHERE rl.bc_ligne_id = ? AND r.bc_id = ?
    `, [line.id, invoice.bc_id]);
    const compliantQty = Number(received?.qty || 0);
    const orderedQty = Number(line.quantite || 0);
    const difference = orderedQty - compliantQty;
    quantityDifference += Math.abs(difference);
    compliantAmount += compliantQty * Number(line.prix_unitaire || 0) * (1 + Number(line.taux_taxe || 0) / 100);
    if (difference > 0.001) out.details.push(`${line.designation}: écart de quantité ${difference.toFixed(2)}.`);
  }

  out.ecart_quantite = money(quantityDifference);
  compliantAmount = money(compliantAmount);
  const partial = quantityDifference > 0.001;
  if (partial && Number(invoice.montant_ttc) > compliantAmount + 1) {
    out.statut = 'ecart_bloquant';
    out.details.push(`Facture ${invoice.montant_ttc} XAF supérieure au reçu conforme ${compliantAmount} XAF.`);
  } else if (partial && out.statut === 'conforme') {
    out.statut = 'ecart_acceptable';
  }

  const comparison = partial ? compliantAmount : Number(order.montant_ttc || 0);
  const amountDifference = Number(invoice.montant_ttc || 0) - comparison;
  const rate = comparison > 0 ? Math.abs(amountDifference) / comparison : 0;
  out.ecart_montant = money(amountDifference);
  if (Math.abs(amountDifference) > 1) {
    const parameter = await tx.queryOne("SELECT valeur FROM parametres WHERE cle = 'rapprochement_seuil_pct'", []);
    const threshold = (Number.parseFloat(parameter?.valeur || '2') || 2) / 100;
    out.details.push(`Écart de montant ${money(amountDifference)} XAF (${(rate * 100).toFixed(2)} %).`);
    if (rate > threshold) out.statut = 'ecart_bloquant';
    else if (out.statut === 'conforme') out.statut = 'ecart_acceptable';
  }
  return out;
}

async function selectPosition(tx, requestedId) {
  if (requestedId) {
    const selected = await tx.queryOne('SELECT id FROM positions WHERE id = ? AND actif = 1', [Number(requestedId)]);
    if (selected) return selected;
  }
  return tx.queryOne(`
    SELECT id FROM positions
    WHERE actif = 1 AND type IN ('caisse','banque')
    ORDER BY ordre, id LIMIT 1
  `, []);
}

async function selectExpenseCategory(tx) {
  const preferred = await tx.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('depense','decaissement') AND COALESCE(actif,1) = 1
      AND (LOWER(nom) LIKE '%achat%' OR LOWER(nom) LIKE '%fournisseur%' OR LOWER(nom) LIKE '%charge%')
    ORDER BY id LIMIT 1
  `, []);
  return preferred || tx.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('depense','decaissement') AND COALESCE(actif,1) = 1
    ORDER BY id LIMIT 1
  `, []);
}

async function paySupplierInvoice({ invoiceId, payload, actorId, canOverride = false, dbc = db, failAfterOperation = false }) {
  if (!invoiceId) throw workflowError('Facture fournisseur obligatoire');
  if (!actorId) throw workflowError('Auteur obligatoire');
  const amount = money(payload?.montant);
  const paymentDate = payload?.date_paiement ? String(payload.date_paiement).slice(0, 10) : null;
  const overrideRequested = payload?.override_rapprochement === true || payload?.override_rapprochement === 'true';
  const overrideReason = String(payload?.motif_override || '').trim();
  if (amount <= 0) throw workflowError('Montant invalide');
  if (!paymentDate) throw workflowError('date_paiement requise');

  const result = await dbc.transaction(async (tx) => {
    const invoice = await tx.queryOne('SELECT * FROM factures_fournisseurs WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!invoice) throw workflowError('Facture fournisseur introuvable', 404);
    const supplier = await tx.queryOne('SELECT nom FROM fournisseurs WHERE id = ?', [invoice.fournisseur_id]);
    invoice.fournisseur_nom = supplier?.nom || 'Fournisseur';

    if (!['validee', 'partiellement_payee'].includes(invoice.statut)) {
      throw workflowError(`Paiement impossible — facture doit être validée (statut : ${invoice.statut})`);
    }

    if (['ecart_bloquant', 'conteste'].includes(invoice.rapprochement_statut)) {
      const code = invoice.rapprochement_statut === 'conteste' ? 'RAPPROCHEMENT_CONTESTE' : 'RAPPROCHEMENT_ECART_BLOQUANT';
      if (!overrideRequested) throw workflowError('Paiement bloqué par le rapprochement fournisseur.', 400, code, {
        ecart_montant: invoice.ecart_montant,
        ecart_quantite: invoice.ecart_quantite,
        ecart_motif: invoice.ecart_motif,
      });
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
        SET rapprochement_statut=?, ecart_montant=?, ecart_quantite=?, ecart_motif=?,
            rapprochement_at=NOW(), rapprochement_by=?, updated_at=NOW()
        WHERE id=?
      `, [reconciliation.statut, reconciliation.ecart_montant, reconciliation.ecart_quantite,
        reconciliation.details.join(' | '), actorId, invoice.id]);
      await audit(tx, invoice.id, 'RAPPROCHEMENT_AUTO', reconciliation, actorId);
      if (reconciliation.statut === 'ecart_bloquant') return { blocked: true, reconciliation };
    }

    const remaining = money(invoice.reste_a_payer);
    if (amount > remaining + 0.01) throw workflowError(`Montant (${amount}) supérieur au reste à payer (${remaining})`);
    const position = await selectPosition(tx, payload?.position_id);
    if (!position) throw workflowError('Aucune position de trésorerie active disponible pour le paiement fournisseur');
    const category = await selectExpenseCategory(tx);
    const mode = normalizeMode(payload?.mode_reglement);
    const reference = String(payload?.ref_paiement || `FF-${invoice.id}`).trim();

    const operation = await tx.execute(`
      INSERT INTO operations
        (date,libelle,tiers,montant,type_op,position_id,categorie_id,mode_reglement,ref_externe,
         statut,dec_statut,created_by,submitted_by,submitted_at,validated_by,validated_at,paid_by,paid_at)
      VALUES (?,?,?,?,'decaissement',?,?,?,?,'valide','paye',?,?,NOW(),?,NOW(),?,NOW())
    `, [paymentDate, `Paiement facture fournisseur ${invoice.numero_facture_fournisseur}`,
      invoice.fournisseur_nom, amount, position.id, category?.id || null, mode, reference,
      actorId, actorId, actorId, actorId]);
    const operationId = operation.insertId;
    if (!operationId) throw new Error('Création de l’opération de paiement sans identifiant');
    if (failAfterOperation) throw new Error('SUPPLIER_PAYMENT_TEST_FAILURE_AFTER_OPERATION');

    const newPaid = money(Number(invoice.montant_paye || 0) + amount);
    const newRemaining = money(Math.max(0, Number(invoice.montant_ttc || 0) - newPaid));
    const newStatus = newRemaining <= 0.01 ? 'payee' : 'partiellement_payee';
    await tx.execute(`
      UPDATE factures_fournisseurs
      SET montant_paye=?, reste_a_payer=?, statut=?, operation_id=?, updated_at=NOW()
      WHERE id=?
    `, [newPaid, newRemaining, newStatus, operationId, invoice.id]);
    await audit(tx, invoice.id, 'PAIEMENT', { montant: amount, nouveau_statut: newStatus, operation_id: operationId }, actorId);
    return { blocked: false, operationId, invoiceId: invoice.id, status: newStatus };
  });

  if (result.blocked) throw workflowError(
    'Paiement bloqué — rapprochement automatique : écart bloquant détecté.',
    400,
    'RAPPROCHEMENT_ECART_BLOQUANT',
    result.reconciliation,
  );

  return {
    ...result,
    invoice: await dbc.queryOne('SELECT * FROM factures_fournisseurs WHERE id = ?', [result.invoiceId]),
  };
}

module.exports = { calculateReconciliation, paySupplierInvoice };

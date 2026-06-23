'use strict';

const db = require('../db');
const {
  creerEntreeParapheurDansTransaction,
  notifierParapheurTarget,
} = require('./parapheur_async');

function workflowError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function audit(tx, recordId, action, details, userId) {
  await tx.execute(
    'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
    ['employes_avances', recordId, action, JSON.stringify(details || {}), userId || null],
  );
}

async function submitSalaryAdvance({
  employee,
  advanceId,
  actorId,
  autoApprove = false,
  dbc = db,
  failAfterStatus = false,
}) {
  if (!employee?.id) throw workflowError('Agent obligatoire');
  if (!advanceId) throw workflowError('Avance obligatoire');
  if (!actorId) throw workflowError('Auteur obligatoire');

  const result = await dbc.transaction(async (tx) => {
    const advance = await tx.queryOne(`
      SELECT * FROM employes_avances
      WHERE id = ? AND employe_id = ?
      FOR UPDATE
    `, [advanceId, employee.id]);
    if (!advance) throw workflowError('Avance introuvable', 404);
    if (advance.statut_workflow !== 'brouillon') {
      throw workflowError(`Statut workflow "${advance.statut_workflow}" — soumission impossible`);
    }

    if (autoApprove) {
      await tx.execute(`
        UPDATE employes_avances
        SET statut_workflow = 'approuve_dg', approuve_par = ?,
            approuve_at = NOW(), updated_at = NOW()
        WHERE id = ?
      `, [actorId, advance.id]);
      if (failAfterStatus) throw new Error('ADVANCE_TEST_FAILURE_AFTER_STATUS');
      await audit(tx, advance.id, 'soumettre_auto_approuver', { approuve_par: actorId }, actorId);
      return {
        statut_workflow: 'approuve_dg',
        auto_approved: true,
        parapheurId: null,
        title: null,
      };
    }

    await tx.execute(`
      UPDATE employes_avances
      SET statut_workflow = 'soumis', updated_at = NOW()
      WHERE id = ?
    `, [advance.id]);
    if (failAfterStatus) throw new Error('ADVANCE_TEST_FAILURE_AFTER_STATUS');

    const title = `Avance salaire — ${employee.nom} ${employee.prenom || ''} (${new Intl.NumberFormat('fr-FR').format(advance.montant)} XAF)`;
    const parapheurId = await creerEntreeParapheurDansTransaction(tx, {
      type: 'avance_salaire',
      titre: title,
      initiateur_id: actorId,
      montant: advance.montant,
      ref_source_table: 'employes_avances',
      ref_source_id: advance.id,
      priorite: 'normal',
      required: true,
    });

    await audit(tx, advance.id, 'soumettre', {
      parapheur_id: parapheurId,
      required_parapheur: true,
    }, actorId);

    return {
      statut_workflow: 'soumis',
      auto_approved: false,
      parapheurId,
      title,
    };
  });

  if (result.title) await notifierParapheurTarget(result.title, dbc);
  return result;
}

module.exports = { submitSalaryAdvance };

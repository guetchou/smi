'use strict';

const db = require('../db');

function workflowError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function runAtomic(dbc, work) {
  return dbc === db ? dbc.transaction(work) : work(dbc);
}

async function getParam(dbc, key, fallback) {
  const row = await dbc.queryOne('SELECT valeur FROM parametres WHERE cle = ?', [key]);
  return row?.valeur ?? fallback;
}

async function getLeave(dbc, employeeId, leaveId) {
  return dbc.queryOne('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?', [leaveId, employeeId]);
}

async function recomputeLeaveCounters(dbc, employeeId, now = new Date()) {
  const employee = await dbc.queryOne(
    'SELECT id, date_embauche, conges_report_n1, conges_maladie_droit FROM employes WHERE id = ?',
    [employeeId],
  );
  if (!employee) throw workflowError('Agent introuvable', 404);

  const rate = Number(await getParam(dbc, 'conges_jours_par_mois', '2.5')) || 2.5;
  let acquired = 0;
  if (employee.date_embauche) {
    const hiredAt = new Date(employee.date_embauche);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const reference = hiredAt > yearStart ? hiredAt : yearStart;
    const months = Math.min(12, Math.max(0,
      (now.getFullYear() - reference.getFullYear()) * 12
      + (now.getMonth() - reference.getMonth())
      + (now.getDate() >= reference.getDate() ? 1 : 0),
    ));
    acquired = Math.min(30, Math.round(months * rate * 2) / 2);
  }

  const year = String(now.getFullYear());
  const annual = await dbc.queryOne(`
    SELECT COALESCE(SUM(nb_jours), 0) AS pris
    FROM employes_conges
    WHERE employe_id = ? AND type_conge = 'annuel'
      AND statut IN ('approuve','termine')
      AND SUBSTR(CAST(date_debut AS CHAR), 1, 4) = ?
  `, [employeeId, year]);
  const sick = await dbc.queryOne(`
    SELECT COALESCE(SUM(nb_jours), 0) AS pris
    FROM employes_conges
    WHERE employe_id = ? AND type_conge = 'maladie'
      AND statut IN ('approuve','termine')
      AND SUBSTR(CAST(date_debut AS CHAR), 1, 4) = ?
  `, [employeeId, year]);

  const annualTaken = Number(annual?.pris || 0);
  const sickTaken = Number(sick?.pris || 0);
  const annualBalance = Math.round((acquired + Number(employee.conges_report_n1 || 0) - annualTaken) * 10) / 10;
  const sickRight = Number(employee.conges_maladie_droit || 15);

  await dbc.execute(`
    UPDATE employes
    SET conges_acquis_annuel = ?, conges_pris_annuel = ?, conges_solde_annuel = ?,
        conges_maladie_pris = ?, conges_maladie_solde = ?, updated_at = NOW()
    WHERE id = ?
  `, [acquired, annualTaken, annualBalance, sickTaken, Math.max(0, sickRight - sickTaken), employeeId]);

  return { acquis: acquired, pris: annualTaken, solde: annualBalance, maladie_pris: sickTaken };
}

async function validateBySupervisor({ employeeId, leaveId, actor, notes = '', dbc = db }) {
  return runAtomic(dbc, async (tx) => {
    const employee = await tx.queryOne('SELECT id, superieur_id FROM employes WHERE id = ?', [employeeId]);
    if (!employee) throw workflowError('Agent introuvable', 404);
    const leave = await getLeave(tx, employeeId, leaveId);
    if (!leave) throw workflowError('Congé introuvable', 404);
    if (leave.statut !== 'demande') throw workflowError(`Transition interdite : ${leave.statut} → valide_sup`, 409);

    const roles = new Set([actor?.role, ...(Array.isArray(actor?.roles) ? actor.roles : [])].filter(Boolean));
    const override = roles.has('admin') || roles.has('dg');
    const isDirectSupervisor = Number(actor?.employe_id || 0) === Number(employee.superieur_id || 0);
    if (!override && !isDirectSupervisor) {
      throw workflowError('Seul le supérieur hiérarchique réel, le DG ou un administrateur peut valider cette étape', 403);
    }

    await tx.execute(`
      UPDATE employes_conges
      SET statut='valide_sup', valide_sup_par=?, valide_sup_at=NOW(),
          valide_sup_notes=?, updated_by=?, updated_at=NOW()
      WHERE id=? AND employe_id=? AND statut='demande'
    `, [actor.id, String(notes || '').trim() || null, actor.id, leaveId, employeeId]);

    return { statut: 'valide_sup' };
  });
}

async function approveLeave({ employeeId, leaveId, actorId, dbc = db }) {
  return runAtomic(dbc, async (tx) => {
    const leave = await getLeave(tx, employeeId, leaveId);
    if (!leave) throw workflowError('Congé introuvable', 404);

    const workflowSup = String(await getParam(tx, 'conges_workflow_sup', '1')) === '1';
    const allowed = workflowSup ? ['valide_sup'] : ['demande', 'valide_sup'];
    if (!allowed.includes(leave.statut)) {
      throw workflowError(`Transition interdite : ${leave.statut} → approuve`, 409, { workflow_superieur_requis: workflowSup });
    }

    const overlap = await tx.queryOne(`
      SELECT id FROM employes_conges
      WHERE employe_id=? AND id<>? AND statut='approuve'
        AND date_debut <= ? AND date_fin >= ?
      LIMIT 1
    `, [employeeId, leaveId, leave.date_fin, leave.date_debut]);
    if (overlap) throw workflowError('Chevauchement avec un congé déjà approuvé', 409, { overlap_id: overlap.id });

    const changed = await tx.execute(`
      UPDATE employes_conges
      SET statut='approuve', approuve_par=?, approuve_at=NOW(), updated_by=?, updated_at=NOW()
      WHERE id=? AND employe_id=? AND statut IN ('demande','valide_sup')
    `, [actorId, actorId, leaveId, employeeId]);
    if (Number(changed?.affectedRows || 0) < 1) throw workflowError('La demande a changé pendant la décision', 409);

    const counters = await recomputeLeaveCounters(tx, employeeId);
    return { statut: 'approuve', counters };
  });
}

async function rejectLeave({ employeeId, leaveId, actorId, reason, dbc = db }) {
  const motif = String(reason || '').trim();
  if (!motif) throw workflowError('Motif de refus obligatoire');
  return runAtomic(dbc, async (tx) => {
    const leave = await getLeave(tx, employeeId, leaveId);
    if (!leave) throw workflowError('Congé introuvable', 404);
    if (!['demande', 'valide_sup'].includes(leave.statut)) {
      throw workflowError(`Transition interdite : ${leave.statut} → refuse`, 409);
    }
    const changed = await tx.execute(`
      UPDATE employes_conges
      SET statut='refuse', refuse_par=?, refuse_at=NOW(), refuse_motif=?, updated_by=?, updated_at=NOW()
      WHERE id=? AND employe_id=? AND statut IN ('demande','valide_sup')
    `, [actorId, motif, actorId, leaveId, employeeId]);
    if (Number(changed?.affectedRows || 0) < 1) throw workflowError('La demande a changé pendant la décision', 409);
    return { statut: 'refuse' };
  });
}

async function cancelLeave({ employeeId, leaveId, actorId, reason, dbc = db }) {
  const motif = String(reason || '').trim();
  if (!motif) throw workflowError("Motif d'annulation obligatoire");
  return runAtomic(dbc, async (tx) => {
    const leave = await getLeave(tx, employeeId, leaveId);
    if (!leave) throw workflowError('Congé introuvable', 404);
    if (['annule', 'termine'].includes(leave.statut)) {
      throw workflowError(`Transition interdite : ${leave.statut} → annule`, 409);
    }
    const changed = await tx.execute(`
      UPDATE employes_conges
      SET statut='annule', annule_statut=?, annule_at=NOW(), annule_by=?, annule_motif=?,
          updated_by=?, updated_at=NOW()
      WHERE id=? AND employe_id=? AND statut NOT IN ('annule','termine')
    `, [leave.statut, actorId, motif, actorId, leaveId, employeeId]);
    if (Number(changed?.affectedRows || 0) < 1) throw workflowError('La demande a changé pendant l’annulation', 409);
    const counters = await recomputeLeaveCounters(tx, employeeId);
    return { statut: 'annule', counters };
  });
}

async function finishLeave({ employeeId, leaveId, actorId, dbc = db }) {
  return runAtomic(dbc, async (tx) => {
    const leave = await getLeave(tx, employeeId, leaveId);
    if (!leave) throw workflowError('Congé introuvable', 404);
    if (leave.statut !== 'approuve') throw workflowError(`Transition interdite : ${leave.statut} → termine`, 409);
    const changed = await tx.execute(`
      UPDATE employes_conges SET statut='termine', updated_by=?, updated_at=NOW()
      WHERE id=? AND employe_id=? AND statut='approuve'
    `, [actorId, leaveId, employeeId]);
    if (Number(changed?.affectedRows || 0) < 1) throw workflowError('La demande a changé pendant la clôture', 409);
    const counters = await recomputeLeaveCounters(tx, employeeId);
    return { statut: 'termine', counters };
  });
}

module.exports = {
  approveLeave,
  cancelLeave,
  finishLeave,
  recomputeLeaveCounters,
  rejectLeave,
  validateBySupervisor,
  workflowError,
};

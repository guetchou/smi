'use strict';

const db = require('../db');
const {
  creerEntreeParapheurDansTransaction,
  notifierParapheurTarget,
} = require('./parapheur_async');

const CONGE_TYPES = ['annuel', 'maladie', 'maternite', 'paternite', 'sans_solde', 'autre'];
const IS_MYSQL_DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql';

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateOrNull(value) {
  return value ? String(value).slice(0, 10) : null;
}

function diffDaysInclusive(start, end) {
  const first = new Date(start);
  const last = new Date(end);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  return Math.max(1, Math.round((last - first) / 86400000) + 1);
}

function workflowError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function yearFilterSql(column) {
  if (IS_MYSQL_DRIVER && column === 'date_debut') return 'YEAR(date_debut) = ?';
  return IS_MYSQL_DRIVER
    ? `YEAR(${column}) = ?`
    : `SUBSTR(CAST(${column} AS TEXT), 1, 4) = ?`;
}

function lockForUpdate() {
  return IS_MYSQL_DRIVER ? ' FOR UPDATE' : '';
}

async function getLeaveBalance(employeeId, dbc = db, now = new Date()) {
  const employee = await dbc.queryOne(`
    SELECT date_embauche, conges_report_n1, conges_maladie_droit,
           conges_maladie_pris, conges_maladie_solde
    FROM employes WHERE id = ?
  `, [employeeId]);
  if (!employee) return null;

  const parameter = await dbc.queryOne(
    'SELECT valeur FROM parametres WHERE cle = ?',
    ['conges_jours_par_mois'],
  );
  const rate = parseFloat(parameter?.valeur || '2.5') || 2.5;
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

  const totals = await dbc.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN statut IN ('approuve','termine') THEN nb_jours ELSE 0 END), 0) AS pris,
      COALESCE(SUM(CASE WHEN statut IN ('demande','valide_sup') THEN nb_jours ELSE 0 END), 0) AS en_attente
    FROM employes_conges
    WHERE employe_id = ? AND type_conge = 'annuel' AND ${yearFilterSql('date_debut')}
  `, [employeeId, String(now.getFullYear())]);

  const carried = num(employee.conges_report_n1, 0);
  const taken = num(totals?.pris, 0);
  const pending = num(totals?.en_attente, 0);
  return {
    acquis: acquired,
    pris: taken,
    report: carried,
    en_attente: pending,
    solde: Math.round((acquired + carried - taken) * 10) / 10,
    solde_apres_attente: Math.round((acquired + carried - taken - pending) * 10) / 10,
    maladie: {
      droit: num(employee.conges_maladie_droit, 15),
      pris: num(employee.conges_maladie_pris, 0),
      solde: num(employee.conges_maladie_solde, 15),
    },
  };
}

async function createLeaveRequest({ employee, payload, actorId, isAdmin = false, dbc = db, failAfterLeave = false }) {
  if (!employee?.id) throw workflowError('Agent obligatoire');
  if (!actorId) throw workflowError('Auteur obligatoire');

  let leaveType = text(payload?.type_conge, 'annuel') || 'annuel';
  if (!CONGE_TYPES.includes(leaveType)) {
    throw workflowError(`type_conge invalide. Valeurs : ${CONGE_TYPES.join(', ')}`);
  }
  const startDate = dateOrNull(payload?.date_debut);
  const endDate = dateOrNull(payload?.date_fin);
  if (!startDate || !endDate) throw workflowError('Dates requises');
  if (endDate < startDate) throw workflowError('Date fin antérieure à date début');
  const days = diffDaysInclusive(startDate, endDate);
  if (!days) throw workflowError('Dates invalides');

  const reason = text(payload?.motif);
  const notes = text(payload?.notes);
  const force = payload?.force_creation === true || payload?.force_creation === 'true';

  const result = await dbc.transaction(async (tx) => {
    const overlap = await tx.queryOne(`
      SELECT id, date_debut, date_fin FROM employes_conges
      WHERE employe_id = ? AND statut IN ('demande','valide_sup','approuve')
        AND date_debut <= ? AND date_fin >= ?
      LIMIT 1${lockForUpdate()}
    `, [employee.id, endDate, startDate]);
    if (overlap) {
      throw workflowError(
        `Chevauchement avec un congé existant du ${overlap.date_debut} au ${overlap.date_fin}`,
        409,
        { overlap_id: overlap.id },
      );
    }

    const balance = await getLeaveBalance(employee.id, tx);
    if (leaveType === 'annuel' && balance && days > balance.solde_apres_attente && !force && !isAdmin) {
      throw workflowError(`Solde insuffisant : ${balance.solde_apres_attente} jour(s) disponible(s) après demandes en attente`);
    }
    if (leaveType === 'maladie' && balance && days > balance.maladie.solde && !force && !isAdmin) {
      throw workflowError(`Solde maladie insuffisant : ${balance.maladie.solde} j disponible(s), ${days} demandé(s)`);
    }
    if (leaveType === 'maladie' && balance && days > balance.maladie.solde && force) {
      leaveType = 'sans_solde';
    }

    const inserted = await tx.execute(`
      INSERT INTO employes_conges
        (employe_id, type_conge, date_debut, date_fin, nb_jours, motif, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee.id, leaveType, startDate, endDate, days, reason, notes, actorId]);
    const leaveId = inserted.insertId;
    if (!leaveId) throw new Error('Création du congé sans identifiant');
    if (failAfterLeave) throw new Error('LEAVE_TEST_FAILURE_AFTER_INSERT');

    const title = `Congé ${leaveType} — ${employee.nom} ${employee.prenom || ''} (${startDate} → ${endDate}, ${days}j)`;
    const parapheurId = await creerEntreeParapheurDansTransaction(tx, {
      type: 'conge', titre: title, initiateur_id: actorId,
      ref_source_table: 'employes_conges', ref_source_id: leaveId,
      priorite: leaveType === 'maladie' ? 'urgent' : 'normal', required: true,
    });
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['employes_conges', leaveId, 'create', JSON.stringify({ type_conge: leaveType, date_debut: startDate, date_fin: endDate, nb_jours: days, parapheur_id: parapheurId, required_parapheur: true }), actorId],
    );
    return { id: leaveId, parapheurId, title, type_conge: leaveType, date_debut: startDate, date_fin: endDate, nb_jours: days, motif: reason, notes };
  });

  await notifierParapheurTarget(result.title, dbc);
  return result;
}

module.exports = { CONGE_TYPES, createLeaveRequest, diffDaysInclusive, getLeaveBalance };

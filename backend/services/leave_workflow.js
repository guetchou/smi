'use strict';

const db = require('../db');
const {
  creerEntreeParapheurDansTransaction,
  notifierParapheurTarget,
} = require('./parapheur_async');
const {
  DEFAULT_TIMEZONE,
  DEFAULT_WEEKEND_DAYS,
  calculateLeaveDays,
  normalizeMode,
  normalizeWeekendDays,
} = require('./leave_calendar');
const {
  cleanupPersistedCertificate,
  getMedicalCertificatePolicy,
  persistMedicalCertificate,
  prepareMedicalCertificate,
} = require('./leave_medical_certificate');

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
  const result = calculateLeaveDays({
    startDate: start,
    endDate: end,
    mode: 'calendaires',
    timezone: DEFAULT_TIMEZONE,
  });
  return result ? result.calendarDays : null;
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

async function getParam(dbc, key, fallback) {
  const row = await dbc.queryOne('SELECT valeur FROM parametres WHERE cle = ?', [key]);
  return row?.valeur ?? fallback;
}

async function getLeaveCalculationSettings(dbc, leaveType) {
  const modeByType = {
    annuel: 'ouvres',
    maladie: 'calendaires',
    maternite: 'calendaires',
    paternite: 'calendaires',
    sans_solde: 'ouvres',
    autre: 'ouvres',
  };
  const mode = normalizeMode(await getParam(
    dbc,
    `conges_calcul_${leaveType}`,
    modeByType[leaveType] || 'ouvres',
  ));
  const weekendDays = normalizeWeekendDays(await getParam(
    dbc,
    'conges_weekend',
    DEFAULT_WEEKEND_DAYS.join(','),
  ));
  const timezone = String(await getParam(dbc, 'conges_timezone', DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  const holidays = String(await getParam(dbc, 'conges_jours_feries', '') || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return { mode, weekendDays, timezone, holidays };
}

async function calculateConfiguredLeaveDays(dbc, leaveType, startDate, endDate) {
  const settings = await getLeaveCalculationSettings(dbc, leaveType);
  const result = calculateLeaveDays({
    startDate,
    endDate,
    mode: settings.mode,
    holidays: settings.holidays,
    weekendDays: settings.weekendDays,
    timezone: settings.timezone,
  });
  if (!result) throw workflowError('Dates invalides');
  return {
    days: result.total,
    details: {
      calculation_mode: settings.mode,
      calendar_days: result.calendarDays,
      excluded_weekends: result.excludedWeekends,
      excluded_holidays: result.excludedHolidays,
      effective_days: result.total,
      timezone: settings.timezone,
    },
  };
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

  const reason = text(payload?.motif);
  const notes = text(payload?.notes);
  const force = payload?.force_creation === true || payload?.force_creation === 'true';
  let persistedCertificate = null;

  let result;
  try {
    result = await dbc.transaction(async (tx) => {
    let calculation = await calculateConfiguredLeaveDays(tx, leaveType, startDate, endDate);
    let days = calculation.days;
    if (days < 1) throw workflowError('Aucun jour de congé effectif sur cette période');

    const certificatePolicy = await getMedicalCertificatePolicy(tx);
    const certificateRequired = leaveType === 'maladie'
      && certificatePolicy.required
      && days >= certificatePolicy.thresholdDays;
    const certificate = prepareMedicalCertificate(
      payload?.certificat_medical || payload?.medical_certificate || null,
      certificatePolicy,
    );
    if (certificateRequired && !certificate) {
      throw workflowError(
        `Certificat médical obligatoire à partir de ${certificatePolicy.thresholdDays} jour(s)`,
        400,
        { certificat_medical_obligatoire: true },
      );
    }

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
      calculation = await calculateConfiguredLeaveDays(tx, leaveType, startDate, endDate);
      days = calculation.days;
      if (days < 1) throw workflowError('Aucun jour de congé effectif sur cette période');
    }

    const inserted = await tx.execute(`
      INSERT INTO employes_conges
        (employe_id, type_conge, date_debut, date_fin, nb_jours, motif, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee.id, leaveType, startDate, endDate, days, reason, notes, actorId]);
    const leaveId = inserted.insertId;
    if (!leaveId) throw new Error('Création du congé sans identifiant');

    if (certificate) {
      persistedCertificate = await persistMedicalCertificate(tx, {
        leaveId,
        actorId,
        certificate,
      });
    }
    if (failAfterLeave) throw new Error('LEAVE_TEST_FAILURE_AFTER_INSERT');

    const title = `Congé ${leaveType} — ${employee.nom} ${employee.prenom || ''} (${startDate} → ${endDate}, ${days}j)`;
    const parapheurId = await creerEntreeParapheurDansTransaction(tx, {
      type: 'conge', titre: title, initiateur_id: actorId,
      ref_source_table: 'employes_conges', ref_source_id: leaveId,
      priorite: leaveType === 'maladie' ? 'urgent' : 'normal', required: true,
    });
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['employes_conges', leaveId, 'create', JSON.stringify({
        type_conge: leaveType,
        date_debut: startDate,
        date_fin: endDate,
        nb_jours: days,
        leave_day_calculation: calculation.details,
        parapheur_id: parapheurId,
        required_parapheur: true,
      }), actorId],
    );
    return {
      id: leaveId,
      parapheurId,
      title,
      type_conge: leaveType,
      date_debut: startDate,
      date_fin: endDate,
      nb_jours: days,
      motif: reason,
      notes,
      certificat_medical: persistedCertificate
        ? { id: persistedCertificate.id, sha256: persistedCertificate.sha256, version: persistedCertificate.version }
        : null,
    };
    });
  } catch (error) {
    cleanupPersistedCertificate(persistedCertificate);
    throw error;
  }

  await notifierParapheurTarget(result.title, dbc);
  return result;
}

module.exports = {
  CONGE_TYPES,
  createLeaveRequest,
  diffDaysInclusive,
  getLeaveBalance,
  getLeaveCalculationSettings,
};

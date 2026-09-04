/**
 * ROUTES OPÉRATIONS — Convention OHADA
 * Encaissement | Décaissement | Virement interne
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { sendMail } = require('../services/email');
const { hasRole } = require('./auth');
const { creerNotification, declencherAlerte, resoudreAlerte, evaluerAlerteSoldes } = require('../services/notif');
const { can } = require('../services/permissions');
const { creerEntreeParapheur } = require('../services/parapheur');
const { attemptAutomaticAccountingForOperation } = require('../services/accounting');
const { buildOperationView } = require('../services/finance-operations');

// Rôles séparés : saisie/soumission, ordonnancement DG, exécution paiement.
const FINANCE_ROLES = ['admin', 'caissier', 'finance'];
const DEC_APPROVAL_ROLES = ['admin', 'dg', 'finance'];
// Rôles autorisés à créer un encaissement officiel (Q1 — SaaS: configurable via paramètre roles_create_encaissement)
const ENC_CREATE_ROLES = ['admin', 'caissier', 'finance', 'dg'];
// Rôles autorisés à annuler un décaissement avant paiement (Q2)
const DEC_CANCEL_ROLES = ['admin', 'finance', 'dg'];
const WRITE_ROLES = ['admin', 'caissier', 'finance', 'rh', 'dg', 'assistante_direction', 'delegue'];

// Cache des colonnes de la table operations (chargé une seule fois au démarrage)
let operationColumns = new Set();
(async () => {
  try {
    const cols = await db.query('SELECT COLUMN_NAME as name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['operations']);
    operationColumns = new Set(cols.map(c => c.name));
  } catch (_) {
    try {
      const cols = await db.query('PRAGMA table_info(operations)');
      operationColumns = new Set(cols.map(c => c.name));
    } catch (_) {}
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────

function safe(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTypeOp(value) {
  if (value === 'recette') return 'encaissement';
  if (value === 'depense') return 'decaissement';
  return value;
}

function normalizeMode(value) {
  if (value === 'virement') return 'virement_bancaire';
  if (value === 'carte') return 'autres';
  return value || 'especes';
}

function serializeOperation(op) {
  if (!op) return op;
  const montant = safe(op.montant);
  return buildOperationView({
    ...op,
    detail: op.libelle,
    n_piece: op.num_piece,
    recette: op.type_op === 'encaissement' ? montant : 0,
    depense: op.type_op === 'decaissement' ? montant : 0,
    solde: safe(op.solde_position),
    mode_paiement: op.mode_reglement === 'virement_bancaire' ? 'virement' : op.mode_reglement,
    couleur: op.cat_couleur || op.couleur || op.pos_couleur,
  });
}

function hasOperationColumn(column) {
  return operationColumns.has(column);
}

function appendOptionalOperationValue(columns, values, column, value) {
  if (!hasOperationColumn(column)) return;
  columns.push(column);
  values.push(value);
}

function flowStatusesForOperation(typeOp, statut) {
  const isTreasurySynced = statut === 'valide' && ['encaissement', 'virement'].includes(typeOp);
  return {
    treasury_status: statut === 'annule' ? 'cancelled' : isTreasurySynced ? 'synced' : 'pending',
    accounting_status: statut === 'annule' ? 'cancelled' : 'pending',
    budget_status: statut === 'annule' ? 'cancelled' : 'pending',
    allocation_status: statut === 'annule' ? 'cancelled' : 'pending',
  };
}

const FLOW_SYNC_ERROR_TYPES = {
  accounting_status: {
    type: 'ACCOUNTING_SYNC_PENDING',
    message: 'Écriture comptable non générée : règle de ventilation ou validation comptable à compléter',
  },
  budget_status: {
    type: 'BUDGET_SYNC_PENDING',
    message: 'Impact budget non confirmé : ligne budgétaire ou imputation à compléter',
  },
  allocation_status: {
    type: 'ALLOCATION_SYNC_PENDING',
    message: 'Affectation métier non confirmée : facture, dette, avance ou charge à rattacher',
  },
};

async function ensureSyncError({ sourceRecordId, errorType, errorMessage, technicalDetails, userId = null }, dbc = db) {
  const existing = await dbc.queryOne(`
    SELECT id FROM sync_errors
    WHERE source_module = 'operations'
      AND source_record_id = ?
      AND error_type = ?
      AND status = 'open'
    LIMIT 1
  `, [sourceRecordId, errorType]);
  if (existing) return existing.id;

  const result = await dbc.execute(`
    INSERT INTO sync_errors
      (source_module, source_record_id, error_type, error_message, technical_details, status, created_at, updated_at)
    VALUES
      ('operations', ?, ?, ?, ?, 'open', NOW(), NOW())
  `, [sourceRecordId, errorType, errorMessage, technicalDetails ? JSON.stringify(technicalDetails) : null]);

  try {
    await auditDec(sourceRecordId, 'sync_error_opened', { errorType, userId }, userId);
  } catch (_) {}

  return result.insertId;
}

// Une operation annulee n'a plus rien a ventiler : ses anomalies ouvertes
// n'attendent plus personne. Sans cela elles restent au tableau indefiniment.
async function resolveOperationSyncErrors(operationId, userId = null, dbc = db) {
  const r = await dbc.execute(`
    UPDATE sync_errors
    SET status = 'resolved', resolved_by = ?, resolved_at = NOW(), updated_at = NOW()
    WHERE source_module = 'operations'
      AND source_record_id = ?
      AND status = 'open'
  `, [userId || null, operationId]);
  return r?.affectedRows ?? 0;
}

async function ensureOperationSyncErrors(operation, userId = null, dbc = db) {
  if (!operation || operation.statut !== 'valide') return;
  for (const [statusColumn, config] of Object.entries(FLOW_SYNC_ERROR_TYPES)) {
    if ((operation[statusColumn] || 'pending') !== 'pending') continue;
    await ensureSyncError({
      sourceRecordId: operation.id,
      errorType: config.type,
      errorMessage: config.message,
      technicalDetails: {
        type_op: operation.type_op,
        num_piece: operation.num_piece || null,
        status_column: statusColumn,
      },
      userId,
    }, dbc);
  }
}

async function closeOperationSyncErrors(operationId, status = 'ignored', userId = null, dbc = db) {
  await dbc.execute(`
    UPDATE sync_errors
    SET status = ?, resolved_by = ?, resolved_at = NOW(), updated_at = NOW()
    WHERE source_module = 'operations'
      AND source_record_id = ?
      AND status = 'open'
  `, [status, userId || null, operationId]);
}

async function canPayCashOut(user) {
  return await can(user, 'cash.out.pay') || hasRole(user, ...FINANCE_ROLES);
}

async function hasActiveDelegation(user) {
  if (!hasRole(user, 'delegue')) return false;
  const row = await db.queryOne(`
    SELECT id FROM delegations_approbation
    WHERE delegue_id = ? AND actif = 1
      AND date_debut <= CURDATE()
      AND (date_fin IS NULL OR date_fin >= CURDATE())
    LIMIT 1
  `, [user.id]);
  return !!row;
}

async function canApproveDec(user) {
  return await can(user, 'cash.out.validate') || hasRole(user, ...DEC_APPROVAL_ROLES) || await hasActiveDelegation(user);
}

async function canWrite(user) {
  return await can(user, 'cash.out.create') || hasRole(user, ...WRITE_ROLES);
}

function legacyValues(op) {
  const montant = safe(op.montant);
  return {
    detail: op.libelle,
    n_piece: op.num_piece,
    recette: op.type_op === 'encaissement' ? montant : 0,
    depense: op.type_op === 'decaissement' ? montant : 0,
    solde: safe(op.solde_position),
    mode_paiement: op.mode_reglement === 'virement_bancaire' ? 'virement' : op.mode_reglement,
  };
}

// Les listes deroulantes du formulaire de decaissement ne produisent que ces
// valeurs. L'import CSV, lui, lit une colonne de tableur saisie a la main : on
// range une valeur inconnue dans « autre » plutot que de la perdre en silence
// ou de refuser la ligne entiere.
const TYPES_BENEFICIAIRE = new Set(['fournisseur', 'employe', 'client', 'administration', 'organisme_social', 'prestataire', 'associe', 'autre']);
const TYPES_PIECE = new Set(['facture', 'recu', 'note_frais', 'bon_caisse', 'cheque', 'bordereau', 'avis_imposition', 'bulletin_paie', 'contrat', 'autre']);

function valeurDeListe(valeur, connues) {
  const brut = String(valeur ?? '').trim();
  if (!brut) return null;
  const normalise = brut
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return connues.has(normalise) ? normalise : 'autre';
}

function normalizeOperationInput(body, current = {}) {
  const recette = Number(body.recette || 0);
  const depense = Number(body.depense || 0);
  const legacyMontant = recette > 0 ? recette : depense > 0 ? depense : undefined;
  const typeOp = normalizeTypeOp(body.type_op || (recette > 0 ? 'encaissement' : depense > 0 ? 'decaissement' : current.type_op));

  return {
    date: body.date || current.date,
    num_piece: body.num_piece ?? body.n_piece ?? current.num_piece,
    libelle: body.libelle ?? body.detail ?? current.libelle,
    tiers: body.tiers ?? current.tiers,
    montant: Number(body.montant ?? legacyMontant ?? current.montant ?? 0),
    type_op: typeOp,
    position_id: Number(body.position_id || current.position_id || 1),
    position_source_id: body.position_source_id || current.position_source_id || null,
    categorie_id: body.categorie_id || current.categorie_id || null,
    mode_reglement: normalizeMode(body.mode_reglement || body.mode_paiement || current.mode_reglement),
    ref_externe: body.ref_externe ?? current.ref_externe,
    piece_justificative: body.piece_justificative ?? current.piece_justificative,
    type_piece: valeurDeListe(body.type_piece ?? current.type_piece, TYPES_PIECE),
    decharge_signee: body.decharge_signee ?? current.decharge_signee ?? 0,
    beneficiaire_type: valeurDeListe(body.beneficiaire_type ?? current.beneficiaire_type, TYPES_BENEFICIAIRE),
    employe_id: body.employe_id || current.employe_id || null,
  };
}

/** Vérifie si une date tombe dans une période clôturée */
async function isPeriodeCloturee(date) {
  if (!date) return false;
  const d = new Date(date);
  const annee = d.getFullYear();
  const mois  = d.getMonth() + 1;
  const row = await db.queryOne(`SELECT 1 AS found FROM periodes_cloturees WHERE annee=? AND mois=?`, [annee, mois]);
  return !!row;
}

async function hasPostedAccountingEntry(operationId, dbc = db) {
  const row = await dbc.queryOne(`
    SELECT id, entry_no
    FROM accounting_entries
    WHERE source_module IN ('cash_receipt', 'cash_disbursement', 'internal_transfer')
      AND source_record_id = ?
      AND status = 'posted'
    LIMIT 1
  `, [operationId]);
  return row || null;
}

async function getActivePosition(id) {
  if (!id) return null;
  return db.queryOne('SELECT id, code, libelle, type, actif FROM positions WHERE id = ? AND actif = 1', [Number(id)]);
}

function modeRequiresExternalReference(mode) {
  return ['cheque', 'virement_bancaire', 'mobile_money'].includes(normalizeMode(mode));
}

async function validateExternalReference({ type_op, mode_reglement, ref_externe, excludeId = null }) {
  if (!modeRequiresExternalReference(mode_reglement)) return null;
  const ref = String(ref_externe || '').trim();
  if (!ref) {
    return 'Référence externe obligatoire pour chèque, virement bancaire ou mobile money';
  }

  let sql = `
    SELECT id, num_piece FROM operations
    WHERE statut != 'annule'
      AND type_op = ?
      AND mode_reglement = ?
      AND LOWER(TRIM(ref_externe)) = LOWER(TRIM(?))
  `;
  const params = [type_op, normalizeMode(mode_reglement), ref];
  if (excludeId) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  sql += ' LIMIT 1';
  const duplicate = await db.queryOne(sql, params);
  if (duplicate) {
    return `Référence externe déjà utilisée sur l'opération ${duplicate.num_piece || '#' + duplicate.id}`;
  }
  return null;
}

async function validateInternalTransfer({ position_id, position_source_id, montant }) {
  const source = await getActivePosition(position_source_id);
  if (!source) return { error: 'Position source inactive ou introuvable' };

  const destination = await getActivePosition(position_id);
  if (!destination) return { error: 'Position destination inactive ou introuvable' };

  if (Number(position_id) === Number(position_source_id)) {
    return { error: 'Source et destination doivent être différentes' };
  }

  const soldeSource = await getSoldePosition(Number(position_source_id));
  if (safe(soldeSource) < safe(montant)) {
    return {
      error: `Solde insuffisant sur ${source.code || source.libelle} — disponible ${new Intl.NumberFormat('fr-FR').format(safe(soldeSource))} XAF`
    };
  }

  return { source, destination, soldeSource };
}

/** Calcule le solde d'une position à un instant donné.
 * Q5 — Les virements internes (type_op='virement') impactent le solde de trésorerie
 * mais ne sont PAS comptés comme encaissements dans les KPIs.
 * Le solde lui-même doit inclure les virements pour rester cohérent (entrée/sortie réelles de fonds). */
async function getSoldePosition(positionId, beforeId = null) {
  const pos = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [positionId]);
  if (!pos) return 0;

  let sql = `SELECT
    COALESCE(SUM(CASE
      WHEN type_op = 'encaissement' AND position_id = ?                THEN montant
      WHEN type_op = 'virement'     AND position_id = ?                THEN montant
      WHEN type_op = 'decaissement' AND position_id = ?                THEN -montant
      WHEN type_op = 'virement'     AND position_source_id = ?         THEN -montant
      ELSE 0 END), 0) as delta
    FROM operations WHERE statut = 'valide'`;
  const params = [positionId, positionId, positionId, positionId];
  if (beforeId) { sql += ' AND id < ?'; params.push(beforeId); }

  const row = await db.queryOne(sql, params);
  return safe(pos.solde_initial) + safe(row.delta);
}

/** Recalcule et stocke solde_position sur toutes les opérations.
 *  Avant : 1 SELECT + N queries (ops/pos) + N*M UPDATEs individuels.
 *  Après : 1 SELECT jointé + 1 batch UPDATE par tranche de 500 lignes.  */
async function recalculateSoldes() {
  // Charge toutes les positions actives + leurs opérations validées en un seul aller-retour.
  const rows = await db.query(`
    SELECT p.id AS pos_id, p.solde_initial,
           o.id AS op_id, o.type_op, o.montant, o.position_id, o.position_source_id
    FROM positions p
    LEFT JOIN operations o
      ON (o.position_id = p.id OR o.position_source_id = p.id)
      AND o.statut = 'valide'
    WHERE p.actif = 1
    ORDER BY p.id ASC, o.date ASC, o.id ASC
  `);

  // Regroupe par position et accumule les soldes courants.
  const posMap = new Map();
  for (const r of rows) {
    if (!posMap.has(r.pos_id)) posMap.set(r.pos_id, { solde_initial: r.solde_initial, ops: [] });
    if (r.op_id != null) posMap.get(r.pos_id).ops.push(r);
  }

  // Calcule le solde cumulatif pour chaque opération.
  // Pour un virement, la dernière position traitée (id le plus grand) gagne (ordre croissant p.id).
  const updates = new Map(); // op_id → solde
  for (const [posId, { solde_initial, ops }] of posMap) {
    let solde = safe(solde_initial);
    for (const op of ops) {
      if (op.type_op === 'encaissement' && op.position_id === posId) solde += safe(op.montant);
      else if (op.type_op === 'decaissement' && op.position_id === posId) solde -= safe(op.montant);
      else if (op.type_op === 'virement') {
        if (op.position_id === posId)        solde += safe(op.montant);
        if (op.position_source_id === posId) solde -= safe(op.montant);
      }
      updates.set(op.op_id, solde);
    }
  }

  if (updates.size === 0) return;

  // Batch UPDATE par tranches de 500 pour éviter des requêtes SQL trop longues.
  const entries = [...updates.entries()];
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const caseWhen = chunk.map(([id, s]) => `WHEN ${Number(id)} THEN ${Number(s)}`).join(' ');
    const ids = chunk.map(([id]) => Number(id)).join(',');
    await db.execute(`UPDATE operations SET solde_position = CASE id ${caseWhen} END WHERE id IN (${ids})`);
  }
}

recalculateSoldes().catch(() => {});

// ─── GET /positions — Soldes de toutes les positions ────────────────────

router.get('/positions', async (req, res) => {
  // Avant : 1 SELECT + 2N requêtes (getSoldePosition + todayFlow par position).
  // Après : 3 requêtes batch quelle que soit le nombre de positions.

  const [positions, soldesRows, fluxRows] = await Promise.all([
    db.query("SELECT * FROM positions WHERE actif = 1 ORDER BY ordre"),

    // Solde cumulatif pour toutes les positions en une seule agrégation.
    db.query(`
      SELECT p.id,
        p.solde_initial + COALESCE(SUM(
          CASE
            WHEN o.type_op = 'encaissement' AND o.position_id = p.id        THEN  o.montant
            WHEN o.type_op = 'virement'     AND o.position_id = p.id        THEN  o.montant
            WHEN o.type_op = 'decaissement' AND o.position_id = p.id        THEN -o.montant
            WHEN o.type_op = 'virement'     AND o.position_source_id = p.id THEN -o.montant
            ELSE 0
          END
        ), 0) AS solde
      FROM positions p
      LEFT JOIN operations o
        ON (o.position_id = p.id OR o.position_source_id = p.id)
        AND o.statut = 'valide'
      WHERE p.actif = 1
      GROUP BY p.id, p.solde_initial
    `),

    // Flux du jour pour toutes les positions en une seule agrégation.
    db.query(`
      SELECT p.id,
        COALESCE(SUM(CASE
          WHEN o.type_op IN ('encaissement','virement') AND o.position_id = p.id THEN o.montant
          ELSE 0
        END), 0) AS enc,
        COALESCE(SUM(CASE
          WHEN o.type_op = 'decaissement' AND o.position_id = p.id        THEN o.montant
          WHEN o.type_op = 'virement'     AND o.position_source_id = p.id THEN o.montant
          ELSE 0
        END), 0) AS decaissements
      FROM positions p
      LEFT JOIN operations o
        ON (o.position_id = p.id OR o.position_source_id = p.id)
        AND o.date = CURDATE()
        AND o.statut = 'valide'
      WHERE p.actif = 1
      GROUP BY p.id
    `),
  ]);

  const soldeMap = new Map(soldesRows.map(r => [r.id, safe(r.solde)]));
  const fluxMap  = new Map(fluxRows.map(r => [r.id, { enc: safe(r.enc), dec: safe(r.decaissements) }]));

  res.json(positions.map(pos => ({
    ...pos,
    solde:               soldeMap.get(pos.id) ?? 0,
    encaissement_today:  fluxMap.get(pos.id)?.enc ?? 0,
    decaissement_today:  fluxMap.get(pos.id)?.dec ?? 0,
  })));
});

// ─── GET /next-ref — Prochaine référence DEC ────────────────────────────

router.get('/next-ref', async (req, res) => {
  const requestedType = normalizeTypeOp(req.query.type || req.query.type_op || 'decaissement');
  const refConfig = {
    encaissement: { prefix: 'REC', type: 'encaissement' },
    decaissement: { prefix: 'DEC', type: 'decaissement' },
    virement: { prefix: 'VIR', type: 'virement' },
  }[requestedType] || { prefix: 'DEC', type: 'decaissement' };
  const year = new Date().getFullYear();
  const row = await db.queryOne('SELECT MAX(id) as max_id FROM operations WHERE type_op = ?', [refConfig.type]);
  const nextId = (row?.max_id || 0) + 1;
  res.json({ ref: `${refConfig.prefix}-${year}-${String(nextId).padStart(6, '0')}` });
});

// ─── GET / — Liste des opérations avec filtres ──────────────────────────

router.get('/', async (req, res) => {
  try {
    const { debut, fin, position_id, categorie_id, search, mois, annee, scope,
            limit = 50, offset = 0, order = 'DESC' } = req.query;
    const type_op = normalizeTypeOp(req.query.type_op || req.query.type);

    let where = "WHERE o.statut = 'valide'";
    const params = [];
    let activeScope = null;
    let effectiveDebut = debut;
    let effectiveFin = fin;

    const monthNumber = Number(mois);
    const yearNumber = Number(annee);
    if (!effectiveDebut && !effectiveFin &&
        Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12 &&
        Number.isInteger(yearNumber) && yearNumber >= 2000 && yearNumber <= 2100) {
      const monthStr = String(monthNumber).padStart(2, '0');
      const lastDay = new Date(yearNumber, monthNumber, 0).getDate();
      effectiveDebut = `${yearNumber}-${monthStr}-01`;
      effectiveFin = `${yearNumber}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
    }

    function addBusinessFilters(targetWhere, targetParams) {
      let nextWhere = targetWhere;
      if (type_op)     { nextWhere += ' AND o.type_op = ?'; targetParams.push(type_op); }
      if (position_id) { nextWhere += ' AND (o.position_id = ? OR o.position_source_id = ?)'; targetParams.push(position_id, position_id); }
      if (categorie_id){ nextWhere += ' AND o.categorie_id = ?'; targetParams.push(categorie_id); }
      if (search)      { nextWhere += ' AND o.libelle LIKE ?'; targetParams.push('%' + search + '%'); }
      return nextWhere;
    }

    if (scope === 'today_or_latest' && !effectiveDebut && !effectiveFin) {
      const today = new Date().toISOString().split('T')[0];
      const probeParams = [today];
      const probeWhere = addBusinessFilters("WHERE o.statut = 'valide' AND o.date = ?", probeParams);
      const todayCount = await db.queryOne(`SELECT COUNT(*) as c FROM operations o ${probeWhere}`, probeParams);
      if ((todayCount?.c || 0) > 0) {
        effectiveDebut = today;
        effectiveFin = today;
        activeScope = 'today';
      } else {
        activeScope = 'latest';
      }
    }

    if (effectiveDebut) { where += ' AND o.date >= ?'; params.push(effectiveDebut); }
    if (effectiveFin)   { where += ' AND o.date <= ?'; params.push(effectiveFin); }
    where = addBusinessFilters(where, params);

    const ord = order === 'ASC' ? 'ASC' : 'DESC';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const countSql = `SELECT COUNT(*) as c FROM operations o ${where}`;
    const countRow = await db.queryOne(countSql, params);
    const total = countRow.c;

    const sql = `
    SELECT o.*,
      c.nom       as categorie_nom,   c.couleur as cat_couleur, c.type as cat_type,
      p.libelle   as position_libelle, p.type    as position_type, p.couleur as pos_couleur,
      ps.libelle  as position_source_libelle,
      CONCAT(e.nom, ' ', e.prenom) as employe_nom,
      u.nom       as created_by_nom,
      da.id       as achat_id, da.numero as achat_numero, da.service_demandeur as achat_service
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
    LEFT JOIN demandes_achat da ON da.decaissement_id = o.id
    ${where}
    ORDER BY o.date ${ord}, o.id ${ord}
    LIMIT ${lim} OFFSET ${off}
  `;
    const rows = (await db.query(sql, params)).map(serializeOperation);

    // Totaux filtrés
    const totSql = `
    SELECT
      COALESCE(SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE 0 END), 0) as total_enc,
      COALESCE(SUM(CASE WHEN type_op = 'decaissement' THEN montant ELSE 0 END), 0) as total_dec,
      COALESCE(SUM(CASE WHEN type_op = 'virement' THEN montant ELSE 0 END), 0) as total_vir
    FROM operations o ${where}
  `;
    const tots = await db.queryOne(totSql, params);

    res.json({ total, rows, totaux: tots, scope: activeScope, debut: effectiveDebut || null, fin: effectiveFin || null });
  } catch (e) {
    console.error('[operations GET /]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST / — Créer une opération ───────────────────────────────────────

router.post('/', async (req, res) => {
  if (!await canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé — rôle autorisé requis pour enregistrer une opération' });
  const {
    date, num_piece, libelle, tiers, montant, type_op, position_id,
    position_source_id, categorie_id, mode_reglement,
    ref_externe, piece_justificative, type_piece, decharge_signee,
    beneficiaire_type, employe_id
  } = normalizeOperationInput(req.body);

  // Q1 — RBAC encaissement : seuls caissier/finance/admin/dg autorisés
  if (type_op === 'encaissement' && !hasRole(req.user, ...ENC_CREATE_ROLES)) {
    return res.status(403).json({ error: 'Enregistrement d\'encaissement réservé aux rôles caissier, finance, admin ou DG' });
  }

  if (!date || !libelle) return res.status(400).json({ error: 'Date et libellé requis' });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: 'Montant doit être > 0' });
  if (!type_op) return res.status(400).json({ error: 'Type opération requis (encaissement/décaissement/virement)' });
  if (!position_id) return res.status(400).json({ error: 'Position requise (Caisse/Banque)' });
  if (type_op === 'virement' && !position_source_id) return res.status(400).json({ error: 'Position source requise pour un virement' });
  if (type_op === 'virement') {
    const transferValidation = await validateInternalTransfer({ position_id, position_source_id, montant });
    if (transferValidation.error) return res.status(400).json({ error: transferValidation.error });
  }
  if (type_op !== 'virement' && !categorie_id) return res.status(400).json({ error: 'Rubrique comptable requise' });
  if (await isPeriodeCloturee(date)) return res.status(400).json({ error: `Période ${date.slice(0,7)} clôturée — aucune écriture autorisée` });

  const refError = await validateExternalReference({ type_op, mode_reglement, ref_externe });
  if (refError) return res.status(400).json({ error: refError });

  // Blocage décaissement si alerte bloquante active sur la position (sauf override admin explicite)
  if (type_op === 'decaissement' && !req.body.override_alerte) {
    const alerteBloquante = await db.queryOne(`
      SELECT id, titre, message FROM alertes_actives
      WHERE position_id = ? AND priorite = 'bloquant' AND statut NOT IN ('resolue','acquittee')
      LIMIT 1
    `, [position_id]);
    if (alerteBloquante) {
      if (!hasRole(req.user, 'admin')) {
        return res.status(403).json({
          error: `Décaissement bloqué — alerte active : ${alerteBloquante.message}`,
          alerte_id: alerteBloquante.id,
          bloquant: true
        });
      }
      // Admin peut passer avec override_alerte=true dans le body — on continue
    }
  }

  // Les décaissements manuels entrent en workflow (brouillon, hors journal)
  // Les encaissements et virements sont directs (valide, impact immédiat)
  const isWorkflowDec = type_op === 'decaissement';
  const statutInsert  = isWorkflowDec ? 'en_attente' : 'valide';
  const decStatut     = isWorkflowDec ? 'brouillon'  : null;

  const columns = [
    'date', 'num_piece', 'libelle', 'tiers', 'montant', 'type_op', 'position_id',
    'position_source_id', 'categorie_id', 'mode_reglement', 'ref_externe',
    'piece_justificative', 'type_piece', 'decharge_signee',
    'beneficiaire_type', 'employe_id', 'created_by',
    'statut', 'dec_statut'
  ];
  const values = [
    date, num_piece || null, libelle, tiers || null,
    Number(montant), type_op, Number(position_id),
    position_source_id ? Number(position_source_id) : null,
    categorie_id ? Number(categorie_id) : null,
    mode_reglement, ref_externe || null, piece_justificative || null,
    type_piece, decharge_signee ? 1 : 0,
    beneficiaire_type, employe_id ? Number(employe_id) : null,
    req.user.id,
    statutInsert, decStatut
  ];
  const legacy = legacyValues({ libelle, num_piece, montant, type_op, solde_position: 0, mode_reglement });
  ['detail', 'n_piece', 'recette', 'depense', 'solde', 'mode_paiement'].forEach(column => {
    if (hasOperationColumn(column)) {
      columns.push(column);
      values.push(legacy[column]);
    }
  });
  const flowStatuses = flowStatusesForOperation(type_op, statutInsert);
  Object.entries(flowStatuses).forEach(([column, value]) => {
    appendOptionalOperationValue(columns, values, column, value);
  });

  const placeholders = columns.map(() => '?').join(',');
  const result = await db.execute(`INSERT INTO operations (${columns.join(',')}) VALUES (${placeholders})`, values);

  if (!isWorkflowDec) {
    recalculateSoldes().catch(() => {});
    setImmediate(() => { try { evaluerAlerteSoldes(); } catch (_) {} });
  }

  const op = await db.queryOne(`
    SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur
    FROM operations o
    LEFT JOIN positions p ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE o.id = ?
  `, [result.insertId]);

  // Notification création (encaissements/virements uniquement — les décaissements sont en brouillon)
  if (!isWorkflowDec) {
    setImmediate(() => {
      try {
        creerNotification({
          type:     'NOTIF_OP_CREE',
          titre:    `${type_op === 'encaissement' ? 'Encaissement' : 'Virement'} enregistré`,
          message:  `${libelle} — ${new Intl.NumberFormat('fr-FR').format(Number(montant))} XAF`,
          srcTable: 'operations',
          srcId:    result.insertId,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });
  }

  await ensureOperationSyncErrors(op, req.user.id);
  await attemptAutomaticAccountingForOperation({
    operationId: op.id,
    userId: req.user.id,
  });
  const operationWithAccountingStatus = await db.queryOne(`
    SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur
    FROM operations o
    LEFT JOIN positions p ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE o.id = ?
  `, [op.id]);

  res.status(201).json(serializeOperation(operationWithAccountingStatus));
});

// ─── PUT /:id — Modifier ─────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  if (!await canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const op = await db.queryOne("SELECT * FROM operations WHERE id = ?", [req.params.id]);
  if (!op) return res.status(404).json({ error: 'Opération non trouvée' });
  const postedEntry = await hasPostedAccountingEntry(op.id);
  if (postedEntry) {
    return res.status(409).json({
      error: `Modification interdite : opération déjà comptabilisée dans ${postedEntry.entry_no}. Utiliser une contre-écriture.`,
      accounting_entry_id: postedEntry.id,
    });
  }
  if (await isPeriodeCloturee(op.date)) return res.status(400).json({ error: `Période ${op.date.slice(0,7)} clôturée — modification interdite` });

  const {
    date, num_piece, libelle, tiers, montant, type_op, position_id,
    position_source_id, categorie_id, mode_reglement,
    ref_externe, piece_justificative, type_piece, decharge_signee,
    beneficiaire_type, employe_id
  } = normalizeOperationInput(req.body, op);
  if (!date || !libelle) return res.status(400).json({ error: 'Date et libellé requis' });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: 'Montant doit être > 0' });
  if (!position_id) return res.status(400).json({ error: 'Position requise (Caisse/Banque)' });
  if (type_op === 'virement' && !position_source_id) return res.status(400).json({ error: 'Position source requise pour un virement' });
  if (type_op === 'virement') {
    const transferValidation = await validateInternalTransfer({ position_id, position_source_id, montant });
    if (transferValidation.error) return res.status(400).json({ error: transferValidation.error });
  }
  if (type_op !== 'virement' && !categorie_id) return res.status(400).json({ error: 'Rubrique comptable requise' });

  const refError = await validateExternalReference({ type_op, mode_reglement, ref_externe, excludeId: op.id });
  if (refError) return res.status(400).json({ error: refError });

  const assignments = [
    'date=?', 'num_piece=?', 'libelle=?', 'tiers=?', 'montant=?', 'type_op=?',
    'position_id=?', 'position_source_id=?', 'categorie_id=?', 'mode_reglement=?',
    'ref_externe=?', 'piece_justificative=?', 'type_piece=?',
    'decharge_signee=?', 'beneficiaire_type=?', 'employe_id=?',
    "updated_at=NOW()"
  ];
  const values = [
    date, num_piece || null, libelle, tiers || null,
    Number(montant), type_op, Number(position_id),
    position_source_id ? Number(position_source_id) : null,
    categorie_id ? Number(categorie_id) : null,
    mode_reglement || 'especes', ref_externe || null,
    piece_justificative || null, type_piece,
    decharge_signee ? 1 : 0, beneficiaire_type,
    employe_id ? Number(employe_id) : null
  ];
  const legacy = legacyValues({ libelle, num_piece, montant, type_op, solde_position: op.solde_position, mode_reglement });
  ['detail', 'n_piece', 'recette', 'depense', 'mode_paiement'].forEach(column => {
    if (hasOperationColumn(column)) {
      assignments.push(`${column}=?`);
      values.push(legacy[column]);
    }
  });
  const flowStatuses = flowStatusesForOperation(type_op, op.statut);
  Object.entries(flowStatuses).forEach(([column, value]) => {
    if (hasOperationColumn(column)) {
      assignments.push(`${column}=?`);
      values.push(value);
    }
  });
  values.push(req.params.id);
  await db.execute(`UPDATE operations SET ${assignments.join(', ')} WHERE id = ?`, values);

  recalculateSoldes().catch(() => {});
  const updated = await db.queryOne("SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur FROM operations o LEFT JOIN positions p ON o.position_id=p.id LEFT JOIN categories c ON o.categorie_id=c.id WHERE o.id=?", [req.params.id]);
  await ensureOperationSyncErrors(updated, req.user.id);
  res.json(serializeOperation(updated));
});

// ─── DELETE /:id — Annuler ────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  // Même périmètre que l'annulation d'un décaissement : un chèque rejeté par
  // la banque est un événement de finance, pas d'administration système.
  if (!hasRole(req.user, ...DEC_CANCEL_ROLES)) {
    return res.status(403).json({ error: 'Admin, Finance ou DG requis pour annuler' });
  }
  const opD = await db.queryOne("SELECT date FROM operations WHERE id = ?", [req.params.id]);
  const postedEntry = await hasPostedAccountingEntry(req.params.id);
  if (postedEntry) {
    return res.status(409).json({
      error: `Annulation directe interdite : opération déjà comptabilisée dans ${postedEntry.entry_no}. Utiliser une contre-écriture.`,
      accounting_entry_id: postedEntry.id,
    });
  }
  if (opD && await isPeriodeCloturee(opD.date)) return res.status(400).json({ error: `Période ${opD.date.slice(0,7)} clôturée — annulation interdite` });

  // Un motif est obligatoire, comme pour toute autre annulation de
  // l'application — décaissement, avance, congé. Celle-ci ne le demandait
  // pas, alors que la colonne annule_motif existait depuis toujours.
  //
  // Ce n'est pas une formalité : « chèque rejeté — provision insuffisante »
  // et « erreur de saisie » n'appellent pas la même suite. Sans le motif, une
  // ligne annulée ne dit plus rien à qui la relit, et la piste d'audit
  // SYSCOHADA perd le lien entre l'écriture et sa raison.
  const { motif } = req.body || {};
  if (!motif || !String(motif).trim()) {
    return res.status(400).json({ error: 'Motif d\'annulation obligatoire' });
  }

  await db.execute(`
    UPDATE operations SET
      statut       = 'annule',
      annule_by    = ?,
      annule_at    = NOW(),
      annule_motif = ?,
      updated_at   = NOW()
    WHERE id = ?
  `, [req.user.id, String(motif).trim(), req.params.id]);
  if (hasOperationColumn('treasury_status')) {
    await db.execute(`
      UPDATE operations
      SET treasury_status='cancelled',
          accounting_status='cancelled',
          budget_status='cancelled',
          allocation_status='cancelled',
          updated_at=NOW()
      WHERE id = ?
    `, [req.params.id]);
  }
  await closeOperationSyncErrors(req.params.id, 'ignored', req.user.id);
  recalculateSoldes().catch(() => {});
  res.json({ ok: true });
});

// ─── GET /kpis/summary — KPIs complets ───────────────────────────────────

router.get('/kpis/summary', async (req, res) => {
  const { mois, annee } = req.query;
  const m  = Number(mois)  || new Date().getMonth() + 1;
  const a  = Number(annee) || new Date().getFullYear();

  const moisStr = String(m).padStart(2, '0');
  const moisDebut = `${a}-${moisStr}-01`;
  const moisFin   = `${a}-${moisStr}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;

  const today = new Date().toISOString().split('T')[0];

  // Début de la semaine (lundi)
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekDebut = monday.toISOString().split('T')[0];
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const weekFin = sunday.toISOString().split('T')[0];

  // Mois précédent
  const prevM = m === 1 ? 12 : m - 1;
  const prevA = m === 1 ? a - 1 : a;
  const prevDebut = `${prevA}-${String(prevM).padStart(2,'0')}-01`;
  const prevFin   = `${prevA}-${String(prevM).padStart(2,'0')}-${String(new Date(prevA, prevM, 0).getDate()).padStart(2, '0')}`;

  // Q5 — virements internes exclus des KPIs encaissement (comptabilisés séparément)
  async function getFlows(debut, fin, posId = null) {
    let posFilter = '';
    const p = [debut, fin];
    if (posId) { posFilter = 'AND (o.position_id = ? OR o.position_source_id = ?)'; p.push(posId, posId); }
    return db.queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE 0 END), 0) as encaissements,
        COALESCE(SUM(CASE WHEN type_op = 'decaissement' THEN montant ELSE 0 END), 0) as decaissements,
        COALESCE(SUM(CASE WHEN type_op = 'virement'     THEN montant ELSE 0 END), 0) as virements_internes,
        COUNT(CASE WHEN type_op != 'virement' THEN 1 END) as nb_ops
      FROM operations o
      WHERE statut = 'valide' AND date BETWEEN ? AND ? ${posFilter}
    `, p);
  }

  // Positions & soldes
  const positions = await db.query("SELECT * FROM positions WHERE actif = 1 ORDER BY ordre");
  const positionsWithSolde = await Promise.all(positions.map(async p => ({
    ...p,
    solde: await getSoldePosition(p.id)
  })));
  const tresTotal = positionsWithSolde.reduce((s, p) => s + p.solde, 0);

  // Flux par période
  const fluxMois     = await getFlows(moisDebut, moisFin);
  const fluxAujourd  = await getFlows(today, today);
  const fluxSemaine  = await getFlows(weekDebut, weekFin);
  const fluxPrevMois = await getFlows(prevDebut, prevFin);

  // Évolution journalière du mois
  const evolution = await db.query(`
    SELECT date,
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements,
      COUNT(CASE WHEN type_op != 'virement' THEN 1 END) as nb_ops
    FROM operations
    WHERE statut = 'valide' AND date BETWEEN ? AND ?
    GROUP BY date ORDER BY date ASC
  `, [moisDebut, moisFin]);

  // Top dépenses par catégorie (mois)
  const topCategories = await db.query(`
    SELECT c.nom, c.couleur, c.type,
      COALESCE(SUM(o.montant), 0) as total
    FROM operations o
    JOIN categories c ON o.categorie_id = c.id
    WHERE o.statut = 'valide' AND o.type_op = 'decaissement'
      AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC LIMIT 8
  `, [moisDebut, moisFin]);

  // Dépense max / min du mois
  const extremes = await db.queryOne(`
    SELECT
      MAX(montant) as max_dep,
      MIN(montant) as min_dep,
      (SELECT libelle FROM operations WHERE type_op='decaissement' AND statut='valide' AND date BETWEEN ? AND ? ORDER BY montant DESC LIMIT 1) as libelle_max,
      (SELECT libelle FROM operations WHERE type_op='decaissement' AND statut='valide' AND date BETWEEN ? AND ? AND montant > 0 ORDER BY montant ASC LIMIT 1) as libelle_min
    FROM operations
    WHERE type_op = 'decaissement' AND statut = 'valide' AND date BETWEEN ? AND ?
  `, [moisDebut, moisFin, moisDebut, moisFin, moisDebut, moisFin]);

  // Opérations à afficher dans le dashboard : priorité au jour, sinon fallback dernières disponibles.
  const todayOpsCount = await db.queryOne(`
    SELECT COUNT(*) as c
    FROM operations
    WHERE statut = 'valide' AND date = ?
  `, [today]);
  const recentOpsScope = (todayOpsCount?.c || 0) > 0 ? 'today' : 'latest';
  const recentOpsWhere = recentOpsScope === 'today'
    ? "WHERE o.statut = 'valide' AND o.date = ?"
    : "WHERE o.statut = 'valide'";
  const recentOpsParams = recentOpsScope === 'today' ? [today] : [];
  const dernieres = await db.query(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           p.libelle as position_libelle, p.couleur as pos_couleur,
           ps.libelle as source_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    ${recentOpsWhere}
    ORDER BY o.date DESC, o.id DESC LIMIT 8
  `, recentOpsParams);

  const evolutionCompat = evolution.map(row => ({
    ...row,
    recettes: row.encaissements,
    depenses: row.decaissements,
  }));
  const dernieresCompat = dernieres.map(serializeOperation);

  res.json({
    positions: positionsWithSolde,
    tresorerie_totale: safe(tresTotal),
    mois: { ...fluxMois, debut: moisDebut, fin: moisFin },
    aujourd_hui: fluxAujourd,
    semaine: { ...fluxSemaine, debut: weekDebut, fin: weekFin },
    mois_precedent: fluxPrevMois,
    evolution: evolutionCompat,
    top_categories: topCategories,
    par_categorie: topCategories,
    extremes,
    dernieres_ops: dernieresCompat,
    dernieres_ops_scope: recentOpsScope,
    solde_courant: safe(tresTotal),
    total_recettes: safe(fluxMois.encaissements),
    total_depenses: safe(fluxMois.decaissements),
    nb_operations: safe(fluxMois.nb_ops),
    prev_recettes: safe(fluxPrevMois.encaissements),
    prev_depenses: safe(fluxPrevMois.decaissements),
  });
});

// ─── GET /journal — Journal de trésorerie par position ───────────────────

router.get('/journal', async (req, res) => {
  const { position_id, debut, fin, type_op, limit = 100, offset = 0 } = req.query;

  let where = "WHERE o.statut = 'valide'";
  const params = [];

  if (type_op) { where += ' AND o.type_op = ?'; params.push(type_op); }
  if (position_id) {
    where += ' AND (o.position_id = ? OR o.position_source_id = ?)';
    params.push(Number(position_id), Number(position_id));
  }
  if (debut) { where += ' AND o.date >= ?'; params.push(debut); }
  if (fin)   { where += ' AND o.date <= ?'; params.push(fin); }

  const countSql = `SELECT COUNT(*) as c FROM operations o ${where}`;
  const countRow = await db.queryOne(countSql, params);
  const total = countRow.c;

  // Pour le journal, on calcule débit/crédit selon la perspective de la position
  const sql = `
    SELECT o.*,
      c.nom as categorie_nom, c.couleur as cat_couleur,
      p.libelle as position_libelle, p.type as position_type,
      ps.libelle as position_source_libelle,
      CONCAT(e.nom, ' ', e.prenom) as employe_nom,
      u.nom as saisie_par
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
    ${where}
    ORDER BY o.date ASC, o.id ASC
    LIMIT ? OFFSET ?
  `;
  const rowParams = [...params, Number(limit), Number(offset)];
  const rows = (await db.query(sql, rowParams)).map(serializeOperation);

  res.json({ total, rows });
});

// ─── GET /sync-errors — Anomalies de synchronisation finance ──────────────

router.get('/sync-errors', async (req, res) => {
  const status = ['open', 'resolved', 'ignored'].includes(req.query.status) ? req.query.status : 'open';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  const rows = await db.query(`
    SELECT se.id, se.source_record_id, se.error_type, se.error_message,
           se.technical_details, se.status, se.created_at, se.updated_at,
           se.resolved_at,
           o.date, o.num_piece, o.libelle, o.type_op, o.montant,
           o.treasury_status, o.accounting_status, o.budget_status, o.allocation_status,
           p.libelle as position_libelle,
           c.nom as categorie_nom,
           u.nom as resolved_by_nom
    FROM sync_errors se
    LEFT JOIN operations o ON o.id = se.source_record_id
    LEFT JOIN positions p  ON p.id = o.position_id
    LEFT JOIN categories c ON c.id = o.categorie_id
    LEFT JOIN users u      ON u.id = se.resolved_by
    WHERE se.source_module = 'operations'
      AND se.status = ?
    ORDER BY se.created_at DESC, se.id DESC
    LIMIT ?
  `, [status, limit]);

  const counts = await db.query(`
    SELECT status, COUNT(*) as total
    FROM sync_errors
    WHERE source_module = 'operations'
    GROUP BY status
  `);

  res.json({ rows, counts });
});

router.put('/sync-errors/:id/resolve', async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg')) {
    return res.status(403).json({ error: 'Résolution réservée à Admin, Finance ou DG' });
  }
  const status = req.body?.status === 'ignored' ? 'ignored' : 'resolved';
  const err = await db.queryOne(`
    SELECT id, source_record_id, status FROM sync_errors
    WHERE id = ? AND source_module = 'operations'
  `, [req.params.id]);
  if (!err) return res.status(404).json({ error: 'Anomalie de synchronisation introuvable' });
  if (err.status !== 'open') return res.status(400).json({ error: 'Anomalie déjà clôturée' });

  await db.execute(`
    UPDATE sync_errors
    SET status = ?, resolved_by = ?, resolved_at = NOW(), updated_at = NOW()
    WHERE id = ?
  `, [status, req.user.id, req.params.id]);
  await auditDec(err.source_record_id, 'sync_error_closed', { sync_error_id: err.id, status }, req.user.id);

  res.json({ ok: true, status });
});

// ─── GET /rapport/hebdo ────────────────────────────────────────────────────

// ─── GET /export-csv — Export CSV journal des opérations ─────────────────────

router.get('/export-csv', async (req, res) => {
  const { debut, fin, position_id, categorie_id, type_op: rawType } = req.query;
  const type_op = normalizeTypeOp(rawType || '');

  let where = "WHERE o.statut = 'valide'";
  const params = [];
  if (debut)       { where += ' AND o.date >= ?'; params.push(debut); }
  if (fin)         { where += ' AND o.date <= ?'; params.push(fin); }
  if (type_op)     { where += ' AND o.type_op = ?'; params.push(type_op); }
  if (position_id) { where += ' AND (o.position_id = ? OR o.position_source_id = ?)'; params.push(position_id, position_id); }
  if (categorie_id){ where += ' AND o.categorie_id = ?'; params.push(categorie_id); }

  const rows = await db.query(`
    SELECT o.date, o.num_piece, o.type_op, o.libelle, o.tiers, o.montant,
           o.mode_reglement, o.ref_externe, o.solde_position,
           c.nom as categorie_nom, p.libelle as position_libelle,
           ps.libelle as position_source_libelle,
           CONCAT(e.nom, ' ', e.prenom) as employe_nom,
           u.nom as saisie_par, o.decharge_signee, o.piece_justificative
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
    ${where}
    ORDER BY o.date ASC, o.id ASC
  `, params);

  const typeLabel = { encaissement: 'Encaissement', decaissement: 'Décaissement', virement: 'Virement' };
  const BOM = '﻿';
  const SEP = ';';
  const headers = [
    'Date','N° Pièce','Type','Libellé','Tiers','Montant',
    'Mode règlement','Réf. externe','Solde position',
    'Catégorie','Position','Position source','Employé','Saisi par','Décharge signée','Pièce jointe'
  ];
  const csvRows = rows.map(r => [
    r.date, r.num_piece || '', typeLabel[r.type_op] || r.type_op,
    `"${(r.libelle || '').replace(/"/g, '""')}"`,
    `"${(r.tiers || '').replace(/"/g, '""')}"`,
    r.montant, r.mode_reglement || '',
    r.ref_externe || '', r.solde_position || 0,
    r.categorie_nom || '', r.position_libelle || '', r.position_source_libelle || '',
    r.employe_nom || '', r.saisie_par || '',
    r.decharge_signee ? 'Oui' : 'Non', r.piece_justificative || ''
  ].join(SEP));

  const label = debut && fin ? `${debut}_au_${fin}` : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="operations-${label}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
});

router.get('/rapport/hebdo', async (req, res) => {
  const { debut } = req.query;
  const d = debut ? new Date(debut) : new Date();
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = dt => dt.toISOString().split('T')[0];

  const ops = await db.query(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           p.libelle as position_libelle, ps.libelle as source_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    WHERE o.statut = 'valide' AND o.date BETWEEN ? AND ?
    ORDER BY o.date ASC, o.id ASC
  `, [fmt(monday), fmt(sunday)]);

  const totEnc = ops.filter(o => o.type_op === 'encaissement').reduce((s, o) => s + o.montant, 0);
  const totDec = ops.filter(o => o.type_op === 'decaissement').reduce((s, o) => s + o.montant, 0);
  const totVir = ops.filter(o => o.type_op === 'virement').reduce((s, o) => s + o.montant, 0);

  res.json({
    debut: fmt(monday), fin: fmt(sunday),
    operations: ops.map(serializeOperation),
    total_encaissements: totEnc,
    total_decaissements: totDec,
    total_virements: totVir,
    total_recettes: totEnc,
    total_depenses: totDec,
    solde_net: totEnc - totDec
  });
});

// ─── GET /rapport/mensuel ─────────────────────────────────────────────────

router.get('/rapport/mensuel', async (req, res) => {
  const { mois, annee } = req.query;
  const m = Number(mois) || new Date().getMonth() + 1;
  const a = Number(annee) || new Date().getFullYear();
  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin   = `${a}-${String(m).padStart(2,'0')}-31`;

  const ops = await db.query(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           c.type as cat_type, p.libelle as position_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    WHERE o.statut = 'valide' AND o.date BETWEEN ? AND ?
    ORDER BY o.date ASC, o.id ASC
  `, [debut, fin]);

  const parCategorie = await db.query(`
    SELECT c.nom, c.couleur, c.type,
      COALESCE(SUM(CASE WHEN o.type_op='decaissement' THEN o.montant ELSE 0 END),0) as total_dec,
      COALESCE(SUM(CASE WHEN o.type_op='encaissement' THEN o.montant ELSE 0 END),0) as total_enc,
      COUNT(*) as nb
    FROM operations o JOIN categories c ON o.categorie_id = c.id
    WHERE o.statut='valide' AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total_dec DESC
  `, [debut, fin]);

  res.json({ mois: m, annee: a, debut, fin, operations: ops, par_categorie: parCategorie });
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW DÉCAISSEMENT — brouillon → soumis → validé → payé / annulé
// ═══════════════════════════════════════════════════════════════════════════

async function auditDec(recordId, action, details, userId) {
  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
      ['operations', recordId, action, details ? JSON.stringify(details) : null, userId || null]);
  } catch (_) {}
}

async function getDecOrFail(id, res) {
  const op = await db.queryOne('SELECT * FROM operations WHERE id = ? AND type_op = ?', [id, 'decaissement']);
  if (!op) { res.status(404).json({ error: 'Décaissement non trouvé' }); return null; }
  return op;
}

// ─── GET /decaissements/pending-count — Compteur léger pour badge sidebar ────
router.get('/decaissements/pending-count', async (req, res) => {
  const statuses = [];
  if (await canApproveDec(req.user)) statuses.push('soumis');
  if (await canPayCashOut(req.user)) statuses.push('valide');
  if (!statuses.length) return res.json({ count: 0, statuses: [] });

  const placeholders = statuses.map(() => '?').join(',');
  const row = await db.queryOne(`
    SELECT COUNT(*) as nb
    FROM operations
    WHERE type_op='decaissement'
      AND dec_statut IN (${placeholders})
      AND statut <> 'annule'
  `, statuses);
  res.json({ count: row.nb, statuses });
});

// ─── GET /decaissements/pending — Liste en attente (hors journal) ────────────
router.get('/decaissements/pending', async (req, res) => {
  const actionableOnly = req.query.scope === 'actionable';
  let statusFilter = ['brouillon', 'soumis', 'valide'];
  let ownerOnly = false;
  if (actionableOnly) {
    statusFilter = [];
    const canApprove = await canApproveDec(req.user);
    const canPay = await canPayCashOut(req.user);
    if (await canWrite(req.user) && !canApprove && !canPay) {
      statusFilter.push('brouillon');
      ownerOnly = true;
    }
    if (canApprove) statusFilter.push('soumis');
    if (canPay) statusFilter.push('valide');
    if (!statusFilter.length) return res.json([]);
  }
  const placeholders = statusFilter.map(() => '?').join(',');
  const filterParams = [...statusFilter];
  const ownerWhere = ownerOnly ? 'AND o.created_by = ?' : '';
  if (ownerOnly) filterParams.push(req.user.id);
  const rows = await db.query(`
    SELECT o.*,
      c.nom  as categorie_nom, c.couleur as cat_couleur,
      p.libelle as position_libelle,
      CONCAT(e.nom, ' ', e.prenom) as employe_nom,
      u.nom  as created_by_nom,
      uv.nom as validated_by_nom,
      up.nom as paid_by_nom,
      da.id  as achat_id, da.numero as achat_numero, da.service_demandeur as achat_service
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions  p ON o.position_id  = p.id
    LEFT JOIN employes   e ON o.employe_id   = e.id
    LEFT JOIN users      u ON o.created_by   = u.id
    LEFT JOIN users     uv ON o.validated_by = uv.id
    LEFT JOIN users     up ON o.paid_by      = up.id
    LEFT JOIN demandes_achat da ON da.decaissement_id = o.id
    WHERE o.type_op = 'decaissement'
      AND COALESCE(o.dec_statut, 'brouillon') IN (${placeholders})
      ${ownerWhere}
    ORDER BY o.created_at DESC
    LIMIT 200
  `, filterParams);
  res.json(rows);
});

// ─── PUT /:id/soumettre — brouillon → soumis ─────────────────────────────────
router.put('/:id/soumettre', async (req, res) => {
  if (!await canWrite(req.user)) return res.status(403).json({ error: 'Rôle autorisé requis pour soumettre un décaissement' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul brouillon peut être soumis` });

  // Si l'ordonnateur habilité soumet lui-même, la dépense est directement validée.
  // Elle reste hors journal tant que Finance/Caisse ne l'a pas payée.
  if (await canApproveDec(req.user)) {
    await db.execute(`
      UPDATE operations
      SET dec_statut='valide',
          submitted_by=?, submitted_at=NOW(),
          validated_by=?, validated_at=NOW(),
          updated_at=NOW()
      WHERE id=?
    `, [req.user.id, req.user.id, op.id]);
    await auditDec(op.id, 'dec_soumis_auto_valide', { montant: op.montant, libelle: op.libelle }, req.user.id);
    return res.json({ ok: true, dec_statut: 'valide', auto_validated: true });
  }

  await db.execute(`UPDATE operations SET dec_statut='soumis', submitted_by=?, submitted_at=NOW(), updated_at=NOW() WHERE id=?`,
    [req.user.id, op.id]);
  await auditDec(op.id, 'dec_soumis', { montant: op.montant, libelle: op.libelle }, req.user.id);

  // Connecteur parapheur (non bloquant)
  setImmediate(() => {
    creerEntreeParapheur({
      type: 'decaissement',
      titre: `Décaissement — ${op.libelle} (${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF)`,
      initiateur_id: req.user.id,
      montant: op.montant,
      ref_source_table: 'operations',
      ref_source_id: op.id,
    });
  });

  // Alerte décaissement soumis en attente de validation
  setImmediate(() => {
    try {
      declencherAlerte({
        type:     'ALRT_DEC_SOUMIS',
        titre:    'Décaissement à valider',
        message:  `${op.libelle} — ${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF soumis par ${req.user.nom}`,
        srcTable: 'operations',
        srcId:    op.id,
        createdBy: req.user.id,
      });
    } catch (_) {}
  });

  // Notifier par email la Direction Générale et les collaborateurs financiers habilités à valider
  try {
    const valideurs = await db.query(`
      SELECT nom, email FROM users
      WHERE actif = 1
        AND email IS NOT NULL AND email != ''
        AND (
          role IN ('dg','finance','admin')
          OR roles LIKE '%"dg"%'
          OR roles LIKE '%"finance"%'
          OR roles LIKE '%"admin"%'
        )
    `);
    const montantStr = new Intl.NumberFormat('fr-FR').format(op.montant) + ' XAF';
    const soumisParNom = req.user.nom || req.user.email;
    valideurs.forEach(u => {
      sendMail({
        to: u.email,
        subject: `✅ Décaissement à valider — ${montantStr}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:16px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#1A50D9,#1545B5);padding:28px;text-align:center">
              <h1 style="margin:0;font-size:20px;color:white">TOP CENTER — Caisse</h1>
              <p style="margin:6px 0 0;color:#bfdbfe;font-size:13px">Décaissement soumis pour validation</p>
            </div>
            <div style="padding:28px">
              <p style="margin:0 0 12px">Bonjour <strong>${u.nom}</strong>,</p>
              <p style="margin:0 0 20px;color:#94a3b8">Un décaissement vient d'être soumis par <strong>${soumisParNom}</strong> et attend votre validation :</p>
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#94a3b8;width:40%">Libellé</td><td style="padding:8px 0;font-weight:600">${op.libelle}</td></tr>
                <tr><td style="padding:8px 0;color:#94a3b8">Montant</td><td style="padding:8px 0;font-weight:700;color:#f87171">${montantStr}</td></tr>
                <tr><td style="padding:8px 0;color:#94a3b8">Date</td><td style="padding:8px 0">${op.date}</td></tr>
                ${op.tiers ? `<tr><td style="padding:8px 0;color:#94a3b8">Tiers</td><td style="padding:8px 0">${op.tiers}</td></tr>` : ''}
              </table>
              <div style="margin-top:24px;text-align:center">
                <a href="${process.env.APP_URL || 'https://talatala.topcenter.cg'}/app/finance/operations" style="background:linear-gradient(135deg,#1A50D9,#1545B5);color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">
                  Voir le décaissement →
                </a>
              </div>
              <p style="margin-top:20px;font-size:11px;color:#475569">Tala SMI · TOP CENTER Congo · ${new Date().toLocaleString('fr-FR')}</p>
            </div>
          </div>`
      }).catch(() => {}); // non bloquant
    });
  } catch (_) {}

  res.json({ ok: true, dec_statut: 'soumis' });
});

// ─── PUT /:id/rejeter — soumis → rejeté (Q2 — DG/finance/admin + motif obligatoire) ──
router.put('/:id/rejeter', async (req, res) => {
  if (!await canApproveDec(req.user)) return res.status(403).json({ error: 'Rejet réservé au DG, Finance ou Admin' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;
  if (!['soumis', 'valide'].includes(op.dec_statut)) {
    return res.status(400).json({ error: `Statut "${op.dec_statut}" ne peut pas être rejeté` });
  }
  const { motif } = req.body;
  if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif de rejet obligatoire' });

  await db.execute(`
    UPDATE operations SET
      dec_statut   = 'rejete',
      motif_rejet  = ?,
      rejete_par   = ?,
      rejete_at    = NOW(),
      updated_at   = NOW()
    WHERE id = ?
  `, [String(motif).trim(), req.user.id, op.id]);
  await auditDec(op.id, 'dec_rejete', { motif: String(motif).trim(), ancien_statut: op.dec_statut }, req.user.id);

  setImmediate(async () => {
    try { resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', op.id); } catch (_) {}
    // Notifier l'initiateur
    try {
      if (op.created_by) {
        const initiateur = await db.queryOne('SELECT nom, email FROM users WHERE id = ?', [op.created_by]);
        if (initiateur?.email) {
          const { sendMail } = require('../services/email');
          sendMail({
            to: initiateur.email,
            subject: `❌ Décaissement rejeté — ${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF`,
            html: `<div style="font-family:Inter,sans-serif;max-width:520px;margin:auto;padding:24px;background:#0f172a;color:#e2e8f0;border-radius:16px">
              <h2 style="color:#f87171">Décaissement rejeté</h2>
              <p>Bonjour ${initiateur.nom},</p>
              <p>Votre demande de décaissement <strong>${op.libelle}</strong> (${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF) a été rejetée.</p>
              <p><strong>Motif :</strong> ${String(motif).trim()}</p>
              <p>Vous pouvez soumettre à nouveau après correction.</p>
            </div>`
          }).catch(() => {});
        }
      }
    } catch (_) {}
  });

  res.json({ ok: true, dec_statut: 'rejete' });
});

// ─── PUT /:id/resoumettre — rejeté → soumis (initiateur resoumets après correction) ──
router.put('/:id/resoumettre', async (req, res) => {
  if (!await canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'rejete') return res.status(400).json({ error: 'Seul un décaissement rejeté peut être resoumis' });
  if (req.user.id !== op.created_by && !hasRole(req.user, 'admin')) {
    return res.status(403).json({ error: 'Seul l\'initiateur ou un admin peut resoumettre' });
  }

  await db.execute(`
    UPDATE operations SET
      dec_statut    = 'soumis',
      submitted_by  = ?,
      submitted_at  = NOW(),
      motif_rejet   = NULL,
      rejete_par    = NULL,
      rejete_at     = NULL,
      updated_at    = NOW()
    WHERE id = ?
  `, [req.user.id, op.id]);
  await auditDec(op.id, 'dec_resoumis', { libelle: op.libelle, montant: op.montant }, req.user.id);

  res.json({ ok: true, dec_statut: 'soumis' });
});

// ─── PUT /:id/valider — soumis → validé (admin / responsable) ────────────────
router.put('/:id/valider', async (req, res) => {
  if (!await canApproveDec(req.user)) return res.status(403).json({ error: 'Validation réservée au DG, à un délégué actif, à Finance ou à Admin' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'soumis') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul soumis peut être validé` });

  await db.execute(`UPDATE operations SET dec_statut='valide', validated_by=?, validated_at=NOW(), updated_at=NOW() WHERE id=?`,
    [req.user.id, op.id]);
  await auditDec(op.id, 'dec_valide', { montant: op.montant, libelle: op.libelle }, req.user.id);

  // Résoudre l'alerte "soumis en attente" — maintenant validé
  setImmediate(() => {
    try { resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', op.id); } catch (_) {}
  });

  res.json({ ok: true, dec_statut: 'valide' });
});

// ─── POST /:id/payer — validé → payé (impact réel journal) ───────────────────
router.post('/:id/payer', async (req, res) => {
  if (!await canPayCashOut(req.user)) return res.status(403).json({ error: 'Permission cash.out.pay requise pour payer' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;

  // Vérification rapide hors transaction (retour rapide sur cas évidents)
  if (op.dec_statut === 'paye')    return res.status(400).json({ error: 'Décaissement déjà payé' });
  if (op.dec_statut !== 'valide')  return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul validé peut être payé` });

  // Blocage si alerte bloquante active sur la position (solde négatif)
  if (!req.body?.override_alerte) {
    const alerteBloquante = await db.queryOne(`
      SELECT id, titre, message FROM alertes_actives
      WHERE position_id = ? AND priorite = 'bloquant' AND statut NOT IN ('resolue','acquittee')
      LIMIT 1
    `, [op.position_id]);
    if (alerteBloquante && !hasRole(req.user, 'admin')) {
      return res.status(403).json({
        error: `Paiement bloqué — alerte active : ${alerteBloquante.message}`,
        alerte_id: alerteBloquante.id,
        bloquant: true
      });
    }
  }

  // Vérification de solde rapide hors-transaction (early return sur cas évident).
  // NOTE : cette vérification n'est PAS définitive — une vérification stricte
  // avec verrou est refaite à l'intérieur de la transaction ci-dessous.
  if (!req.body?.override_solde) {
    const soldeDisponible = await getSoldePosition(op.position_id, op.id);
    if (safe(soldeDisponible) < safe(op.montant)) {
      return res.status(409).json({
        error: `Paiement impossible : solde insuffisant sur la position de trésorerie — disponible ${new Intl.NumberFormat('fr-FR').format(safe(soldeDisponible))} XAF`,
        solde_disponible: safe(soldeDisponible),
        montant: safe(op.montant),
        bloquant: true
      });
    }
  }

  // Transaction atomique — UPDATE conditionnel sur dec_statut='valide'
  // Verrou pessimiste sur cashbox_balances (FOR UPDATE) pour éviter le découvert concurrent.
  let paid = false;
  let concurrentSoldeError = null;
  try { await db.transaction(async (tx) => {
    // 1. Verrouiller la ligne cashbox_balances AVANT de lire le solde.
    //    Toute transaction concurrente sur la même position sera bloquée ici
    //    jusqu'au COMMIT de celle-ci — empêche le double-spend.
    const bal = await tx.queryOne(
      'SELECT solde_courant FROM cashbox_balances WHERE caisse_id = ? FOR UPDATE',
      [op.position_id]
    );
    const soldeBefore = bal != null ? safe(bal.solde_courant) : await getSoldePosition(op.position_id, op.id);

    // 2. Re-vérifier le solde DANS la transaction avec le verrou tenu.
    if (soldeBefore < safe(op.montant) && !req.body?.override_solde) {
      throw Object.assign(new Error('SOLDE_INSUFFISANT'), {
        solde_disponible: soldeBefore,
        montant: safe(op.montant),
      });
    }

    // 3. Transition d'état atomique — condition sur dec_statut garantit l'idempotence.
    const info = await tx.execute(`
      UPDATE operations SET
        dec_statut = 'paye',
        statut     = 'valide',
        paid_by    = ?,
        paid_at    = NOW(),
        treasury_status = 'synced',
        accounting_status = 'pending',
        budget_status = 'pending',
        allocation_status = 'pending',
        updated_at = NOW()
      WHERE id = ? AND dec_statut = 'valide'
    `, [req.user.id, op.id]);
    paid = info.affectedRows === 1;

    if (paid) {
      // 4. Écriture cash_ledger (append-only) et mise à jour cashbox_balances.
      //    Ces deux écritures font partie de la même transaction — elles réussissent
      //    ensemble ou échouent ensemble. Ne pas avaler l'erreur ici.
      const soldeAfter = soldeBefore - safe(op.montant);
      await tx.execute(`
        INSERT INTO cash_ledger (caisse_id, operation_id, type_mouvement, montant, solde_avant, solde_apres, reference, created_by)
        VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)
      `, [op.position_id, op.id, safe(op.montant), soldeBefore, soldeAfter, op.num_piece || null, req.user.id]);
      await tx.execute(`
        INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at)
        VALUES (?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE solde_courant = VALUES(solde_courant),
          derniere_operation_id = VALUES(derniere_operation_id), updated_at = VALUES(updated_at)
      `, [op.position_id, soldeAfter, op.id]);
    }
  }); } catch (txErr) {
    if (txErr.message === 'SOLDE_INSUFFISANT') {
      concurrentSoldeError = txErr;
    } else {
      throw txErr;
    }
  }

  if (concurrentSoldeError) {
    return res.status(409).json({
      error: `Paiement impossible : solde insuffisant après vérification concurrente — disponible ${new Intl.NumberFormat('fr-FR').format(concurrentSoldeError.solde_disponible)} XAF`,
      solde_disponible: concurrentSoldeError.solde_disponible,
      montant: concurrentSoldeError.montant,
      bloquant: true
    });
  }

  if (!paid) return res.status(409).json({ error: 'Conflit : décaissement déjà traité (double requête ?)' });

  recalculateSoldes().catch(() => {});
  await auditDec(op.id, 'dec_paye', { montant: op.montant, libelle: op.libelle, position_id: op.position_id }, req.user.id);
  const paidOperation = await db.queryOne('SELECT * FROM operations WHERE id = ?', [op.id]);
  await ensureOperationSyncErrors(paidOperation, req.user.id);
  await attemptAutomaticAccountingForOperation({
    operationId: op.id,
    userId: req.user.id,
  });

  setImmediate(() => {
    try {
      resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', op.id);
      evaluerAlerteSoldes();
      creerNotification({
        type:     'NOTIF_OP_CREE',
        titre:    'Décaissement payé',
        message:  `${op.libelle} — ${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF`,
        srcTable: 'operations',
        srcId:    op.id,
        createdBy: req.user.id,
      });
    } catch (_) {}
  });

  res.json({ ok: true, dec_statut: 'paye', montant: op.montant });
});

// ─── GET /:id/historique — audit trail d'un décaissement ─────────────────────
router.get('/:id/historique', async (req, res) => {
  const rows = await db.query(`
    SELECT a.id, a.action, a.details, a.created_at,
           u.nom as user_nom, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.table_name = 'operations' AND a.record_id = ?
    ORDER BY a.created_at ASC
  `, [req.params.id]);
  res.json(rows.map(r => ({
    ...r,
    details: (() => { try { return JSON.parse(r.details); } catch { return r.details; } })()
  })));
});

// ─── PUT /:id/annuler — tout statut non payé → annulé (motif obligatoire) ────
router.put('/:id/annuler', async (req, res) => {
  // Q2 — annulation élargie à finance+dg+admin (avant paiement)
  if (!hasRole(req.user, ...DEC_CANCEL_ROLES)) return res.status(403).json({ error: 'Admin, Finance ou DG requis pour annuler' });
  const op = await getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut === 'paye' || op.statut === 'valide') {
    return res.status(400).json({ error: 'Décaissement déjà payé — créez une opération inverse pour le contrepasser' });
  }
  if (op.statut === 'annule') return res.status(400).json({ error: 'Déjà annulé' });

  const { motif } = req.body;
  if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif d\'annulation obligatoire' });

  await db.execute(`
    UPDATE operations SET
      statut       = 'annule',
      dec_statut   = 'annule',
      annule_by    = ?,
      annule_at    = NOW(),
      annule_motif = ?,
      updated_at   = NOW()
    WHERE id = ?
  `, [req.user.id, String(motif).trim(), op.id]);

  const anomaliesFermees = await resolveOperationSyncErrors(op.id, req.user.id);

  await auditDec(op.id, 'dec_annule', {
    motif: String(motif).trim(), ancien_statut: op.dec_statut, montant: op.montant,
    anomalies_fermees: anomaliesFermees,
  }, req.user.id);

  setImmediate(() => {
    try {
      resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', op.id);
      evaluerAlerteSoldes();
      creerNotification({
        type:     'NOTIF_OP_ANNULE',
        titre:    'Opération annulée',
        message:  `${op.libelle} — ${new Intl.NumberFormat('fr-FR').format(op.montant)} XAF. Motif : ${String(motif).trim()}`,
        srcTable: 'operations',
        srcId:    op.id,
        createdBy: req.user.id,
      });
    } catch (_) {}
  });

  res.json({ ok: true, dec_statut: 'annule' });
});

// ═══════════════════════════════════════════════════════════════════════════
// BILAN MENSUEL DIRIGEANT — synthèse consolidée trésorerie + RH + achats + alertes
// ═══════════════════════════════════════════════════════════════════════════

router.get('/bilan-mensuel', async (req, res) => {
  const m = Number(req.query.mois)  || new Date().getMonth() + 1;
  const a = Number(req.query.annee) || new Date().getFullYear();

  const debut   = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin     = `${a}-${String(m).padStart(2,'0')}-31`;
  const today   = new Date().toISOString().slice(0,10);
  const in30    = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,10);

  // ── Mois précédent ──
  const prevM   = m === 1 ? 12 : m - 1;
  const prevA   = m === 1 ? a - 1 : a;
  const prevDeb = `${prevA}-${String(prevM).padStart(2,'0')}-01`;
  const prevFin = `${prevA}-${String(prevM).padStart(2,'0')}-31`;

  // ── 1. TRÉSORERIE ────────────────────────────────────────────────────────
  const positions = await db.query("SELECT * FROM positions WHERE actif=1 ORDER BY ordre");
  const positionsAvecSolde = await Promise.all(positions.map(async p => ({ ...p, solde: await getSoldePosition(p.id) })));
  const tresorerieTotale   = positionsAvecSolde.reduce((s,p) => s + p.solde, 0);

  const fluxMois = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements,
      COUNT(*) as nb_operations
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
  `, [debut, fin]);

  const fluxPrev = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
  `, [prevDeb, prevFin]);

  const soldeNet = safe(fluxMois.encaissements) - safe(fluxMois.decaissements);

  // Top 5 dépenses du mois par catégorie
  const topDepenses = await db.query(`
    SELECT c.nom, c.couleur, COALESCE(SUM(o.montant),0) as total, COUNT(*) as nb
    FROM operations o JOIN categories c ON o.categorie_id=c.id
    WHERE o.statut='valide' AND o.type_op='decaissement' AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC LIMIT 5
  `, [debut, fin]);

  // Évolution journalière du mois
  const evolution = await db.query(`
    SELECT date,
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
    GROUP BY date ORDER BY date ASC
  `, [debut, fin]);

  // Décaissements en attente
  // Un décaissement importé porte dec_statut NULL : il n'est jamais entré dans
  // le parcours de validation, il n'attend donc rien. Le compter comme un
  // brouillon annonçait 37 149 361 XAF en attente là où il n'y avait rien.
  const decEnAttente = await db.queryOne(`
    SELECT COUNT(*) as nb, COALESCE(SUM(montant),0) as total
    FROM operations
    WHERE type_op='decaissement'
      AND dec_statut IN ('brouillon','soumis','valide')
      AND statut <> 'annule'
  `);

  // ── 2. MASSE SALARIALE ───────────────────────────────────────────────────
  const masseSalarialeRow = await db.queryOne(
    "SELECT COALESCE(SUM(brut),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?",
    [m, a]
  );
  const masseSalarialeBrute = masseSalarialeRow.total;

  const masseSalarialeNetteRow = await db.queryOne(
    "SELECT COALESCE(SUM(net_a_payer),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?",
    [m, a]
  );
  const masseSalarialeNette = masseSalarialeNetteRow.total;

  const bulletinsParStatut = await db.query(`
    SELECT statut, COUNT(*) as nb, COALESCE(SUM(net_a_payer),0) as total
    FROM bulletins_salaire WHERE mois=? AND annee=?
    GROUP BY statut
  `, [m, a]);

  const chargesPatronalesRow = await db.queryOne(
    "SELECT COALESCE(SUM(cnss_patronal+camu_patronal),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?",
    [m, a]
  );
  const chargesPatronales = chargesPatronalesRow.total;

  // Masse salariale mois précédent (comparaison)
  const massePrevRow = await db.queryOne(
    "SELECT COALESCE(SUM(net_a_payer),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?",
    [prevM, prevA]
  );
  const massePrev = massePrevRow.total;

  // ── 3. EFFECTIFS RH ──────────────────────────────────────────────────────
  const effectifTotalRow   = await db.queryOne("SELECT COUNT(*) as c FROM employes WHERE actif=1");
  const effectifTotal      = effectifTotalRow.c;
  const effectifActifsRow  = await db.queryOne("SELECT COUNT(*) as c FROM employes WHERE actif=1 AND statut_dossier='actif'");
  const effectifActifs     = effectifActifsRow.c;
  const contratsExpJ30Row  = await db.queryOne(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND date_fin_contrat BETWEEN ? AND ?",
    [today, in30]
  );
  const contratsExpJ30     = contratsExpJ30Row.c;
  const essaisExpJ30Row    = await db.queryOne(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND date_fin_essai BETWEEN ? AND ?",
    [today, in30]
  );
  const essaisExpJ30       = essaisExpJ30Row.c;
  const avancesEnCours     = await db.queryOne(
    "SELECT COUNT(*) as nb, COALESCE(SUM(solde_restant),0) as total FROM employes_avances WHERE statut='en_cours'"
  );
  const docsExpiresRow     = await db.queryOne(
    "SELECT COUNT(*) as c FROM employes_documents WHERE date_expiration IS NOT NULL AND date_expiration < ?",
    [today]
  );
  const docsExpires        = docsExpiresRow.c;

  // ── 4. ACHATS ────────────────────────────────────────────────────────────
  const achatsDuMois = await db.query(`
    SELECT statut, COUNT(*) as nb, COALESCE(SUM(total_general),0) as total
    FROM demandes_achat WHERE date_demande BETWEEN ? AND ?
    GROUP BY statut
  `, [debut, fin]);

  const achatsSoumis   = achatsDuMois.find(r => r.statut==='soumis')   || { nb:0, total:0 };
  const achatsApprouves= achatsDuMois.find(r => r.statut==='approuve') || { nb:0, total:0 };
  const achatsRejetes  = achatsDuMois.find(r => r.statut==='rejete')   || { nb:0, total:0 };
  const achatsBrouillon= achatsDuMois.find(r => r.statut==='brouillon')|| { nb:0, total:0 };

  // Total engagé ce mois (approuvés)
  const totalEngageMois = safe(achatsApprouves.total);

  // ── 5. ALERTES ACTIVES ───────────────────────────────────────────────────
  const alertes = await db.query(`
    SELECT type, priorite, titre, message, statut, created_at
    FROM alertes_actives
    WHERE statut NOT IN ('resolue')
    ORDER BY CASE priorite WHEN 'bloquant' THEN 1 WHEN 'critique' THEN 2 WHEN 'avertissement' THEN 3 ELSE 4 END, created_at DESC
    LIMIT 10
  `);

  const alertesParPrio = { bloquant:0, critique:0, avertissement:0, info:0 };
  alertes.forEach(a => { if (alertesParPrio[a.priorite] !== undefined) alertesParPrio[a.priorite]++; });

  // ── 6. VARIATIONS MoM (%) ────────────────────────────────────────────────
  // MySQL rend les DECIMAL en chaines : « 0.00 » est verite en JavaScript.
  // Sans conversion, !prev est faux pour un mois precedent a zero, et le calcul
  // produit NaN — serialise en null, puis affiche comme une baisse de 0 %.
  function pct(curr, prev) {
    const c = Number(curr) || 0;
    const p = Number(prev) || 0;
    if (!p) return c > 0 ? 100 : 0;
    return Math.round((c - p) / p * 100);
  }

  const societeRow = await db.queryOne("SELECT valeur FROM parametres WHERE cle='societe'");
  const societe = societeRow?.valeur || 'TOP CENTER';
  const deviseRow = await db.queryOne("SELECT valeur FROM parametres WHERE cle='devise'");
  const devise  = deviseRow?.valeur  || 'XAF';

  res.json({
    meta: { mois: m, annee: a, debut, fin, societe, devise, genere_le: new Date().toISOString() },

    tresorerie: {
      positions: positionsAvecSolde,
      total: safe(tresorerieTotale),
      encaissements: safe(fluxMois.encaissements),
      decaissements: safe(fluxMois.decaissements),
      solde_net:     safe(soldeNet),
      nb_operations: safe(fluxMois.nb_operations),
      prev_encaissements: safe(fluxPrev.encaissements),
      prev_decaissements: safe(fluxPrev.decaissements),
      var_enc_pct: pct(fluxMois.encaissements, fluxPrev.encaissements),
      var_dec_pct: pct(fluxMois.decaissements, fluxPrev.decaissements),
      top_depenses: topDepenses,
      evolution,
      dec_en_attente: { nb: safe(decEnAttente.nb), total: safe(decEnAttente.total) },
    },

    salaires: {
      masse_brute:      safe(masseSalarialeBrute),
      masse_nette:      safe(masseSalarialeNette),
      charges_patronales: safe(chargesPatronales),
      cout_total_employeur: safe(masseSalarialeBrute) + safe(chargesPatronales),
      prev_masse_nette: safe(massePrev),
      var_masse_pct:    pct(masseSalarialeNette, massePrev),
      par_statut:       bulletinsParStatut,
    },

    rh: {
      effectif_total:  effectifTotal,
      effectif_actifs: effectifActifs,
      contrats_exp_j30: contratsExpJ30,
      essais_exp_j30:   essaisExpJ30,
      avances_en_cours: { nb: safe(avancesEnCours.nb), total: safe(avancesEnCours.total) },
      docs_expires:     docsExpires,
    },

    achats: {
      soumis:    { nb: safe(achatsSoumis.nb),    total: safe(achatsSoumis.total) },
      approuves: { nb: safe(achatsApprouves.nb), total: safe(achatsApprouves.total) },
      rejetes:   { nb: safe(achatsRejetes.nb),   total: safe(achatsRejetes.total) },
      brouillon: { nb: safe(achatsBrouillon.nb), total: safe(achatsBrouillon.total) },
      total_engage: totalEngageMois,
    },

    alertes: {
      liste:    alertes,
      par_priorite: alertesParPrio,
      total_actives: alertes.length,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLÔTURE DE PÉRIODE — verrouille un mois pour empêcher toute modification
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /clotures — liste des périodes clôturées ─────────────────────────────
router.get('/clotures', async (req, res) => {
  const rows = await db.query(`
    SELECT p.*, u.nom as cloture_par_nom
    FROM periodes_cloturees p
    LEFT JOIN users u ON u.id = p.cloture_by
    ORDER BY p.annee DESC, p.mois DESC
  `);
  res.json(rows);
});

// ─── POST /clotures — clôturer un mois (admin uniquement) ────────────────────
router.post('/clotures', async (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis pour clôturer une période' });
  const { mois, annee, notes } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
  const m = Number(mois); const a = Number(annee);
  if (m < 1 || m > 12 || a < 2000) return res.status(400).json({ error: 'mois ou annee invalide' });

  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin   = `${a}-${String(m).padStart(2,'0')}-31`;
  const nbEnAttenteRow = await db.queryOne(
    `SELECT COUNT(*) as c
     FROM operations
     WHERE type_op='decaissement'
       AND dec_statut IN ('brouillon','soumis','valide')
       AND statut <> 'annule'
       AND date BETWEEN ? AND ?`,
    [debut, fin]
  );
  const nbEnAttente = nbEnAttenteRow.c;
  if (nbEnAttente > 0) {
    return res.status(400).json({ error: `Impossible de clôturer : ${nbEnAttente} opération(s) encore en attente pour cette période.` });
  }

  try {
    await db.execute(
      `INSERT INTO periodes_cloturees (annee, mois, cloture_by, notes) VALUES (?,?,?,?)`,
      [a, m, req.user.id, notes || null]
    );
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
      ['periodes_cloturees', 0, 'cloture', JSON.stringify({ annee: a, mois: m }), req.user.id]);
    res.json({ ok: true, annee: a, mois: m });
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.message.includes('Duplicate')) return res.status(409).json({ error: 'Période déjà clôturée' });
    throw e;
  }
});

// ─── DELETE /clotures/:annee/:mois — réouvrir une période (admin) ─────────────
router.delete('/clotures/:annee/:mois', async (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const { annee, mois } = req.params;
  const r = await db.execute(`DELETE FROM periodes_cloturees WHERE annee=? AND mois=?`, [Number(annee), Number(mois)]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Période non clôturée' });
  await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
    ['periodes_cloturees', 0, 'reouverture', JSON.stringify({ annee, mois }), req.user.id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLÔTURE QUOTIDIENNE PAR CAISSE (Q6) — cashbox_closures
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /clotures/quotidiennes — liste des clôtures par caisse ──────────────
router.get('/clotures/quotidiennes', async (req, res) => {
  const { caisse_id, date_debut, date_fin } = req.query;
  let where = '1=1';
  const params = [];
  if (caisse_id) { where += ' AND cc.caisse_id = ?'; params.push(Number(caisse_id)); }
  if (date_debut) { where += ' AND cc.date_cloture >= ?'; params.push(date_debut); }
  if (date_fin)   { where += ' AND cc.date_cloture <= ?'; params.push(date_fin); }

  const rows = await db.query(`
    SELECT cc.*, p.libelle as caisse_nom,
           uc.nom as cloture_par_nom, ur.nom as reouverture_par_nom
    FROM cashbox_closures cc
    LEFT JOIN positions p ON cc.caisse_id = p.id
    LEFT JOIN users uc ON cc.cloture_par = uc.id
    LEFT JOIN users ur ON cc.reouverture_par = ur.id
    WHERE ${where}
    ORDER BY cc.date_cloture DESC, cc.caisse_id ASC
  `, params);
  res.json(rows);
});

// ─── POST /clotures/quotidiennes — clôturer une caisse pour aujourd'hui ────────
router.post('/clotures/quotidiennes', async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'caissier')) {
    return res.status(403).json({ error: 'Rôle caissier, finance ou admin requis pour clôturer' });
  }
  const { caisse_id, date_cloture, solde_cloture_saisi } = req.body;
  if (!caisse_id) return res.status(400).json({ error: 'caisse_id requis' });

  const dateCloture = date_cloture || new Date().toISOString().split('T')[0];

  // Vérifier qu'il n'y a pas déjà une clôture pour cette caisse/date
  const existing = await db.queryOne('SELECT id FROM cashbox_closures WHERE caisse_id=? AND date_cloture=?', [caisse_id, dateCloture]);
  if (existing) return res.status(409).json({ error: `Caisse déjà clôturée pour le ${dateCloture}` });

  // Calculer solde ouverture (clôture précédente ou solde initial)
  const derniereCloture = await db.queryOne(`
    SELECT solde_cloture FROM cashbox_closures
    WHERE caisse_id = ? AND statut = 'cloturee'
    ORDER BY date_cloture DESC LIMIT 1
  `, [caisse_id]);
  const pos = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [caisse_id]);
  const soldeOuverture = derniereCloture ? derniereCloture.solde_cloture : (pos ? safe(pos.solde_initial) : 0);

  // Calculer flux de la journée
  const flux = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as total_enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as total_dec
    FROM operations
    WHERE statut='valide' AND date=? AND position_id=?
  `, [dateCloture, caisse_id]);

  const soldeCloture = solde_cloture_saisi != null ? Number(solde_cloture_saisi) : await getSoldePosition(Number(caisse_id));
  const soldeAttendu = soldeOuverture + safe(flux.total_enc) - safe(flux.total_dec);
  const ecart = soldeCloture - soldeAttendu;

  const result = await db.execute(`
    INSERT INTO cashbox_closures
      (caisse_id, date_cloture, solde_ouverture, solde_cloture, total_encaissements, total_decaissements, ecart, cloture_par)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [Number(caisse_id), dateCloture, soldeOuverture, soldeCloture, safe(flux.total_enc), safe(flux.total_dec), ecart, req.user.id]);

  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
      ['cashbox_closures', result.insertId, 'cloture_quotidienne',
        JSON.stringify({ caisse_id, date_cloture: dateCloture, solde_ouverture: soldeOuverture, solde_cloture: soldeCloture, ecart }),
        req.user.id]);
  } catch (_) {}

  res.status(201).json({
    ok: true,
    id: result.insertId,
    caisse_id, date_cloture: dateCloture,
    solde_ouverture: soldeOuverture,
    solde_cloture: soldeCloture,
    total_encaissements: safe(flux.total_enc),
    total_decaissements: safe(flux.total_dec),
    ecart,
  });
});

// ─── PUT /clotures/quotidiennes/:id/reouvrir — réouverture (finance+dg+motif) ──
router.put('/clotures/quotidiennes/:id/reouvrir', async (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg')) {
    return res.status(403).json({ error: 'Finance, DG ou Admin requis pour réouvrir une clôture' });
  }
  const { motif } = req.body;
  if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif de réouverture obligatoire' });

  const closure = await db.queryOne('SELECT * FROM cashbox_closures WHERE id = ?', [req.params.id]);
  if (!closure) return res.status(404).json({ error: 'Clôture non trouvée' });
  if (closure.statut === 'reopened') return res.status(400).json({ error: 'Clôture déjà réouverte' });

  await db.execute(`
    UPDATE cashbox_closures SET
      statut = 'reopened',
      reouverture_par = ?,
      reouverture_motif = ?,
      updated_at = NOW()
    WHERE id = ?
  `, [req.user.id, String(motif).trim(), req.params.id]);

  try {
    await db.execute('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
      ['cashbox_closures', closure.id, 'reouverture_quotidienne', JSON.stringify({ motif: String(motif).trim() }), req.user.id]);
  } catch (_) {}

  res.json({ ok: true, statut: 'reopened' });
});

// ─── GET /clotures/quotidiennes/check — vérifier si une date est clôturée ──────
router.get('/clotures/quotidiennes/check', async (req, res) => {
  const { caisse_id, date } = req.query;
  if (!caisse_id || !date) return res.status(400).json({ error: 'caisse_id et date requis' });
  const closure = await db.queryOne(`
    SELECT id FROM cashbox_closures
    WHERE caisse_id = ? AND date_cloture = ? AND statut = 'cloturee'
  `, [Number(caisse_id), date]);
  res.json({ cloture: !!closure });
});

// ─── Templates d'import Excel ────────────────────────────────────────────────
// GET /api/operations/templates/import?type=encaissement|decaissement|virement
// Génère un vrai .xlsx avec en-têtes stylés, listes déroulantes et exemples.
const XLSX = require('xlsx');
const multer = require('multer');
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Convertit une date saisie (DD/MM/YYYY ou YYYY-MM-DD ou texte Excel) en YYYY-MM-DD
function parseImportDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // Format DD/MM/YYYY
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  // Format YYYY-MM-DD déjà correct
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Numéro de série Excel (jours depuis 1900-01-01)
  const n = Number(s);
  if (!isNaN(n) && n > 1000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return d.toISOString().split('T')[0];
  }
  return null;
}

async function buildImportXlsx(type) {
  const cats     = await db.query("SELECT id, nom, type FROM categories WHERE actif=1 ORDER BY type, nom");
  const positions = await db.query("SELECT id, code, libelle FROM positions WHERE actif=1 ORDER BY id");

  // Accepter les deux conventions de type (encaissement/recette, decaissement/depense)
  const catTypeMatch = (c) => {
    if (type === 'virement') return true;
    if (type === 'encaissement') return c.type === 'encaissement' || c.type === 'recette';
    if (type === 'decaissement') return c.type === 'decaissement' || c.type === 'depense';
    return false;
  };

  const wb = XLSX.utils.book_new();

  // ── Feuille AIDE (premier onglet) ────────────────────────────────────────
  const posLines  = positions.map(p => [`${p.code} — ${p.libelle}`, `ID = ${p.id}`]);
  const catLines  = cats.filter(catTypeMatch).map(c => [c.nom, `(${c.type})`]);
  const aideData  = [
    ['MODÈLE D\'IMPORT — ' + type.toUpperCase(), ''],
    ['', ''],
    ['FORMAT DES DATES', 'Écrire au format JJ/MM/AAAA  (ex: 02/01/2025)'],
    ['MONTANTS',         'Nombres entiers sans espace ni symbole  (ex: 250000)'],
    ['MODE RÈGLEMENT',   'especes  /  virement_bancaire  /  cheque  /  mobile_money  /  autres'],
    ['', ''],
    ['CAISSES / COMPTES DISPONIBLES', ''],
    ...posLines,
    ['', ''],
    ['RUBRIQUES DISPONIBLES', ''],
    ...catLines,
  ];
  const wsAide = XLSX.utils.aoa_to_sheet(aideData);
  wsAide['!cols'] = [{ wch: 38 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, wsAide, 'AIDE');

  // ── Feuille données ──────────────────────────────────────────────────────
  const catNoms    = cats.filter(catTypeMatch).map(c => c.nom);
  const posChoices = positions.map(p => `${p.id} - ${p.code}`);
  const modeList   = ['especes', 'virement_bancaire', 'cheque', 'mobile_money', 'autres'];
  const benefList  = ['employe', 'fournisseur', 'client', 'autre'];

  let headers, examples, colWidths, validations;

  if (type === 'encaissement') {
    headers   = ['Date (JJ/MM/AAAA)','N° Pièce','Libellé','Tiers / Client','Montant (FCFA)','Mode règlement','Rubrique','Caisse / Compte','Référence externe'];
    examples  = [
      ['02/01/2025','REC-001','Règlement facture F-2025-001','CLIENT ALPHA',250000,'virement_bancaire',catNoms[0]||'',posChoices[0]||'',''],
      ['05/01/2025','REC-002','Avance client','Agence BETA',100000,'especes',catNoms[0]||'',posChoices[0]||'','AGC-2025-01'],
      ['10/01/2025','REC-003','Remboursement frais','Ministère Finances',75000,'cheque',catNoms[1]||catNoms[0]||'',posChoices[0]||'',''],
    ];
    colWidths = [18,14,38,28,16,20,24,22,22];
    validations = { F: modeList, G: catNoms, H: posChoices };

  } else if (type === 'decaissement') {
    headers   = ['Date (JJ/MM/AAAA)','N° Pièce','Libellé','Fournisseur / Bénéficiaire','Montant (FCFA)','Mode règlement','Rubrique','Caisse / Compte','Référence externe','Type bénéficiaire'];
    examples  = [
      ['03/01/2025','DEC-001','Achat fournitures bureau','PAPETERIE CENTRALE',45000,'especes',catNoms[0]||'',posChoices[0]||'','','fournisseur'],
      ['07/01/2025','DEC-002','Carburant véhicule DG','TOTAL ENERGIE',80000,'especes',catNoms[0]||'',posChoices[0]||'','','fournisseur'],
      ['15/01/2025','DEC-003','Loyer bureau janvier 2025','SCI IMMO',350000,'virement_bancaire',catNoms[1]||catNoms[0]||'',posChoices[0]||'','BC-2025-01','fournisseur'],
    ];
    colWidths = [18,14,38,30,16,20,24,22,22,18];
    validations = { F: modeList, G: catNoms, H: posChoices, J: benefList };

  } else { // virement
    headers   = ['Date (JJ/MM/AAAA)','N° Pièce','Libellé','Montant (FCFA)','Caisse source','Caisse destination','Référence externe'];
    examples  = [
      ['04/01/2025','VIR-001','Approvisionnement caisse espèces',500000,posChoices[1]||posChoices[0]||'',posChoices[0]||'',''],
      ['11/01/2025','VIR-002','Versement banque excédent caisse',1200000,posChoices[0]||'',posChoices[1]||posChoices[0]||'','VIR-BQ-01'],
    ];
    colWidths = [18,14,38,16,22,22,22];
    validations = { E: posChoices, F: posChoices };
  }

  const wsData = XLSX.utils.aoa_to_sheet([headers, ...examples]);

  // Style en-tête (fond bleu, texte blanc)
  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: { fgColor: { rgb: '1A50D9' } }, alignment: { horizontal: 'center', wrapText: true }, border: { bottom: { style: 'thin', color: { rgb: 'FFFFFF' } } } };
  headers.forEach((_, ci) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c: ci });
    if (!wsData[addr]) wsData[addr] = {};
    wsData[addr].s = headerStyle;
  });

  // Largeurs colonnes
  wsData['!cols'] = colWidths.map(wch => ({ wch }));

  // Hauteur ligne en-tête
  wsData['!rows'] = [{ hpt: 36 }];

  // Listes déroulantes via data validation
  const maxRows = 1000;
  const colLetters = Object.keys(validations);
  const dataValidations = colLetters.map(col => ({
    sqref: `${col}2:${col}${maxRows}`,
    type: 'list',
    formula1: `"${validations[col].join(',')}"`,
  }));
  if (dataValidations.length) wsData['!dataValidation'] = dataValidations;

  // Figer la ligne d'en-tête
  wsData['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, wsData, type === 'encaissement' ? 'Encaissements' : type === 'decaissement' ? 'Décaissements' : 'Virements');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

router.get('/templates/import', async (req, res) => {
  const type = req.query.type || 'encaissement';
  if (!['encaissement', 'decaissement', 'virement'].includes(type)) {
    return res.status(400).json({ error: 'type invalide — valeurs: encaissement, decaissement, virement' });
  }

  const buf = await buildImportXlsx(type);
  const filename = `modele-import-${type}-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

// ─── Import en masse ──────────────────────────────────────────────────────────
// POST /api/operations/import — accepte un fichier .xlsx ou .csv
// Retourne { imported, errors[] } — transactionnel, rollback total si > 20% d'erreurs
router.post('/import', uploadMem.single('file'), async (req, res) => {
  if (!await canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ: file)' });

  const type = (req.body.type || 'encaissement').toLowerCase();
  if (!['encaissement', 'decaissement', 'virement'].includes(type)) {
    return res.status(400).json({ error: 'type invalide' });
  }
  // RBAC
  if (type === 'encaissement' && !hasRole(req.user, ...ENC_CREATE_ROLES)) {
    return res.status(403).json({ error: 'Import encaissements réservé aux rôles caissier, finance, admin ou DG' });
  }

  // Parse du fichier
  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier illisible — format .xlsx ou .csv requis' });
  }

  // Prendre la première feuille non nommée "AIDE"
  const sheetName = wb.SheetNames.find(n => n !== 'AIDE') || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rows.length < 2) return res.status(400).json({ error: 'Fichier vide ou sans données' });

  // Normalise l'en-tête : on cherche les colonnes par mot-clé insensible à la casse
  const rawHeaders = rows[0].map(h => String(h).toLowerCase().trim());
  const col = (keywords) => {
    const i = rawHeaders.findIndex(h => keywords.some(k => h.includes(k)));
    return i >= 0 ? i : null;
  };

  const idxDate    = col(['date']);
  const idxPiece   = col(['pièce','piece','n°','num']);
  const idxLib     = col(['libellé','libelle']);
  const idxTiers   = col(['tiers','client','fournisseur','bénéficiaire','beneficiaire']);
  const idxMontant = col(['montant']);
  const idxMode    = col(['mode','règlement','reglement']);
  const idxCat     = col(['rubrique','catégorie','categorie']);
  const idxPos     = col(['caisse','compte','position']);
  const idxRef     = col(['référence','reference','ref']);
  const idxBenef   = col(['type bénéf','beneficiaire_type','type ben']);
  const idxSrc     = col(['source']);
  const idxDest    = col(['destination','dest']);

  if (idxDate === null || idxLib === null || idxMontant === null) {
    return res.status(400).json({ error: 'Colonnes obligatoires introuvables : Date, Libellé, Montant' });
  }

  // Charger les référentiels pour résolution par nom
  const cats     = await db.query("SELECT id, nom, type FROM categories WHERE actif=1");
  const positions = await db.query("SELECT id, code, libelle FROM positions WHERE actif=1");

  function resolveCategorie(val) {
    if (!val) return null;
    const s = String(val).trim().toLowerCase();
    // Filtre par type compatible avec le type d'import (accepte anciens types recette/depense)
    const compatTypes = type === 'encaissement'
      ? ['encaissement', 'recette']
      : type === 'decaissement'
        ? ['decaissement', 'depense']
        : null; // virement : pas de catégorie
    const pool = compatTypes ? cats.filter(c => compatTypes.includes(c.type)) : cats;
    const c = pool.find(c => c.nom.toLowerCase() === s) || pool.find(c => c.nom.toLowerCase().includes(s));
    return c ? c.id : null;
  }
  function resolvePosition(val) {
    if (!val) return positions[0]?.id || 1;
    const s = String(val).trim();
    // "1 - CAISSE" → prend le numéro avant " - "
    const byId = positions.find(p => String(p.id) === s || s.startsWith(String(p.id) + ' ') || s.startsWith(String(p.id) + '-'));
    if (byId) return byId.id;
    const byCode = positions.find(p => p.code.toLowerCase() === s.toLowerCase());
    return byCode ? byCode.id : (positions[0]?.id || 1);
  }

  const errors = [];
  const toInsert = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    // Ligne vide ?
    if (r.every(v => String(v).trim() === '')) continue;

    const rowNum = i + 1;
    const dateRaw = r[idxDate];
    const date    = parseImportDate(dateRaw);
    if (!date) { errors.push({ ligne: rowNum, erreur: `Date invalide : "${dateRaw}" — format attendu JJ/MM/AAAA` }); continue; }

    const montant = Number(String(r[idxMontant]).replace(/\s/g,'').replace(',','.'));
    if (!isFinite(montant) || montant <= 0) { errors.push({ ligne: rowNum, erreur: `Montant invalide : "${r[idxMontant]}"` }); continue; }

    const libelle = String(r[idxLib] || '').trim();
    if (!libelle) { errors.push({ ligne: rowNum, erreur: 'Libellé manquant' }); continue; }

    if (await isPeriodeCloturee(date)) { errors.push({ ligne: rowNum, erreur: `Période ${date.slice(0,7)} clôturée` }); continue; }

    const mode = normalizeMode(idxMode !== null ? String(r[idxMode] || '').trim() : '');

    if (type === 'virement') {
      const posSrc  = resolvePosition(idxSrc  !== null ? r[idxSrc]  : null);
      const posDest = resolvePosition(idxDest !== null ? r[idxDest] : (idxPos !== null ? r[idxPos] : null));
      if (posSrc === posDest) { errors.push({ ligne: rowNum, erreur: 'Source et destination identiques' }); continue; }
      toInsert.push({ date, libelle, num_piece: idxPiece !== null ? String(r[idxPiece]||'').trim()||null : null, montant, type_op: 'virement', position_id: posDest, position_source_id: posSrc, categorie_id: null, mode_reglement: 'virement_bancaire', ref_externe: idxRef !== null ? String(r[idxRef]||'').trim()||null : null, tiers: null, beneficiaire_type: null });
    } else {
      const catId = resolveCategorie(idxCat !== null ? r[idxCat] : null);
      if (!catId) { errors.push({ ligne: rowNum, erreur: `Rubrique introuvable : "${idxCat !== null ? r[idxCat] : ''}" — vérifiez l'onglet AIDE` }); continue; }
      const posId = resolvePosition(idxPos !== null ? r[idxPos] : null);
      const tiers = idxTiers !== null ? String(r[idxTiers]||'').trim()||null : null;
      const ref   = idxRef   !== null ? String(r[idxRef]  ||'').trim()||null : null;
      const benef = valeurDeListe(idxBenef !== null ? r[idxBenef] : null, TYPES_BENEFICIAIRE);
      const numP  = idxPiece !== null ? String(r[idxPiece]||'').trim()||null : null;
      toInsert.push({ date, libelle, num_piece: numP, montant, type_op: type, position_id: posId, position_source_id: null, categorie_id: catId, mode_reglement: mode, ref_externe: ref, tiers, beneficiaire_type: benef });
    }
  }

  // Refuser si trop d'erreurs (> 50% des lignes en erreur, minimum 3)
  const total = toInsert.length + errors.length;
  if (errors.length > 0 && errors.length >= Math.max(3, total * 0.5)) {
    return res.status(422).json({
      error: `${errors.length} erreur(s) sur ${total} lignes — corrigez le fichier et réimportez`,
      errors,
      imported: 0,
    });
  }

  if (toInsert.length === 0) {
    return res.status(422).json({ error: 'Aucune ligne valide à importer', errors, imported: 0 });
  }

  // Insertion transactionnelle
  const isWorkflowDec = type === 'decaissement';
  const statutInsert  = isWorkflowDec ? 'en_attente' : 'valide';
  const decStatut     = isWorkflowDec ? 'brouillon'  : null;

  try {
    await db.transaction(async (tx) => {
      for (const op of toInsert) {
        const legacy = legacyValues({ libelle: op.libelle, num_piece: op.num_piece, montant: op.montant, type_op: op.type_op, solde_position: 0, mode_reglement: op.mode_reglement });
        const result = await tx.execute(`
          INSERT INTO operations
            (date, num_piece, libelle, tiers, montant, type_op, position_id, position_source_id,
             categorie_id, mode_reglement, ref_externe, beneficiaire_type, created_by, statut, dec_statut,
             detail, n_piece, recette, depense, solde, mode_paiement,
             treasury_status, accounting_status, budget_status, allocation_status)
          VALUES
            (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)
        `, [
          op.date, op.num_piece, op.libelle, op.tiers, op.montant, op.type_op,
          op.position_id, op.position_source_id, op.categorie_id, op.mode_reglement,
          op.ref_externe, op.beneficiaire_type, req.user.id, statutInsert, decStatut,
          legacy.detail, legacy.n_piece, legacy.recette, legacy.depense, legacy.mode_paiement,
          ...Object.values(flowStatusesForOperation(op.type_op, statutInsert)),
        ]);
        await ensureOperationSyncErrors({
          ...op,
          id: result.insertId,
          statut: statutInsert,
          ...flowStatusesForOperation(op.type_op, statutInsert),
        }, req.user.id, tx);
        if (!isWorkflowDec) {
          await attemptAutomaticAccountingForOperation({
            operationId: result.insertId,
            userId: req.user.id,
          }, tx);
        }
      }
    });
  } catch (e) {
    return res.status(500).json({ error: 'Erreur base de données : ' + e.message });
  }

  if (!isWorkflowDec) {
    recalculateSoldes().catch(() => {});
    setImmediate(() => { try { evaluerAlerteSoldes(); } catch (_) {} });
  }

  res.json({
    imported: toInsert.length,
    errors,
    message: `${toInsert.length} opération(s) importée(s) avec succès${errors.length ? ` (${errors.length} ligne(s) ignorée(s))` : ''}`,
  });
});

module.exports = router;
module.exports.recalculateSoldes = recalculateSoldes;

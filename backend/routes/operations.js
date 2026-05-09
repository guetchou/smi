/**
 * ROUTES OPÉRATIONS — Convention OHADA
 * Encaissement | Décaissement | Virement interne
 */
const express = require('express');
const db = require('../database');
const router = express.Router();
const operationColumns = new Set(db.prepare('PRAGMA table_info(operations)').all().map(col => col.name));
const { sendMail } = require('../services/email');
const { hasRole } = require('./auth');
const { creerNotification, declencherAlerte, resoudreAlerte, evaluerAlerteSoldes } = require('../services/notif');

// Rôles autorisés pour les opérations financières (décaissement, paiement)
const FINANCE_ROLES = ['admin', 'caissier', 'finance'];
const WRITE_ROLES = ['admin', 'caissier', 'finance', 'rh', 'dg', 'assistante_direction', 'delegue'];

// ─── Helpers ──────────────────────────────────────────────────────────────

function safe(v) { return (isFinite(v) && v !== null) ? v : 0; }

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
  return {
    ...op,
    detail: op.libelle,
    n_piece: op.num_piece,
    recette: op.type_op === 'encaissement' ? montant : 0,
    depense: op.type_op === 'decaissement' ? montant : 0,
    solde: safe(op.solde_position),
    mode_paiement: op.mode_reglement === 'virement_bancaire' ? 'virement' : op.mode_reglement,
    couleur: op.cat_couleur || op.couleur || op.pos_couleur,
  };
}

function hasOperationColumn(column) {
  return operationColumns.has(column);
}

function canFinance(user) {
  return hasRole(user, ...FINANCE_ROLES);
}

function canWrite(user) {
  return hasRole(user, ...WRITE_ROLES);
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
    decharge_signee: body.decharge_signee ?? current.decharge_signee ?? 0,
    employe_id: body.employe_id || current.employe_id || null,
  };
}

/** Vérifie si une date tombe dans une période clôturée */
function isPeriodeCloturee(date) {
  if (!date) return false;
  const d = new Date(date);
  const annee = d.getFullYear();
  const mois  = d.getMonth() + 1;
  return !!db.prepare(`SELECT 1 FROM "periodes_clôturees" WHERE annee=? AND mois=?`).get(annee, mois);
}

/** Calcule le solde d'une position à un instant donné */
function getSoldePosition(positionId, beforeId = null) {
  const pos = db.prepare('SELECT solde_initial FROM positions WHERE id = ?').get(positionId);
  if (!pos) return 0;

  let sql = `SELECT
    COALESCE(SUM(CASE
      WHEN type_op IN ('encaissement','virement') AND position_id = ? THEN montant
      WHEN type_op = 'decaissement'               AND position_id = ? THEN -montant
      WHEN type_op = 'virement'    AND position_source_id = ?         THEN -montant
      ELSE 0 END), 0) as delta
    FROM operations WHERE statut = 'valide'`;
  const params = [positionId, positionId, positionId];
  if (beforeId) { sql += ' AND id < ?'; params.push(beforeId); }

  const row = db.prepare(sql).get(...params);
  return safe(pos.solde_initial) + safe(row.delta);
}

/** Recalcule et stocke solde_position sur toutes les opérations */
function recalculateSoldes() {
  const positions = db.prepare("SELECT id FROM positions WHERE actif = 1").all();
  const update = db.prepare("UPDATE operations SET solde_position = ? WHERE id = ?");
  const tx = db.transaction(() => {
    positions.forEach(pos => {
      const posObj = db.prepare('SELECT solde_initial FROM positions WHERE id = ?').get(pos.id);
      let solde = safe(posObj.solde_initial);
      const ops = db.prepare(`
        SELECT id, type_op, montant, position_id, position_source_id
        FROM operations
        WHERE statut = 'valide'
          AND (position_id = ? OR position_source_id = ?)
        ORDER BY date ASC, id ASC
      `).all(pos.id, pos.id);
      ops.forEach(op => {
        if (op.type_op === 'encaissement' && op.position_id === pos.id) {
          solde += safe(op.montant);
        } else if (op.type_op === 'decaissement' && op.position_id === pos.id) {
          solde -= safe(op.montant);
        } else if (op.type_op === 'virement') {
          if (op.position_id === pos.id)        solde += safe(op.montant); // arrive ici
          if (op.position_source_id === pos.id) solde -= safe(op.montant); // part d'ici
        }
        update.run(solde, op.id);
      });
    });
  });
  tx();
}

recalculateSoldes();

// ─── GET /positions — Soldes de toutes les positions ────────────────────

router.get('/positions', (req, res) => {
  const positions = db.prepare("SELECT * FROM positions WHERE actif = 1 ORDER BY ordre").all();
  const result = positions.map(pos => {
    const solde = getSoldePosition(pos.id);
    const today = new Date().toISOString().split('T')[0];
    const todayFlow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type_op IN ('encaissement','virement') AND position_id = ? THEN montant ELSE 0 END), 0) as enc,
        COALESCE(SUM(CASE WHEN type_op = 'decaissement' AND position_id = ? THEN montant
                          WHEN type_op = 'virement' AND position_source_id = ? THEN montant ELSE 0 END), 0) as dec
      FROM operations WHERE date = ? AND statut = 'valide'
    `).get(pos.id, pos.id, pos.id, today);
    return { ...pos, solde, encaissement_today: safe(todayFlow.enc), decaissement_today: safe(todayFlow.dec) };
  });
  res.json(result);
});

// ─── GET /next-ref — Prochaine référence DEC ────────────────────────────

router.get('/next-ref', (req, res) => {
  const year = new Date().getFullYear();
  const row = db.prepare("SELECT MAX(id) as max_id FROM operations WHERE type_op = 'decaissement'").get();
  const nextId = (row?.max_id || 0) + 1;
  res.json({ ref: `DEC-${year}-${String(nextId).padStart(6, '0')}` });
});

// ─── GET / — Liste des opérations avec filtres ──────────────────────────

router.get('/', (req, res) => {
  const { debut, fin, position_id, categorie_id, search,
          limit = 50, offset = 0, order = 'DESC' } = req.query;
  const type_op = normalizeTypeOp(req.query.type_op || req.query.type);

  let where = "WHERE o.statut = 'valide'";
  const params = [];

  if (debut)       { where += ' AND o.date >= ?'; params.push(debut); }
  if (fin)         { where += ' AND o.date <= ?'; params.push(fin); }
  if (type_op)     { where += ' AND o.type_op = ?'; params.push(type_op); }
  if (position_id) { where += ' AND (o.position_id = ? OR o.position_source_id = ?)'; params.push(position_id, position_id); }
  if (categorie_id){ where += ' AND o.categorie_id = ?'; params.push(categorie_id); }
  if (search)      { where += ' AND o.libelle LIKE ?'; params.push('%' + search + '%'); }

  const ord = order === 'ASC' ? 'ASC' : 'DESC';
  const countSql = `SELECT COUNT(*) as c FROM operations o ${where}`;
  const total = db.prepare(countSql).get(...params).c;

  const sql = `
    SELECT o.*,
      c.nom       as categorie_nom,   c.couleur as cat_couleur, c.type as cat_type,
      p.libelle   as position_libelle, p.type    as position_type, p.couleur as pos_couleur,
      ps.libelle  as position_source_libelle,
      e.nom || ' ' || e.prenom as employe_nom,
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
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));
  const rows = db.prepare(sql).all(...params).map(serializeOperation);

  // Totaux filtrés
  const totSql = `
    SELECT
      COALESCE(SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE 0 END), 0) as total_enc,
      COALESCE(SUM(CASE WHEN type_op = 'decaissement' THEN montant ELSE 0 END), 0) as total_dec,
      COALESCE(SUM(CASE WHEN type_op = 'virement' THEN montant ELSE 0 END), 0) as total_vir
    FROM operations o ${where.replace(/LIMIT.*/, '')}
  `;
  const tots = db.prepare(totSql).get(...params.slice(0, -2));

  res.json({ total, rows, totaux: tots });
});

// ─── POST / — Créer une opération ───────────────────────────────────────

router.post('/', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Accès refusé — Finance ou Admin requis pour créer une opération' });
  const {
    date, num_piece, libelle, tiers, montant, type_op, position_id,
    position_source_id, categorie_id, mode_reglement,
    ref_externe, piece_justificative, decharge_signee, employe_id
  } = normalizeOperationInput(req.body);

  if (!date || !libelle) return res.status(400).json({ error: 'Date et libellé requis' });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: 'Montant doit être > 0' });
  if (!type_op) return res.status(400).json({ error: 'Type opération requis (encaissement/décaissement/virement)' });
  if (!position_id) return res.status(400).json({ error: 'Position requise (Caisse/Banque)' });
  if (type_op === 'virement' && !position_source_id) return res.status(400).json({ error: 'Position source requise pour un virement' });
  if (type_op === 'virement' && Number(position_id) === Number(position_source_id)) return res.status(400).json({ error: 'Source et destination doivent être différentes' });
  if (type_op !== 'virement' && !categorie_id) return res.status(400).json({ error: 'Rubrique comptable requise' });
  if (isPeriodeCloturee(date)) return res.status(400).json({ error: `Période ${date.slice(0,7)} clôturée — aucune écriture autorisée` });

  // Blocage décaissement si alerte bloquante active sur la position (sauf override admin explicite)
  if (type_op === 'decaissement' && !req.body.override_alerte) {
    const alerteBloquante = db.prepare(`
      SELECT id, titre, message FROM alertes_actives
      WHERE position_id = ? AND priorite = 'bloquant' AND statut NOT IN ('resolue','acquittee')
      LIMIT 1
    `).get(position_id);
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
    'piece_justificative', 'decharge_signee', 'employe_id', 'created_by',
    'statut', 'dec_statut'
  ];
  const values = [
    date, num_piece || null, libelle, tiers || null,
    Number(montant), type_op, Number(position_id),
    position_source_id ? Number(position_source_id) : null,
    categorie_id ? Number(categorie_id) : null,
    mode_reglement, ref_externe || null, piece_justificative || null,
    decharge_signee ? 1 : 0, employe_id ? Number(employe_id) : null,
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

  const placeholders = columns.map(() => '?').join(',');
  const result = db.prepare(`INSERT INTO operations (${columns.join(',')}) VALUES (${placeholders})`).run(...values);

  if (!isWorkflowDec) {
    recalculateSoldes();
    setImmediate(() => { try { evaluerAlerteSoldes(); } catch (_) {} });
  }

  const op = db.prepare(`
    SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur
    FROM operations o
    LEFT JOIN positions p ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE o.id = ?
  `).get(result.lastInsertRowid);

  // Notification création (encaissements/virements uniquement — les décaissements sont en brouillon)
  if (!isWorkflowDec) {
    setImmediate(() => {
      try {
        creerNotification({
          type:     'NOTIF_OP_CREE',
          titre:    `${type_op === 'encaissement' ? 'Encaissement' : 'Virement'} enregistré`,
          message:  `${libelle} — ${new Intl.NumberFormat('fr-FR').format(Number(montant))} XAF`,
          srcTable: 'operations',
          srcId:    result.lastInsertRowid,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });
  }

  res.status(201).json(serializeOperation(op));
});

// ─── PUT /:id — Modifier ─────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const op = db.prepare("SELECT * FROM operations WHERE id = ?").get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Opération non trouvée' });
  if (isPeriodeCloturee(op.date)) return res.status(400).json({ error: `Période ${op.date.slice(0,7)} clôturée — modification interdite` });

  const {
    date, num_piece, libelle, tiers, montant, type_op, position_id,
    position_source_id, categorie_id, mode_reglement,
    ref_externe, piece_justificative, decharge_signee, employe_id
  } = normalizeOperationInput(req.body, op);
  if (!date || !libelle) return res.status(400).json({ error: 'Date et libellé requis' });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: 'Montant doit être > 0' });
  if (!position_id) return res.status(400).json({ error: 'Position requise (Caisse/Banque)' });
  if (type_op === 'virement' && !position_source_id) return res.status(400).json({ error: 'Position source requise pour un virement' });
  if (type_op === 'virement' && Number(position_id) === Number(position_source_id)) return res.status(400).json({ error: 'Source et destination doivent être différentes' });
  if (type_op !== 'virement' && !categorie_id) return res.status(400).json({ error: 'Rubrique comptable requise' });

  const assignments = [
    'date=?', 'num_piece=?', 'libelle=?', 'tiers=?', 'montant=?', 'type_op=?',
    'position_id=?', 'position_source_id=?', 'categorie_id=?', 'mode_reglement=?',
    'ref_externe=?', 'piece_justificative=?', 'decharge_signee=?', 'employe_id=?',
    "updated_at=datetime('now')"
  ];
  const values = [
    date, num_piece || null, libelle, tiers || null,
    Number(montant), type_op, Number(position_id),
    position_source_id ? Number(position_source_id) : null,
    categorie_id ? Number(categorie_id) : null,
    mode_reglement || 'especes', ref_externe || null,
    piece_justificative || null, decharge_signee ? 1 : 0,
    employe_id ? Number(employe_id) : null
  ];
  const legacy = legacyValues({ libelle, num_piece, montant, type_op, solde_position: op.solde_position, mode_reglement });
  ['detail', 'n_piece', 'recette', 'depense', 'mode_paiement'].forEach(column => {
    if (hasOperationColumn(column)) {
      assignments.push(`${column}=?`);
      values.push(legacy[column]);
    }
  });
  values.push(req.params.id);
  db.prepare(`UPDATE operations SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

  recalculateSoldes();
  res.json(serializeOperation(db.prepare("SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur FROM operations o LEFT JOIN positions p ON o.position_id=p.id LEFT JOIN categories c ON o.categorie_id=c.id WHERE o.id=?").get(req.params.id)));
});

// ─── DELETE /:id — Annuler ────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const opD = db.prepare("SELECT date FROM operations WHERE id = ?").get(req.params.id);
  if (opD && isPeriodeCloturee(opD.date)) return res.status(400).json({ error: `Période ${opD.date.slice(0,7)} clôturée — annulation interdite` });
  db.prepare("UPDATE operations SET statut = 'annule', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  recalculateSoldes();
  res.json({ ok: true });
});

// ─── GET /kpis/summary — KPIs complets ───────────────────────────────────

router.get('/kpis/summary', (req, res) => {
  const { mois, annee } = req.query;
  const m  = Number(mois)  || new Date().getMonth() + 1;
  const a  = Number(annee) || new Date().getFullYear();

  const moisStr = String(m).padStart(2, '0');
  const moisDebut = `${a}-${moisStr}-01`;
  const moisFin   = `${a}-${moisStr}-31`;

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
  const prevFin   = `${prevA}-${String(prevM).padStart(2,'0')}-31`;

  function getFlows(debut, fin, posId = null) {
    let posFilter = '';
    const p = [debut, fin];
    if (posId) { posFilter = 'AND (o.position_id = ? OR o.position_source_id = ?)'; p.push(posId, posId); }
    return db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type_op = 'encaissement' THEN montant ELSE 0 END), 0) as encaissements,
        COALESCE(SUM(CASE WHEN type_op = 'decaissement' THEN montant ELSE 0 END), 0) as decaissements,
        COALESCE(SUM(CASE WHEN type_op = 'virement'     THEN montant ELSE 0 END), 0) as virements,
        COUNT(*) as nb_ops
      FROM operations o
      WHERE statut = 'valide' AND date BETWEEN ? AND ? ${posFilter}
    `).get(...p);
  }

  // Positions & soldes
  const positions = db.prepare("SELECT * FROM positions WHERE actif = 1 ORDER BY ordre").all();
  const positionsWithSolde = positions.map(p => ({
    ...p,
    solde: getSoldePosition(p.id)
  }));
  const tresTotal = positionsWithSolde.reduce((s, p) => s + p.solde, 0);

  // Flux par période
  const fluxMois     = getFlows(moisDebut, moisFin);
  const fluxAujourd  = getFlows(today, today);
  const fluxSemaine  = getFlows(weekDebut, weekFin);
  const fluxPrevMois = getFlows(prevDebut, prevFin);

  // Évolution journalière du mois
  const evolution = db.prepare(`
    SELECT date,
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements
    FROM operations
    WHERE statut = 'valide' AND date BETWEEN ? AND ?
    GROUP BY date ORDER BY date ASC
  `).all(moisDebut, moisFin);

  // Top dépenses par catégorie (mois)
  const topCategories = db.prepare(`
    SELECT c.nom, c.couleur, c.type,
      COALESCE(SUM(o.montant), 0) as total
    FROM operations o
    JOIN categories c ON o.categorie_id = c.id
    WHERE o.statut = 'valide' AND o.type_op = 'decaissement'
      AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC LIMIT 8
  `).all(moisDebut, moisFin);

  // Dépense max / min du mois
  const extremes = db.prepare(`
    SELECT
      MAX(montant) as max_dep,
      MIN(montant) as min_dep,
      (SELECT libelle FROM operations WHERE type_op='decaissement' AND statut='valide' AND date BETWEEN ? AND ? ORDER BY montant DESC LIMIT 1) as libelle_max,
      (SELECT libelle FROM operations WHERE type_op='decaissement' AND statut='valide' AND date BETWEEN ? AND ? AND montant > 0 ORDER BY montant ASC LIMIT 1) as libelle_min
    FROM operations
    WHERE type_op = 'decaissement' AND statut = 'valide' AND date BETWEEN ? AND ?
  `).get(moisDebut, moisFin, moisDebut, moisFin, moisDebut, moisFin);

  // Dernières opérations
  const dernieres = db.prepare(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           p.libelle as position_libelle, p.couleur as pos_couleur,
           ps.libelle as source_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    WHERE o.statut = 'valide'
    ORDER BY o.date DESC, o.id DESC LIMIT 8
  `).all();

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
    solde_courant: safe(tresTotal),
    total_recettes: safe(fluxMois.encaissements),
    total_depenses: safe(fluxMois.decaissements),
    nb_operations: safe(fluxMois.nb_ops),
    prev_recettes: safe(fluxPrevMois.encaissements),
    prev_depenses: safe(fluxPrevMois.decaissements),
  });
});

// ─── GET /journal — Journal OHADA par position ───────────────────────────

router.get('/journal', (req, res) => {
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
  const total = db.prepare(countSql).get(...params).c;

  // Pour le journal, on calcule débit/crédit selon la perspective de la position
  const sql = `
    SELECT o.*,
      c.nom as categorie_nom, c.couleur as cat_couleur,
      p.libelle as position_libelle, p.type as position_type,
      ps.libelle as position_source_libelle,
      e.nom || ' ' || e.prenom as employe_nom,
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
  params.push(Number(limit), Number(offset));
  const rows = db.prepare(sql).all(...params).map(serializeOperation);

  res.json({ total, rows });
});

// ─── GET /rapport/hebdo ────────────────────────────────────────────────────

// ─── GET /export-csv — Export CSV journal des opérations ─────────────────────

router.get('/export-csv', (req, res) => {
  const { debut, fin, position_id, categorie_id, type_op: rawType } = req.query;
  const type_op = normalizeTypeOp(rawType || '');

  let where = "WHERE o.statut = 'valide'";
  const params = [];
  if (debut)       { where += ' AND o.date >= ?'; params.push(debut); }
  if (fin)         { where += ' AND o.date <= ?'; params.push(fin); }
  if (type_op)     { where += ' AND o.type_op = ?'; params.push(type_op); }
  if (position_id) { where += ' AND (o.position_id = ? OR o.position_source_id = ?)'; params.push(position_id, position_id); }
  if (categorie_id){ where += ' AND o.categorie_id = ?'; params.push(categorie_id); }

  const rows = db.prepare(`
    SELECT o.date, o.num_piece, o.type_op, o.libelle, o.tiers, o.montant,
           o.mode_reglement, o.ref_externe, o.solde_position,
           c.nom as categorie_nom, p.libelle as position_libelle,
           ps.libelle as position_source_libelle,
           e.nom || ' ' || e.prenom as employe_nom,
           u.nom as saisie_par, o.decharge_signee, o.piece_justificative
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
    ${where}
    ORDER BY o.date ASC, o.id ASC
  `).all(...params);

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

router.get('/rapport/hebdo', (req, res) => {
  const { debut } = req.query;
  const d = debut ? new Date(debut) : new Date();
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = dt => dt.toISOString().split('T')[0];

  const ops = db.prepare(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           p.libelle as position_libelle, ps.libelle as source_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    WHERE o.statut = 'valide' AND o.date BETWEEN ? AND ?
    ORDER BY o.date ASC, o.id ASC
  `).all(fmt(monday), fmt(sunday));

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

router.get('/rapport/mensuel', (req, res) => {
  const { mois, annee } = req.query;
  const m = Number(mois) || new Date().getMonth() + 1;
  const a = Number(annee) || new Date().getFullYear();
  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin   = `${a}-${String(m).padStart(2,'0')}-31`;

  const ops = db.prepare(`
    SELECT o.*, c.nom as categorie_nom, c.couleur as cat_couleur,
           c.type as cat_type, p.libelle as position_libelle
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    WHERE o.statut = 'valide' AND o.date BETWEEN ? AND ?
    ORDER BY o.date ASC, o.id ASC
  `).all(debut, fin);

  const parCategorie = db.prepare(`
    SELECT c.nom, c.couleur, c.type,
      COALESCE(SUM(CASE WHEN o.type_op='decaissement' THEN o.montant ELSE 0 END),0) as total_dec,
      COALESCE(SUM(CASE WHEN o.type_op='encaissement' THEN o.montant ELSE 0 END),0) as total_enc,
      COUNT(*) as nb
    FROM operations o JOIN categories c ON o.categorie_id = c.id
    WHERE o.statut='valide' AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total_dec DESC
  `).all(debut, fin);

  res.json({ mois: m, annee: a, debut, fin, operations: ops, par_categorie: parCategorie });
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW DÉCAISSEMENT — brouillon → soumis → validé → payé / annulé
// ═══════════════════════════════════════════════════════════════════════════

function auditDec(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('operations', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

function getDecOrFail(id, res) {
  const op = db.prepare('SELECT * FROM operations WHERE id = ? AND type_op = ?').get(id, 'decaissement');
  if (!op) { res.status(404).json({ error: 'Décaissement non trouvé' }); return null; }
  return op;
}

// ─── GET /decaissements/pending-count — Compteur léger pour badge sidebar ────
router.get('/decaissements/pending-count', (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as nb FROM operations WHERE type_op='decaissement' AND statut='en_attente'").get();
  res.json({ count: row.nb });
});

// ─── GET /decaissements/pending — Liste en attente (hors journal) ────────────
router.get('/decaissements/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
      c.nom  as categorie_nom, c.couleur as cat_couleur,
      p.libelle as position_libelle,
      e.nom || ' ' || e.prenom as employe_nom,
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
    WHERE o.type_op = 'decaissement' AND o.statut = 'en_attente'
    ORDER BY o.created_at DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

// ─── PUT /:id/soumettre — brouillon → soumis ─────────────────────────────────
router.put('/:id/soumettre', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour soumettre un décaissement' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul brouillon peut être soumis` });

  db.prepare(`UPDATE operations SET dec_statut='soumis', submitted_by=?, submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, op.id);
  auditDec(op.id, 'dec_soumis', { montant: op.montant, libelle: op.libelle }, req.user.id);

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

  // Notifier par email tous les admin/finance habiltés à valider
  try {
    const valideurs = db.prepare("SELECT nom, email FROM users WHERE role IN ('admin','finance') AND actif = 1").all();
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
                <a href="https://talatala.topcenter.cg/dashboard.html" style="background:linear-gradient(135deg,#1A50D9,#1545B5);color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">
                  Accéder à l'application →
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

// ─── PUT /:id/valider — soumis → validé (admin / responsable) ────────────────
router.put('/:id/valider', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour valider' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'soumis') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul soumis peut être validé` });

  db.prepare(`UPDATE operations SET dec_statut='valide', validated_by=?, validated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, op.id);
  auditDec(op.id, 'dec_valide', { montant: op.montant, libelle: op.libelle }, req.user.id);

  // Résoudre l'alerte "soumis en attente" — maintenant validé
  setImmediate(() => {
    try { resoudreAlerte('ALRT_DEC_SOUMIS', 'operations', op.id); } catch (_) {}
  });

  res.json({ ok: true, dec_statut: 'valide' });
});

// ─── POST /:id/payer — validé → payé (impact réel journal) ───────────────────
router.post('/:id/payer', (req, res) => {
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour payer' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;

  // Vérification rapide hors transaction (retour rapide sur cas évidents)
  if (op.dec_statut === 'paye')    return res.status(400).json({ error: 'Décaissement déjà payé' });
  if (op.dec_statut !== 'valide')  return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul validé peut être payé` });

  // Blocage si alerte bloquante active sur la position (solde négatif)
  if (!req.body?.override_alerte) {
    const alerteBloquante = db.prepare(`
      SELECT id, titre, message FROM alertes_actives
      WHERE position_id = ? AND priorite = 'bloquant' AND statut NOT IN ('resolue','acquittee')
      LIMIT 1
    `).get(op.position_id);
    if (alerteBloquante && !hasRole(req.user, 'admin')) {
      return res.status(403).json({
        error: `Paiement bloqué — alerte active : ${alerteBloquante.message}`,
        alerte_id: alerteBloquante.id,
        bloquant: true
      });
    }
  }

  // Transaction atomique — UPDATE conditionnel sur dec_statut='valide'
  // Si deux requêtes simultanées arrivent, une seule trouvera changes=1
  let paid = false;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      UPDATE operations SET
        dec_statut = 'paye',
        statut     = 'valide',
        paid_by    = ?,
        paid_at    = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ? AND dec_statut = 'valide'
    `).run(req.user.id, op.id);
    paid = info.changes === 1;
  });
  tx();

  if (!paid) return res.status(409).json({ error: 'Conflit : décaissement déjà traité (double requête ?)' });

  recalculateSoldes();
  auditDec(op.id, 'dec_paye', { montant: op.montant, libelle: op.libelle, position_id: op.position_id }, req.user.id);

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
router.get('/:id/historique', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.details, a.created_at,
           u.nom as user_nom, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.table_name = 'operations' AND a.record_id = ?
    ORDER BY a.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(r => ({
    ...r,
    details: (() => { try { return JSON.parse(r.details); } catch { return r.details; } })()
  })));
});

// ─── PUT /:id/annuler — tout statut non payé → annulé (motif obligatoire) ────
router.put('/:id/annuler', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis pour annuler' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut === 'paye' || op.statut === 'valide') {
    return res.status(400).json({ error: 'Décaissement déjà payé — créez une opération inverse pour le contrepasser' });
  }
  if (op.statut === 'annule') return res.status(400).json({ error: 'Déjà annulé' });

  const { motif } = req.body;
  if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif d\'annulation obligatoire' });

  db.prepare(`
    UPDATE operations SET
      statut       = 'annule',
      dec_statut   = 'annule',
      annule_by    = ?,
      annule_at    = datetime('now'),
      annule_motif = ?,
      updated_at   = datetime('now')
    WHERE id = ?
  `).run(req.user.id, String(motif).trim(), op.id);

  auditDec(op.id, 'dec_annule', { motif: String(motif).trim(), ancien_statut: op.dec_statut, montant: op.montant }, req.user.id);

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

router.get('/bilan-mensuel', (req, res) => {
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
  const positions = db.prepare("SELECT * FROM positions WHERE actif=1 ORDER BY ordre").all();
  const positionsAvecSolde = positions.map(p => ({ ...p, solde: getSoldePosition(p.id) }));
  const tresorerieTotale   = positionsAvecSolde.reduce((s,p) => s + p.solde, 0);

  const fluxMois = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements,
      COUNT(*) as nb_operations
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
  `).get(debut, fin);

  const fluxPrev = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
  `).get(prevDeb, prevFin);

  const soldeNet = safe(fluxMois.encaissements) - safe(fluxMois.decaissements);

  // Top 5 dépenses du mois par catégorie
  const topDepenses = db.prepare(`
    SELECT c.nom, c.couleur, COALESCE(SUM(o.montant),0) as total, COUNT(*) as nb
    FROM operations o JOIN categories c ON o.categorie_id=c.id
    WHERE o.statut='valide' AND o.type_op='decaissement' AND o.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC LIMIT 5
  `).all(debut, fin);

  // Évolution journalière du mois
  const evolution = db.prepare(`
    SELECT date,
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) as encaissements,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) as decaissements
    FROM operations WHERE statut='valide' AND date BETWEEN ? AND ?
    GROUP BY date ORDER BY date ASC
  `).all(debut, fin);

  // Décaissements en attente
  const decEnAttente = db.prepare(`
    SELECT COUNT(*) as nb, COALESCE(SUM(montant),0) as total
    FROM operations WHERE type_op='decaissement' AND statut='en_attente'
  `).get();

  // ── 2. MASSE SALARIALE ───────────────────────────────────────────────────
  const masseSalarialeBrute = db.prepare(
    "SELECT COALESCE(SUM(brut),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?"
  ).get(m, a).total;

  const masseSalarialeNette = db.prepare(
    "SELECT COALESCE(SUM(net_a_payer),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?"
  ).get(m, a).total;

  const bulletinsParStatut = db.prepare(`
    SELECT statut, COUNT(*) as nb, COALESCE(SUM(net_a_payer),0) as total
    FROM bulletins_salaire WHERE mois=? AND annee=?
    GROUP BY statut
  `).all(m, a);

  const chargesPatronales = db.prepare(
    "SELECT COALESCE(SUM(cnss_patronal+camu_patronal),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?"
  ).get(m, a).total;

  // Masse salariale mois précédent (comparaison)
  const massePrev = db.prepare(
    "SELECT COALESCE(SUM(net_a_payer),0) as total FROM bulletins_salaire WHERE mois=? AND annee=?"
  ).get(prevM, prevA).total;

  // ── 3. EFFECTIFS RH ──────────────────────────────────────────────────────
  const effectifTotal   = db.prepare("SELECT COUNT(*) as c FROM employes WHERE actif=1").get().c;
  const effectifActifs  = db.prepare("SELECT COUNT(*) as c FROM employes WHERE actif=1 AND statut_dossier='actif'").get().c;
  const contratsExpJ30  = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND date_fin_contrat BETWEEN ? AND ?"
  ).get(today, in30).c;
  const essaisExpJ30    = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND periode_essai_fin BETWEEN ? AND ?"
  ).get(today, in30).c;
  const avancesEnCours  = db.prepare(
    "SELECT COUNT(*) as nb, COALESCE(SUM(solde_restant),0) as total FROM employes_avances WHERE statut='en_cours'"
  ).get();
  const docsExpires     = db.prepare(
    "SELECT COUNT(*) as c FROM employes_documents WHERE date_expiration IS NOT NULL AND date_expiration < ?"
  ).get(today).c;

  // ── 4. ACHATS ────────────────────────────────────────────────────────────
  const achatsDuMois = db.prepare(`
    SELECT statut, COUNT(*) as nb, COALESCE(SUM(total_general),0) as total
    FROM demandes_achat WHERE date_demande BETWEEN ? AND ?
    GROUP BY statut
  `).all(debut, fin);

  const achatsSoumis   = achatsDuMois.find(r => r.statut==='soumis')   || { nb:0, total:0 };
  const achatsApprouves= achatsDuMois.find(r => r.statut==='approuve') || { nb:0, total:0 };
  const achatsRejetes  = achatsDuMois.find(r => r.statut==='rejete')   || { nb:0, total:0 };
  const achatsBrouillon= achatsDuMois.find(r => r.statut==='brouillon')|| { nb:0, total:0 };

  // Total engagé ce mois (approuvés)
  const totalEngageMois = safe(achatsApprouves.total);

  // ── 5. ALERTES ACTIVES ───────────────────────────────────────────────────
  const alertes = db.prepare(`
    SELECT type, priorite, titre, message, statut, created_at
    FROM alertes_actives
    WHERE statut NOT IN ('resolue')
    ORDER BY CASE priorite WHEN 'bloquant' THEN 1 WHEN 'critique' THEN 2 WHEN 'avertissement' THEN 3 ELSE 4 END, created_at DESC
    LIMIT 10
  `).all();

  const alertesParPrio = { bloquant:0, critique:0, avertissement:0, info:0 };
  alertes.forEach(a => { if (alertesParPrio[a.priorite] !== undefined) alertesParPrio[a.priorite]++; });

  // ── 6. VARIATIONS MoM (%) ────────────────────────────────────────────────
  function pct(curr, prev) {
    if (!prev) return curr > 0 ? 100 : 0;
    return Math.round((curr - prev) / prev * 100);
  }

  const societe = db.prepare("SELECT valeur FROM parametres WHERE cle='societe'").get()?.valeur || 'TOP CENTER';
  const devise  = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get()?.valeur  || 'XAF';

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
router.get('/clotures', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.nom as cloture_par_nom
    FROM "periodes_clôturees" p
    LEFT JOIN users u ON u.id = p.cloture_by
    ORDER BY p.annee DESC, p.mois DESC
  `).all();
  res.json(rows);
});

// ─── POST /clotures — clôturer un mois (admin uniquement) ────────────────────
router.post('/clotures', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis pour clôturer une période' });
  const { mois, annee, notes } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
  const m = Number(mois); const a = Number(annee);
  if (m < 1 || m > 12 || a < 2000) return res.status(400).json({ error: 'mois ou annee invalide' });

  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin   = `${a}-${String(m).padStart(2,'0')}-31`;
  const nbEnAttente = db.prepare(
    "SELECT COUNT(*) as c FROM operations WHERE statut='en_attente' AND date BETWEEN ? AND ?"
  ).get(debut, fin).c;
  if (nbEnAttente > 0) {
    return res.status(400).json({ error: `Impossible de clôturer : ${nbEnAttente} opération(s) encore en attente pour cette période.` });
  }

  try {
    db.prepare(
      `INSERT INTO "periodes_clôturees" (annee, mois, cloture_by, notes) VALUES (?,?,?,?)`
    ).run(a, m, req.user.id, notes || null);
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('periodes_cloturees', 0, 'cloture', JSON.stringify({ annee: a, mois: m }), req.user.id);
    res.json({ ok: true, annee: a, mois: m });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Période déjà clôturée' });
    throw e;
  }
});

// ─── DELETE /clotures/:annee/:mois — réouvrir une période (admin) ─────────────
router.delete('/clotures/:annee/:mois', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const { annee, mois } = req.params;
  const r = db.prepare(`DELETE FROM "periodes_clôturees" WHERE annee=? AND mois=?`).run(Number(annee), Number(mois));
  if (r.changes === 0) return res.status(404).json({ error: 'Période non clôturée' });
  db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
    .run('periodes_cloturees', 0, 'reouverture', JSON.stringify({ annee, mois }), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.recalculateSoldes = recalculateSoldes;

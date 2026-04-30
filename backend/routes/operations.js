/**
 * ROUTES OPÉRATIONS — Convention OHADA
 * Encaissement | Décaissement | Virement interne
 */
const express = require('express');
const db = require('../database');
const router = express.Router();
const operationColumns = new Set(db.prepare('PRAGMA table_info(operations)').all().map(col => col.name));

// Rôles autorisés pour les opérations financières (décaissement, paiement)
const FINANCE_ROLES = ['admin', 'caissier', 'finance'];

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
      u.nom       as created_by_nom
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN positions ps ON o.position_source_id = ps.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
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
  if (!FINANCE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Accès refusé — Finance ou Admin requis pour créer une opération' });
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

  if (!isWorkflowDec) recalculateSoldes(); // décaissement en brouillon : pas d'impact solde

  const op = db.prepare(`
    SELECT o.*, p.libelle as position_libelle, c.nom as categorie_nom, c.couleur as cat_couleur
    FROM operations o
    LEFT JOIN positions p ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE o.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json(serializeOperation(op));
});

// ─── PUT /:id — Modifier ─────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const op = db.prepare("SELECT * FROM operations WHERE id = ?").get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Opération non trouvée' });

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
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
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

// ─── GET /decaissements/pending — Liste en attente (hors journal) ────────────
router.get('/decaissements/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT o.*,
      c.nom  as categorie_nom, c.couleur as cat_couleur,
      p.libelle as position_libelle,
      e.nom || ' ' || e.prenom as employe_nom,
      u.nom  as created_by_nom,
      uv.nom as validated_by_nom,
      up.nom as paid_by_nom
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN positions  p ON o.position_id  = p.id
    LEFT JOIN employes   e ON o.employe_id   = e.id
    LEFT JOIN users      u ON o.created_by   = u.id
    LEFT JOIN users     uv ON o.validated_by = uv.id
    LEFT JOIN users     up ON o.paid_by      = up.id
    WHERE o.type_op = 'decaissement' AND o.statut = 'en_attente'
    ORDER BY o.created_at DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

// ─── PUT /:id/soumettre — brouillon → soumis ─────────────────────────────────
router.put('/:id/soumettre', (req, res) => {
  if (!FINANCE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour soumettre un décaissement' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul brouillon peut être soumis` });

  db.prepare(`UPDATE operations SET dec_statut='soumis', submitted_by=?, submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, op.id);
  auditDec(op.id, 'dec_soumis', { montant: op.montant, libelle: op.libelle }, req.user.id);
  res.json({ ok: true, dec_statut: 'soumis' });
});

// ─── PUT /:id/valider — soumis → validé (admin / responsable) ────────────────
router.put('/:id/valider', (req, res) => {
  if (!FINANCE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour valider' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;
  if (op.dec_statut !== 'soumis') return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul soumis peut être validé` });

  db.prepare(`UPDATE operations SET dec_statut='valide', validated_by=?, validated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, op.id);
  auditDec(op.id, 'dec_valide', { montant: op.montant, libelle: op.libelle }, req.user.id);
  res.json({ ok: true, dec_statut: 'valide' });
});

// ─── POST /:id/payer — validé → payé (impact réel journal) ───────────────────
router.post('/:id/payer', (req, res) => {
  if (!FINANCE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis pour payer' });
  const op = getDecOrFail(req.params.id, res); if (!op) return;

  // Vérification rapide hors transaction (retour rapide sur cas évidents)
  if (op.dec_statut === 'paye')    return res.status(400).json({ error: 'Décaissement déjà payé' });
  if (op.dec_statut !== 'valide')  return res.status(400).json({ error: `Statut actuel "${op.dec_statut}" — seul validé peut être payé` });

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
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis pour annuler' });
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
  res.json({ ok: true, dec_statut: 'annule' });
});

module.exports = router;
module.exports.recalculateSoldes = recalculateSoldes;

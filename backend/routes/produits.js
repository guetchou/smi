/**
 * MODULE STOCK / PRODUITS — Prompt 4
 * Gestion produits avec stock disponible/réservé/minimum, mouvements traçés.
 * Règles : sortie bloquée si stock insuffisant, alerte si stock <= minimum.
 */
const express = require('express');
const db      = require('../database');
const { requireAuth, hasRole } = require('./auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function auditLog(userId, action, recordId, details = '') {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, 'produits', ?, ?, datetime('now'))
    `).run(userId, action, recordId,
      typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (_) {}
}

function genCodeProduit() {
  const last = db.prepare(
    "SELECT code_produit FROM produits WHERE code_produit LIKE 'PROD-%' ORDER BY id DESC LIMIT 1"
  ).get();
  if (!last) return 'PROD-0001';
  const n = parseInt(last.code_produit.split('-')[1], 10) || 0;
  return `PROD-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Enregistre un mouvement de stock et met à jour le stock du produit.
 * Utilise db directement — doit être appelé dans un db.transaction() de better-sqlite3.
 * Retourne le mouvement créé.
 */
function enregistrerMouvement({ produitId, type, quantite, referenceId, referenceType, motif, userId }) {
  const produit = db.prepare('SELECT stock_disponible, stock_reserve FROM produits WHERE id = ?').get(produitId);
  if (!produit) throw new Error('Produit introuvable');

  const qAvant     = produit.stock_disponible;
  let   qApres     = qAvant;
  let   newReserve = produit.stock_reserve;

  switch (type) {
    case 'entree':
      qApres = qAvant + quantite;
      break;
    case 'sortie':
    case 'perte':
      if (quantite > qAvant + 0.001)
        throw new Error(`Stock insuffisant : disponible=${qAvant}, demandé=${quantite}`);
      qApres = qAvant - quantite;
      break;
    case 'reservation':
      if (quantite > qAvant + 0.001)
        throw new Error(`Stock insuffisant pour réservation : disponible=${qAvant}, demandé=${quantite}`);
      qApres     = qAvant - quantite;
      newReserve = produit.stock_reserve + quantite;
      break;
    case 'liberation':
      qApres     = qAvant + Math.min(quantite, produit.stock_reserve);
      newReserve = Math.max(0, produit.stock_reserve - quantite);
      break;
    case 'retour':
      qApres = qAvant + quantite;
      break;
    case 'inventaire':
    case 'ajustement':
      qApres = quantite; // valeur absolue du stock réel observé
      break;
    case 'transfert':
      if (quantite > qAvant + 0.001)
        throw new Error(`Stock insuffisant pour transfert : disponible=${qAvant}, demandé=${quantite}`);
      qApres = qAvant - quantite;
      break;
    default:
      throw new Error(`Type de mouvement inconnu : ${type}`);
  }

  qApres     = Math.round(qApres     * 1000) / 1000;
  newReserve = Math.round(newReserve * 1000) / 1000;

  db.prepare(`
    UPDATE produits SET
      stock_disponible = ?,
      stock_reserve    = ?,
      updated_at       = datetime('now')
    WHERE id = ?
  `).run(qApres, newReserve, produitId);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO stock_mouvements
      (produit_id, type, quantite, quantite_avant, quantite_apres,
       reference_id, reference_type, motif, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(produitId, type, quantite, qAvant, qApres,
         referenceId || null, referenceType || null, motif || null, userId);

  return { id: lastInsertRowid, type, quantite, quantite_avant: qAvant, quantite_apres: qApres };
}

// ── GET /api/produits ─────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { statut, categorie_id, stock_bas, search, limit = 100, offset = 0 } = req.query;

  const where  = ['1=1'];
  const params = [];

  if (statut)       { where.push('p.statut = ?');       params.push(statut); }
  if (categorie_id) { where.push('p.categorie_id = ?'); params.push(categorie_id); }
  if (stock_bas === '1') where.push('p.stock_disponible <= p.stock_minimum');
  if (search) {
    where.push('(p.code_produit LIKE ? OR p.designation LIKE ? OR p.code_barres LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const sql = `
    SELECT p.*,
           cp.nom AS categorie_nom,
           CASE WHEN p.stock_disponible <= 0             THEN 'rupture'
                WHEN p.stock_disponible <= p.stock_minimum THEN 'bas'
                ELSE 'ok'
           END AS niveau_stock
    FROM produits p
    LEFT JOIN categories_produits cp ON cp.id = p.categorie_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.designation ASC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const rows  = db.prepare(sql).all(...params);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM produits p WHERE ${where.join(' AND ')}`
  ).get(...params.slice(0, -2)).n;

  res.json({ produits: rows, total });
});

// ── GET /api/produits/alertes/stock-bas ──────────────────────────────────────
// Doit être avant /:id
router.get('/alertes/stock-bas', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
           cp.nom AS categorie_nom,
           CASE WHEN p.stock_disponible <= 0 THEN 'rupture' ELSE 'bas' END AS niveau_stock
    FROM produits p
    LEFT JOIN categories_produits cp ON cp.id = p.categorie_id
    WHERE p.statut = 'actif'
      AND p.stock_disponible <= p.stock_minimum
    ORDER BY p.stock_disponible ASC
  `).all();
  res.json({ alertes: rows, total: rows.length });
});

// ── GET /api/produits/categories ─────────────────────────────────────────────
router.get('/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories_produits WHERE actif = 1 ORDER BY nom ASC').all();
  res.json({ categories: rows });
});

// ── POST /api/produits/categories ────────────────────────────────────────────
router.post('/categories', requireAuth, (req, res) => {
  const { nom, description } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: 'nom requis' });
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO categories_produits (nom, description) VALUES (?, ?)'
    ).run(nom.trim(), description || null);
    res.status(201).json(db.prepare('SELECT * FROM categories_produits WHERE id = ?').get(lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Catégorie déjà existante' });
    throw e;
  }
});

// ── GET /api/produits/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const produit = db.prepare(`
    SELECT p.*, cp.nom AS categorie_nom,
           CASE WHEN p.stock_disponible <= 0             THEN 'rupture'
                WHEN p.stock_disponible <= p.stock_minimum THEN 'bas'
                ELSE 'ok'
           END AS niveau_stock
    FROM produits p
    LEFT JOIN categories_produits cp ON cp.id = p.categorie_id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!produit) return res.status(404).json({ error: 'Produit introuvable' });

  const mouvements = db.prepare(`
    SELECT sm.*, u.nom AS created_by_nom
    FROM stock_mouvements sm
    LEFT JOIN users u ON u.id = sm.created_by
    WHERE sm.produit_id = ?
    ORDER BY sm.created_at DESC
    LIMIT 50
  `).all(produit.id);

  res.json({ ...produit, mouvements });
});

// ── POST /api/produits ────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const {
    designation, categorie_id, unite = 'piece',
    prix_achat = 0, prix_vente = 0, taux_taxe = 0,
    stock_initial = 0, stock_minimum = 0, emplacement,
    date_expiration, numero_lot, code_barres, notes
  } = req.body;

  if (!designation?.trim()) return res.status(400).json({ error: 'designation requise' });

  const code_produit = genCodeProduit();

  const tx = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO produits
        (code_produit, designation, categorie_id, unite,
         prix_achat, prix_vente, taux_taxe,
         stock_disponible, stock_reserve, stock_minimum,
         emplacement, date_expiration, numero_lot, code_barres,
         statut, notes, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?,
         ?, ?, ?,
         ?, 0, ?,
         ?, ?, ?, ?,
         'actif', ?, ?, datetime('now'), datetime('now'))
    `).run(
      code_produit, designation.trim(), categorie_id || null, unite,
      Number(prix_achat), Number(prix_vente), Number(taux_taxe),
      0, Number(stock_minimum), // stock_disponible = 0, mis à jour par le mouvement ci-dessous
      emplacement || null, date_expiration || null, numero_lot || null, code_barres || null,
      notes || null, req.user.id
    );

    // Mouvement d'entrée initial si stock > 0
    if (Number(stock_initial) > 0) {
      enregistrerMouvement({
        produitId: lastInsertRowid, type: 'entree',
        quantite: Number(stock_initial),
        referenceType: 'ajustement', motif: 'Stock initial à la création',
        userId: req.user.id
      });
    }

    return lastInsertRowid;
  });

  const id      = tx();
  const created = db.prepare('SELECT * FROM produits WHERE id = ?').get(id);
  auditLog(req.user.id, 'CREATE', id, { code_produit, designation });
  res.status(201).json(created);
});

// ── PUT /api/produits/:id ────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const produit = db.prepare('SELECT * FROM produits WHERE id = ?').get(req.params.id);
  if (!produit) return res.status(404).json({ error: 'Produit introuvable' });

  const {
    designation, categorie_id, unite, prix_achat, prix_vente,
    taux_taxe, stock_minimum, emplacement, date_expiration,
    numero_lot, code_barres, statut, notes
  } = req.body;

  const before = { ...produit };

  db.prepare(`
    UPDATE produits SET
      designation     = COALESCE(?, designation),
      categorie_id    = COALESCE(?, categorie_id),
      unite           = COALESCE(?, unite),
      prix_achat      = COALESCE(?, prix_achat),
      prix_vente      = COALESCE(?, prix_vente),
      taux_taxe       = COALESCE(?, taux_taxe),
      stock_minimum   = COALESCE(?, stock_minimum),
      emplacement     = COALESCE(?, emplacement),
      date_expiration = COALESCE(?, date_expiration),
      numero_lot      = COALESCE(?, numero_lot),
      code_barres     = COALESCE(?, code_barres),
      statut          = COALESCE(?, statut),
      notes           = COALESCE(?, notes),
      updated_at      = datetime('now')
    WHERE id = ?
  `).run(
    designation?.trim() || null, categorie_id || null, unite || null,
    prix_achat != null ? Number(prix_achat) : null,
    prix_vente != null ? Number(prix_vente) : null,
    taux_taxe  != null ? Number(taux_taxe)  : null,
    stock_minimum != null ? Number(stock_minimum) : null,
    emplacement || null, date_expiration || null,
    numero_lot || null, code_barres || null, statut || null,
    notes !== undefined ? notes : null,
    produit.id
  );

  const updated = db.prepare('SELECT * FROM produits WHERE id = ?').get(produit.id);
  auditLog(req.user.id, 'UPDATE', produit.id, { before, after: updated });
  res.json(updated);
});

// ── POST /api/produits/:id/entree ────────────────────────────────────────────
router.post('/:id/entree', requireAuth, (req, res) => {
  const produit = db.prepare('SELECT id, designation, statut FROM produits WHERE id = ?').get(req.params.id);
  if (!produit) return res.status(404).json({ error: 'Produit introuvable' });
  if (produit.statut === 'archive') return res.status(400).json({ error: 'Produit archivé' });

  const { quantite, motif, reference_id, reference_type = 'autre' } = req.body;
  const qty = Number(quantite);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantité invalide (doit être > 0)' });

  const tx = db.transaction(() =>
    enregistrerMouvement({
      produitId: produit.id, type: 'entree', quantite: qty,
      referenceId: reference_id, referenceType: reference_type,
      motif: motif || 'Entrée de stock', userId: req.user.id
    })
  );

  const mouvement = tx();
  const updated   = db.prepare('SELECT stock_disponible, stock_reserve FROM produits WHERE id = ?').get(produit.id);
  auditLog(req.user.id, 'ENTREE_STOCK', produit.id, { quantite: qty, motif, ...updated });
  res.json({ ok: true, mouvement, ...updated });
});

// ── POST /api/produits/:id/sortie ────────────────────────────────────────────
router.post('/:id/sortie', requireAuth, (req, res) => {
  const produit = db.prepare('SELECT id, designation, stock_disponible, statut FROM produits WHERE id = ?').get(req.params.id);
  if (!produit) return res.status(404).json({ error: 'Produit introuvable' });
  if (produit.statut === 'archive') return res.status(400).json({ error: 'Produit archivé' });

  const { quantite, type = 'sortie', motif, reference_id, reference_type = 'autre' } = req.body;
  const qty = Number(quantite);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantité invalide (doit être > 0)' });

  const typesValides = ['sortie', 'perte', 'transfert'];
  if (!typesValides.includes(type))
    return res.status(400).json({ error: `Type invalide. Valeurs : ${typesValides.join(', ')}` });

  let mouvement;
  try {
    const tx = db.transaction(() =>
      enregistrerMouvement({
        produitId: produit.id, type, quantite: qty,
        referenceId: reference_id, referenceType: reference_type,
        motif: motif || 'Sortie de stock', userId: req.user.id
      })
    );
    mouvement = tx();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const updated = db.prepare('SELECT stock_disponible, stock_reserve FROM produits WHERE id = ?').get(produit.id);

  // Alerte si stock bas après sortie
  const alerte = updated.stock_disponible <= 0
    ? 'rupture'
    : updated.stock_disponible <= db.prepare('SELECT stock_minimum FROM produits WHERE id = ?').get(produit.id).stock_minimum
    ? 'bas' : null;

  auditLog(req.user.id, 'SORTIE_STOCK', produit.id, { type, quantite: qty, motif, ...updated });
  res.json({ ok: true, mouvement, ...updated, alerte });
});

// ── POST /api/produits/inventaire ────────────────────────────────────────────
// Ajustement inventaire : on fixe le stock réel observé
router.post('/inventaire', requireAuth, (req, res) => {
  // Rôles autorisés à faire un inventaire
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Permission insuffisante pour un ajustement inventaire' });

  const { produit_id, quantite_reelle, motif } = req.body;
  if (!produit_id) return res.status(400).json({ error: 'produit_id requis' });
  if (quantite_reelle == null || Number(quantite_reelle) < 0)
    return res.status(400).json({ error: 'quantite_reelle invalide (doit être >= 0)' });

  const produit = db.prepare('SELECT * FROM produits WHERE id = ?').get(produit_id);
  if (!produit) return res.status(404).json({ error: 'Produit introuvable' });

  const ecart = Number(quantite_reelle) - produit.stock_disponible;

  const tx = db.transaction(() =>
    enregistrerMouvement({
      produitId: produit.id, type: 'inventaire',
      quantite: Number(quantite_reelle),
      referenceType: 'inventaire',
      motif: motif || `Ajustement inventaire (écart ${ecart >= 0 ? '+' : ''}${ecart})`,
      userId: req.user.id
    })
  );

  const mouvement = tx();
  auditLog(req.user.id, 'INVENTAIRE', produit.id, {
    ancienStock: produit.stock_disponible,
    nouveauStock: Number(quantite_reelle),
    ecart, motif
  });
  res.json({ ok: true, mouvement, ecart, stock_apres: Number(quantite_reelle) });
});

// ── Fonction pour alertes stock bas (appelée depuis cron) ────────────────────
function getProduitsStockBas() {
  return db.prepare(`
    SELECT id, code_produit, designation, stock_disponible, stock_minimum
    FROM produits
    WHERE statut = 'actif' AND stock_disponible <= stock_minimum
  `).all();
}

module.exports = router;
module.exports.getProduitsStockBas = getProduitsStockBas;

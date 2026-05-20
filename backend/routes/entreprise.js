'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const router  = express.Router();
const { hasRole } = require('./auth');

// ── Upload assets entreprise ──────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads', 'entreprise');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadEntreprise = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename:    (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.png';
      const type = req.params.type || 'asset';
      cb(null, `entreprise_${type}_${Date.now()}${ext}`);
    },
  }),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Image uniquement'));
    cb(null, true);
  },
});

const WRITABLE_FIELDS = [
  'raison_sociale', 'nom_commercial', 'forme_juridique', 'rccm', 'nif',
  'secteur_activite', 'date_creation', 'capital_social', 'regime_fiscal',
  'adresse', 'ville', 'pays', 'telephone', 'email', 'site_web',
  'directeur_general', 'responsable_rh', 'responsable_finance',
  'signataire_paie', 'signataire_decaissement',
  'devise', 'exercice_debut', 'exercice_fin', 'fuseau_horaire',
];

// ── GET /entreprise ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const ent = await db.queryOne('SELECT * FROM entreprise WHERE actif = 1 LIMIT 1');
    res.json(ent || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /entreprise — création (une seule fois) ──────────────────────────────
router.post('/', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

    const existing = await db.queryOne('SELECT id FROM entreprise WHERE actif = 1');
    if (existing) return res.status(409).json({ error: 'Une entreprise active existe déjà. Utilisez PUT pour la modifier.' });

    const fields = {};
    WRITABLE_FIELDS.forEach(f => {
      if (req.body[f] !== undefined) fields[f] = String(req.body[f]).trim();
    });
    if (!fields.raison_sociale) return res.status(400).json({ error: 'raison_sociale requis' });

    const cols = [...Object.keys(fields), 'created_by'].join(', ');
    const vals = [...Object.keys(fields).map(() => '?'), '?'].join(', ');
    const result = await db.execute(
      `INSERT INTO entreprise (${cols}) VALUES (${vals})`,
      [...Object.values(fields), req.user.id]
    );

    await db.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
      ['entreprise', result.insertId, 'create', JSON.stringify(fields), req.user.id]
    );

    res.status(201).json({ id: result.insertId, ...fields });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /entreprise — modification ────────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

    const current = await db.queryOne('SELECT * FROM entreprise WHERE actif = 1 LIMIT 1');
    if (!current) return res.status(404).json({ error: 'Aucune entreprise configurée. Utilisez POST.' });

    await db.execute(
      'INSERT INTO entreprise_historique (entreprise_id, snapshot, modifie_par) VALUES (?, ?, ?)',
      [current.id, JSON.stringify(current), req.user.id]
    );

    const updates = {};
    WRITABLE_FIELDS.forEach(f => {
      if (req.body[f] !== undefined) updates[f] = String(req.body[f]).trim();
    });
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'Aucun champ modifiable fourni' });

    const setParts = Object.keys(updates).map(f => `${f} = ?`).join(', ');
    await db.execute(
      `UPDATE entreprise SET ${setParts}, updated_at = NOW(), updated_by = ? WHERE id = ?`,
      [...Object.values(updates), req.user.id, current.id]
    );

    const modifs = {};
    Object.entries(updates).forEach(([k, v]) => {
      if (String(current[k] ?? '') !== v) modifs[k] = { avant: current[k] ?? null, apres: v };
    });
    if (Object.keys(modifs).length > 0) {
      await db.execute(
        "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
        ['entreprise', current.id, 'update', JSON.stringify(modifs), req.user.id]
      );
    }

    const updated = await db.queryOne('SELECT * FROM entreprise WHERE id = ?', [current.id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /entreprise/historique ────────────────────────────────────────────────
router.get('/historique', async (req, res) => {
  try {
    const ent = await db.queryOne('SELECT id FROM entreprise WHERE actif = 1 LIMIT 1');
    if (!ent) return res.json([]);

    const hist = await db.query(`
      SELECT h.id, h.modifie_le, h.snapshot,
             u.nom AS modifie_par_nom, u.email AS modifie_par_email
      FROM entreprise_historique h
      LEFT JOIN users u ON h.modifie_par = u.id
      WHERE h.entreprise_id = ?
      ORDER BY h.modifie_le DESC
      LIMIT 50
    `, [ent.id]);

    res.json(hist.map(h => ({
      ...h,
      snapshot: (() => { try { return JSON.parse(h.snapshot); } catch { return {}; } })(),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /entreprise/upload/:type ─────────────────────────────────────────────
router.post('/upload/:type', uploadEntreprise.single('file'), async (req, res) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

    const type    = req.params.type;
    const ALLOWED = ['logo', 'cachet', 'signature'];
    if (!ALLOWED.includes(type)) return res.status(400).json({ error: 'Type invalide. Valeurs: logo, cachet, signature' });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    const field = `${type}_path`;
    const ent   = await db.queryOne(`SELECT id, ${field} FROM entreprise WHERE actif = 1 LIMIT 1`);
    if (!ent) return res.status(404).json({ error: 'Aucune entreprise configurée' });

    if (ent[field]) {
      const oldPath = path.join(__dirname, '..', 'data', 'uploads', 'entreprise', path.basename(ent[field]));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const filePath = '/uploads/entreprise/' + req.file.filename;
    await db.execute(
      `UPDATE entreprise SET ${field} = ?, updated_at = NOW(), updated_by = ? WHERE id = ?`,
      [filePath, req.user.id, ent.id]
    );
    await db.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
      ['entreprise', ent.id, `upload_${type}`, filePath, req.user.id]
    );

    res.json({ ok: true, [field]: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');

// ── Upload assets entreprise (logo, cachet, signature) ───────────────────────
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads', 'entreprise');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadEntreprise = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.png';
      const type = req.params.type || 'asset'; // logo | cachet | signature
      cb(null, `entreprise_${type}_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Image uniquement'));
    cb(null, true);
  }
});

// ── Champs autorisés en écriture ──────────────────────────────────────────────
const WRITABLE_FIELDS = [
  'raison_sociale', 'nom_commercial', 'forme_juridique', 'rccm', 'nif',
  'secteur_activite', 'date_creation', 'capital_social', 'regime_fiscal',
  'adresse', 'ville', 'pays', 'telephone', 'email', 'site_web',
  'directeur_general', 'responsable_rh', 'responsable_finance',
  'signataire_paie', 'signataire_decaissement',
  'devise', 'exercice_debut', 'exercice_fin', 'fuseau_horaire',
];

// ── GET /entreprise — lecture tous rôles ─────────────────────────────────────
router.get('/', (req, res) => {
  const ent = db.prepare('SELECT * FROM entreprise WHERE actif = 1 LIMIT 1').get();
  res.json(ent || {});
});

// ── POST /entreprise — création (seulement si aucune n'existe) ────────────────
router.post('/', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

  const existing = db.prepare('SELECT id FROM entreprise WHERE actif = 1').get();
  if (existing) return res.status(409).json({ error: 'Une entreprise active existe déjà. Utilisez PUT pour la modifier.' });

  const fields = {};
  WRITABLE_FIELDS.forEach(f => {
    if (req.body[f] !== undefined) fields[f] = String(req.body[f]).trim();
  });
  if (!fields.raison_sociale) return res.status(400).json({ error: 'raison_sociale requis' });

  const cols = Object.keys(fields).join(', ');
  const vals = Object.keys(fields).map(() => '?').join(', ');
  const r = db.prepare(
    `INSERT INTO entreprise (${cols}, created_by) VALUES (${vals}, ?)`
  ).run([...Object.values(fields), req.user.id]);

  db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
    .run('entreprise', r.lastInsertRowid, 'create', JSON.stringify(fields), req.user.id);

  res.status(201).json({ id: r.lastInsertRowid, ...fields });
});

// ── PUT /entreprise — modification (admin only) ───────────────────────────────
router.put('/', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

  const current = db.prepare('SELECT * FROM entreprise WHERE actif = 1 LIMIT 1').get();
  if (!current) return res.status(404).json({ error: 'Aucune entreprise configurée. Utilisez POST.' });

  // Snapshot avant modification → historique
  db.prepare(`
    INSERT INTO entreprise_historique (entreprise_id, snapshot, modifie_par)
    VALUES (?, ?, ?)
  `).run(current.id, JSON.stringify(current), req.user.id);

  // Construire le SET dynamique sur les champs autorisés
  const updates = {};
  WRITABLE_FIELDS.forEach(f => {
    if (req.body[f] !== undefined) updates[f] = String(req.body[f]).trim();
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
  }

  const setParts = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(
    `UPDATE entreprise SET ${setParts}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`
  ).run([...Object.values(updates), req.user.id, current.id]);

  // Audit : only changed fields
  const modifs = {};
  Object.entries(updates).forEach(([k, v]) => {
    if (String(current[k] ?? '') !== v) modifs[k] = { avant: current[k] ?? null, apres: v };
  });
  if (Object.keys(modifs).length > 0) {
    db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
      .run('entreprise', current.id, 'update', JSON.stringify(modifs), req.user.id);
  }

  const updated = db.prepare('SELECT * FROM entreprise WHERE id = ?').get(current.id);
  res.json(updated);
});

// ── GET /entreprise/historique ────────────────────────────────────────────────
router.get('/historique', (req, res) => {
  const ent = db.prepare('SELECT id FROM entreprise WHERE actif = 1 LIMIT 1').get();
  if (!ent) return res.json([]);

  const hist = db.prepare(`
    SELECT h.id, h.modifie_le, h.snapshot,
           u.nom as modifie_par_nom, u.email as modifie_par_email
    FROM entreprise_historique h
    LEFT JOIN users u ON h.modifie_par = u.id
    WHERE h.entreprise_id = ?
    ORDER BY h.modifie_le DESC
    LIMIT 50
  `).all(ent.id);

  res.json(hist.map(h => ({
    ...h,
    snapshot: (() => { try { return JSON.parse(h.snapshot); } catch { return {}; } })()
  })));
});

// ── POST /entreprise/upload/:type — upload logo|cachet|signature ──────────────
router.post('/upload/:type', uploadEntreprise.single('file'), (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

  const type = req.params.type;
  const ALLOWED = ['logo', 'cachet', 'signature'];
  if (!ALLOWED.includes(type)) return res.status(400).json({ error: 'Type invalide. Valeurs: logo, cachet, signature' });

  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const field = `${type}_path`;
  const ent = db.prepare('SELECT id, ' + field + ' FROM entreprise WHERE actif = 1 LIMIT 1').get();
  if (!ent) return res.status(404).json({ error: 'Aucune entreprise configurée' });

  // Supprimer l'ancien fichier
  if (ent[field]) {
    const oldPath = path.join(__dirname, '..', 'data', 'uploads', 'entreprise',
      path.basename(ent[field]));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const filePath = '/uploads/entreprise/' + req.file.filename;
  db.prepare(`UPDATE entreprise SET ${field} = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
    .run(filePath, req.user.id, ent.id);

  db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
    .run('entreprise', ent.id, `upload_${type}`, filePath, req.user.id);

  res.json({ ok: true, [field]: filePath });
});

module.exports = router;

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcryptjs');
const db      = require('../database');
const router  = express.Router();

// ─── Multer : photo profil utilisateur ───────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadUser = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Image uniquement'));
    cb(null, true);
  }
});

// Liste des utilisateurs (admin only)
router.get('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const users = db.prepare('SELECT id, nom, email, role, sous_role, actif, created_at FROM users ORDER BY nom').all();
  res.json(users);
});

// Créer un utilisateur
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { nom, email, password, role = 'caissier', sous_role = null } = req.body;
  if (!nom || !email || !password) return res.status(400).json({ error: 'Champs requis manquants' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (nom, email, password_hash, role, sous_role) VALUES (?, ?, ?, ?, ?)').run(nom, email, hash, role, sous_role || null);
    res.status(201).json({ id: result.lastInsertRowid, nom, email, role, sous_role });
  } catch {
    res.status(409).json({ error: 'Email déjà utilisé' });
  }
});

// Modifier un utilisateur
router.put('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { nom, email, role, actif, password, sous_role = null } = req.body;
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  db.prepare('UPDATE users SET nom=?, email=?, role=?, sous_role=?, actif=? WHERE id=?').run(nom, email, role, sous_role || null, actif ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Supprimer un utilisateur
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  db.prepare("UPDATE users SET actif = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Liste des employés (exclut les agents sortis — non sélectionnables dans paie/avances/congés)
router.get('/employes', (req, res) => {
  const employes = db.prepare("SELECT * FROM employes WHERE actif = 1 AND statut_dossier != 'sorti' ORDER BY type, nom").all();
  res.json(employes);
});

router.post('/employes', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { nom, prenom, poste, type = 'permanent', salaire_base = 0,
          mode_paiement = 'especes', banque = '', numero_compte = '' } = req.body;
  const result = db.prepare(
    'INSERT INTO employes (nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte);
  res.status(201).json({ id: result.lastInsertRowid, nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte });
});

router.put('/employes/:id', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { nom, prenom, poste, type, salaire_base, actif,
          mode_paiement = 'especes', banque = '', numero_compte = '' } = req.body;
  db.prepare(
    'UPDATE employes SET nom=?, prenom=?, poste=?, type=?, salaire_base=?, actif=?, mode_paiement=?, banque=?, numero_compte=? WHERE id=?'
  ).run(nom, prenom, poste, type, salaire_base, actif ? 1 : 0, mode_paiement, banque || '', numero_compte || '', req.params.id);
  res.json({ ok: true });
});

// Supprimer un employé
router.delete('/employes/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  db.prepare('UPDATE employes SET actif = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Categories
router.get('/categories', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories ORDER BY type, nom').all();
  res.json(cats);
});

router.post('/categories', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { nom, type, couleur = '#6366f1', icone = 'circle' } = req.body;
  const result = db.prepare('INSERT INTO categories (nom, type, couleur, icone) VALUES (?, ?, ?, ?)').run(nom, type, couleur, icone);
  res.status(201).json({ id: result.lastInsertRowid, nom, type, couleur, icone });
});

router.put('/categories/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { nom, type, couleur, icone } = req.body;
  db.prepare('UPDATE categories SET nom=?, type=?, couleur=?, icone=? WHERE id=?').run(nom, type, couleur || '#6366f1', icone || 'circle', req.params.id);
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Paramètres
router.get('/parametres', (req, res) => {
  const params = db.prepare('SELECT * FROM parametres').all();
  const obj = {};
  params.forEach(p => obj[p.cle] = p.valeur);
  res.json(obj);
});

router.put('/parametres', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const upd = db.prepare('INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?, ?)');
  const tx = db.transaction(() => {
    Object.entries(req.body).forEach(([k, v]) => upd.run(k, String(v)));
  });
  tx();
  res.json({ ok: true });
});

// Test connexion SMTP
router.post('/email/test', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  try {
    const { testConnection, sendMail } = require('../services/email');
    await testConnection();
    await sendMail({ to: req.user.email, subject: 'Test SMTP — TOP CENTER Caisse', html: '<p>✅ La configuration SMTP fonctionne correctement.</p>' });
    res.json({ ok: true, message: `Email de test envoyé à ${req.user.email}` });
  } catch (e) {
    res.status(500).json({ error: 'Échec SMTP: ' + e.message });
  }
});

// Envoyer bulletin de paie par email
router.post('/bulletin/:employe_id/email', async (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.employe_id);
  if (!emp) return res.status(404).json({ error: 'Employé non trouvé' });
  if (!emp.email) return res.status(400).json({ error: 'Aucun email pour cet employé' });
  const { mois, annee, htmlBulletin } = req.body;
  try {
    const { sendBulletin } = require('../services/email');
    await sendBulletin(emp.email, emp.nom + ' ' + (emp.prenom || ''), mois, annee, htmlBulletin || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Échec envoi: ' + e.message });
  }
});

// ─── Fournisseurs ────────────────────────────────────────────────────────────
router.get('/fournisseurs', (req, res) => {
  res.json(db.prepare("SELECT * FROM fournisseurs WHERE actif = 1 ORDER BY nom").all());
});

router.post('/fournisseurs', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare('INSERT INTO fournisseurs (nom,telephone,reference,nif_rccm,adresse) VALUES (?,?,?,?,?)').run(nom, telephone, reference, nif_rccm, adresse);
  res.status(201).json({ id: r.lastInsertRowid, nom, telephone, reference, nif_rccm, adresse });
});

router.put('/fournisseurs/:id', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
  db.prepare('UPDATE fournisseurs SET nom=?,telephone=?,reference=?,nif_rccm=?,adresse=? WHERE id=?').run(nom, telephone, reference, nif_rccm, adresse, req.params.id);
  res.json({ ok: true });
});

router.delete('/fournisseurs/:id', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('UPDATE fournisseurs SET actif = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Rapport salaires mensuel ────────────────────────────────────────────────
router.get('/salaires/rapport', (req, res) => {
  const { mois, annee } = req.query;
  const m = Number(mois) || new Date().getMonth() + 1;
  const a = Number(annee) || new Date().getFullYear();
  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin = `${a}-${String(m).padStart(2,'0')}-31`;

  const employes = db.prepare("SELECT * FROM employes WHERE actif = 1 AND statut_dossier != 'sorti' ORDER BY type, nom").all();
  const paiements = db.prepare(`
    SELECT o.employe_id,
           SUM(o.montant) as paye,
           MAX(o.decharge_signee) as decharge_signee
    FROM operations o
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE o.date BETWEEN ? AND ?
      AND o.statut != 'annule'
      AND o.employe_id IS NOT NULL
      AND o.type_op = 'decaissement'
      AND (
        lower(COALESCE(c.nom, '')) LIKE '%salaire%'
        OR lower(COALESCE(c.nom, '')) LIKE '%gratification%'
        OR lower(COALESCE(o.libelle, '')) LIKE '%salaire%'
        OR lower(COALESCE(o.libelle, '')) LIKE '%gratification%'
      )
    GROUP BY o.employe_id
  `).all(debut, fin);

  const payMap = {};
  paiements.forEach(p => payMap[p.employe_id] = p);

  const rapport = employes.map(e => ({
    ...e,
    paye: payMap[e.id]?.paye || 0,
    decharge: payMap[e.id]?.decharge_signee || 0,
    restant: e.salaire_base - (payMap[e.id]?.paye || 0)
  }));

  res.json({ mois: m, annee: a, employes: rapport });
});

// ─── Positions de trésorerie ─────────────────────────────────────────────

router.get('/positions', (req, res) => {
  res.json(db.prepare('SELECT * FROM positions ORDER BY ordre').all());
});

router.post('/positions', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { code, libelle, type = 'caisse', solde_initial = 0, couleur = '#6366f1', ordre = 0 } = req.body;
  try {
    const r = db.prepare('INSERT INTO positions (code,libelle,type,solde_initial,couleur,ordre) VALUES (?,?,?,?,?,?)').run(code, libelle, type, solde_initial, couleur, ordre);
    res.status(201).json({ id: r.lastInsertRowid, code, libelle, type, solde_initial, couleur, ordre });
  } catch { res.status(409).json({ error: 'Code déjà utilisé' }); }
});

router.put('/positions/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { libelle, type, solde_initial, couleur, ordre, actif } = req.body;
  db.prepare('UPDATE positions SET libelle=?,type=?,solde_initial=?,couleur=?,ordre=?,actif=? WHERE id=?').run(libelle, type, solde_initial, couleur, ordre, actif ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Bulletin de paie (données)
router.get('/bulletin/:employe_id', (req, res) => {
  const { mois, annee } = req.query;
  const m = Number(mois) || new Date().getMonth() + 1;
  const a = Number(annee) || new Date().getFullYear();
  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.employe_id);
  if (!emp) return res.status(404).json({ error: 'Employé non trouvé' });
  const debut = `${a}-${String(m).padStart(2,'0')}-01`;
  const fin   = `${a}-${String(m).padStart(2,'0')}-31`;
  const ops = db.prepare(`SELECT o.*, c.nom as cat_nom FROM operations o LEFT JOIN categories c ON o.categorie_id=c.id WHERE o.employe_id=? AND o.date BETWEEN ? AND ? AND o.statut='valide' ORDER BY o.date`).all(emp.id, debut, fin);
  const totalPaye = ops.reduce((s,o) => s + (o.montant||0), 0);
  const params = db.prepare('SELECT * FROM parametres').all().reduce((o,p) => ({...o,[p.cle]:p.valeur}), {});
  res.json({ employe: emp, mois: m, annee: a, operations: ops, total_paye: totalPaye, societe: params.societe || 'TOP CENTER', devise: params.devise || 'XAF' });
});

// ─── Upload photo profil utilisateur connecté ─────────────────────────────────

router.post('/me/photo', uploadUser.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  // Supprimer l'ancienne photo
  const user = db.prepare('SELECT photo_url FROM users WHERE id = ?').get(req.user.id);
  if (user?.photo_url) {
    const old = path.join(uploadsDir, path.basename(user.photo_url));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  const photoUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run(photoUrl, req.user.id);
  res.json({ ok: true, photo_url: photoUrl });
});

router.get('/me', (req, res) => {
  const user = db.prepare('SELECT id, nom, email, role, photo_url FROM users WHERE id = ?').get(req.user.id);
  res.json(user || {});
});

module.exports = router;

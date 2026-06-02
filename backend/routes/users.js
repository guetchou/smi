const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');
const identityAccess = require('../services/identity_access');

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

const WRITE_ROLES = ['admin', 'caissier', 'finance', 'rh', 'dg', 'assistante_direction', 'delegue'];

function isAdmin(user) {
  return hasRole(user, 'admin');
}

function canManageUsers(user) {
  return hasRole(user, 'admin', 'dg');
}

function canWrite(user) {
  return hasRole(user, ...WRITE_ROLES);
}

function canManageEmployeeRegistry(user) {
  return hasRole(user, 'admin', 'dg', 'rh');
}

function parseRoles(user) {
  return identityAccess.parseRoles(user);
}

function userDto(u) {
  return {
    ...u,
    roles: parseRoles(u),
    employe: u.employe_id ? {
      id: u.employe_id,
      nom: u.employe_nom || '',
      prenom: u.employe_prenom || '',
      matricule: u.employe_matricule || '',
      poste: u.employe_poste || '',
    } : null,
    employe_nom: undefined,
    employe_prenom: undefined,
    employe_matricule: undefined,
    employe_poste: undefined,
  };
}

// Liste des utilisateurs (admin / DG)
router.get('/', (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  const users = db.prepare(`
    SELECT u.id, u.nom, u.prenom, u.email, u.role, u.roles, u.sous_role, u.actif, u.employe_id, u.created_at,
           e.nom AS employe_nom, e.prenom AS employe_prenom, e.matricule AS employe_matricule, e.poste AS employe_poste
    FROM users u
    LEFT JOIN employes e ON e.id = u.employe_id
    ORDER BY u.nom
  `).all();
  res.json(users.map(userDto));
});

// Créer un utilisateur
router.post('/', async (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  try {
    const created = await identityAccess.createUserAccess(req.body, req.user.id);
    setImmediate(() => {
      try {
        creerNotification({
          type:     'NOTIF_USER_CREE',
          titre:    'Nouvel utilisateur créé',
          message:  `${created.nom} (${created.email}) — rôle : ${created.role}.`,
          srcTable: 'users',
          srcId:    created.id,
          createdBy: req.user.id,
        });
      } catch (_) {}
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Modifier un utilisateur
router.put('/:id', async (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  const existing = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Utilisateur introuvable' });
  try {
    await identityAccess.updateUserAccess(req.params.id, req.body, req.user.id);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ ok: true });
});

// Supprimer un utilisateur
router.delete('/:id', (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  const targetUser = db.prepare('SELECT nom, email FROM users WHERE id=?').get(req.params.id);
  db.prepare("UPDATE users SET actif = 0 WHERE id = ?").run(req.params.id);
  setImmediate(() => {
    try {
      creerNotification({
        type:     'NOTIF_USER_DESACTIVE',
        titre:    'Utilisateur désactivé',
        message:  `${targetUser?.nom} (${targetUser?.email}) a été désactivé.`,
        srcTable: 'users',
        srcId:    Number(req.params.id),
        createdBy: req.user.id,
      });
    } catch (_) {}
  });
  res.json({ ok: true });
});

// Liste des employés (exclut les agents sortis — non sélectionnables dans paie/avances/congés)
router.get('/employes', (req, res) => {
  const employes = db.prepare("SELECT * FROM employes WHERE actif = 1 AND statut_dossier != 'sorti' ORDER BY type, nom").all();
  res.json(employes);
});

router.post('/employes', (req, res) => {
  if (!canManageEmployeeRegistry(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
  const { nom, prenom, poste, type = 'permanent', salaire_base = 0,
          mode_paiement = 'especes', banque = '', numero_compte = '' } = req.body;
  const result = db.prepare(
    'INSERT INTO employes (nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte);
  res.status(201).json({ id: result.lastInsertRowid, nom, prenom, poste, type, salaire_base, mode_paiement, banque, numero_compte });
});

router.put('/employes/:id', (req, res) => {
  if (!canManageEmployeeRegistry(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
  const { nom, prenom, poste, type, salaire_base, actif,
          mode_paiement = 'especes', banque = '', numero_compte = '' } = req.body;
  db.prepare(
    'UPDATE employes SET nom=?, prenom=?, poste=?, type=?, salaire_base=?, actif=?, mode_paiement=?, banque=?, numero_compte=? WHERE id=?'
  ).run(nom, prenom, poste, type, salaire_base, actif ? 1 : 0, mode_paiement, banque || '', numero_compte || '', req.params.id);
  res.json({ ok: true });
});

// Supprimer un employé
router.delete('/employes/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  db.prepare('UPDATE employes SET actif = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Categories
router.get('/categories', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE actif = 1 ORDER BY type, nom').all();
  res.json(cats);
});

router.post('/categories', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { nom, type, couleur = '#6366f1', icone = 'circle' } = req.body;
  const result = db.prepare('INSERT INTO categories (nom, type, couleur, icone, actif) VALUES (?, ?, ?, ?, 1)').run(nom, type, couleur, icone);
  res.status(201).json({ id: result.lastInsertRowid, nom, type, couleur, icone, actif: 1 });
});

router.put('/categories/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { nom, type, couleur, icone } = req.body;
  db.prepare('UPDATE categories SET nom=?, type=?, couleur=?, icone=? WHERE id=?').run(nom, type, couleur || '#6366f1', icone || 'circle', req.params.id);
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  // Soft-delete : vérifier si des opérations référencent cette catégorie
  const usage = db.prepare('SELECT COUNT(*) as c FROM operations WHERE categorie_id = ?').get(req.params.id).c;
  if (usage > 0) {
    // Désactivation douce — préserve l'intégrité des données historiques
    db.prepare('UPDATE categories SET actif = 0 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, soft: true, message: `Catégorie désactivée (${usage} opération(s) liée(s))` });
  }
  // Suppression physique si aucun usage
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true, soft: false });
});

// Paramètres
router.get('/parametres', (req, res) => {
  const params = db.prepare('SELECT * FROM parametres').all();
  const obj = {};
  params.forEach(p => obj[p.cle] = p.valeur);
  res.json(obj);
});

router.put('/parametres', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

  // Capture valeurs avant modification pour audit
  const avant = {};
  db.prepare('SELECT cle, valeur FROM parametres').all().forEach(p => { avant[p.cle] = p.valeur; });

  const upd = db.prepare('INSERT OR REPLACE INTO parametres (cle, valeur) VALUES (?, ?)');
  const tx = db.transaction(() => {
    Object.entries(req.body).forEach(([k, v]) => upd.run(k, String(v)));
  });
  tx();

  // Audit : enregistre uniquement les clés réellement modifiées
  const modifs = {};
  Object.entries(req.body).forEach(([k, v]) => {
    if (String(avant[k] ?? '') !== String(v)) modifs[k] = { avant: avant[k] ?? null, apres: String(v) };
  });
  if (Object.keys(modifs).length > 0) {
    db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('parametres', 0, 'update', ?, ?)")
      .run(JSON.stringify(modifs), req.user.id);
  }

  res.json({ ok: true });
});

// Test connexion SMTP
router.post('/email/test', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  try {
    const { testConnection, sendMail } = require('../services/email');
    await testConnection();
    await sendMail({ to: req.user.email, subject: 'Test SMTP — TOP CENTER Caisse', html: '<p>✅ La configuration SMTP fonctionne correctement.</p>' });
    res.json({ ok: true, message: `Email de test envoyé à ${req.user.email}` });
  } catch (e) {
    res.status(500).json({ error: 'Échec SMTP: ' + e.message });
  }
});

// A4 — Ancienne route dépréciée : redirige vers la nouvelle route serveur-side
// Conservée pour compatibilité ascendante mais sécurisée (admin uniquement, HTML ignoré)
router.post('/bulletin/:employe_id/email', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis — utilisez POST /api/salaires/bulletin/:id/email' });
  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.employe_id);
  if (!emp) return res.status(404).json({ error: 'Employé non trouvé' });
  const { mois, annee } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
  // Trouver le bulletin correspondant et déléguer à la route canonique
  const bulletin = db.prepare('SELECT id FROM bulletins_salaire WHERE employe_id=? AND mois=? AND annee=?').get(emp.id, Number(mois), Number(annee));
  if (!bulletin) return res.status(404).json({ error: `Aucun bulletin pour ${mois}/${annee}` });
  // Redirection interne : réponse directe avec l'id pour que le client utilise la bonne route
  res.status(301).json({
    deprecated: true,
    message:    'Utilisez POST /api/salaires/bulletin/' + bulletin.id + '/email',
    bulletin_id: bulletin.id
  });
});

// ─── Fournisseurs ────────────────────────────────────────────────────────────
router.get('/fournisseurs', (req, res) => {
  res.json(db.prepare("SELECT * FROM fournisseurs WHERE actif = 1 ORDER BY nom").all());
});

router.post('/fournisseurs', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare('INSERT INTO fournisseurs (nom,telephone,reference,nif_rccm,adresse) VALUES (?,?,?,?,?)').run(nom, telephone, reference, nif_rccm, adresse);
  res.status(201).json({ id: r.lastInsertRowid, nom, telephone, reference, nif_rccm, adresse });
});

router.put('/fournisseurs/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
  db.prepare('UPDATE fournisseurs SET nom=?,telephone=?,reference=?,nif_rccm=?,adresse=? WHERE id=?').run(nom, telephone, reference, nif_rccm, adresse, req.params.id);
  res.json({ ok: true });
});

router.delete('/fournisseurs/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
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
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { code, libelle, type = 'caisse', solde_initial = 0, couleur = '#6366f1', ordre = 0 } = req.body;
  try {
    const r = db.prepare('INSERT INTO positions (code,libelle,type,solde_initial,couleur,ordre) VALUES (?,?,?,?,?,?)').run(code, libelle, type, solde_initial, couleur, ordre);
    res.status(201).json({ id: r.lastInsertRowid, code, libelle, type, solde_initial, couleur, ordre });
  } catch { res.status(409).json({ error: 'Code déjà utilisé' }); }
});

router.put('/positions/:id', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
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
  const user = db.prepare('SELECT id, nom, email, role, roles, photo_url, employe_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.json({});
  const result = { ...user, roles: parseRoles(user) };
  // Joindre le nom complet de l'employé lié si disponible
  if (user.employe_id) {
    const emp = db.prepare('SELECT id, nom, prenom, matricule, poste FROM employes WHERE id = ?').get(user.employe_id);
    if (emp) result.employe = emp;
  }
  res.json(result);
});

module.exports = router;

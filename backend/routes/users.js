const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
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
router.get('/', async (req, res, next) => {
  try {
    if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
    const users = await db.query(`
      SELECT u.id, u.nom, u.prenom, u.email, u.login_identifier, u.role, u.roles, u.sous_role, u.actif, u.employe_id, u.created_at,
             e.nom AS employe_nom, e.prenom AS employe_prenom, e.matricule AS employe_matricule, e.poste AS employe_poste
      FROM users u
      LEFT JOIN employes e ON e.id = u.employe_id
      ORDER BY u.nom
    `);
    res.json(users.map(userDto));
  } catch (error) { next(error); }
});

// Créer un utilisateur
router.post('/', async (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  try {
    const created = await identityAccess.createUserAccess(req.body, req.user.id);
    setImmediate(() => {
      Promise.resolve(creerNotification({
        type:     'NOTIF_USER_CREE',
        titre:    'Nouvel utilisateur créé',
        message:  `${created.nom} (${created.email}) — rôle : ${created.role}.`,
        srcTable: 'users',
        srcId:    created.id,
        createdBy: req.user.id,
      })).catch(() => {});
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Modifier un utilisateur
router.put('/:id', async (req, res) => {
  if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
  const existing = await db.queryOne('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Utilisateur introuvable' });
  try {
    await identityAccess.updateUserAccess(req.params.id, req.body, req.user.id);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ ok: true });
});

// Supprimer un utilisateur
router.delete('/:id', async (req, res, next) => {
  try {
    if (!canManageUsers(req.user)) return res.status(403).json({ error: 'Admin ou DG requis' });
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const targetUser = await db.queryOne('SELECT nom, email FROM users WHERE id=?', [req.params.id]);
    await db.execute('UPDATE users SET actif = 0 WHERE id = ?', [req.params.id]);
    setImmediate(() => {
      Promise.resolve(creerNotification({
        type:     'NOTIF_USER_DESACTIVE',
        titre:    'Utilisateur désactivé',
        message:  `${targetUser?.nom} (${targetUser?.email}) a été désactivé.`,
        srcTable: 'users',
        srcId:    Number(req.params.id),
        createdBy: req.user.id,
      })).catch(() => {});
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Liste des employés (exclut les agents sortis — non sélectionnables dans paie/avances/congés)
router.get('/employes', async (_req, res, next) => {
  try {
    const employes = await db.query("SELECT * FROM employes WHERE actif = 1 AND statut_dossier != 'sorti' ORDER BY type, nom");
    res.json(employes);
  } catch (error) { next(error); }
});

function rejectLegacyEmployeeMutation(_req, res) {
  res.status(410).json({
    error: 'Création/modification employé minimal désactivée — utilisez le module Agents pour préserver la fiche RH complète.',
    code: 'LEGACY_EMPLOYEE_MUTATION_DISABLED',
  });
}

router.post('/employes', rejectLegacyEmployeeMutation);
router.put('/employes/:id', rejectLegacyEmployeeMutation);
router.delete('/employes/:id', rejectLegacyEmployeeMutation);

// Categories
router.get('/categories', async (_req, res, next) => {
  try {
    res.json(await db.query('SELECT * FROM categories WHERE actif = 1 ORDER BY type, nom'));
  } catch (error) { next(error); }
});

router.post('/categories', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
    const { nom, type, couleur = '#6366f1', icone = 'circle' } = req.body;
    const result = await db.execute('INSERT INTO categories (nom, type, couleur, icone, actif) VALUES (?, ?, ?, ?, 1)', [nom, type, couleur, icone]);
    res.status(201).json({ id: result.insertId, nom, type, couleur, icone, actif: 1 });
  } catch (error) { next(error); }
});

router.put('/categories/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
    const { nom, type, couleur, icone } = req.body;
    await db.execute('UPDATE categories SET nom=?, type=?, couleur=?, icone=? WHERE id=?', [nom, type, couleur || '#6366f1', icone || 'circle', req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
    const usage = Number((await db.queryOne('SELECT COUNT(*) as c FROM operations WHERE categorie_id = ?', [req.params.id]))?.c || 0);
    if (usage > 0) {
      await db.execute('UPDATE categories SET actif = 0 WHERE id = ?', [req.params.id]);
      return res.json({ ok: true, soft: true, message: `Catégorie désactivée (${usage} opération(s) liée(s))` });
    }
    await db.execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ ok: true, soft: false });
  } catch (error) { next(error); }
});

// Paramètres
router.get('/parametres', async (_req, res, next) => {
  try {
    const params = await db.query('SELECT * FROM parametres');
    const obj = {};
    params.forEach(p => { obj[p.cle] = p.valeur; });
    res.json(obj);
  } catch (error) { next(error); }
});

router.put('/parametres', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });

    const modifs = await db.transaction(async tx => {
      const rows = await tx.query('SELECT cle, valeur FROM parametres');
      const avant = {};
      rows.forEach(p => { avant[p.cle] = p.valeur; });

      for (const [cle, value] of Object.entries(req.body || {})) {
        const valeur = String(value);
        const exists = Object.prototype.hasOwnProperty.call(avant, cle);
        if (exists) await tx.execute('UPDATE parametres SET valeur=? WHERE cle=?', [valeur, cle]);
        else await tx.execute('INSERT INTO parametres (cle, valeur) VALUES (?, ?)', [cle, valeur]);
      }

      const changes = {};
      for (const [cle, value] of Object.entries(req.body || {})) {
        if (String(avant[cle] ?? '') !== String(value)) changes[cle] = { avant: avant[cle] ?? null, apres: String(value) };
      }
      if (Object.keys(changes).length > 0) {
        await tx.execute(
          "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('parametres', 0, 'update', ?, ?)",
          [JSON.stringify(changes), req.user.id],
        );
      }
      return changes;
    });

    res.json({ ok: true, updated: Object.keys(modifs).length });
  } catch (error) { next(error); }
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
router.post('/bulletin/:employe_id/email', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis — utilisez POST /api/salaires/bulletin/:id/email' });
    const emp = await db.queryOne('SELECT * FROM employes WHERE id = ?', [req.params.employe_id]);
    if (!emp) return res.status(404).json({ error: 'Employé non trouvé' });
    const { mois, annee } = req.body;
    if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
    const bulletin = await db.queryOne('SELECT id FROM bulletins_salaire WHERE employe_id=? AND mois=? AND annee=?', [emp.id, Number(mois), Number(annee)]);
    if (!bulletin) return res.status(404).json({ error: `Aucun bulletin pour ${mois}/${annee}` });
    res.status(301).json({
      deprecated: true,
      message: 'Utilisez POST /api/salaires/bulletin/' + bulletin.id + '/email',
      bulletin_id: bulletin.id,
    });
  } catch (error) { next(error); }
});

// ─── Fournisseurs ────────────────────────────────────────────────────────────
router.get('/fournisseurs', async (_req, res, next) => {
  try { res.json(await db.query('SELECT * FROM fournisseurs WHERE actif = 1 ORDER BY nom')); }
  catch (error) { next(error); }
});

router.post('/fournisseurs', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    const result = await db.execute('INSERT INTO fournisseurs (nom,telephone,reference,nif_rccm,adresse) VALUES (?,?,?,?,?)', [nom, telephone, reference, nif_rccm, adresse]);
    res.status(201).json({ id: result.insertId, nom, telephone, reference, nif_rccm, adresse });
  } catch (error) { next(error); }
});

router.put('/fournisseurs/:id', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { nom, telephone = '', reference = '', nif_rccm = '', adresse = '' } = req.body;
    await db.execute('UPDATE fournisseurs SET nom=?,telephone=?,reference=?,nif_rccm=?,adresse=? WHERE id=?', [nom, telephone, reference, nif_rccm, adresse, req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/fournisseurs/:id', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    await db.execute('UPDATE fournisseurs SET actif = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ─── Rapport salaires mensuel ────────────────────────────────────────────────
router.get('/salaires/rapport', async (req, res, next) => {
  try {
    const { mois, annee } = req.query;
    const m = Number(mois) || new Date().getMonth() + 1;
    const a = Number(annee) || new Date().getFullYear();
    const debut = `${a}-${String(m).padStart(2,'0')}-01`;
    const fin = `${a}-${String(m).padStart(2,'0')}-31`;

    const [employes, paiements] = await Promise.all([
      db.query("SELECT * FROM employes WHERE actif = 1 AND statut_dossier != 'sorti' ORDER BY type, nom"),
      db.query(`
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
      `, [debut, fin]),
    ]);

    const payMap = {};
    paiements.forEach(p => { payMap[p.employe_id] = p; });
    const rapport = employes.map(e => ({
      ...e,
      paye: payMap[e.id]?.paye || 0,
      decharge: payMap[e.id]?.decharge_signee || 0,
      restant: e.salaire_base - (payMap[e.id]?.paye || 0),
    }));
    res.json({ mois: m, annee: a, employes: rapport });
  } catch (error) { next(error); }
});

// ─── Positions de trésorerie ─────────────────────────────────────────────
router.get('/positions', async (_req, res, next) => {
  try { res.json(await db.query('SELECT * FROM positions ORDER BY ordre')); }
  catch (error) { next(error); }
});

router.post('/positions', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
  const { code, libelle, type = 'caisse', solde_initial = 0, couleur = '#6366f1', ordre = 0 } = req.body;
  try {
    const result = await db.execute('INSERT INTO positions (code,libelle,type,solde_initial,couleur,ordre) VALUES (?,?,?,?,?,?)', [code, libelle, type, solde_initial, couleur, ordre]);
    res.status(201).json({ id: result.insertId, code, libelle, type, solde_initial, couleur, ordre });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || /UNIQUE constraint failed/i.test(error?.message || '')) return res.status(409).json({ error: 'Code déjà utilisé' });
    res.status(500).json({ error: error.message });
  }
});

router.put('/positions/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin requis' });
    const { libelle, type, solde_initial, couleur, ordre, actif } = req.body;
    await db.execute('UPDATE positions SET libelle=?,type=?,solde_initial=?,couleur=?,ordre=?,actif=? WHERE id=?', [libelle, type, solde_initial, couleur, ordre, actif ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Bulletin de paie (données)
router.get('/bulletin/:employe_id', async (req, res, next) => {
  try {
    const { mois, annee } = req.query;
    const m = Number(mois) || new Date().getMonth() + 1;
    const a = Number(annee) || new Date().getFullYear();
    const emp = await db.queryOne('SELECT * FROM employes WHERE id = ?', [req.params.employe_id]);
    if (!emp) return res.status(404).json({ error: 'Employé non trouvé' });
    const debut = `${a}-${String(m).padStart(2,'0')}-01`;
    const fin = `${a}-${String(m).padStart(2,'0')}-31`;
    const [ops, paramsRows] = await Promise.all([
      db.query(`SELECT o.*, c.nom as cat_nom FROM operations o LEFT JOIN categories c ON o.categorie_id=c.id WHERE o.employe_id=? AND o.date BETWEEN ? AND ? AND o.statut='valide' ORDER BY o.date`, [emp.id, debut, fin]),
      db.query('SELECT * FROM parametres'),
    ]);
    const totalPaye = ops.reduce((sum, op) => sum + (Number(op.montant) || 0), 0);
    const params = paramsRows.reduce((obj, p) => ({ ...obj, [p.cle]: p.valeur }), {});
    res.json({ employe: emp, mois: m, annee: a, operations: ops, total_paye: totalPaye, societe: params.societe || 'TOP CENTER', devise: params.devise || 'XAF' });
  } catch (error) { next(error); }
});

// ─── Upload photo profil utilisateur connecté ─────────────────────────────────
router.post('/me/photo', uploadUser.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const user = await db.queryOne('SELECT photo_url FROM users WHERE id = ?', [req.user.id]);
    if (user?.photo_url) {
      const old = path.join(uploadsDir, path.basename(user.photo_url));
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    const photoUrl = '/uploads/' + req.file.filename;
    await db.execute('UPDATE users SET photo_url = ? WHERE id = ?', [photoUrl, req.user.id]);
    res.json({ ok: true, photo_url: photoUrl });
  } catch (error) { next(error); }
});

router.get('/me', async (req, res, next) => {
  try {
    const user = await db.queryOne('SELECT id, nom, email, role, roles, photo_url, employe_id FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.json({});
    const result = { ...user, roles: parseRoles(user) };
    if (user.employe_id) {
      const emp = await db.queryOne('SELECT id, nom, prenom, matricule, poste FROM employes WHERE id = ?', [user.employe_id]);
      if (emp) result.employe = emp;
    }
    res.json(result);
  } catch (error) { next(error); }
});

module.exports = router;

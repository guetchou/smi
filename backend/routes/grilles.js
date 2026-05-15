/**
 * MODULE GRILLES SALARIALES — TOP CENTER
 * Référentiel rémunération : grille → catégorie → échelon
 * Workflow : brouillon → soumis → valide → archive (approbation DG)
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');

// Lecture : tous les rôles authentifiés
// Écriture : admin, rh, finance, dg
// Approbation : dg, admin
function canWrite(user)   { return hasRole(user, 'admin', 'rh', 'finance', 'dg'); }
function canApprove(user) { return hasRole(user, 'admin', 'dg'); }
function canAffecter(user){ return hasRole(user, 'admin', 'rh', 'finance'); }

function audit(table, id, action, details, userId) {
  try {
    db.prepare(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)"
    ).run(table, id, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── GRILLES ─────────────────────────────────────────────────────────────────

// GET /api/grilles/ — liste des grilles (filtres optionnels : statut)
router.get('/', (req, res) => {
  const { statut } = req.query;
  let sql = `
    SELECT g.*,
           COUNT(DISTINCT gc.id) AS nb_categories,
           u1.nom AS created_by_nom,
           u2.nom AS approved_by_nom
    FROM grilles_salariales g
    LEFT JOIN grille_categories gc ON gc.grille_id = g.id
    LEFT JOIN users u1 ON u1.id = g.created_by
    LEFT JOIN users u2 ON u2.id = g.approved_by
  `;
  const args = [];
  if (statut) { sql += ' WHERE g.statut = ?'; args.push(statut); }
  sql += ' GROUP BY g.id ORDER BY g.annee DESC, g.created_at DESC';
  // annee n'existe pas encore — retirer l'ordre par annee
  sql = sql.replace(' g.annee DESC,', '');
  res.json(db.prepare(sql).all(...args));
});

// GET /api/grilles/:id — détail d'une grille avec catégories et échelons
router.get('/:id', (req, res) => {
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });

  const categories = db.prepare(
    'SELECT * FROM grille_categories WHERE grille_id = ? ORDER BY code'
  ).all(grille.id);

  for (const cat of categories) {
    cat.echelons = db.prepare(
      'SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon'
    ).all(cat.id);
  }

  res.json({ ...grille, categories });
});

// POST /api/grilles/ — créer une grille (brouillon)
router.post('/', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { code, libelle, date_debut, date_fin } = req.body;
  if (!code || !libelle || !date_debut)
    return res.status(400).json({ error: 'code, libelle et date_debut sont requis' });

  const existing = db.prepare('SELECT id FROM grilles_salariales WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: `Une grille avec le code "${code}" existe déjà` });

  const r = db.prepare(`
    INSERT INTO grilles_salariales (code, libelle, date_debut, date_fin, statut, created_by, updated_at)
    VALUES (?, ?, ?, ?, 'brouillon', ?, datetime('now'))
  `).run(code, libelle, date_debut, date_fin || null, req.user.id);

  audit('grilles_salariales', r.lastInsertRowid, 'creer', { code, libelle }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, code, libelle, date_debut, statut: 'brouillon' });
});

// PUT /api/grilles/:id — modifier (brouillon uniquement)
router.put('/:id', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (grille.statut !== 'brouillon')
    return res.status(400).json({ error: `Grille en statut "${grille.statut}" — modification impossible` });

  const { code = grille.code, libelle = grille.libelle,
          date_debut = grille.date_debut, date_fin = grille.date_fin } = req.body;

  if (code !== grille.code) {
    const dup = db.prepare('SELECT id FROM grilles_salariales WHERE code = ? AND id != ?').get(code, grille.id);
    if (dup) return res.status(409).json({ error: `Code "${code}" déjà utilisé` });
  }

  db.prepare(`
    UPDATE grilles_salariales SET code=?, libelle=?, date_debut=?, date_fin=?, updated_at=datetime('now')
    WHERE id=?
  `).run(code, libelle, date_debut, date_fin || null, grille.id);

  audit('grilles_salariales', grille.id, 'modifier', { code, libelle }, req.user.id);
  res.json({ ok: true });
});

// POST /api/grilles/:id/soumettre — brouillon → soumis
router.post('/:id/soumettre', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (grille.statut !== 'brouillon')
    return res.status(400).json({ error: `Statut actuel "${grille.statut}" — soumission impossible` });

  const nbCat = db.prepare('SELECT COUNT(*) AS c FROM grille_categories WHERE grille_id = ?').get(grille.id).c;
  if (nbCat === 0)
    return res.status(400).json({ error: 'La grille doit contenir au moins une catégorie avant soumission' });

  if (canApprove(req.user)) {
    db.prepare(`
      UPDATE grilles_salariales
      SET statut='valide', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, grille.id);
    audit('grilles_salariales', grille.id, 'soumettre_auto_valider_dg',
      { code: grille.code, libelle: grille.libelle }, req.user.id);
    return res.json({ ok: true, statut: 'valide', auto_approved: true });
  }

  db.prepare(`UPDATE grilles_salariales SET statut='soumis', updated_at=datetime('now') WHERE id=?`).run(grille.id);
  audit('grilles_salariales', grille.id, 'soumettre', null, req.user.id);
  res.json({ ok: true, statut: 'soumis' });
});

// POST /api/grilles/:id/valider-dg — soumis → valide (DG/admin uniquement)
router.post('/:id/valider-dg', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (grille.statut !== 'soumis')
    return res.status(400).json({ error: `Statut actuel "${grille.statut}" — validation impossible` });

  db.prepare(`
    UPDATE grilles_salariales
    SET statut='valide', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, grille.id);

  audit('grilles_salariales', grille.id, 'valider_dg',
    { code: grille.code, libelle: grille.libelle }, req.user.id);
  res.json({ ok: true, statut: 'valide' });
});

// POST /api/grilles/:id/archiver — valide → archive (DG/admin)
router.post('/:id/archiver', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (grille.statut !== 'valide')
    return res.status(400).json({ error: `Seule une grille validée peut être archivée` });

  db.prepare(`UPDATE grilles_salariales SET statut='archive', updated_at=datetime('now') WHERE id=?`).run(grille.id);
  audit('grilles_salariales', grille.id, 'archiver', null, req.user.id);
  res.json({ ok: true, statut: 'archive' });
});

// ─── CATÉGORIES ──────────────────────────────────────────────────────────────

// GET /api/grilles/:id/categories
router.get('/:id/categories', (req, res) => {
  const grille = db.prepare('SELECT id FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  const cats = db.prepare(
    'SELECT * FROM grille_categories WHERE grille_id = ? ORDER BY code'
  ).all(grille.id);
  for (const c of cats) {
    c.echelons = db.prepare(
      'SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon'
    ).all(c.id);
  }
  res.json(cats);
});

// POST /api/grilles/:id/categories — ajouter catégorie
router.post('/:id/categories', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (!['brouillon', 'soumis'].includes(grille.statut))
    return res.status(400).json({ error: 'Grille verrouillée — archivez-la pour créer une nouvelle version' });

  const { code, libelle, salaire_min = 0, salaire_max,
          coefficient_min, coefficient_max } = req.body;
  if (!code || !libelle)
    return res.status(400).json({ error: 'code et libelle requis' });

  const dup = db.prepare(
    'SELECT id FROM grille_categories WHERE grille_id = ? AND code = ?'
  ).get(grille.id, code);
  if (dup) return res.status(409).json({ error: `Catégorie "${code}" existe déjà dans cette grille` });

  const r = db.prepare(`
    INSERT INTO grille_categories
      (grille_id, code, libelle, salaire_min, salaire_max, coefficient_min, coefficient_max)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(grille.id, code, libelle, salaire_min, salaire_max || null,
         coefficient_min || null, coefficient_max || null);

  res.status(201).json({ id: r.lastInsertRowid, code, libelle, salaire_min, echelons: [] });
});

// PUT /api/grilles/:id/categories/:cid — modifier catégorie
router.put('/:id/categories/:cid', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const grille = db.prepare('SELECT * FROM grilles_salariales WHERE id = ?').get(req.params.id);
  if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
  if (!['brouillon', 'soumis'].includes(grille.statut))
    return res.status(400).json({ error: 'Grille verrouillée' });

  const cat = db.prepare(
    'SELECT * FROM grille_categories WHERE id = ? AND grille_id = ?'
  ).get(req.params.cid, grille.id);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });

  const { code = cat.code, libelle = cat.libelle,
          salaire_min = cat.salaire_min, salaire_max = cat.salaire_max,
          coefficient_min = cat.coefficient_min, coefficient_max = cat.coefficient_max,
          actif = cat.actif } = req.body;

  db.prepare(`
    UPDATE grille_categories
    SET code=?, libelle=?, salaire_min=?, salaire_max=?,
        coefficient_min=?, coefficient_max=?, actif=?
    WHERE id=?
  `).run(code, libelle, salaire_min, salaire_max || null,
         coefficient_min || null, coefficient_max || null, actif ? 1 : 0, cat.id);

  res.json({ ok: true });
});

// ─── ÉCHELONS ────────────────────────────────────────────────────────────────

// GET /api/grilles/categories/:cid/echelons
router.get('/categories/:cid/echelons', (req, res) => {
  const cat = db.prepare('SELECT * FROM grille_categories WHERE id = ?').get(req.params.cid);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });
  res.json(db.prepare(
    'SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon'
  ).all(cat.id));
});

// POST /api/grilles/categories/:cid/echelons — ajouter échelon
router.post('/categories/:cid/echelons', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const cat = db.prepare(
    'SELECT gc.*, gs.statut AS grille_statut FROM grille_categories gc JOIN grilles_salariales gs ON gs.id = gc.grille_id WHERE gc.id = ?'
  ).get(req.params.cid);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });
  if (!['brouillon', 'soumis'].includes(cat.grille_statut))
    return res.status(400).json({ error: 'Grille verrouillée' });

  const { echelon, salaire_reference, salaire_min, salaire_max,
          prime_transport = 0, prime_logement = 0,
          anciennete_min_ans = 0 } = req.body;
  if (!echelon || !salaire_reference)
    return res.status(400).json({ error: 'echelon et salaire_reference requis' });

  const dup = db.prepare(
    'SELECT id FROM grille_echelons WHERE categorie_id = ? AND echelon = ?'
  ).get(cat.id, echelon);
  if (dup) return res.status(409).json({ error: `Échelon ${echelon} existe déjà` });

  const r = db.prepare(`
    INSERT INTO grille_echelons
      (categorie_id, echelon, salaire_reference, salaire_min, salaire_max,
       prime_transport, prime_logement, anciennete_min_ans)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cat.id, echelon, salaire_reference,
         salaire_min || salaire_reference, salaire_max || null,
         prime_transport, prime_logement, anciennete_min_ans);

  res.status(201).json({ id: r.lastInsertRowid, echelon, salaire_reference });
});

// PUT /api/grilles/echelons/:eid — modifier échelon
router.put('/echelons/:eid', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const ech = db.prepare(`
    SELECT ge.*, gs.statut AS grille_statut
    FROM grille_echelons ge
    JOIN grille_categories gc ON gc.id = ge.categorie_id
    JOIN grilles_salariales gs ON gs.id = gc.grille_id
    WHERE ge.id = ?
  `).get(req.params.eid);
  if (!ech) return res.status(404).json({ error: 'Échelon introuvable' });
  if (!['brouillon', 'soumis'].includes(ech.grille_statut))
    return res.status(400).json({ error: 'Grille verrouillée' });

  const { salaire_reference = ech.salaire_reference,
          salaire_min = ech.salaire_min, salaire_max = ech.salaire_max,
          prime_transport = ech.prime_transport, prime_logement = ech.prime_logement,
          anciennete_min_ans = ech.anciennete_min_ans, actif = ech.actif } = req.body;

  db.prepare(`
    UPDATE grille_echelons
    SET salaire_reference=?, salaire_min=?, salaire_max=?,
        prime_transport=?, prime_logement=?, anciennete_min_ans=?, actif=?
    WHERE id=?
  `).run(salaire_reference, salaire_min, salaire_max || null,
         prime_transport, prime_logement, anciennete_min_ans, actif ? 1 : 0, ech.id);

  res.json({ ok: true });
});

// ─── AFFECTATION AGENT ────────────────────────────────────────────────────────

// GET /api/grilles/agent/:id — catégorie + échelon courant d'un agent
router.get('/agent/:id', (req, res) => {
  const agent = db.prepare(`
    SELECT e.id, e.nom, e.prenom, e.salaire_base, e.prime_transport, e.prime_logement,
           e.grille_categorie_id, e.grille_echelon_id,
           gc.code AS categorie_code, gc.libelle AS categorie_libelle,
           gc.salaire_min AS cat_salaire_min, gc.salaire_max AS cat_salaire_max,
           ge.echelon AS echelon_num, ge.salaire_reference, ge.salaire_min AS ech_salaire_min,
           ge.salaire_max AS ech_salaire_max,
           gs.code AS grille_code, gs.libelle AS grille_libelle, gs.statut AS grille_statut
    FROM employes e
    LEFT JOIN grille_categories gc ON gc.id = e.grille_categorie_id
    LEFT JOIN grille_echelons ge   ON ge.id = e.grille_echelon_id
    LEFT JOIN grilles_salariales gs ON gs.id = gc.grille_id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  // Alerte si salaire hors borne de l'échelon
  let alerte_borne = null;
  if (agent.grille_echelon_id) {
    if (agent.ech_salaire_min && agent.salaire_base < agent.ech_salaire_min)
      alerte_borne = 'inferieur_min';
    else if (agent.ech_salaire_max && agent.salaire_base > agent.ech_salaire_max)
      alerte_borne = 'superieur_max';
  }

  res.json({ ...agent, alerte_borne });
});

// PUT /api/grilles/agent/:id/affecter — affecter catégorie + échelon à un agent
router.put('/agent/:id/affecter', (req, res) => {
  if (!canAffecter(req.user))
    return res.status(403).json({ error: 'Rôle Admin, RH ou Finance requis' });

  const agent = db.prepare('SELECT id, nom, prenom, salaire_base FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const { grille_categorie_id, grille_echelon_id } = req.body;

  // Valider que la catégorie existe
  if (grille_categorie_id) {
    const cat = db.prepare('SELECT id FROM grille_categories WHERE id = ?').get(grille_categorie_id);
    if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });
  }
  // Valider que l'échelon appartient bien à la catégorie
  if (grille_echelon_id && grille_categorie_id) {
    const ech = db.prepare(
      'SELECT id, salaire_reference FROM grille_echelons WHERE id = ? AND categorie_id = ?'
    ).get(grille_echelon_id, grille_categorie_id);
    if (!ech) return res.status(400).json({ error: "L'échelon n'appartient pas à cette catégorie" });
  }

  db.prepare(`
    UPDATE employes
    SET grille_categorie_id=?, grille_echelon_id=?, updated_at=datetime('now')
    WHERE id=?
  `).run(grille_categorie_id || null, grille_echelon_id || null, agent.id);

  audit('employes', agent.id, 'affecter_grille',
    { grille_categorie_id, grille_echelon_id }, req.user.id);
  res.json({ ok: true });
});

module.exports = router;

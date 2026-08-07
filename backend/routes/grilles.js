/**
 * MODULE GRILLES SALARIALES — TOP CENTER
 * Référentiel rémunération : grille → catégorie → échelon
 * Workflow : brouillon → soumis → valide → archive (approbation DG)
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');

function canWrite(user) { return hasRole(user, 'admin', 'rh', 'finance', 'dg'); }
function canApprove(user) { return hasRole(user, 'admin', 'dg'); }
function canAffecter(user) { return hasRole(user, 'admin', 'rh', 'finance'); }

async function audit(table, id, action, details, userId) {
  try {
    await db.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      [table, id, action, details ? JSON.stringify(details) : null, userId || null],
    );
  } catch (_) {}
}

router.get('/', async (req, res, next) => {
  try {
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
    sql += ' GROUP BY g.id ORDER BY g.created_at DESC';
    res.json(await db.query(sql, args));
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    const categories = await db.query('SELECT * FROM grille_categories WHERE grille_id = ? ORDER BY code', [grille.id]);
    for (const cat of categories) {
      cat.echelons = await db.query('SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon', [cat.id]);
    }
    res.json({ ...grille, categories });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { code, libelle, date_debut, date_fin } = req.body;
    if (!code || !libelle || !date_debut) return res.status(400).json({ error: 'code, libelle et date_debut sont requis' });
    const existing = await db.queryOne('SELECT id FROM grilles_salariales WHERE code = ?', [code]);
    if (existing) return res.status(409).json({ error: `Une grille avec le code "${code}" existe déjà` });
    const result = await db.execute(`
      INSERT INTO grilles_salariales (code, libelle, date_debut, date_fin, statut, created_by, updated_at)
      VALUES (?, ?, ?, ?, 'brouillon', ?, NOW())
    `, [code, libelle, date_debut, date_fin || null, req.user.id]);
    await audit('grilles_salariales', result.insertId, 'creer', { code, libelle }, req.user.id);
    res.status(201).json({ id: result.insertId, code, libelle, date_debut, statut: 'brouillon' });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (grille.statut !== 'brouillon') return res.status(400).json({ error: `Grille en statut "${grille.statut}" — modification impossible` });
    const { code = grille.code, libelle = grille.libelle, date_debut = grille.date_debut, date_fin = grille.date_fin } = req.body;
    if (code !== grille.code) {
      const duplicate = await db.queryOne('SELECT id FROM grilles_salariales WHERE code = ? AND id != ?', [code, grille.id]);
      if (duplicate) return res.status(409).json({ error: `Code "${code}" déjà utilisé` });
    }
    await db.execute(`
      UPDATE grilles_salariales SET code=?, libelle=?, date_debut=?, date_fin=?, updated_at=NOW()
      WHERE id=?
    `, [code, libelle, date_debut, date_fin || null, grille.id]);
    await audit('grilles_salariales', grille.id, 'modifier', { code, libelle }, req.user.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/:id/soumettre', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (grille.statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${grille.statut}" — soumission impossible` });
    const count = await db.queryOne('SELECT COUNT(*) AS c FROM grille_categories WHERE grille_id = ?', [grille.id]);
    if (Number(count?.c || 0) === 0) return res.status(400).json({ error: 'La grille doit contenir au moins une catégorie avant soumission' });
    if (canApprove(req.user)) {
      await db.execute(`
        UPDATE grilles_salariales SET statut='valide', approved_by=?, approved_at=NOW(), updated_at=NOW() WHERE id=?
      `, [req.user.id, grille.id]);
      await audit('grilles_salariales', grille.id, 'soumettre_auto_valider_dg', { code: grille.code, libelle: grille.libelle }, req.user.id);
      return res.json({ ok: true, statut: 'valide', auto_approved: true });
    }
    await db.execute("UPDATE grilles_salariales SET statut='soumis', updated_at=NOW() WHERE id=?", [grille.id]);
    await audit('grilles_salariales', grille.id, 'soumettre', null, req.user.id);
    res.json({ ok: true, statut: 'soumis' });
  } catch (error) { next(error); }
});

router.post('/:id/valider-dg', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (grille.statut !== 'soumis') return res.status(400).json({ error: `Statut actuel "${grille.statut}" — validation impossible` });
    await db.execute(`
      UPDATE grilles_salariales SET statut='valide', approved_by=?, approved_at=NOW(), updated_at=NOW() WHERE id=?
    `, [req.user.id, grille.id]);
    await audit('grilles_salariales', grille.id, 'valider_dg', { code: grille.code, libelle: grille.libelle }, req.user.id);
    res.json({ ok: true, statut: 'valide' });
  } catch (error) { next(error); }
});

router.post('/:id/archiver', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (grille.statut !== 'valide') return res.status(400).json({ error: 'Seule une grille validée peut être archivée' });
    await db.execute("UPDATE grilles_salariales SET statut='archive', updated_at=NOW() WHERE id=?", [grille.id]);
    await audit('grilles_salariales', grille.id, 'archiver', null, req.user.id);
    res.json({ ok: true, statut: 'archive' });
  } catch (error) { next(error); }
});

router.get('/:id/categories', async (req, res, next) => {
  try {
    const grille = await db.queryOne('SELECT id FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    const categories = await db.query('SELECT * FROM grille_categories WHERE grille_id = ? ORDER BY code', [grille.id]);
    for (const category of categories) {
      category.echelons = await db.query('SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon', [category.id]);
    }
    res.json(categories);
  } catch (error) { next(error); }
});

router.post('/:id/categories', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (!['brouillon', 'soumis'].includes(grille.statut)) return res.status(400).json({ error: 'Grille verrouillée — archivez-la pour créer une nouvelle version' });
    const { code, libelle, salaire_min = 0, salaire_max, coefficient_min, coefficient_max } = req.body;
    if (!code || !libelle) return res.status(400).json({ error: 'code et libelle requis' });
    const duplicate = await db.queryOne('SELECT id FROM grille_categories WHERE grille_id = ? AND code = ?', [grille.id, code]);
    if (duplicate) return res.status(409).json({ error: `Catégorie "${code}" existe déjà dans cette grille` });
    const result = await db.execute(`
      INSERT INTO grille_categories (grille_id, code, libelle, salaire_min, salaire_max, coefficient_min, coefficient_max)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [grille.id, code, libelle, salaire_min, salaire_max || null, coefficient_min || null, coefficient_max || null]);
    res.status(201).json({ id: result.insertId, code, libelle, salaire_min, echelons: [] });
  } catch (error) { next(error); }
});

router.put('/:id/categories/:cid', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const grille = await db.queryOne('SELECT * FROM grilles_salariales WHERE id = ?', [req.params.id]);
    if (!grille) return res.status(404).json({ error: 'Grille introuvable' });
    if (!['brouillon', 'soumis'].includes(grille.statut)) return res.status(400).json({ error: 'Grille verrouillée' });
    const category = await db.queryOne('SELECT * FROM grille_categories WHERE id = ? AND grille_id = ?', [req.params.cid, grille.id]);
    if (!category) return res.status(404).json({ error: 'Catégorie introuvable' });
    const {
      code = category.code,
      libelle = category.libelle,
      salaire_min = category.salaire_min,
      salaire_max = category.salaire_max,
      coefficient_min = category.coefficient_min,
      coefficient_max = category.coefficient_max,
      actif = category.actif,
    } = req.body;
    await db.execute(`
      UPDATE grille_categories SET code=?, libelle=?, salaire_min=?, salaire_max=?, coefficient_min=?, coefficient_max=?, actif=? WHERE id=?
    `, [code, libelle, salaire_min, salaire_max || null, coefficient_min || null, coefficient_max || null, actif ? 1 : 0, category.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/categories/:cid/echelons', async (req, res, next) => {
  try {
    const category = await db.queryOne('SELECT * FROM grille_categories WHERE id = ?', [req.params.cid]);
    if (!category) return res.status(404).json({ error: 'Catégorie introuvable' });
    res.json(await db.query('SELECT * FROM grille_echelons WHERE categorie_id = ? ORDER BY echelon', [category.id]));
  } catch (error) { next(error); }
});

router.post('/categories/:cid/echelons', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const category = await db.queryOne(`
      SELECT gc.*, gs.statut AS grille_statut
      FROM grille_categories gc JOIN grilles_salariales gs ON gs.id = gc.grille_id
      WHERE gc.id = ?
    `, [req.params.cid]);
    if (!category) return res.status(404).json({ error: 'Catégorie introuvable' });
    if (!['brouillon', 'soumis'].includes(category.grille_statut)) return res.status(400).json({ error: 'Grille verrouillée' });
    const { echelon, salaire_reference, salaire_min, salaire_max, prime_transport = 0, prime_logement = 0, anciennete_min_ans = 0 } = req.body;
    if (!echelon || !salaire_reference) return res.status(400).json({ error: 'echelon et salaire_reference requis' });
    const duplicate = await db.queryOne('SELECT id FROM grille_echelons WHERE categorie_id = ? AND echelon = ?', [category.id, echelon]);
    if (duplicate) return res.status(409).json({ error: `Échelon ${echelon} existe déjà` });
    const result = await db.execute(`
      INSERT INTO grille_echelons
        (categorie_id, echelon, salaire_reference, salaire_min, salaire_max, prime_transport, prime_logement, anciennete_min_ans)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [category.id, echelon, salaire_reference, salaire_min || salaire_reference, salaire_max || null, prime_transport, prime_logement, anciennete_min_ans]);
    res.status(201).json({ id: result.insertId, echelon, salaire_reference });
  } catch (error) { next(error); }
});

router.put('/echelons/:eid', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const echelon = await db.queryOne(`
      SELECT ge.*, gs.statut AS grille_statut
      FROM grille_echelons ge
      JOIN grille_categories gc ON gc.id = ge.categorie_id
      JOIN grilles_salariales gs ON gs.id = gc.grille_id
      WHERE ge.id = ?
    `, [req.params.eid]);
    if (!echelon) return res.status(404).json({ error: 'Échelon introuvable' });
    if (!['brouillon', 'soumis'].includes(echelon.grille_statut)) return res.status(400).json({ error: 'Grille verrouillée' });
    const {
      salaire_reference = echelon.salaire_reference,
      salaire_min = echelon.salaire_min,
      salaire_max = echelon.salaire_max,
      prime_transport = echelon.prime_transport,
      prime_logement = echelon.prime_logement,
      anciennete_min_ans = echelon.anciennete_min_ans,
      actif = echelon.actif,
    } = req.body;
    await db.execute(`
      UPDATE grille_echelons
      SET salaire_reference=?, salaire_min=?, salaire_max=?, prime_transport=?, prime_logement=?, anciennete_min_ans=?, actif=?
      WHERE id=?
    `, [salaire_reference, salaire_min, salaire_max || null, prime_transport, prime_logement, anciennete_min_ans, actif ? 1 : 0, echelon.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/agent/:id', async (req, res, next) => {
  try {
    const agent = await db.queryOne(`
      SELECT e.id, e.nom, e.prenom, e.salaire_base, e.prime_transport, e.prime_logement,
             e.grille_categorie_id, e.grille_echelon_id,
             gc.code AS categorie_code, gc.libelle AS categorie_libelle,
             gc.salaire_min AS cat_salaire_min, gc.salaire_max AS cat_salaire_max,
             ge.echelon AS echelon_num, ge.salaire_reference, ge.salaire_min AS ech_salaire_min,
             ge.salaire_max AS ech_salaire_max,
             gs.code AS grille_code, gs.libelle AS grille_libelle, gs.statut AS grille_statut
      FROM employes e
      LEFT JOIN grille_categories gc ON gc.id = e.grille_categorie_id
      LEFT JOIN grille_echelons ge ON ge.id = e.grille_echelon_id
      LEFT JOIN grilles_salariales gs ON gs.id = gc.grille_id
      WHERE e.id = ?
    `, [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    let alerte_borne = null;
    if (agent.grille_echelon_id) {
      if (agent.ech_salaire_min && agent.salaire_base < agent.ech_salaire_min) alerte_borne = 'inferieur_min';
      else if (agent.ech_salaire_max && agent.salaire_base > agent.ech_salaire_max) alerte_borne = 'superieur_max';
    }
    res.json({ ...agent, alerte_borne });
  } catch (error) { next(error); }
});

router.put('/agent/:id/affecter', async (req, res, next) => {
  try {
    if (!canAffecter(req.user)) return res.status(403).json({ error: 'Rôle Admin, RH ou Finance requis' });
    const agent = await db.queryOne('SELECT id, nom, prenom, salaire_base FROM employes WHERE id = ?', [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    const { grille_categorie_id, grille_echelon_id } = req.body;
    if (grille_categorie_id) {
      const category = await db.queryOne('SELECT id FROM grille_categories WHERE id = ?', [grille_categorie_id]);
      if (!category) return res.status(404).json({ error: 'Catégorie introuvable' });
    }
    if (grille_echelon_id && grille_categorie_id) {
      const echelon = await db.queryOne('SELECT id FROM grille_echelons WHERE id = ? AND categorie_id = ?', [grille_echelon_id, grille_categorie_id]);
      if (!echelon) return res.status(400).json({ error: "L'échelon n'appartient pas à cette catégorie" });
    }
    await db.execute(`
      UPDATE employes SET grille_categorie_id=?, grille_echelon_id=?, updated_at=NOW() WHERE id=?
    `, [grille_categorie_id || null, grille_echelon_id || null, agent.id]);
    await audit('employes', agent.id, 'affecter_grille', { grille_categorie_id, grille_echelon_id }, req.user.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;

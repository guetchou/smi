'use strict';
/**
 * MODULE ORGANIGRAMME — TOP CENTER
 * Référentiels postes / départements / sites
 * Hiérarchie (superieur_id) + contrôle de boucle
 * Historique mutations
 */
const express   = require('express');
const db        = require('../database');
const { hasRole } = require('./auth');
const router    = express.Router();

function canRH(user) { return hasRole(user, 'admin', 'rh', 'dg'); }

function audit(table, recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run(table, recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── Utilitaire : détection de boucle hiérarchique ────────────────────────────
// Retourne true si affecter supId comme supérieur de empId crée un cycle.
// Parcourt la chaîne vers le haut jusqu'à 50 niveaux (sécurité anti-infini).
function creeraitBoucle(empId, supId) {
  if (!supId || supId === empId) return true; // soi-même
  let current = supId;
  for (let i = 0; i < 50; i++) {
    const row = db.prepare('SELECT superieur_id FROM employes WHERE id = ?').get(current);
    if (!row || !row.superieur_id) return false;
    if (row.superieur_id === empId) return true;
    current = row.superieur_id;
  }
  return false; // pas de cycle trouvé dans 50 niveaux
}

// ─── Utilitaire : construire l'arbre JSON ─────────────────────────────────────
function buildTree(agents) {
  const map  = new Map(agents.map(a => [a.id, { ...a, enfants: [] }]));
  const roots = [];
  for (const [, node] of map) {
    if (node.superieur_id && map.has(node.superieur_id)) {
      map.get(node.superieur_id).enfants.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ─── Organigramme — arbre complet ─────────────────────────────────────────────

router.get('/arbre', (req, res) => {
  const agents = db.prepare(`
    SELECT e.id, e.nom, e.prenom, e.matricule, e.poste, e.departement, e.site,
           e.superieur_id, e.superieur_hierarchique, e.statut_dossier, e.photo_url,
           e.type_contrat, e.date_embauche,
           s.nom || ' ' || COALESCE(s.prenom,'') AS superieur_nom
    FROM employes e
    LEFT JOIN employes s ON s.id = e.superieur_id
    WHERE e.actif = 1
    ORDER BY e.nom, e.prenom
  `).all();
  res.json({ agents, arbre: buildTree(agents) });
});

// Sous-arbre d'un département
router.get('/arbre/departement/:dept', (req, res) => {
  const dept = req.params.dept;
  const agents = db.prepare(`
    SELECT e.id, e.nom, e.prenom, e.matricule, e.poste, e.departement, e.site,
           e.superieur_id, e.superieur_hierarchique, e.statut_dossier, e.photo_url
    FROM employes e
    WHERE e.actif = 1 AND e.departement = ?
    ORDER BY e.nom, e.prenom
  `).all(dept);
  res.json({ departement: dept, agents, arbre: buildTree(agents) });
});

// ─── Supérieur hiérarchique : affecter (avec contrôle boucle) ─────────────────

router.put('/:id/superieur', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });

  const empId = Number(req.params.id);
  const emp   = db.prepare('SELECT * FROM employes WHERE id = ?').get(empId);
  if (!emp) return res.status(404).json({ error: 'Agent non trouvé' });

  const { superieur_id, motif = '' } = req.body;
  const newSupId = superieur_id ? Number(superieur_id) : null;

  if (newSupId !== null) {
    // Vérifier que le supérieur existe
    const sup = db.prepare('SELECT id, nom, prenom FROM employes WHERE id = ? AND actif = 1').get(newSupId);
    if (!sup) return res.status(404).json({ error: 'Supérieur introuvable ou inactif' });

    // Contrôle boucle
    if (creeraitBoucle(empId, newSupId)) {
      return res.status(409).json({
        error: `Cycle hiérarchique détecté : affecter l'agent ${newSupId} comme supérieur de ${empId} créerait une boucle`,
        code: 'CYCLE_HIERARCHIQUE',
      });
    }
  }

  const ancienSupId  = emp.superieur_id;
  const ancienSupNom = emp.superieur_hierarchique || null;

  // Récupérer le nom du nouveau supérieur pour le champ TEXT miroir
  let newSupNom = null;
  if (newSupId) {
    const s = db.prepare('SELECT nom, prenom FROM employes WHERE id = ?').get(newSupId);
    if (s) newSupNom = `${s.nom} ${s.prenom || ''}`.trim();
  }

  db.prepare(`
    UPDATE employes
    SET superieur_id = ?, superieur_hierarchique = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newSupId, newSupNom, empId);

  // Historique mutation
  _enregistrerMutation({
    employe_id: empId, date_effet: new Date().toISOString().slice(0, 10),
    ancien_sup_id: ancienSupId, ancien_sup_nom: ancienSupNom,
    nouveau_sup_id: newSupId,   nouveau_sup_nom: newSupNom,
    ancien_poste: emp.poste,    nouveau_poste: emp.poste,
    ancien_dept: emp.departement, nouveau_dept: emp.departement,
    ancien_site: emp.site,      nouveau_site: emp.site,
    type_mutation: 'modification', motif: motif || 'Changement supérieur',
    created_by: req.user.id,
  });

  audit('employes', empId, 'superieur_modifie',
    { ancien: ancienSupId, nouveau: newSupId, nom: newSupNom }, req.user.id);

  res.json({ ok: true, superieur_id: newSupId, superieur_nom: newSupNom });
});

// ─── Référentiel Postes ────────────────────────────────────────────────────────

router.get('/postes', (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, COUNT(e.id) AS nb_agents
    FROM org_postes p
    LEFT JOIN employes e ON e.poste = p.libelle AND e.actif = 1
    WHERE p.actif = 1
    GROUP BY p.id
    ORDER BY p.libelle
  `).all();
  res.json(rows);
});

router.post('/postes', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, description = '' } = req.body;
  if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
  const exist = db.prepare("SELECT id FROM org_postes WHERE libelle = ?").get(libelle.trim());
  if (exist) return res.status(409).json({ error: 'Ce poste existe déjà' });
  const r = db.prepare("INSERT INTO org_postes (libelle, description) VALUES (?, ?)").run(libelle.trim(), description.trim());
  audit('org_postes', r.lastInsertRowid, 'create', { libelle: libelle.trim() }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, libelle: libelle.trim(), description: description.trim() });
});

router.put('/postes/:id', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, description, actif } = req.body;
  const row = db.prepare("SELECT * FROM org_postes WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Poste introuvable' });
  db.prepare("UPDATE org_postes SET libelle=?, description=?, actif=?, updated_at=datetime('now') WHERE id=?")
    .run(libelle ?? row.libelle, description ?? row.description, actif !== undefined ? (actif ? 1 : 0) : row.actif, row.id);
  audit('org_postes', row.id, 'update', { libelle, description, actif }, req.user.id);
  res.json({ ok: true });
});

// ─── Référentiel Départements ─────────────────────────────────────────────────

router.get('/departements', (_req, res) => {
  const rows = db.prepare(`
    SELECT d.*, COUNT(e.id) AS nb_agents,
           r.nom || ' ' || COALESCE(r.prenom,'') AS responsable_nom
    FROM org_departements d
    LEFT JOIN employes e ON e.departement = d.libelle AND e.actif = 1
    LEFT JOIN employes r ON r.id = d.responsable_id AND r.actif = 1
    WHERE d.actif = 1
    GROUP BY d.id
    ORDER BY d.libelle
  `).all();
  res.json(rows);
});

router.post('/departements', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, code = '', responsable_id = null, description = '' } = req.body;
  if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
  const exist = db.prepare("SELECT id FROM org_departements WHERE libelle = ?").get(libelle.trim());
  if (exist) return res.status(409).json({ error: 'Ce département existe déjà' });
  const r = db.prepare("INSERT INTO org_departements (libelle, code, responsable_id, description) VALUES (?, ?, ?, ?)")
    .run(libelle.trim(), code.trim(), responsable_id || null, description.trim());
  audit('org_departements', r.lastInsertRowid, 'create', { libelle: libelle.trim() }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, libelle: libelle.trim() });
});

router.put('/departements/:id', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, code, responsable_id, description, actif } = req.body;
  const row = db.prepare("SELECT * FROM org_departements WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Département introuvable' });
  db.prepare(`
    UPDATE org_departements
    SET libelle=?, code=?, responsable_id=?, description=?, actif=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    libelle ?? row.libelle, code ?? row.code,
    responsable_id !== undefined ? (responsable_id || null) : row.responsable_id,
    description ?? row.description,
    actif !== undefined ? (actif ? 1 : 0) : row.actif,
    row.id
  );
  audit('org_departements', row.id, 'update', { libelle, responsable_id, actif }, req.user.id);
  res.json({ ok: true });
});

// ─── Référentiel Sites ────────────────────────────────────────────────────────

router.get('/sites', (_req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(e.id) AS nb_agents
    FROM org_sites s
    LEFT JOIN employes e ON e.site = s.libelle AND e.actif = 1
    WHERE s.actif = 1
    GROUP BY s.id
    ORDER BY s.libelle
  `).all();
  res.json(rows);
});

router.post('/sites', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, ville = '', adresse = '' } = req.body;
  if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
  const exist = db.prepare("SELECT id FROM org_sites WHERE libelle = ?").get(libelle.trim());
  if (exist) return res.status(409).json({ error: 'Ce site existe déjà' });
  const r = db.prepare("INSERT INTO org_sites (libelle, ville, adresse) VALUES (?, ?, ?)")
    .run(libelle.trim(), ville.trim(), adresse.trim());
  audit('org_sites', r.lastInsertRowid, 'create', { libelle: libelle.trim() }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, libelle: libelle.trim() });
});

router.put('/sites/:id', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const { libelle, ville, adresse, actif } = req.body;
  const row = db.prepare("SELECT * FROM org_sites WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Site introuvable' });
  db.prepare("UPDATE org_sites SET libelle=?, ville=?, adresse=?, actif=?, updated_at=datetime('now') WHERE id=?")
    .run(libelle ?? row.libelle, ville ?? row.ville, adresse ?? row.adresse,
         actif !== undefined ? (actif ? 1 : 0) : row.actif, row.id);
  audit('org_sites', row.id, 'update', { libelle, actif }, req.user.id);
  res.json({ ok: true });
});

// ─── Mutations ────────────────────────────────────────────────────────────────

router.get('/mutations', (req, res) => {
  if (!hasRole(req.user, 'admin', 'rh', 'dg', 'finance'))
    return res.status(403).json({ error: 'Accès refusé' });
  const { employe_id, type_mutation, debut, fin, limit = 50, offset = 0 } = req.query;
  let where = '1=1';
  const params = [];
  if (employe_id)    { where += ' AND m.employe_id = ?';      params.push(Number(employe_id)); }
  if (type_mutation) { where += ' AND m.type_mutation = ?';   params.push(type_mutation); }
  if (debut)         { where += ' AND m.date_effet >= ?';     params.push(debut); }
  if (fin)           { where += ' AND m.date_effet <= ?';     params.push(fin); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM employes_mutations m WHERE ${where}`).get(...params).c;
  const rows  = db.prepare(`
    SELECT m.*,
           e.nom  || ' ' || COALESCE(e.prenom,'')  AS employe_nom,
           e.matricule,
           u.nom AS created_by_nom,
           v.nom AS valide_par_nom
    FROM employes_mutations m
    JOIN  employes e ON e.id = m.employe_id
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN users v ON v.id = m.valide_par
    WHERE ${where}
    ORDER BY m.date_effet DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  res.json({ total, rows });
});

// Mutations d'un agent
router.get('/:id/mutations', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.nom AS created_by_nom, v.nom AS valide_par_nom
    FROM employes_mutations m
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN users v ON v.id = m.valide_par
    WHERE m.employe_id = ?
    ORDER BY m.date_effet DESC, m.id DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(rows);
});

// Créer une mutation manuelle
router.post('/mutations', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });

  const {
    employe_id, date_effet, type_mutation = 'modification',
    nouveau_poste, nouveau_dept, nouveau_site, nouveau_sup_id, motif = '',
  } = req.body;

  if (!employe_id || !date_effet)
    return res.status(400).json({ error: 'employe_id et date_effet requis' });

  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(Number(employe_id));
  if (!emp) return res.status(404).json({ error: 'Agent introuvable' });

  const newSupId = nouveau_sup_id ? Number(nouveau_sup_id) : null;
  if (newSupId && creeraitBoucle(Number(employe_id), newSupId))
    return res.status(409).json({ error: 'Cycle hiérarchique détecté', code: 'CYCLE_HIERARCHIQUE' });

  let newSupNom = null;
  if (newSupId) {
    const s = db.prepare('SELECT nom, prenom FROM employes WHERE id = ?').get(newSupId);
    if (s) newSupNom = `${s.nom} ${s.prenom || ''}`.trim();
  }

  // Créer en statut=propose — l'application est différée à l'approbation DG
  const r = db.prepare(`
    INSERT INTO employes_mutations
      (employe_id, date_effet, type_mutation,
       ancien_poste, nouveau_poste,
       ancien_dept,  nouveau_dept,
       ancien_site,  nouveau_site,
       ancien_sup_id, ancien_sup_nom, nouveau_sup_id, nouveau_sup_nom,
       motif, statut, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'propose',?)
  `).run(
    Number(employe_id), date_effet, type_mutation,
    emp.poste,         nouveau_poste ?? emp.poste,
    emp.departement,   nouveau_dept  ?? emp.departement,
    emp.site,          nouveau_site  ?? emp.site,
    emp.superieur_id,  emp.superieur_hierarchique,
    newSupId,          newSupNom,
    motif, req.user.id
  );

  audit('employes_mutations', r.lastInsertRowid, 'propose',
    { type_mutation, employe_id, nouveau_poste, nouveau_dept }, req.user.id);

  if (hasRole(req.user, 'admin', 'dg')) {
    const mut = db.prepare('SELECT * FROM employes_mutations WHERE id = ?').get(r.lastInsertRowid);
    db.prepare(`
      UPDATE employes_mutations
      SET statut='approuve', approuve_par=?, approuve_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, mut.id);
    audit('employes_mutations', mut.id, 'propose_auto_approuver_dg', null, req.user.id);

    const today = new Date().toISOString().slice(0, 10);
    const appliquerMaintenant = mut.date_effective ? mut.date_effective <= today : mut.date_effet <= today;
    if (appliquerMaintenant) {
      _appliquerMutation(mut, req.user.id);
      return res.status(201).json({ id: r.lastInsertRowid, ok: true, statut: 'effectif', auto_approved: true, applique_maintenant: true });
    }
    return res.status(201).json({ id: r.lastInsertRowid, ok: true, statut: 'approuve', auto_approved: true, applique_maintenant: false });
  }

  // Notifier DG
  setImmediate(() => {
    try {
      const { creerNotification } = require('../services/notif');
      const dgs = db.prepare("SELECT id FROM users WHERE actif=1 AND (role IN ('admin','dg') OR roles LIKE '%\"dg\"%')").all();
      const empNom = `${emp.nom} ${emp.prenom || ''}`.trim();
      dgs.forEach(u => creerNotification({
        type: 'NOTIF_MUTATION_PROPOSE',
        titre: 'Mutation proposée',
        message: `Mutation de ${empNom} (${type_mutation}) proposée pour le ${date_effet}. En attente de votre approbation.`,
        srcTable: 'employes_mutations', srcId: r.lastInsertRowid, destinataire_id: u.id,
      }));
    } catch (_) {}
  });

  res.status(201).json({ id: r.lastInsertRowid, ok: true, statut: 'propose' });
});

// ─── PUT /mutations/:id/approuver — DG approuve la mutation ──────────────────
router.put('/mutations/:id/approuver', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg'))
    return res.status(403).json({ error: 'Rôle DG ou Admin requis' });

  const mut = db.prepare('SELECT * FROM employes_mutations WHERE id = ?').get(req.params.id);
  if (!mut) return res.status(404).json({ error: 'Mutation introuvable' });
  if (mut.statut !== 'propose')
    return res.status(400).json({ error: `Statut "${mut.statut}" — approbation impossible` });

  const today = new Date().toISOString().slice(0, 10);
  const appliquerMaintenant = mut.date_effective ? mut.date_effective <= today : mut.date_effet <= today;

  db.prepare(`
    UPDATE employes_mutations
    SET statut='approuve', approuve_par=?, approuve_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, mut.id);
  audit('employes_mutations', mut.id, 'approuver', null, req.user.id);

  if (appliquerMaintenant) {
    _appliquerMutation(mut, req.user.id);
    return res.json({ ok: true, statut: 'effectif', applique_maintenant: true });
  }

  res.json({ ok: true, statut: 'approuve', applique_maintenant: false, date_effective: mut.date_effective || mut.date_effet });
});

// ─── PUT /mutations/:id/refuser — DG refuse la mutation ──────────────────────
router.put('/mutations/:id/refuser', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg'))
    return res.status(403).json({ error: 'Rôle DG ou Admin requis' });

  const mut = db.prepare('SELECT * FROM employes_mutations WHERE id = ?').get(req.params.id);
  if (!mut) return res.status(404).json({ error: 'Mutation introuvable' });
  if (!['propose', 'approuve'].includes(mut.statut))
    return res.status(400).json({ error: `Statut "${mut.statut}" — refus impossible` });

  const { motif_refus } = req.body;
  if (!motif_refus || !String(motif_refus).trim())
    return res.status(400).json({ error: 'motif_refus obligatoire' });

  db.prepare(`
    UPDATE employes_mutations SET statut='annule', motif_refus=? WHERE id=?
  `).run(String(motif_refus).trim(), mut.id);
  audit('employes_mutations', mut.id, 'refuser', { motif_refus }, req.user.id);
  res.json({ ok: true, statut: 'annule' });
});

// ─── Helper : appliquer une mutation approuvée sur l'agent ───────────────────
function _appliquerMutation(mut, userId) {
  const updates = {};
  if (mut.nouveau_poste !== mut.ancien_poste) updates.poste = mut.nouveau_poste;
  if (mut.nouveau_dept  !== mut.ancien_dept)  updates.departement = mut.nouveau_dept;
  if (mut.nouveau_site  !== mut.ancien_site)  updates.site = mut.nouveau_site;
  if (mut.nouveau_sup_id !== mut.ancien_sup_id) {
    updates.superieur_id = mut.nouveau_sup_id;
    updates.superieur_hierarchique = mut.nouveau_sup_nom;
  }
  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE employes SET ${sets}, updated_at=datetime('now') WHERE id=?`)
      .run(...Object.values(updates), mut.employe_id);
  }
  db.prepare("UPDATE employes_mutations SET statut='effectif' WHERE id=?").run(mut.id);
  audit('employes_mutations', mut.id, 'appliquer', null, userId);
}

// ─── Helper interne : mutation automatique sur changement hiérarchique ─────────
function _enregistrerMutation(opts) {
  try {
    db.prepare(`
      INSERT INTO employes_mutations
        (employe_id, date_effet, type_mutation,
         ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
         ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
         nouveau_sup_id, nouveau_sup_nom, motif, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      opts.employe_id, opts.date_effet, opts.type_mutation,
      opts.ancien_poste, opts.nouveau_poste,
      opts.ancien_dept,  opts.nouveau_dept,
      opts.ancien_site,  opts.nouveau_site,
      opts.ancien_sup_id, opts.ancien_sup_nom,
      opts.nouveau_sup_id, opts.nouveau_sup_nom,
      opts.motif || null, opts.created_by || null
    );
  } catch (_) {}
}

module.exports = { router, creeraitBoucle, _enregistrerMutation };

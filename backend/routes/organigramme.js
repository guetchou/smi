'use strict';
/**
 * MODULE ORGANIGRAMME — TOP CENTER
 * Référentiels postes / départements / sites
 * Hiérarchie + historique mutations
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const organizationSvc = require('../services/organization_assignment');
const router = express.Router();

function canRH(user) { return hasRole(user, 'admin', 'rh', 'dg'); }

async function audit(dbc, table, recordId, action, details, userId) {
  await dbc.execute(
    'INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
    [table, recordId, action, details ? JSON.stringify(details) : null, userId || null],
  );
}

async function creeraitBoucle(empId, supId, dbc = db) {
  if (!supId || Number(supId) === Number(empId)) return true;
  const rows = await dbc.query(`
    SELECT id, superieur_id
    FROM employes
    WHERE actif = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti','archive')
  `);
  const hierarchy = new Map(rows.map(row => [Number(row.id), row.superieur_id ? Number(row.superieur_id) : null]));
  return organizationSvc.createsCycleFromMap(Number(empId), Number(supId), hierarchy);
}

function buildTree(agents) {
  const map = new Map(agents.map(a => [Number(a.id), { ...a, enfants: [] }]));
  const roots = [];
  for (const [, node] of map) {
    const supervisorId = node.superieur_id ? Number(node.superieur_id) : null;
    if (supervisorId && map.has(supervisorId)) map.get(supervisorId).enfants.push(node);
    else roots.push(node);
  }
  return roots;
}

async function _enregistrerMutation(dbc, opts) {
  await dbc.execute(`
    INSERT INTO employes_mutations
      (employe_id, date_effet, type_mutation,
       ancien_poste, nouveau_poste, ancien_dept, nouveau_dept,
       ancien_site, nouveau_site, ancien_sup_id, ancien_sup_nom,
       nouveau_sup_id, nouveau_sup_nom, motif, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    opts.employe_id, opts.date_effet, opts.type_mutation,
    opts.ancien_poste, opts.nouveau_poste,
    opts.ancien_dept, opts.nouveau_dept,
    opts.ancien_site, opts.nouveau_site,
    opts.ancien_sup_id, opts.ancien_sup_nom,
    opts.nouveau_sup_id, opts.nouveau_sup_nom,
    opts.motif || null, opts.created_by || null,
  ]);
}

async function _appliquerMutation(dbc, mut, userId) {
  const updates = {};
  if (mut.nouveau_poste !== mut.ancien_poste) updates.poste = mut.nouveau_poste;
  if (mut.nouveau_dept !== mut.ancien_dept) updates.departement = mut.nouveau_dept;
  if (mut.nouveau_site !== mut.ancien_site) updates.site = mut.nouveau_site;
  if (Number(mut.nouveau_sup_id || 0) !== Number(mut.ancien_sup_id || 0)) {
    updates.superieur_id = mut.nouveau_sup_id || null;
    updates.superieur_hierarchique = mut.nouveau_sup_nom || '';
  }
  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    await dbc.execute(
      `UPDATE employes SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [...Object.values(updates), Number(mut.employe_id)],
    );
  }
  await dbc.execute("UPDATE employes_mutations SET statut='effectif' WHERE id=?", [Number(mut.id)]);
  await audit(dbc, 'employes_mutations', Number(mut.id), 'appliquer', null, userId);
}

router.get('/arbre', async (_req, res, next) => {
  try {
    const agents = await db.query(`
      SELECT e.id, e.nom, e.prenom, e.matricule, e.poste, e.departement, e.site,
             e.superieur_id, e.superieur_hierarchique, e.statut_dossier, e.photo_url,
             e.type_contrat, e.date_embauche,
             CONCAT(s.nom, ' ', COALESCE(s.prenom,'')) AS superieur_nom
      FROM employes e
      LEFT JOIN employes s ON s.id = e.superieur_id
      WHERE e.actif = 1 AND e.statut_dossier NOT IN ('sorti','archive')
      ORDER BY e.nom, e.prenom
    `);
    res.json({ agents, arbre: buildTree(agents) });
  } catch (error) { next(error); }
});

router.get('/arbre/departement/:dept', async (req, res, next) => {
  try {
    const dept = req.params.dept;
    const agents = await db.query(`
      SELECT e.id, e.nom, e.prenom, e.matricule, e.poste, e.departement, e.site,
             e.superieur_id, e.superieur_hierarchique, e.statut_dossier, e.photo_url
      FROM employes e
      WHERE e.actif = 1 AND e.statut_dossier NOT IN ('sorti','archive') AND e.departement = ?
      ORDER BY e.nom, e.prenom
    `, [dept]);
    res.json({ departement: dept, agents, arbre: buildTree(agents) });
  } catch (error) { next(error); }
});

router.put('/:id/superieur', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const empId = Number(req.params.id);
    const newSupId = req.body?.superieur_id ? Number(req.body.superieur_id) : null;
    const { employee, manager } = await organizationSvc.assertSupervisorChange(empId, newSupId);
    const newSupNom = manager ? `${manager.nom} ${manager.prenom || ''}`.trim() : null;

    await db.transaction(async tx => {
      await tx.execute(`
        UPDATE employes
        SET superieur_id = ?, superieur_hierarchique = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [newSupId, newSupNom || '', empId]);
      await _enregistrerMutation(tx, {
        employe_id: empId,
        date_effet: new Date().toISOString().slice(0, 10),
        ancien_sup_id: employee.superieur_id,
        ancien_sup_nom: employee.superieur_hierarchique || null,
        nouveau_sup_id: newSupId,
        nouveau_sup_nom: newSupNom,
        ancien_poste: employee.poste,
        nouveau_poste: employee.poste,
        ancien_dept: employee.departement,
        nouveau_dept: employee.departement,
        ancien_site: employee.site,
        nouveau_site: employee.site,
        type_mutation: 'modification',
        motif: req.body?.motif || 'Changement supérieur',
        created_by: req.user.id,
      });
      await audit(tx, 'employes', empId, 'superieur_modifie', {
        ancien: employee.superieur_id || null,
        nouveau: newSupId,
        nom: newSupNom,
      }, req.user.id);
    });

    res.json({ ok: true, superieur_id: newSupId, superieur_nom: newSupNom });
  } catch (error) {
    if (error?.code) return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details || undefined });
    next(error);
  }
});

router.get('/postes', async (_req, res, next) => {
  try {
    const rows = await db.query(`
      SELECT p.*, COUNT(e.id) AS nb_agents
      FROM org_postes p
      LEFT JOIN employes e ON e.poste = p.libelle AND e.actif = 1
      WHERE p.actif = 1
      GROUP BY p.id
      ORDER BY p.libelle
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/postes', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const { libelle, description = '' } = req.body;
    if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
    const clean = libelle.trim();
    const exist = await db.queryOne('SELECT id FROM org_postes WHERE libelle = ?', [clean]);
    if (exist) return res.status(409).json({ error: 'Ce poste existe déjà' });
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO org_postes (libelle, description) VALUES (?, ?)', [clean, description.trim()]);
      await audit(tx, 'org_postes', r.insertId, 'create', { libelle: clean }, req.user.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, libelle: clean, description: description.trim() });
  } catch (error) { next(error); }
});

router.put('/postes/:id', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const row = await db.queryOne('SELECT * FROM org_postes WHERE id = ?', [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Poste introuvable' });
    const { libelle, description, actif } = req.body;
    await db.transaction(async tx => {
      await tx.execute(
        'UPDATE org_postes SET libelle=?, description=?, actif=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [libelle ?? row.libelle, description ?? row.description, actif !== undefined ? (actif ? 1 : 0) : row.actif, row.id],
      );
      await audit(tx, 'org_postes', row.id, 'update', { libelle, description, actif }, req.user.id);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/departements', async (_req, res, next) => {
  try {
    const rows = await db.query(`
      SELECT d.*, COUNT(e.id) AS nb_agents,
             CONCAT(r.nom, ' ', COALESCE(r.prenom,'')) AS responsable_nom
      FROM org_departements d
      LEFT JOIN employes e ON e.departement = d.libelle AND e.actif = 1
      LEFT JOIN employes r ON r.id = d.responsable_id AND r.actif = 1
      WHERE d.actif = 1
      GROUP BY d.id
      ORDER BY d.libelle
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/departements', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const { libelle, code = '', responsable_id = null, description = '' } = req.body;
    if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
    const clean = libelle.trim();
    const exist = await db.queryOne('SELECT id FROM org_departements WHERE libelle = ?', [clean]);
    if (exist) return res.status(409).json({ error: 'Ce département existe déjà' });
    const out = await db.transaction(async tx => {
      const r = await tx.execute(
        'INSERT INTO org_departements (libelle, code, responsable_id, description) VALUES (?, ?, ?, ?)',
        [clean, code.trim(), responsable_id || null, description.trim()],
      );
      await audit(tx, 'org_departements', r.insertId, 'create', { libelle: clean }, req.user.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, libelle: clean });
  } catch (error) { next(error); }
});

router.put('/departements/:id', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const row = await db.queryOne('SELECT * FROM org_departements WHERE id = ?', [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Département introuvable' });
    const { libelle, code, responsable_id, description, actif } = req.body;
    await db.transaction(async tx => {
      await tx.execute(`
        UPDATE org_departements
        SET libelle=?, code=?, responsable_id=?, description=?, actif=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `, [
        libelle ?? row.libelle,
        code ?? row.code,
        responsable_id !== undefined ? (responsable_id || null) : row.responsable_id,
        description ?? row.description,
        actif !== undefined ? (actif ? 1 : 0) : row.actif,
        row.id,
      ]);
      await audit(tx, 'org_departements', row.id, 'update', { libelle, responsable_id, actif }, req.user.id);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/sites', async (_req, res, next) => {
  try {
    const rows = await db.query(`
      SELECT s.*, COUNT(e.id) AS nb_agents
      FROM org_sites s
      LEFT JOIN employes e ON e.site = s.libelle AND e.actif = 1
      WHERE s.actif = 1
      GROUP BY s.id
      ORDER BY s.libelle
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/sites', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const { libelle, ville = '', adresse = '' } = req.body;
    if (!libelle?.trim()) return res.status(400).json({ error: 'Libellé requis' });
    const clean = libelle.trim();
    const exist = await db.queryOne('SELECT id FROM org_sites WHERE libelle = ?', [clean]);
    if (exist) return res.status(409).json({ error: 'Ce site existe déjà' });
    const out = await db.transaction(async tx => {
      const r = await tx.execute('INSERT INTO org_sites (libelle, ville, adresse) VALUES (?, ?, ?)', [clean, ville.trim(), adresse.trim()]);
      await audit(tx, 'org_sites', r.insertId, 'create', { libelle: clean }, req.user.id);
      return r;
    });
    res.status(201).json({ id: out.insertId, libelle: clean });
  } catch (error) { next(error); }
});

router.put('/sites/:id', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const row = await db.queryOne('SELECT * FROM org_sites WHERE id = ?', [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Site introuvable' });
    const { libelle, ville, adresse, actif } = req.body;
    await db.transaction(async tx => {
      await tx.execute(
        'UPDATE org_sites SET libelle=?, ville=?, adresse=?, actif=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [libelle ?? row.libelle, ville ?? row.ville, adresse ?? row.adresse, actif !== undefined ? (actif ? 1 : 0) : row.actif, row.id],
      );
      await audit(tx, 'org_sites', row.id, 'update', { libelle, actif }, req.user.id);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/mutations', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'rh', 'dg', 'finance')) return res.status(403).json({ error: 'Accès refusé' });
    const { employe_id, type_mutation, debut, fin, limit = 50, offset = 0 } = req.query;
    let where = '1=1';
    const params = [];
    if (employe_id) { where += ' AND m.employe_id = ?'; params.push(Number(employe_id)); }
    if (type_mutation) { where += ' AND m.type_mutation = ?'; params.push(type_mutation); }
    if (debut) { where += ' AND m.date_effet >= ?'; params.push(debut); }
    if (fin) { where += ' AND m.date_effet <= ?'; params.push(fin); }

    const totalRow = await db.queryOne(`SELECT COUNT(*) as c FROM employes_mutations m WHERE ${where}`, params);
    const rows = await db.query(`
      SELECT m.*,
             CONCAT(e.nom, ' ', COALESCE(e.prenom,'')) AS employe_nom,
             e.matricule,
             u.nom AS created_by_nom,
             v.nom AS valide_par_nom
      FROM employes_mutations m
      JOIN employes e ON e.id = m.employe_id
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN users v ON v.id = m.valide_par
      WHERE ${where}
      ORDER BY m.date_effet DESC, m.id DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), Number(offset)]);
    res.json({ total: Number(totalRow?.c || 0), rows });
  } catch (error) { next(error); }
});

router.get('/:id/mutations', async (req, res, next) => {
  try {
    const rows = await db.query(`
      SELECT m.*, u.nom AS created_by_nom, v.nom AS valide_par_nom
      FROM employes_mutations m
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN users v ON v.id = m.valide_par
      WHERE m.employe_id = ?
      ORDER BY m.date_effet DESC, m.id DESC
      LIMIT 100
    `, [Number(req.params.id)]);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/mutations', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
    const {
      employe_id, date_effet, type_mutation = 'modification',
      nouveau_poste, nouveau_dept, nouveau_site, nouveau_sup_id, motif = '',
    } = req.body;
    if (!employe_id || !date_effet) return res.status(400).json({ error: 'employe_id et date_effet requis' });

    const emp = await db.queryOne('SELECT * FROM employes WHERE id = ?', [Number(employe_id)]);
    if (!emp) return res.status(404).json({ error: 'Agent introuvable' });
    const newSupId = nouveau_sup_id ? Number(nouveau_sup_id) : null;
    if (newSupId && await creeraitBoucle(Number(employe_id), newSupId)) {
      return res.status(409).json({ error: 'Cycle hiérarchique détecté', code: 'CYCLE_HIERARCHIQUE' });
    }
    const supervisor = newSupId ? await db.queryOne('SELECT nom, prenom FROM employes WHERE id = ?', [newSupId]) : null;
    const newSupNom = supervisor ? `${supervisor.nom} ${supervisor.prenom || ''}`.trim() : null;
    const autoApprove = hasRole(req.user, 'admin', 'dg');
    const today = new Date().toISOString().slice(0, 10);

    const result = await db.transaction(async tx => {
      const r = await tx.execute(`
        INSERT INTO employes_mutations
          (employe_id, date_effet, type_mutation,
           ancien_poste, nouveau_poste,
           ancien_dept, nouveau_dept,
           ancien_site, nouveau_site,
           ancien_sup_id, ancien_sup_nom, nouveau_sup_id, nouveau_sup_nom,
           motif, statut, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'propose',?)
      `, [
        Number(employe_id), date_effet, type_mutation,
        emp.poste, nouveau_poste ?? emp.poste,
        emp.departement, nouveau_dept ?? emp.departement,
        emp.site, nouveau_site ?? emp.site,
        emp.superieur_id, emp.superieur_hierarchique,
        newSupId, newSupNom,
        motif, req.user.id,
      ]);
      await audit(tx, 'employes_mutations', r.insertId, 'propose', { type_mutation, employe_id, nouveau_poste, nouveau_dept }, req.user.id);
      if (!autoApprove) return { id: r.insertId, statut: 'propose', autoApproved: false, applied: false };

      await tx.execute(`
        UPDATE employes_mutations
        SET statut='approuve', approuve_par=?, approuve_at=CURRENT_TIMESTAMP
        WHERE id=?
      `, [req.user.id, r.insertId]);
      await audit(tx, 'employes_mutations', r.insertId, 'propose_auto_approuver_dg', null, req.user.id);
      const mut = await tx.queryOne('SELECT * FROM employes_mutations WHERE id = ?', [r.insertId]);
      const effectiveDate = mut.date_effective || mut.date_effet;
      if (effectiveDate && effectiveDate <= today) {
        await _appliquerMutation(tx, mut, req.user.id);
        return { id: r.insertId, statut: 'effectif', autoApproved: true, applied: true };
      }
      return { id: r.insertId, statut: 'approuve', autoApproved: true, applied: false };
    });

    if (!result.autoApproved) {
      setImmediate(async () => {
        try {
          const { creerNotification } = require('../services/notif');
          const dgs = await db.query("SELECT id FROM users WHERE actif=1 AND (role IN ('admin','dg') OR roles LIKE '%\"dg\"%')");
          const empNom = `${emp.nom} ${emp.prenom || ''}`.trim();
          for (const user of dgs) {
            await Promise.resolve(creerNotification({
              type: 'NOTIF_MUTATION_PROPOSE',
              titre: 'Mutation proposée',
              message: `Mutation de ${empNom} (${type_mutation}) proposée pour le ${date_effet}. En attente de votre approbation.`,
              srcTable: 'employes_mutations',
              srcId: result.id,
              destinataire_id: user.id,
            }));
          }
        } catch (_) {}
      });
    }

    res.status(201).json({
      id: result.id,
      ok: true,
      statut: result.statut,
      auto_approved: result.autoApproved || undefined,
      applique_maintenant: result.autoApproved ? result.applied : undefined,
    });
  } catch (error) { next(error); }
});

router.put('/mutations/:id/approuver', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const mut = await db.queryOne('SELECT * FROM employes_mutations WHERE id = ?', [Number(req.params.id)]);
    if (!mut) return res.status(404).json({ error: 'Mutation introuvable' });
    if (mut.statut !== 'propose') return res.status(400).json({ error: `Statut "${mut.statut}" — approbation impossible` });
    const today = new Date().toISOString().slice(0, 10);
    const effectiveDate = mut.date_effective || mut.date_effet;
    const appliquerMaintenant = effectiveDate ? effectiveDate <= today : true;

    const status = await db.transaction(async tx => {
      await tx.execute(`
        UPDATE employes_mutations
        SET statut='approuve', approuve_par=?, approuve_at=CURRENT_TIMESTAMP
        WHERE id=? AND statut='propose'
      `, [req.user.id, mut.id]);
      await audit(tx, 'employes_mutations', mut.id, 'approuver', null, req.user.id);
      if (appliquerMaintenant) {
        await _appliquerMutation(tx, mut, req.user.id);
        return 'effectif';
      }
      return 'approuve';
    });
    res.json({ ok: true, statut: status, applique_maintenant: appliquerMaintenant, date_effective: effectiveDate });
  } catch (error) { next(error); }
});

router.put('/mutations/:id/refuser', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const mut = await db.queryOne('SELECT * FROM employes_mutations WHERE id = ?', [Number(req.params.id)]);
    if (!mut) return res.status(404).json({ error: 'Mutation introuvable' });
    if (!['propose', 'approuve'].includes(mut.statut)) return res.status(400).json({ error: `Statut "${mut.statut}" — refus impossible` });
    const motifRefus = String(req.body?.motif_refus || '').trim();
    if (!motifRefus) return res.status(400).json({ error: 'motif_refus obligatoire' });
    await db.transaction(async tx => {
      await tx.execute("UPDATE employes_mutations SET statut='annule', motif_refus=? WHERE id=?", [motifRefus, mut.id]);
      await audit(tx, 'employes_mutations', mut.id, 'refuser', { motif_refus: motifRefus }, req.user.id);
    });
    res.json({ ok: true, statut: 'annule' });
  } catch (error) { next(error); }
});

module.exports = { router, creeraitBoucle, _enregistrerMutation };

/**
 * MODULE RÉVISIONS SALARIALES — TOP CENTER
 * Circuit : brouillon → soumis_rh → soumis_dg → approuve|rejete|ajourne → applique
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');
const { creerEntreeParapheurDansTransaction } = require('../services/parapheur_async');

const WRITE_ROLES = ['admin', 'rh', 'finance', 'dg'];
const RH_ROLES = ['admin', 'rh'];
const APPROVE_ROLES = ['admin', 'dg'];

function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function canRH(user) { return hasRole(user, ...RH_ROLES); }
function canApprove(user) { return hasRole(user, ...APPROVE_ROLES); }

const ACTIVE_EMPLOYEE_SQL = "COALESCE(actif, 1) = 1 AND COALESCE(statut_dossier, 'actif') NOT IN ('sorti', 'archive')";
const ACTIVE_EMPLOYEE_JOIN_SQL = "COALESCE(e.actif, 1) = 1 AND COALESCE(e.statut_dossier, 'actif') NOT IN ('sorti', 'archive')";

function wantsInactiveRows(req) {
  return ['1', 'true', 'oui', 'yes'].includes(String(req.query.include_inactive || '').toLowerCase());
}

async function getActiveEmployee(employeId, dbc = db) {
  return dbc.queryOne(`
    SELECT id, nom, prenom, salaire_base, prime_transport, prime_logement,
           grille_categorie_id, grille_echelon_id
    FROM employes
    WHERE id = ? AND ${ACTIVE_EMPLOYEE_SQL}
  `, [employeId]);
}

async function audit(id, action, details, userId, dbc = db) {
  try {
    await dbc.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['demandes_revision_salaire', id, action, details ? JSON.stringify(details) : null, userId || null],
    );
  } catch (_) {}
}

async function notifyRoles(roles, titre, message, srcId) {
  try {
    const placeholders = roles.map(() => '?').join(',');
    const likeParts = roles.map(() => 'roles LIKE ?').join(' OR ');
    const params = [...roles, ...roles.map(role => `%\"${role}\"%`)];
    const users = await db.query(
      `SELECT id FROM users WHERE actif=1 AND (role IN (${placeholders}) OR ${likeParts})`,
      params,
    );
    for (const user of users) {
      await Promise.resolve(creerNotification({
        type: 'NOTIF_REVISION_SALAIRE', titre, message,
        srcTable: 'demandes_revision_salaire', srcId, destinataire_id: user.id,
      }));
    }
  } catch (_) {}
}

async function enrichRevision(revision) {
  if (!revision) return null;
  const [employee, creator, rhValidator, dgValidator, category, echelon] = await Promise.all([
    db.queryOne('SELECT nom, prenom, poste, salaire_base FROM employes WHERE id = ?', [revision.employe_id]),
    revision.created_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [revision.created_by]) : null,
    revision.valide_rh_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [revision.valide_rh_by]) : null,
    revision.valide_dg_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [revision.valide_dg_by]) : null,
    revision.nouvelle_categorie_id ? db.queryOne('SELECT code, libelle FROM grille_categories WHERE id = ?', [revision.nouvelle_categorie_id]) : null,
    revision.nouvel_echelon_id ? db.queryOne('SELECT echelon, salaire_reference FROM grille_echelons WHERE id = ?', [revision.nouvel_echelon_id]) : null,
  ]);
  return {
    ...revision,
    employe_nom: employee ? `${employee.nom} ${employee.prenom}` : null,
    employe_poste: employee?.poste,
    employe_salaire_actuel_reel: employee?.salaire_base,
    created_by_nom: creator?.nom || null,
    valide_rh_nom: rhValidator?.nom || null,
    valide_dg_nom: dgValidator?.nom || null,
    nouvelle_categorie: category,
    nouvel_echelon: echelon,
  };
}

async function applyRevisionInTransaction(tx, revision, userId, options = {}) {
  const employee = await getActiveEmployee(revision.employe_id, tx);
  if (!employee) throw new Error('Agent inactif ou sorti — application de la révision impossible');

  await tx.execute(`
    UPDATE employes
    SET salaire_base=?, prime_transport=?, prime_logement=?,
        grille_categorie_id=?, grille_echelon_id=?, updated_at=NOW()
    WHERE id=?
  `, [
    revision.salaire_propose,
    revision.transport_propose || employee.prime_transport || 0,
    revision.logement_propose || employee.prime_logement || 0,
    revision.nouvelle_categorie_id || null,
    revision.nouvel_echelon_id || null,
    revision.employe_id,
  ]);

  if (options.failAfterEmployeeUpdate) throw new Error('SALARY_REVISION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE');

  await tx.execute(`
    INSERT INTO historique_salaires
      (employe_id, date_effet, ancien_salaire, nouveau_salaire,
       ancien_transport, nouveau_transport, ancien_logement, nouveau_logement,
       ancienne_categorie_id, nouvelle_categorie_id,
       ancien_echelon_id, nouvel_echelon_id,
       motif, type_revision, demande_revision_id, approved_by, approved_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
  `, [
    revision.employe_id, revision.date_effet,
    revision.salaire_actuel, revision.salaire_propose,
    revision.transport_actuel, revision.transport_propose,
    revision.logement_actuel, revision.logement_propose,
    employee.grille_categorie_id || null, revision.nouvelle_categorie_id || null,
    employee.grille_echelon_id || null, revision.nouvel_echelon_id || null,
    revision.motif, revision.type_revision, revision.id, userId, userId,
  ]);

  await tx.execute("UPDATE demandes_revision_salaire SET statut='applique', updated_at=NOW() WHERE id=?", [revision.id]);
  await audit(revision.id, 'appliquer', { nouveau_salaire: revision.salaire_propose, motif: revision.motif }, userId, tx);
}

async function applyRevision(revision, userId, options = {}) {
  await db.transaction(tx => applyRevisionInTransaction(tx, revision, userId, options));
  try {
    const employee = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [revision.employe_id]);
    await Promise.resolve(creerNotification({
      type: 'NOTIF_REVISION_SALAIRE',
      titre: 'Révision salariale appliquée',
      message: `La révision salariale de ${employee?.nom || ''} ${employee?.prenom || ''} a été appliquée — nouveau salaire : ${new Intl.NumberFormat('fr-FR').format(revision.salaire_propose)} XAF.`,
      srcTable: 'demandes_revision_salaire', srcId: revision.id,
    }));
  } catch (_) {}
}

router.get('/', async (req, res, next) => {
  try {
    if (!canWrite(req.user) && !canApprove(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { statut, employe_id, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT r.* FROM demandes_revision_salaire r JOIN employes e ON e.id = r.employe_id WHERE 1=1';
    const args = [];
    if (!wantsInactiveRows(req)) sql += ` AND ${ACTIVE_EMPLOYEE_JOIN_SQL}`;
    if (statut) { sql += ' AND r.statut = ?'; args.push(statut); }
    if (employe_id) { sql += ' AND r.employe_id = ?'; args.push(employe_id); }
    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    args.push(Number(limit), Number(offset));
    const rows = await db.query(sql, args);
    res.json(await Promise.all(rows.map(enrichRevision)));
  } catch (error) { next(error); }
});

router.get('/en-attente', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const rows = await db.query(`
      SELECT r.* FROM demandes_revision_salaire r
      JOIN employes e ON e.id = r.employe_id
      WHERE r.statut='soumis_dg' AND ${ACTIVE_EMPLOYEE_JOIN_SQL}
      ORDER BY r.updated_at ASC
    `);
    res.json({ count: rows.length, items: await Promise.all(rows.map(enrichRevision)) });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    res.json(await enrichRevision(revision));
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, Finance ou Admin requis' });
    const {
      employe_id, type_revision = 'augmentation', date_effet,
      salaire_propose, transport_propose, logement_propose,
      nouvelle_categorie_id, nouvel_echelon_id, motif, document_url,
    } = req.body;
    if (!employe_id || !date_effet || !salaire_propose || !motif) return res.status(400).json({ error: 'employe_id, date_effet, salaire_propose et motif sont requis' });
    const employee = await getActiveEmployee(employe_id);
    if (!employee) return res.status(400).json({ error: 'Agent inactif, sorti ou introuvable — révision salariale impossible' });

    if (nouvel_echelon_id) {
      const echelon = await db.queryOne('SELECT salaire_min, salaire_max FROM grille_echelons WHERE id = ?', [nouvel_echelon_id]);
      if (echelon?.salaire_min && Number(salaire_propose) < echelon.salaire_min) return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) inférieur au minimum de l'échelon (${echelon.salaire_min})` });
      if (echelon?.salaire_max && Number(salaire_propose) > echelon.salaire_max) return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) supérieur au maximum de l'échelon (${echelon.salaire_max})` });
    }

    const result = await db.execute(`
      INSERT INTO demandes_revision_salaire
        (employe_id, type_revision, date_effet, salaire_actuel, salaire_propose,
         transport_actuel, transport_propose, logement_actuel, logement_propose,
         nouvelle_categorie_id, nouvel_echelon_id, motif, document_url, statut, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, NOW())
    `, [
      employe_id, type_revision, date_effet,
      employee.salaire_base || 0, Number(salaire_propose),
      employee.prime_transport || 0, Number(transport_propose) || employee.prime_transport || 0,
      employee.prime_logement || 0, Number(logement_propose) || employee.prime_logement || 0,
      nouvelle_categorie_id || null, nouvel_echelon_id || null,
      motif, document_url || null, req.user.id,
    ]);
    await audit(result.insertId, 'creer', { type_revision, salaire_propose, motif }, req.user.id);
    res.status(201).json(await enrichRevision(await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [result.insertId])));
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'brouillon') return res.status(400).json({ error: `Statut "${revision.statut}" — modification impossible. Seul un brouillon est modifiable.` });
    if (revision.created_by !== req.user.id && !hasRole(req.user, 'admin', 'rh')) return res.status(403).json({ error: 'Seul le créateur, un RH ou un Admin peut modifier ce brouillon' });
    const {
      type_revision = revision.type_revision, date_effet = revision.date_effet,
      salaire_propose = revision.salaire_propose, transport_propose = revision.transport_propose,
      logement_propose = revision.logement_propose, nouvelle_categorie_id = revision.nouvelle_categorie_id,
      nouvel_echelon_id = revision.nouvel_echelon_id, motif = revision.motif, document_url = revision.document_url,
    } = req.body;
    await db.execute(`
      UPDATE demandes_revision_salaire SET type_revision=?, date_effet=?, salaire_propose=?,
        transport_propose=?, logement_propose=?, nouvelle_categorie_id=?, nouvel_echelon_id=?,
        motif=?, document_url=?, updated_at=NOW() WHERE id=?
    `, [type_revision, date_effet, Number(salaire_propose), Number(transport_propose) || 0, Number(logement_propose) || 0, nouvelle_categorie_id || null, nouvel_echelon_id || null, motif, document_url || null, revision.id]);
    await audit(revision.id, 'modifier', { salaire_propose, motif }, req.user.id);
    res.json(await enrichRevision(await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [revision.id])));
  } catch (error) { next(error); }
});

router.post('/:id/soumettre-rh', async (req, res, next) => {
  try {
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${revision.statut}" — soumission impossible` });
    if (revision.created_by !== req.user.id && !hasRole(req.user, 'admin', 'rh', 'dg')) return res.status(403).json({ error: 'Seul le créateur, un RH, le DG ou un Admin peut soumettre' });
    const employee = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [revision.employe_id]);

    if (canApprove(req.user)) {
      const avis = 'Décision DG enregistrée directement';
      const today = new Date().toISOString().slice(0, 10);
      const applyNow = revision.date_effet <= today;
      await db.transaction(async tx => {
        await tx.execute(`
          UPDATE demandes_revision_salaire SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?
        `, [avis, req.user.id, revision.id]);
        await audit(revision.id, 'soumettre_auto_valider_dg', { avis_dg: avis }, req.user.id, tx);
        if (applyNow) {
          const updated = await tx.queryOne('SELECT * FROM demandes_revision_salaire WHERE id=?', [revision.id]);
          await applyRevisionInTransaction(tx, updated, req.user.id);
        }
      });
      return res.json({ ok: true, statut: applyNow ? 'applique' : 'approuve', auto_approved: true, applique_maintenant: applyNow, date_effet: revision.date_effet });
    }

    if (canRH(req.user)) {
      const avis = 'Contrôle RH validé directement';
      const parapheurId = await db.transaction(async tx => {
        await tx.execute(`
          UPDATE demandes_revision_salaire SET statut='soumis_dg', avis_rh=?, valide_rh_by=?, valide_rh_at=NOW(), updated_at=NOW() WHERE id=?
        `, [avis, req.user.id, revision.id]);
        const id = await creerEntreeParapheurDansTransaction(tx, {
          type: 'revision_salariale',
          titre: `Révision salariale — ${employee?.nom || ''} ${employee?.prenom || ''} (contrôlée RH, en attente DG)`,
          initiateur_id: req.user.id,
          ref_source_table: 'demandes_revision_salaire',
          ref_source_id: revision.id,
          required: true,
        });
        await audit(revision.id, 'soumettre_auto_valider_rh', { avis_rh: avis, parapheur_id: id, required_parapheur: true }, req.user.id, tx);
        return id;
      });
      await notifyRoles(['dg', 'admin'], 'Révision salariale en attente DG', `Révision salariale de ${employee?.nom || ''} ${employee?.prenom || ''} contrôlée par RH — en attente de votre approbation.`, revision.id);
      return res.json({ ok: true, statut: 'soumis_dg', auto_rh_validated: true, parapheur_id: parapheurId });
    }

    await db.execute("UPDATE demandes_revision_salaire SET statut='soumis_rh', updated_at=NOW() WHERE id=?", [revision.id]);
    await audit(revision.id, 'soumettre_rh', null, req.user.id);
    await notifyRoles(['rh', 'admin'], 'Révision salariale soumise', `Révision salariale de ${employee?.nom || ''} ${employee?.prenom || ''} (${revision.type_revision}) soumise pour contrôle RH.`, revision.id);
    res.json({ ok: true, statut: 'soumis_rh' });
  } catch (error) { next(error); }
});

router.post('/:id/valider-rh', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'soumis_rh') return res.status(400).json({ error: `Statut actuel "${revision.statut}" — validation RH impossible` });
    const { avis_rh } = req.body;
    if (!avis_rh || !String(avis_rh).trim()) return res.status(400).json({ error: 'Avis RH obligatoire' });
    const employee = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [revision.employe_id]);
    const parapheurId = await db.transaction(async tx => {
      await tx.execute(`
        UPDATE demandes_revision_salaire SET statut='soumis_dg', avis_rh=?, valide_rh_by=?, valide_rh_at=NOW(), updated_at=NOW() WHERE id=?
      `, [String(avis_rh).trim(), req.user.id, revision.id]);
      const id = await creerEntreeParapheurDansTransaction(tx, {
        type: 'revision_salariale',
        titre: `Révision salariale — ${employee?.nom || ''} ${employee?.prenom || ''} (validée RH, en attente DG)`,
        initiateur_id: req.user.id,
        ref_source_table: 'demandes_revision_salaire',
        ref_source_id: revision.id,
        required: true,
      });
      await audit(revision.id, 'valider_rh', { avis_rh, parapheur_id: id, required_parapheur: true }, req.user.id, tx);
      return id;
    });
    await notifyRoles(['dg', 'admin'], 'Révision salariale en attente DG', `Révision salariale de ${employee?.nom || ''} ${employee?.prenom || ''} validée par RH — en attente de votre approbation.`, revision.id);
    res.json({ ok: true, statut: 'soumis_dg', parapheur_id: parapheurId });
  } catch (error) { next(error); }
});

router.post('/:id/valider-dg', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'soumis_dg') return res.status(400).json({ error: `Statut actuel "${revision.statut}" — validation DG impossible` });
    const { avis_dg } = req.body;
    if (!avis_dg || !String(avis_dg).trim()) return res.status(400).json({ error: 'Avis DG obligatoire' });
    const today = new Date().toISOString().slice(0, 10);
    const applyNow = revision.date_effet <= today;
    await db.transaction(async tx => {
      await tx.execute(`
        UPDATE demandes_revision_salaire SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?
      `, [String(avis_dg).trim(), req.user.id, revision.id]);
      await audit(revision.id, 'valider_dg', { avis_dg }, req.user.id, tx);
      if (applyNow) {
        const updated = await tx.queryOne('SELECT * FROM demandes_revision_salaire WHERE id=?', [revision.id]);
        await applyRevisionInTransaction(tx, updated, req.user.id);
      }
    });
    res.json({ ok: true, statut: applyNow ? 'applique' : 'approuve', applique_maintenant: applyNow, date_effet: revision.date_effet });
  } catch (error) { next(error); }
});

router.post('/:id/appliquer', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'approuve') return res.status(400).json({ error: 'Seule une révision approuvée peut être appliquée' });
    await applyRevision(revision, req.user.id);
    res.json({ ok: true, statut: 'applique' });
  } catch (error) {
    if (error.message.includes('Agent inactif ou sorti')) return res.status(400).json({ error: error.message });
    next(error);
  }
});

router.post('/:id/rejeter', async (req, res, next) => {
  try {
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    const peutRejeter = (revision.statut === 'soumis_rh' && canRH(req.user)) || (revision.statut === 'soumis_dg' && canApprove(req.user));
    if (!peutRejeter) return res.status(403).json({ error: 'Vous ne pouvez pas rejeter à cette étape' });
    const { motif_rejet } = req.body;
    if (!motif_rejet || !String(motif_rejet).trim()) return res.status(400).json({ error: 'Motif de rejet obligatoire' });
    await db.execute("UPDATE demandes_revision_salaire SET statut='rejete', motif_rejet=?, updated_at=NOW() WHERE id=?", [String(motif_rejet).trim(), revision.id]);
    await audit(revision.id, 'rejeter', { motif_rejet }, req.user.id);
    try {
      const employee = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [revision.employe_id]);
      const creator = await db.queryOne('SELECT id FROM users WHERE id=?', [revision.created_by]);
      if (creator) await Promise.resolve(creerNotification({
        type: 'NOTIF_REVISION_SALAIRE', titre: 'Révision salariale rejetée',
        message: `La révision salariale de ${employee?.nom || ''} ${employee?.prenom || ''} a été rejetée. Motif : ${motif_rejet}`,
        srcTable: 'demandes_revision_salaire', srcId: revision.id, destinataire_id: revision.created_by,
      }));
    } catch (_) {}
    res.json({ ok: true, statut: 'rejete' });
  } catch (error) { next(error); }
});

router.post('/:id/ajourner', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    if (revision.statut !== 'soumis_dg') return res.status(400).json({ error: `Statut "${revision.statut}" — ajournement impossible` });
    const { avis_dg } = req.body;
    await db.execute("UPDATE demandes_revision_salaire SET statut='ajourne', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?", [avis_dg || null, req.user.id, revision.id]);
    await audit(revision.id, 'ajourner', { avis_dg }, req.user.id);
    res.json({ ok: true, statut: 'ajourne' });
  } catch (error) { next(error); }
});

router.post('/:id/annuler', async (req, res, next) => {
  try {
    const revision = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!revision) return res.status(404).json({ error: 'Révision introuvable' });
    const peutAnnuler = (revision.statut === 'brouillon' && revision.created_by === req.user.id) || hasRole(req.user, 'admin');
    if (!peutAnnuler) return res.status(403).json({ error: 'Seul le créateur (brouillon) ou un Admin peut annuler' });
    const annulables = ['brouillon', 'soumis_rh', 'soumis_dg', 'approuve', 'ajourne'];
    if (!annulables.includes(revision.statut)) return res.status(400).json({ error: `Statut "${revision.statut}" non annulable` });
    await db.execute("UPDATE demandes_revision_salaire SET statut='annule', updated_at=NOW() WHERE id=?", [revision.id]);
    await audit(revision.id, 'annuler', null, req.user.id);
    res.json({ ok: true, statut: 'annule' });
  } catch (error) { next(error); }
});

module.exports = {
  router,
  applyRevision,
  applyRevisionInTransaction,
  getActiveEmployee,
};

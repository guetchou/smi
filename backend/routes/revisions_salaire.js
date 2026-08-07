/**
 * MODULE RÉVISIONS SALARIALES — TOP CENTER
 * Circuit : brouillon → soumis_rh → soumis_dg → approuve|rejete|ajourne → applique
 */
'use strict';

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
    const users = await db.query('SELECT id, role, roles FROM users WHERE actif=1');
    const wanted = new Set(roles);
    for (const user of users) {
      let extra = [];
      try { extra = user.roles ? JSON.parse(user.roles) : []; } catch (_) { extra = []; }
      const all = new Set([user.role, ...extra].filter(Boolean));
      if (![...wanted].some(role => all.has(role))) continue;
      await Promise.resolve(creerNotification({
        type: 'NOTIF_REVISION_SALAIRE',
        titre,
        message,
        srcTable: 'demandes_revision_salaire',
        srcId,
        destinataire_id: user.id,
      }));
    }
  } catch (_) {}
}

async function enrichRevision(r) {
  if (!r) return null;
  const [emp, crBy, vRH, vDG, cat, ech] = await Promise.all([
    db.queryOne('SELECT nom, prenom, poste, salaire_base FROM employes WHERE id = ?', [r.employe_id]),
    r.created_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [r.created_by]) : null,
    r.valide_rh_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [r.valide_rh_by]) : null,
    r.valide_dg_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [r.valide_dg_by]) : null,
    r.nouvelle_categorie_id ? db.queryOne('SELECT code, libelle FROM grille_categories WHERE id = ?', [r.nouvelle_categorie_id]) : null,
    r.nouvel_echelon_id ? db.queryOne('SELECT echelon, salaire_reference FROM grille_echelons WHERE id = ?', [r.nouvel_echelon_id]) : null,
  ]);
  return {
    ...r,
    employe_nom: emp ? `${emp.nom} ${emp.prenom}` : null,
    employe_poste: emp?.poste,
    employe_salaire_actuel_reel: emp?.salaire_base,
    created_by_nom: crBy?.nom || null,
    valide_rh_nom: vRH?.nom || null,
    valide_dg_nom: vDG?.nom || null,
    nouvelle_categorie: cat,
    nouvel_echelon: ech,
  };
}

async function applyRevision(rev, userId, dbc = db) {
  return dbc.transaction(async tx => {
    const agent = await getActiveEmployee(rev.employe_id, tx);
    if (!agent) throw new Error('Agent inactif ou sorti — application de la révision impossible');

    await tx.execute(`
      UPDATE employes
      SET salaire_base=?, prime_transport=?, prime_logement=?,
          grille_categorie_id=?, grille_echelon_id=?, updated_at=NOW()
      WHERE id=?
    `, [
      rev.salaire_propose,
      rev.transport_propose || agent.prime_transport || 0,
      rev.logement_propose || agent.prime_logement || 0,
      rev.nouvelle_categorie_id || null,
      rev.nouvel_echelon_id || null,
      rev.employe_id,
    ]);

    await tx.execute(`
      INSERT INTO historique_salaires
        (employe_id, date_effet, ancien_salaire, nouveau_salaire,
         ancien_transport, nouveau_transport, ancien_logement, nouveau_logement,
         ancienne_categorie_id, nouvelle_categorie_id,
         ancien_echelon_id, nouvel_echelon_id,
         motif, type_revision, demande_revision_id, approved_by, approved_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    `, [
      rev.employe_id, rev.date_effet,
      rev.salaire_actuel, rev.salaire_propose,
      rev.transport_actuel, rev.transport_propose,
      rev.logement_actuel, rev.logement_propose,
      agent.grille_categorie_id || null, rev.nouvelle_categorie_id || null,
      agent.grille_echelon_id || null, rev.nouvel_echelon_id || null,
      rev.motif, rev.type_revision, rev.id, userId, userId,
    ]);

    await tx.execute(
      "UPDATE demandes_revision_salaire SET statut='applique', updated_at=NOW() WHERE id=?",
      [rev.id],
    );
    await audit(rev.id, 'appliquer', { nouveau_salaire: rev.salaire_propose, motif: rev.motif }, userId, tx);
    return agent;
  });
}

async function notifyApplied(rev) {
  try {
    const emp = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [rev.employe_id]);
    await Promise.resolve(creerNotification({
      type: 'NOTIF_REVISION_SALAIRE',
      titre: 'Révision salariale appliquée',
      message: `La révision salariale de ${emp?.nom || ''} ${emp?.prenom || ''} a été appliquée — nouveau salaire : ${new Intl.NumberFormat('fr-FR').format(rev.salaire_propose)} XAF.`,
      srcTable: 'demandes_revision_salaire',
      srcId: rev.id,
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
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    res.json(await enrichRevision(rev));
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
    if (!employe_id || !date_effet || !salaire_propose || !motif) {
      return res.status(400).json({ error: 'employe_id, date_effet, salaire_propose et motif sont requis' });
    }
    const agent = await getActiveEmployee(employe_id);
    if (!agent) return res.status(400).json({ error: 'Agent inactif, sorti ou introuvable — révision salariale impossible' });

    if (nouvel_echelon_id) {
      const ech = await db.queryOne('SELECT salaire_min, salaire_max FROM grille_echelons WHERE id = ?', [nouvel_echelon_id]);
      if (ech?.salaire_min && Number(salaire_propose) < Number(ech.salaire_min)) {
        return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) inférieur au minimum de l'échelon (${ech.salaire_min})` });
      }
      if (ech?.salaire_max && Number(salaire_propose) > Number(ech.salaire_max)) {
        return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) supérieur au maximum de l'échelon (${ech.salaire_max})` });
      }
    }

    const result = await db.execute(`
      INSERT INTO demandes_revision_salaire
        (employe_id, type_revision, date_effet, salaire_actuel, salaire_propose,
         transport_actuel, transport_propose, logement_actuel, logement_propose,
         nouvelle_categorie_id, nouvel_echelon_id, motif, document_url,
         statut, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, NOW())
    `, [
      employe_id, type_revision, date_effet,
      agent.salaire_base || 0, Number(salaire_propose),
      agent.prime_transport || 0, Number(transport_propose) || agent.prime_transport || 0,
      agent.prime_logement || 0, Number(logement_propose) || agent.prime_logement || 0,
      nouvelle_categorie_id || null, nouvel_echelon_id || null,
      motif, document_url || null, req.user.id,
    ]);
    await audit(result.insertId, 'creer', { type_revision, salaire_propose, motif }, req.user.id);
    res.status(201).json(await enrichRevision(await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [result.insertId])));
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'brouillon') return res.status(400).json({ error: `Statut "${rev.statut}" — modification impossible. Seul un brouillon est modifiable.` });
    if (Number(rev.created_by) !== Number(req.user.id) && !hasRole(req.user, 'admin', 'rh')) return res.status(403).json({ error: 'Seul le créateur, un RH ou un Admin peut modifier ce brouillon' });

    const payload = {
      type_revision: req.body.type_revision ?? rev.type_revision,
      date_effet: req.body.date_effet ?? rev.date_effet,
      salaire_propose: req.body.salaire_propose ?? rev.salaire_propose,
      transport_propose: req.body.transport_propose ?? rev.transport_propose,
      logement_propose: req.body.logement_propose ?? rev.logement_propose,
      nouvelle_categorie_id: req.body.nouvelle_categorie_id ?? rev.nouvelle_categorie_id,
      nouvel_echelon_id: req.body.nouvel_echelon_id ?? rev.nouvel_echelon_id,
      motif: req.body.motif ?? rev.motif,
      document_url: req.body.document_url ?? rev.document_url,
    };

    await db.execute(`
      UPDATE demandes_revision_salaire SET
        type_revision=?, date_effet=?, salaire_propose=?, transport_propose=?, logement_propose=?,
        nouvelle_categorie_id=?, nouvel_echelon_id=?, motif=?, document_url=?, updated_at=NOW()
      WHERE id=?
    `, [
      payload.type_revision, payload.date_effet, Number(payload.salaire_propose),
      Number(payload.transport_propose) || 0, Number(payload.logement_propose) || 0,
      payload.nouvelle_categorie_id || null, payload.nouvel_echelon_id || null,
      payload.motif, payload.document_url || null, rev.id,
    ]);
    await audit(rev.id, 'modifier', { salaire_propose: payload.salaire_propose, motif: payload.motif }, req.user.id);
    res.json(await enrichRevision(await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [rev.id])));
  } catch (error) { next(error); }
});

async function moveToDgWithParapheur(rev, actorId, avisRh, emp) {
  return db.transaction(async tx => {
    await tx.execute(`
      UPDATE demandes_revision_salaire
      SET statut='soumis_dg', avis_rh=?, valide_rh_by=?, valide_rh_at=NOW(), updated_at=NOW()
      WHERE id=?
    `, [avisRh, actorId, rev.id]);
    const parapheurId = await creerEntreeParapheurDansTransaction(tx, {
      type: 'revision_salariale',
      titre: `Révision salariale — ${emp?.nom || ''} ${emp?.prenom || ''} (validée RH, en attente DG)`,
      initiateur_id: actorId,
      ref_source_table: 'demandes_revision_salaire',
      ref_source_id: rev.id,
      required: true,
    });
    await audit(rev.id, 'valider_rh', { avis_rh: avisRh, parapheur_id: parapheurId, required_parapheur: true }, actorId, tx);
    return parapheurId;
  });
}

router.post('/:id/soumettre-rh', async (req, res, next) => {
  try {
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'brouillon') return res.status(400).json({ error: `Statut actuel "${rev.statut}" — soumission impossible` });
    if (Number(rev.created_by) !== Number(req.user.id) && !hasRole(req.user, 'admin', 'rh', 'dg')) return res.status(403).json({ error: 'Seul le créateur, un RH, le DG ou un Admin peut soumettre' });
    const emp = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [rev.employe_id]);

    if (canApprove(req.user)) {
      const avis = 'Décision DG enregistrée directement';
      await db.execute(`UPDATE demandes_revision_salaire SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?`, [avis, req.user.id, rev.id]);
      await audit(rev.id, 'soumettre_auto_valider_dg', { avis_dg: avis }, req.user.id);
      const updated = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [rev.id]);
      const today = new Date().toISOString().slice(0, 10);
      if (updated.date_effet <= today) {
        if (!await getActiveEmployee(updated.employe_id)) return res.status(400).json({ error: 'Agent inactif ou sorti — application de la révision impossible' });
        await applyRevision(updated, req.user.id);
        await notifyApplied(updated);
        return res.json({ ok: true, statut: 'applique', auto_approved: true, applique_maintenant: true });
      }
      return res.json({ ok: true, statut: 'approuve', auto_approved: true, applique_maintenant: false, date_effet: updated.date_effet });
    }

    if (canRH(req.user)) {
      const avis = 'Contrôle RH validé directement';
      const parapheurId = await moveToDgWithParapheur(rev, req.user.id, avis, emp);
      await notifyRoles(['dg', 'admin'], 'Révision salariale en attente DG', `Révision salariale de ${emp?.nom || ''} ${emp?.prenom || ''} contrôlée par RH — en attente de votre approbation.`, rev.id);
      return res.json({ ok: true, statut: 'soumis_dg', auto_rh_validated: true, parapheur_id: parapheurId });
    }

    await db.execute("UPDATE demandes_revision_salaire SET statut='soumis_rh', updated_at=NOW() WHERE id=?", [rev.id]);
    await audit(rev.id, 'soumettre_rh', null, req.user.id);
    await notifyRoles(['rh', 'admin'], 'Révision salariale soumise', `Révision salariale de ${emp?.nom || ''} ${emp?.prenom || ''} (${rev.type_revision}) soumise pour contrôle RH.`, rev.id);
    res.json({ ok: true, statut: 'soumis_rh' });
  } catch (error) { next(error); }
});

router.post('/:id/valider-rh', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'soumis_rh') return res.status(400).json({ error: `Statut actuel "${rev.statut}" — validation RH impossible` });
    const avis = String(req.body.avis_rh || '').trim();
    if (!avis) return res.status(400).json({ error: 'Avis RH obligatoire' });
    const emp = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [rev.employe_id]);
    const parapheurId = await moveToDgWithParapheur(rev, req.user.id, avis, emp);
    await notifyRoles(['dg', 'admin'], 'Révision salariale en attente DG', `Révision salariale de ${emp?.nom || ''} ${emp?.prenom || ''} validée par RH — en attente de votre approbation.`, rev.id);
    res.json({ ok: true, statut: 'soumis_dg', parapheur_id: parapheurId });
  } catch (error) { next(error); }
});

router.post('/:id/valider-dg', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'soumis_dg') return res.status(400).json({ error: `Statut actuel "${rev.statut}" — validation DG impossible` });
    const avis = String(req.body.avis_dg || '').trim();
    if (!avis) return res.status(400).json({ error: 'Avis DG obligatoire' });
    await db.execute(`UPDATE demandes_revision_salaire SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?`, [avis, req.user.id, rev.id]);
    await audit(rev.id, 'valider_dg', { avis_dg: avis }, req.user.id);
    const updated = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [rev.id]);
    const today = new Date().toISOString().slice(0, 10);
    if (updated.date_effet <= today) {
      if (!await getActiveEmployee(updated.employe_id)) return res.status(400).json({ error: 'Agent inactif ou sorti — application de la révision impossible' });
      await applyRevision(updated, req.user.id);
      await notifyApplied(updated);
      return res.json({ ok: true, statut: 'applique', applique_maintenant: true });
    }
    res.json({ ok: true, statut: 'approuve', applique_maintenant: false, date_effet: updated.date_effet });
  } catch (error) { next(error); }
});

router.post('/:id/appliquer', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'approuve') return res.status(400).json({ error: 'Seule une révision approuvée peut être appliquée' });
    if (!await getActiveEmployee(rev.employe_id)) return res.status(400).json({ error: 'Agent inactif ou sorti — application de la révision impossible' });
    await applyRevision(rev, req.user.id);
    await notifyApplied(rev);
    res.json({ ok: true, statut: 'applique' });
  } catch (error) { next(error); }
});

router.post('/:id/rejeter', async (req, res, next) => {
  try {
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    const peutRejeter = (rev.statut === 'soumis_rh' && canRH(req.user)) || (rev.statut === 'soumis_dg' && canApprove(req.user));
    if (!peutRejeter) return res.status(403).json({ error: 'Vous ne pouvez pas rejeter à cette étape' });
    const motif = String(req.body.motif_rejet || '').trim();
    if (!motif) return res.status(400).json({ error: 'Motif de rejet obligatoire' });
    await db.execute("UPDATE demandes_revision_salaire SET statut='rejete', motif_rejet=?, updated_at=NOW() WHERE id=?", [motif, rev.id]);
    await audit(rev.id, 'rejeter', { motif_rejet: motif }, req.user.id);
    try {
      const emp = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [rev.employe_id]);
      if (rev.created_by) await Promise.resolve(creerNotification({
        type: 'NOTIF_REVISION_SALAIRE', titre: 'Révision salariale rejetée',
        message: `La révision salariale de ${emp?.nom || ''} ${emp?.prenom || ''} a été rejetée. Motif : ${motif}`,
        srcTable: 'demandes_revision_salaire', srcId: rev.id, destinataire_id: rev.created_by,
      }));
    } catch (_) {}
    res.json({ ok: true, statut: 'rejete' });
  } catch (error) { next(error); }
});

router.post('/:id/ajourner', async (req, res, next) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    if (rev.statut !== 'soumis_dg') return res.status(400).json({ error: `Statut "${rev.statut}" — ajournement impossible` });
    const avis = req.body.avis_dg || null;
    await db.execute("UPDATE demandes_revision_salaire SET statut='ajourne', avis_dg=?, valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?", [avis, req.user.id, rev.id]);
    await audit(rev.id, 'ajourner', { avis_dg: avis }, req.user.id);
    res.json({ ok: true, statut: 'ajourne' });
  } catch (error) { next(error); }
});

router.post('/:id/annuler', async (req, res, next) => {
  try {
    const rev = await db.queryOne('SELECT * FROM demandes_revision_salaire WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
    const peutAnnuler = (rev.statut === 'brouillon' && Number(rev.created_by) === Number(req.user.id)) || hasRole(req.user, 'admin');
    if (!peutAnnuler) return res.status(403).json({ error: 'Seul le créateur (brouillon) ou un Admin peut annuler' });
    if (!['brouillon', 'soumis_rh', 'soumis_dg', 'approuve', 'ajourne'].includes(rev.statut)) return res.status(400).json({ error: `Statut "${rev.statut}" non annulable` });
    await db.execute("UPDATE demandes_revision_salaire SET statut='annule', updated_at=NOW() WHERE id=?", [rev.id]);
    await audit(rev.id, 'annuler', null, req.user.id);
    res.json({ ok: true, statut: 'annule' });
  } catch (error) { next(error); }
});

module.exports = router;

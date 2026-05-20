'use strict';

/**
 * MODULE HEURES SUPPLÉMENTAIRES — TOP CENTER
 * Saisie → validation → intégration automatique au bulletin.
 * Taux configurables : normal 125%, dimanche 150%, férié 200%
 * Plafond mensuel configurable (défaut 40h)
 */
const express   = require('express');
const db        = require('../db');
const router    = express.Router();
const { hasRole } = require('./auth');

const WRITE_ROLES   = ['admin', 'rh', 'finance', 'dg'];
const APPROVE_ROLES = ['admin', 'finance', 'dg'];

function canWrite(user)   { return hasRole(user, ...WRITE_ROLES); }
function canApprove(user) { return hasRole(user, ...APPROVE_ROLES); }

async function audit(id, action, details, userId) {
  try {
    await db.execute(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)",
      ['employes_heures_sup', id, action, details ? JSON.stringify(details) : null, userId || null]
    );
  } catch (_) {}
}

async function getTaux() {
  const rows = await db.query("SELECT cle, valeur FROM parametres WHERE cle LIKE 'heures_sup%'");
  const p = {};
  rows.forEach(r => { p[r.cle] = parseFloat(r.valeur) || 0; });
  return {
    normal:   p.heures_sup_taux_normal   || 1.25,
    dimanche: p.heures_sup_taux_dimanche || 1.50,
    ferie:    p.heures_sup_taux_ferie    || 2.00,
    plafond:  p.heures_sup_plafond_mois  || 40,
  };
}

async function calcMontant(nb_heures, type, salaire_base) {
  const taux = await getTaux();
  const taux_majoration = taux[type] || taux.normal;
  const salaire_horaire = (salaire_base || 0) / (26 * 8);
  return {
    taux_majoration,
    montant_brut: Math.round(nb_heures * salaire_horaire * taux_majoration),
  };
}

async function enrichHS(h) {
  if (!h) return null;
  const [emp, valBy, creBy] = await Promise.all([
    db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [h.employe_id]),
    h.valide_par ? db.queryOne('SELECT nom FROM users WHERE id=?', [h.valide_par]) : null,
    h.created_by ? db.queryOne('SELECT nom FROM users WHERE id=?', [h.created_by]) : null,
  ]);
  return {
    ...h,
    employe_nom:    emp   ? `${emp.nom} ${emp.prenom}` : null,
    valide_par_nom: valBy ? valBy.nom : null,
    created_by_nom: creBy ? creBy.nom : null,
  };
}

// Version JOIN — une seule requête pour un listing complet
function hsQueryWithJoins(whereExtra, params) {
  return db.query(`
    SELECT h.*,
           CONCAT(e.nom, ' ', e.prenom) AS employe_nom,
           uv.nom AS valide_par_nom,
           uc.nom AS created_by_nom
    FROM employes_heures_sup h
    JOIN employes e ON e.id = h.employe_id
    LEFT JOIN users uv ON uv.id = h.valide_par
    LEFT JOIN users uc ON uc.id = h.created_by
    ${whereExtra}
    ORDER BY h.date_heures DESC
  `, params);
}

// ─── GET /api/agents/:id/heures-sup ──────────────────────────────────────────
router.get('/:id/heures-sup', async (req, res) => {
  try {
    if (!canWrite(req.user) && !hasRole(req.user, 'dg'))
      return res.status(403).json({ error: 'Accès refusé' });

    const { mois, annee } = req.query;
    const args = [req.params.id];
    let where = 'WHERE h.employe_id = ?';
    if (mois)  { where += ' AND h.mois = ?';  args.push(mois); }
    if (annee) { where += ' AND h.annee = ?'; args.push(annee); }

    res.json(await hsQueryWithJoins(where, args));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/agents/:id/heures-sup ─────────────────────────────────────────
router.post('/:id/heures-sup', async (req, res) => {
  try {
    if (!canWrite(req.user))
      return res.status(403).json({ error: 'Rôle RH, Finance, DG ou Admin requis' });

    const agent = await db.queryOne('SELECT id, salaire_base, statut_dossier FROM employes WHERE id=?', [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
    if (agent.statut_dossier !== 'actif')
      return res.status(400).json({ error: "L'agent doit être actif" });

    const { date_heures, nb_heures, type = 'normal', motif = '' } = req.body;
    if (!date_heures) return res.status(400).json({ error: 'date_heures requis (YYYY-MM-DD)' });
    if (!nb_heures || Number(nb_heures) <= 0)
      return res.status(400).json({ error: 'nb_heures doit être un nombre positif' });

    const typesValides = ['normal', 'dimanche', 'ferie'];
    if (!typesValides.includes(type))
      return res.status(400).json({ error: `type invalide. Valeurs : ${typesValides.join(', ')}` });

    const [annee, mois] = date_heures.slice(0, 7).split('-').map(Number);

    const [taux, tot] = await Promise.all([
      getTaux(),
      db.queryOne(
        "SELECT COALESCE(SUM(nb_heures),0) AS total FROM employes_heures_sup WHERE employe_id=? AND mois=? AND annee=? AND statut IN ('saisi','valide','integre_bulletin')",
        [agent.id, mois, annee]
      ),
    ]);
    const dejaEnregistre = Number(tot.total || 0);

    if (dejaEnregistre + Number(nb_heures) > taux.plafond) {
      return res.status(400).json({
        error: `Plafond mensuel dépassé. Total ce mois : ${dejaEnregistre}h + ${nb_heures}h = ${dejaEnregistre + Number(nb_heures)}h > ${taux.plafond}h autorisées.`,
        code: 'PLAFOND_HEURES_SUP',
        dejaEnregistre,
        plafond: taux.plafond,
      });
    }

    // Calcul direct avec les taux déjà chargés — évite un 2ème appel getTaux()
    const taux_majoration = taux[type] || taux.normal;
    const salaire_horaire = (agent.salaire_base || 0) / (26 * 8);
    const montant_brut    = Math.round(Number(nb_heures) * salaire_horaire * taux_majoration);
    const autoValide = canApprove(req.user);

    const result = await db.execute(`
      INSERT INTO employes_heures_sup
        (employe_id, mois, annee, date_heures, nb_heures, type,
         taux_majoration, montant_brut, statut, valide_par, motif, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      agent.id, mois, annee, date_heures, Number(nb_heures), type,
      taux_majoration, montant_brut,
      autoValide ? 'valide' : 'saisi',
      autoValide ? req.user.id : null,
      motif || null, req.user.id,
    ]);

    await audit(result.insertId, autoValide ? 'creer_auto_valider' : 'creer', { nb_heures, type, montant_brut }, req.user.id);

    const [created] = await hsQueryWithJoins('WHERE h.id = ?', [result.insertId]);
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/agents/:id/heures-sup/:hid/valider ─────────────────────────────
router.put('/:id/heures-sup/:hid/valider', async (req, res) => {
  try {
    if (!canApprove(req.user))
      return res.status(403).json({ error: 'Rôle Finance, DG ou Admin requis' });

    const hs = await db.queryOne('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?', [req.params.hid, req.params.id]);
    if (!hs) return res.status(404).json({ error: 'Entrée heures sup introuvable' });
    if (hs.statut !== 'saisi')
      return res.status(400).json({ error: `Statut "${hs.statut}" — validation impossible (doit être saisi)` });

    const [agent, taux] = await Promise.all([
      db.queryOne('SELECT salaire_base FROM employes WHERE id=?', [req.params.id]),
      getTaux(),
    ]);
    const taux_maj   = taux[hs.type] || taux.normal;
    const sal_horaire = (agent.salaire_base || 0) / (26 * 8);
    const montant_brut = Math.round(hs.nb_heures * sal_horaire * taux_maj);

    await db.execute(
      "UPDATE employes_heures_sup SET statut='valide', valide_par=?, montant_brut=? WHERE id=?",
      [req.user.id, montant_brut, hs.id]
    );

    await audit(hs.id, 'valider', { montant_brut }, req.user.id);
    res.json({ ok: true, statut: 'valide', montant_brut });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/agents/:id/heures-sup/:hid ──────────────────────────────────
router.delete('/:id/heures-sup/:hid', async (req, res) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });

    const hs = await db.queryOne('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?', [req.params.hid, req.params.id]);
    if (!hs) return res.status(404).json({ error: 'Entrée heures sup introuvable' });
    if (hs.statut === 'integre_bulletin')
      return res.status(400).json({ error: 'Heures sup déjà intégrées dans un bulletin — suppression impossible' });

    await db.execute('DELETE FROM employes_heures_sup WHERE id=?', [hs.id]);
    await audit(hs.id, 'supprimer', { nb_heures: hs.nb_heures, type: hs.type }, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/heures-sup/periode/:mois/:annee — vue consolidée ───────────────
router.get('/periode/:mois/:annee', async (req, res) => {
  try {
    const { mois, annee } = req.params;
    const { statut } = req.query;

    let sql = `
      SELECT h.*, CONCAT(e.nom, ' ', e.prenom) AS employe_nom, e.poste, e.departement,
             u.nom AS valide_par_nom
      FROM employes_heures_sup h
      JOIN employes e ON e.id = h.employe_id
      LEFT JOIN users u ON u.id = h.valide_par
      WHERE h.mois = ? AND h.annee = ?
    `;
    const args = [Number(mois), Number(annee)];
    if (statut) { sql += ' AND h.statut = ?'; args.push(statut); }
    sql += ' ORDER BY e.nom, h.date_heures';

    const rows = await db.query(sql, args);

    const totaux = rows.reduce((acc, r) => {
      acc.total_heures  += r.nb_heures;
      acc.total_montant += r.montant_brut;
      acc[r.type]        = (acc[r.type] || 0) + r.nb_heures;
      return acc;
    }, { total_heures: 0, total_montant: 0, normal: 0, dimanche: 0, ferie: 0 });

    const taux = await getTaux();
    res.json({ mois: Number(mois), annee: Number(annee), taux, totaux, items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

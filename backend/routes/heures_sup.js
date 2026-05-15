/**
 * MODULE HEURES SUPPLÉMENTAIRES — TOP CENTER
 * Saisie → validation → intégration automatique au bulletin.
 * Taux configurables : normal 125%, dimanche 150%, férié 200%
 * Plafond mensuel configurable (défaut 40h)
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { createScopedAudit } = require('../services/audit');

const WRITE_ROLES   = ['admin', 'rh', 'finance', 'dg'];
const APPROVE_ROLES = ['admin', 'finance', 'dg'];

function canWrite(user)   { return hasRole(user, ...WRITE_ROLES); }
function canApprove(user) { return hasRole(user, ...APPROVE_ROLES); }

const audit = createScopedAudit('employes_heures_sup');

function getTaux() {
  const rows = db.prepare("SELECT cle, valeur FROM parametres WHERE cle LIKE 'heures_sup%'").all();
  const p = {};
  rows.forEach(r => { p[r.cle] = parseFloat(r.valeur) || 0; });
  return {
    normal:   p.heures_sup_taux_normal   || 1.25,
    dimanche: p.heures_sup_taux_dimanche || 1.50,
    ferie:    p.heures_sup_taux_ferie    || 2.00,
    plafond:  p.heures_sup_plafond_mois  || 40,
  };
}

function calcMontant(nb_heures, type, salaire_base) {
  const taux = getTaux();
  const taux_majoration = taux[type] || taux.normal;
  // Salaire horaire = salaire_base / (26 jours ouvrés × 8 heures)
  const salaire_horaire = (salaire_base || 0) / (26 * 8);
  return {
    taux_majoration,
    montant_brut: Math.round(nb_heures * salaire_horaire * taux_majoration),
  };
}

function enrichHS(h) {
  if (!h) return null;
  const emp   = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(h.employe_id);
  const valBy = h.valide_par ? db.prepare('SELECT nom FROM users WHERE id=?').get(h.valide_par) : null;
  const creBy = h.created_by ? db.prepare('SELECT nom FROM users WHERE id=?').get(h.created_by) : null;
  return {
    ...h,
    employe_nom:    emp   ? `${emp.nom} ${emp.prenom}`     : null,
    valide_par_nom: valBy ? valBy.nom : null,
    created_by_nom: creBy ? creBy.nom : null,
  };
}

// ─── GET /api/agents/:id/heures-sup ──────────────────────────────────────────
router.get('/:id/heures-sup', (req, res) => {
  if (!canWrite(req.user) && !hasRole(req.user, 'dg')) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee } = req.query;
  let sql  = 'SELECT * FROM employes_heures_sup WHERE employe_id = ?';
  const args = [req.params.id];
  if (mois)  { sql += ' AND mois = ?';  args.push(mois); }
  if (annee) { sql += ' AND annee = ?'; args.push(annee); }
  sql += ' ORDER BY date_heures DESC';
  res.json(db.prepare(sql).all(...args).map(enrichHS));
});

// ─── POST /api/agents/:id/heures-sup ─────────────────────────────────────────
router.post('/:id/heures-sup', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, Finance, DG ou Admin requis' });

  const agent = db.prepare('SELECT id, salaire_base, statut_dossier FROM employes WHERE id=?').get(req.params.id);
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

  // Extraire mois/annee de la date
  const [annee, mois] = date_heures.slice(0, 7).split('-').map(Number);

  // Contrôle plafond mensuel
  const taux = getTaux();
  const dejaEnregistre = db.prepare(
    "SELECT COALESCE(SUM(nb_heures),0) AS total FROM employes_heures_sup WHERE employe_id=? AND mois=? AND annee=? AND statut IN ('saisi','valide','integre_bulletin')"
  ).get(agent.id, mois, annee).total;

  if (dejaEnregistre + Number(nb_heures) > taux.plafond) {
    return res.status(400).json({
      error: `Plafond mensuel dépassé. Total ce mois : ${dejaEnregistre}h + ${nb_heures}h = ${dejaEnregistre + Number(nb_heures)}h > ${taux.plafond}h autorisées.`,
      code: 'PLAFOND_HEURES_SUP',
      dejaEnregistre,
      plafond: taux.plafond,
    });
  }

  const { taux_majoration, montant_brut } = calcMontant(Number(nb_heures), type, agent.salaire_base);
  const autoValide = canApprove(req.user);

  const r = db.prepare(`
    INSERT INTO employes_heures_sup
      (employe_id, mois, annee, date_heures, nb_heures, type,
       taux_majoration, montant_brut, statut, valide_par, motif, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(agent.id, mois, annee, date_heures, Number(nb_heures), type,
         taux_majoration, montant_brut, autoValide ? 'valide' : 'saisi',
         autoValide ? req.user.id : null, motif || null, req.user.id);

  audit(r.lastInsertRowid, autoValide ? 'creer_auto_valider' : 'creer', { nb_heures, type, montant_brut }, req.user.id);
  res.status(201).json(enrichHS(db.prepare('SELECT * FROM employes_heures_sup WHERE id=?').get(r.lastInsertRowid)));
});

// ─── PUT /api/agents/:id/heures-sup/:hid/valider ─────────────────────────────
router.put('/:id/heures-sup/:hid/valider', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle Finance, DG ou Admin requis' });

  const hs = db.prepare('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?').get(req.params.hid, req.params.id);
  if (!hs) return res.status(404).json({ error: 'Entrée heures sup introuvable' });
  if (hs.statut !== 'saisi')
    return res.status(400).json({ error: `Statut "${hs.statut}" — validation impossible (doit être saisi)` });

  // Recalculer le montant avec le salaire à jour (peut avoir changé depuis la saisie)
  const agent = db.prepare('SELECT salaire_base FROM employes WHERE id=?').get(req.params.id);
  const { montant_brut } = calcMontant(hs.nb_heures, hs.type, agent.salaire_base);

  db.prepare(`
    UPDATE employes_heures_sup
    SET statut='valide', valide_par=?, montant_brut=?
    WHERE id=?
  `).run(req.user.id, montant_brut, hs.id);

  audit(hs.id, 'valider', { montant_brut }, req.user.id);
  res.json({ ok: true, statut: 'valide', montant_brut });
});

// ─── DELETE /api/agents/:id/heures-sup/:hid ──────────────────────────────────
router.delete('/:id/heures-sup/:hid', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Accès refusé' });

  const hs = db.prepare('SELECT * FROM employes_heures_sup WHERE id=? AND employe_id=?').get(req.params.hid, req.params.id);
  if (!hs) return res.status(404).json({ error: 'Entrée heures sup introuvable' });
  if (hs.statut === 'integre_bulletin')
    return res.status(400).json({ error: 'Heures sup déjà intégrées dans un bulletin — suppression impossible' });

  db.prepare('DELETE FROM employes_heures_sup WHERE id=?').run(hs.id);
  audit(hs.id, 'supprimer', { nb_heures: hs.nb_heures, type: hs.type }, req.user.id);
  res.json({ ok: true });
});

// ─── GET /api/heures-sup/periode/:mois/:annee — vue consolidée ───────────────
router.get('/periode/:mois/:annee', (req, res) => {
  const { mois, annee } = req.params;
  const { statut } = req.query;

  let sql = `
    SELECT h.*, e.nom || ' ' || e.prenom AS employe_nom, e.poste, e.departement,
           u.nom AS valide_par_nom
    FROM employes_heures_sup h
    JOIN employes e ON e.id = h.employe_id
    LEFT JOIN users u ON u.id = h.valide_par
    WHERE h.mois = ? AND h.annee = ?
  `;
  const args = [Number(mois), Number(annee)];
  if (statut) { sql += ' AND h.statut = ?'; args.push(statut); }
  sql += ' ORDER BY e.nom, h.date_heures';

  const rows = db.prepare(sql).all(...args);

  // Totaux par type
  const totaux = rows.reduce((acc, r) => {
    acc.total_heures  += r.nb_heures;
    acc.total_montant += r.montant_brut;
    acc[r.type]        = (acc[r.type] || 0) + r.nb_heures;
    return acc;
  }, { total_heures: 0, total_montant: 0, normal: 0, dimanche: 0, ferie: 0 });

  const taux = getTaux();
  res.json({ mois: Number(mois), annee: Number(annee), taux, totaux, items: rows });
});

module.exports = router;

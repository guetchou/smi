/**
 * MODULE PÉRIODES DE PAIE — TOP CENTER
 * Cycle mensuel avec validation DG de la masse salariale globale.
 * Statuts : ouverte → preparation → controle_rh → controle_finance
 *         → soumis_dg → validee_dg → paiement_en_cours → payee_partielle
 *         → payee → cloturee | rouverte_exception
 *
 * Règle métier : un bulletin ne peut être payé que si sa période est validee_dg.
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');
const {
  can,
  canSubmitPayrollPeriod,
  canApprovePayrollPeriod,
} = require('../services/permissions');

function canRH(user)      { return can(user, 'salary.generate') || hasRole(user, 'admin', 'rh', 'finance'); }

function audit(id, action, details, userId) {
  try {
    db.prepare(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)"
    ).run('periodes_paie', id, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrCreatePeriode(mois, annee, userId) {
  let p = db.prepare('SELECT * FROM periodes_paie WHERE mois = ? AND annee = ?').get(mois, annee);
  if (!p) {
    const r = db.prepare(`
      INSERT INTO periodes_paie (mois, annee, statut, created_at, updated_at)
      VALUES (?, ?, 'ouverte', datetime('now'), datetime('now'))
    `).run(mois, annee);
    p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(r.lastInsertRowid);
    audit(p.id, 'creer', { mois, annee }, userId);
  }
  return p;
}

function computeSynthese(periodeId, mois, annee) {
  // Requête 1/4 — agrégats + anomalies purement sur bulletins_salaire (sans JOIN)
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                                                    AS nb_total,
      COUNT(CASE WHEN statut = 'brouillon' THEN 1 END)                           AS nb_brouillon,
      COUNT(CASE WHEN statut = 'valide'    THEN 1 END)                           AS nb_valide,
      COUNT(CASE WHEN statut = 'paye'      THEN 1 END)                           AS nb_paye,
      COALESCE(SUM(brut), 0)                                                     AS total_brut,
      COALESCE(SUM(net_a_payer), 0)                                              AS total_net,
      COALESCE(SUM(cout_total_employeur - brut), 0)                              AS total_charges_patronales,
      COALESCE(SUM(retenue_avance), 0)                                           AS total_avances_retenues,
      COALESCE(SUM(autres_primes), 0)                                            AS total_primes,
      COUNT(CASE WHEN net_a_payer < 0 THEN 1 END)                                AS net_negatif,
      COUNT(CASE WHEN statut='valide'
                      AND generated_by IS NOT NULL AND validated_by IS NOT NULL
                      AND generated_by = validated_by THEN 1 END)                AS seg_breach
    FROM bulletins_salaire WHERE mois = ? AND annee = ?
  `).get(mois, annee);

  // Requête 2/4 — anomalies nécessitant un JOIN avec employes + grille_echelons
  const joinStats = db.prepare(`
    SELECT
      COUNT(CASE WHEN e.statut_dossier = 'sorti' AND b.statut != 'paye' THEN 1 END) AS agents_sortis,
      COUNT(CASE WHEN ge.salaire_max IS NOT NULL AND b.salaire_base > ge.salaire_max THEN 1 END) AS hors_grille
    FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    LEFT JOIN grille_echelons ge ON ge.id = e.grille_echelon_id
    WHERE b.mois = ? AND b.annee = ?
  `).get(mois, annee);

  // Requête 3/4 — salaires modifiés ce mois (table historique_salaires)
  const mPad = String(mois).padStart(2,'0');
  const salaireModifie = db.prepare(`
    SELECT COUNT(DISTINCT employe_id) AS c FROM historique_salaires
    WHERE strftime('%Y-%m', created_at) = ?
  `).get(`${annee}-${mPad}`).c;

  // Requête 4/4 — entrants/sortants du mois (table employes)
  const mvtMois = db.prepare(`
    SELECT
      COUNT(CASE WHEN strftime('%Y-%m', date_embauche) = ? THEN 1 END) AS entrants,
      COUNT(CASE WHEN strftime('%Y-%m', date_sortie)   = ? THEN 1 END) AS sortants
    FROM employes
    WHERE strftime('%Y-%m', date_embauche) = ?
       OR strftime('%Y-%m', date_sortie)   = ?
  `).get(`${annee}-${mPad}`, `${annee}-${mPad}`, `${annee}-${mPad}`, `${annee}-${mPad}`);

  const anomalies = [];
  if (stats.net_negatif  > 0) anomalies.push({ type: 'net_negatif',              gravite: 'bloquant',      count: stats.net_negatif,        message: `${stats.net_negatif} bulletin(s) avec net négatif` });
  if (joinStats.agents_sortis > 0) anomalies.push({ type: 'agent_sorti_avec_bulletin', gravite: 'bloquant', count: joinStats.agents_sortis, message: `${joinStats.agents_sortis} agent(s) sorti(s) avec bulletin actif` });
  if (joinStats.hors_grille   > 0) anomalies.push({ type: 'hors_borne_grille',   gravite: 'avertissement', count: joinStats.hors_grille,   message: `${joinStats.hors_grille} bulletin(s) avec salaire hors borne d'échelon` });
  if (stats.seg_breach   > 0) anomalies.push({ type: 'segregation_taches',        gravite: 'avertissement', count: stats.seg_breach,         message: `${stats.seg_breach} bulletin(s) validé(s) par leur créateur` });
  if (salaireModifie     > 0) anomalies.push({ type: 'salaire_modifie_ce_mois',   gravite: 'info',          count: salaireModifie,           message: `${salaireModifie} agent(s) avec salaire modifié ce mois` });

  const { net_negatif: _n, seg_breach: _s, ...statsMains } = stats;
  return { ...statsMains, anomalies, entrants: mvtMois.entrants || 0, sortants: mvtMois.sortants || 0 };
}

function updatePeriodeStats(mois, annee) {
  const s = db.prepare(`
    SELECT COUNT(*) AS ng,
           SUM(CASE WHEN statut='valide' THEN 1 ELSE 0 END) AS nv,
           SUM(CASE WHEN statut='paye'   THEN 1 ELSE 0 END) AS np,
           COALESCE(SUM(brut),0) AS tb, COALESCE(SUM(net_a_payer),0) AS tn,
           COALESCE(SUM(cout_total_employeur-brut),0) AS tc
    FROM bulletins_salaire WHERE mois=? AND annee=?
  `).get(mois, annee);
  db.prepare(`
    UPDATE periodes_paie SET
      nb_bulletins_generes=?, nb_bulletins_valides=?, nb_bulletins_payes=?,
      total_brut=?, total_net=?, total_charges=?, updated_at=datetime('now')
    WHERE mois=? AND annee=?
  `).run(s.ng||0, s.nv||0, s.np||0, s.tb||0, s.tn||0, s.tc||0, mois, annee);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/paie/periodes — créer ou récupérer la période du mois
router.post('/periodes', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Accès refusé' });
  const { mois, annee, force } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });

  const m = Number(mois); const y = Number(annee);

  // Règle métier n°20 : période précédente non clôturée → alerte bloquante
  // (sauf si la période demandée existe déjà ou si force=true avec rôle admin)
  const existing = db.prepare('SELECT id FROM periodes_paie WHERE mois = ? AND annee = ?').get(m, y);
  if (!existing) {
    const prevMois  = m === 1 ? 12 : m - 1;
    const prevAnnee = m === 1 ? y - 1 : y;
    const prev = db.prepare(
      "SELECT mois, annee, statut FROM periodes_paie WHERE mois = ? AND annee = ?"
    ).get(prevMois, prevAnnee);
    if (prev && !['cloturee'].includes(prev.statut)) {
      if (!force || !hasRole(req.user, 'admin', 'dg')) {
        return res.status(409).json({
          error: `La période ${String(prevMois).padStart(2,'0')}/${prevAnnee} n'est pas clôturée (statut: ${prev.statut}). Clôturez-la avant d'ouvrir le mois suivant.`,
          periode_precedente: prev,
          peut_forcer: hasRole(req.user, 'admin', 'dg'),
        });
      }
    }
  }

  const p = getOrCreatePeriode(m, y, req.user.id);
  res.status(existing ? 200 : 201).json(p);
});

// GET /api/paie/periodes — liste des périodes
router.get('/periodes', (req, res) => {
  const periodes = db.prepare(
    'SELECT * FROM periodes_paie ORDER BY annee DESC, mois DESC LIMIT 24'
  ).all();
  res.json(periodes);
});

// GET /api/paie/periodes/:id — détail + synthèse + anomalies
router.get('/periodes/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });
  const synthese = computeSynthese(p.id, p.mois, p.annee);
  const valideurDG  = p.valide_dg_by  ? db.prepare('SELECT nom FROM users WHERE id=?').get(p.valide_dg_by)  : null;
  const valideurSub = p.soumis_dg_by  ? db.prepare('SELECT nom FROM users WHERE id=?').get(p.soumis_dg_by) : null;
  res.json({
    ...p,
    synthese,
    valide_dg_nom:  valideurDG  ? valideurDG.nom  : null,
    soumis_dg_nom:  valideurSub ? valideurSub.nom : null,
  });
});

// POST /api/paie/periodes/:id/soumettre-dg — controle_finance → soumis_dg
router.post('/periodes/:id/soumettre-dg', (req, res) => {
  if (!canSubmitPayrollPeriod(req.user)) return res.status(403).json({ error: 'Permission salary.submit_to_dg requise' });
  const p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });

  const transitionOk = ['ouverte','preparation','controle_rh','controle_finance'].includes(p.statut);
  if (!transitionOk)
    return res.status(400).json({ error: `Statut "${p.statut}" — soumission au DG impossible` });

  const synthese = computeSynthese(p.id, p.mois, p.annee);
  const bloquants = synthese.anomalies.filter(a => a.gravite === 'bloquant');
  if (bloquants.length > 0)
    return res.status(400).json({
      error: 'Des anomalies bloquantes empêchent la soumission au DG',
      anomalies: bloquants,
    });

  updatePeriodeStats(p.mois, p.annee);
  if (canApprovePayrollPeriod(req.user)) {
    db.prepare(`
      UPDATE periodes_paie
      SET statut='validee_dg',
          soumis_dg_by=?, soumis_dg_at=datetime('now'),
          valide_dg_by=?, valide_dg_at=datetime('now'),
          updated_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, req.user.id, p.id);
    audit(p.id, 'soumettre_auto_valider_dg', { mois: p.mois, annee: p.annee }, req.user.id);
    return res.json({ ok: true, statut: 'validee_dg', auto_approved: true, synthese });
  }

  db.prepare(`
    UPDATE periodes_paie
    SET statut='soumis_dg', soumis_dg_by=?, soumis_dg_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, p.id);
  audit(p.id, 'soumettre_dg', { mois: p.mois, annee: p.annee }, req.user.id);

  // Notifier DG
  try {
    const dgs = db.prepare("SELECT id FROM users WHERE actif=1 AND (role='dg' OR role='admin' OR roles LIKE '%\"dg\"%')").all();
    dgs.forEach(u => creerNotification({
      type: 'NOTIF_PERIODE_PAIE',
      titre: `Masse salariale ${p.mois}/${p.annee} soumise`,
      message: `La masse salariale de ${p.mois}/${p.annee} est soumise pour validation (total net : ${new Intl.NumberFormat('fr-FR').format(synthese.total_net)} XAF).`,
      srcTable: 'periodes_paie', srcId: p.id, destinataire_id: u.id,
    }));
  } catch (_) {}

  res.json({ ok: true, statut: 'soumis_dg', synthese });
});

// POST /api/paie/periodes/:id/valider-dg — soumis_dg → validee_dg (DG uniquement)
router.post('/periodes/:id/valider-dg', (req, res) => {
  if (!canApprovePayrollPeriod(req.user)) return res.status(403).json({ error: 'Permission salary.approve_period_dg requise' });
  const p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });
  if (p.statut !== 'soumis_dg')
    return res.status(400).json({ error: `Statut "${p.statut}" — validation DG impossible` });

  const { notes } = req.body;
  updatePeriodeStats(p.mois, p.annee);
  db.prepare(`
    UPDATE periodes_paie
    SET statut='validee_dg', valide_dg_by=?, valide_dg_at=datetime('now'),
        notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, notes || null, p.id);
  audit(p.id, 'valider_dg', { notes }, req.user.id);

  res.json({ ok: true, statut: 'validee_dg' });
});

// POST /api/paie/periodes/:id/cloturer — payee → cloturee
router.post('/periodes/:id/cloturer', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis pour clôturer' });
  const p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });
  if (!['payee', 'paiement_en_cours', 'payee_partielle', 'validee_dg'].includes(p.statut))
    return res.status(400).json({ error: `Statut "${p.statut}" — clôture impossible` });

  const nbNonPayes = db.prepare(
    "SELECT COUNT(*) AS c FROM bulletins_salaire WHERE mois=? AND annee=? AND statut != 'paye'"
  ).get(p.mois, p.annee).c;
  if (nbNonPayes > 0)
    return res.status(400).json({ error: `${nbNonPayes} bulletin(s) non encore payé(s) — réglez-les avant de clôturer` });

  db.prepare(`
    UPDATE periodes_paie
    SET statut='cloturee', cloture_by=?, cloture_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, p.id);
  audit(p.id, 'cloturer', null, req.user.id);
  res.json({ ok: true, statut: 'cloturee' });
});

// POST /api/paie/periodes/:id/rouvrir-exception — cloturee → rouverte_exception
router.post('/periodes/:id/rouvrir-exception', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const p = db.prepare('SELECT * FROM periodes_paie WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });
  if (p.statut !== 'cloturee')
    return res.status(400).json({ error: 'Seule une période clôturée peut être réouverte' });

  const { motif } = req.body;
  if (!motif || !String(motif).trim())
    return res.status(400).json({ error: 'Motif obligatoire pour réouverture exceptionnelle' });

  db.prepare(`
    UPDATE periodes_paie
    SET statut='rouverte_exception', notes=?, updated_at=datetime('now')
    WHERE id=?
  `).run(String(motif).trim(), p.id);
  // Audit renforcé
  audit(p.id, 'rouvrir_exception', { motif: String(motif).trim() }, req.user.id);
  try {
    db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
      .run('periodes_paie', p.id, 'ALERTE_SECURITE_REOUVERTURE',
        JSON.stringify({ motif, mois: p.mois, annee: p.annee }), req.user.id);
  } catch (_) {}

  res.json({ ok: true, statut: 'rouverte_exception' });
});

module.exports = { router, getOrCreatePeriode, updatePeriodeStats };

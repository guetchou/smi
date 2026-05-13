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

const FINANCE_ROLES = ['admin', 'finance', 'dg'];
const APPROVE_ROLES = ['admin', 'dg'];

function canFinance(user) { return hasRole(user, ...FINANCE_ROLES); }
function canApprove(user) { return hasRole(user, ...APPROVE_ROLES); }
function canRH(user)      { return hasRole(user, 'admin', 'rh', 'finance'); }

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
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS nb_total,
      COUNT(CASE WHEN statut = 'brouillon' THEN 1 END) AS nb_brouillon,
      COUNT(CASE WHEN statut = 'valide'    THEN 1 END) AS nb_valide,
      COUNT(CASE WHEN statut = 'paye'      THEN 1 END) AS nb_paye,
      COALESCE(SUM(brut), 0)             AS total_brut,
      COALESCE(SUM(net_a_payer), 0)      AS total_net,
      COALESCE(SUM(cout_total_employeur - brut), 0) AS total_charges_patronales,
      COALESCE(SUM(retenue_avance), 0)   AS total_avances_retenues,
      COALESCE(SUM(autres_primes), 0)    AS total_primes
    FROM bulletins_salaire WHERE mois = ? AND annee = ?
  `).get(mois, annee);

  // Anomalies détectées automatiquement
  const anomalies = [];

  // 1. Bulletins avec net négatif
  const netNegatif = db.prepare(
    "SELECT COUNT(*) AS c FROM bulletins_salaire WHERE mois=? AND annee=? AND net_a_payer < 0"
  ).get(mois, annee).c;
  if (netNegatif > 0) anomalies.push({ type: 'net_negatif', gravite: 'bloquant', count: netNegatif, message: `${netNegatif} bulletin(s) avec net négatif` });

  // 2. Agents sortis avec bulletin actif
  const agentsSortis = db.prepare(`
    SELECT COUNT(*) AS c FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    WHERE b.mois=? AND b.annee=? AND b.statut != 'paye'
    AND e.statut_dossier = 'sorti'
  `).get(mois, annee).c;
  if (agentsSortis > 0) anomalies.push({ type: 'agent_sorti_avec_bulletin', gravite: 'bloquant', count: agentsSortis, message: `${agentsSortis} agent(s) sorti(s) avec bulletin actif` });

  // 3. Bulletins hors borne de grille
  const horsGrille = db.prepare(`
    SELECT COUNT(*) AS c FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    JOIN grille_echelons ge ON ge.id = e.grille_echelon_id
    WHERE b.mois=? AND b.annee=?
    AND ge.salaire_max IS NOT NULL AND b.salaire_base > ge.salaire_max
  `).get(mois, annee).c;
  if (horsGrille > 0) anomalies.push({ type: 'hors_borne_grille', gravite: 'avertissement', count: horsGrille, message: `${horsGrille} bulletin(s) avec salaire hors borne d'échelon` });

  // 4. Ségrégation des tâches : même créateur = validateur
  const segBreachCount = db.prepare(`
    SELECT COUNT(*) AS c FROM bulletins_salaire
    WHERE mois=? AND annee=? AND statut='valide'
    AND generated_by IS NOT NULL AND validated_by IS NOT NULL
    AND generated_by = validated_by
  `).get(mois, annee).c;
  if (segBreachCount > 0) anomalies.push({ type: 'segregation_taches', gravite: 'avertissement', count: segBreachCount, message: `${segBreachCount} bulletin(s) validé(s) par leur créateur` });

  // 5. Salaire modifié ce mois vs historique
  const salaireModifie = db.prepare(`
    SELECT COUNT(DISTINCT employe_id) AS c FROM historique_salaires
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', ?)
  `).get(`${annee}-${String(mois).padStart(2,'0')}-01`).c;
  if (salaireModifie > 0) anomalies.push({ type: 'salaire_modifie_ce_mois', gravite: 'info', count: salaireModifie, message: `${salaireModifie} agent(s) avec salaire modifié ce mois` });

  // Agents entrants et sortants du mois
  const m = String(mois).padStart(2,'0');
  const entrants = db.prepare(
    `SELECT COUNT(*) AS c FROM employes WHERE strftime('%Y-%m', date_embauche) = ?`
  ).get(`${annee}-${m}`).c;
  const sortants = db.prepare(
    `SELECT COUNT(*) AS c FROM employes WHERE strftime('%Y-%m', date_sortie) = ?`
  ).get(`${annee}-${m}`).c;

  return { ...stats, anomalies, entrants, sortants };
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
  const { mois, annee } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
  const p = getOrCreatePeriode(Number(mois), Number(annee), req.user.id);
  res.status(201).json(p);
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
  if (!canFinance(req.user)) return res.status(403).json({ error: 'Rôle Finance ou Admin requis' });
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
  if (canApprove(req.user)) {
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
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
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

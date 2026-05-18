/**
 * ROUTES DASHBOARD — Données par rôle
 * Endpoints légers agrégeant les données pour chaque vue home.
 */
const express = require('express');
const db = require('../database');
const router = express.Router();
const { hasRole } = require('./auth');

// Calcule le solde courant d'une position (solde_initial + delta des opérations validées)
function getSoldePosition(positionId) {
  const pos = db.prepare('SELECT solde_initial FROM positions WHERE id = ?').get(positionId);
  if (!pos) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN type_op IN ('encaissement','virement') AND position_id = ? THEN montant
      WHEN type_op = 'decaissement'               AND position_id = ? THEN -montant
      WHEN type_op = 'virement'    AND position_source_id = ?         THEN -montant
      ELSE 0 END), 0) AS delta
    FROM operations WHERE statut = 'valide'
  `).get(positionId, positionId, positionId);
  return (pos.solde_initial || 0) + (row.delta || 0);
}

function getSoldePrincipal() {
  const positions = db.prepare("SELECT id, code, libelle, type FROM positions WHERE actif = 1 ORDER BY CASE type WHEN 'caisse' THEN 1 ELSE 2 END").all();
  const withSolde = positions.map(p => ({ ...p, solde: getSoldePosition(p.id) }));
  const caisse = withSolde.find(p => p.code === 'CAISSE') || withSolde.find(p => p.type === 'caisse') || withSolde[0];
  return { positions: withSolde, soldePrincipal: caisse?.solde || 0 };
}

// ─── GET /home — vue agrégée selon le rôle de l'utilisateur ──────────────────
router.get('/home', (req, res) => {
  const user = req.user;
  const role = user.role;

  try {
    if (hasRole(user, 'dg', 'manager', 'admin', 'delegue')) {
      return res.json({ vue: 'decideur', data: getDecideurData(user) });
    }
    if (hasRole(user, 'finance')) {
      return res.json({ vue: 'finance', data: getFinanceData() });
    }
    if (hasRole(user, 'rh')) {
      return res.json({ vue: 'rh', data: getRhData() });
    }
    // caissier, assistante_direction, lecteur
    return res.json({ vue: 'operationnel', data: getOperationnelData(user) });
  } catch (e) {
    console.error('[dashboard/home]', e.message);
    res.status(500).json({ error: 'Erreur chargement dashboard' });
  }
});

// ─── GET /solde — solde + seuil d'alerte ─────────────────────────────────────
router.get('/solde', (req, res) => {
  try {
    const { positions, soldePrincipal } = getSoldePrincipal();
    const prm = db.prepare("SELECT valeur FROM parametres WHERE cle = 'seuil_alerte'").get();
    const seuil = Number(prm?.valeur || 100000);
    res.json({
      solde: soldePrincipal,
      seuil_alerte: seuil,
      alerte: soldePrincipal < seuil,
      positions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /flux?periode=jour|semaine|mois ──────────────────────────────────────
router.get('/flux', (req, res) => {
  const periode = req.query.periode || 'mois';

  let dateFilter;
  if (periode === 'jour') {
    dateFilter = "date(o.date) = date('now')";
  } else if (periode === 'semaine') {
    dateFilter = "date(o.date) >= date('now', 'weekday 0', '-7 days')";
  } else {
    dateFilter = "strftime('%Y-%m', o.date) = strftime('%Y-%m', 'now')";
  }

  try {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN o.type_op = 'encaissement' THEN o.montant ELSE 0 END), 0) AS encaissements,
        COALESCE(SUM(CASE WHEN o.type_op = 'decaissement' THEN o.montant ELSE 0 END), 0) AS decaissements,
        COUNT(*) AS nb_ops
      FROM operations o
      WHERE ${dateFilter}
    `).get();
    res.json({ periode, ...row, solde_net: row.encaissements - row.decaissements });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /actions-en-attente — décaissements à valider (rôle DG/Finance) ──────
router.get('/actions-en-attente', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT o.id, o.num_piece, o.libelle, o.montant, o.date, o.dec_statut,
        c.nom AS categorie_nom,
        u.nom AS created_by_nom
      FROM operations o
      LEFT JOIN categories c ON c.id = o.categorie_id
      LEFT JOIN users u ON u.id = o.created_by
      WHERE o.type_op = 'decaissement'
        AND COALESCE(o.dec_statut, 'brouillon') IN ('brouillon', 'soumis')
      ORDER BY o.date DESC
      LIMIT 10
    `).all();
    res.json({ actions: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /conges-en-attente — congés à valider (rôle RH) ────────────────────
router.get('/conges-en-attente', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.type_conge, c.date_debut, c.date_fin, c.nb_jours,
        c.statut, c.motif, c.created_at,
        e.nom || ' ' || COALESCE(e.prenom, '') AS employe_nom,
        e.poste, e.departement
      FROM employes_conges c
      JOIN employes e ON e.id = c.employe_id
      WHERE c.statut IN ('demande', 'valide_sup')
      ORDER BY c.created_at ASC
      LIMIT 20
    `).all();
    res.json({ conges: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /echeances-contrats — fins d'essai et CDD dans 90j ─────────────────
router.get('/echeances-contrats', (req, res) => {
  try {
    const cols = db.prepare("PRAGMA table_info(employes)").all().map(c => c.name);
    const hasDateFinEssai = cols.includes('date_fin_essai');
    const hasDateFin = cols.includes('date_fin_contrat');
    const hasType = cols.includes('type_contrat');

    const echeances = [];

    if (hasDateFinEssai) {
      const essais = db.prepare(`
        SELECT id, nom, prenom, poste, departement, date_fin_essai AS date_echeance,
          'fin_essai' AS type_echeance
        FROM employes
        WHERE actif = 1
          AND date_fin_essai IS NOT NULL
          AND date(date_fin_essai) BETWEEN date('now') AND date('now', '+90 days')
        ORDER BY date_fin_essai ASC
        LIMIT 20
      `).all();
      echeances.push(...essais);
    }

    if (hasDateFin && hasType) {
      const cdds = db.prepare(`
        SELECT id, nom, prenom, poste, departement, date_fin_contrat AS date_echeance,
          'fin_cdd' AS type_echeance
        FROM employes
        WHERE actif = 1
          AND type_contrat = 'CDD'
          AND date_fin_contrat IS NOT NULL
          AND date(date_fin_contrat) BETWEEN date('now') AND date('now', '+90 days')
        ORDER BY date_fin_contrat ASC
        LIMIT 20
      `).all();
      echeances.push(...cdds);
    }

    echeances.sort((a, b) => new Date(a.date_echeance) - new Date(b.date_echeance));
    res.json({ echeances });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /kpis-rh — effectif, turnover, absentéisme ─────────────────────────
router.get('/kpis-rh', (req, res) => {
  try {
    const effectif = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN actif = 1 THEN 1 ELSE 0 END), 0) AS actifs,
        COALESCE(SUM(CASE WHEN actif != 1 THEN 1 ELSE 0 END), 0) AS inactifs
      FROM employes
    `).get();

    // Onboardings incomplets (checklist < 100%)
    let onboardingAlerts = 0;
    try {
      const obs = db.prepare(`
        SELECT COUNT(*) AS nb FROM onboarding_checklists
        WHERE progression < 100
          AND created_at >= date('now', '-90 days')
      `).get();
      onboardingAlerts = obs?.nb || 0;
    } catch (_) { /* table peut ne pas exister */ }

    // Entrées/sorties du mois courant (colonnes variables selon migration)
    let mouvement = { entrees_mois: 0, sorties_mois: 0 };
    try {
      const empCols = db.prepare("PRAGMA table_info(employes)").all().map(c => c.name);
      const entreeCol = empCols.includes('date_embauche') ? 'date_embauche' : null;
      const sortieCol = empCols.includes('date_sortie') ? 'date_sortie' : null;
      mouvement.entrees_mois = entreeCol
        ? db.prepare(`SELECT COUNT(*) AS nb FROM employes WHERE strftime('%Y-%m',${entreeCol})=strftime('%Y-%m','now')`).get()?.nb || 0
        : 0;
      mouvement.sorties_mois = sortieCol
        ? db.prepare(`SELECT COUNT(*) AS nb FROM employes WHERE ${sortieCol} IS NOT NULL AND strftime('%Y-%m',${sortieCol})=strftime('%Y-%m','now')`).get()?.nb || 0
        : 0;
    } catch (_) {}

    res.json({
      effectif,
      entrees_mois: mouvement?.entrees_mois || 0,
      sorties_mois: mouvement?.sorties_mois || 0,
      onboarding_alertes: onboardingAlerts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /periode-paie-courante ───────────────────────────────────────────────
router.get('/periode-paie-courante', (req, res) => {
  try {
    const now = new Date();
    const mois = now.getMonth() + 1;
    const annee = now.getFullYear();

    const periode = db.prepare(`
      SELECT pp.*, COUNT(b.id) AS nb_bulletins,
        COALESCE(SUM(CASE WHEN b.statut = 'paye' THEN 1 ELSE 0 END), 0) AS bulletins_payes
      FROM periodes_paie pp
      LEFT JOIN bulletins_salaire b ON b.periode_id = pp.id
      WHERE pp.mois = ? AND pp.annee = ?
      GROUP BY pp.id
    `).get(mois, annee);

    const actifs = db.prepare("SELECT COUNT(*) AS nb FROM employes WHERE actif = 1").get();
    const totalActifs = actifs?.nb || 0;

    if (!periode) {
      return res.json({ periode: null, mois, annee, total_actifs: totalActifs });
    }

    const progression = totalActifs > 0
      ? Math.round((periode.bulletins_payes / totalActifs) * 100)
      : 0;

    res.json({ periode, progression, total_actifs: totalActifs, mois, annee });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helpers internes ─────────────────────────────────────────────────────────

function getDecideurData(user) {
  const prm = db.prepare("SELECT valeur FROM parametres WHERE cle = 'seuil_alerte'").get();
  const seuil = Number(prm?.valeur || 100000);

  const { soldePrincipal: solde } = getSoldePrincipal();
  const caisse = { solde };

  const todayFlux = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec
    FROM operations WHERE date(date)=date('now')
  `).get();

  const moisFlux = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec,
      COUNT(*) AS nb
    FROM operations WHERE strftime('%Y-%m',date)=strftime('%Y-%m','now')
  `).get();

  const actions = db.prepare(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.date, o.dec_statut,
      u.nom AS created_by_nom
    FROM operations o
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.type_op='decaissement'
      AND COALESCE(o.dec_statut,'brouillon') IN ('brouillon','soumis')
    ORDER BY o.date DESC LIMIT 5
  `).all();

  return {
    solde: caisse?.solde || 0,
    seuil_alerte: seuil,
    alerte: (caisse?.solde || 0) < seuil,
    today: { enc: todayFlux.enc, dec: todayFlux.dec, net: todayFlux.enc - todayFlux.dec },
    mois: { enc: moisFlux.enc, dec: moisFlux.dec, nb: moisFlux.nb, net: moisFlux.enc - moisFlux.dec },
    actions_en_attente: actions,
    parapheur_en_attente: (() => {
      try {
        return db.prepare(`SELECT COUNT(*) AS c FROM parapheur WHERE statut = 'transmis_dg'`).get().c;
      } catch (_) { return 0; }
    })(),
  };
}

function getFinanceData() {
  function flux(filter) {
    return db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
        COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec
      FROM operations WHERE ${filter}
    `).get();
  }

  const jour = flux("date(date)=date('now')");
  const semaine = flux("date(date)>=date('now','-6 days')");
  const mois = flux("strftime('%Y-%m',date)=strftime('%Y-%m','now')");

  const pending = db.prepare(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.date, o.dec_statut,
      u.nom AS created_by_nom
    FROM operations o
    LEFT JOIN users u ON u.id=o.created_by
    WHERE o.type_op='decaissement'
      AND COALESCE(o.dec_statut,'brouillon') IN ('brouillon','soumis')
    ORDER BY o.date DESC LIMIT 10
  `).all();

  // Rapprochements en attente : opérations sans rapprochement associé
  let rappro_pending = 0;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS nb FROM operations
      WHERE rapprochement_id IS NULL
        AND type_op IN ('encaissement','decaissement')
        AND strftime('%Y-%m',date)=strftime('%Y-%m','now')
    `).get();
    rappro_pending = r?.nb || 0;
  } catch (_) { /* colonne peut ne pas exister */ }

  return {
    flux: { jour, semaine, mois },
    decaissements_a_valider: pending,
    rappro_pending,
  };
}

function getOperationnelData(user) {
  const mesDernieres = db.prepare(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.type_op, o.date,
      o.dec_statut, c.nom AS categorie_nom
    FROM operations o
    LEFT JOIN categories c ON c.id=o.categorie_id
    WHERE o.created_by=?
    ORDER BY o.created_at DESC LIMIT 10
  `).all(user.id);

  const todayFlux = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec,
      COUNT(*) AS nb
    FROM operations WHERE date(date)=date('now')
  `).get();

  const prm = db.prepare("SELECT valeur FROM parametres WHERE cle='seuil_alerte'").get();
  const seuil = Number(prm?.valeur || 100000);
  const { soldePrincipal: solde } = getSoldePrincipal();

  return {
    solde,
    seuil_alerte: seuil,
    alerte: solde < seuil,
    today: { enc: todayFlux.enc, dec: todayFlux.dec, nb: todayFlux.nb, net: todayFlux.enc - todayFlux.dec },
    mes_dernieres: mesDernieres,
  };
}

function getRhData() {
  const conges = db.prepare(`
    SELECT c.id, c.type_conge, c.date_debut, c.date_fin, c.nb_jours, c.statut, c.created_at,
      e.nom || ' ' || COALESCE(e.prenom,'') AS employe_nom, e.poste, e.departement
    FROM employes_conges c
    JOIN employes e ON e.id=c.employe_id
    WHERE c.statut IN ('demande','valide_sup')
    ORDER BY c.created_at ASC LIMIT 10
  `).all();

  const effectif = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN actif=1 THEN 1 ELSE 0 END),0) AS actifs,
      COALESCE(SUM(CASE WHEN actif!=1 THEN 1 ELSE 0 END),0) AS inactifs
    FROM employes
  `).get();

  // date_embauche est la colonne d'entrée, date_sortie pour les sorties
  const cols = db.prepare("PRAGMA table_info(employes)").all().map(c => c.name);
  const hasDateEmbauche = cols.includes('date_embauche');
  const hasDateSortie = cols.includes('date_sortie');

  let mouvement = { entrees: 0, sorties: 0 };
  try {
    const entreeCol = hasDateEmbauche ? 'date_embauche' : null;
    const sortieCol = hasDateSortie ? 'date_sortie' : null;
    const entrees = entreeCol
      ? db.prepare(`SELECT COUNT(*) AS nb FROM employes WHERE strftime('%Y-%m',${entreeCol})=strftime('%Y-%m','now')`).get()?.nb || 0
      : 0;
    const sorties = sortieCol
      ? db.prepare(`SELECT COUNT(*) AS nb FROM employes WHERE ${sortieCol} IS NOT NULL AND strftime('%Y-%m',${sortieCol})=strftime('%Y-%m','now')`).get()?.nb || 0
      : 0;
    mouvement = { entrees, sorties };
  } catch (_) {}

  // Echeances contrats (30j)
  let echeances = [];
  if (cols.includes('date_fin_essai')) {
    const essais = db.prepare(`
      SELECT id,nom,prenom,poste,date_fin_essai AS date_echeance,'fin_essai' AS type_echeance
      FROM employes WHERE actif=1 AND date_fin_essai IS NOT NULL
        AND date(date_fin_essai) BETWEEN date('now') AND date('now','+30 days')
      ORDER BY date_fin_essai LIMIT 10
    `).all();
    echeances.push(...essais);
  }
  if (cols.includes('date_fin_contrat') && cols.includes('type_contrat')) {
    const cdds = db.prepare(`
      SELECT id,nom,prenom,poste,date_fin_contrat AS date_echeance,'fin_cdd' AS type_echeance
      FROM employes WHERE actif=1 AND type_contrat='CDD' AND date_fin_contrat IS NOT NULL
        AND date(date_fin_contrat) BETWEEN date('now') AND date('now','+30 days')
      ORDER BY date_fin_contrat LIMIT 10
    `).all();
    echeances.push(...cdds);
  }

  // Période de paie courante
  const now = new Date();
  const periode = db.prepare(`
    SELECT pp.mois, pp.annee, pp.statut,
      COUNT(b.id) AS nb_bulletins,
      COALESCE(SUM(CASE WHEN b.statut='paye' THEN 1 ELSE 0 END),0) AS bulletins_payes
    FROM periodes_paie pp
    LEFT JOIN bulletins_salaire b ON b.periode_id=pp.id
    WHERE pp.mois=? AND pp.annee=?
    GROUP BY pp.id
  `).get(now.getMonth() + 1, now.getFullYear());

  let onboarding_alertes = 0;
  try {
    const obs = db.prepare(`SELECT COUNT(*) AS nb FROM onboarding_checklists WHERE progression<100 AND created_at>=date('now','-90 days')`).get();
    onboarding_alertes = obs?.nb || 0;
  } catch (_) {}

  return {
    conges_en_attente: conges,
    effectif,
    mouvement,
    echeances_proches: echeances,
    periode_courante: periode || null,
    onboarding_alertes,
  };
}

module.exports = router;

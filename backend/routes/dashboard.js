/**
 * ROUTES DASHBOARD — Données par rôle
 * Endpoints légers agrégeant les données pour chaque vue home.
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');

// Calcule le solde courant d'une position (solde_initial + delta des opérations validées)
async function getSoldePosition(positionId) {
  const pos = await db.queryOne('SELECT solde_initial FROM positions WHERE id = ?', [positionId]);
  if (!pos) return 0;
  const row = await db.queryOne(`
    SELECT COALESCE(SUM(CASE
      WHEN type_op IN ('encaissement','virement') AND position_id = ? THEN montant
      WHEN type_op = 'decaissement'               AND position_id = ? THEN -montant
      WHEN type_op = 'virement'    AND position_source_id = ?         THEN -montant
      ELSE 0 END), 0) AS delta
    FROM operations WHERE statut = 'valide'
  `, [positionId, positionId, positionId]);
  return (pos.solde_initial || 0) + (row.delta || 0);
}

async function getSoldePrincipal() {
  const positions = await db.query("SELECT id, code, libelle, type FROM positions WHERE actif = 1 ORDER BY CASE type WHEN 'caisse' THEN 1 ELSE 2 END");
  const withSolde = await Promise.all(positions.map(async p => ({ ...p, solde: await getSoldePosition(p.id) })));
  const caisse = withSolde.find(p => p.code === 'CAISSE') || withSolde.find(p => p.type === 'caisse') || withSolde[0];
  return { positions: withSolde, soldePrincipal: caisse?.solde || 0 };
}

// ─── GET /home — vue agrégée selon le rôle de l'utilisateur ──────────────────
router.get('/home', async (req, res) => {
  const user = req.user;
  const role = user.role;

  try {
    if (hasRole(user, 'dg', 'manager', 'admin', 'delegue')) {
      return res.json({ vue: 'decideur', data: await getDecideurData(user) });
    }
    if (hasRole(user, 'finance')) {
      return res.json({ vue: 'finance', data: await getFinanceData() });
    }
    if (hasRole(user, 'rh')) {
      return res.json({ vue: 'rh', data: await getRhData() });
    }
    // caissier, assistante_direction, lecteur
    return res.json({ vue: 'operationnel', data: await getOperationnelData(user) });
  } catch (e) {
    console.error('[dashboard/home]', e.message);
    res.status(500).json({ error: 'Erreur chargement dashboard' });
  }
});

// ─── GET /solde — solde + seuil d'alerte ─────────────────────────────────────
router.get('/solde', async (req, res) => {
  try {
    const { positions, soldePrincipal } = await getSoldePrincipal();
    const prm = await db.queryOne("SELECT valeur FROM parametres WHERE cle = 'seuil_alerte'");
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
router.get('/flux', async (req, res) => {
  const periode = req.query.periode || 'mois';

  let dateFilter;
  if (periode === 'jour') {
    dateFilter = "DATE(o.date) = CURDATE()";
  } else if (periode === 'semaine') {
    dateFilter = "DATE(o.date) >= DATE(NOW() - INTERVAL 7 DAY)";
  } else {
    dateFilter = "DATE_FORMAT(o.date, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')";
  }

  try {
    const row = await db.queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN o.type_op = 'encaissement' THEN o.montant ELSE 0 END), 0) AS encaissements,
        COALESCE(SUM(CASE WHEN o.type_op = 'decaissement' THEN o.montant ELSE 0 END), 0) AS decaissements,
        COUNT(*) AS nb_ops
      FROM operations o
      WHERE ${dateFilter}
    `);
    res.json({ periode, ...row, solde_net: row.encaissements - row.decaissements });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /actions-en-attente — décaissements à valider (rôle DG/Finance) ──────
router.get('/actions-en-attente', async (req, res) => {
  try {
    const rows = await db.query(`
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
    `);
    res.json({ actions: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /conges-en-attente — congés à valider (rôle RH) ────────────────────
router.get('/conges-en-attente', async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT c.id, c.type_conge, c.date_debut, c.date_fin, c.nb_jours,
        c.statut, c.motif, c.created_at,
        CONCAT(e.nom, ' ', COALESCE(e.prenom, '')) AS employe_nom,
        e.poste, e.departement
      FROM employes_conges c
      JOIN employes e ON e.id = c.employe_id
      WHERE c.statut IN ('demande', 'valide_sup')
      ORDER BY c.created_at ASC
      LIMIT 20
    `);
    res.json({ conges: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /echeances-contrats — fins d'essai et CDD dans 90j ─────────────────
router.get('/echeances-contrats', async (req, res) => {
  try {
    const echeances = [];

    try {
      const essais = await db.query(`
        SELECT id, nom, prenom, poste, departement, date_fin_essai AS date_echeance,
          'fin_essai' AS type_echeance
        FROM employes
        WHERE actif = 1
          AND date_fin_essai IS NOT NULL
          AND DATE(date_fin_essai) BETWEEN CURDATE() AND DATE(NOW() + INTERVAL 90 DAY)
        ORDER BY date_fin_essai ASC
        LIMIT 20
      `);
      echeances.push(...essais);
    } catch (_) { /* colonne peut ne pas exister */ }

    try {
      const cdds = await db.query(`
        SELECT id, nom, prenom, poste, departement, date_fin_contrat AS date_echeance,
          'fin_cdd' AS type_echeance
        FROM employes
        WHERE actif = 1
          AND type_contrat = 'CDD'
          AND date_fin_contrat IS NOT NULL
          AND DATE(date_fin_contrat) BETWEEN CURDATE() AND DATE(NOW() + INTERVAL 90 DAY)
        ORDER BY date_fin_contrat ASC
        LIMIT 20
      `);
      echeances.push(...cdds);
    } catch (_) { /* colonne peut ne pas exister */ }

    echeances.sort((a, b) => new Date(a.date_echeance) - new Date(b.date_echeance));
    res.json({ echeances });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /kpis-rh — effectif, turnover, absentéisme ─────────────────────────
router.get('/kpis-rh', async (req, res) => {
  try {
    const effectif = await db.queryOne(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN actif = 1 THEN 1 ELSE 0 END), 0) AS actifs,
        COALESCE(SUM(CASE WHEN actif != 1 THEN 1 ELSE 0 END), 0) AS inactifs
      FROM employes
    `);

    // Onboardings incomplets (checklist < 100%)
    let onboardingAlerts = 0;
    try {
      const obs = await db.queryOne(`
        SELECT COUNT(*) AS nb FROM onboarding_checklists
        WHERE progression < 100
          AND created_at >= CURDATE() - INTERVAL 90 DAY
      `);
      onboardingAlerts = obs?.nb || 0;
    } catch (_) { /* table peut ne pas exister */ }

    // Entrées/sorties du mois courant (colonnes variables selon migration)
    let mouvement = { entrees_mois: 0, sorties_mois: 0 };
    try {
      let entrees_mois = 0;
      let sorties_mois = 0;
      try {
        const r = await db.queryOne(`SELECT COUNT(*) AS nb FROM employes WHERE DATE_FORMAT(date_embauche,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')`);
        entrees_mois = r?.nb || 0;
      } catch (_) {}
      try {
        const r = await db.queryOne(`SELECT COUNT(*) AS nb FROM employes WHERE date_sortie IS NOT NULL AND DATE_FORMAT(date_sortie,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')`);
        sorties_mois = r?.nb || 0;
      } catch (_) {}
      mouvement = { entrees_mois, sorties_mois };
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
router.get('/periode-paie-courante', async (req, res) => {
  try {
    const now = new Date();
    const mois = now.getMonth() + 1;
    const annee = now.getFullYear();

    const periode = await db.queryOne(`
      SELECT pp.*, COUNT(b.id) AS nb_bulletins,
        COALESCE(SUM(CASE WHEN b.statut = 'paye' THEN 1 ELSE 0 END), 0) AS bulletins_payes
      FROM periodes_paie pp
      LEFT JOIN bulletins_salaire b ON b.periode_id = pp.id
      WHERE pp.mois = ? AND pp.annee = ?
      GROUP BY pp.id
    `, [mois, annee]);

    const actifs = await db.queryOne("SELECT COUNT(*) AS nb FROM employes WHERE actif = 1");
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

async function getDecideurData(user) {
  const prm = await db.queryOne("SELECT valeur FROM parametres WHERE cle = 'seuil_alerte'");
  const seuil = Number(prm?.valeur || 100000);

  const { soldePrincipal: solde } = await getSoldePrincipal();
  const caisse = { solde };

  const todayFlux = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec
    FROM operations WHERE DATE(date)=CURDATE()
  `);

  const moisFlux = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec,
      COUNT(*) AS nb
    FROM operations WHERE DATE_FORMAT(date,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')
  `);

  const actions = await db.query(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.date, o.dec_statut,
      u.nom AS created_by_nom
    FROM operations o
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.type_op='decaissement'
      AND COALESCE(o.dec_statut,'brouillon') IN ('brouillon','soumis')
    ORDER BY o.date DESC LIMIT 5
  `);

  let parapheur_en_attente = 0;
  try {
    const r = await db.queryOne(`SELECT COUNT(*) AS c FROM parapheur WHERE statut = 'transmis_dg'`);
    parapheur_en_attente = r?.c || 0;
  } catch (_) {}

  return {
    solde: caisse?.solde || 0,
    seuil_alerte: seuil,
    alerte: (caisse?.solde || 0) < seuil,
    today: { enc: todayFlux.enc, dec: todayFlux.dec, net: todayFlux.enc - todayFlux.dec },
    mois: { enc: moisFlux.enc, dec: moisFlux.dec, nb: moisFlux.nb, net: moisFlux.enc - moisFlux.dec },
    actions_en_attente: actions,
    parapheur_en_attente,
  };
}

async function getFinanceData() {
  async function flux(filter) {
    return db.queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
        COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec
      FROM operations WHERE ${filter}
    `);
  }

  const jour    = await flux("DATE(date)=CURDATE()");
  const semaine = await flux("DATE(date)>=DATE(NOW() - INTERVAL 6 DAY)");
  const mois    = await flux("DATE_FORMAT(date,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')");

  const pending = await db.query(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.date, o.dec_statut,
      u.nom AS created_by_nom
    FROM operations o
    LEFT JOIN users u ON u.id=o.created_by
    WHERE o.type_op='decaissement'
      AND COALESCE(o.dec_statut,'brouillon') IN ('brouillon','soumis')
    ORDER BY o.date DESC LIMIT 10
  `);

  // Rapprochements en attente : opérations sans rapprochement associé
  let rappro_pending = 0;
  try {
    const r = await db.queryOne(`
      SELECT COUNT(*) AS nb FROM operations
      WHERE rapprochement_id IS NULL
        AND type_op IN ('encaissement','decaissement')
        AND DATE_FORMAT(date,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')
    `);
    rappro_pending = r?.nb || 0;
  } catch (_) { /* colonne peut ne pas exister */ }

  return {
    flux: { jour, semaine, mois },
    decaissements_a_valider: pending,
    rappro_pending,
  };
}

async function getOperationnelData(user) {
  const mesDernieres = await db.query(`
    SELECT o.id, o.num_piece, o.libelle, o.montant, o.type_op, o.date,
      o.dec_statut, c.nom AS categorie_nom
    FROM operations o
    LEFT JOIN categories c ON c.id=o.categorie_id
    WHERE o.created_by=?
    ORDER BY o.created_at DESC LIMIT 10
  `, [user.id]);

  const todayFlux = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END),0) AS enc,
      COALESCE(SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END),0) AS dec,
      COUNT(*) AS nb
    FROM operations WHERE DATE(date)=CURDATE()
  `);

  const prm = await db.queryOne("SELECT valeur FROM parametres WHERE cle='seuil_alerte'");
  const seuil = Number(prm?.valeur || 100000);
  const { soldePrincipal: solde } = await getSoldePrincipal();

  return {
    solde,
    seuil_alerte: seuil,
    alerte: solde < seuil,
    today: { enc: todayFlux.enc, dec: todayFlux.dec, nb: todayFlux.nb, net: todayFlux.enc - todayFlux.dec },
    mes_dernieres: mesDernieres,
  };
}

async function getRhData() {
  const conges = await db.query(`
    SELECT c.id, c.type_conge, c.date_debut, c.date_fin, c.nb_jours, c.statut, c.created_at,
      CONCAT(e.nom, ' ', COALESCE(e.prenom,'')) AS employe_nom, e.poste, e.departement
    FROM employes_conges c
    JOIN employes e ON e.id=c.employe_id
    WHERE c.statut IN ('demande','valide_sup')
    ORDER BY c.created_at ASC LIMIT 10
  `);

  const effectif = await db.queryOne(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN actif=1 THEN 1 ELSE 0 END),0) AS actifs,
      COALESCE(SUM(CASE WHEN actif!=1 THEN 1 ELSE 0 END),0) AS inactifs
    FROM employes
  `);

  // date_embauche est la colonne d'entrée, date_sortie pour les sorties
  let mouvement = { entrees: 0, sorties: 0 };
  try {
    let entrees = 0;
    let sorties = 0;
    try {
      const r = await db.queryOne(`SELECT COUNT(*) AS nb FROM employes WHERE DATE_FORMAT(date_embauche,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')`);
      entrees = r?.nb || 0;
    } catch (_) {}
    try {
      const r = await db.queryOne(`SELECT COUNT(*) AS nb FROM employes WHERE date_sortie IS NOT NULL AND DATE_FORMAT(date_sortie,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')`);
      sorties = r?.nb || 0;
    } catch (_) {}
    mouvement = { entrees, sorties };
  } catch (_) {}

  // Echeances contrats (30j)
  let echeances = [];
  try {
    const essais = await db.query(`
      SELECT id,nom,prenom,poste,date_fin_essai AS date_echeance,'fin_essai' AS type_echeance
      FROM employes WHERE actif=1 AND date_fin_essai IS NOT NULL
        AND DATE(date_fin_essai) BETWEEN CURDATE() AND DATE(NOW() + INTERVAL 30 DAY)
      ORDER BY date_fin_essai LIMIT 10
    `);
    echeances.push(...essais);
  } catch (_) {}
  try {
    const cdds = await db.query(`
      SELECT id,nom,prenom,poste,date_fin_contrat AS date_echeance,'fin_cdd' AS type_echeance
      FROM employes WHERE actif=1 AND type_contrat='CDD' AND date_fin_contrat IS NOT NULL
        AND DATE(date_fin_contrat) BETWEEN CURDATE() AND DATE(NOW() + INTERVAL 30 DAY)
      ORDER BY date_fin_contrat LIMIT 10
    `);
    echeances.push(...cdds);
  } catch (_) {}

  // Période de paie courante
  const now = new Date();
  const periode = await db.queryOne(`
    SELECT pp.mois, pp.annee, pp.statut,
      COUNT(b.id) AS nb_bulletins,
      COALESCE(SUM(CASE WHEN b.statut='paye' THEN 1 ELSE 0 END),0) AS bulletins_payes
    FROM periodes_paie pp
    LEFT JOIN bulletins_salaire b ON b.periode_id=pp.id
    WHERE pp.mois=? AND pp.annee=?
    GROUP BY pp.id
  `, [now.getMonth() + 1, now.getFullYear()]);

  let onboarding_alertes = 0;
  try {
    const obs = await db.queryOne(`SELECT COUNT(*) AS nb FROM onboarding_checklists WHERE progression<100 AND created_at>=CURDATE() - INTERVAL 90 DAY`);
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

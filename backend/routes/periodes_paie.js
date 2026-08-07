/**
 * MODULE PÉRIODES DE PAIE — TOP CENTER
 * Cycle mensuel avec validation DG de la masse salariale globale.
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');
const { can, canSubmitPayrollPeriod, canApprovePayrollPeriod } = require('../services/permissions');

async function canRH(user) {
  return (await can(user, 'salary.generate')) || hasRole(user, 'admin', 'rh', 'finance');
}

async function audit(id, action, details, userId, dbc = db) {
  try {
    await dbc.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['periodes_paie', id, action, details ? JSON.stringify(details) : null, userId || null],
    );
  } catch (_) {}
}

async function getOrCreatePeriode(mois, annee, userId, dbc = db) {
  let periode = await dbc.queryOne('SELECT * FROM periodes_paie WHERE mois = ? AND annee = ?', [mois, annee]);
  if (!periode) {
    const result = await dbc.execute(`
      INSERT INTO periodes_paie (mois, annee, statut, created_at, updated_at)
      VALUES (?, ?, 'ouverte', NOW(), NOW())
    `, [mois, annee]);
    periode = await dbc.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [result.insertId]);
    await audit(periode.id, 'creer', { mois, annee }, userId, dbc);
  }
  return periode;
}

async function computeSynthese(periodeId, mois, annee, dbc = db) {
  const stats = await dbc.queryOne(`
    SELECT
      COUNT(*) AS nb_total,
      SUM(CASE WHEN statut = 'brouillon' THEN 1 ELSE 0 END) AS nb_brouillon,
      SUM(CASE WHEN statut = 'valide' THEN 1 ELSE 0 END) AS nb_valide,
      SUM(CASE WHEN statut = 'paye' THEN 1 ELSE 0 END) AS nb_paye,
      COALESCE(SUM(brut), 0) AS total_brut,
      COALESCE(SUM(net_a_payer), 0) AS total_net,
      COALESCE(SUM(cout_total_employeur - brut), 0) AS total_charges_patronales,
      COALESCE(SUM(retenue_avance), 0) AS total_avances_retenues,
      COALESCE(SUM(autres_primes), 0) AS total_primes
    FROM bulletins_salaire WHERE mois = ? AND annee = ?
  `, [mois, annee]);

  const anomalies = [];
  const netNegatif = Number((await dbc.queryOne(
    'SELECT COUNT(*) AS c FROM bulletins_salaire WHERE mois=? AND annee=? AND net_a_payer < 0',
    [mois, annee],
  ))?.c || 0);
  if (netNegatif > 0) anomalies.push({ type: 'net_negatif', gravite: 'bloquant', count: netNegatif, message: `${netNegatif} bulletin(s) avec net négatif` });

  const agentsSortis = Number((await dbc.queryOne(`
    SELECT COUNT(*) AS c FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    WHERE b.mois=? AND b.annee=? AND b.statut != 'paye' AND e.statut_dossier = 'sorti'
  `, [mois, annee]))?.c || 0);
  if (agentsSortis > 0) anomalies.push({ type: 'agent_sorti_avec_bulletin', gravite: 'bloquant', count: agentsSortis, message: `${agentsSortis} agent(s) sorti(s) avec bulletin actif` });

  const horsGrille = Number((await dbc.queryOne(`
    SELECT COUNT(*) AS c FROM bulletins_salaire b
    JOIN employes e ON e.id = b.employe_id
    JOIN grille_echelons ge ON ge.id = e.grille_echelon_id
    WHERE b.mois=? AND b.annee=? AND ge.salaire_max IS NOT NULL AND b.salaire_base > ge.salaire_max
  `, [mois, annee]))?.c || 0);
  if (horsGrille > 0) anomalies.push({ type: 'hors_borne_grille', gravite: 'avertissement', count: horsGrille, message: `${horsGrille} bulletin(s) avec salaire hors borne d'échelon` });

  const segregation = Number((await dbc.queryOne(`
    SELECT COUNT(*) AS c FROM bulletins_salaire
    WHERE mois=? AND annee=? AND statut='valide'
      AND generated_by IS NOT NULL AND validated_by IS NOT NULL AND generated_by = validated_by
  `, [mois, annee]))?.c || 0);
  if (segregation > 0) anomalies.push({ type: 'segregation_taches', gravite: 'avertissement', count: segregation, message: `${segregation} bulletin(s) validé(s) par leur créateur` });

  const monthDate = `${annee}-${String(mois).padStart(2, '0')}-01`;
  const salaireModifie = Number((await dbc.queryOne(`
    SELECT COUNT(DISTINCT employe_id) AS c FROM historique_salaires
    WHERE DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(?, '%Y-%m')
  `, [monthDate]))?.c || 0);
  if (salaireModifie > 0) anomalies.push({ type: 'salaire_modifie_ce_mois', gravite: 'info', count: salaireModifie, message: `${salaireModifie} agent(s) avec salaire modifié ce mois` });

  const monthKey = `${annee}-${String(mois).padStart(2, '0')}`;
  const entrants = Number((await dbc.queryOne(
    "SELECT COUNT(*) AS c FROM employes WHERE DATE_FORMAT(date_embauche, '%Y-%m') = ?",
    [monthKey],
  ))?.c || 0);
  const sortants = Number((await dbc.queryOne(
    "SELECT COUNT(*) AS c FROM employes WHERE DATE_FORMAT(date_sortie, '%Y-%m') = ?",
    [monthKey],
  ))?.c || 0);

  return { ...(stats || {}), anomalies, entrants, sortants, periode_id: Number(periodeId) };
}

async function updatePeriodeStats(mois, annee, dbc = db) {
  const stats = await dbc.queryOne(`
    SELECT COUNT(*) AS ng,
           SUM(CASE WHEN statut='valide' THEN 1 ELSE 0 END) AS nv,
           SUM(CASE WHEN statut='paye' THEN 1 ELSE 0 END) AS np,
           COALESCE(SUM(brut),0) AS tb,
           COALESCE(SUM(net_a_payer),0) AS tn,
           COALESCE(SUM(cout_total_employeur-brut),0) AS tc
    FROM bulletins_salaire WHERE mois=? AND annee=?
  `, [mois, annee]);
  await dbc.execute(`
    UPDATE periodes_paie SET
      nb_bulletins_generes=?, nb_bulletins_valides=?, nb_bulletins_payes=?,
      total_brut=?, total_net=?, total_charges=?, updated_at=NOW()
    WHERE mois=? AND annee=?
  `, [stats?.ng || 0, stats?.nv || 0, stats?.np || 0, stats?.tb || 0, stats?.tn || 0, stats?.tc || 0, mois, annee]);
}

router.post('/periodes', async (req, res, next) => {
  try {
    if (!(await canRH(req.user))) return res.status(403).json({ error: 'Accès refusé' });
    const { mois, annee, force } = req.body;
    if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });
    const m = Number(mois);
    const y = Number(annee);
    const existing = await db.queryOne('SELECT id FROM periodes_paie WHERE mois = ? AND annee = ?', [m, y]);
    if (!existing) {
      const prevMois = m === 1 ? 12 : m - 1;
      const prevAnnee = m === 1 ? y - 1 : y;
      const previous = await db.queryOne('SELECT mois, annee, statut FROM periodes_paie WHERE mois = ? AND annee = ?', [prevMois, prevAnnee]);
      if (previous && previous.statut !== 'cloturee' && (!force || !hasRole(req.user, 'admin', 'dg'))) {
        return res.status(409).json({
          error: `La période ${String(prevMois).padStart(2, '0')}/${prevAnnee} n'est pas clôturée (statut: ${previous.statut}). Clôturez-la avant d'ouvrir le mois suivant.`,
          periode_precedente: previous,
          peut_forcer: hasRole(req.user, 'admin', 'dg'),
        });
      }
    }
    const periode = await getOrCreatePeriode(m, y, req.user.id);
    res.status(existing ? 200 : 201).json(periode);
  } catch (error) { next(error); }
});

router.get('/periodes', async (_req, res, next) => {
  try {
    res.json(await db.query('SELECT * FROM periodes_paie ORDER BY annee DESC, mois DESC LIMIT 24'));
  } catch (error) { next(error); }
});

router.get('/periodes/:id', async (req, res, next) => {
  try {
    const periode = await db.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [req.params.id]);
    if (!periode) return res.status(404).json({ error: 'Période introuvable' });
    const [synthese, valideurDG, valideurSubmit] = await Promise.all([
      computeSynthese(periode.id, periode.mois, periode.annee),
      periode.valide_dg_by ? db.queryOne('SELECT nom FROM users WHERE id=?', [periode.valide_dg_by]) : null,
      periode.soumis_dg_by ? db.queryOne('SELECT nom FROM users WHERE id=?', [periode.soumis_dg_by]) : null,
    ]);
    res.json({ ...periode, synthese, valide_dg_nom: valideurDG?.nom || null, soumis_dg_nom: valideurSubmit?.nom || null });
  } catch (error) { next(error); }
});

router.post('/periodes/:id/soumettre-dg', async (req, res, next) => {
  try {
    if (!(await canSubmitPayrollPeriod(req.user))) return res.status(403).json({ error: 'Permission salary.submit_to_dg requise' });
    const periode = await db.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [req.params.id]);
    if (!periode) return res.status(404).json({ error: 'Période introuvable' });
    if (!['ouverte', 'preparation', 'controle_rh', 'controle_finance'].includes(periode.statut)) return res.status(400).json({ error: `Statut "${periode.statut}" — soumission au DG impossible` });

    const synthese = await computeSynthese(periode.id, periode.mois, periode.annee);
    const bloquants = synthese.anomalies.filter(anomalie => anomalie.gravite === 'bloquant');
    if (bloquants.length) return res.status(400).json({ error: 'Des anomalies bloquantes empêchent la soumission au DG', anomalies: bloquants });

    await updatePeriodeStats(periode.mois, periode.annee);
    if (await canApprovePayrollPeriod(req.user)) {
      await db.execute(`
        UPDATE periodes_paie SET statut='validee_dg', soumis_dg_by=?, soumis_dg_at=NOW(),
          valide_dg_by=?, valide_dg_at=NOW(), updated_at=NOW() WHERE id=?
      `, [req.user.id, req.user.id, periode.id]);
      await audit(periode.id, 'soumettre_auto_valider_dg', { mois: periode.mois, annee: periode.annee }, req.user.id);
      return res.json({ ok: true, statut: 'validee_dg', auto_approved: true, synthese });
    }

    await db.execute(`
      UPDATE periodes_paie SET statut='soumis_dg', soumis_dg_by=?, soumis_dg_at=NOW(), updated_at=NOW() WHERE id=?
    `, [req.user.id, periode.id]);
    await audit(periode.id, 'soumettre_dg', { mois: periode.mois, annee: periode.annee }, req.user.id);

    try {
      const dgs = await db.query("SELECT id FROM users WHERE actif=1 AND (role='dg' OR role='admin' OR roles LIKE '%\"dg\"%')");
      for (const user of dgs) {
        await Promise.resolve(creerNotification({
          type: 'NOTIF_PERIODE_PAIE',
          titre: `Masse salariale ${periode.mois}/${periode.annee} soumise`,
          message: `La masse salariale de ${periode.mois}/${periode.annee} est soumise pour validation (total net : ${new Intl.NumberFormat('fr-FR').format(synthese.total_net)} XAF).`,
          srcTable: 'periodes_paie', srcId: periode.id, destinataire_id: user.id,
        }));
      }
    } catch (_) {}

    res.json({ ok: true, statut: 'soumis_dg', synthese });
  } catch (error) { next(error); }
});

router.post('/periodes/:id/valider-dg', async (req, res, next) => {
  try {
    if (!(await canApprovePayrollPeriod(req.user))) return res.status(403).json({ error: 'Permission salary.approve_period_dg requise' });
    const periode = await db.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [req.params.id]);
    if (!periode) return res.status(404).json({ error: 'Période introuvable' });
    if (periode.statut !== 'soumis_dg') return res.status(400).json({ error: `Statut "${periode.statut}" — validation DG impossible` });
    const { notes } = req.body;
    await updatePeriodeStats(periode.mois, periode.annee);
    await db.execute(`
      UPDATE periodes_paie SET statut='validee_dg', valide_dg_by=?, valide_dg_at=NOW(), notes=?, updated_at=NOW() WHERE id=?
    `, [req.user.id, notes || null, periode.id]);
    await audit(periode.id, 'valider_dg', { notes }, req.user.id);
    res.json({ ok: true, statut: 'validee_dg' });
  } catch (error) { next(error); }
});

router.post('/periodes/:id/cloturer', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis pour clôturer' });
    const periode = await db.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [req.params.id]);
    if (!periode) return res.status(404).json({ error: 'Période introuvable' });
    if (!['payee', 'paiement_en_cours', 'payee_partielle', 'validee_dg'].includes(periode.statut)) return res.status(400).json({ error: `Statut "${periode.statut}" — clôture impossible` });
    const nbNonPayes = Number((await db.queryOne(
      "SELECT COUNT(*) AS c FROM bulletins_salaire WHERE mois=? AND annee=? AND statut != 'paye'",
      [periode.mois, periode.annee],
    ))?.c || 0);
    if (nbNonPayes > 0) return res.status(400).json({ error: `${nbNonPayes} bulletin(s) non encore payé(s) — réglez-les avant de clôturer` });
    await db.execute("UPDATE periodes_paie SET statut='cloturee', cloture_by=?, cloture_at=NOW(), updated_at=NOW() WHERE id=?", [req.user.id, periode.id]);
    await audit(periode.id, 'cloturer', null, req.user.id);
    res.json({ ok: true, statut: 'cloturee' });
  } catch (error) { next(error); }
});

router.post('/periodes/:id/rouvrir-exception', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
    const periode = await db.queryOne('SELECT * FROM periodes_paie WHERE id = ?', [req.params.id]);
    if (!periode) return res.status(404).json({ error: 'Période introuvable' });
    if (periode.statut !== 'cloturee') return res.status(400).json({ error: 'Seule une période clôturée peut être réouverte' });
    const { motif } = req.body;
    if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif obligatoire pour réouverture exceptionnelle' });
    const normalizedMotif = String(motif).trim();
    await db.transaction(async tx => {
      await tx.execute("UPDATE periodes_paie SET statut='rouverte_exception', notes=?, updated_at=NOW() WHERE id=?", [normalizedMotif, periode.id]);
      await audit(periode.id, 'rouvrir_exception', { motif: normalizedMotif }, req.user.id, tx);
      await tx.execute(
        'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
        ['periodes_paie', periode.id, 'ALERTE_SECURITE_REOUVERTURE', JSON.stringify({ motif: normalizedMotif, mois: periode.mois, annee: periode.annee }), req.user.id],
      );
    });
    res.json({ ok: true, statut: 'rouverte_exception' });
  } catch (error) { next(error); }
});

module.exports = { router, getOrCreatePeriode, updatePeriodeStats, computeSynthese };

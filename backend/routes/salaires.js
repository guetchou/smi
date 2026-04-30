/**
 * MODULE SALAIRES — TOP CENTER
 * Calcul OHADA / Congo-Brazzaville
 * CNSS, CAMU, IRPP progressif, bulletin de paie complet
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();

// Importé après le premier require pour éviter la dépendance circulaire
// (operations.js charge aussi database.js — pas de problème, Node met en cache)
let recalculateSoldes;
setImmediate(() => {
  ({ recalculateSoldes } = require('./operations'));
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTaux() {
  const rows = db.prepare('SELECT cle, valeur FROM parametres').all();
  const p    = {};
  rows.forEach(r => { p[r.cle] = parseFloat(r.valeur) || 0; });
  return {
    cnss_employe : p.cnss_employe_taux  || 4.725,
    cnss_patron  : p.cnss_patron_taux   || 20,
    camu_employe : p.camu_employe_taux  || 2.25,
    camu_patron  : p.camu_patron_taux   || 5,
    irpp: {
      plafond_t1 : p.irpp_plafond_t1 || 464000,
      taux_t2    : p.irpp_taux_t2    || 10,
      plafond_t2 : p.irpp_plafond_t2 || 1000000,
      taux_t3    : p.irpp_taux_t3    || 25,
      plafond_t3 : p.irpp_plafond_t3 || 3000000,
      taux_t4    : p.irpp_taux_t4    || 40,
    },
  };
}

function getDevise() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get();
  return r ? r.valeur : 'XAF';
}

function getSociete() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='societe'").get();
  return r ? r.valeur : 'TOP CENTER';
}

/**
 * Retourne les rubriques paie custom configurées dans les paramètres.
 * Format JSON : [{ nom, type:'prime'|'retenue', calcul:'fixe'|'pct_brut', valeur }]
 */
function getRubriquesPaieCustom() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='rubriques_custom'").get();
  if (!r || !r.valeur) return [];
  try { return JSON.parse(r.valeur); } catch { return []; }
}

/**
 * Calcule toutes les rubriques d'un bulletin à partir du brut et des taux.
 */
function calculer(base, primes, taux, rubriquesCustom = []) {
  const { prime_transport = 0, prime_logement = 0, autres_primes = 0 } = primes;

  // Rubriques custom : primes additionnelles
  let extra_primes   = 0;
  let extra_retenues = 0;
  const lignes_custom = [];
  for (const r of rubriquesCustom) {
    const montant = r.calcul === 'pct_brut'
      ? Math.round((base + prime_transport + prime_logement + autres_primes) * (parseFloat(r.valeur) || 0) / 100)
      : Math.round(parseFloat(r.valeur) || 0);
    lignes_custom.push({ nom: r.nom, type: r.type, montant });
    if (r.type === 'prime')   extra_primes   += montant;
    else                       extra_retenues += montant;
  }

  const brut = base + prime_transport + prime_logement + autres_primes + extra_primes;

  // Cotisations salariales
  const cnss_employe = Math.round(brut * taux.cnss_employe / 100);
  const camu_employe = Math.round(brut * taux.camu_employe / 100);

  // Net imposable = brut – cotisations sociales salariales
  const net_imposable = brut - cnss_employe - camu_employe;

  // IRPP — barème progressif mensuel Congo-Brazzaville
  const tranches = [
    { seuil: 0,                   plafond: taux.irpp.plafond_t1, taux: 0 },
    { seuil: taux.irpp.plafond_t1, plafond: taux.irpp.plafond_t2, taux: taux.irpp.taux_t2 / 100 },
    { seuil: taux.irpp.plafond_t2, plafond: taux.irpp.plafond_t3, taux: taux.irpp.taux_t3 / 100 },
    { seuil: taux.irpp.plafond_t3, plafond: Infinity,             taux: taux.irpp.taux_t4 / 100 },
  ];
  let irpp = 0;
  for (const t of tranches) {
    if (net_imposable <= t.seuil) break;
    const base_tranche = Math.min(net_imposable, t.plafond) - t.seuil;
    irpp += base_tranche * t.taux;
  }
  irpp = Math.round(irpp);

  const total_retenues       = cnss_employe + camu_employe + irpp + extra_retenues;
  const net_a_payer          = brut - total_retenues;

  // Charges patronales
  const cnss_patronal        = Math.round(brut * taux.cnss_patron / 100);
  const camu_patronal        = Math.round(brut * taux.camu_patron / 100);
  const cout_total_employeur = brut + cnss_patronal + camu_patronal;

  return {
    brut, cnss_employe, camu_employe, irpp,
    total_retenues, net_imposable, net_a_payer,
    cnss_patronal, camu_patronal, cout_total_employeur,
    lignes_custom,
    extra_primes, extra_retenues,
  };
}

// ─── Rapport mensuel ─────────────────────────────────────────────────────────

router.get('/rapport', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const employes  = db.prepare("SELECT * FROM employes WHERE actif = 1 AND statut_dossier = 'actif' ORDER BY type, nom").all();
  const bulletins = db.prepare(
    'SELECT * FROM bulletins_salaire WHERE mois = ? AND annee = ?'
  ).all(mois, annee);
  const bulMap = {};
  bulletins.forEach(b => { bulMap[b.employe_id] = b; });

  // Paiements réalisés via opérations caisse (pour les bulletins en statut paye)
  const debut = `${annee}-${String(mois).padStart(2,'0')}-01`;
  const fin   = `${annee}-${String(mois).padStart(2,'0')}-31`;
  const paiements = db.prepare(`
    SELECT employe_id, SUM(montant) as paye
    FROM operations
    WHERE date BETWEEN ? AND ?
      AND statut != 'annule'
      AND employe_id IS NOT NULL
      AND type_op = 'decaissement'
    GROUP BY employe_id
  `).all(debut, fin);
  const payMap = {};
  paiements.forEach(p => { payMap[p.employe_id] = p.paye || 0; });

  const liste = employes.map(e => ({
    ...e,
    bulletin : bulMap[e.id] || null,
    paye     : payMap[e.id] || 0,
  }));

  const totaux = {
    brut    : liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.brut        : e.salaire_base), 0),
    net     : liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.net_a_payer : e.salaire_base), 0),
    paye    : liste.reduce((s, e) => s + e.paye, 0),
    restant : 0,
    patronal: liste.reduce((s, e) => s + (e.bulletin ? e.bulletin.cnss_patronal + e.bulletin.camu_patronal : 0), 0),
  };
  totaux.restant = totaux.net - totaux.paye;

  res.json({ mois, annee, employes: liste, totaux });
});

// ─── Générer bulletins du mois ────────────────────────────────────────────────

router.post('/generer', (req, res) => {
  const { mois, annee, employe_id } = req.body;
  if (!mois || !annee) return res.status(400).json({ error: 'mois et annee requis' });

  const taux  = getTaux();
  const where = employe_id
    ? "WHERE actif = 1 AND statut_dossier = 'actif' AND id = ?"
    : "WHERE actif = 1 AND statut_dossier = 'actif'";
  const employes = employe_id
    ? db.prepare(`SELECT * FROM employes ${where}`).all(employe_id)
    : db.prepare(`SELECT * FROM employes ${where} ORDER BY type, nom`).all();

  const upsert = db.prepare(`
    INSERT INTO bulletins_salaire
      (employe_id, mois, annee, salaire_base, prime_transport, prime_logement, autres_primes,
       brut, cnss_employe, camu_employe, irpp, total_retenues, net_imposable, net_a_payer,
       cnss_patronal, camu_patronal, cout_total_employeur, statut, created_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'brouillon',?,datetime('now'))
    ON CONFLICT(employe_id, mois, annee) DO UPDATE SET
      salaire_base=excluded.salaire_base,
      prime_transport=excluded.prime_transport,
      prime_logement=excluded.prime_logement,
      autres_primes=excluded.autres_primes,
      brut=excluded.brut,
      cnss_employe=excluded.cnss_employe,
      camu_employe=excluded.camu_employe,
      irpp=excluded.irpp,
      total_retenues=excluded.total_retenues,
      net_imposable=excluded.net_imposable,
      net_a_payer=excluded.net_a_payer,
      cnss_patronal=excluded.cnss_patronal,
      camu_patronal=excluded.camu_patronal,
      cout_total_employeur=excluded.cout_total_employeur,
      updated_at=datetime('now')
    WHERE bulletins_salaire.statut = 'brouillon'
  `);

  const rubriquesCustom = getRubriquesPaieCustom();
  const tx = db.transaction(() => {
    for (const e of employes) {
      const primes = { prime_transport: 0, prime_logement: 0, autres_primes: 0 };
      const calc   = calculer(e.salaire_base, primes, taux, rubriquesCustom);
      upsert.run(
        e.id, mois, annee,
        e.salaire_base, 0, 0, 0,
        calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
        calc.total_retenues, calc.net_imposable, calc.net_a_payer,
        calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
        req.user.id
      );
    }
  });
  tx();

  res.json({ ok: true, count: employes.length, mois, annee });
});

// ─── Détail d'un bulletin ─────────────────────────────────────────────────────

router.get('/bulletin/:id', (req, res) => {
  const bulletin = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bulletin) return res.status(404).json({ error: 'Bulletin introuvable' });

  const employe = db.prepare('SELECT * FROM employes WHERE id = ?').get(bulletin.employe_id);

  // Référence décaissement (numéro de pièce de l'opération liée)
  let reference_decaissement = null;
  if (bulletin.operation_id) {
    const op = db.prepare('SELECT num_piece FROM operations WHERE id = ?').get(bulletin.operation_id);
    reference_decaissement = op?.num_piece || `OP-${bulletin.operation_id}`;
  }

  // Avances en cours de cet employé (pour proposer une retenue)
  const avances_actives = db.prepare(
    "SELECT id, date, montant, solde_restant, motif FROM employes_avances WHERE employe_id = ? AND statut = 'en_cours' ORDER BY date"
  ).all(bulletin.employe_id);

  res.json({
    bulletin: { ...bulletin, reference_decaissement },
    employe,
    avances_actives,
    devise: getDevise(),
    societe: getSociete(),
    taux: getTaux()
  });
});

// ─── Helper audit ─────────────────────────────────────────────────────────────
function auditBulletin(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('bulletins_salaire', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

// ─── Modifier les primes d'un bulletin ───────────────────────────────────────

router.put('/bulletin/:id', (req, res) => {
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'valide') return res.status(400).json({ error: 'Bulletin validé — annulez-le d\'abord pour le modifier' });
  if (bul.statut === 'paye')   return res.status(400).json({ error: 'Bulletin payé, modification impossible' });

  const {
    prime_transport = bul.prime_transport,
    prime_logement  = bul.prime_logement,
    autres_primes   = bul.autres_primes,
    notes           = bul.notes,
    retenue_avance  = bul.retenue_avance || 0,
    avance_id       = bul.avance_id || null,
  } = req.body;

  const taux    = getTaux();
  const rubriquesCustom = getRubriquesPaieCustom();
  const employe = db.prepare('SELECT salaire_base FROM employes WHERE id = ?').get(bul.employe_id);
  const primes  = { prime_transport, prime_logement, autres_primes };
  const calc    = calculer(employe.salaire_base, primes, taux, rubriquesCustom);
  const net_a_verser = calc.net_a_payer - Math.max(0, retenue_avance);

  db.prepare(`
    UPDATE bulletins_salaire SET
      prime_transport=?, prime_logement=?, autres_primes=?,
      brut=?, cnss_employe=?, camu_employe=?, irpp=?,
      total_retenues=?, net_imposable=?, net_a_payer=?,
      cnss_patronal=?, camu_patronal=?, cout_total_employeur=?,
      notes=?, retenue_avance=?, avance_id=?, net_a_verser=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    prime_transport, prime_logement, autres_primes,
    calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
    calc.total_retenues, calc.net_imposable, calc.net_a_payer,
    calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
    notes, retenue_avance, avance_id, net_a_verser,
    req.params.id
  );

  res.json({ ok: true, ...calc, net_a_verser });
});

// ─── Attacher une retenue avance à un bulletin ────────────────────────────────

router.post('/bulletin/:id/retenue-avance', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: 'Seul un bulletin brouillon peut être modifié' });

  const { avance_id, montant } = req.body;
  if (!avance_id || !montant || montant <= 0)
    return res.status(400).json({ error: 'avance_id et montant positif requis' });

  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?')
    .get(avance_id, bul.employe_id);
  if (!avance) return res.status(404).json({ error: 'Avance non trouvée pour cet employé' });
  if (avance.statut !== 'en_cours') return res.status(400).json({ error: 'Avance non active' });
  if (montant > avance.solde_restant)
    return res.status(400).json({ error: `Montant dépasse le solde restant (${avance.solde_restant} XAF)` });

  const net_a_verser = bul.net_a_payer - montant;
  db.prepare('UPDATE bulletins_salaire SET retenue_avance=?, avance_id=?, net_a_verser=?, updated_at=datetime("now") WHERE id=?')
    .run(montant, avance_id, net_a_verser, bul.id);
  auditBulletin(bul.id, 'retenue_avance', { avance_id, montant, net_a_verser }, req.user.id);
  res.json({ ok: true, retenue_avance: montant, net_a_verser });
});

// ─── Supprimer la retenue avance d'un bulletin ────────────────────────────────

router.delete('/bulletin/:id/retenue-avance', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: 'Seul un bulletin brouillon peut être modifié' });
  db.prepare('UPDATE bulletins_salaire SET retenue_avance=0, avance_id=NULL, net_a_verser=net_a_payer, updated_at=datetime("now") WHERE id=?')
    .run(bul.id);
  res.json({ ok: true });
});

// ─── Payer un bulletin ────────────────────────────────────────────────────────

router.post('/bulletin/:id/payer', (req, res) => {
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'paye')      return res.status(400).json({ error: 'Bulletin déjà payé' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Validez le bulletin avant de procéder au paiement' });
  if (bul.statut !== 'valide')    return res.status(400).json({ error: `Statut "${bul.statut}" — seul un bulletin validé peut être payé` });

  const emp = db.prepare('SELECT * FROM employes WHERE id = ?').get(bul.employe_id);
  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

  // Position de paiement (caisse principale par défaut)
  const position = db.prepare("SELECT id FROM positions WHERE actif=1 ORDER BY ordre LIMIT 1").get();
  const posId    = req.body.position_id || position?.id || 1;

  // Catégorie salaire
  const salCat = db.prepare(
    "SELECT id FROM categories WHERE type='depense' AND lower(nom) LIKE '%salaire%' LIMIT 1"
  ).get();

  // categorie_id : obligatoire dans le journal OHADA
  if (!salCat) return res.status(400).json({
    error: "Aucune catégorie de dépense 'Salaires' trouvée. Créez-en une dans Paramètres → Rubriques."
  });

  const dateOp = `${bul.annee}-${String(bul.mois).padStart(2,'0')}-${new Date().getDate().toString().padStart(2,'0')}`;

  // Montant décaissé = net_a_verser si retenue avance, sinon net_a_payer
  const montantDecaisse = (bul.retenue_avance > 0 && bul.net_a_verser > 0)
    ? bul.net_a_verser
    : bul.net_a_payer;

  const tx = db.transaction(() => {
    // Insérer le décaissement — solde_position sera recalculé proprement ensuite
    const libelle = `Salaire ${emp.nom} ${emp.prenom} — ${nomsMois[bul.mois]} ${bul.annee}`;
    const opResult = db.prepare(`
      INSERT INTO operations
        (date, libelle, tiers, montant, type_op, position_id,
         categorie_id, mode_reglement, decharge_signee, employe_id, statut, created_by)
      VALUES (?,?,?,?,'decaissement',?,?,'especes',1,?,'valide',?)
    `).run(
      dateOp,
      libelle,
      `${emp.nom} ${emp.prenom}`,
      montantDecaisse,
      posId,
      salCat.id,
      emp.id,
      req.user.id
    );

    db.prepare(
      "UPDATE bulletins_salaire SET statut='paye', operation_id=?, updated_at=datetime('now') WHERE id=?"
    ).run(opResult.lastInsertRowid, bul.id);

    // Si retenue avance : enregistrer le remboursement partiel sur l'avance
    if (bul.avance_id && bul.retenue_avance > 0) {
      const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ?').get(bul.avance_id);
      if (avance && avance.statut === 'en_cours') {
        const nouveau_solde  = Math.max(0, (avance.solde_restant || 0) - bul.retenue_avance);
        const nouveau_statut = nouveau_solde <= 0 ? 'rembourse' : 'en_cours';
        db.prepare('INSERT INTO employes_avances_remboursements (avance_id,date,montant,notes,created_by) VALUES (?,?,?,?,?)')
          .run(avance.id, dateOp, bul.retenue_avance, `Retenue bulletin ${nomsMois[bul.mois]} ${bul.annee}`, req.user.id);
        db.prepare('UPDATE employes_avances SET solde_restant=?, montant_rembourse=COALESCE(montant_rembourse,0)+?, statut=?, updated_at=datetime("now") WHERE id=?')
          .run(nouveau_solde, bul.retenue_avance, nouveau_statut, avance.id);
      }
    }
  });
  tx();

  // Recalcul propre des soldes — identique à operations.js POST /
  if (recalculateSoldes) recalculateSoldes();

  auditBulletin(bul.id, 'paye', { mois: bul.mois, annee: bul.annee, net_a_payer: bul.net_a_payer, montant_decaisse: montantDecaisse, retenue_avance: bul.retenue_avance || 0, position_id: posId }, req.user.id);
  res.json({ ok: true, net_a_payer: bul.net_a_payer, net_a_verser: montantDecaisse });
});

// ─── Valider un bulletin (brouillon → validé) ─────────────────────────────────

router.put('/bulletin/:id/valider', (req, res) => {
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut !== 'brouillon') return res.status(400).json({ error: `Bulletin en statut "${bul.statut}", impossible à valider` });
  db.prepare("UPDATE bulletins_salaire SET statut='valide', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  auditBulletin(req.params.id, 'valide', { mois: bul.mois, annee: bul.annee, net_a_payer: bul.net_a_payer }, req.user.id);
  res.json({ ok: true });
});

// ─── Annuler un bulletin validé (valide → brouillon) ─────────────────────────

router.put('/bulletin/:id/annuler', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const bul = db.prepare('SELECT * FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'paye') return res.status(400).json({ error: 'Bulletin déjà payé — annulation impossible' });
  if (bul.statut === 'brouillon') return res.status(400).json({ error: 'Bulletin déjà en brouillon' });
  const { motif = '' } = req.body;
  db.prepare("UPDATE bulletins_salaire SET statut='brouillon', annule_at=datetime('now'), annule_by=?, annule_motif=?, updated_at=datetime('now') WHERE id=?")
    .run(req.user.id, motif, req.params.id);
  auditBulletin(req.params.id, 'annule', { motif, ancien_statut: bul.statut }, req.user.id);
  res.json({ ok: true });
});

// ─── Taux en vigueur (pour affichage dans les paramètres) ────────────────────

router.get('/taux', (req, res) => {
  res.json(getTaux());
});

// ─── Note de virement bancaire ────────────────────────────────────────────────

router.get('/note-banque', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.poste, e.type, e.banque, e.numero_compte, e.mode_paiement
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.banque, e.nom
  `).all(mois, annee);

  const virements = rows.filter(r => r.mode_paiement === 'virement_bancaire');
  const total = virements.reduce((s, r) => s + (r.net_a_payer || 0), 0);

  res.json({ mois, annee, societe: getSociete(), devise: getDevise(), virements, total });
});

// ─── Export CSV masse salariale ───────────────────────────────────────────────

router.get('/export-csv', (req, res) => {
  const mois  = Number(req.query.mois)  || new Date().getMonth() + 1;
  const annee = Number(req.query.annee) || new Date().getFullYear();

  const rows = db.prepare(`
    SELECT b.*, e.nom, e.prenom, e.poste, e.type, e.mode_paiement, e.banque, e.numero_compte
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.mois = ? AND b.annee = ?
    ORDER BY e.type, e.nom
  `).all(mois, annee);

  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin',
                    'Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const BOM = '\uFEFF';
  const headers = [
    'Nom','Prénom','Poste','Type contrat',
    'Salaire base','Total primes','Brut',
    'CNSS salarié','CAMU salarié','IRPP','Total retenues',
    'Net à payer',
    'CNSS patronal','CAMU patronal','Coût total employeur',
    'Mode paiement','Banque','N° Compte','Statut'
  ];
  const sep = ';';
  const csvRows = rows.map(r => [
    r.nom, r.prenom, r.poste || '', r.type,
    r.salaire_base,
    (r.prime_transport || 0) + (r.prime_logement || 0) + (r.autres_primes || 0),
    r.brut, r.cnss_employe, r.camu_employe, r.irpp, r.total_retenues, r.net_a_payer,
    r.cnss_patronal, r.camu_patronal, r.cout_total_employeur,
    r.mode_paiement || 'especes', r.banque || '', r.numero_compte || '', r.statut
  ].join(sep));

  const content = BOM + [headers.join(sep), ...csvRows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="salaires-${nomsMois[mois]}-${annee}.csv"`);
  res.send(content);
});

// ─── Supprimer/réinitialiser un bulletin brouillon ────────────────────────────

router.delete('/bulletin/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const bul = db.prepare('SELECT statut FROM bulletins_salaire WHERE id = ?').get(req.params.id);
  if (!bul) return res.status(404).json({ error: 'Bulletin introuvable' });
  if (bul.statut === 'valide') return res.status(400).json({ error: 'Bulletin validé — annulez-le d\'abord via "Annuler la validation"' });
  if (bul.statut === 'paye')   return res.status(400).json({ error: 'Impossible de supprimer un bulletin payé' });
  db.prepare('DELETE FROM bulletins_salaire WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

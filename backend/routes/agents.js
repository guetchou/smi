/**
 * MODULE AGENTS / EMPLOYÉS — TOP CENTER
 * Dossier RH complet : identité, contrat, paie, famille, documents
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { creerNotification, declencherAlerte, resoudreAlerte } = require('../services/notif');
const { generatePdf } = require('../services/pdf');
const { sendCongeNotification } = require('../services/email');
const onboardingSvc    = require('../services/onboarding');
const { creerEntreeParapheur } = require('../services/parapheur');
const userProvSvc      = require('../services/user_provisioning');
const { can }          = require('../services/permissions');
// Chargement différé pour éviter la dépendance circulaire (organigramme → agents → organigramme)
function getOrgHelpers() {
  return require('./organigramme');
}

// Rôles autorisés pour la gestion RH (agents, avances, congés).
// Le DG est l'ordonnateur principal et peut approuver ou déléguer.
const RH_ROLES = ['admin', 'dg', 'rh'];

function canRH(user) {
  return hasRole(user, ...RH_ROLES);
}

async function canAgentPermission(user, permission) {
  return can(user, permission);
}

function requireAgentPermission(permission, error) {
  return async (req, res, next) => {
    try {
      if (!await canAgentPermission(req.user, permission)) {
        return res.status(403).json({ error });
      }
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}

// ─── Multer : stockage photos agents ─────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `agent_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Image uniquement'));
    cb(null, true);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgeRetraite() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='age_retraite'").get();
  return r ? parseInt(r.valeur) : 60;
}

function calcAge(dateNaissance) {
  if (!dateNaissance) return null;
  const today = new Date();
  const dob   = new Date(dateNaissance);
  if (isNaN(dob)) return null;
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function calcAnciennete(dateEmbauche) {
  if (!dateEmbauche) return null;
  const today = new Date();
  const deb   = new Date(dateEmbauche);
  if (isNaN(deb)) return null;
  const diffMs   = today - deb;
  const diffJours = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const annees   = Math.floor(diffJours / 365);
  const moisRest = Math.floor((diffJours % 365) / 30);
  return { annees, mois: moisRest, jours: diffJours };
}

function calcRetraite(dateNaissance, ageRetraite) {
  if (!dateNaissance) return null;
  const dob = new Date(dateNaissance);
  if (isNaN(dob)) return null;
  const retraite = new Date(dob);
  retraite.setFullYear(dob.getFullYear() + ageRetraite);
  return retraite.toISOString().slice(0, 10);
}

function enrichAgent(e) {
  const age          = calcAge(e.date_naissance);
  const anciennete   = calcAnciennete(e.date_embauche);
  const ageRetraite  = getAgeRetraite();
  const dateRetraite = calcRetraite(e.date_naissance, ageRetraite);
  const today        = new Date().toISOString().slice(0, 10);
  const anneesRetraite = dateRetraite ? Math.floor((new Date(dateRetraite) - new Date()) / (1000 * 60 * 60 * 24 * 365)) : null;
  const userAccount = db.prepare('SELECT id, email, role, actif FROM users WHERE employe_id = ? AND actif = 1 ORDER BY id LIMIT 1').get(e.id) || null;

  return {
    ...e,
    user_account: userAccount,
    has_user_account: !!userAccount,
    age,
    anciennete,
    date_retraite_previsionnelle: dateRetraite,
    annees_avant_retraite: anneesRetraite,
    alerte_retraite: anneesRetraite !== null && anneesRetraite <= 5,
    alerte_contrat_expire: e.date_fin_contrat && e.date_fin_contrat <= today,
    alerte_essai_fin: e.date_fin_essai && e.date_fin_essai <= today,
  };
}

function nextMatricule() {
  const last = db.prepare("SELECT matricule FROM employes WHERE matricule LIKE 'MAT-%' ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'MAT-0001';
  const num = parseInt(last.matricule.replace('MAT-', '')) || 0;
  return 'MAT-' + String(num + 1).padStart(4, '0');
}

// ─── KPIs dashboard ──────────────────────────────────────────────────────────

router.get('/kpis', (req, res) => {
  const today   = new Date();
  const in30    = new Date(today); in30.setDate(in30.getDate() + 30);
  const todayStr = today.toISOString().slice(0, 10);
  const in30Str  = in30.toISOString().slice(0, 10);
  const moisActuel = today.getMonth() + 1;

  const total   = db.prepare("SELECT COUNT(*) as c FROM employes WHERE actif = 1").get().c;
  const actifs  = db.prepare("SELECT COUNT(*) as c FROM employes WHERE actif = 1 AND statut_dossier = 'actif'").get().c;
  const suspendus = db.prepare("SELECT COUNT(*) as c FROM employes WHERE actif = 1 AND statut_dossier = 'suspendu'").get().c;

  const contratsExpirants = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND date_fin_contrat BETWEEN ? AND ?"
  ).get(todayStr, in30Str).c;

  const essaisExpirants = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND date_fin_essai BETWEEN ? AND ?"
  ).get(todayStr, in30Str).c;

  // Anniversaires du mois (nés dans le mois courant)
  const anniversaires = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE actif=1 AND strftime('%m', date_naissance) = ?"
  ).get(String(moisActuel).padStart(2, '0')).c;

  const masseSalariale = db.prepare(
    "SELECT COALESCE(SUM(salaire_base),0) as total FROM employes WHERE actif=1 AND statut_dossier='actif'"
  ).get().total;

  const documentsExpires = db.prepare(
    "SELECT COUNT(*) as c FROM employes_documents WHERE date_expiration IS NOT NULL AND date_expiration < ?"
  ).get(todayStr).c;

  // Répartition par type contrat
  const parContrat = db.prepare(
    "SELECT type_contrat, COUNT(*) as nb FROM employes WHERE actif=1 GROUP BY type_contrat"
  ).all();

  // Répartition par département
  const parDept = db.prepare(
    "SELECT COALESCE(departement,'Non défini') as dept, COUNT(*) as nb FROM employes WHERE actif=1 GROUP BY departement ORDER BY nb DESC LIMIT 8"
  ).all();

  // ── KPIs avancés ──────────────────────────────────────────────────────────

  // Turnover mois courant : agents sortis ce mois / effectif moyen × 100
  const moisStr = String(moisActuel).padStart(2, '0');
  const anneeStr = String(today.getFullYear());
  const sortisM = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE statut_dossier='sorti' AND strftime('%Y-%m', date_sortie)=?"
  ).get(`${anneeStr}-${moisStr}`).c;
  const effectifMoyen = Math.max(1, actifs + sortisM);
  const turnover_mois = Math.round((sortisM / effectifMoyen) * 1000) / 10; // 1 décimale

  // Turnover annuel : sorties 12 derniers mois glissants
  const il12mois = new Date(today); il12mois.setFullYear(il12mois.getFullYear() - 1);
  const il12Str  = il12mois.toISOString().slice(0, 10);
  const sortisA  = db.prepare(
    "SELECT COUNT(*) as c FROM employes WHERE statut_dossier='sorti' AND date_sortie >= ?"
  ).get(il12Str).c;
  const effectifMoyenA = Math.max(1, actifs + sortisA);
  const turnover_annee = Math.round((sortisA / effectifMoyenA) * 1000) / 10;

  // Ancienneté moyenne (agents actifs avec date_embauche)
  const anciennetesRows = db.prepare(
    "SELECT date_embauche FROM employes WHERE actif=1 AND statut_dossier='actif' AND date_embauche IS NOT NULL"
  ).all();
  let anciennete_moyenne = 0;
  if (anciennetesRows.length > 0) {
    const now = Date.now();
    const total_annees = anciennetesRows.reduce((s, r) => {
      return s + (now - new Date(r.date_embauche).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    }, 0);
    anciennete_moyenne = Math.round((total_annees / anciennetesRows.length) * 10) / 10;
  }

  // Répartition H/F
  const sexeRows = db.prepare(
    "SELECT COALESCE(sexe,'?') as s, COUNT(*) as nb FROM employes WHERE actif=1 GROUP BY sexe"
  ).all();
  const repartition_sexe = { H: 0, F: 0, autre: 0 };
  sexeRows.forEach(r => {
    if (r.s === 'M' || r.s === 'H') repartition_sexe.H += r.nb;
    else if (r.s === 'F')           repartition_sexe.F += r.nb;
    else                            repartition_sexe.autre += r.nb;
  });

  // Taux d'absentéisme (congés approuvés + en cours / nb jours ouvrés mois × actifs)
  const nbJoursOuvres = 22;
  const joursCongePris = db.prepare(`
    SELECT COALESCE(SUM(nb_jours),0) as total
    FROM employes_conges
    WHERE statut IN ('approuve','termine')
    AND strftime('%Y-%m', date_debut) = ?
  `).get(`${anneeStr}-${moisStr}`).total;
  const taux_absenteisme = actifs > 0
    ? Math.round((joursCongePris / (actifs * nbJoursOuvres)) * 10000) / 100
    : 0;

  // Sanctions actives 30 derniers jours
  const il30Str = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nb_sanctions_actives_30j = db.prepare(
    "SELECT COUNT(*) as c FROM employes_sanctions WHERE statut NOT IN ('clos','annule') AND created_at >= ?"
  ).get(il30Str).c;

  // Heures sup en attente de validation
  const heures_sup_en_attente = db.prepare(
    "SELECT COUNT(*) as c FROM employes_heures_sup WHERE statut='saisi'"
  ).get().c;

  // Révisions salariales en attente DG
  const revisions_en_attente_dg = (() => {
    try {
      return db.prepare("SELECT COUNT(*) as c FROM demandes_revision_salaire WHERE statut='soumis_dg'").get().c;
    } catch (_) { return 0; }
  })();

  res.json({
    total, actifs, suspendus,
    contratsExpirants, essaisExpirants, anniversaires,
    masseSalariale, documentsExpires,
    parContrat, parDept,
    // KPIs avancés
    turnover_mois,
    turnover_annee,
    anciennete_moyenne,
    repartition_sexe,
    taux_absenteisme,
    nb_sanctions_actives_30j,
    heures_sup_en_attente,
    revisions_en_attente_dg,
  });
});

// ─── Prochain matricule ───────────────────────────────────────────────────────
// IMPORTANT : doit être AVANT /:id pour éviter le conflit de route Express

router.get('/next-matricule', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
  res.json({ matricule: nextMatricule() });
});

// ─── Liste des agents ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
  // statut='' signifie "Tous" (onglet explicite) — sinon défaut 'actif' pour éviter d'afficher les suspendus/sortis par accident
  const { statut = 'actif', type_contrat, departement, search, limit = 100, offset = 0 } = req.query;
  let sql    = 'SELECT * FROM employes WHERE 1 = 1';
  const args = [];

  if (statut !== '') {
    if (['sorti', 'archive'].includes(statut)) {
      sql += ' AND statut_dossier = ?';
    } else {
      sql += ' AND actif = 1 AND statut_dossier = ?';
    }
    args.push(statut);
  }
  if (type_contrat)  { sql += ' AND type_contrat = ?';   args.push(type_contrat); }
  if (departement)   { sql += ' AND departement = ?';    args.push(departement); }
  if (search) {
    sql += ' AND (nom LIKE ? OR prenom LIKE ? OR matricule LIKE ? OR poste LIKE ?)';
    const s = '%' + search + '%';
    args.push(s, s, s, s);
  }

  sql += ' ORDER BY nom, prenom LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));

  const agents = db.prepare(sql).all(...args).map(enrichAgent);

  const countSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as c').replace(/ORDER BY.*/s, '');
  const total    = db.prepare(countSql).get(...args.slice(0, -2)).c;

  res.json({ agents, total, limit: Number(limit), offset: Number(offset) });
});

// ─── Alertes documents expirant dans 30 jours ─────────────────────────────────
// IMPORTANT : doit être AVANT /:id

router.get('/documents/alertes', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
  const today = new Date().toISOString().slice(0, 10);
  const in30  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const docs  = db.prepare(`
    SELECT d.*, e.nom, e.prenom, e.matricule
    FROM employes_documents d
    JOIN employes e ON d.employe_id = e.id
    WHERE e.actif = 1
      AND d.date_expiration IS NOT NULL
      AND d.date_expiration <= ?
    ORDER BY d.date_expiration ASC
    LIMIT 60
  `).all(in30);
  res.json(docs.map(d => ({
    ...d,
    statut_calc: d.date_expiration < today ? 'expiré' : 'expire_bientot'
  })));
});

// ─── Liste des dossiers de sortie ────────────────────────────────────────────
// IMPORTANT : doit être AVANT /:id, sinon "sorties" est interprété comme un id.
router.get('/sorties', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      s.*,
      e.id AS employe_id,
      e.nom || ' ' || COALESCE(e.prenom, '') AS employe_nom,
      e.matricule AS employe_matricule,
      e.poste,
      e.departement
    FROM employes_sortie s
    JOIN employes e ON e.id = s.employe_id
    ORDER BY
      CASE s.statut
        WHEN 'initie' THEN 1
        WHEN 'calcule' THEN 2
        WHEN 'valide' THEN 3
        ELSE 4
      END,
      COALESCE(s.date_depart_effectif, s.created_at) DESC
  `).all();

  res.json({ sorties: rows });
});

// ─── Détail d'un agent ────────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });

  // ?include=enfants,documents,diplomes,experiences,avances,conges,bulletins
  // Sans paramètre : tout charger (rétrocompatible)
  const ALL = ['enfants','documents','diplomes','experiences','avances','conges','bulletins'];
  const inc = req.query.include ? new Set(req.query.include.split(',')) : new Set(ALL);

  const payload = { agent: enrichAgent(agent) };

  if (inc.has('enfants'))
    payload.enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ? ORDER BY date_naissance').all(agent.id);
  if (inc.has('documents')) {
    const today = new Date().toISOString().slice(0, 10);
    const in30  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    payload.documents = db.prepare('SELECT * FROM employes_documents WHERE employe_id = ? ORDER BY created_at DESC').all(agent.id)
      .map(d => {
        let statut = d.statut || 'valide';
        if (d.date_expiration) {
          if (d.date_expiration < today) statut = 'expiré';
          else if (d.date_expiration <= in30) statut = 'expire_bientot';
        }
        return { ...d, statut };
      });
  }
  if (inc.has('diplomes'))
    payload.diplomes = db.prepare('SELECT * FROM employes_diplomes WHERE employe_id = ? ORDER BY annee_obtention DESC').all(agent.id);
  if (inc.has('experiences'))
    payload.experiences = db.prepare('SELECT * FROM employes_experiences WHERE employe_id = ? ORDER BY date_debut DESC').all(agent.id);
  if (inc.has('avances')) {
    const avances = db.prepare('SELECT * FROM employes_avances WHERE employe_id = ? ORDER BY date DESC').all(agent.id);
    // Enrichir chaque avance avec ses remboursements
    const stmtRmb = db.prepare('SELECT * FROM employes_avances_remboursements WHERE avance_id = ? ORDER BY date');
    payload.avances = avances.map(a => ({ ...a, remboursements: stmtRmb.all(a.id) }));
  }
  if (inc.has('conges'))
    payload.conges = db.prepare('SELECT * FROM employes_conges WHERE employe_id = ? ORDER BY date_debut DESC').all(agent.id);
  if (inc.has('bulletins'))
    payload.bulletins = db.prepare('SELECT id, mois, annee, brut, net_a_payer, statut FROM bulletins_salaire WHERE employe_id = ? ORDER BY annee DESC, mois DESC LIMIT 24').all(agent.id);

  // Contrat de travail lié (si contrat_id renseigné)
  if (agent.contrat_id) {
    const contratLie = db.prepare(`
      SELECT id, numero, type_contrat, objet, statut,
             date_debut, date_fin, montant, periodicite
      FROM contrats WHERE id = ?
    `).get(agent.contrat_id);
    payload.contrat_lie = contratLie || null;
  } else {
    payload.contrat_lie = null;
  }

  const params = db.prepare('SELECT * FROM parametres').all().reduce((o, p) => ({ ...o, [p.cle]: p.valeur }), {});
  payload.devise  = params.devise  || 'XAF';
  payload.societe = params.societe || 'TOP CENTER';

  res.json(payload);
});

// ─── Créer un agent ───────────────────────────────────────────────────────────

router.post('/', requireAgentPermission('hr.agent.create', 'Permission hr.agent.create requise pour créer un agent'), (req, res) => {
  const {
    nom, prenom,
    matricule,
    sexe = 'M',
    poste, type = 'permanent',
    salaire_base = 0,
    prime_transport = 0,
    prime_logement  = 0,
    mode_paiement   = 'especes',
    banque = '', numero_compte = '',
    email = '', telephone = '', telephone2 = '',
    date_naissance, lieu_naissance,
    nationalite = 'Congolaise',
    situation_matrimoniale = 'celibataire',
    nb_enfants = 0, nb_enfants_charge = 0,
    adresse = '',
    num_piece_identite = '', type_piece_identite = '', date_expiration_identite = '',
    date_embauche, type_contrat = 'cdi',
    date_debut_contrat = '', date_fin_contrat = '',
    periode_essai_mois = 0, date_fin_essai = '',
    departement = '', superieur_hierarchique = '', site = '',
    statut_dossier = 'actif',
  } = req.body;

  if (!nom || !prenom) return res.status(400).json({ error: 'Nom et prénom requis' });

  // Unicité pièce d'identité
  if (num_piece_identite && num_piece_identite.trim()) {
    const existing = db.prepare('SELECT id, nom, prenom FROM employes WHERE num_piece_identite = ? AND actif = 1').get(num_piece_identite.trim());
    if (existing) return res.status(409).json({ error: `Numéro de pièce déjà utilisé par ${existing.nom} ${existing.prenom}` });
  }

  const mat = matricule || nextMatricule();

  try {
    const r = db.prepare(`
      INSERT INTO employes (
        nom, prenom, matricule, sexe, poste, type, salaire_base, prime_transport, prime_logement,
        mode_paiement, banque, numero_compte, email, telephone, telephone2,
        date_naissance, lieu_naissance, nationalite, situation_matrimoniale,
        nb_enfants, nb_enfants_charge, adresse,
        num_piece_identite, type_piece_identite, date_expiration_identite,
        date_embauche, type_contrat, date_debut_contrat, date_fin_contrat,
        periode_essai_mois, date_fin_essai,
        departement, superieur_hierarchique, site, statut_dossier
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,?,?,
        ?,?,
        ?,?,?,?
      )
    `).run(
      nom, prenom, mat, sexe, poste, type, salaire_base, prime_transport, prime_logement,
      mode_paiement, banque, numero_compte, email, telephone, telephone2,
      date_naissance || null, lieu_naissance || null, nationalite, situation_matrimoniale,
      nb_enfants, nb_enfants_charge, adresse,
      num_piece_identite, type_piece_identite, date_expiration_identite || null,
      date_embauche || null, type_contrat, date_debut_contrat || null, date_fin_contrat || null,
      periode_essai_mois, date_fin_essai || null,
      departement, superieur_hierarchique, site, statut_dossier
    );
    const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(r.lastInsertRowid);
    audit('employes', agent.id, 'create', {
      matricule: agent.matricule,
      statut_dossier: agent.statut_dossier,
      besoin_acces_systeme: agent.besoin_acces_systeme,
    }, req.user?.id);

    // Déclencher l'onboarding automatiquement (non bloquant)
    try {
      onboardingSvc.initOnboarding(agent.id, agent, req.user?.id, req.ip);
      onboardingSvc.notifierCreation(agent, req.user?.id);
    } catch (obErr) {
      // L'onboarding ne doit jamais bloquer la création de l'employé
      console.error('[onboarding] init error:', obErr.message);
    }

    res.status(201).json(enrichAgent(agent));
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Matricule déjà utilisé' });
    }
    throw e;
  }
});

// ─── Modifier un agent ────────────────────────────────────────────────────────

// Rôles autorisés à modifier les données salariales (salaire_base, primes)
const SALARY_ROLES = ['admin', 'rh', 'finance', 'dg'];
const VALID_SALARY_REVISION_TYPES = ['embauche','augmentation','correction','promotion','indexation','regularisation','sanction'];
function canSalary(user) { return hasRole(user, ...SALARY_ROLES); }
function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function activeSalaryRevision(empId) {
  return db.prepare(`
    SELECT id, statut
    FROM demandes_revision_salaire
    WHERE employe_id = ?
    AND statut NOT IN ('rejete','applique','annule')
    LIMIT 1
  `).get(empId);
}
function validateSalaryRevisionPayload({ empId, agent, body }) {
  const revEnCours = activeSalaryRevision(empId);
  if (revEnCours) {
    return {
      error: {
        status: 409,
        body: {
          error: 'Une révision salariale est en cours (soumis_rh/soumis_dg/approuve) — attendez sa conclusion avant toute modification directe',
          code: 'REVISION_EN_COURS',
          revision_id: revEnCours.id,
        },
      },
    };
  }

  const {
    salaire_base     = agent.salaire_base,
    prime_transport  = agent.prime_transport,
    prime_logement   = agent.prime_logement,
    motif            = '',
    type_revision    = 'correction',
  } = body;

  const nouveauSalaire    = numberOrZero(salaire_base);
  const nouveauTransport  = numberOrZero(prime_transport);
  const nouveauLogement   = numberOrZero(prime_logement);
  const motifTrim         = String(motif || '').trim();

  if (nouveauSalaire < 0) {
    return { error: { status: 400, body: { error: 'Le salaire de base ne peut pas être négatif' } } };
  }
  if (!motifTrim) {
    return {
      error: {
        status: 400,
        body: {
          error: 'Motif obligatoire pour toute modification de rémunération',
          code: 'SALARY_MOTIF_REQUIRED',
        },
      },
    };
  }
  if (!VALID_SALARY_REVISION_TYPES.includes(type_revision)) {
    return {
      error: {
        status: 400,
        body: { error: `type_revision invalide. Valeurs : ${VALID_SALARY_REVISION_TYPES.join(', ')}` },
      },
    };
  }

  return {
    values: {
      nouveauSalaire,
      nouveauTransport,
      nouveauLogement,
      motif: motifTrim,
      type_revision,
    },
  };
}
function auditSalaryRevision(empId, agent, salaryRevision, userId) {
  db.prepare(`
    INSERT INTO historique_salaires
      (employe_id, date_effet, ancien_salaire, nouveau_salaire,
       ancien_transport, nouveau_transport, ancien_logement, nouveau_logement,
       motif, type_revision, approved_by, approved_at, created_by)
    VALUES (?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    empId,
    agent.salaire_base    || 0, salaryRevision.nouveauSalaire,
    agent.prime_transport || 0, salaryRevision.nouveauTransport,
    agent.prime_logement  || 0, salaryRevision.nouveauLogement,
    salaryRevision.motif, salaryRevision.type_revision,
    userId, userId
  );

  audit('employes', empId, 'modifier_salaire', {
    ancien_salaire: agent.salaire_base,
    nouveau_salaire: salaryRevision.nouveauSalaire,
    motif: salaryRevision.motif,
    type_revision: salaryRevision.type_revision,
  }, userId);
}

const AGENT_AUDIT_FIELDS = [
  'nom', 'prenom', 'matricule', 'sexe', 'poste', 'type',
  'mode_paiement', 'banque', 'numero_compte', 'email', 'telephone', 'telephone2',
  'date_naissance', 'lieu_naissance', 'nationalite', 'situation_matrimoniale',
  'nb_enfants', 'nb_enfants_charge', 'adresse',
  'num_piece_identite', 'type_piece_identite', 'date_expiration_identite',
  'date_embauche', 'type_contrat', 'date_debut_contrat', 'date_fin_contrat',
  'periode_essai_mois', 'date_fin_essai',
  'departement', 'superieur_hierarchique', 'superieur_id', 'site',
  'statut_dossier', 'motif_sortie', 'date_sortie', 'actif',
];

function changedAgentFields(before, after) {
  if (!before || !after) return [];
  return AGENT_AUDIT_FIELDS.filter(field => String(before[field] ?? '') !== String(after[field] ?? ''));
}

router.put('/:id', requireAgentPermission('hr.agent.update', 'Permission hr.agent.update requise pour modifier un agent'), (req, res) => {
  const agent = db.prepare(`
    SELECT id, statut_dossier, salaire_base, prime_transport, prime_logement,
           superieur_id, superieur_hierarchique
    FROM employes WHERE id = ?
  `).get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });
  const beforeAgent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);

  // ── Un agent sorti ne peut être modifié que via /reactiver ──────────────────
  if (agent.statut_dossier === 'sorti') {
    return res.status(403).json({ error: 'Agent sorti — utilisez la route /reactiver pour le réactiver' });
  }

  // ── Champs salariaux protégés — passer par PUT /:id/salaire ─────────────────
  const salaryFields = ['salaire_base', 'prime_transport', 'prime_logement'];
  const hasSalaryChange = salaryFields.some(f =>
    req.body[f] !== undefined && numberOrZero(req.body[f]) !== numberOrZero(agent[f])
  );
  if (hasSalaryChange) {
    if (!canSalary(req.user)) {
      return res.status(403).json({
        error: 'Modification de la rémunération interdite — utilisez PUT /api/agents/:id/salaire (rôle RH, Finance ou DG requis)',
        code: 'SALARY_PROTECTED',
      });
    }
  }

  const salaryRevision = hasSalaryChange
    ? validateSalaryRevisionPayload({ empId: Number(req.params.id), agent, body: req.body })
    : null;
  if (salaryRevision?.error) {
    return res.status(salaryRevision.error.status).json(salaryRevision.error.body);
  }

  // Unicité pièce d'identité (sauf pour soi-même)
  const { num_piece_identite: npi } = req.body;
  if (npi && npi.trim()) {
    const conflict = db.prepare('SELECT id, nom, prenom FROM employes WHERE num_piece_identite = ? AND id != ? AND actif = 1').get(npi.trim(), req.params.id);
    if (conflict) return res.status(409).json({ error: `Numéro de pièce déjà utilisé par ${conflict.nom} ${conflict.prenom}` });
  }

  const {
    nom, prenom, matricule, sexe,
    poste, type, salaire_base, prime_transport, prime_logement,
    mode_paiement, banque, numero_compte, email, telephone, telephone2,
    date_naissance, lieu_naissance, nationalite, situation_matrimoniale,
    nb_enfants, nb_enfants_charge, adresse,
    num_piece_identite, type_piece_identite, date_expiration_identite,
    date_embauche, type_contrat, date_debut_contrat, date_fin_contrat,
    periode_essai_mois, date_fin_essai,
    departement, superieur_hierarchique, site,
    superieur_id: rawSupId,
    statut_dossier, motif_sortie, date_sortie,
    actif,
  } = req.body;

  // ── Résolution superieur_id ──────────────────────────────────────────────────
  // Le frontend peut envoyer superieur_id (INTEGER) ou superieur_hierarchique (TEXT).
  // On tente de résoudre l'ID en priorité, puis par nom si absent.
  const empIdN = Number(req.params.id);
  let resolvedSupId = rawSupId !== undefined ? (rawSupId ? Number(rawSupId) : null)
                    : agent.superieur_id ?? null;

  // Si le champ TEXT a changé mais pas l'ID, tenter de retrouver l'ID par nom
  if (rawSupId === undefined && superieur_hierarchique !== undefined) {
    if (!superieur_hierarchique || !superieur_hierarchique.trim()) {
      resolvedSupId = null;
    } else if (superieur_hierarchique !== (
      (() => { const s = db.prepare('SELECT nom,prenom FROM employes WHERE id=?').get(agent.superieur_id); return s ? `${s.nom} ${s.prenom||''}`.trim() : null; })()
    )) {
      // Nom a changé → chercher l'ID correspondant
      const found = db.prepare(
        "SELECT id FROM employes WHERE (nom || ' ' || COALESCE(prenom,'')) = ? AND id != ? AND actif = 1 LIMIT 1"
      ).get(superieur_hierarchique.trim(), empIdN);
      resolvedSupId = found ? found.id : null;
    }
  }

  // ── Contrôle de boucle hiérarchique ─────────────────────────────────────────
  if (resolvedSupId !== null && resolvedSupId !== agent.superieur_id) {
    const orgStrict = db.prepare("SELECT valeur FROM parametres WHERE cle='org_boucle_strict'").get()?.valeur !== '0';
    const { creeraitBoucle } = getOrgHelpers();
    if (creeraitBoucle(empIdN, resolvedSupId)) {
      if (orgStrict) {
        return res.status(409).json({
          error: 'Cycle hiérarchique détecté : cette affectation créerait une boucle',
          code: 'CYCLE_HIERARCHIQUE',
        });
      }
      resolvedSupId = null; // mode permissif : ignorer silencieusement
    }
  }

  // Nom TEXT miroir du supérieur résolu
  let resolvedSupNom = superieur_hierarchique !== undefined ? (superieur_hierarchique || '') : (agent.superieur_hierarchique || '');
  if (resolvedSupId) {
    const s = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(resolvedSupId);
    if (s) resolvedSupNom = `${s.nom} ${s.prenom || ''}`.trim();
  } else if (!superieur_hierarchique?.trim()) {
    resolvedSupNom = '';
  }

  // ── Validation profil paie à l'activation ───────────────────────────────────
  if (agent.statut_dossier === 'brouillon' && statut_dossier === 'actif') {
    const sal = Number(salaire_base) || agent.salaire_base || 0;
    if (sal <= 0) {
      return res.status(400).json({ error: 'Salaire de base requis pour activer le profil paie de l\'agent' });
    }
  }

  // Lire l'état avant modification (pour mutation auto)
  const avant = db.prepare('SELECT poste, departement, site, superieur_id, superieur_hierarchique FROM employes WHERE id=?').get(empIdN);

  db.prepare(`
    UPDATE employes SET
      nom=?, prenom=?, matricule=?, sexe=?,
      poste=?, type=?, salaire_base=?, prime_transport=?, prime_logement=?,
      mode_paiement=?, banque=?, numero_compte=?, email=?, telephone=?, telephone2=?,
      date_naissance=?, lieu_naissance=?, nationalite=?, situation_matrimoniale=?,
      nb_enfants=?, nb_enfants_charge=?, adresse=?,
      num_piece_identite=?, type_piece_identite=?, date_expiration_identite=?,
      date_embauche=?, type_contrat=?, date_debut_contrat=?, date_fin_contrat=?,
      periode_essai_mois=?, date_fin_essai=?,
      departement=?, superieur_hierarchique=?, site=?,
      superieur_id=?,
      statut_dossier=?, motif_sortie=?, date_sortie=?,
      actif=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    nom, prenom, matricule, sexe,
    poste, type,
    salaire_base === undefined ? numberOrZero(agent.salaire_base) : numberOrZero(salaire_base),
    prime_transport === undefined ? numberOrZero(agent.prime_transport) : numberOrZero(prime_transport),
    prime_logement === undefined ? numberOrZero(agent.prime_logement) : numberOrZero(prime_logement),
    mode_paiement, banque || '', numero_compte || '', email || '', telephone || '', telephone2 || '',
    date_naissance || null, lieu_naissance || null, nationalite, situation_matrimoniale,
    nb_enfants || 0, nb_enfants_charge || 0, adresse || '',
    num_piece_identite || '', type_piece_identite || '', date_expiration_identite || null,
    date_embauche || null, type_contrat, date_debut_contrat || null, date_fin_contrat || null,
    periode_essai_mois || 0, date_fin_essai || null,
    departement || '', resolvedSupNom, site || '',
    resolvedSupId,
    statut_dossier, motif_sortie || null, date_sortie || null,
    ['sorti', 'archive'].includes(statut_dossier) ? 0 : (actif !== undefined ? (actif ? 1 : 0) : 1),
    empIdN
  );

  // ── Mutation automatique si poste/dept/site/supérieur a changé ───────────────
  const orgMutAuto = db.prepare("SELECT valeur FROM parametres WHERE cle='org_mutation_auto'").get()?.valeur !== '0';
  const apresPoste = poste || avant.poste;
  const apresDept  = departement || avant.departement;
  const apresSite  = site || avant.site;
  const hieroChange = resolvedSupId !== avant.superieur_id;
  const posteChange = apresPoste !== avant.poste;
  const deptChange  = apresDept  !== avant.departement;
  const siteChange  = apresSite  !== avant.site;

  if (orgMutAuto && (hieroChange || posteChange || deptChange || siteChange)) {
    try {
      const { _enregistrerMutation } = getOrgHelpers();
      let typeMut = 'modification';
      if (posteChange && !deptChange) typeMut = 'promotion';
      if (deptChange)                 typeMut = 'transfert';
      _enregistrerMutation({
        employe_id: empIdN, date_effet: new Date().toISOString().slice(0, 10),
        type_mutation: typeMut,
        ancien_poste: avant.poste,    nouveau_poste: apresPoste,
        ancien_dept:  avant.departement, nouveau_dept: apresDept,
        ancien_site:  avant.site,     nouveau_site: apresSite,
        ancien_sup_id: avant.superieur_id, ancien_sup_nom: avant.superieur_hierarchique,
        nouveau_sup_id: resolvedSupId, nouveau_sup_nom: resolvedSupNom,
        motif: motif_sortie || null, created_by: req.user.id,
      });
    } catch (_) {}
  }

  // ── Audit des transitions de statut importantes ─────────────────────────────
  const ancienStatut = agent.statut_dossier;
  if (statut_dossier && statut_dossier !== ancienStatut) {
    const details = { ancien: ancienStatut, nouveau: statut_dossier };
    if (statut_dossier === 'actif')    details.profil_paie = 'activé';
    if (statut_dossier === 'sorti')    details.motif = motif_sortie || null;
    if (statut_dossier === 'suspendu') details.motif = motif_sortie || null;
    audit('employes', empIdN, `statut_${statut_dossier}`, details, req.user.id);
  }

  const updatedAgent = db.prepare('SELECT * FROM employes WHERE id = ?').get(empIdN);
  const changed_fields = changedAgentFields(beforeAgent, updatedAgent);
  if (changed_fields.length > 0) {
    audit('employes', empIdN, 'update', { changed_fields }, req.user.id);
  }
  if (salaryRevision?.values) {
    auditSalaryRevision(empIdN, agent, salaryRevision.values, req.user.id);
  }

  res.json(enrichAgent(updatedAgent));
});

// ─── Réactiver un agent sorti ────────────────────────────────────────────────
// Seule voie légale pour faire passer statut_dossier de 'sorti' → 'actif'.
// Admin uniquement + motif obligatoire.

router.put('/:id/reactiver', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

  const agent = db.prepare('SELECT id, nom, prenom, statut_dossier, salaire_base FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });
  if (agent.statut_dossier !== 'sorti') return res.status(400).json({ error: `L'agent n'est pas sorti (statut actuel : ${agent.statut_dossier})` });

  const { motif, salaire_base: newSalaire } = req.body;
  if (!motif || !String(motif).trim()) {
    return res.status(400).json({ error: 'Motif de réactivation obligatoire' });
  }

  const salaireEffectif = Number(newSalaire) || agent.salaire_base || 0;
  if (salaireEffectif <= 0) {
    return res.status(400).json({ error: 'Salaire de base requis pour réactiver le profil paie de l\'agent' });
  }

  db.prepare(`
    UPDATE employes SET
      statut_dossier = 'actif',
      salaire_base   = ?,
      motif_sortie   = NULL,
      date_sortie    = NULL
    WHERE id = ?
  `).run(salaireEffectif, agent.id);

  audit('employes', agent.id, 'agent_reactive', {
    motif: String(motif).trim(),
    ancien_statut: 'sorti',
    profil_paie: 'réactivé',
  }, req.user.id);

  res.json(enrichAgent(db.prepare('SELECT * FROM employes WHERE id = ?').get(agent.id)));
});

// ─── Sortie définitive d'un agent ────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });

  const { motif_sortie, date_sortie } = req.body || {};
  if (!motif_sortie || !String(motif_sortie).trim())
    return res.status(400).json({ error: 'Motif de sortie obligatoire' });
  if (!date_sortie)
    return res.status(400).json({ error: 'Date de sortie obligatoire' });

  const agent = db.prepare('SELECT id, nom, prenom FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });

  db.prepare(`
    UPDATE employes SET actif=0, statut_dossier='sorti',
      motif_sortie=?, date_sortie=?, updated_at=datetime('now')
    WHERE id=?
  `).run(String(motif_sortie).trim(), date_sortie, req.params.id);

  audit('employes', req.params.id, 'sortie', {
    motif_sortie: String(motif_sortie).trim(),
    date_sortie,
    nom: agent.nom, prenom: agent.prenom
  }, req.user.id);

  res.json({ ok: true });
});

// ─── Enfants ──────────────────────────────────────────────────────────────────

router.get('/:id/enfants', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ? ORDER BY date_naissance').all(req.params.id));
});

router.post('/:id/enfants', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { prenom, nom = '', date_naissance = '', sexe = 'M', est_charge = 1, scolarise = 0, observation = '' } = req.body;
  if (!prenom) return res.status(400).json({ error: 'Prénom requis' });
  const r = db.prepare('INSERT INTO employes_enfants (employe_id,nom,prenom,date_naissance,sexe,est_charge,scolarise,observation) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id, nom, prenom, date_naissance || null, sexe, est_charge ? 1 : 0, scolarise ? 1 : 0, observation);
  // Mettre à jour le compteur sur l'agent
  const enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ?').all(req.params.id);
  const charge  = enfants.filter(e => e.est_charge).length;
  db.prepare("UPDATE employes SET nb_enfants=?, nb_enfants_charge=?, updated_at=datetime('now') WHERE id=?").run(enfants.length, charge, req.params.id);
  audit('employes_enfants', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), prenom, nom }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, prenom, nom, date_naissance, sexe, est_charge, scolarise, observation });
});

router.delete('/:id/enfants/:eid', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const enfant = db.prepare('SELECT id, prenom, nom FROM employes_enfants WHERE id = ? AND employe_id = ?').get(req.params.eid, req.params.id);
  db.prepare('DELETE FROM employes_enfants WHERE id = ? AND employe_id = ?').run(req.params.eid, req.params.id);
  const enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ?').all(req.params.id);
  const charge  = enfants.filter(e => e.est_charge).length;
  db.prepare("UPDATE employes SET nb_enfants=?, nb_enfants_charge=?, updated_at=datetime('now') WHERE id=?").run(enfants.length, charge, req.params.id);
  audit('employes_enfants', Number(req.params.eid), 'delete', { employe_id: Number(req.params.id), prenom: enfant?.prenom, nom: enfant?.nom }, req.user.id);
  res.json({ ok: true });
});

// ─── Documents RH ─────────────────────────────────────────────────────────────

router.get('/:id/documents', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_documents WHERE employe_id = ? ORDER BY created_at DESC').all(req.params.id));
});

router.post('/:id/documents', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { type_document, date_emission = '', date_expiration = '', statut = 'valide', observation = '' } = req.body;
  if (!type_document) return res.status(400).json({ error: 'Type de document requis' });
  const r = db.prepare('INSERT INTO employes_documents (employe_id,type_document,date_emission,date_expiration,statut,observation) VALUES (?,?,?,?,?,?)').run(req.params.id, type_document, date_emission || null, date_expiration || null, statut, observation);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_documents', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), type_document, statut }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, type_document, date_emission, date_expiration, statut, observation });
});

router.delete('/:id/documents/:did', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const doc = db.prepare('SELECT id, type_document, statut FROM employes_documents WHERE id = ? AND employe_id = ?').get(req.params.did, req.params.id);
  db.prepare('DELETE FROM employes_documents WHERE id = ? AND employe_id = ?').run(req.params.did, req.params.id);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_documents', Number(req.params.did), 'delete', { employe_id: Number(req.params.id), type_document: doc?.type_document, statut: doc?.statut }, req.user.id);
  res.json({ ok: true });
});

// ─── Diplômes ─────────────────────────────────────────────────────────────────

router.get('/:id/diplomes', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_diplomes WHERE employe_id = ? ORDER BY annee_obtention DESC').all(req.params.id));
});

router.post('/:id/diplomes', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { intitule, etablissement = '', pays = 'Congo-Brazzaville', annee_obtention = null, niveau = 'autre', observation = '' } = req.body;
  if (!intitule) return res.status(400).json({ error: 'Intitulé requis' });
  const r = db.prepare('INSERT INTO employes_diplomes (employe_id,intitule,etablissement,pays,annee_obtention,niveau,observation) VALUES (?,?,?,?,?,?,?)').run(req.params.id, intitule, etablissement, pays, annee_obtention || null, niveau, observation);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_diplomes', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), intitule, niveau }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, intitule, etablissement, pays, annee_obtention, niveau, observation });
});

router.delete('/:id/diplomes/:did', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const diplome = db.prepare('SELECT id, intitule, niveau FROM employes_diplomes WHERE id = ? AND employe_id = ?').get(req.params.did, req.params.id);
  db.prepare('DELETE FROM employes_diplomes WHERE id = ? AND employe_id = ?').run(req.params.did, req.params.id);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_diplomes', Number(req.params.did), 'delete', { employe_id: Number(req.params.id), intitule: diplome?.intitule, niveau: diplome?.niveau }, req.user.id);
  res.json({ ok: true });
});

// ─── Expériences professionnelles ────────────────────────────────────────────

router.get('/:id/experiences', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_experiences WHERE employe_id = ? ORDER BY date_debut DESC').all(req.params.id));
});

router.post('/:id/experiences', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { poste, entreprise = '', date_debut = '', date_fin = '', type_contrat = '', description = '' } = req.body;
  if (!poste) return res.status(400).json({ error: 'Poste requis' });
  const r = db.prepare('INSERT INTO employes_experiences (employe_id,poste,entreprise,date_debut,date_fin,type_contrat,description) VALUES (?,?,?,?,?,?,?)').run(req.params.id, poste, entreprise, date_debut || null, date_fin || null, type_contrat, description);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_experiences', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), poste, entreprise }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, poste, entreprise, date_debut, date_fin, type_contrat, description });
});

router.delete('/:id/experiences/:eid', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const experience = db.prepare('SELECT id, poste, entreprise FROM employes_experiences WHERE id = ? AND employe_id = ?').get(req.params.eid, req.params.id);
  db.prepare('DELETE FROM employes_experiences WHERE id = ? AND employe_id = ?').run(req.params.eid, req.params.id);
  db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(req.params.id);
  audit('employes_experiences', Number(req.params.eid), 'delete', { employe_id: Number(req.params.id), poste: experience?.poste, entreprise: experience?.entreprise }, req.user.id);
  res.json({ ok: true });
});

// ─── Historique audit de l'agent ──────────────────────────────────────────────

router.get('/:id/historique', (req, res) => {
  const agentId = Number(req.params.id);
  const rows = db.prepare(`
    SELECT a.*, u.nom as user_nom
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE
      (a.table_name = 'employes' AND a.record_id = ?)
      OR (a.table_name = 'employes_avances' AND a.record_id IN (
            SELECT id FROM employes_avances WHERE employe_id = ?
          ))
      OR (a.table_name = 'employes_conges' AND a.record_id IN (
            SELECT id FROM employes_conges WHERE employe_id = ?
          ))
      OR (a.table_name = 'employes_enfants' AND a.record_id IN (
            SELECT id FROM employes_enfants WHERE employe_id = ?
          ))
      OR (a.table_name = 'employes_documents' AND a.record_id IN (
            SELECT id FROM employes_documents WHERE employe_id = ?
          ))
      OR (a.table_name = 'employes_diplomes' AND a.record_id IN (
            SELECT id FROM employes_diplomes WHERE employe_id = ?
          ))
      OR (a.table_name = 'employes_experiences' AND a.record_id IN (
            SELECT id FROM employes_experiences WHERE employe_id = ?
          ))
      OR (a.table_name = 'bulletins_salaire' AND a.record_id IN (
            SELECT id FROM bulletins_salaire WHERE employe_id = ?
          ))
    ORDER BY a.created_at DESC
    LIMIT 150
  `).all(agentId, agentId, agentId, agentId, agentId, agentId, agentId, agentId);
  res.json(rows);
});

// ─── Helper audit ─────────────────────────────────────────────────────────────
function audit(table, recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run(table, recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) { /* audit non bloquant */ }
}

// ─── Avances sur salaire ──────────────────────────────────────────────────────

router.get('/:id/avances', (req, res) => {
  const avances = db.prepare('SELECT * FROM employes_avances WHERE employe_id = ? ORDER BY date DESC').all(req.params.id);
  const stmtRmb = db.prepare('SELECT * FROM employes_avances_remboursements WHERE avance_id = ? ORDER BY date');
  res.json(avances.map(a => ({ ...a, remboursements: stmtRmb.all(a.id) })));
});

router.post('/:id/avances', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });

  const agent = db.prepare("SELECT id, statut_dossier, salaire_base FROM employes WHERE id = ?").get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  if (agent.statut_dossier !== 'actif')
    return res.status(400).json({ error: "L'agent doit être en statut actif pour recevoir une avance" });

  const { date, montant, motif = '', nb_echeances = 1, notes = '' } = req.body;
  if (!date || !montant || Number(montant) <= 0)
    return res.status(400).json({ error: 'Date et montant positif requis' });

  // Contrôle plafond (paramétrable : avance_plafond_mois × salaire_base)
  const plafondMois = parseFloat(
    db.prepare("SELECT valeur FROM parametres WHERE cle='avance_plafond_mois'").get()?.valeur || '1'
  );
  const plafond = plafondMois * (agent.salaire_base || 0);
  if (plafond > 0 && Number(montant) > plafond) {
    return res.status(400).json({
      error: `Montant (${montant} XAF) dépasse le plafond autorisé de ${plafond} XAF (${plafondMois}× salaire de base). Demandez une approbation DG pour dépasser ce plafond.`,
      code: 'PLAFOND_AVANCE_DEPASSE',
      plafond,
    });
  }

  const echeance = Math.round(Number(montant) / Math.max(1, nb_echeances));

  // Statut workflow initial = brouillon (plus de décaissement immédiat)
  const r = db.prepare(`
    INSERT INTO employes_avances
      (employe_id, date, montant, solde_restant, motif, nb_echeances,
       montant_echeance, notes, statut, statut_workflow, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_cours', 'brouillon', ?, datetime('now'))
  `).run(req.params.id, date, Number(montant), Number(montant),
         motif, nb_echeances, echeance, notes, req.user.id);

  audit('employes_avances', r.lastInsertRowid, 'create', { montant, motif }, req.user.id);

  // Notifier rh/finance de la nouvelle demande
  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
      const { creerNotification } = require('../services/notif');
      const notifUsers = db.prepare(
        "SELECT id FROM users WHERE actif=1 AND (role IN ('admin','rh','finance') OR roles LIKE '%\"rh\"%' OR roles LIKE '%\"finance\"%')"
      ).all();
      notifUsers.forEach(u => creerNotification({
        type: 'NOTIF_AVANCE_DEMANDE',
        titre: 'Nouvelle demande d\'avance sur salaire',
        message: `${emp?.nom} ${emp?.prenom} a une demande d'avance de ${new Intl.NumberFormat('fr-FR').format(montant)} XAF en attente de validation.`,
        srcTable: 'employes_avances', srcId: r.lastInsertRowid,
        destinataire_id: u.id,
      }));
    } catch (_) {}
  });

  res.status(201).json({
    id: r.lastInsertRowid, date, montant: Number(montant),
    solde_restant: Number(montant), motif,
    statut: 'en_cours', statut_workflow: 'brouillon',
    nb_echeances, montant_echeance: echeance, notes,
    remboursements: [],
  });
});

// ─── POST /:id/avances/:aid/soumettre ────────────────────────────────────────
router.post('/:id/avances/:aid/soumettre', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
  if (avance.statut_workflow !== 'brouillon')
    return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — soumission impossible` });

  if (hasRole(req.user, 'admin', 'finance', 'dg')) {
    db.prepare(`
      UPDATE employes_avances
      SET statut_workflow='approuve_dg', approuve_par=?, approuve_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, avance.id);
    audit('employes_avances', avance.id, 'soumettre_auto_approuver', { approuve_par: req.user.id }, req.user.id);
    return res.json({ ok: true, statut_workflow: 'approuve_dg', auto_approved: true });
  }

  db.prepare("UPDATE employes_avances SET statut_workflow='soumis', updated_at=datetime('now') WHERE id=?").run(avance.id);
  audit('employes_avances', avance.id, 'soumettre', null, req.user.id);

  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
      creerEntreeParapheur({
        type: 'avance_salaire',
        titre: `Avance salaire — ${emp?.nom || ''} ${emp?.prenom || ''} (${new Intl.NumberFormat('fr-FR').format(avance.montant)} XAF)`,
        initiateur_id: req.user.id,
        montant: avance.montant,
        ref_source_table: 'employes_avances',
        ref_source_id: avance.id,
      });
    } catch (_) {}
  });

  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
      const { creerNotification } = require('../services/notif');
      const dgs = db.prepare("SELECT id FROM users WHERE actif=1 AND (role IN ('admin','dg','finance') OR roles LIKE '%\"dg\"%')").all();
      dgs.forEach(u => creerNotification({
        type: 'NOTIF_AVANCE_DEMANDE',
        titre: 'Avance sur salaire soumise pour approbation',
        message: `Demande d'avance de ${emp?.nom} ${emp?.prenom} (${new Intl.NumberFormat('fr-FR').format(avance.montant)} XAF) soumise pour approbation.`,
        srcTable: 'employes_avances', srcId: avance.id, destinataire_id: u.id,
      }));
    } catch (_) {}
  });

  res.json({ ok: true, statut_workflow: 'soumis' });
});

// ─── POST /:id/avances/:aid/approuver ────────────────────────────────────────
router.post('/:id/avances/:aid/approuver', (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Rôle Finance, DG ou Admin requis pour approuver une avance' });

  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
  if (!['soumis', 'brouillon'].includes(avance.statut_workflow))
    return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — approbation impossible` });

  db.prepare(`
    UPDATE employes_avances
    SET statut_workflow='approuve_dg', approuve_par=?, approuve_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, avance.id);
  audit('employes_avances', avance.id, 'approuver', { approuve_par: req.user.id }, req.user.id);
  res.json({ ok: true, statut_workflow: 'approuve_dg' });
});

// ─── POST /:id/avances/:aid/decaisser ────────────────────────────────────────
router.post('/:id/avances/:aid/decaisser', (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'caissier'))
    return res.status(403).json({ error: 'Rôle Finance, Caissier ou Admin requis pour décaisser une avance' });

  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
  if (avance.statut_workflow !== 'approuve_dg')
    return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — décaissement impossible. L'avance doit être approuvée avant décaissement.` });
  if (avance.operation_id)
    return res.status(400).json({ error: 'Cette avance a déjà été décaissée' });

  const agent = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
  const { position_id } = req.body;

  // Récupérer la position (caisse) pour le décaissement
  const position = position_id
    ? db.prepare('SELECT id FROM positions WHERE id = ? AND actif = 1').get(position_id)
    : db.prepare("SELECT id FROM positions WHERE actif=1 AND type IN ('caisse','banque') ORDER BY ordre LIMIT 1").get();

  if (!position) return res.status(400).json({ error: 'Position de trésorerie introuvable — précisez position_id' });

  // Catégorie avance sur salaire
  const salCat = db.prepare(
    "SELECT id FROM categories WHERE type='depense' AND (lower(nom) LIKE '%avance%' OR lower(nom) LIKE '%salaire%') LIMIT 1"
  ).get();

  const tx = db.transaction(() => {
    // Créer le décaissement dans la caisse
    const libelle = `Avance sur salaire — ${agent.nom} ${agent.prenom}`;
    const opResult = db.prepare(`
      INSERT INTO operations
        (date, libelle, detail, tiers, montant, type_op, position_id,
         categorie_id, mode_reglement, employe_id, statut, created_by)
      VALUES (date('now'), ?, ?, ?, ?, 'decaissement', ?, ?, 'especes', ?, 'valide', ?)
    `).run(
      libelle, libelle,
      `${agent.nom} ${agent.prenom}`,
      avance.montant,
      position.id,
      salCat?.id || null,
      Number(req.params.id),
      req.user.id
    );

    // Lier l'opération à l'avance et passer en décaissé
    db.prepare(`
      UPDATE employes_avances
      SET statut_workflow='decaisse', operation_id=?, updated_at=datetime('now')
      WHERE id=?
    `).run(opResult.lastInsertRowid, avance.id);

    return opResult.lastInsertRowid;
  });

  const opId = tx();

  audit('employes_avances', avance.id, 'decaisser',
    { operation_id: opId, montant: avance.montant, position_id: position.id }, req.user.id);

  // Recalculer solde de la position
  setImmediate(() => {
    try {
      let recalc;
      try { ({ recalculateSoldes: recalc } = require('./operations')); } catch (_) {}
      if (recalc) recalc();
    } catch (_) {}
  });

  res.json({ ok: true, statut_workflow: 'decaisse', operation_id: opId, montant: avance.montant });
});

// ─── POST /:id/avances/:aid/rejeter ─────────────────────────────────────────
router.post('/:id/avances/:aid/rejeter', (req, res) => {
  if (!hasRole(req.user, 'admin', 'finance', 'dg'))
    return res.status(403).json({ error: 'Rôle Finance, DG ou Admin requis' });

  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
  if (['decaisse', 'solde', 'annule'].includes(avance.statut_workflow))
    return res.status(400).json({ error: `Avance déjà ${avance.statut_workflow} — rejet impossible` });

  const { motif_rejet } = req.body;
  if (!motif_rejet || !String(motif_rejet).trim())
    return res.status(400).json({ error: 'motif_rejet obligatoire' });

  db.prepare(`
    UPDATE employes_avances
    SET statut_workflow='rejete', statut='annule',
        rejete_par=?, rejete_at=datetime('now'),
        motif_rejet=?, updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, String(motif_rejet).trim(), avance.id);

  audit('employes_avances', avance.id, 'rejeter', { motif_rejet }, req.user.id);

  // Notifier le demandeur
  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
      const { creerNotification } = require('../services/notif');
      const createur = db.prepare('SELECT id FROM users WHERE id=?').get(avance.created_by);
      if (createur) {
        creerNotification({
          type: 'NOTIF_AVANCE_DEMANDE',
          titre: 'Demande d\'avance rejetée',
          message: `La demande d'avance de ${emp?.nom} ${emp?.prenom} (${new Intl.NumberFormat('fr-FR').format(avance.montant)} XAF) a été rejetée. Motif : ${motif_rejet}`,
          srcTable: 'employes_avances', srcId: avance.id, destinataire_id: createur.id,
        });
      }
    } catch (_) {}
  });

  res.json({ ok: true, statut_workflow: 'rejete' });
});

// Remboursement partiel
router.post('/:id/avances/:aid/remboursements', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance non trouvée' });
  if (avance.statut !== 'en_cours') return res.status(400).json({ error: 'Avance non active' });

  const { date, montant, notes = '' } = req.body;
  if (!date || !montant || montant <= 0) return res.status(400).json({ error: 'Date et montant positif requis' });
  if (montant > avance.solde_restant) return res.status(400).json({ error: `Montant dépasse le solde restant (${avance.solde_restant} XAF)` });

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO employes_avances_remboursements (avance_id,date,montant,notes,created_by) VALUES (?,?,?,?,?)').run(avance.id, date, montant, notes, req.user.id);
    const nouveau_solde = avance.solde_restant - montant;
    const nouveau_statut = nouveau_solde <= 0 ? 'rembourse' : 'en_cours';
    db.prepare("UPDATE employes_avances SET solde_restant=?, montant_rembourse=COALESCE(montant_rembourse,0)+?, statut=?, updated_at=datetime('now') WHERE id=?")
      .run(nouveau_solde, montant, nouveau_statut, avance.id);
  });
  tx();
  audit('employes_avances', avance.id, 'remboursement_partiel', { montant, notes }, req.user.id);
  res.status(201).json({ ok: true, solde_restant: avance.solde_restant - montant });
});

// Annulation logique (remplace DELETE)
router.put('/:id/avances/:aid/annuler', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
  if (!avance) return res.status(404).json({ error: 'Avance non trouvée' });
  if (avance.statut === 'annule') return res.status(400).json({ error: 'Avance déjà annulée' });

  // Vérifier si liée à une opération caisse
  const op = db.prepare("SELECT id FROM operations WHERE employe_id = ? AND statut = 'valide' AND libelle LIKE '%avance%' ORDER BY id DESC LIMIT 1").get(req.params.id);
  const { motif = '' } = req.body;

  db.prepare("UPDATE employes_avances SET statut='annule', annule_at=datetime('now'), annule_by=?, annule_motif=?, updated_at=datetime('now') WHERE id=?")
    .run(req.user.id, motif, avance.id);
  audit('employes_avances', avance.id, 'annule', { motif, liee_operation: !!op }, req.user.id);
  res.json({ ok: true, info: op ? 'Avance annulée — une opération caisse liée peut exister' : null });
});

// ─── Tous les congés (vue globale) ───────────────────────────────────────────
// ─── Helpers congés ───────────────────────────────────────────────────────────

function param(cle, defaut) {
  const row = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle);
  return row ? row.valeur : defaut;
}

function calculerSoldeConge(employeId) {
  const annee = new Date().getFullYear().toString();
  const emp = db.prepare('SELECT date_embauche, conges_report_n1, type FROM employes WHERE id = ?').get(employeId);
  if (!emp) return null;

  let acquis = 0;
  let warningNoEmbauche = false;

  if (!emp.date_embauche) {
    warningNoEmbauche = true;
  } else {
    const tauxParMois = parseFloat(param('conges_jours_par_mois', '2.5'));
    const embauche    = new Date(emp.date_embauche);
    const now         = new Date();
    const debutAnnee  = new Date(now.getFullYear(), 0, 1);
    const refDebut    = embauche > debutAnnee ? embauche : debutAnnee;
    const moisEcoules = (now.getFullYear() - refDebut.getFullYear()) * 12
                      + (now.getMonth() - refDebut.getMonth())
                      + (now.getDate() >= refDebut.getDate() ? 1 : 0);
    const moisCapes   = Math.min(Math.max(0, moisEcoules), 12);
    acquis = Math.round(moisCapes * tauxParMois * 2) / 2; // arrondi au 0.5
    acquis = Math.min(acquis, 30); // plafond légal
  }

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN statut IN ('approuve','termine') THEN nb_jours ELSE 0 END), 0) AS pris,
      COALESCE(SUM(CASE WHEN statut IN ('demande','valide_sup') THEN nb_jours ELSE 0 END), 0) AS en_attente
    FROM employes_conges
    WHERE employe_id = ?
      AND type_conge = 'annuel'
      AND strftime('%Y', date_debut) = ?
  `).get(employeId, annee);

  const pris       = row.pris       || 0;
  const enAttente  = row.en_attente || 0;
  const report     = parseFloat(emp.conges_report_n1 || 0);
  const solde      = Math.round((acquis + report - pris) * 10) / 10;

  return { acquis, pris, solde, report, en_attente: enAttente,
           solde_apres_attente: Math.round((solde - enAttente) * 10) / 10,
           warning_no_embauche: warningNoEmbauche };
}

function mettreAJourSoldeConge(employeId) {
  const s = calculerSoldeConge(employeId);
  if (!s) return;
  db.prepare(`
    UPDATE employes
    SET conges_acquis_annuel = ?,
        conges_pris_annuel   = ?,
        conges_solde_annuel  = ?
    WHERE id = ?
  `).run(s.acquis, s.pris, s.solde, employeId);
}

// ─── GET /conges/all ──────────────────────────────────────────────────────────

router.get('/conges/all', (req, res) => {
  const { statut, mois, annee, employe_id, type_conge } = req.query;
  let where = '1=1';
  const params = [];
  if (statut)     { where += ' AND c.statut = ?';                              params.push(statut); }
  if (employe_id) { where += ' AND c.employe_id = ?';                         params.push(employe_id); }
  if (annee)      { where += " AND strftime('%Y', c.date_debut) = ?";          params.push(annee); }
  if (mois)       { where += " AND strftime('%m', c.date_debut) = ?";          params.push(String(mois).padStart(2,'0')); }
  if (type_conge) { where += ' AND c.type_conge = ?';                          params.push(type_conge); }

  const rows = db.prepare(`
    SELECT c.*,
      e.nom || ' ' || e.prenom AS employe_nom, e.poste, e.departement,
      ua.nom AS approuve_par_nom,
      ur.nom AS refuse_par_nom
    FROM employes_conges c
    JOIN employes e ON e.id = c.employe_id
    LEFT JOIN users ua ON ua.id = c.approuve_par
    LEFT JOIN users ur ON ur.id = c.refuse_par
    WHERE ${where}
    ORDER BY c.date_debut DESC
    LIMIT 200
  `).all(...params);
  res.json(rows);
});

// ─── GET /conges/all/export-csv ───────────────────────────────────────────────

router.get('/conges/all/export-csv', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { statut, annee, employe_id, type_conge } = req.query;
  let where = '1=1';
  const params = [];
  if (statut)     { where += ' AND c.statut = ?';                params.push(statut); }
  if (employe_id) { where += ' AND c.employe_id = ?';           params.push(employe_id); }
  if (annee)      { where += " AND strftime('%Y', c.date_debut) = ?"; params.push(annee); }
  if (type_conge) { where += ' AND c.type_conge = ?';           params.push(type_conge); }

  const rows = db.prepare(`
    SELECT c.*, e.nom, e.prenom, e.poste, e.departement,
      ua.nom AS approuve_par_nom, ur.nom AS refuse_par_nom
    FROM employes_conges c
    JOIN employes e ON e.id = c.employe_id
    LEFT JOIN users ua ON ua.id = c.approuve_par
    LEFT JOIN users ur ON ur.id = c.refuse_par
    WHERE ${where}
    ORDER BY c.date_debut DESC
    LIMIT 2000
  `).all(...params);

  const TYPE_LABELS = {
    annuel:'Annuel', maladie:'Maladie', maternite:'Maternité',
    paternite:'Paternité', evenement_familial:'Événement familial',
    sans_solde:'Sans solde', autre:'Autre'
  };
  const BOM = '﻿';
  const SEP = ';';
  const headers = ['Agent','Poste','Département','Type de congé','Date début','Date fin',
                   'Nb jours','Statut','Motif','Approbateur','Date approbation','Motif refus','Annulé par'];
  const csvRows = rows.map(r => [
    `"${r.nom} ${r.prenom}"`, r.poste || '', r.departement || '',
    TYPE_LABELS[r.type_conge] || r.type_conge,
    r.date_debut, r.date_fin, r.nb_jours, r.statut,
    `"${(r.motif || '').replace(/"/g,'""')}"`,
    r.approuve_par_nom || '', r.approuve_at ? r.approuve_at.slice(0,10) : '',
    `"${(r.refuse_motif || '').replace(/"/g,'""')}"`,
    r.annule_by ? (db.prepare('SELECT nom FROM users WHERE id=?').get(r.annule_by)?.nom || '') : ''
  ].join(SEP));

  const label = annee || new Date().getFullYear();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="absences-${label}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
});

// ─── GET /conges/calendrier — impact calendrier mensuel ───────────────────────
// Retourne, pour un mois/année donnés, la liste des congés approuvés ou en cours
// de workflow (demande, valide_sup), groupés par jour, pour affichage calendrier.

router.get('/conges/calendrier', (req, res) => {
  const annee = parseInt(req.query.annee) || new Date().getFullYear();
  const mois  = parseInt(req.query.mois)  || (new Date().getMonth() + 1);
  const pad   = n => String(n).padStart(2, '0');
  const debut = `${annee}-${pad(mois)}-01`;
  const fin   = `${annee}-${pad(mois)}-31`;

  const rows = db.prepare(`
    SELECT c.id, c.employe_id, c.type_conge, c.date_debut, c.date_fin,
           c.nb_jours, c.statut, c.motif,
           e.nom || ' ' || e.prenom AS employe_nom,
           e.poste, e.departement
    FROM employes_conges c
    JOIN employes e ON e.id = c.employe_id AND e.actif = 1
    WHERE c.statut IN ('demande','valide_sup','approuve','termine')
      AND c.date_debut <= ? AND c.date_fin >= ?
    ORDER BY c.date_debut, e.nom
  `).all(fin, debut);

  // Construire une map jour → événements
  const calendar = {};
  for (const cg of rows) {
    const d0 = new Date(cg.date_debut);
    const d1 = new Date(cg.date_fin);
    const cur = new Date(Math.max(d0, new Date(debut)));
    const max = new Date(Math.min(d1, new Date(fin)));
    while (cur <= max) {
      const key = cur.toISOString().slice(0, 10);
      if (!calendar[key]) calendar[key] = [];
      calendar[key].push({
        conge_id:     cg.id,
        employe_id:   cg.employe_id,
        employe_nom:  cg.employe_nom,
        poste:        cg.poste,
        departement:  cg.departement,
        type_conge:   cg.type_conge,
        statut:       cg.statut,
        motif:        cg.motif,
        date_debut:   cg.date_debut,
        date_fin:     cg.date_fin,
        nb_jours:     cg.nb_jours,
      });
      cur.setDate(cur.getDate() + 1);
    }
  }

  res.json({ annee, mois, calendar, conges: rows });
});

// ─── Congés & absences ────────────────────────────────────────────────────────

router.get('/:id/conges', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, ua.nom AS approuve_par_nom, ur.nom AS refuse_par_nom
    FROM employes_conges c
    LEFT JOIN users ua ON ua.id = c.approuve_par
    LEFT JOIN users ur ON ur.id = c.refuse_par
    WHERE c.employe_id = ?
    ORDER BY c.date_debut DESC
  `).all(req.params.id);
  res.json(rows);
});

// B2 — Solde congés d'un agent (calcul temps réel)
router.get('/:id/conges/solde', (req, res) => {
  const emp = db.prepare(
    'SELECT id, conges_maladie_droit, conges_maladie_pris, conges_maladie_solde FROM employes WHERE id = ? AND actif = 1'
  ).get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Agent non trouvé' });
  const solde = calculerSoldeConge(req.params.id);
  res.json({
    ...solde,
    maladie: {
      droit:  emp.conges_maladie_droit  ?? 15,
      pris:   emp.conges_maladie_pris   ?? 0,
      solde:  emp.conges_maladie_solde  ?? 15,
    },
  });
});

// B1 — Ajuster le report N-1 (admin uniquement)
router.put('/:id/conges/solde/report', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const { jours_report } = req.body;
  const maxReport = parseFloat(param('conges_report_max_jours', '15'));
  if (jours_report === undefined || jours_report < 0)
    return res.status(400).json({ error: 'jours_report doit être ≥ 0' });
  if (jours_report > maxReport)
    return res.status(400).json({ error: `Report maximum autorisé : ${maxReport} jours` });
  db.prepare('UPDATE employes SET conges_report_n1 = ? WHERE id = ?').run(jours_report, req.params.id);
  mettreAJourSoldeConge(req.params.id);
  audit('employes', Number(req.params.id), 'report_conge', { jours_report }, req.user.id);
  res.json({ ok: true, jours_report, solde: calculerSoldeConge(req.params.id) });
});

router.post('/:id/conges', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { type_conge = 'annuel', date_debut, date_fin, motif = '', notes = '',
          force_creation = false } = req.body;
  if (!date_debut || !date_fin) return res.status(400).json({ error: 'Dates requises' });
  if (date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });

  const emp = db.prepare("SELECT id, statut_dossier FROM employes WHERE id = ?").get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Agent non trouvé' });
  if (emp.statut_dossier !== 'actif') return res.status(400).json({ error: 'L\'agent doit être en statut actif' });

  const nb_jours = Math.max(1, Math.round((new Date(date_fin) - new Date(date_debut)) / (1000 * 60 * 60 * 24)) + 1);

  // Préavis minimum (sauf congé maladie)
  if (type_conge !== 'maladie') {
    const preavisMin = parseInt(param('conges_preavis_min_jours', '3'), 10);
    const diff = Math.round((new Date(date_debut) - new Date()) / (1000 * 60 * 60 * 24));
    if (diff < preavisMin) {
      return res.status(400).json({ error: `Préavis minimum de ${preavisMin} jours requis (${diff} jour(s) donné(s))` });
    }
  }

  // Chevauchement avec congés approuvés
  const overlap = db.prepare(`
    SELECT id, date_debut, date_fin FROM employes_conges
    WHERE employe_id = ? AND statut = 'approuve'
    AND date_debut <= ? AND date_fin >= ?
  `).get(req.params.id, date_fin, date_debut);
  if (overlap) return res.status(409).json({
    error: `Chevauchement avec un congé approuvé du ${overlap.date_debut} au ${overlap.date_fin}`
  });

  // Contrôle solde selon le type de congé
  if (type_conge === 'annuel') {
    const solde = calculerSoldeConge(req.params.id);
    if (solde && nb_jours > solde.solde && !force_creation && !hasRole(req.user, 'admin')) {
      return res.status(400).json({
        error:        `Solde insuffisant : ${solde.solde} jour(s) disponible(s), ${nb_jours} demandé(s)`,
        solde_actuel: solde.solde,
        nb_jours,
        solde
      });
    }
  }

  if (type_conge === 'maladie') {
    // Certificat médical obligatoire
    const { document_url } = req.body;
    if (!document_url && !req.body.certificat_medical) {
      return res.status(400).json({
        error: 'Certificat médical obligatoire pour un congé maladie. Joignez le document via document_url.',
        code: 'CERTIFICAT_REQUIS',
      });
    }

    // Contrôle solde maladie
    const agentMal = db.prepare('SELECT conges_maladie_solde FROM employes WHERE id=?').get(req.params.id);
    const soldeMaladie = agentMal?.conges_maladie_solde ?? 15;

    if (nb_jours > soldeMaladie && !force_creation && !hasRole(req.user, 'admin')) {
      if (soldeMaladie <= 0) {
        // Solde maladie épuisé → basculement automatique sur sans_solde avec alerte
        return res.status(400).json({
          error: `Solde congés maladie épuisé (${soldeMaladie} j). Ce congé sera enregistré en congé sans solde si vous confirmez avec force_creation=true.`,
          code: 'SOLDE_MALADIE_EPUISE',
          solde_maladie: soldeMaladie,
          suggestion: 'Ajoutez force_creation: true pour basculer en congé sans solde',
        });
      }
      return res.status(400).json({
        error:          `Solde maladie insuffisant : ${soldeMaladie} j disponible(s), ${nb_jours} demandé(s)`,
        solde_maladie:  soldeMaladie,
        nb_jours,
      });
    }
  }

  // Déterminer le type effectif (si solde maladie épuisé + force_creation → sans_solde)
  let type_conge_effectif = type_conge;
  if (type_conge === 'maladie' && force_creation) {
    const agentMalCheck = db.prepare('SELECT conges_maladie_solde FROM employes WHERE id=?').get(req.params.id);
    if ((agentMalCheck?.conges_maladie_solde ?? 15) <= 0) {
      type_conge_effectif = 'sans_solde';
      // Notifier RH du basculement
      setImmediate(() => {
        try {
          const { creerNotification } = require('../services/notif');
          const empMal = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
          const rhs = db.prepare("SELECT id FROM users WHERE actif=1 AND (role IN ('admin','dg','rh') OR roles LIKE '%\"dg\"%' OR roles LIKE '%\"rh\"%')").all();
          rhs.forEach(u => creerNotification({
            type: 'NOTIF_CONGE_BASCULE_SANS_SOLDE',
            titre: 'Congé maladie basculé en sans solde',
            message: `Solde maladie épuisé pour ${empMal?.nom} ${empMal?.prenom} — congé du ${date_debut} au ${date_fin} enregistré en congé sans solde.`,
            srcTable: 'employes_conges', destinataire_id: u.id,
          }));
        } catch (_) {}
      });
    }
  }

  const r = db.prepare(
    'INSERT INTO employes_conges (employe_id,type_conge,date_debut,date_fin,nb_jours,motif,notes,created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).run(req.params.id, type_conge_effectif, date_debut, date_fin, nb_jours, motif, notes, req.user.id);

  audit('employes_conges', r.lastInsertRowid, 'create', { type_conge, date_debut, date_fin, nb_jours }, req.user.id);

  // Connecteur parapheur (non bloquant)
  setImmediate(() => {
    const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(req.params.id);
    const empNom = emp ? `${emp.nom} ${emp.prenom}` : `Employé #${req.params.id}`;
    creerEntreeParapheur({
      type: 'conge',
      titre: `Congé ${type_conge} — ${empNom} (${date_debut} → ${date_fin}, ${nb_jours}j)`,
      initiateur_id: req.user.id,
      ref_source_table: 'employes_conges',
      ref_source_id: r.lastInsertRowid,
    });
  });

  // Notification email aux responsables RH/admin
  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom, email FROM employes WHERE id=?').get(req.params.id);
      const rhUsers = db.prepare("SELECT email FROM users WHERE actif=1 AND email IS NOT NULL AND email != '' AND (role IN ('admin','dg','rh') OR roles LIKE '%\"dg\"%' OR roles LIKE '%\"rh\"%' OR roles LIKE '%\"admin\"%')").all();
      for (const u of rhUsers) {
        if (u.email) {
          sendCongeNotification({
            to: u.email, employe_nom: `${emp?.nom} ${emp?.prenom}`,
            action: 'demande', date_debut, date_fin, nb_jours, type_conge, motif,
          }).catch(() => {});
        }
      }
    } catch (_) {}
  });

  res.status(201).json({ id: r.lastInsertRowid, type_conge, date_debut, date_fin, nb_jours, motif, statut: 'demande', notes });
});

// B3a — Validation supérieur hiérarchique (étape intermédiaire facultative)
// Si le paramètre conges_workflow_sup = '1', l'approbation DG/RH requiert que le
// supérieur ait d'abord validé (statut 'valide_sup'). Sinon, cette étape est
// optionnelle et l'approbation DG/RH peut intervenir directement depuis 'demande'.
router.put('/:id/conges/:cid/valider-sup', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Validation supérieur réservée DG, RH ou Admin' });

  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (conge.statut !== 'demande')
    return res.status(400).json({ error: `Impossible de valider : statut actuel "${conge.statut}" (attendu: "demande")` });

  const { notes = '' } = req.body;

  db.prepare(`
    UPDATE employes_conges
    SET statut='valide_sup', valide_sup_par=?, valide_sup_at=datetime('now'),
        valide_sup_notes=?, updated_by=?, updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, notes.trim() || null, req.user.id, conge.id);

  audit('employes_conges', conge.id, 'valide_sup',
    { valide_par: req.user.id, notes: notes.trim() }, req.user.id);

  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom, email FROM employes WHERE id=?').get(req.params.id);
      creerNotification({
        type:      'NOTIF_CONGE_VALIDE_SUP',
        titre:     'Congé validé par le supérieur',
        message:   `Le congé de ${emp?.nom} ${emp?.prenom} du ${conge.date_debut} au ${conge.date_fin} (${conge.nb_jours}j) a été validé par le supérieur et attend l'approbation DG/RH.`,
        srcTable:  'employes_conges',
        srcId:     conge.id,
        createdBy: req.user.id,
      });
      // Email RH
      const rhUsers = db.prepare("SELECT email FROM users WHERE actif=1 AND email IS NOT NULL AND email != '' AND (role IN ('admin','dg','rh') OR roles LIKE '%\"dg\"%' OR roles LIKE '%\"rh\"%' OR roles LIKE '%\"admin\"%')").all();
      for (const u of rhUsers) {
        if (u.email) {
          sendCongeNotification({
            to: u.email, employe_nom: `${emp?.nom} ${emp?.prenom}`,
            action: 'valide_sup', date_debut: conge.date_debut, date_fin: conge.date_fin,
            nb_jours: conge.nb_jours, type_conge: conge.type_conge, motif: notes.trim(),
            par_nom: req.user.nom,
          }).catch(() => {});
        }
      }
    } catch (_) {}
  });

  res.json({ ok: true, statut: 'valide_sup' });
});

// B3 — Approuver un congé (avec solde + traçabilité)
// Accepte aussi le statut 'valide_sup' (après validation supérieur)
router.put('/:id/conges/:cid/approuver', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle DG, RH ou Admin requis' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });

  // Vérifier que l'étape supérieur a été franchie si le workflow est activé
  const workflowSup = (db.prepare("SELECT valeur FROM parametres WHERE cle='conges_workflow_sup'").get()?.valeur || '1') === '1';
  const statutsValides = workflowSup ? ['valide_sup'] : ['demande', 'valide_sup'];
  if (!statutsValides.includes(conge.statut))
    return res.status(400).json({
      error: workflowSup
        ? `Approbation DG/RH impossible : le congé doit d'abord être validé par le supérieur (statut actuel : "${conge.statut}")`
        : `Impossible d'approuver un congé en statut "${conge.statut}"`,
      statut_actuel: conge.statut,
    });

  // Re-vérification chevauchement (race condition)
  const overlap = db.prepare(`
    SELECT id, date_debut, date_fin FROM employes_conges
    WHERE employe_id = ? AND statut = 'approuve' AND id != ?
    AND date_debut <= ? AND date_fin >= ?
  `).get(req.params.id, req.params.cid, conge.date_fin, conge.date_debut);
  if (overlap) return res.status(409).json({
    error: `Chevauchement avec un congé approuvé du ${overlap.date_debut} au ${overlap.date_fin}`
  });

  // Transaction atomique : approbation + mise à jour solde
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE employes_conges
      SET statut='approuve', approuve_par=?, approuve_at=datetime('now'),
          updated_by=?, updated_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, req.user.id, conge.id);

    // Décrémenter les soldes selon le type de congé
    if (conge.type_conge === 'annuel') {
      db.prepare(`
        UPDATE employes
        SET conges_pris_annuel  = conges_pris_annuel + ?,
            conges_solde_annuel = conges_solde_annuel - ?
        WHERE id = ?
      `).run(conge.nb_jours, conge.nb_jours, req.params.id);
    } else if (conge.type_conge === 'maladie') {
      // Décrémenter le compteur maladie séparé
      db.prepare(`
        UPDATE employes
        SET conges_maladie_pris  = COALESCE(conges_maladie_pris, 0) + ?,
            conges_maladie_solde = MAX(0, COALESCE(conges_maladie_solde, 15) - ?)
        WHERE id = ?
      `).run(conge.nb_jours, conge.nb_jours, req.params.id);
    }
  });
  tx();

  audit('employes_conges', conge.id, 'approuve',
    { date_debut: conge.date_debut, date_fin: conge.date_fin, nb_jours: conge.nb_jours, approuve_par: req.user.id },
    req.user.id);

  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom, email FROM employes WHERE id=?').get(req.params.id);
      creerNotification({
        type:     'NOTIF_CONGE_APPROUVE',
        titre:    'Congé approuvé',
        message:  `Le congé de ${emp?.nom} ${emp?.prenom} du ${conge.date_debut} au ${conge.date_fin} (${conge.nb_jours}j) a été approuvé.`,
        srcTable: 'employes_conges',
        srcId:    conge.id,
        createdBy: req.user.id,
      });
      // Email à l'employé si son email est renseigné
      if (emp?.email) {
        sendCongeNotification({
          to: emp.email, employe_nom: `${emp.nom} ${emp.prenom}`,
          action: 'approuve', date_debut: conge.date_debut, date_fin: conge.date_fin,
          nb_jours: conge.nb_jours, type_conge: conge.type_conge,
          par_nom: req.user.nom,
        }).catch(() => {});
      }
    } catch (_) {}
  });

  res.json({ ok: true, solde: calculerSoldeConge(req.params.id) });
});

// Bug fix — Refuser : écrit dans refuse_motif (plus dans annule_motif)
router.put('/:id/conges/:cid/refuser', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (['refuse','annule','termine'].includes(conge.statut))
    return res.status(400).json({ error: `Congé déjà en statut "${conge.statut}"` });
  const { motif = '' } = req.body;
  if (!motif.trim()) return res.status(400).json({ error: 'Motif de refus obligatoire' });

  db.prepare(`
    UPDATE employes_conges
    SET statut='refuse', refuse_par=?, refuse_at=datetime('now'),
        refuse_motif=?, updated_by=?, updated_at=datetime('now')
    WHERE id=?
  `).run(req.user.id, motif.trim(), req.user.id, conge.id);
  audit('employes_conges', conge.id, 'refuse', { motif: motif.trim(), refuse_par: req.user.id }, req.user.id);

  setImmediate(() => {
    try {
      const emp = db.prepare('SELECT nom, prenom, email FROM employes WHERE id=?').get(req.params.id);
      creerNotification({
        type:     'NOTIF_CONGE_REFUSE',
        titre:    'Congé refusé',
        message:  `Le congé de ${emp?.nom} ${emp?.prenom} du ${conge.date_debut} au ${conge.date_fin} a été refusé. Motif : ${motif.trim()}.`,
        srcTable: 'employes_conges',
        srcId:    conge.id,
        createdBy: req.user.id,
      });
      if (emp?.email) {
        sendCongeNotification({
          to: emp.email, employe_nom: `${emp.nom} ${emp.prenom}`,
          action: 'refuse', date_debut: conge.date_debut, date_fin: conge.date_fin,
          nb_jours: conge.nb_jours, type_conge: conge.type_conge, motif: motif.trim(),
          par_nom: req.user.nom,
        }).catch(() => {});
      }
    } catch (_) {}
  });

  res.json({ ok: true });
});

// Terminer un congé (inchangé dans la logique, ajout audit complet)
router.put('/:id/conges/:cid/terminer', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (conge.statut !== 'approuve') return res.status(400).json({ error: 'Seul un congé approuvé peut être terminé' });
  db.prepare("UPDATE employes_conges SET statut='termine', updated_by=?, updated_at=datetime('now') WHERE id=?").run(req.user.id, conge.id);
  audit('employes_conges', conge.id, 'termine', { nb_jours: conge.nb_jours }, req.user.id);
  res.json({ ok: true });
});

// Bug fix — Annuler : statut 'annule' (pas 'refuse') + recrédite solde si approuvé
router.put('/:id/conges/:cid/annuler', (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin requis' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (['annule','termine'].includes(conge.statut))
    return res.status(400).json({ error: `Congé déjà en statut "${conge.statut}"` });
  const { motif = '' } = req.body;
  if (!motif.trim()) return res.status(400).json({ error: 'Motif d\'annulation obligatoire' });

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE employes_conges
      SET statut='annule', annule_statut=?, annule_at=datetime('now'),
          annule_by=?, annule_motif=?, updated_at=datetime('now')
      WHERE id=?
    `).run(conge.statut, req.user.id, motif.trim(), conge.id);

    // Recréditer le solde si le congé était approuvé (annuel uniquement)
    if (conge.statut === 'approuve' && conge.type_conge === 'annuel') {
      db.prepare(`
        UPDATE employes
        SET conges_pris_annuel  = MAX(0, conges_pris_annuel - ?),
            conges_solde_annuel = conges_solde_annuel + ?
        WHERE id = ?
      `).run(conge.nb_jours, conge.nb_jours, req.params.id);
    }
  });
  tx();

  audit('employes_conges', conge.id, 'annule',
    { motif: motif.trim(), annule_statut: conge.statut, nb_jours: conge.nb_jours }, req.user.id);
  res.json({ ok: true, solde: calculerSoldeConge(req.params.id) });
});

// ─── Upload photo agent ───────────────────────────────────────────────────────

router.post('/:id/photo', upload.single('photo'), (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  // Supprimer l'ancienne photo si elle existe
  const agent = db.prepare('SELECT photo_url FROM employes WHERE id = ?').get(req.params.id);
  if (agent?.photo_url) {
    const old = path.join(uploadsDir, path.basename(agent.photo_url));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  const photoUrl = '/uploads/' + req.file.filename;
  db.prepare('UPDATE employes SET photo_url = ? WHERE id = ?').run(photoUrl, req.params.id);
  res.json({ ok: true, photo_url: photoUrl });
});

// ─── Supprimer photo agent ────────────────────────────────────────────────────

router.delete('/:id/photo', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const agent = db.prepare('SELECT photo_url FROM employes WHERE id = ?').get(req.params.id);
  if (agent?.photo_url) {
    const filePath = path.join(uploadsDir, path.basename(agent.photo_url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('UPDATE employes SET photo_url = NULL WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ─── GET /export-csv — Export CSV liste des agents ────────────────────────────

router.get('/export-csv', (req, res) => {
  const { statut_dossier, type } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (statut_dossier) { where += ' AND statut_dossier = ?'; params.push(statut_dossier); }
  if (type)           { where += ' AND type = ?'; params.push(type); }

  const rows = db.prepare(`
    SELECT nom, prenom, poste, departement, type, statut_dossier,
           date_naissance, lieu_naissance, sexe, nationalite, telephone, email,
           type_contrat, date_embauche, date_fin_contrat, date_fin_essai AS periode_essai_fin,
           salaire_base, prime_transport, prime_logement,
           mode_paiement, banque, numero_compte,
           cnss, camu, num_piece_identite, type_piece_identite,
           created_at
    FROM employes
    ${where}
    ORDER BY nom, prenom
  `).all(...params);

  const BOM = '﻿';
  const SEP = ';';
  const headers = [
    'Nom','Prénom','Poste','Département','Type contrat','Statut dossier',
    'Date naissance','Lieu naissance','Sexe','Nationalité','Téléphone','Email',
    'Type contrat','Date embauche','Fin contrat','Fin essai',
    'Salaire base','Prime transport','Prime logement',
    'Mode paiement','Banque','N° compte (masqué)',
    'N° CNSS','N° CAMU','Pièce identité','Type pièce','Date création'
  ];
  const csvRows = rows.map(r => [
    `"${(r.nom || '').replace(/"/g,'""')}"`,
    `"${(r.prenom || '').replace(/"/g,'""')}"`,
    r.poste || '', r.departement || '', r.type || '', r.statut_dossier || '',
    r.date_naissance || '', r.lieu_naissance || '', r.sexe || '', r.nationalite || '',
    r.telephone || '', r.email || '',
    r.type_contrat || '', r.date_embauche || '', r.date_fin_contrat || '', r.periode_essai_fin || '',
    r.salaire_base || 0, r.prime_transport || 0, r.prime_logement || 0,
    r.mode_paiement || '',
    r.banque || '',
    r.numero_compte ? `****${String(r.numero_compte).slice(-4)}` : '', // masqué
    r.cnss || '', r.camu || '',
    r.num_piece_identite || '', r.type_piece_identite || '',
    (r.created_at || '').slice(0,10)
  ].join(SEP));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="agents-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(BOM + [headers.join(SEP), ...csvRows].join('\n'));
});

// ─── PUT /:id/lier-contrat — Lier un contrat de travail au dossier agent ──────
router.put('/:id/lier-contrat', (req, res) => {
  if (!hasRole(req.user, 'admin', 'rh', 'finance'))
    return res.status(403).json({ error: 'Rôle RH, Finance ou Admin requis' });

  const agent = db.prepare('SELECT id, nom, prenom, contrat_id FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const { contrat_id } = req.body;

  if (contrat_id === null || contrat_id === undefined || contrat_id === '') {
    // Délier
    db.prepare("UPDATE employes SET contrat_id=NULL, updated_at=datetime('now') WHERE id=?").run(agent.id);
    audit('employes', agent.id, 'delier_contrat',
      { ancien_contrat_id: agent.contrat_id }, req.user.id);
    return res.json({ ok: true, contrat_id: null });
  }

  const contrat = db.prepare('SELECT id, numero, statut, type_contrat FROM contrats WHERE id = ?').get(contrat_id);
  if (!contrat) return res.status(404).json({ error: 'Contrat introuvable' });

  db.prepare("UPDATE employes SET contrat_id=?, updated_at=datetime('now') WHERE id=?")
    .run(contrat.id, agent.id);

  audit('employes', agent.id, 'lier_contrat', {
    contrat_id: contrat.id,
    contrat_numero: contrat.numero,
    ancien_contrat_id: agent.contrat_id,
  }, req.user.id);

  res.json({ ok: true, contrat_id: contrat.id, contrat_numero: contrat.numero, contrat_statut: contrat.statut });
});

// ─── PUT /:id/salaire — Modification rémunération (protégée + tracée) ────────
//
// Règle métier n°1 : aucun salaire validé ne se modifie directement sans trace.
// Cette route est la seule voie légale pour modifier salaire_base, prime_transport,
// prime_logement. Elle insère automatiquement dans historique_salaires.

function handleSalaireUpdate(req, res, agentArg) {
  const empId  = Number(req.params.id);
  const agent  = agentArg || db.prepare(
    'SELECT id, nom, prenom, salaire_base, prime_transport, prime_logement, statut_dossier FROM employes WHERE id = ?'
  ).get(empId);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  if (!canSalary(req.user))
    return res.status(403).json({ error: 'Rôle RH, Finance ou DG requis' });

  const salaryRevision = validateSalaryRevisionPayload({ empId, agent, body: req.body });
  if (salaryRevision.error) {
    return res.status(salaryRevision.error.status).json(salaryRevision.error.body);
  }
  const { nouveauSalaire, nouveauTransport, nouveauLogement } = salaryRevision.values;

  // Appliquer la modification
  db.prepare(`
    UPDATE employes
    SET salaire_base=?, prime_transport=?, prime_logement=?, updated_at=datetime('now')
    WHERE id=?
  `).run(nouveauSalaire, nouveauTransport, nouveauLogement, empId);

  auditSalaryRevision(empId, agent, salaryRevision.values, req.user.id);

  res.json({ ok: true, salaire_base: nouveauSalaire, prime_transport: nouveauTransport, prime_logement: nouveauLogement });
}

// Route explicite PUT /:id/salaire
router.put('/:id/salaire', (req, res) => {
  if (!canSalary(req.user))
    return res.status(403).json({ error: 'Rôle RH, Finance ou DG requis pour modifier la rémunération' });
  handleSalaireUpdate(req, res, null);
});

// ─── GET /:id/historique-salaires — Historique des révisions salariales ───────
router.get('/:id/historique-salaires', (req, res) => {
  const agent = db.prepare('SELECT id, nom, prenom FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  const historique = db.prepare(`
    SELECT h.*,
           u1.nom AS created_by_nom,
           u2.nom AS approved_by_nom,
           gc_old.code AS ancienne_categorie_code, gc_old.libelle AS ancienne_categorie_libelle,
           gc_new.code AS nouvelle_categorie_code, gc_new.libelle AS nouvelle_categorie_libelle,
           ge_old.echelon AS ancien_echelon_num,
           ge_new.echelon AS nouvel_echelon_num
    FROM historique_salaires h
    LEFT JOIN users u1 ON u1.id = h.created_by
    LEFT JOIN users u2 ON u2.id = h.approved_by
    LEFT JOIN grille_categories gc_old ON gc_old.id = h.ancienne_categorie_id
    LEFT JOIN grille_categories gc_new ON gc_new.id = h.nouvelle_categorie_id
    LEFT JOIN grille_echelons ge_old   ON ge_old.id = h.ancien_echelon_id
    LEFT JOIN grille_echelons ge_new   ON ge_new.id = h.nouvel_echelon_id
    WHERE h.employe_id = ?
    ORDER BY h.date_effet DESC, h.created_at DESC
  `).all(agent.id);

  res.json({ agent: { id: agent.id, nom: agent.nom, prenom: agent.prenom }, historique });
});

// ─── ATTESTATIONS PDF AUTOMATIQUES ───────────────────────────────────────────

function getEntrepriseAttestations() {
  const p = db.prepare('SELECT cle, valeur FROM parametres').all().reduce((o, r) => { o[r.cle] = r.valeur; return o; }, {});
  const ent = db.prepare('SELECT * FROM entreprise LIMIT 1').get() || {};
  return { nom: ent.nom || p.societe || 'TOP CENTER', adresse: ent.adresse || '', logo_url: ent.logo_url || '' };
}

function fmtD(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function attestationHeader(ent, titre) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;font-size:13px;color:#1f2937;margin:0;padding:0}
  .hdr{background:#1e3a5f;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}
  .hdr h1{margin:0;font-size:17px;letter-spacing:1px}.hdr .sub{font-size:11px;opacity:.8;margin-top:3px}
  .body{padding:24px 36px;line-height:1.8}
  .field{display:grid;grid-template-columns:180px 1fr;gap:4px 12px;margin-bottom:14px}
  .lbl{color:#6b7280;font-size:11px;padding-top:2px}.val{font-weight:600}
  .sig{display:flex;justify-content:space-between;margin-top:48px;padding:0 24px}
  .sig-block{width:45%;text-align:center}
  .sig-line{border-top:1px solid #374151;margin-top:44px;padding-top:6px;font-size:11px;color:#6b7280}
  .footer{font-size:10px;color:#9ca3af;text-align:center;margin-top:24px;padding:8px 24px;border-top:1px solid #e5e7eb}
  .badge{display:inline-block;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;padding:2px 8px;font-size:11px;color:#374151;margin-top:8px}
</style></head><body>
<div class="hdr">
  <div><div class="sub">${ent.nom}</div><h1>${titre}</h1><div class="sub">${ent.adresse || ''}</div></div>
  <div style="text-align:right;font-size:11px"><div>Établi le ${new Date().toLocaleDateString('fr-FR')}</div></div>
</div><div class="body">`;
}

function attestationFooter(ent) {
  return `</div>
<div class="sig"><div class="sig-block"><div class="sig-line">L'intéressé(e)</div></div>
<div class="sig-block"><div class="sig-line">Le Directeur Général<br>${ent.nom}</div></div></div>
<div class="footer">${ent.nom} — Document confidentiel — ${new Date().getFullYear()}</div>
</body></html>`;
}

// GET /api/agents/:id/attestation/travail-pdf
router.get('/:id/attestation/travail-pdf', async (req, res) => {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  const ent = getEntrepriseAttestations();
  const devise = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get()?.valeur || 'XAF';

  const html = attestationHeader(ent, 'ATTESTATION DE TRAVAIL') + `
<p>Je soussigné(e), Directeur(trice) Général(e) de <strong>${ent.nom}</strong>, atteste que :</p>
<div class="field">
  <span class="lbl">Nom & Prénom</span><span class="val">${agent.nom} ${agent.prenom || ''}</span>
  <span class="lbl">Matricule</span><span class="val">${agent.matricule || '—'}</span>
  <span class="lbl">Date de naissance</span><span class="val">${fmtD(agent.date_naissance)}</span>
  <span class="lbl">Poste occupé</span><span class="val">${agent.poste || '—'}</span>
  <span class="lbl">Département</span><span class="val">${agent.departement || '—'}</span>
  <span class="lbl">Type de contrat</span><span class="val">${agent.type_contrat || '—'}</span>
  <span class="lbl">Date d'embauche</span><span class="val">${fmtD(agent.date_embauche)}</span>
  <span class="lbl">Statut</span><span class="val">${agent.statut_dossier || 'actif'}</span>
  <span class="lbl">N° CNSS</span><span class="val">${agent.cnss || '—'}</span>
</div>
<p>Cette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.</p>
<div class="badge">Situation au ${new Date().toLocaleDateString('fr-FR')}</div>
` + attestationFooter(ent);

  try {
    const buf = await generatePdf(html, { prefix: 'att_travail', marginTop: '15mm', marginBottom: '15mm' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attestation-travail-${agent.nom}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Génération PDF impossible : ' + err.message });
  }
});

// GET /api/agents/:id/attestation/salaire-pdf
router.get('/:id/attestation/salaire-pdf', async (req, res) => {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  const ent = getEntrepriseAttestations();
  const devise = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get()?.valeur || 'XAF';
  const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)) + ' ' + devise;

  // Dernier bulletin payé
  const dernierBulletin = db.prepare(
    "SELECT * FROM bulletins_salaire WHERE employe_id=? AND statut='paye' ORDER BY annee DESC, mois DESC LIMIT 1"
  ).get(agent.id);

  const nomsMois = ['','Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const refBulletin = dernierBulletin
    ? `${nomsMois[dernierBulletin.mois]} ${dernierBulletin.annee}`
    : 'Salaire de référence';

  const html = attestationHeader(ent, 'ATTESTATION DE SALAIRE') + `
<p>Je soussigné(e), Directeur(trice) Général(e) de <strong>${ent.nom}</strong>, atteste que :</p>
<div class="field">
  <span class="lbl">Nom & Prénom</span><span class="val">${agent.nom} ${agent.prenom || ''}</span>
  <span class="lbl">Matricule</span><span class="val">${agent.matricule || '—'}</span>
  <span class="lbl">Poste occupé</span><span class="val">${agent.poste || '—'}</span>
  <span class="lbl">Date d'embauche</span><span class="val">${fmtD(agent.date_embauche)}</span>
  <span class="lbl">Salaire de base</span><span class="val">${fmt(agent.salaire_base)}</span>
  ${agent.prime_transport > 0 ? `<span class="lbl">Prime de transport</span><span class="val">${fmt(agent.prime_transport)}</span>` : ''}
  ${agent.prime_logement > 0  ? `<span class="lbl">Prime de logement</span><span class="val">${fmt(agent.prime_logement)}</span>` : ''}
  ${dernierBulletin ? `<span class="lbl">Net à payer (${refBulletin})</span><span class="val">${fmt(dernierBulletin.net_a_payer)}</span>` : ''}
  <span class="lbl">Mode de paiement</span><span class="val">${agent.mode_paiement || '—'}</span>
  ${agent.banque ? `<span class="lbl">Banque</span><span class="val">${agent.banque}</span>` : ''}
</div>
<p>Cette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit, notamment pour toute démarche bancaire ou administrative.</p>
<div class="badge">Situation au ${new Date().toLocaleDateString('fr-FR')}</div>
` + attestationFooter(ent);

  try {
    const buf = await generatePdf(html, { prefix: 'att_salaire', marginTop: '15mm', marginBottom: '15mm' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attestation-salaire-${agent.nom}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Génération PDF impossible : ' + err.message });
  }
});

// GET /api/agents/:id/attestation/conges-pdf
router.get('/:id/attestation/conges-pdf', async (req, res) => {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });
  const ent = getEntrepriseAttestations();

  const solde = calculerSoldeConge(req.params.id);
  const soldeMal = {
    droit: agent.conges_maladie_droit  ?? 15,
    pris:  agent.conges_maladie_pris   ?? 0,
    solde: agent.conges_maladie_solde  ?? 15,
  };

  const html = attestationHeader(ent, 'ATTESTATION DE CONGÉS') + `
<p>Je soussigné(e), Directeur(trice) Général(e) de <strong>${ent.nom}</strong>, atteste que pour :</p>
<div class="field">
  <span class="lbl">Nom & Prénom</span><span class="val">${agent.nom} ${agent.prenom || ''}</span>
  <span class="lbl">Matricule</span><span class="val">${agent.matricule || '—'}</span>
  <span class="lbl">Poste</span><span class="val">${agent.poste || '—'}</span>
  <span class="lbl">Date d'embauche</span><span class="val">${fmtD(agent.date_embauche)}</span>
</div>
<p><strong>Congés annuels</strong></p>
<div class="field">
  <span class="lbl">Droits acquis</span><span class="val">${solde?.acquis ?? '—'} jour(s)</span>
  <span class="lbl">Jours pris</span><span class="val">${solde?.pris ?? '—'} jour(s)</span>
  <span class="lbl">Report N-1</span><span class="val">${solde?.report ?? 0} jour(s)</span>
  <span class="lbl">Solde disponible</span><span class="val" style="color:#16a34a;font-size:15px">${solde?.solde ?? '—'} jour(s)</span>
  ${solde?.en_attente > 0 ? `<span class="lbl">En attente validation</span><span class="val">${solde.en_attente} jour(s)</span>` : ''}
</div>
<p><strong>Congés maladie</strong></p>
<div class="field">
  <span class="lbl">Droit annuel</span><span class="val">${soldeMal.droit} jour(s)</span>
  <span class="lbl">Jours utilisés</span><span class="val">${soldeMal.pris} jour(s)</span>
  <span class="lbl">Solde maladie</span><span class="val">${soldeMal.solde} jour(s)</span>
</div>
<p>Cette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.</p>
<div class="badge">Situation au ${new Date().toLocaleDateString('fr-FR')}</div>
` + attestationFooter(ent);

  try {
    const buf = await generatePdf(html, { prefix: 'att_conges', marginTop: '15mm', marginBottom: '15mm' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attestation-conges-${agent.nom}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Génération PDF impossible : ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ROUTES ONBOARDING ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// GET /:id/onboarding — état complet de l'onboarding
router.get('/:id/onboarding', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  try {
    const ob = await onboardingSvc.getOnboarding(Number(req.params.id));
    if (!ob) return res.status(404).json({ error: 'Employé introuvable' });
    res.json(ob);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/onboarding/reinit — réinitialiser la checklist
router.post('/:id/onboarding/reinit', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  try {
    const ob = await onboardingSvc.initOnboarding(Number(req.params.id), null, req.user.id, req.ip);
    res.json(ob);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /:id/onboarding/tasks/:taskKey/complete — compléter une tâche
router.post('/:id/onboarding/tasks/:taskKey/complete', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { notes } = req.body;
  try {
    const ob = await onboardingSvc.completeTask(Number(req.params.id), req.params.taskKey, req.user.id, notes, req.ip);
    res.json(ob);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /:id/onboarding/tasks/:taskKey/skip — ignorer une tâche optionnelle
router.post('/:id/onboarding/tasks/:taskKey/skip', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const { motif } = req.body;
  try {
    const ob = await onboardingSvc.skipTask(Number(req.params.id), req.params.taskKey, req.user.id, motif, req.ip);
    res.json(ob);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /:id/onboarding/activate — activer l'employé
router.post('/:id/onboarding/activate', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  try {
    const ob = await onboardingSvc.activerEmploye(Number(req.params.id), req.user.id, req.ip);
    res.json(ob);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /:id/create-user — provisionner un compte utilisateur
router.post('/:id/create-user', async (req, res) => {
  if (!hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Rôle Admin requis pour créer un compte utilisateur' });
  const { role, email, nom_affiche } = req.body;
  if (!role) return res.status(400).json({ error: 'Le rôle est requis' });
  if (!userProvSvc.ROLES_VALIDES.includes(role))
    return res.status(400).json({ error: `Rôle invalide. Valeurs acceptées : ${userProvSvc.ROLES_VALIDES.join(', ')}` });
  if (role === 'admin') return res.status(403).json({ error: 'Attribution du rôle admin interdite via ce workflow' });
  try {
    const result = await userProvSvc.provisionUser(
      Number(req.params.id),
      { role, email, nom_affiche, provisioned_by: req.user.id },
      req.ip
    );
    res.status(201).json({
      message: 'Compte créé. Communiquer le mot de passe temporaire à l\'employé.',
      user_id: result.user_id,
      email:   result.email,
      role:    result.role,
      temp_password: result.temp_password,
      must_change_password: 1,
    });
  } catch (e) {
    res.status(e.message.includes('déjà') ? 409 : 400).json({ error: e.message });
  }
});

// GET /:id/user-account — compte système lié à cet employé
router.get('/:id/user-account', async (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  try {
    const user = await userProvSvc.getUserForEmploye(Number(req.params.id));
    res.json(user || { linked: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

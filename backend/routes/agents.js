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

  return {
    ...e,
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

  res.json({
    total, actifs, suspendus,
    contratsExpirants, essaisExpirants, anniversaires,
    masseSalariale, documentsExpires,
    parContrat, parDept
  });
});

// ─── Prochain matricule ───────────────────────────────────────────────────────
// IMPORTANT : doit être AVANT /:id pour éviter le conflit de route Express

router.get('/next-matricule', (req, res) => {
  res.json({ matricule: nextMatricule() });
});

// ─── Liste des agents ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { statut, type_contrat, departement, search, limit = 100, offset = 0 } = req.query;
  let sql    = 'SELECT * FROM employes WHERE actif = 1';
  const args = [];

  if (statut)        { sql += ' AND statut_dossier = ?'; args.push(statut); }
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

  const countSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as c').replace(/ORDER BY.*/, '');
  const total    = db.prepare(countSql).get(...args.slice(0, -2)).c;

  res.json({ agents, total, limit: Number(limit), offset: Number(offset) });
});

// ─── Alertes documents expirant dans 30 jours ─────────────────────────────────
// IMPORTANT : doit être AVANT /:id

router.get('/documents/alertes', (req, res) => {
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

  const params = db.prepare('SELECT * FROM parametres').all().reduce((o, p) => ({ ...o, [p.cle]: p.valeur }), {});
  payload.devise  = params.devise  || 'XAF';
  payload.societe = params.societe || 'TOP CENTER';

  res.json(payload);
});

// ─── Créer un agent ───────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });

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
    res.status(201).json(enrichAgent(agent));
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Matricule déjà utilisé' });
    }
    throw e;
  }
});

// ─── Modifier un agent ────────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });

  const agent = db.prepare('SELECT id, statut_dossier, salaire_base FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });

  // ── Un agent sorti ne peut être modifié que via /reactiver ──────────────────
  if (agent.statut_dossier === 'sorti') {
    return res.status(403).json({ error: 'Agent sorti — utilisez la route /reactiver pour le réactiver' });
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
    statut_dossier, motif_sortie, date_sortie,
    actif,
  } = req.body;

  // ── Validation profil paie à l'activation ───────────────────────────────────
  // Si on passe brouillon → actif, le salaire de base doit être renseigné
  if (agent.statut_dossier === 'brouillon' && statut_dossier === 'actif') {
    const sal = Number(salaire_base) || agent.salaire_base || 0;
    if (sal <= 0) {
      return res.status(400).json({ error: 'Salaire de base requis pour activer le profil paie de l\'agent' });
    }
  }

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
      statut_dossier=?, motif_sortie=?, date_sortie=?,
      actif=?
    WHERE id=?
  `).run(
    nom, prenom, matricule, sexe,
    poste, type, salaire_base || 0, prime_transport || 0, prime_logement || 0,
    mode_paiement, banque || '', numero_compte || '', email || '', telephone || '', telephone2 || '',
    date_naissance || null, lieu_naissance || null, nationalite, situation_matrimoniale,
    nb_enfants || 0, nb_enfants_charge || 0, adresse || '',
    num_piece_identite || '', type_piece_identite || '', date_expiration_identite || null,
    date_embauche || null, type_contrat, date_debut_contrat || null, date_fin_contrat || null,
    periode_essai_mois || 0, date_fin_essai || null,
    departement || '', superieur_hierarchique || '', site || '',
    statut_dossier, motif_sortie || null, date_sortie || null,
    actif !== undefined ? (actif ? 1 : 0) : 1,
    req.params.id
  );

  // ── Audit des transitions de statut importantes ─────────────────────────────
  const ancienStatut = agent.statut_dossier;
  if (statut_dossier && statut_dossier !== ancienStatut) {
    const details = { ancien: ancienStatut, nouveau: statut_dossier };
    if (statut_dossier === 'actif')    details.profil_paie = 'activé';
    if (statut_dossier === 'sorti')    details.motif = motif_sortie || null;
    if (statut_dossier === 'suspendu') details.motif = motif_sortie || null;
    audit('employes', Number(req.params.id), `statut_${statut_dossier}`, details, req.user.id);
  }

  res.json(enrichAgent(db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id)));
});

// ─── Réactiver un agent sorti ────────────────────────────────────────────────
// Seule voie légale pour faire passer statut_dossier de 'sorti' → 'actif'.
// Admin uniquement + motif obligatoire.

router.put('/:id/reactiver', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });

  const agent = db.prepare('SELECT id, nom, prenom, statut_dossier, salaire_base FROM employes WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent non trouvé' });
  if (agent.statut_dossier !== 'sorti') return res.status(400).json({ error: `L'agent n'est pas sorti (statut actuel : ${agent.statut_dossier})` });

  const { motif } = req.body;
  if (!motif || !String(motif).trim()) {
    return res.status(400).json({ error: 'Motif de réactivation obligatoire' });
  }

  if ((agent.salaire_base || 0) <= 0) {
    return res.status(400).json({ error: 'Salaire de base requis pour réactiver le profil paie de l\'agent' });
  }

  db.prepare(`
    UPDATE employes SET
      statut_dossier = 'actif',
      motif_sortie   = NULL,
      date_sortie    = NULL
    WHERE id = ?
  `).run(agent.id);

  audit('employes', agent.id, 'agent_reactive', {
    motif: String(motif).trim(),
    ancien_statut: 'sorti',
    profil_paie: 'réactivé',
  }, req.user.id);

  res.json(enrichAgent(db.prepare('SELECT * FROM employes WHERE id = ?').get(agent.id)));
});

// ─── Désactiver un agent ─────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  db.prepare("UPDATE employes SET actif=0, statut_dossier='archive' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Enfants ──────────────────────────────────────────────────────────────────

router.get('/:id/enfants', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ? ORDER BY date_naissance').all(req.params.id));
});

router.post('/:id/enfants', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { prenom, nom = '', date_naissance = '', sexe = 'M', est_charge = 1, scolarise = 0, observation = '' } = req.body;
  if (!prenom) return res.status(400).json({ error: 'Prénom requis' });
  const r = db.prepare('INSERT INTO employes_enfants (employe_id,nom,prenom,date_naissance,sexe,est_charge,scolarise,observation) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id, nom, prenom, date_naissance || null, sexe, est_charge ? 1 : 0, scolarise ? 1 : 0, observation);
  // Mettre à jour le compteur sur l'agent
  const enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ?').all(req.params.id);
  const charge  = enfants.filter(e => e.est_charge).length;
  db.prepare('UPDATE employes SET nb_enfants=?, nb_enfants_charge=? WHERE id=?').run(enfants.length, charge, req.params.id);
  res.status(201).json({ id: r.lastInsertRowid, prenom, nom, date_naissance, sexe, est_charge, scolarise, observation });
});

router.delete('/:id/enfants/:eid', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM employes_enfants WHERE id = ? AND employe_id = ?').run(req.params.eid, req.params.id);
  const enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ?').all(req.params.id);
  const charge  = enfants.filter(e => e.est_charge).length;
  db.prepare('UPDATE employes SET nb_enfants=?, nb_enfants_charge=? WHERE id=?').run(enfants.length, charge, req.params.id);
  res.json({ ok: true });
});

// ─── Documents RH ─────────────────────────────────────────────────────────────

router.get('/:id/documents', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_documents WHERE employe_id = ? ORDER BY created_at DESC').all(req.params.id));
});

router.post('/:id/documents', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { type_document, date_emission = '', date_expiration = '', statut = 'valide', observation = '' } = req.body;
  if (!type_document) return res.status(400).json({ error: 'Type de document requis' });
  const r = db.prepare('INSERT INTO employes_documents (employe_id,type_document,date_emission,date_expiration,statut,observation) VALUES (?,?,?,?,?,?)').run(req.params.id, type_document, date_emission || null, date_expiration || null, statut, observation);
  res.status(201).json({ id: r.lastInsertRowid, type_document, date_emission, date_expiration, statut, observation });
});

router.delete('/:id/documents/:did', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM employes_documents WHERE id = ? AND employe_id = ?').run(req.params.did, req.params.id);
  res.json({ ok: true });
});

// ─── Diplômes ─────────────────────────────────────────────────────────────────

router.get('/:id/diplomes', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_diplomes WHERE employe_id = ? ORDER BY annee_obtention DESC').all(req.params.id));
});

router.post('/:id/diplomes', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { intitule, etablissement = '', pays = 'Congo-Brazzaville', annee_obtention = null, niveau = 'autre', observation = '' } = req.body;
  if (!intitule) return res.status(400).json({ error: 'Intitulé requis' });
  const r = db.prepare('INSERT INTO employes_diplomes (employe_id,intitule,etablissement,pays,annee_obtention,niveau,observation) VALUES (?,?,?,?,?,?,?)').run(req.params.id, intitule, etablissement, pays, annee_obtention || null, niveau, observation);
  res.status(201).json({ id: r.lastInsertRowid, intitule, etablissement, pays, annee_obtention, niveau, observation });
});

router.delete('/:id/diplomes/:did', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM employes_diplomes WHERE id = ? AND employe_id = ?').run(req.params.did, req.params.id);
  res.json({ ok: true });
});

// ─── Expériences professionnelles ────────────────────────────────────────────

router.get('/:id/experiences', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_experiences WHERE employe_id = ? ORDER BY date_debut DESC').all(req.params.id));
});

router.post('/:id/experiences', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { poste, entreprise = '', date_debut = '', date_fin = '', type_contrat = '', description = '' } = req.body;
  if (!poste) return res.status(400).json({ error: 'Poste requis' });
  const r = db.prepare('INSERT INTO employes_experiences (employe_id,poste,entreprise,date_debut,date_fin,type_contrat,description) VALUES (?,?,?,?,?,?,?)').run(req.params.id, poste, entreprise, date_debut || null, date_fin || null, type_contrat, description);
  res.status(201).json({ id: r.lastInsertRowid, poste, entreprise, date_debut, date_fin, type_contrat, description });
});

router.delete('/:id/experiences/:eid', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  db.prepare('DELETE FROM employes_experiences WHERE id = ? AND employe_id = ?').run(req.params.eid, req.params.id);
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
      OR (a.table_name = 'bulletins_salaire' AND a.record_id IN (
            SELECT id FROM bulletins_salaire WHERE employe_id = ?
          ))
    ORDER BY a.created_at DESC
    LIMIT 150
  `).all(agentId, agentId, agentId, agentId);
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
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { date, montant, motif = '', nb_echeances = 1, notes = '' } = req.body;
  if (!date || !montant || montant <= 0) return res.status(400).json({ error: 'Date et montant positif requis' });
  const echeance = Math.round(montant / Math.max(1, nb_echeances));
  const r = db.prepare(
    'INSERT INTO employes_avances (employe_id,date,montant,solde_restant,motif,nb_echeances,montant_echeance,notes,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime("now"))'
  ).run(req.params.id, date, montant, montant, motif, nb_echeances, echeance, notes, req.user.id);
  const newAvance = { id: r.lastInsertRowid, date, montant, solde_restant: montant, motif, statut: 'en_cours', nb_echeances, montant_echeance: echeance, notes, remboursements: [] };
  audit('employes_avances', r.lastInsertRowid, 'create', { montant, motif }, req.user.id);
  res.status(201).json(newAvance);
});

// Remboursement partiel
router.post('/:id/avances/:aid/remboursements', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
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
    db.prepare('UPDATE employes_avances SET solde_restant=?, montant_rembourse=COALESCE(montant_rembourse,0)+?, statut=?, updated_at=datetime("now") WHERE id=?')
      .run(nouveau_solde, montant, nouveau_statut, avance.id);
  });
  tx();
  audit('employes_avances', avance.id, 'remboursement_partiel', { montant, notes }, req.user.id);
  res.status(201).json({ ok: true, solde_restant: avance.solde_restant - montant });
});

// Annulation logique (remplace DELETE)
router.put('/:id/avances/:aid/annuler', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
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

// ─── Congés & absences ────────────────────────────────────────────────────────

router.get('/:id/conges', (req, res) => {
  res.json(db.prepare('SELECT * FROM employes_conges WHERE employe_id = ? ORDER BY date_debut DESC').all(req.params.id));
});

router.post('/:id/conges', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const { type_conge = 'annuel', date_debut, date_fin, motif = '', notes = '' } = req.body;
  if (!date_debut || !date_fin) return res.status(400).json({ error: 'Dates requises' });
  if (date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });

  const nb_jours = Math.max(1, Math.round((new Date(date_fin) - new Date(date_debut)) / (1000 * 60 * 60 * 24)) + 1);
  const r = db.prepare('INSERT INTO employes_conges (employe_id,type_conge,date_debut,date_fin,nb_jours,motif,notes,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.params.id, type_conge, date_debut, date_fin, nb_jours, motif, notes, req.user.id);
  audit('employes_conges', r.lastInsertRowid, 'create', { type_conge, date_debut, date_fin, nb_jours }, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, type_conge, date_debut, date_fin, nb_jours, motif, statut: 'demande', notes });
});

// Approuver un congé (avec contrôle chevauchement)
router.put('/:id/conges/:cid/approuver', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (conge.statut !== 'demande') return res.status(400).json({ error: `Impossible d'approuver un congé en statut "${conge.statut}"` });

  // Contrôle chevauchement avec congés déjà approuvés
  const overlap = db.prepare(`
    SELECT id, date_debut, date_fin FROM employes_conges
    WHERE employe_id = ? AND statut = 'approuve' AND id != ?
    AND date_debut <= ? AND date_fin >= ?
  `).get(req.params.id, req.params.cid, conge.date_fin, conge.date_debut);
  if (overlap) return res.status(409).json({
    error: `Chevauchement avec un congé approuvé du ${overlap.date_debut} au ${overlap.date_fin}`
  });

  db.prepare("UPDATE employes_conges SET statut='approuve', updated_by=?, updated_at=datetime('now') WHERE id=?").run(req.user.id, conge.id);
  audit('employes_conges', conge.id, 'approuve', { date_debut: conge.date_debut, date_fin: conge.date_fin }, req.user.id);
  res.json({ ok: true });
});

// Refuser un congé
router.put('/:id/conges/:cid/refuser', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (['refuse','annule'].includes(conge.statut)) return res.status(400).json({ error: 'Congé déjà refusé/annulé' });
  const { motif = '' } = req.body;
  db.prepare("UPDATE employes_conges SET statut='refuse', annule_motif=?, updated_by=?, updated_at=datetime('now') WHERE id=?").run(motif, req.user.id, conge.id);
  audit('employes_conges', conge.id, 'refuse', { motif }, req.user.id);
  res.json({ ok: true });
});

// Terminer un congé
router.put('/:id/conges/:cid/terminer', (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (conge.statut !== 'approuve') return res.status(400).json({ error: 'Seul un congé approuvé peut être terminé' });
  db.prepare("UPDATE employes_conges SET statut='termine', updated_by=?, updated_at=datetime('now') WHERE id=?").run(req.user.id, conge.id);
  audit('employes_conges', conge.id, 'termine', null, req.user.id);
  res.json({ ok: true });
});

// Annulation logique (remplace DELETE)
router.put('/:id/conges/:cid/annuler', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const conge = db.prepare('SELECT * FROM employes_conges WHERE id = ? AND employe_id = ?').get(req.params.cid, req.params.id);
  if (!conge) return res.status(404).json({ error: 'Congé non trouvé' });
  if (conge.statut === 'annule') return res.status(400).json({ error: 'Congé déjà annulé' });
  const { motif = '' } = req.body;
  db.prepare("UPDATE employes_conges SET statut='refuse', annule_at=datetime('now'), annule_by=?, annule_motif=?, updated_at=datetime('now') WHERE id=?").run(req.user.id, motif, conge.id);
  audit('employes_conges', conge.id, 'annule', { motif }, req.user.id);
  res.json({ ok: true });
});

// ─── Upload photo agent ───────────────────────────────────────────────────────

router.post('/:id/photo', upload.single('photo'), (req, res) => {
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
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
  if (req.user.role === 'lecteur') return res.status(403).json({ error: 'Accès refusé' });
  const agent = db.prepare('SELECT photo_url FROM employes WHERE id = ?').get(req.params.id);
  if (agent?.photo_url) {
    const filePath = path.join(uploadsDir, path.basename(agent.photo_url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('UPDATE employes SET photo_url = NULL WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

module.exports = router;

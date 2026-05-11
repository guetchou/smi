/**
 * MODULE RÉVISIONS SALARIALES — TOP CENTER
 * Circuit : brouillon → soumis_rh → soumis_dg → approuve|rejete|ajourne → applique
 *
 * Règle métier : modification salaire_base toujours tracée dans historique_salaires
 * à l'application. Le DG est l'approbateur final.
 */
const express = require('express');
const db      = require('../database');
const router  = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');

const WRITE_ROLES   = ['admin', 'rh', 'finance'];
const RH_ROLES      = ['admin', 'rh'];
const APPROVE_ROLES = ['admin', 'dg'];

function canWrite(user)   { return hasRole(user, ...WRITE_ROLES); }
function canRH(user)      { return hasRole(user, ...RH_ROLES); }
function canApprove(user) { return hasRole(user, ...APPROVE_ROLES); }

function audit(id, action, details, userId) {
  try {
    db.prepare(
      "INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)"
    ).run('demandes_revision_salaire', id, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

function notifyRoles(roles, titre, message, srcId) {
  try {
    const users = db.prepare(
      `SELECT id FROM users WHERE actif=1 AND (role IN (${roles.map(() => '?').join(',')}) ${roles.map(r => `OR roles LIKE '%"${r}"%'`).join(' ')})`
    ).all(...roles);
    users.forEach(u => {
      creerNotification({ type: 'NOTIF_REVISION_SALAIRE', titre, message, srcTable: 'demandes_revision_salaire', srcId, destinataire_id: u.id });
    });
  } catch (_) {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function enrichRevision(r) {
  if (!r) return null;
  const emp  = db.prepare('SELECT nom, prenom, poste, salaire_base FROM employes WHERE id = ?').get(r.employe_id);
  const crBy = db.prepare('SELECT nom, prenom FROM users WHERE id = ?').get(r.created_by);
  const vRH  = r.valide_rh_by  ? db.prepare('SELECT nom, prenom FROM users WHERE id = ?').get(r.valide_rh_by)  : null;
  const vDG  = r.valide_dg_by  ? db.prepare('SELECT nom, prenom FROM users WHERE id = ?').get(r.valide_dg_by)  : null;
  const cat  = r.nouvelle_categorie_id ? db.prepare('SELECT code, libelle FROM grille_categories WHERE id = ?').get(r.nouvelle_categorie_id) : null;
  const ech  = r.nouvel_echelon_id     ? db.prepare('SELECT echelon, salaire_reference FROM grille_echelons WHERE id = ?').get(r.nouvel_echelon_id) : null;
  return {
    ...r,
    employe_nom:    emp  ? `${emp.nom} ${emp.prenom}` : null,
    employe_poste:  emp?.poste,
    employe_salaire_actuel_reel: emp?.salaire_base,
    created_by_nom: crBy ? `${crBy.nom} ${crBy.prenom}` : null,
    valide_rh_nom:  vRH  ? `${vRH.nom} ${vRH.prenom}`  : null,
    valide_dg_nom:  vDG  ? `${vDG.nom} ${vDG.prenom}`  : null,
    nouvelle_categorie: cat,
    nouvel_echelon: ech,
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/revisions-salaire/ — liste (filtrable par statut, employe_id)
router.get('/', (req, res) => {
  const { statut, employe_id, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM demandes_revision_salaire WHERE 1=1';
  const args = [];
  if (statut)      { sql += ' AND statut = ?';     args.push(statut); }
  if (employe_id)  { sql += ' AND employe_id = ?'; args.push(employe_id); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));
  res.json(db.prepare(sql).all(...args).map(enrichRevision));
});

// GET /api/revisions-salaire/en-attente — soumis_dg (dashboard DG)
router.get('/en-attente', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM demandes_revision_salaire WHERE statut='soumis_dg' ORDER BY updated_at ASC"
  ).all();
  res.json({ count: rows.length, items: rows.map(enrichRevision) });
});

// GET /api/revisions-salaire/:id — détail
router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Révision introuvable' });
  res.json(enrichRevision(r));
});

// POST /api/revisions-salaire/ — créer demande (admin/rh/finance)
router.post('/', (req, res) => {
  if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH, Finance ou Admin requis' });

  const {
    employe_id, type_revision = 'augmentation', date_effet,
    salaire_propose, transport_propose, logement_propose,
    nouvelle_categorie_id, nouvel_echelon_id,
    motif, document_url,
  } = req.body;

  if (!employe_id || !date_effet || !salaire_propose || !motif)
    return res.status(400).json({ error: 'employe_id, date_effet, salaire_propose et motif sont requis' });

  const agent = db.prepare('SELECT id, nom, prenom, salaire_base, prime_transport, prime_logement FROM employes WHERE id = ?').get(employe_id);
  if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

  // Vérifier que le salaire proposé est dans les bornes de l'échelon (si affecté)
  if (nouvel_echelon_id) {
    const ech = db.prepare('SELECT salaire_min, salaire_max FROM grille_echelons WHERE id = ?').get(nouvel_echelon_id);
    if (ech) {
      if (ech.salaire_min && Number(salaire_propose) < ech.salaire_min)
        return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) inférieur au minimum de l'échelon (${ech.salaire_min})` });
      if (ech.salaire_max && Number(salaire_propose) > ech.salaire_max)
        return res.status(400).json({ error: `Salaire proposé (${salaire_propose}) supérieur au maximum de l'échelon (${ech.salaire_max})` });
    }
  }

  const r = db.prepare(`
    INSERT INTO demandes_revision_salaire
      (employe_id, type_revision, date_effet,
       salaire_actuel, salaire_propose,
       transport_actuel, transport_propose,
       logement_actuel, logement_propose,
       nouvelle_categorie_id, nouvel_echelon_id,
       motif, document_url,
       statut, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'brouillon', ?, datetime('now'))
  `).run(
    employe_id, type_revision, date_effet,
    agent.salaire_base || 0, Number(salaire_propose),
    agent.prime_transport || 0, Number(transport_propose) || agent.prime_transport || 0,
    agent.prime_logement  || 0, Number(logement_propose)  || agent.prime_logement  || 0,
    nouvelle_categorie_id || null, nouvel_echelon_id || null,
    motif, document_url || null,
    req.user.id
  );

  audit(r.lastInsertRowid, 'creer', { type_revision, salaire_propose, motif }, req.user.id);
  res.status(201).json(enrichRevision(db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(r.lastInsertRowid)));
});

// PUT /api/revisions-salaire/:id — modifier si brouillon
router.put('/:id', (req, res) => {
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'brouillon')
    return res.status(400).json({ error: `Statut "${rev.statut}" — modification impossible. Seul un brouillon est modifiable.` });
  if (rev.created_by !== req.user.id && !hasRole(req.user, 'admin', 'rh'))
    return res.status(403).json({ error: 'Seul le créateur, un RH ou un Admin peut modifier ce brouillon' });

  const {
    type_revision = rev.type_revision,
    date_effet = rev.date_effet,
    salaire_propose = rev.salaire_propose,
    transport_propose = rev.transport_propose,
    logement_propose = rev.logement_propose,
    nouvelle_categorie_id = rev.nouvelle_categorie_id,
    nouvel_echelon_id = rev.nouvel_echelon_id,
    motif = rev.motif,
    document_url = rev.document_url,
  } = req.body;

  db.prepare(`
    UPDATE demandes_revision_salaire SET
      type_revision=?, date_effet=?,
      salaire_propose=?, transport_propose=?, logement_propose=?,
      nouvelle_categorie_id=?, nouvel_echelon_id=?,
      motif=?, document_url=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    type_revision, date_effet,
    Number(salaire_propose), Number(transport_propose) || 0, Number(logement_propose) || 0,
    nouvelle_categorie_id || null, nouvel_echelon_id || null,
    motif, document_url || null,
    rev.id
  );

  audit(rev.id, 'modifier', { salaire_propose, motif }, req.user.id);
  res.json(enrichRevision(db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(rev.id)));
});

// POST /api/revisions-salaire/:id/soumettre-rh — brouillon → soumis_rh
router.post('/:id/soumettre-rh', (req, res) => {
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'brouillon')
    return res.status(400).json({ error: `Statut actuel "${rev.statut}" — soumission impossible` });
  if (rev.created_by !== req.user.id && !hasRole(req.user, 'admin', 'rh'))
    return res.status(403).json({ error: 'Seul le créateur, un RH ou un Admin peut soumettre' });

  db.prepare(`UPDATE demandes_revision_salaire SET statut='soumis_rh', updated_at=datetime('now') WHERE id=?`).run(rev.id);
  audit(rev.id, 'soumettre_rh', null, req.user.id);

  const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(rev.employe_id);
  notifyRoles(['rh', 'admin'],
    'Révision salariale soumise',
    `Révision salariale de ${emp?.nom} ${emp?.prenom} (${rev.type_revision}) soumise pour contrôle RH.`,
    rev.id
  );

  res.json({ ok: true, statut: 'soumis_rh' });
});

// POST /api/revisions-salaire/:id/valider-rh — soumis_rh → soumis_dg
router.post('/:id/valider-rh', (req, res) => {
  if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'soumis_rh')
    return res.status(400).json({ error: `Statut actuel "${rev.statut}" — validation RH impossible` });

  const { avis_rh } = req.body;
  if (!avis_rh || !String(avis_rh).trim())
    return res.status(400).json({ error: 'Avis RH obligatoire' });

  db.prepare(`
    UPDATE demandes_revision_salaire
    SET statut='soumis_dg', avis_rh=?, valide_rh_by=?, valide_rh_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(String(avis_rh).trim(), req.user.id, rev.id);
  audit(rev.id, 'valider_rh', { avis_rh }, req.user.id);

  const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(rev.employe_id);
  notifyRoles(['dg', 'admin'],
    'Révision salariale en attente DG',
    `Révision salariale de ${emp?.nom} ${emp?.prenom} validée par RH — en attente de votre approbation.`,
    rev.id
  );

  res.json({ ok: true, statut: 'soumis_dg' });
});

// POST /api/revisions-salaire/:id/valider-dg — soumis_dg → approuve + application
router.post('/:id/valider-dg', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'soumis_dg')
    return res.status(400).json({ error: `Statut actuel "${rev.statut}" — validation DG impossible` });

  const { avis_dg } = req.body;
  if (!avis_dg || !String(avis_dg).trim())
    return res.status(400).json({ error: 'Avis DG obligatoire' });

  db.prepare(`
    UPDATE demandes_revision_salaire
    SET statut='approuve', avis_dg=?, valide_dg_by=?, valide_dg_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(String(avis_dg).trim(), req.user.id, rev.id);
  audit(rev.id, 'valider_dg', { avis_dg }, req.user.id);

  // Appliquer immédiatement si date_effet <= aujourd'hui
  const today = new Date().toISOString().slice(0, 10);
  if (rev.date_effet <= today) {
    _appliquerRevision(rev, req.user.id);
    return res.json({ ok: true, statut: 'applique', applique_maintenant: true });
  }

  // Sinon : statut=approuve — sera appliqué à date_effet par le cron ou manuellement
  res.json({ ok: true, statut: 'approuve', applique_maintenant: false, date_effet: rev.date_effet });
});

// POST /api/revisions-salaire/:id/appliquer — appliquer manuellement une révision approuvée
router.post('/:id/appliquer', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'approuve')
    return res.status(400).json({ error: 'Seule une révision approuvée peut être appliquée' });

  _appliquerRevision(rev, req.user.id);
  res.json({ ok: true, statut: 'applique' });
});

function _appliquerRevision(rev, userId) {
  const agent = db.prepare('SELECT salaire_base, prime_transport, prime_logement FROM employes WHERE id=?').get(rev.employe_id);

  // Mettre à jour le dossier agent
  db.prepare(`
    UPDATE employes
    SET salaire_base=?, prime_transport=?, prime_logement=?,
        grille_categorie_id=?, grille_echelon_id=?,
        updated_at=datetime('now')
    WHERE id=?
  `).run(
    rev.salaire_propose, rev.transport_propose || agent.prime_transport || 0,
    rev.logement_propose || agent.prime_logement || 0,
    rev.nouvelle_categorie_id || null, rev.nouvel_echelon_id || null,
    rev.employe_id
  );

  // Tracer dans historique_salaires
  db.prepare(`
    INSERT INTO historique_salaires
      (employe_id, date_effet, ancien_salaire, nouveau_salaire,
       ancien_transport, nouveau_transport, ancien_logement, nouveau_logement,
       ancienne_categorie_id, nouvelle_categorie_id,
       ancien_echelon_id, nouvel_echelon_id,
       motif, type_revision, demande_revision_id, approved_by, approved_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    rev.employe_id, rev.date_effet,
    rev.salaire_actuel, rev.salaire_propose,
    rev.transport_actuel, rev.transport_propose,
    rev.logement_actuel, rev.logement_propose,
    null, rev.nouvelle_categorie_id || null,
    null, rev.nouvel_echelon_id || null,
    rev.motif, rev.type_revision, rev.id, userId, userId
  );

  // Marquer la révision comme appliquée
  db.prepare(`
    UPDATE demandes_revision_salaire SET statut='applique', updated_at=datetime('now') WHERE id=?
  `).run(rev.id);

  try {
    const emp = db.prepare('SELECT nom, prenom, email FROM employes WHERE id=?').get(rev.employe_id);
    creerNotification({
      type: 'NOTIF_REVISION_SALAIRE',
      titre: 'Révision salariale appliquée',
      message: `La révision salariale de ${emp?.nom} ${emp?.prenom} a été appliquée — nouveau salaire : ${new Intl.NumberFormat('fr-FR').format(rev.salaire_propose)} XAF.`,
      srcTable: 'demandes_revision_salaire',
      srcId: rev.id,
    });
  } catch (_) {}

  try {
    db.prepare("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)")
      .run('demandes_revision_salaire', rev.id, 'appliquer',
        JSON.stringify({ nouveau_salaire: rev.salaire_propose, motif: rev.motif }), userId);
  } catch (_) {}
}

// POST /api/revisions-salaire/:id/rejeter
router.post('/:id/rejeter', (req, res) => {
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });

  const etapesRH = ['soumis_rh'];
  const etapesDG = ['soumis_dg'];
  const peutRejeter =
    (etapesRH.includes(rev.statut) && canRH(req.user)) ||
    (etapesDG.includes(rev.statut) && canApprove(req.user));
  if (!peutRejeter)
    return res.status(403).json({ error: 'Vous ne pouvez pas rejeter à cette étape' });

  const { motif_rejet } = req.body;
  if (!motif_rejet || !String(motif_rejet).trim())
    return res.status(400).json({ error: 'Motif de rejet obligatoire' });

  db.prepare(`
    UPDATE demandes_revision_salaire
    SET statut='rejete', motif_rejet=?, updated_at=datetime('now')
    WHERE id=?
  `).run(String(motif_rejet).trim(), rev.id);
  audit(rev.id, 'rejeter', { motif_rejet }, req.user.id);

  const emp = db.prepare('SELECT nom, prenom FROM employes WHERE id=?').get(rev.employe_id);
  const createur = db.prepare('SELECT id FROM users WHERE id=?').get(rev.created_by);
  if (createur) {
    try {
      creerNotification({
        type: 'NOTIF_REVISION_SALAIRE',
        titre: 'Révision salariale rejetée',
        message: `La révision salariale de ${emp?.nom} ${emp?.prenom} a été rejetée. Motif : ${motif_rejet}`,
        srcTable: 'demandes_revision_salaire',
        srcId: rev.id,
        destinataire_id: rev.created_by,
      });
    } catch (_) {}
  }

  res.json({ ok: true, statut: 'rejete' });
});

// POST /api/revisions-salaire/:id/ajourner — soumis_dg → ajourne (DG/admin)
router.post('/:id/ajourner', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });
  if (rev.statut !== 'soumis_dg')
    return res.status(400).json({ error: `Statut "${rev.statut}" — ajournement impossible` });

  const { avis_dg } = req.body;
  db.prepare(`
    UPDATE demandes_revision_salaire
    SET statut='ajourne', avis_dg=?, valide_dg_by=?, valide_dg_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(avis_dg || null, req.user.id, rev.id);
  audit(rev.id, 'ajourner', { avis_dg }, req.user.id);
  res.json({ ok: true, statut: 'ajourne' });
});

// POST /api/revisions-salaire/:id/annuler
router.post('/:id/annuler', (req, res) => {
  const rev = db.prepare('SELECT * FROM demandes_revision_salaire WHERE id = ?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Révision introuvable' });

  const peutAnnuler =
    (rev.statut === 'brouillon' && rev.created_by === req.user.id) ||
    hasRole(req.user, 'admin');
  if (!peutAnnuler)
    return res.status(403).json({ error: 'Seul le créateur (brouillon) ou un Admin peut annuler' });

  const annulables = ['brouillon','soumis_rh','soumis_dg','approuve','ajourne'];
  if (!annulables.includes(rev.statut))
    return res.status(400).json({ error: `Statut "${rev.statut}" non annulable` });

  db.prepare(`UPDATE demandes_revision_salaire SET statut='annule', updated_at=datetime('now') WHERE id=?`).run(rev.id);
  audit(rev.id, 'annuler', null, req.user.id);
  res.json({ ok: true, statut: 'annule' });
});

module.exports = router;

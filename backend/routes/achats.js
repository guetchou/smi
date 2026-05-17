/**
 * ROUTES DEMANDES D'ACHAT — Tala SMI
 * Workflow : brouillon → soumis → approuve | rejete
 * Approbation génère automatiquement un décaissement
 */
const express = require('express');
const db = require('../database');
const router = express.Router();
const { sendMail } = require('../services/email');
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');
const { can } = require('../services/permissions');

// ─── Rôles ────────────────────────────────────────────────────────────────────
const ROLES_APPROUVER = ['admin', 'dg'];
const ROLES_VOIR_TOUT = ['admin', 'dg', 'assistante_direction', 'finance'];
const ROLES_P2P_OPERER = ['admin', 'dg', 'finance', 'assistante_direction'];
const ROLES_PAYER = ['admin', 'finance', 'caissier'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genNumero() {
  const annee = new Date().getFullYear();
  const last = db.prepare(
    "SELECT numero FROM demandes_achat WHERE numero LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`DA-${annee}-%`);
  let seq = 1;
  if (last?.numero) {
    const parts = last.numero.split('-');
    seq = parseInt(parts[parts.length - 1], 10) + 1;
  }
  return `DA-${annee}-${String(seq).padStart(6, '0')}`;
}

function canApprove(user) {
  if (can(user, 'purchase.validate')) return true;
  if (hasRole(user, ...ROLES_APPROUVER)) return true;
  if (hasRole(user, 'delegue')) {
    const deleg = db.prepare(`
      SELECT id FROM delegations_approbation
      WHERE delegue_id = ? AND actif = 1
        AND date_debut <= date('now')
        AND (date_fin IS NULL OR date_fin >= date('now'))
    `).get(user.id);
    return !!deleg;
  }
  return false;
}

function canOperateP2P(user) {
  return can(user, 'purchase.create') || can(user, 'purchase.submit') || hasRole(user, ...ROLES_P2P_OPERER);
}

function canPay(user) {
  return can(user, 'purchase.pay') || hasRole(user, ...ROLES_PAYER);
}

function getAchatApproverUserIds() {
  return db.prepare(`
    SELECT DISTINCT u.id
    FROM users u
    LEFT JOIN delegations_approbation d
      ON d.delegue_id = u.id
      AND d.actif = 1
      AND d.date_debut <= date('now')
      AND (d.date_fin IS NULL OR d.date_fin >= date('now'))
    WHERE u.actif = 1
      AND (
        u.role IN ('admin','dg')
        OR u.roles LIKE '%"admin"%'
        OR u.roles LIKE '%"dg"%'
        OR d.id IS NOT NULL
      )
  `).all().map(r => r.id);
}

function canSeeAll(user) {
  return can(user, 'purchase.validate') || hasRole(user, ...ROLES_VOIR_TOUT);
}

function auditOperation(recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run('operations', recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

function approuverDemandeAchat(da, user) {
  const approbateurId = user.id;
  const approbateurNom = user.nom;
  const approuver = db.transaction(() => {
    if (da.statut === 'brouillon') {
      db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);
    }

    db.prepare(`
      UPDATE demandes_achat SET
        statut = 'approuve',
        approuve_par_id = ?, approuve_par_nom = ?,
        date_approbation = date('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(approbateurId, approbateurNom, da.id);

    const libelle = `Demande d'achat ${da.numero} — ${da.service_demandeur}`;
    const result = db.prepare(`
      INSERT INTO operations (type_op, date, libelle, montant, statut, dec_statut,
        categorie_id, position_id, ref_externe, created_by,
        submitted_by, submitted_at, validated_by, validated_at)
      VALUES ('decaissement', date('now'), ?, ?, 'en_attente', 'valide',
        (SELECT id FROM categories WHERE type='depense' ORDER BY id LIMIT 1),
        (SELECT id FROM positions ORDER BY id LIMIT 1),
        ?, ?, ?, datetime('now'), ?, datetime('now'))
    `).run(libelle, da.total_general, da.numero, approbateurId, approbateurId, approbateurId);

    db.prepare('UPDATE demandes_achat SET decaissement_id = ? WHERE id = ?')
      .run(result.lastInsertRowid, da.id);

    return result.lastInsertRowid;
  });

  const decId = approuver();
  auditOperation(decId, 'dec_valide_achat', {
    achat_id: da.id,
    numero: da.numero,
    montant: da.total_general,
    libelle: `Demande d'achat ${da.numero} — ${da.service_demandeur}`,
  }, approbateurId);

  return {
    decId,
    daUpdated: db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id),
  };
}

function syncPaiementFournisseur({ facture, montant, datePaiement, positionId, modeReglement, refPaiement, userId }) {
  const position = positionId
    ? db.prepare("SELECT id FROM positions WHERE id=? AND actif=1").get(positionId)
    : db.prepare("SELECT id FROM positions WHERE actif=1 AND type IN ('caisse','banque') ORDER BY ordre LIMIT 1").get();
  if (!position) throw new Error('Aucune position de trésorerie active disponible pour le paiement fournisseur');

  const fournisseur = db.prepare('SELECT nom FROM fournisseurs WHERE id=?').get(facture.fournisseur_id);
  const cat = db.prepare(`
    SELECT id FROM categories
    WHERE type='depense' AND COALESCE(actif,1)=1
      AND (lower(nom) LIKE '%achat%' OR lower(nom) LIKE '%fournisseur%' OR lower(nom) LIKE '%charge%')
    ORDER BY id LIMIT 1
  `).get() || db.prepare("SELECT id FROM categories WHERE type='depense' ORDER BY id LIMIT 1").get();

  const operation = db.prepare(`
    INSERT INTO operations
      (date, libelle, tiers, montant, type_op, position_id, categorie_id,
       mode_reglement, ref_externe, statut, dec_statut,
       created_by, submitted_by, submitted_at, validated_by, validated_at, paid_by, paid_at)
    VALUES (?, ?, ?, ?, 'decaissement', ?, ?, ?, ?, 'valide', 'paye',
       ?, ?, datetime('now'), ?, datetime('now'), ?, datetime('now'))
  `).run(
    datePaiement,
    `Paiement facture fournisseur ${facture.numero_facture_fournisseur}`,
    fournisseur?.nom || 'Fournisseur',
    montant,
    position.id,
    cat?.id || null,
    modeReglement || 'virement_bancaire',
    refPaiement || `FF-${facture.id}`,
    userId,
    userId,
    userId,
    userId
  );

  return operation.lastInsertRowid;
}

// ─── Envoyer email de notification à soumission ───────────────────────────────
async function notifierApprobateurs(da, lignes) {
  try {
    const destinataires = db.prepare(`
      SELECT DISTINCT u.email, u.nom
      FROM users u
      LEFT JOIN delegations_approbation d
        ON d.delegue_id = u.id
        AND d.actif = 1
        AND d.date_debut <= date('now')
        AND (d.date_fin IS NULL OR d.date_fin >= date('now'))
      WHERE u.actif = 1
        AND u.email IS NOT NULL AND u.email != ''
        AND (
          u.role IN ('admin', 'dg')
          OR u.roles LIKE '%"admin"%'
          OR u.roles LIKE '%"dg"%'
          OR d.id IS NOT NULL
        )
    `).all();
    if (!destinataires.length) return;

    const lignesHtml = lignes.map(l => `
      <tr style="border-bottom:1px solid #334155">
        <td style="padding:8px 12px;color:#e2e8f0">${l.designation}</td>
        <td style="padding:8px 12px;color:#94a3b8;text-align:center">${l.quantite}</td>
        <td style="padding:8px 12px;color:#94a3b8;text-align:right">${Number(l.montant).toLocaleString('fr-FR')} FCFA</td>
        <td style="padding:8px 12px;color:#94a3b8">${l.fournisseur_recommande || '—'}</td>
      </tr>`).join('');

    const html = `
      <div style="font-family:Inter,sans-serif;max-width:620px;margin:auto;background:#0f172a;color:#e2e8f0;border-radius:16px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#d97706,#b45309);padding:28px 32px">
          <h1 style="margin:0;font-size:20px;color:white">TOP CENTER</h1>
          <p style="margin:6px 0 0;color:#fde68a;font-size:14px">Nouvelle Demande d'Achat à approuver</p>
        </div>
        <div style="padding:28px 32px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr><td style="color:#94a3b8;padding:4px 0;width:40%">Numéro</td><td style="color:#f59e0b;font-weight:700">${da.numero}</td></tr>
            <tr><td style="color:#94a3b8;padding:4px 0">Date</td><td style="color:#e2e8f0">${da.date_demande}</td></tr>
            <tr><td style="color:#94a3b8;padding:4px 0">Service</td><td style="color:#e2e8f0">${da.service_demandeur}</td></tr>
            <tr><td style="color:#94a3b8;padding:4px 0">Demandeur</td><td style="color:#e2e8f0">${da.demandeur_nom}</td></tr>
            <tr><td style="color:#94a3b8;padding:4px 0">Total</td><td style="color:#10b981;font-weight:700;font-size:16px">${Number(da.total_general).toLocaleString('fr-FR')} FCFA</td></tr>
          </table>
          <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">Détail des articles :</p>
          <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden">
            <thead>
              <tr style="background:#334155">
                <th style="padding:8px 12px;text-align:left;color:#94a3b8;font-size:12px">Désignation</th>
                <th style="padding:8px 12px;text-align:center;color:#94a3b8;font-size:12px">Quantité</th>
                <th style="padding:8px 12px;text-align:right;color:#94a3b8;font-size:12px">Montant</th>
                <th style="padding:8px 12px;text-align:left;color:#94a3b8;font-size:12px">Fournisseur</th>
              </tr>
            </thead>
            <tbody>${lignesHtml}</tbody>
          </table>
          ${da.commentaires ? `<p style="margin-top:16px;color:#94a3b8;font-size:13px">Commentaires : <span style="color:#e2e8f0">${da.commentaires}</span></p>` : ''}
          <p style="margin-top:24px;font-size:12px;color:#475569">TOP CENTER Caisse — ${new Date().toLocaleString('fr-FR')}</p>
        </div>
      </div>`;

    for (const dest of destinataires) {
      await sendMail({
        to: dest.email,
        subject: `Nouvelle demande d'achat à approuver — ${da.numero} (${da.service_demandeur})`,
        html
      });
    }
  } catch (e) {
    console.error('[ACHATS] Email notif error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/achats — liste
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/', (req, res) => {
  const { statut, service, date_debut, date_fin } = req.query;
  const user = req.user;

  let where = [];
  let params = [];

  if (!canSeeAll(user)) {
    where.push('da.demandeur_id = ?');
    params.push(user.id);
  }
  if (statut) { where.push('da.statut = ?'); params.push(statut); }
  if (service) { where.push('da.service_demandeur LIKE ?'); params.push(`%${service}%`); }
  if (date_debut) { where.push("da.date_demande >= ?"); params.push(date_debut); }
  if (date_fin)   { where.push("da.date_demande <= ?"); params.push(date_fin); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT da.*,
      (SELECT COUNT(*) FROM demandes_achat_lignes WHERE demande_id = da.id) AS nb_lignes
    FROM demandes_achat da
    ${whereClause}
    ORDER BY da.created_at DESC
  `).all(...params);

  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/achats/delegations — liste délégations
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/delegations', (req, res) => {
  if (!canSeeAll(req.user) && !hasRole(req.user, 'dg')) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const rows = db.prepare(`
    SELECT d.*,
      u1.nom AS delegant_nom,
      u2.nom AS delegue_nom_user
    FROM delegations_approbation d
    LEFT JOIN users u1 ON u1.id = d.delegant_id
    LEFT JOIN users u2 ON u2.id = d.delegue_id
    ORDER BY d.created_at DESC
  `).all();
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/achats/delegations — créer une délégation
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/delegations', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) {
    return res.status(403).json({ error: 'DG ou Admin requis' });
  }
  const { delegue_id, date_debut, date_fin, motif } = req.body;
  if (!delegue_id || !date_debut) {
    return res.status(400).json({ error: 'delegue_id et date_debut requis' });
  }
  const result = db.prepare(`
    INSERT INTO delegations_approbation (delegant_id, delegue_id, date_debut, date_fin, motif)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, delegue_id, date_debut, date_fin || null, motif || null);
  res.json({ id: result.lastInsertRowid, ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/delegations/:id/desactiver
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/delegations/:id/desactiver', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg')) {
    return res.status(403).json({ error: 'DG ou Admin requis' });
  }
  db.prepare("UPDATE delegations_approbation SET actif = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/achats/count-soumis — badge sidebar
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/count-soumis', (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS c FROM demandes_achat WHERE statut = 'soumis'").get().c;
  res.json({ count });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT 5 — BONS DE COMMANDE / RÉCEPTIONS / FACTURES FOURNISSEURS
// Placé AVANT router.get('/:id') pour éviter capture par paramètre dynamique
// ═══════════════════════════════════════════════════════════════════════════════

function auditLog(userId, action, table, recordId, details = '') {
  try {
    db.prepare(`INSERT INTO audit_logs (user_id, action, table_name, record_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))`)
      .run(userId, action, table, recordId,
        typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (_) {}
}

function genNumeroBc() {
  const y = new Date().getFullYear();
  const last = db.prepare(
    `SELECT numero FROM bons_commandes_fournisseurs WHERE numero LIKE 'BC-${y}-%' ORDER BY id DESC LIMIT 1`
  ).get();
  const n = last ? parseInt(last.numero.split('-')[2], 10) + 1 : 1;
  return `BC-${y}-${String(n).padStart(4, '0')}`;
}

function genNumeroRec() {
  const y = new Date().getFullYear();
  const last = db.prepare(
    `SELECT numero FROM receptions WHERE numero LIKE 'REC-${y}-%' ORDER BY id DESC LIMIT 1`
  ).get();
  const n = last ? parseInt(last.numero.split('-')[2], 10) + 1 : 1;
  return `REC-${y}-${String(n).padStart(4, '0')}`;
}

function calcTotauxBc(lignes) {
  let ht = 0, taxes = 0;
  for (const l of lignes) {
    const montHT  = (Number(l.quantite) || 1) * (Number(l.prix_unitaire) || 0);
    const montTax = montHT * ((Number(l.taux_taxe) || 0) / 100);
    l.montant_ht  = Math.round(montHT  * 100) / 100;
    l.montant_ttc = Math.round((montHT + montTax) * 100) / 100;
    ht    += montHT;
    taxes += montTax;
  }
  return {
    montant_ht:    Math.round(ht          * 100) / 100,
    montant_taxes: Math.round(taxes        * 100) / 100,
    montant_ttc:   Math.round((ht + taxes) * 100) / 100,
  };
}

function getLignesBc(bcId) {
  return db.prepare('SELECT * FROM bons_commandes_lignes WHERE bc_id = ? ORDER BY ordre ASC, id ASC').all(bcId);
}

function saveLignesBc(bcId, lignes) {
  db.prepare('DELETE FROM bons_commandes_lignes WHERE bc_id = ?').run(bcId);
  const ins = db.prepare(`INSERT INTO bons_commandes_lignes
    (bc_id, produit_id, designation, quantite, quantite_recue, prix_unitaire, taux_taxe, montant_ht, montant_ttc, ordre)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
  lignes.forEach((l, i) => {
    ins.run(bcId, l.produit_id || null, l.designation,
      Number(l.quantite) || 1, Number(l.prix_unitaire) || 0,
      Number(l.taux_taxe) || 0, l.montant_ht || 0, l.montant_ttc || 0,
      l.ordre != null ? l.ordre : i);
  });
}

// ── GET /api/achats/bons-commandes ────────────────────────────────────────────
router.get('/bons-commandes', (req, res) => {
  const { statut, fournisseur_id, search, limit = 50, offset = 0 } = req.query;
  const where = ['1=1']; const params = [];
  if (statut)         { where.push('bc.statut = ?');         params.push(statut); }
  if (fournisseur_id) { where.push('bc.fournisseur_id = ?'); params.push(fournisseur_id); }
  if (search) {
    where.push('(bc.numero LIKE ? OR f.nom LIKE ?)');
    const q = `%${search}%`; params.push(q, q);
  }
  const rows = db.prepare(`
    SELECT bc.*, f.nom AS fournisseur_nom, u.nom AS responsable_nom
    FROM bons_commandes_fournisseurs bc
    LEFT JOIN fournisseurs f ON f.id = bc.fournisseur_id
    LEFT JOIN users u        ON u.id = bc.responsable_achat_id
    WHERE ${where.join(' AND ')}
    ORDER BY bc.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM bons_commandes_fournisseurs bc LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id WHERE ${where.join(' AND ')}`
  ).get(...params).n;
  res.json({ bons_commandes: rows, total });
});

// ── POST /api/achats/bons-commandes ───────────────────────────────────────────
router.post('/bons-commandes', (req, res) => {
  const { fournisseur_id, demande_achat_id, delai_livraison, lieu_livraison,
          conditions_paiement, notes, lignes = [] } = req.body;
  if (!fournisseur_id) return res.status(400).json({ error: 'fournisseur_id requis' });
  if (!lignes.length)  return res.status(400).json({ error: 'Au moins une ligne requise' });
  for (const l of lignes)
    if (!l.designation?.trim()) return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });

  const fournisseur = db.prepare('SELECT id FROM fournisseurs WHERE id = ?').get(fournisseur_id);
  if (!fournisseur) return res.status(404).json({ error: 'Fournisseur introuvable' });

  const totaux = calcTotauxBc(lignes);
  const numero = genNumeroBc();

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO bons_commandes_fournisseurs
      (numero, fournisseur_id, demande_achat_id, statut, montant_ht, montant_taxes, montant_ttc,
       delai_livraison, lieu_livraison, conditions_paiement, responsable_achat_id, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(numero, fournisseur_id, demande_achat_id || null,
    totaux.montant_ht, totaux.montant_taxes, totaux.montant_ttc,
    delai_livraison || null, lieu_livraison || null, conditions_paiement || null,
    req.user.id, notes || null, req.user.id);

  saveLignesBc(lastInsertRowid, lignes);
  auditLog(req.user.id, 'CREATE', 'bons_commandes_fournisseurs', lastInsertRowid, { numero });
  const created = db.prepare('SELECT * FROM bons_commandes_fournisseurs WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ ...created, lignes: getLignesBc(lastInsertRowid) });
});

// ── GET /api/achats/bons-commandes/:id ────────────────────────────────────────
router.get('/bons-commandes/:id', (req, res) => {
  const bc = db.prepare(`
    SELECT bc.*, f.nom AS fournisseur_nom, u.nom AS responsable_nom
    FROM bons_commandes_fournisseurs bc
    LEFT JOIN fournisseurs f ON f.id = bc.fournisseur_id
    LEFT JOIN users u        ON u.id = bc.responsable_achat_id
    WHERE bc.id = ?
  `).get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
  const lignes     = getLignesBc(bc.id);
  const receptions = db.prepare('SELECT * FROM receptions WHERE bc_id = ? ORDER BY created_at DESC').all(bc.id);
  const factures   = db.prepare('SELECT * FROM factures_fournisseurs WHERE bc_id = ?').all(bc.id);
  res.json({ ...bc, lignes, receptions, factures });
});

// ── PUT /api/achats/bons-commandes/:id/statut ─────────────────────────────────
router.put('/bons-commandes/:id/statut', (req, res) => {
  if (!canOperateP2P(req.user))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const bc = db.prepare('SELECT * FROM bons_commandes_fournisseurs WHERE id = ?').get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
  const { statut, motif } = req.body;
  const VALIDES = ['brouillon','soumis','valide','envoye','accepte_fournisseur','partiellement_livre','livre','annule','cloture'];
  if (!VALIDES.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  if (statut === 'valide' && !hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Validation BC réservée DG, Finance ou Admin' });
  if (statut === 'annule' && !motif?.trim())
    return res.status(400).json({ error: 'Motif obligatoire pour annuler un BC' });
  db.prepare(`UPDATE bons_commandes_fournisseurs SET statut=?, motif_annulation=COALESCE(?,motif_annulation), updated_at=datetime('now') WHERE id=?`)
    .run(statut, motif || null, bc.id);
  auditLog(req.user.id, 'STATUT_CHANGE', 'bons_commandes_fournisseurs', bc.id, { ancien: bc.statut, nouveau: statut, motif });
  res.json({ ok: true, statut });
});

// ── POST /api/achats/bons-commandes/:id/valider ───────────────────────────────
router.post('/bons-commandes/:id/valider', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const bc = db.prepare('SELECT * FROM bons_commandes_fournisseurs WHERE id = ?').get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
  if (!['brouillon','soumis'].includes(bc.statut))
    return res.status(400).json({ error: `Validation impossible — statut : ${bc.statut}` });
  db.prepare(`UPDATE bons_commandes_fournisseurs SET statut='valide', updated_at=datetime('now') WHERE id=?`).run(bc.id);
  auditLog(req.user.id, 'VALIDER', 'bons_commandes_fournisseurs', bc.id, { ancienStatut: bc.statut });
  res.json({ ok: true, statut: 'valide' });
});

// ── POST /api/achats/receptions ───────────────────────────────────────────────
router.post('/receptions', (req, res) => {
  const { bc_id, date_reception, lignes = [], notes } = req.body;
  if (!bc_id)          return res.status(400).json({ error: 'bc_id requis' });
  if (!date_reception) return res.status(400).json({ error: 'date_reception requise' });
  if (!lignes.length)  return res.status(400).json({ error: 'Au moins une ligne requise' });
  const bc = db.prepare('SELECT * FROM bons_commandes_fournisseurs WHERE id = ?').get(bc_id);
  if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
  if (['annule','cloture'].includes(bc.statut))
    return res.status(400).json({ error: `Réception impossible sur BC ${bc.statut}` });

  const numero = genNumeroRec();
  const tx = db.transaction(() => {
    const { lastInsertRowid: recId } = db.prepare(`
      INSERT INTO receptions (numero, bc_id, statut, date_reception, notes, created_by, created_at, updated_at)
      VALUES (?, ?, 'en_cours', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(numero, bc_id, date_reception, notes || null, req.user.id);

    const insL = db.prepare(`INSERT INTO receptions_lignes
      (reception_id, bc_ligne_id, quantite_commandee, quantite_recue, quantite_conforme, ecart, motif_ecart, statut_ligne)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    let totalCmd = 0, totalRec = 0;
    for (const l of lignes) {
      const bcLigne = db.prepare('SELECT * FROM bons_commandes_lignes WHERE id = ? AND bc_id = ?').get(l.bc_ligne_id, bc_id);
      if (!bcLigne) continue;
      const qRec  = Number(l.quantite_recue)    || 0;
      const qConf = Number(l.quantite_conforme) ?? qRec;
      const ecart = qRec - bcLigne.quantite;
      const statutL = qConf < bcLigne.quantite ? (qConf === 0 ? 'non_conforme' : 'ecart') : 'conforme';
      insL.run(recId, bcLigne.id, bcLigne.quantite, qRec, qConf, ecart, l.motif_ecart || null, statutL);
      db.prepare('UPDATE bons_commandes_lignes SET quantite_recue = quantite_recue + ? WHERE id = ?').run(qRec, bcLigne.id);
      totalCmd += bcLigne.quantite;
      totalRec += qRec;
    }
    const statutRec = totalRec === 0 ? 'non_conforme' : totalRec < totalCmd ? 'reception_partielle' : 'reception_totale';
    db.prepare(`UPDATE receptions SET statut=?, updated_at=datetime('now') WHERE id=?`).run(statutRec, recId);
    const bcStatutNouv = statutRec === 'reception_totale' ? 'livre' : 'partiellement_livre';
    db.prepare(`UPDATE bons_commandes_fournisseurs SET statut=?, updated_at=datetime('now') WHERE id=?`).run(bcStatutNouv, bc_id);
    return recId;
  });

  const recId    = tx();
  auditLog(req.user.id, 'CREATE', 'receptions', recId, { numero, bc_id });
  const reception = db.prepare('SELECT * FROM receptions WHERE id = ?').get(recId);
  const recLignes = db.prepare('SELECT * FROM receptions_lignes WHERE reception_id = ?').all(recId);
  res.status(201).json({ ...reception, lignes: recLignes });
});

// ── GET /api/achats/receptions/:id ────────────────────────────────────────────
router.get('/receptions/:id', (req, res) => {
  const rec = db.prepare(`
    SELECT r.*, bc.numero AS bc_numero, f.nom AS fournisseur_nom
    FROM receptions r
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = r.bc_id
    LEFT JOIN fournisseurs f ON f.id = bc.fournisseur_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Réception introuvable' });
  const lignes = db.prepare('SELECT rl.*, bcl.designation, bcl.produit_id FROM receptions_lignes rl LEFT JOIN bons_commandes_lignes bcl ON bcl.id = rl.bc_ligne_id WHERE rl.reception_id = ?').all(rec.id);
  res.json({ ...rec, lignes });
});

// ── PUT /api/achats/receptions/:id/valider ────────────────────────────────────
router.put('/receptions/:id/valider', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const rec = db.prepare('SELECT * FROM receptions WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Réception introuvable' });
  if (rec.statut === 'accepte') return res.status(400).json({ error: 'Réception déjà validée' });

  const lignes = db.prepare(`
    SELECT rl.*, bcl.produit_id, bcl.designation FROM receptions_lignes rl
    LEFT JOIN bons_commandes_lignes bcl ON bcl.id = rl.bc_ligne_id
    WHERE rl.reception_id = ?
  `).all(rec.id);

  db.transaction(() => {
    for (const l of lignes) {
      if (!l.produit_id || l.quantite_conforme <= 0) continue;
      const produit = db.prepare('SELECT stock_disponible FROM produits WHERE id = ?').get(l.produit_id);
      if (!produit) continue;
      const qAvant = produit.stock_disponible;
      const qApres = qAvant + l.quantite_conforme;
      db.prepare(`UPDATE produits SET stock_disponible=?, updated_at=datetime('now') WHERE id=?`).run(qApres, l.produit_id);
      db.prepare(`INSERT INTO stock_mouvements (produit_id,type,quantite,quantite_avant,quantite_apres,reference_id,reference_type,motif,created_by,created_at)
        VALUES (?,'entree',?,?,?,?,'reception',?,?,datetime('now'))
      `).run(l.produit_id, l.quantite_conforme, qAvant, qApres, rec.id, `Réception ${rec.numero}`, req.user.id);
    }
    db.prepare(`UPDATE receptions SET statut='accepte', updated_at=datetime('now') WHERE id=?`).run(rec.id);
  })();

  auditLog(req.user.id, 'VALIDER', 'receptions', rec.id, { stockMisAJour: true });
  res.json({ ok: true, statut: 'accepte' });
});

// ── POST /api/achats/factures-fournisseurs ────────────────────────────────────
router.post('/factures-fournisseurs', (req, res) => {
  const { numero_facture_fournisseur, fournisseur_id, bc_id, reception_id,
          montant_ht, montant_ttc, date_facture, date_echeance, notes } = req.body;
  if (!numero_facture_fournisseur?.trim()) return res.status(400).json({ error: 'numero_facture_fournisseur requis' });
  if (!fournisseur_id) return res.status(400).json({ error: 'fournisseur_id requis' });
  if (!montant_ttc)    return res.status(400).json({ error: 'montant_ttc requis' });
  if (!date_facture)   return res.status(400).json({ error: 'date_facture requise' });

  const doublon = db.prepare('SELECT id FROM factures_fournisseurs WHERE numero_facture_fournisseur=? AND fournisseur_id=?')
    .get(numero_facture_fournisseur.trim(), fournisseur_id);
  if (doublon) return res.status(409).json({ error: `Doublon : facture ${numero_facture_fournisseur} déjà enregistrée pour ce fournisseur` });

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO factures_fournisseurs
      (numero_facture_fournisseur, fournisseur_id, bc_id, reception_id, statut,
       montant_ht, montant_ttc, date_facture, date_echeance, montant_paye, reste_a_payer, notes, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'recue',?,?,?,?,0,?,?,?,datetime('now'),datetime('now'))
  `).run(numero_facture_fournisseur.trim(), fournisseur_id, bc_id || null, reception_id || null,
    Number(montant_ht) || 0, Number(montant_ttc), date_facture, date_echeance || null,
    Number(montant_ttc), notes || null, req.user.id);

  auditLog(req.user.id, 'CREATE', 'factures_fournisseurs', lastInsertRowid, { numero_facture_fournisseur });
  res.status(201).json(db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(lastInsertRowid));
});

// ── GET /api/achats/factures-fournisseurs ─────────────────────────────────────
router.get('/factures-fournisseurs', (req, res) => {
  const { statut, fournisseur_id, limit = 50, offset = 0 } = req.query;
  const where = ['1=1']; const params = [];
  if (statut)         { where.push('ff.statut=?');         params.push(statut); }
  if (fournisseur_id) { where.push('ff.fournisseur_id=?'); params.push(fournisseur_id); }
  const rows = db.prepare(`
    SELECT ff.*, f.nom AS fournisseur_nom FROM factures_fournisseurs ff
    LEFT JOIN fournisseurs f ON f.id=ff.fournisseur_id
    WHERE ${where.join(' AND ')} ORDER BY ff.date_facture DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM factures_fournisseurs ff WHERE ${where.join(' AND ')}`).get(...params).n;
  res.json({ factures: rows, total });
});

// ── GET /api/achats/factures-fournisseurs/:id ─────────────────────────────────
router.get('/factures-fournisseurs/:id', (req, res) => {
  const ff = db.prepare(`
    SELECT ff.*, f.nom AS fournisseur_nom FROM factures_fournisseurs ff
    LEFT JOIN fournisseurs f ON f.id=ff.fournisseur_id WHERE ff.id=?
  `).get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture fournisseur introuvable' });
  res.json(ff);
});

// ── POST /api/achats/factures-fournisseurs/:id/valider ────────────────────────
router.post('/factures-fournisseurs/:id/valider', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Permission insuffisante' });
  const ff = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture fournisseur introuvable' });
  if (!['recue','a_verifier'].includes(ff.statut))
    return res.status(400).json({ error: `Validation impossible — statut : ${ff.statut}` });
  if (ff.bc_id) {
    const bc = db.prepare('SELECT statut FROM bons_commandes_fournisseurs WHERE id=?').get(ff.bc_id);
    if (bc && !['partiellement_livre','livre','cloture'].includes(bc.statut))
      return res.status(400).json({ error: 'Réception non confirmée — le BC doit être au moins partiellement livré' });
  }
  db.prepare(`UPDATE factures_fournisseurs SET statut='validee', updated_at=datetime('now') WHERE id=?`).run(ff.id);
  auditLog(req.user.id, 'VALIDER', 'factures_fournisseurs', ff.id, { ancienStatut: ff.statut });
  res.json({ ok: true, statut: 'validee' });
});

// ── POST /api/achats/factures-fournisseurs/:id/payer ─────────────────────────
router.post('/factures-fournisseurs/:id/payer', (req, res) => {
  if (!canPay(req.user))
    return res.status(403).json({ error: 'Paiement réservé Finance, Caisse ou Admin' });
  const ff = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture fournisseur introuvable' });
  if (!['validee','partiellement_payee'].includes(ff.statut))
    return res.status(400).json({ error: `Paiement impossible — facture doit être validée (statut : ${ff.statut})` });

  // ── Blocage rapprochement 3 voies ────────────────────────────────────────────
  // override_rapprochement=true autorisé uniquement DG ou Admin, avec motif obligatoire
  const { override_rapprochement, motif_override } = req.body || {};
  const peutOverrider = hasRole(req.user, 'admin', 'dg');

  if (ff.rapprochement_statut === 'ecart_bloquant') {
    if (override_rapprochement && peutOverrider && motif_override?.trim()) {
      // Override DG/Admin explicite — tracer l'exception
      auditLog(req.user.id, 'OVERRIDE_RAPPROCHEMENT', 'factures_fournisseurs', ff.id, {
        rapprochement_statut: ff.rapprochement_statut,
        motif_override: motif_override.trim(),
      });
      // Continuer vers le paiement
    } else if (override_rapprochement && peutOverrider && !motif_override?.trim()) {
      return res.status(400).json({
        error: 'Override rapprochement : motif obligatoire.',
        code: 'OVERRIDE_MOTIF_REQUIS',
      });
    } else {
      return res.status(400).json({
        error: 'Paiement bloqué — rapprochement 3 voies : écart bloquant. Faites corriger l\'écart par Finance ou demandez un override DG.',
        code: 'RAPPROCHEMENT_ECART_BLOQUANT',
        ecart_montant:  ff.ecart_montant,
        ecart_quantite: ff.ecart_quantite,
        ecart_motif:    ff.ecart_motif,
      });
    }
  }

  // Statut 'conteste' : bloquant sauf override DG/Admin explicite avec motif
  if (ff.rapprochement_statut === 'conteste') {
    if (override_rapprochement && peutOverrider && motif_override?.trim()) {
      auditLog(req.user.id, 'OVERRIDE_RAPPROCHEMENT_CONTESTE', 'factures_fournisseurs', ff.id, {
        motif_override: motif_override.trim(),
      });
      // Continuer vers le paiement
    } else if (override_rapprochement && peutOverrider && !motif_override?.trim()) {
      return res.status(400).json({
        error: 'Override contestation : motif obligatoire.',
        code: 'OVERRIDE_MOTIF_REQUIS',
      });
    } else {
      return res.status(400).json({
        error: 'Paiement bloqué — facture contestée. Un DG ou Admin peut lever le blocage avec motif explicite.',
        code: 'RAPPROCHEMENT_CONTESTE',
        ecart_motif: ff.ecart_motif,
      });
    }
  }

  if (ff.rapprochement_statut === 'non_rapproche' && ff.bc_id) {
    // Auto-rapprochement silencieux avant paiement si BC existe
    const rapport = calculerRapprochement(ff);
    db.prepare(`
      UPDATE factures_fournisseurs
      SET rapprochement_statut=?, ecart_montant=?, ecart_quantite=?,
          ecart_motif=?, rapprochement_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(rapport.statut, rapport.ecart_montant, rapport.ecart_quantite,
           rapport.details.join(' | '), ff.id);
    auditLog(req.user.id, 'RAPPROCHEMENT_AUTO', 'factures_fournisseurs', ff.id, rapport);
    if (rapport.statut === 'ecart_bloquant') {
      return res.status(400).json({
        error: 'Paiement bloqué — rapprochement automatique : écart bloquant détecté.',
        code: 'RAPPROCHEMENT_ECART_BLOQUANT',
        ecart_montant:  rapport.ecart_montant,
        ecart_quantite: rapport.ecart_quantite,
        details:        rapport.details,
      });
    }
  }

  const { montant, date_paiement, position_id, mode_reglement, ref_paiement } = req.body;
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: 'Montant invalide' });
  if (!date_paiement) return res.status(400).json({ error: 'date_paiement requise' });

  const montantNum    = Number(montant);
  if (montantNum > ff.reste_a_payer + 0.01)
    return res.status(400).json({ error: `Montant (${montantNum}) supérieur au reste à payer (${ff.reste_a_payer})` });

  const nouveauPaye   = Math.round((ff.montant_paye + montantNum) * 100) / 100;
  const nouveauReste  = Math.round((ff.montant_ttc  - nouveauPaye) * 100) / 100;
  const nouveauStatut = nouveauReste <= 0.01 ? 'payee' : 'partiellement_payee';

  let operationId;
  const tx = db.transaction(() => {
    operationId = syncPaiementFournisseur({
      facture: ff,
      montant: montantNum,
      datePaiement: date_paiement,
      positionId: position_id ? Number(position_id) : null,
      modeReglement: mode_reglement || 'virement_bancaire',
      refPaiement: ref_paiement || null,
      userId: req.user.id,
    });
    db.prepare(`UPDATE factures_fournisseurs SET montant_paye=?, reste_a_payer=?, statut=?, operation_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(nouveauPaye, Math.max(0, nouveauReste), nouveauStatut, operationId, ff.id);
  });
  tx();

  try {
    const operations = require('./operations');
    if (operations.recalculateSoldes) operations.recalculateSoldes();
  } catch (_) {}

  auditLog(req.user.id, 'PAIEMENT', 'factures_fournisseurs', ff.id, { montant: montantNum, nouveauStatut, operation_id: operationId });

  res.json({ ok: true, operation_id: operationId, facture: db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(ff.id) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/achats — créer une demande avec lignes
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/', (req, res) => {
  const { service_demandeur, demandeur_nom, date_demande, commentaires, transport, lignes } = req.body;
  if (!service_demandeur || !demandeur_nom) {
    return res.status(400).json({ error: 'service_demandeur et demandeur_nom requis' });
  }
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: 'Au moins une ligne requise' });
  }

  const numero = genNumero();
  const total_articles = lignes.reduce((s, l) => s + Number(l.montant || 0), 0);
  const transport_val = Number(transport || 0);
  const total_general = total_articles + transport_val;

  const insertDA = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO demandes_achat
        (numero, date_demande, service_demandeur, demandeur_id, demandeur_nom,
         statut, commentaires, transport, total_articles, total_general)
      VALUES (?, ?, ?, ?, ?, 'brouillon', ?, ?, ?, ?)
    `).run(
      numero,
      date_demande || new Date().toISOString().split('T')[0],
      service_demandeur,
      req.user.id,
      demandeur_nom,
      commentaires || null,
      transport_val,
      total_articles,
      total_general
    );
    const daId = r.lastInsertRowid;
    const insLigne = db.prepare(`
      INSERT INTO demandes_achat_lignes
        (demande_id, designation, quantite, montant, fournisseur_recommande, ordre)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    lignes.forEach((l, i) => {
      insLigne.run(daId, l.designation, l.quantite || '1', Number(l.montant || 0), l.fournisseur_recommande || null, i);
    });
    return daId;
  });

  const daId = insertDA();
  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(daId);
  res.status(201).json(da);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/:id — modifier (seulement brouillon)
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/:id', (req, res) => {
  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  if (da.statut !== 'brouillon') return res.status(400).json({ error: 'Seules les demandes en brouillon sont modifiables' });
  if (da.demandeur_id !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const { service_demandeur, demandeur_nom, date_demande, commentaires, transport, lignes } = req.body;
  const total_articles = Array.isArray(lignes) ? lignes.reduce((s, l) => s + Number(l.montant || 0), 0) : da.total_articles;
  const transport_val = Number(transport ?? da.transport);
  const total_general = total_articles + transport_val;

  const updateDA = db.transaction(() => {
    db.prepare(`
      UPDATE demandes_achat SET
        service_demandeur = ?, demandeur_nom = ?, date_demande = ?,
        commentaires = ?, transport = ?, total_articles = ?, total_general = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      service_demandeur || da.service_demandeur,
      demandeur_nom || da.demandeur_nom,
      date_demande || da.date_demande,
      commentaires ?? da.commentaires,
      transport_val,
      total_articles,
      total_general,
      da.id
    );
    if (Array.isArray(lignes)) {
      db.prepare('DELETE FROM demandes_achat_lignes WHERE demande_id = ?').run(da.id);
      const insLigne = db.prepare(`
        INSERT INTO demandes_achat_lignes
          (demande_id, designation, quantite, montant, fournisseur_recommande, ordre)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      lignes.forEach((l, i) => {
        insLigne.run(da.id, l.designation, l.quantite || '1', Number(l.montant || 0), l.fournisseur_recommande || null, i);
      });
    }
  });
  updateDA();
  const updated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/:id/soumettre — passe en 'soumis' + email notif
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/:id/soumettre', async (req, res) => {
  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  if (da.statut !== 'brouillon') return res.status(400).json({ error: 'La demande n\'est pas en brouillon' });
  if (da.demandeur_id !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Seul le créateur peut soumettre' });
  }

  const lignes = db.prepare('SELECT * FROM demandes_achat_lignes WHERE demande_id = ? ORDER BY ordre, id').all(da.id);

  if (canApprove(req.user)) {
    const { decId, daUpdated } = approuverDemandeAchat(da, req.user);
    return res.json({ ok: true, da: daUpdated, decaissement_id: decId, dec_statut: 'valide', auto_approved: true });
  }

  db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);

  const daUpdated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);

  // Email asynchrone (ne bloque pas la réponse)
  notifierApprobateurs(daUpdated, lignes);
  setImmediate(() => {
    try {
      creerNotification({
        type:     'NOTIF_ACHAT_SOUMIS',
        titre:    `Demande d'achat à approuver — ${daUpdated.numero}`,
        message:  `${daUpdated.service_demandeur || 'Service'} — ${new Intl.NumberFormat('fr-FR').format(Number(daUpdated.total_general || 0))} XAF soumis par ${req.user.nom || req.user.email}`,
        srcTable: 'demandes_achat',
        srcId:    daUpdated.id,
        userIds:  getAchatApproverUserIds(),
        createdBy: req.user.id,
      });
    } catch (_) {}
  });

  res.json({ ok: true, da: daUpdated });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/:id/approuver — approuve + génère décaissement
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/:id/approuver', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Approbation non autorisée pour ce rôle' });

  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  // Le DG, l'admin ou un délégué actif peut approuver depuis brouillon directement.
  if (!['brouillon', 'soumis'].includes(da.statut)) {
    return res.status(400).json({ error: 'La demande doit être en brouillon ou soumis' });
  }
  // Passer en soumis d'abord si brouillon (traçabilité)
  if (da.statut === 'brouillon') {
    db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);
  }

  const approbateurId = req.user.id;
  const approbateurNom = req.user.nom;
  const { decId, daUpdated } = approuverDemandeAchat(da, req.user);

  setImmediate(() => {
    try {
      // Notifier le demandeur
      if (da.demandeur_id) {
        creerNotification({
          type:     'NOTIF_ACHAT_APPROUVE',
          titre:    `Demande d'achat approuvée — ${da.numero}`,
          message:  `Votre demande "${da.numero}" (${new Intl.NumberFormat('fr-FR').format(da.total_general)} XAF) a été approuvée par ${approbateurNom}. Décaissement validé, prêt au paiement.`,
          srcTable: 'demandes_achat',
          srcId:    da.id,
          userIds:  [da.demandeur_id],
          createdBy: approbateurId,
        });
      }
    } catch (_) {}
  });

  res.json({ ok: true, da: daUpdated, decaissement_id: decId, dec_statut: 'valide' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/:id/rejeter — rejete avec motif
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/:id/rejeter', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Rejet non autorisé pour ce rôle' });

  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  if (da.statut !== 'soumis') return res.status(400).json({ error: 'La demande doit être en statut soumis' });

  const { motif } = req.body;
  db.prepare(`
    UPDATE demandes_achat SET
      statut = 'rejete', motif_rejet = ?,
      approuve_par_id = ?, approuve_par_nom = ?,
      date_approbation = date('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(motif || null, req.user.id, req.user.nom, da.id);

  const daUpdated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);

  setImmediate(() => {
    try {
      if (da.demandeur_id) {
        creerNotification({
          type:     'NOTIF_ACHAT_REJETE',
          titre:    `Demande d'achat rejetée — ${da.numero}`,
          message:  `Votre demande "${da.numero}" a été rejetée. Motif : ${motif || 'Non précisé'}.`,
          srcTable: 'demandes_achat',
          srcId:    da.id,
          userIds:  [da.demandeur_id],
          createdBy: req.user.id,
        });
      }
    } catch (_) {}
  });

  res.json({ ok: true, da: daUpdated });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/achats/:id — supprime (seulement brouillon, par le créateur)
// ═══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', (req, res) => {
  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  if (da.statut !== 'brouillon') return res.status(400).json({ error: 'Seules les demandes en brouillon peuvent être supprimées' });
  if (da.demandeur_id !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  db.prepare('DELETE FROM demandes_achat WHERE id = ?').run(da.id);
  res.json({ ok: true });
});

// ─── Helper local isAdmin ─────────────────────────────────────────────────────
function isAdmin(user) { return hasRole(user, 'admin'); }

// ── Helpers PDF bons de commande ──────────────────────────────────────────────
function getSociete() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='societe'").get();
  return r ? r.valeur : 'TOP CENTER';
}
function getDevise() {
  const r = db.prepare("SELECT valeur FROM parametres WHERE cle='devise'").get();
  return r ? r.valeur : 'XAF';
}

const { generatePdf } = require('../services/pdf');

function buildHtmlBc(bc, lignes, devise, societe) {
  const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(v || 0);
  const fmtDate = d => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  const lignesHtml = lignes.map((l, i) => `
    <tr style="border-bottom:1px solid #f1f5f9;background:${i % 2 === 1 ? '#fafbfe' : '#fff'}">
      <td style="padding:7px 9px;text-align:center;font-size:10px;color:#94a3b8">${i + 1}</td>
      <td style="padding:7px 9px;font-size:11px;font-weight:600;color:#0f172a">${l.designation || '—'}</td>
      <td style="padding:7px 9px;text-align:center;font-size:11px;font-weight:700">${l.quantite}</td>
      <td style="padding:7px 9px;text-align:right;font-size:11px">${fmt(l.prix_unitaire)}</td>
      <td style="padding:7px 9px;text-align:right;font-size:11px;font-weight:600">${fmt(l.montant_ht)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:12px;color:#1e293b}
  .header-band{background:#1A50D9;padding:8mm 12mm;display:flex;justify-content:space-between;align-items:center;color:#fff}
  .brand{font-size:22px;font-weight:700}
  .brand-sub{font-size:9px;opacity:.8;text-transform:uppercase;letter-spacing:2px;margin-top:2px}
  .doc-label{display:inline-block;background:rgba(255,255,255,.15);border:1.5px solid rgba(255,255,255,.4);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;padding:3px 10px;border-radius:4px;margin-bottom:4px;color:#fff}
  .doc-title{font-size:20px;font-weight:700;text-align:right}
  .doc-meta{font-size:9px;opacity:.8;text-align:right;margin-top:2px}
  .info-grid{display:grid;grid-template-columns:1fr 1fr 0.8fr;border-bottom:1px solid #e2e8f0}
  .info-cell{padding:5mm 9mm;border-right:1px solid #e2e8f0}
  .info-cell:last-child{border-right:none}
  .cell-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#1A50D9;margin-bottom:5px}
  .cell-name{font-size:12px;font-weight:700;color:#0f172a;margin-bottom:3px}
  .cell-detail{font-size:9px;color:#475569;line-height:1.7}
  .kv{display:flex;justify-content:space-between;font-size:9.5px;margin-bottom:3px}
  .kk{color:#64748b}.vv{font-weight:600;color:#0f172a}
  .content{padding:5mm 12mm}
  table{width:100%;border-collapse:collapse}
  thead th{background:#1A50D9;color:#fff;font-weight:600;padding:7px 9px;font-size:9px;text-transform:uppercase}
  thead th.r{text-align:right}thead th.c{text-align:center}
  .bottom{display:flex;gap:4mm;padding:4mm 12mm}
  .conditions{flex:1;background:#f8fafc;border-radius:6px;padding:9px 11px}
  .cond-title{font-size:8px;font-weight:700;text-transform:uppercase;color:#1A50D9;margin-bottom:8px}
  .cond-item{display:flex;align-items:flex-start;gap:5px;font-size:9px;color:#475569;margin-bottom:4px;line-height:1.4}
  .cond-item::before{content:"→";color:#1A50D9;font-weight:700;flex-shrink:0}
  .tot{width:68mm}
  .tot-line{display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid #f1f5f9;color:#475569}
  .tot-line .v{font-weight:600;color:#334155}
  .tot-grand{display:flex;justify-content:space-between;background:#1A50D9;color:#fff;font-weight:700;font-size:13px;padding:8px 10px;border-radius:6px;margin-top:6px}
  .sigs{display:flex;gap:4mm;padding:0 12mm 4mm}
  .sig-box{flex:1;border:1.5px dashed #cbd5e1;border-radius:6px;padding:8px 10px}
  .sig-box.cta{border-color:#1A50D9;border-style:solid;background:#eff6ff}
  .sig-title{font-size:8px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:5px}
  .sig-box.cta .sig-title{color:#1A50D9}
  .sig-line{height:1px;background:#e2e8f0;margin-bottom:20px}
  .sig-sub{font-size:8px;color:#94a3b8;text-align:center}
  .footer{background:#1A50D9;color:rgba(255,255,255,.8);padding:4mm 12mm;display:flex;justify-content:space-between;font-size:8px;line-height:1.7}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head><body>

<div class="header-band">
  <div>
    <div class="brand">${societe}</div>
    <div class="brand-sub">SARL</div>
  </div>
  <div style="text-align:right">
    <div><span class="doc-label">Document d'achat</span></div>
    <div class="doc-title">BON DE COMMANDE</div>
    <div class="doc-meta">${bc.numero} — Émis le ${fmtDate(bc.created_at)}</div>
  </div>
</div>

<div class="info-grid">
  <div class="info-cell">
    <div class="cell-label">Acheteur</div>
    <div class="cell-name">${societe} SARL</div>
    <div class="cell-detail">Brazzaville, République du Congo<br>contact@topcenter.cg</div>
  </div>
  <div class="info-cell">
    <div class="cell-label">Fournisseur</div>
    <div class="cell-name">${bc.fournisseur_nom || '—'}</div>
    <div class="cell-detail">${bc.lieu_livraison ? 'Livraison : ' + bc.lieu_livraison : ''}</div>
  </div>
  <div class="info-cell">
    <div class="cell-label">Références</div>
    <div class="kv"><span class="kk">N° BC</span><span class="vv">${bc.numero}</span></div>
    <div class="kv"><span class="kk">Date</span><span class="vv">${fmtDate(bc.created_at)}</span></div>
    ${bc.delai_livraison ? `<div class="kv"><span class="kk">Livraison</span><span class="vv" style="color:#dc2626">${bc.delai_livraison}</span></div>` : ''}
    <div class="kv"><span class="kk">Statut</span><span class="vv">${bc.statut || '—'}</span></div>
    <div class="kv"><span class="kk">Devise</span><span class="vv">${devise}</span></div>
  </div>
</div>

<div class="content">
<br>
<table>
  <thead><tr>
    <th class="c" style="width:6%">#</th>
    <th style="width:45%;text-align:left">Désignation</th>
    <th class="c" style="width:9%">Qté</th>
    <th class="r" style="width:15%">P.U. HT</th>
    <th class="r" style="width:15%">Montant HT</th>
  </tr></thead>
  <tbody>${lignesHtml}</tbody>
</table>
</div>

<div class="bottom">
  <div class="conditions">
    <div class="cond-title">Conditions &amp; Instructions</div>
    ${bc.conditions_paiement ? `<div class="cond-item">Paiement : ${bc.conditions_paiement}</div>` : ''}
    ${bc.notes ? `<div class="cond-item">${bc.notes}</div>` : ''}
    <div class="cond-item">Livraison en parfait état, emballage d'origine.</div>
    <div class="cond-item">Joindre bon de livraison signé et facture en 2 exemplaires.</div>
  </div>
  <div class="tot">
    <div class="tot-line"><span>Total HT</span><span class="v">${fmt(bc.montant_ht)} ${devise}</span></div>
    <div class="tot-line"><span>Taxes</span><span class="v">${fmt(bc.montant_taxes)} ${devise}</span></div>
    <div class="tot-grand"><span>TOTAL TTC</span><span>${fmt(bc.montant_ttc)} ${devise}</span></div>
  </div>
</div>

<div class="sigs">
  <div class="sig-box">
    <div class="sig-title">Responsable Achats</div>
    <div class="sig-line"></div><div class="sig-line"></div>
    <div class="sig-sub">${bc.responsable_nom || 'Responsable Achats'}</div>
  </div>
  <div class="sig-box">
    <div class="sig-title">Approbation Direction</div>
    <div class="sig-line"></div><div class="sig-line"></div>
    <div class="sig-sub">Directeur Général / DGA</div>
  </div>
  <div class="sig-box cta">
    <div class="sig-title">Confirmation Fournisseur</div>
    <div class="sig-line"></div><div class="sig-line"></div>
    <div class="sig-sub">${bc.fournisseur_nom || 'Fournisseur'} — Cachet &amp; Signature</div>
  </div>
</div>

<div class="footer">
  <div>${societe} SARL — Brazzaville, Congo</div>
  <div style="text-align:center">${bc.numero} — Tala SMI</div>
  <div style="text-align:right">contact@topcenter.cg</div>
</div>
</body></html>`;
}

// ── GET /api/achats/bons-commandes/:id/pdf ────────────────────────────────────
router.get('/bons-commandes/:id/pdf', async (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance', 'assistante_direction'))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const bc = db.prepare(`
    SELECT bc.*, f.nom AS fournisseur_nom, u.nom AS responsable_nom
    FROM bons_commandes_fournisseurs bc
    LEFT JOIN fournisseurs f ON f.id = bc.fournisseur_id
    LEFT JOIN users u        ON u.id = bc.responsable_achat_id
    WHERE bc.id = ?
  `).get(req.params.id);
  if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });

  const lignes = getLignesBc(bc.id);

  try {
    const html   = buildHtmlBc(bc, lignes, getDevise(), getSociete());
    const pdfBuf = await generatePdf(html, { prefix: 'bc', marginTop: '0mm', marginBottom: '0mm', marginLeft: '0mm', marginRight: '0mm' });
    const nomFich = `bon_commande_${bc.numero}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    auditLog(req.user.id, 'PDF_DOWNLOAD', 'bons_commandes_fournisseurs', bc.id, { numero: bc.numero, par: req.user.email });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFich}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: 'Génération PDF échouée : ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAPPROCHEMENT 3 VOIES — BC ↔ Réception ↔ Facture fournisseur
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Seuil d'écart toléré (en %) au-delà duquel l'écart est bloquant.
 * Configurable via paramètre DB 'rapprochement_seuil_pct' (défaut 2 %).
 */
function getSeuilEcart() {
  try {
    const row = db.prepare("SELECT valeur FROM parametres WHERE cle='rapprochement_seuil_pct'").get();
    return row ? parseFloat(row.valeur) / 100 : 0.02;
  } catch (_) { return 0.02; }
}

/**
 * Calcule le rapprochement entre la facture, son BC et ses réceptions.
 * Retourne { statut, ecart_montant, ecart_quantite, details }.
 */
/**
 * Calcule le rapprochement 3 voies : BC ↔ Réception ↔ Facture.
 *
 * Règle réception partielle :
 *   - Facture partielle (montant ≤ valeur reçue conforme) → acceptable
 *   - Facture totale alors que réception partielle        → bloquant
 *
 * @param {object} ff - Enregistrement factures_fournisseurs complet
 * @returns {{ statut, ecart_montant, ecart_quantite, details[] }}
 */
function calculerRapprochement(ff) {
  const result = {
    statut: 'conforme',
    ecart_montant: 0,
    ecart_quantite: 0,
    details: [],
  };

  // ── 1. Existence BC ──────────────────────────────────────────────────────────
  if (!ff.bc_id) {
    result.statut = 'ecart_bloquant';
    result.details.push('Aucun bon de commande associé à cette facture.');
    return result;
  }

  const bc = db.prepare('SELECT * FROM bons_commandes_fournisseurs WHERE id=?').get(ff.bc_id);
  if (!bc) {
    result.statut = 'ecart_bloquant';
    result.details.push(`BC #${ff.bc_id} introuvable.`);
    return result;
  }

  const seuil = getSeuilEcart();

  // ── 2. Existence d'au moins une réception ────────────────────────────────────
  const receptions = db.prepare('SELECT * FROM receptions WHERE bc_id=?').all(ff.bc_id);
  if (!receptions.length) {
    result.statut = 'ecart_bloquant';
    result.details.push('Aucune réception enregistrée pour ce bon de commande — paiement impossible sans réception.');
    return result;
  }

  // ── 3. Réception associée à la facture (si renseignée) ──────────────────────
  if (ff.reception_id) {
    const rec = db.prepare('SELECT * FROM receptions WHERE id=?').get(ff.reception_id);
    if (!rec) {
      result.statut = 'ecart_bloquant';
      result.details.push(`Réception #${ff.reception_id} référencée mais introuvable.`);
      return result;
    }
    if (rec.statut === 'non_conforme') {
      result.statut = 'ecart_bloquant';
      result.details.push(`La réception #${ff.reception_id} est marquée non conforme.`);
    }
  }

  // ── 4. Contrôle quantités ligne par ligne + montant reçu conforme ────────────
  const lignesBc = getLignesBc(ff.bc_id);
  let totalEcartQte       = 0;
  let montantReçuConforme = 0; // valeur TTC des quantités effectivement reçues conformes

  for (const ligne of lignesBc) {
    const totalRecu = db.prepare(`
      SELECT COALESCE(SUM(rl.quantite_conforme), 0) AS total_conforme
      FROM receptions_lignes rl
      JOIN receptions r ON r.id = rl.reception_id
      WHERE rl.bc_ligne_id = ? AND r.bc_id = ?
    `).get(ligne.id, ff.bc_id);

    const qteConforme  = totalRecu.total_conforme;
    const qteCommandee = ligne.quantite;
    const ecartQte     = qteCommandee - qteConforme;
    totalEcartQte     += Math.abs(ecartQte);

    // Contribution de cette ligne au montant reçu conforme
    const prixUnitaireTtc = ligne.prix_unitaire * (1 + (ligne.taux_taxe || 0) / 100);
    montantReçuConforme  += qteConforme * prixUnitaireTtc;

    if (ecartQte > 0.001) {
      result.details.push(
        `"${ligne.designation}" : commandé ${qteCommandee}, reçu conforme ${qteConforme} (−${ecartQte.toFixed(2)} unité(s)).`
      );
    }
  }
  result.ecart_quantite       = Math.round(totalEcartQte * 100) / 100;
  montantReçuConforme         = Math.round(montantReçuConforme * 100) / 100;

  // ── 5. Règle réception partielle vs montant facturé ─────────────────────────
  //   Réception partielle = toutes les quantités n'ont pas encore été reçues conformes
  const receptionPartielle = totalEcartQte > 0.001;

  if (receptionPartielle) {
    const factureEstPartielle = ff.montant_ttc <= montantReçuConforme + 1; // tolérance 1 XAF
    if (factureEstPartielle) {
      // Facture partielle conforme aux quantités reçues → acceptable
      result.details.push(
        `Réception partielle : ${fmtXAF(montantReçuConforme)} reçus conformes, facture de ${fmtXAF(ff.montant_ttc)} — acceptable car facture ≤ reçu.`
      );
      if (result.statut === 'conforme') result.statut = 'ecart_acceptable';
    } else {
      // Facture totale alors que réception partielle → bloquant
      result.statut = 'ecart_bloquant';
      result.details.push(
        `Réception partielle bloquante : facture de ${fmtXAF(ff.montant_ttc)} alors que seulement ${fmtXAF(montantReçuConforme)} ont été reçus conformes.`
      );
    }
  }

  // ── 6. Écart de montant BC vs Facture ────────────────────────────────────────
  // Ce contrôle est fait en dernier : si réception partielle acceptable,
  // on compare la facture au montant reçu (pas au BC total)
  const referenceComparaison = receptionPartielle ? montantReçuConforme : bc.montant_ttc;
  const libRef               = receptionPartielle ? 'montant reçu conforme' : 'montant BC';
  const ecartMontant         = ff.montant_ttc - referenceComparaison;
  const pctMontant           = referenceComparaison > 0
    ? Math.abs(ecartMontant) / referenceComparaison : 0;
  result.ecart_montant = Math.round(ecartMontant * 100) / 100;

  if (Math.abs(ecartMontant) > 1) {
    const msg = `Montant facture ${fmtXAF(ff.montant_ttc)} ≠ ${libRef} ${fmtXAF(referenceComparaison)}, écart ${ecartMontant > 0 ? '+' : ''}${Math.round(ecartMontant)} XAF (${(pctMontant * 100).toFixed(2)} %).`;
    result.details.push(msg);
    if (pctMontant > seuil && result.statut !== 'ecart_bloquant') {
      result.statut = 'ecart_bloquant';
    } else if (result.statut === 'conforme') {
      result.statut = 'ecart_acceptable';
    }
  }

  return result;
}

function fmtXAF(n) {
  return (n || 0).toLocaleString('fr-CG') + ' XAF';
}

// ── GET /api/achats/factures-fournisseurs/:id/rapprochement ──────────────────
// Calcule et retourne le résultat du rapprochement sans l'enregistrer
router.get('/factures-fournisseurs/:id/rapprochement', (req, res) => {
  if (!canOperateP2P(req.user))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const ff = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture introuvable' });

  const rapport = calculerRapprochement(ff);

  // Enrichir avec les données liées pour l'affichage
  const bc  = ff.bc_id ? db.prepare(
    'SELECT id, numero, montant_ttc, statut FROM bons_commandes_fournisseurs WHERE id=?'
  ).get(ff.bc_id) : null;
  const recs = ff.bc_id ? db.prepare(
    'SELECT id, numero, statut, date_reception FROM receptions WHERE bc_id=? ORDER BY date_reception ASC'
  ).all(ff.bc_id) : [];

  res.json({
    facture_id:      ff.id,
    facture_num:     ff.numero_facture_fournisseur,
    montant_facture: ff.montant_ttc,
    bc,
    receptions: recs,
    rapprochement_actuel: {
      statut:     ff.rapprochement_statut,
      at:         ff.rapprochement_at,
      ecart_montant:   ff.ecart_montant,
      ecart_quantite:  ff.ecart_quantite,
      ecart_motif:     ff.ecart_motif,
    },
    simulation: rapport,
  });
});

// ── POST /api/achats/factures-fournisseurs/:id/rapprocher ────────────────────
// Effectue et enregistre le rapprochement (finance / admin / dg)
router.post('/factures-fournisseurs/:id/rapprocher', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg', 'finance'))
    return res.status(403).json({ error: 'Rapprochement réservé Finance, DG ou Admin' });

  const ff = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture introuvable' });
  if (['payee', 'annulee'].includes(ff.statut))
    return res.status(400).json({ error: `Rapprochement impossible sur une facture ${ff.statut}` });

  const rapport = calculerRapprochement(ff);
  const { motif_ecart } = req.body; // motif optionnel fourni par l'utilisateur

  db.prepare(`
    UPDATE factures_fournisseurs
    SET rapprochement_statut = ?,
        rapprochement_at     = datetime('now'),
        rapprochement_by     = ?,
        ecart_montant        = ?,
        ecart_quantite       = ?,
        ecart_motif          = ?,
        statut               = CASE
          WHEN statut = 'recue' OR statut = 'a_verifier' THEN
            CASE WHEN ? = 'ecart_bloquant' THEN 'contestee' ELSE 'a_verifier' END
          ELSE statut
        END,
        updated_at           = datetime('now')
    WHERE id = ?
  `).run(
    rapport.statut,
    req.user.id,
    rapport.ecart_montant,
    rapport.ecart_quantite,
    motif_ecart || rapport.details.join(' | ') || null,
    rapport.statut,
    ff.id,
  );

  auditLog(req.user.id, 'RAPPROCHEMENT', 'factures_fournisseurs', ff.id, {
    statut:          rapport.statut,
    ecart_montant:   rapport.ecart_montant,
    ecart_quantite:  rapport.ecart_quantite,
    details:         rapport.details,
  });

  const updated = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(ff.id);
  res.json({ ok: true, rapprochement: rapport, facture: updated });
});

// ── POST /api/achats/factures-fournisseurs/:id/contester-rapprochement ───────
// Force un statut 'conteste' avec motif (admin seulement)
router.post('/factures-fournisseurs/:id/contester-rapprochement', (req, res) => {
  if (!hasRole(req.user, 'admin', 'dg'))
    return res.status(403).json({ error: 'Contestation réservée DG ou Admin' });

  const ff = db.prepare('SELECT * FROM factures_fournisseurs WHERE id=?').get(req.params.id);
  if (!ff) return res.status(404).json({ error: 'Facture introuvable' });

  const { motif } = req.body;
  if (!motif?.trim()) return res.status(400).json({ error: 'Motif de contestation obligatoire' });

  db.prepare(`
    UPDATE factures_fournisseurs
    SET rapprochement_statut = 'conteste',
        ecart_motif          = ?,
        statut               = 'contestee',
        updated_at           = datetime('now')
    WHERE id = ?
  `).run(motif.trim(), ff.id);

  auditLog(req.user.id, 'CONTESTATION_RAPPROCHEMENT', 'factures_fournisseurs', ff.id, { motif });
  res.json({ ok: true });
});

// ── GET /api/achats/rapprochement/tableau-de-bord ────────────────────────────
// Vue d'ensemble : toutes les factures avec leur statut de rapprochement
router.get('/rapprochement/tableau-de-bord', (req, res) => {
  if (!canOperateP2P(req.user))
    return res.status(403).json({ error: 'Permission insuffisante' });

  const rows = db.prepare(`
    SELECT
      ff.id, ff.numero_facture_fournisseur, ff.montant_ttc,
      ff.statut, ff.rapprochement_statut,
      ff.ecart_montant, ff.ecart_quantite, ff.ecart_motif,
      ff.rapprochement_at, ff.date_facture,
      f.nom AS fournisseur_nom,
      bc.numero AS bc_numero,
      u.nom AS rapprocha_par
    FROM factures_fournisseurs ff
    LEFT JOIN fournisseurs f ON f.id = ff.fournisseur_id
    LEFT JOIN bons_commandes_fournisseurs bc ON bc.id = ff.bc_id
    LEFT JOIN users u ON u.id = ff.rapprochement_by
    WHERE ff.statut NOT IN ('annulee')
    ORDER BY
      CASE ff.rapprochement_statut
        WHEN 'ecart_bloquant'  THEN 1
        WHEN 'non_rapproche'   THEN 2
        WHEN 'conteste'        THEN 3
        WHEN 'ecart_acceptable'THEN 4
        WHEN 'conforme'        THEN 5
        ELSE 6
      END,
      ff.created_at DESC
    LIMIT 200
  `).all();

  const stats = {
    total:            rows.length,
    non_rapproche:    rows.filter(r => r.rapprochement_statut === 'non_rapproche').length,
    conforme:         rows.filter(r => r.rapprochement_statut === 'conforme').length,
    ecart_acceptable: rows.filter(r => r.rapprochement_statut === 'ecart_acceptable').length,
    ecart_bloquant:   rows.filter(r => r.rapprochement_statut === 'ecart_bloquant').length,
    conteste:         rows.filter(r => r.rapprochement_statut === 'conteste').length,
  };

  res.json({ stats, rows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/achats/:id — détail complet avec lignes (doit rester après toutes les routes spécifiques)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:id', (req, res) => {
  const user = req.user;
  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });

  // Vérifier accès
  if (!canSeeAll(user) && da.demandeur_id !== user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const lignes = db.prepare(
    'SELECT * FROM demandes_achat_lignes WHERE demande_id = ? ORDER BY ordre, id'
  ).all(da.id);
  res.json({ ...da, lignes });
});

module.exports = router;

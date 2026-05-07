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

// ─── Rôles ────────────────────────────────────────────────────────────────────
const ROLES_APPROUVER = ['admin', 'dg', 'delegue'];
const ROLES_VOIR_TOUT = ['admin', 'dg', 'assistante_direction', 'finance'];

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
  if (hasRole(user, ...ROLES_APPROUVER)) return true;
  // Vérifier délégation active pour delegue
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

function canSeeAll(user) {
  return hasRole(user, ...ROLES_VOIR_TOUT);
}

// ─── Envoyer email de notification à soumission ───────────────────────────────
async function notifierApprobateurs(da, lignes) {
  try {
    const destinataires = db.prepare(`
      SELECT email, nom FROM users
      WHERE role IN ('admin', 'dg', 'assistante_direction') AND actif = 1
        AND email IS NOT NULL AND email != ''
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
// GET /api/achats/:id — détail complet avec lignes
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

  db.prepare("UPDATE demandes_achat SET statut = 'soumis', updated_at = datetime('now') WHERE id = ?").run(da.id);

  const lignes = db.prepare('SELECT * FROM demandes_achat_lignes WHERE demande_id = ? ORDER BY ordre, id').all(da.id);
  const daUpdated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);

  // Email asynchrone (ne bloque pas la réponse)
  notifierApprobateurs(daUpdated, lignes);

  res.json({ ok: true, da: daUpdated });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/achats/:id/approuver — approuve + génère décaissement
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/:id/approuver', (req, res) => {
  if (!canApprove(req.user)) return res.status(403).json({ error: 'Approbation non autorisée pour ce rôle' });

  const da = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(req.params.id);
  if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
  if (da.statut !== 'soumis') return res.status(400).json({ error: 'La demande doit être en statut soumis' });

  const approbateurId = req.user.id;
  const approbateurNom = req.user.nom;

  const approuver = db.transaction(() => {
    db.prepare(`
      UPDATE demandes_achat SET
        statut = 'approuve',
        approuve_par_id = ?, approuve_par_nom = ?,
        date_approbation = date('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(approbateurId, approbateurNom, da.id);

    // Générer décaissement automatique
    const libelle = `Demande d'achat ${da.numero} — ${da.service_demandeur}`;
    const result = db.prepare(`
      INSERT INTO operations (type_op, date, libelle, montant, statut, dec_statut,
        categorie_id, position_id, ref_externe, created_by)
      VALUES ('decaissement', date('now'), ?, ?, 'en_attente', 'brouillon',
        (SELECT id FROM categories WHERE type='depense' ORDER BY id LIMIT 1),
        (SELECT id FROM positions ORDER BY id LIMIT 1),
        ?, ?)
    `).run(libelle, da.total_general, da.numero, approbateurId);

    db.prepare('UPDATE demandes_achat SET decaissement_id = ? WHERE id = ?')
      .run(result.lastInsertRowid, da.id);

    return result.lastInsertRowid;
  });

  const decId = approuver();
  const daUpdated = db.prepare('SELECT * FROM demandes_achat WHERE id = ?').get(da.id);
  res.json({ ok: true, da: daUpdated, decaissement_id: decId });
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

module.exports = router;

'use strict';

/**
 * ROUTES ACHATS — runtime MySQL asynchrone.
 * Les écritures critiques soumission/parapheur, validation réception/stock et paiement fournisseur
 * sont interceptées avant ce routeur par achats_parapheur_required_safe.js.
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { generatePdf } = require('../services/pdf');
const { calculateReconciliation } = require('../services/supplier_payment_workflow');

const router = express.Router();
const ROLES_APPROUVER = ['admin', 'dg'];
const ROLES_VOIR_TOUT = ['admin', 'dg', 'assistante_direction', 'finance'];
const ROLES_P2P_OPERER = ['admin', 'dg', 'finance', 'assistante_direction'];

function isAdmin(user) { return hasRole(user, 'admin'); }
function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function money(value) { return Math.round(num(value, 0) * 100) / 100; }
function clean(value) { return value == null ? '' : String(value).trim(); }
function fmtXAF(value) { return `${new Intl.NumberFormat('fr-CG').format(num(value, 0))} XAF`; }

async function canApprove(user) {
  if (await can(user, 'purchase.validate')) return true;
  if (hasRole(user, ...ROLES_APPROUVER)) return true;
  if (!hasRole(user, 'delegue')) return false;
  return !!await db.queryOne(`
    SELECT id FROM delegations_approbation
    WHERE delegue_id=? AND actif=1
      AND date_debut <= CURDATE()
      AND (date_fin IS NULL OR date_fin >= CURDATE())
    LIMIT 1
  `, [user.id]);
}

async function canOperateP2P(user) {
  return await can(user, 'purchase.create')
    || await can(user, 'purchase.submit')
    || hasRole(user, ...ROLES_P2P_OPERER);
}

async function canSeeAll(user) {
  return await can(user, 'purchase.validate') || hasRole(user, ...ROLES_VOIR_TOUT);
}

async function audit(dbc, userId, action, table, recordId, details = null) {
  await dbc.execute(`
    INSERT INTO audit_logs (user_id,action,table_name,record_id,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
  `, [userId || null, action, table, recordId, details == null ? null : JSON.stringify(details)]);
}

async function nextNumber(table, prefix, width = 4, dbc = db) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const last = await dbc.queryOne(`SELECT numero FROM ${table} WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`, [like]);
  const seq = last?.numero ? (parseInt(String(last.numero).split('-').pop(), 10) || 0) + 1 : 1;
  return `${prefix}-${year}-${String(seq).padStart(width, '0')}`;
}

async function getLines(table, foreignKey, id, dbc = db, order = 'ordre ASC, id ASC') {
  return dbc.query(`SELECT * FROM ${table} WHERE ${foreignKey}=? ORDER BY ${order}`, [Number(id)]);
}

function calculateOrderTotals(lines) {
  let ht = 0;
  let taxes = 0;
  const normalized = lines.map((line, index) => {
    const quantity = num(line.quantite, 1) || 1;
    const unit = money(line.prix_unitaire);
    const taxRate = num(line.taux_taxe);
    const lineHt = money(quantity * unit);
    const lineTax = money(lineHt * taxRate / 100);
    ht += lineHt;
    taxes += lineTax;
    return {
      produit_id: line.produit_id || null,
      designation: clean(line.designation),
      quantite: quantity,
      prix_unitaire: unit,
      taux_taxe: taxRate,
      montant_ht: lineHt,
      montant_ttc: money(lineHt + lineTax),
      ordre: line.ordre != null ? Number(line.ordre) : index,
    };
  });
  return { lines: normalized, montant_ht: money(ht), montant_taxes: money(taxes), montant_ttc: money(ht + taxes) };
}

async function saveOrderLines(tx, orderId, lines) {
  await tx.execute('DELETE FROM bons_commandes_lignes WHERE bc_id=?', [orderId]);
  for (const line of lines) {
    await tx.execute(`
      INSERT INTO bons_commandes_lignes
        (bc_id,produit_id,designation,quantite,quantite_recue,prix_unitaire,taux_taxe,montant_ht,montant_ttc,ordre)
      VALUES (?,?,?,?,0,?,?,?,?,?)
    `, [orderId, line.produit_id, line.designation, line.quantite, line.prix_unitaire, line.taux_taxe, line.montant_ht, line.montant_ttc, line.ordre]);
  }
}

async function approvePurchaseRequest(requestId, user) {
  return db.transaction(async tx => {
    const da = await tx.queryOne('SELECT * FROM demandes_achat WHERE id=? FOR UPDATE', [Number(requestId)]);
    if (!da) {
      const error = new Error('Demande non trouvée'); error.status = 404; throw error;
    }
    if (!['brouillon', 'soumis'].includes(da.statut)) {
      const error = new Error('La demande doit être en brouillon ou soumis'); error.status = 400; throw error;
    }
    if (da.decaissement_id) {
      const error = new Error('Cette demande possède déjà un décaissement'); error.status = 409; throw error;
    }
    if (da.statut === 'brouillon') {
      await tx.execute("UPDATE demandes_achat SET statut='soumis', updated_at=CURRENT_TIMESTAMP WHERE id=?", [da.id]);
    }
    await tx.execute(`
      UPDATE demandes_achat
      SET statut='approuve', approuve_par_id=?, approuve_par_nom=?,
          date_approbation=CURDATE(), updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `, [user.id, user.nom || user.email || 'approbateur', da.id]);
    const operation = await tx.execute(`
      INSERT INTO operations
        (type_op,date,libelle,montant,statut,dec_statut,categorie_id,position_id,ref_externe,
         created_by,submitted_by,submitted_at,validated_by,validated_at)
      VALUES ('decaissement',CURDATE(),?,?,'en_attente','valide',
        (SELECT id FROM categories WHERE type IN ('decaissement','depense') ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END,id LIMIT 1),
        (SELECT id FROM positions WHERE actif=1 ORDER BY ordre,id LIMIT 1),
        ?,?,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP)
    `, [`Demande d'achat ${da.numero} — ${da.service_demandeur}`, da.total_general, da.numero, user.id, user.id, user.id]);
    if (!operation.insertId) throw new Error('Décaissement achat non créé');
    await tx.execute('UPDATE demandes_achat SET decaissement_id=? WHERE id=?', [operation.insertId, da.id]);
    await audit(tx, user.id, 'dec_valide_achat', 'operations', operation.insertId, {
      achat_id: da.id, numero: da.numero, montant: da.total_general,
    });
    return {
      decId: operation.insertId,
      da: await tx.queryOne('SELECT * FROM demandes_achat WHERE id=?', [da.id]),
    };
  });
}

// Demandes d'achat -----------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { statut, service, date_debut, date_fin } = req.query;
    const where = [];
    const params = [];
    if (!await canSeeAll(req.user)) { where.push('da.demandeur_id=?'); params.push(req.user.id); }
    if (statut) { where.push('da.statut=?'); params.push(statut); }
    if (service) { where.push('da.service_demandeur LIKE ?'); params.push(`%${service}%`); }
    if (date_debut) { where.push('da.date_demande>=?'); params.push(date_debut); }
    if (date_fin) { where.push('da.date_demande<=?'); params.push(date_fin); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json(await db.query(`
      SELECT da.*, (SELECT COUNT(*) FROM demandes_achat_lignes l WHERE l.demande_id=da.id) AS nb_lignes
      FROM demandes_achat da ${clause} ORDER BY da.created_at DESC
    `, params));
  } catch (error) { next(error); }
});

router.get('/count-soumis', async (_req, res, next) => {
  try {
    const row = await db.queryOne("SELECT COUNT(*) AS c FROM demandes_achat WHERE statut='soumis'");
    res.json({ count: Number(row?.c || 0) });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const { service_demandeur, demandeur_nom, date_demande, commentaires, transport, lignes } = req.body || {};
    if (!clean(service_demandeur) || !clean(demandeur_nom)) return res.status(400).json({ error: 'service_demandeur et demandeur_nom requis' });
    if (!Array.isArray(lignes) || !lignes.length) return res.status(400).json({ error: 'Au moins une ligne requise' });
    const totalArticles = money(lignes.reduce((sum, line) => sum + num(line.montant), 0));
    const transportValue = money(transport);
    const result = await db.transaction(async tx => {
      const numero = await nextNumber('demandes_achat', 'DA', 6, tx);
      const created = await tx.execute(`
        INSERT INTO demandes_achat
          (numero,date_demande,service_demandeur,demandeur_id,demandeur_nom,statut,commentaires,transport,total_articles,total_general)
        VALUES (?,?,?,?,?,'brouillon',?,?,?,?)
      `, [numero, date_demande || new Date().toISOString().slice(0,10), clean(service_demandeur), req.user.id, clean(demandeur_nom), commentsOrNull(commentaires), transportValue, totalArticles, money(totalArticles + transportValue)]);
      for (let index = 0; index < lignes.length; index += 1) {
        const line = lignes[index];
        if (!clean(line.designation)) throw Object.assign(new Error('Chaque ligne doit avoir une désignation'), { status: 400 });
        await tx.execute(`
          INSERT INTO demandes_achat_lignes (demande_id,designation,quantite,montant,fournisseur_recommande,ordre)
          VALUES (?,?,?,?,?,?)
        `, [created.insertId, clean(line.designation), line.quantite || '1', money(line.montant), commentsOrNull(line.fournisseur_recommande), index]);
      }
      return tx.queryOne('SELECT * FROM demandes_achat WHERE id=?', [created.insertId]);
    });
    res.status(201).json(result);
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

function commentsOrNull(value) { const out = clean(value); return out || null; }

router.put('/:id', async (req, res, next) => {
  try {
    const da = await db.queryOne('SELECT * FROM demandes_achat WHERE id=?', [Number(req.params.id)]);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (da.statut !== 'brouillon') return res.status(400).json({ error: 'Seules les demandes en brouillon sont modifiables' });
    if (Number(da.demandeur_id) !== Number(req.user.id) && !isAdmin(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const { service_demandeur, demandeur_nom, date_demande, commentaires, transport, lignes } = req.body || {};
    const totalArticles = Array.isArray(lignes) ? money(lignes.reduce((sum, line) => sum + num(line.montant), 0)) : money(da.total_articles);
    const transportValue = transport === undefined ? money(da.transport) : money(transport);
    const updated = await db.transaction(async tx => {
      await tx.execute(`
        UPDATE demandes_achat SET service_demandeur=?,demandeur_nom=?,date_demande=?,commentaires=?,
          transport=?,total_articles=?,total_general=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `, [clean(service_demandeur) || da.service_demandeur, clean(demandeur_nom) || da.demandeur_nom,
        date_demande || da.date_demande, commentaires === undefined ? da.commentaires : commentsOrNull(commentaires),
        transportValue, totalArticles, money(totalArticles + transportValue), da.id]);
      if (Array.isArray(lignes)) {
        await tx.execute('DELETE FROM demandes_achat_lignes WHERE demande_id=?', [da.id]);
        for (let index = 0; index < lignes.length; index += 1) {
          const line = lignes[index];
          if (!clean(line.designation)) throw Object.assign(new Error('Chaque ligne doit avoir une désignation'), { status: 400 });
          await tx.execute('INSERT INTO demandes_achat_lignes (demande_id,designation,quantite,montant,fournisseur_recommande,ordre) VALUES (?,?,?,?,?,?)',
            [da.id, clean(line.designation), line.quantite || '1', money(line.montant), commentsOrNull(line.fournisseur_recommande), index]);
        }
      }
      return tx.queryOne('SELECT * FROM demandes_achat WHERE id=?', [da.id]);
    });
    res.json(updated);
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

router.put('/:id/approuver', async (req, res, next) => {
  try {
    if (!await canApprove(req.user)) return res.status(403).json({ error: 'Approbation non autorisée pour ce rôle' });
    const result = await approvePurchaseRequest(req.params.id, req.user);
    res.json({ ok: true, da: result.da, decaissement_id: result.decId, dec_statut: 'valide' });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

router.put('/:id/rejeter', async (req, res, next) => {
  try {
    if (!await canApprove(req.user)) return res.status(403).json({ error: 'Rejet non autorisé pour ce rôle' });
    const da = await db.queryOne('SELECT * FROM demandes_achat WHERE id=?', [Number(req.params.id)]);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (da.statut !== 'soumis') return res.status(400).json({ error: 'La demande doit être en statut soumis' });
    const motif = clean(req.body?.motif) || null;
    const updated = await db.transaction(async tx => {
      const result = await tx.execute(`
        UPDATE demandes_achat SET statut='rejete',motif_rejet=?,approuve_par_id=?,approuve_par_nom=?,
          date_approbation=CURDATE(),updated_at=CURRENT_TIMESTAMP WHERE id=? AND statut='soumis'
      `, [motif, req.user.id, req.user.nom || req.user.email || '', da.id]);
      if (Number(result.affectedRows || 0) !== 1) throw Object.assign(new Error('Demande déjà traitée'), { status: 409 });
      await audit(tx, req.user.id, 'REJETER', 'demandes_achat', da.id, { motif });
      return tx.queryOne('SELECT * FROM demandes_achat WHERE id=?', [da.id]);
    });
    res.json({ ok: true, da: updated });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const da = await db.queryOne('SELECT * FROM demandes_achat WHERE id=?', [Number(req.params.id)]);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (da.statut !== 'brouillon') return res.status(400).json({ error: 'Seules les demandes en brouillon peuvent être supprimées' });
    if (Number(da.demandeur_id) !== Number(req.user.id) && !isAdmin(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    await db.transaction(async tx => {
      await tx.execute('DELETE FROM demandes_achat_lignes WHERE demande_id=?', [da.id]);
      await tx.execute('DELETE FROM demandes_achat WHERE id=?', [da.id]);
      await audit(tx, req.user.id, 'DELETE', 'demandes_achat', da.id, { numero: da.numero });
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Délégations ----------------------------------------------------------------
router.get('/delegations', async (req, res, next) => {
  try {
    if (!await canSeeAll(req.user) && !hasRole(req.user, 'dg')) return res.status(403).json({ error: 'Accès refusé' });
    res.json(await db.query(`
      SELECT d.*,u1.nom AS delegant_nom,u2.nom AS delegue_nom_user
      FROM delegations_approbation d
      LEFT JOIN users u1 ON u1.id=d.delegant_id
      LEFT JOIN users u2 ON u2.id=d.delegue_id
      ORDER BY d.created_at DESC
    `));
  } catch (error) { next(error); }
});

router.post('/delegations', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'DG ou Admin requis' });
    const { delegue_id, date_debut, date_fin, motif } = req.body || {};
    if (!delegue_id || !date_debut) return res.status(400).json({ error: 'delegue_id et date_debut requis' });
    const result = await db.execute('INSERT INTO delegations_approbation (delegant_id,delegue_id,date_debut,date_fin,motif) VALUES (?,?,?,?,?)',
      [req.user.id, Number(delegue_id), date_debut, date_fin || null, commentsOrNull(motif)]);
    res.status(201).json({ id: result.insertId, ok: true });
  } catch (error) { next(error); }
});

router.put('/delegations/:id/desactiver', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'DG ou Admin requis' });
    await db.execute('UPDATE delegations_approbation SET actif=0 WHERE id=?', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Bons de commande -----------------------------------------------------------
router.get('/bons-commandes', async (req, res, next) => {
  try {
    const { statut, fournisseur_id, search, limit = 50, offset = 0 } = req.query;
    const where = ['1=1']; const params = [];
    if (statut) { where.push('bc.statut=?'); params.push(statut); }
    if (fournisseur_id) { where.push('bc.fournisseur_id=?'); params.push(Number(fournisseur_id)); }
    if (search) { const term = `%${search}%`; where.push('(bc.numero LIKE ? OR f.nom LIKE ?)'); params.push(term, term); }
    const rows = await db.query(`
      SELECT bc.*,f.nom AS fournisseur_nom,u.nom AS responsable_nom
      FROM bons_commandes_fournisseurs bc LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id
      LEFT JOIN users u ON u.id=bc.responsable_achat_id
      WHERE ${where.join(' AND ')} ORDER BY bc.created_at DESC LIMIT ? OFFSET ?
    `, [...params, Number(limit), Number(offset)]);
    const total = await db.queryOne(`SELECT COUNT(*) AS n FROM bons_commandes_fournisseurs bc LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id WHERE ${where.join(' AND ')}`, params);
    res.json({ bons_commandes: rows, total: Number(total?.n || 0) });
  } catch (error) { next(error); }
});

router.post('/bons-commandes', async (req, res, next) => {
  try {
    const { fournisseur_id, demande_achat_id, delai_livraison, lieu_livraison, conditions_paiement, notes, lignes = [] } = req.body || {};
    if (!fournisseur_id) return res.status(400).json({ error: 'fournisseur_id requis' });
    if (!Array.isArray(lignes) || !lignes.length) return res.status(400).json({ error: 'Au moins une ligne requise' });
    if (lignes.some(line => !clean(line.designation))) return res.status(400).json({ error: 'Chaque ligne doit avoir une désignation' });
    if (!await db.queryOne('SELECT id FROM fournisseurs WHERE id=?', [Number(fournisseur_id)])) return res.status(404).json({ error: 'Fournisseur introuvable' });
    const totals = calculateOrderTotals(lignes);
    const result = await db.transaction(async tx => {
      const numero = await nextNumber('bons_commandes_fournisseurs', 'BC', 4, tx);
      const created = await tx.execute(`
        INSERT INTO bons_commandes_fournisseurs
          (numero,fournisseur_id,demande_achat_id,statut,montant_ht,montant_taxes,montant_ttc,delai_livraison,
           lieu_livraison,conditions_paiement,responsable_achat_id,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,'brouillon',?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `, [numero, Number(fournisseur_id), demande_achat_id ? Number(demande_achat_id) : null,
        totals.montant_ht, totals.montant_taxes, totals.montant_ttc, commentsOrNull(delai_livraison),
        commentsOrNull(lieu_livraison), commentsOrNull(conditions_paiement), req.user.id, commentsOrNull(notes), req.user.id]);
      await saveOrderLines(tx, created.insertId, totals.lines);
      await audit(tx, req.user.id, 'CREATE', 'bons_commandes_fournisseurs', created.insertId, { numero });
      return created.insertId;
    });
    const created = await db.queryOne('SELECT * FROM bons_commandes_fournisseurs WHERE id=?', [result]);
    res.status(201).json({ ...created, lignes: await getLines('bons_commandes_lignes', 'bc_id', result) });
  } catch (error) { next(error); }
});

router.get('/bons-commandes/:id', async (req, res, next) => {
  try {
    const bc = await db.queryOne(`
      SELECT bc.*,f.nom AS fournisseur_nom,u.nom AS responsable_nom
      FROM bons_commandes_fournisseurs bc LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id
      LEFT JOIN users u ON u.id=bc.responsable_achat_id WHERE bc.id=?
    `, [Number(req.params.id)]);
    if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
    const [lignes, receptions, factures] = await Promise.all([
      getLines('bons_commandes_lignes', 'bc_id', bc.id),
      db.query('SELECT * FROM receptions WHERE bc_id=? ORDER BY created_at DESC', [bc.id]),
      db.query('SELECT * FROM factures_fournisseurs WHERE bc_id=?', [bc.id]),
    ]);
    res.json({ ...bc, lignes, receptions, factures });
  } catch (error) { next(error); }
});

router.put('/bons-commandes/:id/statut', async (req, res, next) => {
  try {
    if (!await canOperateP2P(req.user)) return res.status(403).json({ error: 'Permission insuffisante' });
    const bc = await db.queryOne('SELECT * FROM bons_commandes_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
    const statut = clean(req.body?.statut), motif = clean(req.body?.motif);
    const valid = ['brouillon','soumis','valide','envoye','accepte_fournisseur','partiellement_livre','livre','annule','cloture'];
    if (!valid.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
    if (statut === 'valide' && !hasRole(req.user, 'admin','dg','finance')) return res.status(403).json({ error: 'Validation BC réservée DG, Finance ou Admin' });
    if (statut === 'annule' && !motif) return res.status(400).json({ error: 'Motif obligatoire pour annuler un BC' });
    await db.transaction(async tx => {
      await tx.execute('UPDATE bons_commandes_fournisseurs SET statut=?,motif_annulation=COALESCE(?,motif_annulation),updated_at=CURRENT_TIMESTAMP WHERE id=?', [statut, motif || null, bc.id]);
      await audit(tx, req.user.id, 'STATUT_CHANGE', 'bons_commandes_fournisseurs', bc.id, { ancien: bc.statut, nouveau: statut, motif });
    });
    res.json({ ok: true, statut });
  } catch (error) { next(error); }
});

router.post('/bons-commandes/:id/valider', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin','dg','finance')) return res.status(403).json({ error: 'Permission insuffisante' });
    const bc = await db.queryOne('SELECT * FROM bons_commandes_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
    if (!['brouillon','soumis'].includes(bc.statut)) return res.status(400).json({ error: `Validation impossible — statut : ${bc.statut}` });
    await db.transaction(async tx => {
      const changed = await tx.execute("UPDATE bons_commandes_fournisseurs SET statut='valide',updated_at=CURRENT_TIMESTAMP WHERE id=? AND statut IN ('brouillon','soumis')", [bc.id]);
      if (Number(changed.affectedRows || 0) !== 1) throw Object.assign(new Error('Bon de commande déjà traité'), { status: 409 });
      await audit(tx, req.user.id, 'VALIDER', 'bons_commandes_fournisseurs', bc.id, { ancienStatut: bc.statut });
    });
    res.json({ ok: true, statut: 'valide' });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

// Réceptions -----------------------------------------------------------------
router.post('/receptions', async (req, res, next) => {
  try {
    const { bc_id, date_reception, lignes = [], notes } = req.body || {};
    if (!bc_id || !date_reception || !Array.isArray(lignes) || !lignes.length) return res.status(400).json({ error: 'bc_id, date_reception et lignes requis' });
    const bc = await db.queryOne('SELECT * FROM bons_commandes_fournisseurs WHERE id=?', [Number(bc_id)]);
    if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
    if (['annule','cloture'].includes(bc.statut)) return res.status(400).json({ error: `Réception impossible sur BC ${bc.statut}` });
    const recId = await db.transaction(async tx => {
      const numero = await nextNumber('receptions', 'REC', 4, tx);
      const created = await tx.execute("INSERT INTO receptions (numero,bc_id,statut,date_reception,notes,created_by,created_at,updated_at) VALUES (?,?,'en_cours',?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [numero, bc.id, date_reception, commentsOrNull(notes), req.user.id]);
      let totalOrdered = 0, totalReceived = 0;
      for (const line of lignes) {
        const orderLine = await tx.queryOne('SELECT * FROM bons_commandes_lignes WHERE id=? AND bc_id=?', [Number(line.bc_ligne_id), bc.id]);
        if (!orderLine) continue;
        const received = Math.max(0, num(line.quantite_recue));
        const compliant = line.quantite_conforme == null ? received : Math.max(0, num(line.quantite_conforme));
        const diff = received - num(orderLine.quantite);
        const lineStatus = compliant < num(orderLine.quantite) ? (compliant === 0 ? 'non_conforme' : 'ecart') : 'conforme';
        await tx.execute(`INSERT INTO receptions_lignes (reception_id,bc_ligne_id,quantite_commandee,quantite_recue,quantite_conforme,ecart,motif_ecart,statut_ligne) VALUES (?,?,?,?,?,?,?,?)`,
          [created.insertId, orderLine.id, orderLine.quantite, received, compliant, diff, commentsOrNull(line.motif_ecart), lineStatus]);
        await tx.execute('UPDATE bons_commandes_lignes SET quantite_recue=COALESCE(quantite_recue,0)+? WHERE id=?', [received, orderLine.id]);
        totalOrdered += num(orderLine.quantite); totalReceived += received;
      }
      const status = totalReceived === 0 ? 'non_conforme' : totalReceived < totalOrdered ? 'reception_partielle' : 'reception_totale';
      await tx.execute('UPDATE receptions SET statut=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, created.insertId]);
      await tx.execute('UPDATE bons_commandes_fournisseurs SET statut=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status === 'reception_totale' ? 'livre' : 'partiellement_livre', bc.id]);
      await audit(tx, req.user.id, 'CREATE', 'receptions', created.insertId, { numero, bc_id: bc.id });
      return created.insertId;
    });
    const reception = await db.queryOne('SELECT * FROM receptions WHERE id=?', [recId]);
    res.status(201).json({ ...reception, lignes: await getLines('receptions_lignes', 'reception_id', recId, db, 'id ASC') });
  } catch (error) { next(error); }
});

router.get('/receptions/:id', async (req, res, next) => {
  try {
    const rec = await db.queryOne(`SELECT r.*,bc.numero AS bc_numero,f.nom AS fournisseur_nom FROM receptions r LEFT JOIN bons_commandes_fournisseurs bc ON bc.id=r.bc_id LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id WHERE r.id=?`, [Number(req.params.id)]);
    if (!rec) return res.status(404).json({ error: 'Réception introuvable' });
    const lines = await db.query('SELECT rl.*,bcl.designation,bcl.produit_id FROM receptions_lignes rl LEFT JOIN bons_commandes_lignes bcl ON bcl.id=rl.bc_ligne_id WHERE rl.reception_id=?', [rec.id]);
    res.json({ ...rec, lignes: lines });
  } catch (error) { next(error); }
});

// Factures fournisseurs ------------------------------------------------------
router.post('/factures-fournisseurs', async (req, res, next) => {
  try {
    const { numero_facture_fournisseur, fournisseur_id, bc_id, reception_id, montant_ht, montant_ttc, date_facture, date_echeance, notes } = req.body || {};
    const numero = clean(numero_facture_fournisseur);
    if (!numero || !fournisseur_id || num(montant_ttc) <= 0 || !date_facture) return res.status(400).json({ error: 'numero_facture_fournisseur, fournisseur_id, montant_ttc et date_facture requis' });
    const duplicate = await db.queryOne('SELECT id FROM factures_fournisseurs WHERE numero_facture_fournisseur=? AND fournisseur_id=?', [numero, Number(fournisseur_id)]);
    if (duplicate) return res.status(409).json({ error: `Doublon : facture ${numero} déjà enregistrée pour ce fournisseur` });
    const id = await db.transaction(async tx => {
      const created = await tx.execute(`
        INSERT INTO factures_fournisseurs
          (numero_facture_fournisseur,fournisseur_id,bc_id,reception_id,statut,montant_ht,montant_ttc,date_facture,date_echeance,montant_paye,reste_a_payer,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,'recue',?,?,?,?,0,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `, [numero, Number(fournisseur_id), bc_id ? Number(bc_id) : null, reception_id ? Number(reception_id) : null,
        money(montant_ht), money(montant_ttc), date_facture, date_echeance || null, money(montant_ttc), commentsOrNull(notes), req.user.id]);
      await audit(tx, req.user.id, 'CREATE', 'factures_fournisseurs', created.insertId, { numero_facture_fournisseur: numero });
      return created.insertId;
    });
    res.status(201).json(await db.queryOne('SELECT * FROM factures_fournisseurs WHERE id=?', [id]));
  } catch (error) { next(error); }
});

router.get('/factures-fournisseurs', async (req, res, next) => {
  try {
    const { statut, fournisseur_id, limit = 50, offset = 0 } = req.query;
    const where = ['1=1']; const params = [];
    if (statut) { where.push('ff.statut=?'); params.push(statut); }
    if (fournisseur_id) { where.push('ff.fournisseur_id=?'); params.push(Number(fournisseur_id)); }
    const factures = await db.query(`SELECT ff.*,f.nom AS fournisseur_nom FROM factures_fournisseurs ff LEFT JOIN fournisseurs f ON f.id=ff.fournisseur_id WHERE ${where.join(' AND ')} ORDER BY ff.date_facture DESC LIMIT ? OFFSET ?`, [...params, Number(limit), Number(offset)]);
    const total = await db.queryOne(`SELECT COUNT(*) AS n FROM factures_fournisseurs ff WHERE ${where.join(' AND ')}`, params);
    res.json({ factures, total: Number(total?.n || 0) });
  } catch (error) { next(error); }
});

router.get('/factures-fournisseurs/:id', async (req, res, next) => {
  try {
    const ff = await db.queryOne('SELECT ff.*,f.nom AS fournisseur_nom FROM factures_fournisseurs ff LEFT JOIN fournisseurs f ON f.id=ff.fournisseur_id WHERE ff.id=?', [Number(req.params.id)]);
    if (!ff) return res.status(404).json({ error: 'Facture fournisseur introuvable' });
    res.json(ff);
  } catch (error) { next(error); }
});

router.post('/factures-fournisseurs/:id/valider', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin','dg','finance')) return res.status(403).json({ error: 'Permission insuffisante' });
    const ff = await db.queryOne('SELECT * FROM factures_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!ff) return res.status(404).json({ error: 'Facture fournisseur introuvable' });
    if (!['recue','a_verifier'].includes(ff.statut)) return res.status(400).json({ error: `Validation impossible — statut : ${ff.statut}` });
    if (ff.bc_id) {
      const bc = await db.queryOne('SELECT statut FROM bons_commandes_fournisseurs WHERE id=?', [ff.bc_id]);
      if (bc && !['partiellement_livre','livre','cloture'].includes(bc.statut)) return res.status(400).json({ error: 'Réception non confirmée — le BC doit être au moins partiellement livré' });
    }
    await db.transaction(async tx => {
      await tx.execute("UPDATE factures_fournisseurs SET statut='validee',updated_at=CURRENT_TIMESTAMP WHERE id=?", [ff.id]);
      await audit(tx, req.user.id, 'VALIDER', 'factures_fournisseurs', ff.id, { ancienStatut: ff.statut });
    });
    res.json({ ok: true, statut: 'validee' });
  } catch (error) { next(error); }
});

// PDF bon de commande --------------------------------------------------------
async function setting(key, fallback) {
  const row = await db.queryOne('SELECT valeur FROM parametres WHERE cle=?', [key]);
  return row?.valeur || fallback;
}

function buildOrderHtml(bc, lines, devise, societe) {
  const rows = lines.map((line, index) => `<tr><td>${index + 1}</td><td>${line.designation || ''}</td><td>${line.quantite}</td><td>${num(line.prix_unitaire).toLocaleString('fr-FR')}</td><td>${num(line.montant_ht).toLocaleString('fr-FR')}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font-family:Arial;color:#172033;margin:30px}h1{margin-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}.totals{margin-top:20px;text-align:right}.meta{color:#667085}</style></head><body><h1>${societe}</h1><div class="meta">BON DE COMMANDE ${bc.numero}</div><h2>${bc.fournisseur_nom || 'Fournisseur'}</h2><table><thead><tr><th>#</th><th>Désignation</th><th>Qté</th><th>P.U.</th><th>HT</th></tr></thead><tbody>${rows}</tbody></table><div class="totals">HT : ${fmtXAF(bc.montant_ht)}<br>Taxes : ${fmtXAF(bc.montant_taxes)}<br><strong>Total : ${num(bc.montant_ttc).toLocaleString('fr-FR')} ${devise}</strong></div><p>${bc.conditions_paiement || ''}</p><p>${bc.notes || ''}</p></body></html>`;
}

router.get('/bons-commandes/:id/pdf', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin','dg','finance','assistante_direction')) return res.status(403).json({ error: 'Permission insuffisante' });
    const bc = await db.queryOne(`SELECT bc.*,f.nom AS fournisseur_nom,u.nom AS responsable_nom FROM bons_commandes_fournisseurs bc LEFT JOIN fournisseurs f ON f.id=bc.fournisseur_id LEFT JOIN users u ON u.id=bc.responsable_achat_id WHERE bc.id=?`, [Number(req.params.id)]);
    if (!bc) return res.status(404).json({ error: 'Bon de commande introuvable' });
    const lines = await getLines('bons_commandes_lignes', 'bc_id', bc.id);
    const [devise, societe] = await Promise.all([setting('devise','XAF'), setting('societe','TOP CENTER')]);
    const pdf = await generatePdf(buildOrderHtml(bc, lines, devise, societe), { prefix: 'bc', marginTop: '10mm', marginBottom: '10mm', marginLeft: '10mm', marginRight: '10mm' });
    await audit(db, req.user.id, 'PDF_DOWNLOAD', 'bons_commandes_fournisseurs', bc.id, { numero: bc.numero, par: req.user.email });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bon_commande_${String(bc.numero).replace(/[^a-zA-Z0-9_.-]/g,'_')}.pdf"`);
    res.end(pdf);
  } catch (error) { next(error); }
});

// Rapprochement 3 voies ------------------------------------------------------
router.get('/factures-fournisseurs/:id/rapprochement', async (req, res, next) => {
  try {
    if (!await canOperateP2P(req.user)) return res.status(403).json({ error: 'Permission insuffisante' });
    const ff = await db.queryOne('SELECT * FROM factures_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!ff) return res.status(404).json({ error: 'Facture introuvable' });
    const [simulation, bc, receptions] = await Promise.all([
      calculateReconciliation(ff, db),
      ff.bc_id ? db.queryOne('SELECT id,numero,montant_ttc,statut FROM bons_commandes_fournisseurs WHERE id=?', [ff.bc_id]) : null,
      ff.bc_id ? db.query('SELECT id,numero,statut,date_reception FROM receptions WHERE bc_id=? ORDER BY date_reception ASC', [ff.bc_id]) : [],
    ]);
    res.json({ facture_id: ff.id, facture_num: ff.numero_facture_fournisseur, montant_facture: ff.montant_ttc, bc, receptions, rapprochement_actuel: { statut: ff.rapprochement_statut, at: ff.rapprochement_at, ecart_montant: ff.ecart_montant, ecart_quantite: ff.ecart_quantite, ecart_motif: ff.ecart_motif }, simulation });
  } catch (error) { next(error); }
});

router.post('/factures-fournisseurs/:id/rapprocher', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin','dg','finance')) return res.status(403).json({ error: 'Rapprochement réservé Finance, DG ou Admin' });
    const ff = await db.queryOne('SELECT * FROM factures_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!ff) return res.status(404).json({ error: 'Facture introuvable' });
    if (['payee','annulee'].includes(ff.statut)) return res.status(400).json({ error: `Rapprochement impossible sur une facture ${ff.statut}` });
    const report = await calculateReconciliation(ff, db);
    const motif = commentsOrNull(req.body?.motif_ecart) || report.details.join(' | ') || null;
    const updated = await db.transaction(async tx => {
      await tx.execute(`UPDATE factures_fournisseurs SET rapprochement_statut=?,rapprochement_at=CURRENT_TIMESTAMP,rapprochement_by=?,ecart_montant=?,ecart_quantite=?,ecart_motif=?,statut=CASE WHEN statut IN ('recue','a_verifier') THEN CASE WHEN ?='ecart_bloquant' THEN 'contestee' ELSE 'a_verifier' END ELSE statut END,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [report.statut, req.user.id, report.ecart_montant, report.ecart_quantite, motif, report.statut, ff.id]);
      await audit(tx, req.user.id, 'RAPPROCHEMENT', 'factures_fournisseurs', ff.id, report);
      return tx.queryOne('SELECT * FROM factures_fournisseurs WHERE id=?', [ff.id]);
    });
    res.json({ ok: true, rapprochement: report, facture: updated });
  } catch (error) { next(error); }
});

router.post('/factures-fournisseurs/:id/contester-rapprochement', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin','dg')) return res.status(403).json({ error: 'Contestation réservée DG ou Admin' });
    const motif = clean(req.body?.motif);
    if (!motif) return res.status(400).json({ error: 'Motif de contestation obligatoire' });
    const ff = await db.queryOne('SELECT id FROM factures_fournisseurs WHERE id=?', [Number(req.params.id)]);
    if (!ff) return res.status(404).json({ error: 'Facture introuvable' });
    await db.transaction(async tx => {
      await tx.execute("UPDATE factures_fournisseurs SET rapprochement_statut='conteste',ecart_motif=?,statut='contestee',updated_at=CURRENT_TIMESTAMP WHERE id=?", [motif, ff.id]);
      await audit(tx, req.user.id, 'CONTESTATION_RAPPROCHEMENT', 'factures_fournisseurs', ff.id, { motif });
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/rapprochement/tableau-de-bord', async (req, res, next) => {
  try {
    if (!await canOperateP2P(req.user)) return res.status(403).json({ error: 'Permission insuffisante' });
    const rows = await db.query(`
      SELECT ff.id,ff.numero_facture_fournisseur,ff.montant_ttc,ff.statut,ff.rapprochement_statut,
        ff.ecart_montant,ff.ecart_quantite,ff.ecart_motif,ff.rapprochement_at,ff.date_facture,
        f.nom AS fournisseur_nom,bc.numero AS bc_numero,u.nom AS rapprocha_par
      FROM factures_fournisseurs ff LEFT JOIN fournisseurs f ON f.id=ff.fournisseur_id
      LEFT JOIN bons_commandes_fournisseurs bc ON bc.id=ff.bc_id LEFT JOIN users u ON u.id=ff.rapprochement_by
      WHERE ff.statut NOT IN ('annulee')
      ORDER BY CASE ff.rapprochement_statut WHEN 'ecart_bloquant' THEN 1 WHEN 'non_rapproche' THEN 2 WHEN 'conteste' THEN 3 WHEN 'ecart_acceptable' THEN 4 WHEN 'conforme' THEN 5 ELSE 6 END,ff.created_at DESC LIMIT 200
    `);
    const stats = { total: rows.length };
    for (const status of ['non_rapproche','conforme','ecart_acceptable','ecart_bloquant','conteste']) stats[status] = rows.filter(row => row.rapprochement_statut === status).length;
    res.json({ stats, rows });
  } catch (error) { next(error); }
});

// Détail demande : toujours en dernier ---------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const da = await db.queryOne('SELECT * FROM demandes_achat WHERE id=?', [Number(req.params.id)]);
    if (!da) return res.status(404).json({ error: 'Demande non trouvée' });
    if (!await canSeeAll(req.user) && Number(da.demandeur_id) !== Number(req.user.id)) return res.status(403).json({ error: 'Accès refusé' });
    res.json({ ...da, lignes: await db.query('SELECT * FROM demandes_achat_lignes WHERE demande_id=? ORDER BY ordre,id', [da.id]) });
  } catch (error) { next(error); }
});

module.exports = router;

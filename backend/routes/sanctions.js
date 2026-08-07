/**
 * MODULE SANCTIONS DISCIPLINAIRES — TOP CENTER
 * Registre officiel des sanctions avec workflow et impact sur bulletin.
 * Workflow : projet → notifie → conteste → clos
 */
const express = require('express');
const db = require('../db');
const router = express.Router();
const { hasRole } = require('./auth');
const { creerNotification } = require('../services/notif');

const READ_ROLES = ['admin', 'rh', 'dg', 'finance'];
const WRITE_ROLES = ['admin', 'rh'];
const CLOSE_ROLES = ['admin', 'dg'];

function canRead(user) { return hasRole(user, ...READ_ROLES); }
function canWrite(user) { return hasRole(user, ...WRITE_ROLES); }
function canClose(user) { return hasRole(user, ...CLOSE_ROLES); }

async function audit(id, action, details, userId) {
  try {
    await db.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      ['employes_sanctions', id, action, details ? JSON.stringify(details) : null, userId || null],
    );
  } catch (_) {}
}

async function enrichSanction(sanction) {
  if (!sanction) return null;
  const [employee, creator, canceller] = await Promise.all([
    db.queryOne('SELECT nom, prenom FROM employes WHERE id = ?', [sanction.employe_id]),
    sanction.created_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [sanction.created_by]) : null,
    sanction.annule_by ? db.queryOne('SELECT nom FROM users WHERE id = ?', [sanction.annule_by]) : null,
  ]);
  return {
    ...sanction,
    employe_nom: employee ? `${employee.nom} ${employee.prenom}` : null,
    created_by_nom: creator ? creator.nom : null,
    annule_by_nom: canceller ? canceller.nom : null,
  };
}

router.get('/:id/sanctions', async (req, res, next) => {
  try {
    if (!canRead(req.user)) return res.status(403).json({ error: 'Accès refusé' });
    const rows = await db.query(
      'SELECT * FROM employes_sanctions WHERE employe_id = ? ORDER BY date_sanction DESC',
      [req.params.id],
    );
    res.json(await Promise.all(rows.map(enrichSanction)));
  } catch (error) { next(error); }
});

router.post('/:id/sanctions', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const agent = await db.queryOne('SELECT id, nom, prenom, salaire_base FROM employes WHERE id = ?', [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable' });

    const { type, date_sanction, motif_detaille, nb_jours_mise_a_pied = 0, document_url } = req.body;
    const typesValides = ['avertissement_verbal', 'avertissement_ecrit', 'mise_a_pied', 'licenciement_cause_reelle', 'autre'];
    if (!type || !typesValides.includes(type)) return res.status(400).json({ error: `type invalide. Valeurs : ${typesValides.join(', ')}` });
    if (!date_sanction) return res.status(400).json({ error: 'date_sanction requis' });
    if (!motif_detaille || !String(motif_detaille).trim()) return res.status(400).json({ error: 'motif_detaille obligatoire' });
    if (type === 'mise_a_pied' && Number(nb_jours_mise_a_pied) <= 0) return res.status(400).json({ error: 'nb_jours_mise_a_pied requis pour une mise à pied' });

    let retenue_calculee = 0;
    if (type === 'mise_a_pied' && Number(nb_jours_mise_a_pied) > 0 && agent.salaire_base > 0) {
      retenue_calculee = Math.round((Number(nb_jours_mise_a_pied) / 26) * agent.salaire_base);
    }

    const result = await db.execute(`
      INSERT INTO employes_sanctions
        (employe_id, type, date_sanction, motif_detaille, nb_jours_mise_a_pied,
         retenue_calculee, document_url, statut, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'projet', ?, NOW(), NOW())
    `, [agent.id, type, date_sanction, String(motif_detaille).trim(), Number(nb_jours_mise_a_pied), retenue_calculee, document_url || null, req.user.id]);

    await audit(result.insertId, 'creer', { type, retenue_calculee }, req.user.id);
    res.status(201).json(await enrichSanction(await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ?', [result.insertId])));
  } catch (error) { next(error); }
});

router.put('/:id/sanctions/:sid', async (req, res, next) => {
  try {
    if (!canWrite(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ? AND employe_id = ?', [req.params.sid, req.params.id]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (sanction.statut !== 'projet') return res.status(400).json({ error: `Statut "${sanction.statut}" — modification impossible. Seul un projet est modifiable.` });

    const agent = await db.queryOne('SELECT salaire_base FROM employes WHERE id = ?', [req.params.id]);
    const {
      type = sanction.type,
      date_sanction = sanction.date_sanction,
      motif_detaille = sanction.motif_detaille,
      nb_jours_mise_a_pied = sanction.nb_jours_mise_a_pied,
      document_url = sanction.document_url,
    } = req.body;

    let retenue_calculee = sanction.retenue_calculee;
    if (type === 'mise_a_pied' && Number(nb_jours_mise_a_pied) > 0 && agent?.salaire_base > 0) {
      retenue_calculee = Math.round((Number(nb_jours_mise_a_pied) / 26) * agent.salaire_base);
    } else if (type !== 'mise_a_pied') {
      retenue_calculee = 0;
    }

    await db.execute(`
      UPDATE employes_sanctions
      SET type=?, date_sanction=?, motif_detaille=?, nb_jours_mise_a_pied=?, retenue_calculee=?, document_url=?, updated_at=NOW()
      WHERE id=?
    `, [type, date_sanction, String(motif_detaille).trim(), Number(nb_jours_mise_a_pied), retenue_calculee, document_url || null, sanction.id]);
    await audit(sanction.id, 'modifier', { type, retenue_calculee }, req.user.id);
    res.json(await enrichSanction(await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ?', [sanction.id])));
  } catch (error) { next(error); }
});

router.put('/:id/sanctions/:sid/notifier', async (req, res, next) => {
  try {
    if (!canWrite(req.user) && !hasRole(req.user, 'dg')) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ? AND employe_id = ?', [req.params.sid, req.params.id]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (sanction.statut !== 'projet') return res.status(400).json({ error: `Statut "${sanction.statut}" — notification impossible` });

    await db.execute("UPDATE employes_sanctions SET statut='notifie', updated_at=NOW() WHERE id=?", [sanction.id]);
    await audit(sanction.id, 'notifier', null, req.user.id);

    setImmediate(async () => {
      try {
        const employee = await db.queryOne('SELECT nom, prenom FROM employes WHERE id=?', [req.params.id]);
        const typesLabel = {
          avertissement_verbal: 'Avertissement verbal',
          avertissement_ecrit: 'Avertissement écrit',
          mise_a_pied: 'Mise à pied',
          licenciement_cause_reelle: 'Licenciement pour cause réelle',
          autre: 'Sanction',
        };
        const users = await db.query("SELECT id FROM users WHERE actif=1 AND (role IN ('admin','dg') OR roles LIKE '%\"dg\"%')");
        for (const user of users) {
          await Promise.resolve(creerNotification({
            type: 'NOTIF_SANCTION',
            titre: `${typesLabel[sanction.type] || 'Sanction'} notifiée`,
            message: `${typesLabel[sanction.type] || 'Sanction'} pour ${employee?.nom || ''} ${employee?.prenom || ''} le ${sanction.date_sanction}. Motif : ${sanction.motif_detaille.slice(0, 80)}`,
            srcTable: 'employes_sanctions',
            srcId: sanction.id,
            destinataire_id: user.id,
          }));
        }
      } catch (_) {}
    });

    res.json({ ok: true, statut: 'notifie' });
  } catch (error) { next(error); }
});

router.put('/:id/sanctions/:sid/contester', async (req, res, next) => {
  try {
    if (!canWrite(req.user) && !hasRole(req.user, 'admin')) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ? AND employe_id = ?', [req.params.sid, req.params.id]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (sanction.statut !== 'notifie') return res.status(400).json({ error: `Statut "${sanction.statut}" — contestation impossible (sanction doit être notifiée)` });
    const { conteste_motif } = req.body;
    if (!conteste_motif || !String(conteste_motif).trim()) return res.status(400).json({ error: 'conteste_motif obligatoire' });
    await db.execute("UPDATE employes_sanctions SET statut='conteste', conteste_motif=?, updated_at=NOW() WHERE id=?", [String(conteste_motif).trim(), sanction.id]);
    await audit(sanction.id, 'contester', { conteste_motif }, req.user.id);
    res.json({ ok: true, statut: 'conteste' });
  } catch (error) { next(error); }
});

router.put('/:id/sanctions/:sid/clore', async (req, res, next) => {
  try {
    if (!canClose(req.user)) return res.status(403).json({ error: 'Rôle DG ou Admin requis pour clore une sanction' });
    const sanction = await db.queryOne('SELECT * FROM employes_sanctions WHERE id = ? AND employe_id = ?', [req.params.sid, req.params.id]);
    if (!sanction) return res.status(404).json({ error: 'Sanction introuvable' });
    if (!['notifie', 'conteste'].includes(sanction.statut)) return res.status(400).json({ error: `Statut "${sanction.statut}" — clôture impossible` });
    await db.execute("UPDATE employes_sanctions SET statut='clos', updated_at=NOW() WHERE id=?", [sanction.id]);
    await audit(sanction.id, 'clore', null, req.user.id);
    res.json({ ok: true, statut: 'clos' });
  } catch (error) { next(error); }
});

router.get('/registre', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'dg')) return res.status(403).json({ error: 'Rôle DG ou Admin requis' });
    const { statut, type, employe_id, limit = 100, offset = 0 } = req.query;
    let sql = `
      SELECT s.*, CONCAT(e.nom, ' ', e.prenom) AS employe_nom,
             e.poste, e.departement, u.nom AS created_by_nom
      FROM employes_sanctions s
      JOIN employes e ON e.id = s.employe_id
      LEFT JOIN users u ON u.id = s.created_by
      WHERE 1=1
    `;
    const args = [];
    if (statut) { sql += ' AND s.statut = ?'; args.push(statut); }
    if (type) { sql += ' AND s.type = ?'; args.push(type); }
    if (employe_id) { sql += ' AND s.employe_id = ?'; args.push(employe_id); }
    sql += ' ORDER BY s.date_sanction DESC LIMIT ? OFFSET ?';
    args.push(Number(limit), Number(offset));
    const rows = await db.query(sql, args);
    res.json({ count: rows.length, items: rows });
  } catch (error) { next(error); }
});

module.exports = router;

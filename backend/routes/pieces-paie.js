'use strict';
/*
 * Pièces de paie à écrire dans la comptabilité générale — écran C4 (ADR 0002).
 *
 *   GET  /api/comptabilite/pieces-paie             périodes validées, pièce écrite ou non
 *   GET  /api/comptabilite/pieces-paie/:id         la pièce calculée
 *   POST /api/comptabilite/pieces-paie/:id/ecrire  « Valider et écrire »
 *
 * « Écrite » se lit dans le grand livre lui-même (journal OD, référence
 * SMI-PAIE-AAAA-MM) : pas de registre parallèle qui pourrait diverger. Une
 * pièce réécrite n'est pas dupliquée : le module rend « deja_ecrite ».
 */
const express = require('express');
const db = require('../db');
const { hasRole } = require('../services/roles');
const dolibarr = require('../services/dolibarr');
const piecePaie = require('../services/piece-paie');

const router = express.Router();
const ROLES = ['admin', 'finance', 'dg'];

router.use((req, res, next) => {
  if (!hasRole(req.user, ...ROLES)) return res.status(403).json({ error: 'Admin, Finance ou DG requis' });
  return next();
});

function repondreErreur(res, e) {
  if (e instanceof dolibarr.DolibarrError) {
    console.warn('[pieces-paie]', e.code, e.message, JSON.stringify(e.details || ''));
    return res.status(e.statusHttp || 502).json({ error: 'Service momentanément indisponible', code: e.code });
  }
  console.error('[pieces-paie]', e);
  return res.status(500).json({ error: 'Service momentanément indisponible' });
}

async function periodesEcrivables() {
  const marques = piecePaie.STATUTS_ECRIVABLES.map(() => '?').join(',');
  return db.query(`SELECT id, annee, mois, statut FROM periodes_paie WHERE statut IN (${marques}) ORDER BY annee DESC, mois DESC`, piecePaie.STATUTS_ECRIVABLES);
}

const bulletinsDe = periode => db.query(
  'SELECT brut, cnss_employe, camu_employe, irpp, net_a_payer, retenue_avance, cnss_patronal, camu_patronal FROM bulletins_salaire WHERE periode_id = ? AND annule_at IS NULL',
  [periode.id],
);

/* Références de pièces de paie déjà au grand livre, sur les années demandées. */
async function referencesEcrites(annees) {
  if (!annees.length) return new Set();
  const du = `${Math.min(...annees)}-01-01`;
  const au = `${Math.max(...annees)}-12-31`;
  const gl = await dolibarr.grandLivre({ du, au, journal: 'OD' });
  return new Set((gl.lignes || []).map(l => l.reference).filter(r => /^SMI-PAIE-\d{4}-\d{2}$/.test(String(r))));
}

router.get('/', async (_req, res) => {
  try {
    const periodes = await periodesEcrivables();
    const ecrites = await referencesEcrites([...new Set(periodes.map(p => Number(p.annee)))]);
    const liste = [];
    for (const p of periodes) {
      const piece = piecePaie.construire(p, await bulletinsDe(p));
      liste.push({
        periode_id: piece.periode_id, annee: piece.annee, mois: piece.mois, libelle_mois: piece.libelle_mois,
        statut_periode: p.statut, reference: piece.reference, lignes: piece.lignes.length,
        total: piece.total_debit, equilibre: piece.equilibre, ecrite: ecrites.has(piece.reference),
      });
    }
    res.json({ pieces: liste, a_traiter: liste.filter(p => !p.ecrite).length });
  } catch (e) { repondreErreur(res, e); }
});

async function chargerPiece(req, res) {
  const id = Number(req.params.id);
  const p = Number.isInteger(id) && id > 0 ? await db.queryOne('SELECT id, annee, mois, statut FROM periodes_paie WHERE id = ?', [id]) : null;
  if (!p) { res.status(404).json({ error: 'Période introuvable' }); return null; }
  if (!piecePaie.STATUTS_ECRIVABLES.includes(p.statut)) { res.status(409).json({ error: 'Statut invalide' }); return null; }
  return { periode: p, piece: piecePaie.construire(p, await bulletinsDe(p)) };
}

router.get('/:id', async (req, res) => {
  try {
    const c = await chargerPiece(req, res);
    if (!c) return;
    const ecrites = await referencesEcrites([c.piece.annee]);
    res.json({ ...c.piece, statut_periode: c.periode.statut, ecrite: ecrites.has(c.piece.reference) });
  } catch (e) { repondreErreur(res, e); }
});

router.post('/:id/ecrire', async (req, res) => {
  try {
    const c = await chargerPiece(req, res);
    if (!c) return;
    const { piece } = c;
    if (!piece.equilibre) return res.status(422).json({ error: 'Équilibre débit/crédit', total_debit: piece.total_debit, total_credit: piece.total_credit });
    const r = await dolibarr.ecrirePiece({
      journal: piece.journal, date: piece.date, reference: piece.reference, source_id: piece.periode_id,
      lignes: piece.lignes.map(l => ({ compte: l.compte, libelle: l.libelle, debit: l.debit, credit: l.credit })),
    });
    try {
      await db.execute(
        'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?, ?, ?, ?, ?)',
        ['periodes_paie', piece.periode_id, 'piece_paie_ecrite', JSON.stringify({ reference: piece.reference, statut: r && r.statut, piece_num: r && r.piece_num, total: piece.total_debit }), req.user.id],
      );
    } catch (erreurAudit) {
      // La pièce est écrite : un journal d'audit indisponible ne doit pas le
      // masquer à l'écran, mais il se dit au journal du serveur.
      console.error('[pieces-paie] audit non ecrit pour', piece.reference, erreurAudit.message);
    }
    res.json({ ok: true, statut: r && r.statut, piece_num: r && r.piece_num, reference: piece.reference });
  } catch (e) { repondreErreur(res, e); }
});

module.exports = router;

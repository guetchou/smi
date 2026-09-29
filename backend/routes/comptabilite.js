'use strict';
/*
 * Comptabilité générale tenue dans Dolibarr, montrée par Tala SMI — ADR 0002.
 *
 *   GET /api/comptabilite/etat         connexion configurée ? dernier passage au grand livre
 *   GET /api/comptabilite/grand-livre  écritures (du, au, journal, compte)
 *   GET /api/comptabilite/balance      comptes regroupés : débit, crédit, solde
 *   GET /api/comptabilite/controles    équilibre, exercices ouverts, compte d'attente
 *
 * Tant que la connexion n'est pas configurée, /etat répond configure: false et
 * l'écran garde les pages comptables actuelles. Les messages d'erreur sont
 * ceux qui existent déjà dans l'application ; aucun ne nomme Dolibarr.
 */
const express = require('express');
const { hasRole } = require('../services/roles');
const dolibarr = require('../services/dolibarr');

const router = express.Router();
const ROLES_COMPTABILITE = ['admin', 'finance', 'dg'];
const COMPTE_ATTENTE = '471';

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const arrondi = n => Math.round(n * 100) / 100;

function exigerRole(req, res, next) {
  if (!hasRole(req.user, ...ROLES_COMPTABILITE)) return res.status(403).json({ error: 'Admin, Finance ou DG requis' });
  return next();
}

function periode(req) {
  const { du, au } = req.query;
  if (!JOUR.test(String(du || '')) || !JOUR.test(String(au || '')) || du > au) return null;
  return { du, au };
}

function repondreErreur(res, e) {
  if (e instanceof dolibarr.DolibarrError) {
    // Le détail va au journal du serveur, pas à l'écran.
    console.warn('[comptabilite]', e.code, e.message);
    return res.status(e.code === 'NON_CONFIGURE' ? 503 : e.statusHttp || 502).json({ error: 'Service momentanément indisponible', code: e.code });
  }
  console.error('[comptabilite]', e);
  return res.status(500).json({ error: 'Service momentanément indisponible' });
}

/* Regroupe les lignes du grand livre par compte, dans l'ordre du plan. */
function balance(lignes) {
  const comptes = new Map();
  for (const l of lignes) {
    const c = comptes.get(l.compte) || { compte: l.compte, libelle: l.libelle_compte || '', classe: String(l.compte).charAt(0), debit: 0, credit: 0 };
    c.debit += Number(l.debit || 0);
    c.credit += Number(l.credit || 0);
    comptes.set(l.compte, c);
  }
  return [...comptes.values()]
    .sort((a, b) => String(a.compte).localeCompare(String(b.compte)))
    .map(c => {
      const solde = arrondi(c.debit - c.credit);
      return { ...c, debit: arrondi(c.debit), credit: arrondi(c.credit), solde: Math.abs(solde), sens: solde > 0 ? 'D' : solde < 0 ? 'C' : '' };
    });
}

router.use(exigerRole);

router.get('/etat', async (_req, res) => {
  if (!dolibarr.configure()) return res.json({ configure: false });
  try {
    res.json({ configure: true, passage: await dolibarr.etatGrandLivre() });
  } catch (e) { repondreErreur(res, e); }
});

router.get('/grand-livre', async (req, res) => {
  const p = periode(req);
  if (!p) return res.status(400).json({ error: 'Période invalide' });
  const journal = /^[A-Z]{2,6}$/.test(String(req.query.journal || '')) ? req.query.journal : '';
  const compte = String(req.query.compte || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 20);
  try {
    res.json(await dolibarr.grandLivre({ ...p, journal, compte }));
  } catch (e) { repondreErreur(res, e); }
});

router.get('/balance', async (req, res) => {
  const p = periode(req);
  if (!p) return res.status(400).json({ error: 'Période invalide' });
  try {
    const gl = await dolibarr.grandLivre(p);
    const comptes = balance(gl.lignes || []);
    res.json({ ...p, comptes, total_debit: gl.total_debit, total_credit: gl.total_credit });
  } catch (e) { repondreErreur(res, e); }
});

router.get('/controles', async (req, res) => {
  const p = periode(req);
  if (!p) return res.status(400).json({ error: 'Période invalide' });
  try {
    const [gl, exercices] = await Promise.all([dolibarr.grandLivre(p), dolibarr.exercices()]);
    const lignes = gl.lignes || [];
    const attente = balance(lignes.filter(l => String(l.compte).startsWith(COMPTE_ATTENTE)));
    const soldeAttente = arrondi(attente.reduce((s, c) => s + (c.sens === 'C' ? -c.solde : c.solde), 0));
    res.json({
      ...p,
      equilibre: { debit: gl.total_debit, credit: gl.total_credit, ok: Math.abs(Number(gl.total_debit) - Number(gl.total_credit)) < 0.005 },
      exercices,
      attente: {
        compte: COMPTE_ATTENTE,
        montant: Math.abs(soldeAttente),
        lignes: lignes.filter(l => String(l.compte).startsWith(COMPTE_ATTENTE)).length,
      },
      dernieres: lignes.slice(-12).reverse(),
    });
  } catch (e) { repondreErreur(res, e); }
});

module.exports = router;
module.exports._balance = balance;
module.exports.ROLES_COMPTABILITE = ROLES_COMPTABILITE;

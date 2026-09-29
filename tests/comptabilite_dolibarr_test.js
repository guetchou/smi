'use strict';
/*
 * Garde — la comptabilité lue dans Dolibarr par Tala SMI (ADR 0002).
 *
 * Un faux Dolibarr (serveur HTTP local) sert les points d'API du module
 * « smi » et vérifie la clé. Les vraies routes /api/comptabilite tournent
 * derrière Express avec un utilisateur connecté. On regarde ce que l'écran
 * recevrait : la bascule tant que rien n'est configuré, les rôles, la balance,
 * les contrôles, et qu'aucune panne ne fait apparaître le mot « Dolibarr ».
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const express = require(path.join(__dirname, '..', 'backend', 'node_modules', 'express'));

const CLE = 'cle-de-test';
let mode = 'normal';
const recues = [];

const LIGNES = [
  { date: '2026-01-13', journal: 'VT', piece: 1, compte: '411', libelle_compte: 'Clients', libelle: 'Client comptant', debit: 1200000, credit: 0 },
  { date: '2026-01-13', journal: 'VT', piece: 1, compte: '706', libelle_compte: 'Services vendus', libelle: 'Services vendus', debit: 0, credit: 1200000 },
  { date: '2026-01-13', journal: 'BQ', piece: 2, compte: '5711', libelle_compte: 'Caisse', libelle: 'Paiement client', debit: 1200000, credit: 0 },
  { date: '2026-01-13', journal: 'BQ', piece: 2, compte: '411', libelle_compte: 'Clients', libelle: 'Paiement client', debit: 0, credit: 1200000 },
  { date: '2026-01-13', journal: 'BQ', piece: 3, compte: '5711', libelle_compte: 'Caisse', libelle: 'Ligne sans piece', debit: 1200000, credit: 0 },
  { date: '2026-01-13', journal: 'BQ', piece: 3, compte: '471', libelle_compte: 'Comptes d attente', libelle: 'Ligne sans piece', debit: 0, credit: 1200000 },
];

const fauxDolibarr = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  recues.push({ chemin: url.pathname, query: Object.fromEntries(url.searchParams), cle: req.headers.dolapikey });
  if (mode === 'lent') return; // ne répond jamais
  const envoyer = (code, corps) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corps)); };
  if (req.headers.dolapikey !== CLE) return envoyer(401, { error: { code: 401, message: 'Unauthorized: Failed to login to API' } });
  if (mode === 'panne') return envoyer(500, { error: { code: 500, message: 'Dolibarr internal error' } });
  if (url.pathname.endsWith('/smi/etat')) return envoyer(200, { horodatage: '2026-09-29T14:05:01+00:00', statut: 'ok', ecritures_ajoutees: 4, en_retard: false });
  if (url.pathname.endsWith('/smi/exercices')) return envoyer(200, [{ libelle: '2026', debut: '2026-01-01', fin: '2026-12-31' }]);
  if (url.pathname.endsWith('/smi/grandlivre')) {
    const d = LIGNES.reduce((s, l) => s + l.debit, 0);
    const c = LIGNES.reduce((s, l) => s + l.credit, 0);
    return envoyer(200, { lignes: LIGNES, total_debit: d, total_credit: c });
  }
  return envoyer(404, { error: { code: 404, message: 'Not found' } });
});

let utilisateur = { id: 1, role: 'finance', roles: ['finance'] };
let vertes = 0;
let echecs = 0;
async function verifier(nom, fn) {
  try { await fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
}

(async () => {
  await new Promise(r => fauxDolibarr.listen(0, '127.0.0.1', r));
  process.env.DOLIBARR_DELAI_MS = '400';
  const router = require('../backend/routes/comptabilite');
  const app = express();
  app.use((req, _res, next) => { req.user = utilisateur; next(); });
  app.use('/api/comptabilite', router);
  const serveur = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}/api/comptabilite`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, corps: await r.json() }; };
  const Q = '?du=2026-01-01&au=2026-03-31';

  await verifier('sans configuration, /etat dit configure: false et rien ne part', async () => {
    delete process.env.DOLIBARR_URL; delete process.env.DOLIBARR_API_KEY;
    const avant = recues.length;
    const r = await get('/etat');
    assert.deepStrictEqual(r.corps, { configure: false });
    assert.strictEqual(recues.length, avant, 'aucun appel ne doit partir');
  });

  process.env.DOLIBARR_URL = `http://127.0.0.1:${fauxDolibarr.address().port}/`;
  process.env.DOLIBARR_API_KEY = CLE;

  await verifier('configuré, /etat rend le dernier passage et envoie la clé', async () => {
    const r = await get('/etat');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corps.configure, true);
    assert.strictEqual(r.corps.passage.ecritures_ajoutees, 4);
    assert.strictEqual(recues.at(-1).cle, CLE);
    assert.strictEqual(recues.at(-1).chemin, '/api/index.php/smi/etat', 'la barre finale de l adresse ne doit pas doubler');
  });

  await verifier('un caissier est refusé', async () => {
    utilisateur = { id: 2, role: 'caissier', roles: ['caissier'] };
    const r = await get('/etat');
    utilisateur = { id: 1, role: 'finance', roles: ['finance'] };
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.corps.error, 'Admin, Finance ou DG requis');
  });

  await verifier('une période invalide est refusée avant tout appel', async () => {
    const avant = recues.length;
    for (const q of ['', '?du=2026-01-01', '?du=2026-03-31&au=2026-01-01', '?du=hier&au=demain']) {
      const r = await get('/grand-livre' + q);
      assert.strictEqual(r.status, 400, q);
      assert.strictEqual(r.corps.error, 'Période invalide');
    }
    assert.strictEqual(recues.length, avant);
  });

  await verifier('le grand livre transmet la période, le journal et un compte nettoyé', async () => {
    const r = await get('/grand-livre' + Q + '&journal=BQ&compte=' + encodeURIComponent("57'; DROP"));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(recues.at(-1).query, { date_debut: '2026-01-01', date_fin: '2026-03-31', journal: 'BQ', compte: '57DROP' });
    const r2 = await get('/grand-livre' + Q + '&journal=bq;1');
    assert.ok(!('journal' in recues.at(-1).query), 'un journal mal formé n est pas transmis');
    assert.strictEqual(r2.status, 200);
  });

  await verifier('la balance regroupe par compte, dans l ordre, avec solde et sens', async () => {
    const r = await get('/balance' + Q);
    assert.strictEqual(r.status, 200);
    const par = Object.fromEntries(r.corps.comptes.map(c => [c.compte, c]));
    assert.deepStrictEqual(r.corps.comptes.map(c => c.compte), ['411', '471', '5711', '706']);
    assert.deepStrictEqual([par['411'].debit, par['411'].credit, par['411'].solde, par['411'].sens], [1200000, 1200000, 0, '']);
    assert.deepStrictEqual([par['5711'].solde, par['5711'].sens, par['5711'].classe], [2400000, 'D', '5']);
    assert.deepStrictEqual([par['706'].solde, par['706'].sens], [1200000, 'C']);
  });

  await verifier('les contrôles : équilibre, exercices ouverts, compte d attente', async () => {
    const r = await get('/controles' + Q);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corps.equilibre.ok, true);
    assert.strictEqual(r.corps.equilibre.debit, 3600000);
    assert.deepStrictEqual(r.corps.exercices, [{ libelle: '2026', debut: '2026-01-01', fin: '2026-12-31' }]);
    assert.deepStrictEqual(r.corps.attente, { compte: '471', montant: 1200000, lignes: 1 });
  });

  await verifier('les dernières écritures ne coupent jamais une pièce', async () => {
    // 8 pièces de 2 lignes : 12 lignes auraient coupé une pièce en deux.
    const lignes = [];
    for (let p = 1; p <= 8; p++) {
      lignes.push({ journal: 'BQ', piece: p, compte: '5711', debit: p, credit: 0 }, { journal: 'BQ', piece: p, compte: '411', debit: 0, credit: p });
    }
    const d = router._dernieresPieces(lignes, 6);
    assert.strictEqual(d.length, 12);
    assert.deepStrictEqual([...new Set(d.map(l => l.piece))], [8, 7, 6, 5, 4, 3], 'les 6 dernières pièces, de la plus récente à la plus ancienne');
    for (const p of [3, 4, 5, 6, 7, 8]) assert.strictEqual(d.filter(l => l.piece === p).length, 2, 'pièce ' + p + ' entière');
  });

  for (const [nom, prepare, attendu] of [
    ['une panne', () => { mode = 'panne'; }, 502],
    ['un service qui ne répond pas', () => { mode = 'lent'; }, 504],
    ['une clé refusée', () => { mode = 'normal'; process.env.DOLIBARR_API_KEY = 'mauvaise'; }, 502],
  ]) {
    await verifier(`${nom} donne un message existant, sans nommer le logiciel`, async () => {
      prepare();
      const r = await get('/controles' + Q);
      mode = 'normal'; process.env.DOLIBARR_API_KEY = CLE;
      assert.strictEqual(r.status, attendu);
      assert.strictEqual(r.corps.error, 'Service momentanément indisponible');
      assert.ok(!/dolibarr/i.test(JSON.stringify(r.corps)), 'le mot Dolibarr apparaît : ' + JSON.stringify(r.corps));
    });
  }

  await verifier('docker-compose transmet DOLIBARR_URL et DOLIBARR_API_KEY, vides par défaut', async () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
    for (const v of ['DOLIBARR_URL', 'DOLIBARR_API_KEY']) {
      assert.ok(new RegExp(`- ${v}=\\$\\{${v}:-\\}`).test(compose), v + ' absent ou sans valeur par défaut');
    }
  });

  serveur.close();
  fauxDolibarr.closeAllConnections?.();
  fauxDolibarr.close();
  console.log(`${vertes}/${vertes + echecs} gardes vertes — comptabilite lue dans Dolibarr`);
  process.exit(echecs ? 1 : 0);
})();

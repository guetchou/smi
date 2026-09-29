'use strict';
/*
 * Garde — pièce de paie écrite dans la comptabilité générale (écran C4,
 * ADR 0002).
 *
 * Base SQLite réelle (périodes et bulletins), faux Dolibarr HTTP (grand livre
 * et écriture de pièces), vraies routes derrière Express. On vérifie la pièce
 * elle-même (équilibre, avance, CAMU, lignes nulles), ce que la liste dit
 * « écrit », les refus, et ce qui part réellement à l'écriture.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const dbPath = `/tmp/projet-smi-pieces-paie-${process.pid}.db`;
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = dbPath;
process.env.DOLIBARR_DELAI_MS = '400';

const express = require(path.join(__dirname, '..', 'backend', 'node_modules', 'express'));
const db = require('../backend/db');
const piecePaie = require('../backend/services/piece-paie');

const CLE = 'cle-paie';
const ecritures = [];
const dejaAuGrandLivre = new Set();
const fauxDolibarr = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const envoyer = (code, corps) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corps)); };
  if (req.headers.dolapikey !== CLE) return envoyer(401, { error: { message: 'Unauthorized' } });
  if (url.pathname.endsWith('/smi/grandlivre')) {
    const lignes = [...dejaAuGrandLivre].map(r => ({ journal: 'OD', reference: r, compte: '422', debit: 0, credit: 1 }));
    return envoyer(200, { lignes, total_debit: 0, total_credit: 0 });
  }
  if (url.pathname.endsWith('/smi/pieces') && req.method === 'POST') {
    let corps = '';
    req.on('data', d => { corps += d; });
    req.on('end', () => {
      const piece = JSON.parse(corps);
      ecritures.push(piece);
      const deja = dejaAuGrandLivre.has(piece.reference);
      dejaAuGrandLivre.add(piece.reference);
      envoyer(200, { statut: deja ? 'deja_ecrite' : 'ecrite', piece_num: 42, lignes: piece.lignes.length });
    });
    return undefined;
  }
  return envoyer(404, { error: { message: 'Not found' } });
});

let vertes = 0;
let echecs = 0;
async function verifier(nom, fn) {
  try { await fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
}

const B = o => ({ brut: 0, cnss_employe: 0, camu_employe: 0, irpp: 0, net_a_payer: 0, retenue_avance: 0, cnss_patronal: 0, camu_patronal: 0, ...o });

(async () => {
  await new Promise(r => fauxDolibarr.listen(0, '127.0.0.1', r));
  process.env.DOLIBARR_URL = `http://127.0.0.1:${fauxDolibarr.address().port}`;
  process.env.DOLIBARR_API_KEY = CLE;

  const admin = await db.queryOne("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  // Un bulletin par salarié et par mois : deux salariés pour mars.
  const [emp, emp2] = await db.query('SELECT id FROM employes ORDER BY id LIMIT 2');
  assert.ok(admin && emp && emp2, 'semis incomplet : il faut deux salaries');
  const periode = async (annee, mois, statut) => (await db.execute('INSERT INTO periodes_paie (annee, mois, statut) VALUES (?, ?, ?)', [annee, mois, statut])).insertId;
  const bulletin = async (periodeId, annee, mois, b, employeId = emp.id) => db.execute(`
    INSERT INTO bulletins_salaire (employe_id, mois, annee, periode_id, brut, cnss_employe, camu_employe, irpp, net_a_payer, retenue_avance, cnss_patronal, camu_patronal, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valide')`,
  [employeId, mois, annee, periodeId, b.brut, b.cnss_employe, b.camu_employe, b.irpp, b.net_a_payer, b.retenue_avance, b.cnss_patronal, b.camu_patronal]);

  const mars = await periode(2031, 3, 'validee_dg');
  await bulletin(mars, 2031, 3, B({ brut: 180000, cnss_employe: 7200, camu_employe: 1800, irpp: 18000, net_a_payer: 153000, retenue_avance: 20000, cnss_patronal: 25000, camu_patronal: 3000 }));
  await bulletin(mars, 2031, 3, B({ brut: 100000, cnss_employe: 4000, irpp: 6000, net_a_payer: 90000, cnss_patronal: 14000 }), emp2.id);
  const avril = await periode(2031, 4, 'controle_rh');
  const mai = await periode(2031, 5, 'cloturee');
  await bulletin(mai, 2031, 5, B({ brut: 100000, cnss_employe: 4000, irpp: 6000, net_a_payer: 85000, cnss_patronal: 14000 }));

  await verifier('la pièce est équilibrée, avance et CAMU sur leurs comptes, sans ligne nulle', async () => {
    const p = piecePaie.construire({ id: mars, annee: 2031, mois: 3 }, [
      B({ brut: 180000, cnss_employe: 7200, camu_employe: 1800, irpp: 18000, net_a_payer: 153000, retenue_avance: 20000, cnss_patronal: 25000, camu_patronal: 3000 }),
      B({ brut: 100000, cnss_employe: 4000, irpp: 6000, net_a_payer: 90000, cnss_patronal: 14000 }),
    ]);
    assert.strictEqual(p.equilibre, true, `${p.total_debit} / ${p.total_credit}`);
    assert.strictEqual(p.total_debit, 280000 + 39000 + 3000);
    assert.strictEqual(p.reference, 'SMI-PAIE-2031-03');
    assert.strictEqual(p.date, '2031-03-31');
    const par = (compte, mot) => p.lignes.find(l => l.compte === compte && l.libelle.includes(mot));
    assert.strictEqual(par('422', 'Net').credit, 243000 - 20000, 'le net à payer est diminué de l avance');
    assert.strictEqual(par('421', 'Avances').credit, 20000);
    assert.strictEqual(par('433', 'CAMU part salariale').credit, 1800);
    assert.strictEqual(par('431', 'CNSS part patronale').credit, 39000);
    assert.ok(p.lignes.every(l => l.debit > 0 || l.credit > 0), 'aucune ligne à zéro');
    assert.ok(p.lignes[0].libelle.endsWith('mars'), 'mois en toutes lettres');
  });

  const router = require('../backend/routes/pieces-paie');
  let utilisateur = { id: admin.id, role: 'finance', roles: ['finance'] };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = utilisateur; next(); });
  app.use('/api/comptabilite/pieces-paie', router);
  const serveur = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${serveur.address().port}/api/comptabilite/pieces-paie`;
  const appel = async (chemin, method = 'GET') => { const r = await fetch(base + chemin, { method }); return { status: r.status, corps: await r.json() }; };

  await verifier('la liste ne montre que les périodes validées, et compte celles à écrire', async () => {
    const r = await appel('/');
    assert.strictEqual(r.status, 200);
    const refs = r.corps.pieces.map(p => p.reference);
    assert.ok(refs.includes('SMI-PAIE-2031-03') && refs.includes('SMI-PAIE-2031-05'));
    assert.ok(!refs.includes('SMI-PAIE-2031-04'), 'une période en contrôle RH n est pas proposée');
    assert.strictEqual(r.corps.a_traiter, r.corps.pieces.filter(p => !p.ecrite).length);
  });

  await verifier('une période non validée est refusée, une période absente aussi', async () => {
    const r1 = await appel(`/${avril}/ecrire`, 'POST');
    assert.strictEqual(r1.status, 409);
    assert.strictEqual(r1.corps.error, 'Statut invalide');
    const r2 = await appel('/999999');
    assert.strictEqual(r2.status, 404);
    assert.strictEqual(r2.corps.error, 'Période introuvable');
  });

  await verifier('une pièce déséquilibrée n est jamais envoyée', async () => {
    const avant = ecritures.length;
    const r = await appel(`/${mai}/ecrire`, 'POST');
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.corps.error, 'Équilibre débit/crédit');
    assert.strictEqual(ecritures.length, avant);
  });

  await verifier('« Valider et écrire » envoie la pièce OD et laisse une trace d audit', async () => {
    const r = await appel(`/${mars}/ecrire`, 'POST');
    assert.strictEqual(r.status, 200, JSON.stringify(r.corps));
    assert.strictEqual(r.corps.statut, 'ecrite');
    const envoi = ecritures.at(-1);
    assert.strictEqual(envoi.journal, 'OD');
    assert.strictEqual(envoi.date, '2031-03-31');
    assert.strictEqual(envoi.reference, 'SMI-PAIE-2031-03');
    assert.strictEqual(envoi.source_id, mars);
    const d = envoi.lignes.reduce((s, l) => s + l.debit, 0);
    const c = envoi.lignes.reduce((s, l) => s + l.credit, 0);
    assert.strictEqual(d, c);
    const trace = await db.queryOne("SELECT details FROM audit_logs WHERE table_name = 'periodes_paie' AND record_id = ? AND action = 'piece_paie_ecrite'", [mars]);
    assert.ok(trace && trace.details.includes('SMI-PAIE-2031-03'));
  });

  await verifier('une fois écrite, la période est marquée écrite, et une seconde écriture ne duplique rien', async () => {
    const liste = await appel('/');
    assert.strictEqual(liste.corps.pieces.find(p => p.reference === 'SMI-PAIE-2031-03').ecrite, true);
    const r = await appel(`/${mars}/ecrire`, 'POST');
    assert.strictEqual(r.corps.statut, 'deja_ecrite');
  });

  await verifier('un caissier est refusé', async () => {
    utilisateur = { id: admin.id, role: 'caissier', roles: ['caissier'] };
    const r = await appel('/');
    utilisateur = { id: admin.id, role: 'finance', roles: ['finance'] };
    assert.strictEqual(r.status, 403);
  });

  serveur.close();
  fauxDolibarr.close();
  try { fs.unlinkSync(dbPath); } catch (_) {}
  console.log(`${vertes}/${vertes + echecs} gardes vertes — pieces de paie`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.log('  ECHEC execution\n        ' + (e.stack || e.message)); process.exit(1); });

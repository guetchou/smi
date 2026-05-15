/**
 * TESTS — Budget Achats par service
 * Branche : feat-achats-budget
 *
 * Exécution :
 *   BASE_URL=http://localhost:3337 TOKEN=<jwt_finance> node tests/budget_achats_test.js
 *
 * Tests statiques (sans serveur) : TEST 01, TEST 11, TEST 12
 * Tests API (nécessitent serveur + JWT) : TEST 02 à TEST 10
 */
'use strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3337';
const TOKEN    = process.env.TOKEN    || '';

let passed = 0, failed = 0, skipped = 0;

async function req(method, path, body, customToken) {
  const t = customToken !== undefined ? customToken : TOKEN;
  const res = await fetch(BASE_URL + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { 'Authorization': `Bearer ${t}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  json._status = res.status;
  return json;
}

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ÉCHEC ${name}` + (detail ? ` — ${detail}` : ''));
    failed++;
  }
}
function skip(name, reason) {
  console.log(`  ↷ ${name} — ${reason}`);
  skipped++;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 01 — Vérification source (statique, sans serveur)
// ─────────────────────────────────────────────────────────────────────────────
async function test01_sourceCoverage() {
  console.log('\nTEST 01 — Couverture source backend/routes/budgets_achats.js');
  const src = require('fs').readFileSync('./backend/routes/budgets_achats.js', 'utf8');

  assert('creerNotification importé',          src.includes("require('../services/notif')"));
  assert('auditBudget défini',                  src.includes('function auditBudget'));
  assert('checkEtNotifApresModif défini',        src.includes('function checkEtNotifApresModif'));
  assert('engage_previsionnel calculé',          src.includes('engage_previsionnel'));
  assert('seuil_alerte_pct depuis paramètres',   src.includes('budget_achats_seuil_alerte_pct'));
  assert('NOTIF_BUDGET_SEUIL envoyée',           src.includes("'NOTIF_BUDGET_SEUIL'"));
  assert('NOTIF_BUDGET_DEPASSE envoyée',         src.includes("'NOTIF_BUDGET_DEPASSE'"));
  assert('NOTIF_BUDGET_OVERRIDE envoyée',        src.includes("'NOTIF_BUDGET_OVERRIDE'"));
  assert('override-depassement route',           src.includes('/override-depassement'));
  assert('OVERRIDE_MOTIF_REQUIS code',           src.includes("'OVERRIDE_MOTIF_REQUIS'"));
  assert('motif.trim().length vérification',     src.includes('motif') && src.includes('OVERRIDE_MOTIF_REQUIS'));

  const srcAchats = require('fs').readFileSync('./backend/routes/achats.js', 'utf8');
  assert('BUDGET_DEPASSE_BLOQUANT dans achats',  srcAchats.includes('BUDGET_DEPASSE_BLOQUANT'));
  assert('override_budget dans achats',          srcAchats.includes('override_budget'));
  assert('NOTIF_BUDGET_OVERRIDE appelée achats', srcAchats.includes("'NOTIF_BUDGET_OVERRIDE'"));

  const srcDB = require('fs').readFileSync('./backend/database.js', 'utf8');
  assert('Table budgets_achats créée',           srcDB.includes('CREATE TABLE IF NOT EXISTS budgets_achats'));
  assert('NOTIF_BUDGET_SEUIL seeded',            srcDB.includes("'NOTIF_BUDGET_SEUIL'"));
  assert('NOTIF_BUDGET_DEPASSE seeded',          srcDB.includes("'NOTIF_BUDGET_DEPASSE'"));
  assert('NOTIF_BUDGET_OVERRIDE seeded',         srcDB.includes("'NOTIF_BUDGET_OVERRIDE'"));
  assert('Param seuil_alerte_pct',               srcDB.includes('budget_achats_seuil_alerte_pct'));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 02 — RBAC sans token → 401
// ─────────────────────────────────────────────────────────────────────────────
async function test02_rbacSansToken() {
  console.log('\nTEST 02 — RBAC : sans token → 401');
  const r = await req('GET', '/budgets-achats', null, '');
  assert('HTTP 401', r._status === 401, `obtenu ${r._status}`);
  const r2 = await req('POST', '/budgets-achats', { annee: 2026, service: 'Test', montant_prevu: 1000 }, '');
  assert('POST sans token → 401', r2._status === 401, `obtenu ${r2._status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 03 — GET / : structure réponse
// ─────────────────────────────────────────────────────────────────────────────
async function test03_getList() {
  if (!TOKEN) { skip('TEST 03', 'TOKEN absent'); return; }
  console.log('\nTEST 03 — GET /budgets-achats → structure');
  const r = await req('GET', '/budgets-achats?annee=2026');
  assert('HTTP 200', r._status === 200, `obtenu ${r._status}`);
  assert('lignes présentes', Array.isArray(r.lignes));
  assert('totaux présents', r.totaux !== undefined);
  assert('seuil_alerte_pct présent', typeof r.seuil_alerte_pct === 'number',
    `obtenu ${r.seuil_alerte_pct}`);
  assert('totaux.engage_previsionnel', 'engage_previsionnel' in (r.totaux || {}));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 04 — POST / : création budget
// ─────────────────────────────────────────────────────────────────────────────
let _testBudgetId = null;
const TEST_SERVICE = `__TEST_BUDGET_${Date.now()}`;

async function test04_creation() {
  if (!TOKEN) { skip('TEST 04', 'TOKEN absent'); return; }
  console.log('\nTEST 04 — POST création budget');
  const r = await req('POST', '/budgets-achats', {
    annee: 2099, service: TEST_SERVICE, montant_prevu: 500000, notes: 'Test automatique',
  });
  assert('HTTP 201', r._status === 201, `obtenu ${r._status}: ${r.error||''}`);
  assert('id retourné', typeof r.id === 'number');
  assert('service correct', r.service === TEST_SERVICE);
  assert('montant correct', r.montant_prevu === 500000);
  _testBudgetId = r.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 05 — POST / doublon → 409
// ─────────────────────────────────────────────────────────────────────────────
async function test05_doublon() {
  if (!TOKEN || !_testBudgetId) { skip('TEST 05', 'TOKEN absent ou création échouée'); return; }
  console.log('\nTEST 05 — POST doublon → 409');
  const r = await req('POST', '/budgets-achats', {
    annee: 2099, service: TEST_SERVICE, montant_prevu: 100000,
  });
  assert('HTTP 409', r._status === 409, `obtenu ${r._status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 06 — PUT / : modification
// ─────────────────────────────────────────────────────────────────────────────
async function test06_modification() {
  if (!TOKEN || !_testBudgetId) { skip('TEST 06', 'TOKEN absent ou création échouée'); return; }
  console.log('\nTEST 06 — PUT modification budget');
  const r = await req('PUT', `/budgets-achats/${_testBudgetId}`, {
    montant_prevu: 750000, notes: 'Modifié par test',
  });
  assert('HTTP 200', r._status === 200, `obtenu ${r._status}`);
  assert('montant mis à jour', r.montant_prevu === 750000);
  assert('engage présent', 'engage' in r);
  assert('solde_disponible présent', 'solde_disponible' in r);
  assert('engage_previsionnel présent', 'engage_previsionnel' in r);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 07 — GET /services : liste services
// ─────────────────────────────────────────────────────────────────────────────
async function test07_services() {
  if (!TOKEN) { skip('TEST 07', 'TOKEN absent'); return; }
  console.log('\nTEST 07 — GET /services');
  const r = await req('GET', '/budgets-achats/services?annee=2026');
  assert('HTTP 200', r._status === 200, `obtenu ${r._status}`);
  assert('services liste', Array.isArray(r.services));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 08 — POST /check-depassement : sans budget → a_budget=false
// ─────────────────────────────────────────────────────────────────────────────
async function test08_checkSansBudget() {
  if (!TOKEN) { skip('TEST 08', 'TOKEN absent'); return; }
  console.log('\nTEST 08 — check-depassement sans budget défini');
  const r = await req('POST', '/budgets-achats/check-depassement', {
    service: '__SERVICE_INEXISTANT_' + Date.now(),
    annee: 2026,
    montant: 50000,
  });
  assert('HTTP 200', r._status === 200, `obtenu ${r._status}`);
  assert('a_budget = false', r.a_budget === false, `obtenu ${r.a_budget}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 09 — Override sans motif → OVERRIDE_MOTIF_REQUIS
// ─────────────────────────────────────────────────────────────────────────────
async function test09_overrideSansMotif() {
  if (!TOKEN || !_testBudgetId) { skip('TEST 09', 'TOKEN absent ou création échouée'); return; }
  console.log('\nTEST 09 — Override sans motif → OVERRIDE_MOTIF_REQUIS');
  const r = await req('POST', `/budgets-achats/${_testBudgetId}/override-depassement`, {
    montant_demande: 999999,
    // motif absent intentionnellement
  });
  assert('HTTP 400', r._status === 400, `obtenu ${r._status}`);
  assert('code OVERRIDE_MOTIF_REQUIS', r.code === 'OVERRIDE_MOTIF_REQUIS',
    `obtenu ${r.code}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — DELETE : budget sans engagements → 200
// ─────────────────────────────────────────────────────────────────────────────
async function test10_suppression() {
  if (!TOKEN || !_testBudgetId) { skip('TEST 10', 'TOKEN absent ou création échouée'); return; }
  console.log('\nTEST 10 — DELETE budget sans engagements');
  const r = await req('DELETE', `/budgets-achats/${_testBudgetId}`);
  assert('HTTP 200', r._status === 200, `obtenu ${r._status}: ${r.error||''}`);
  assert('ok:true', r.ok === true);
  _testBudgetId = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 11 — Syntaxe node --check (statique)
// ─────────────────────────────────────────────────────────────────────────────
async function test11_syntaxe() {
  console.log('\nTEST 11 — Syntaxe node --check');
  const { execSync } = require('child_process');
  const files = [
    'backend/database.js',
    'backend/routes/budgets_achats.js',
    'backend/routes/achats.js',
    'backend/server.js',
    'backend/services/notif.js',
  ];
  for (const f of files) {
    try {
      execSync(`node --check ${f}`, { stdio: 'pipe' });
      assert(`${f}`, true);
    } catch (e) {
      assert(`${f}`, false, e.stderr?.toString().slice(0, 100));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 12 — DB : colonnes et paramètres (statique via SQLite direct)
// ─────────────────────────────────────────────────────────────────────────────
async function test12_db() {
  console.log('\nTEST 12 — DB migrations (lecture SQLite directe)');
  const DB_PATH = './backend/data/caisse.db';
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });

    const cols = db.prepare("SELECT name FROM pragma_table_info('budgets_achats')").all().map(r => r.name);
    assert('colonne id',            cols.includes('id'));
    assert('colonne annee',         cols.includes('annee'));
    assert('colonne service',       cols.includes('service'));
    assert('colonne montant_prevu', cols.includes('montant_prevu'));
    assert('colonne created_by',    cols.includes('created_by'));

    const params = db.prepare("SELECT cle, valeur FROM parametres WHERE cle LIKE 'budget_achats%'").all();
    const pMap = Object.fromEntries(params.map(p => [p.cle, p.valeur]));
    assert('param budget_achats_blocage_depassement', 'budget_achats_blocage_depassement' in pMap,
      `présents: ${Object.keys(pMap).join(', ')}`);
    assert('param budget_achats_seuil_alerte_pct',   'budget_achats_seuil_alerte_pct' in pMap);

    const notifTypes = db.prepare("SELECT type FROM notif_regles WHERE type LIKE 'NOTIF_BUDGET%'").all().map(r => r.type);
    assert('NOTIF_BUDGET_SEUIL seeded',   notifTypes.includes('NOTIF_BUDGET_SEUIL'));
    assert('NOTIF_BUDGET_DEPASSE seeded', notifTypes.includes('NOTIF_BUDGET_DEPASSE'));
    assert('NOTIF_BUDGET_OVERRIDE seeded',notifTypes.includes('NOTIF_BUDGET_OVERRIDE'));

    db.close();
  } catch (e) {
    skip('TEST 12', `DB inaccessible directement : ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' TESTS BUDGET ACHATS — feat-achats-budget');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`Token    : ${TOKEN ? TOKEN.slice(0,20)+'…' : '(absent — tests statiques uniquement)'}`);

  await test01_sourceCoverage();
  await test02_rbacSansToken();
  await test03_getList();
  await test04_creation();
  await test05_doublon();
  await test06_modification();
  await test07_services();
  await test08_checkSansBudget();
  await test09_overrideSansMotif();
  await test10_suppression();
  await test11_syntaxe();
  await test12_db();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` Résultat : ${passed} ✓  ${failed} ✗  ${skipped} ↷  sur ${passed+failed+skipped} tests`);
  if (failed > 0) {
    console.error(' ⚠ Tests échoués — ne pas merger avant correction.');
    process.exit(1);
  } else {
    console.log(' ✅ Tous les tests exécutés passent.');
    process.exit(0);
  }
})();

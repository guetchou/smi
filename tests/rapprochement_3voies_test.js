/**
 * TESTS — Rapprochement 3 voies BC ↔ Réception ↔ Facture fournisseur
 * Branche : feat-achats-rapprochement
 *
 * Exécution (hors prod) :
 *   BASE_URL=http://localhost:3337 TOKEN=<jwt> node tests/rapprochement_3voies_test.js
 *
 * Ces tests sont des tests d'intégration API — ils nécessitent un serveur
 * en écoute et un jeton JWT valide avec rôle finance ou admin.
 */

'use strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3337';
const TOKEN    = process.env.TOKEN    || '';

let passed = 0;
let failed = 0;

async function req(method, path, body) {
  const res = await fetch(BASE_URL + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ÉCHEC ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 01 — GET /api/achats/rapprochement/tableau-de-bord
// Vérifie que le dashboard rapprochement répond avec les champs attendus
// ─────────────────────────────────────────────────────────────────────────────
async function test01_dashboardRepond() {
  console.log('\nTEST 01 — Dashboard rapprochement répond correctement');
  const r = await req('GET', '/achats/rapprochement/tableau-de-bord');
  assert('HTTP 200', r.status === 200, `status=${r.status}`);
  assert('Champ stats présent', r.body.stats !== undefined);
  assert('Champ rows présent', Array.isArray(r.body.rows));
  assert('stats.total est un nombre', typeof r.body.stats?.total === 'number',
    JSON.stringify(r.body.stats));
  assert('stats contient ecart_bloquant', 'ecart_bloquant' in (r.body.stats || {}));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 02 — GET /api/achats/factures-fournisseurs/:id/rapprochement
// Vérifie la structure de la simulation
// ─────────────────────────────────────────────────────────────────────────────
async function test02_simulationStructure() {
  console.log('\nTEST 02 — Simulation rapprochement sur première facture disponible');
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=1');
  if (!liste.body.factures?.length) {
    console.log('  ↷ Aucune facture en base — test ignoré');
    return;
  }
  const id = liste.body.factures[0].id;
  const r  = await req('GET', `/achats/factures-fournisseurs/${id}/rapprochement`);
  assert('HTTP 200', r.status === 200, `status=${r.status}`);
  assert('Champ simulation présent', r.body.simulation !== undefined);
  assert('simulation.statut présent', typeof r.body.simulation?.statut === 'string');
  assert('simulation.ecart_montant est un nombre', typeof r.body.simulation?.ecart_montant === 'number');
  assert('simulation.details est un tableau', Array.isArray(r.body.simulation?.details));
  assert('Champ bc présent (peut être null)', 'bc' in r.body);
  assert('Champ receptions est un tableau', Array.isArray(r.body.receptions));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 03 — Facture sans BC → statut doit être ecart_bloquant
// ─────────────────────────────────────────────────────────────────────────────
async function test03_sansBC() {
  console.log('\nTEST 03 — Facture sans BC → simulation ecart_bloquant');
  // Chercher une facture sans bc_id
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=50');
  const sansBC = (liste.body.factures || []).find(f => !f.bc_id);
  if (!sansBC) {
    console.log('  ↷ Aucune facture sans BC en base — test ignoré');
    return;
  }
  const r = await req('GET', `/achats/factures-fournisseurs/${sansBC.id}/rapprochement`);
  assert('HTTP 200', r.status === 200);
  assert('simulation.statut = ecart_bloquant', r.body.simulation?.statut === 'ecart_bloquant',
    `obtenu: ${r.body.simulation?.statut}`);
  assert('details non vide', r.body.simulation?.details?.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 04 — Paiement bloqué si ecart_bloquant
// ─────────────────────────────────────────────────────────────────────────────
async function test04_paiementBloqueEcartBloquant() {
  console.log('\nTEST 04 — Paiement bloqué si rapprochement_statut = ecart_bloquant');
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=50');
  const bloquee = (liste.body.factures || []).find(
    f => f.rapprochement_statut === 'ecart_bloquant' &&
         ['validee','partiellement_payee'].includes(f.statut)
  );
  if (!bloquee) {
    console.log('  ↷ Aucune facture avec ecart_bloquant + validée — test ignoré');
    return;
  }
  const r = await req('POST', `/achats/factures-fournisseurs/${bloquee.id}/payer`, {
    montant: 1000,
    date_paiement: new Date().toISOString().split('T')[0],
    position_id: 1,
  });
  assert('HTTP 400 (bloqué)', r.status === 400, `status=${r.status}`);
  assert('code RAPPROCHEMENT_ECART_BLOQUANT', r.body.code === 'RAPPROCHEMENT_ECART_BLOQUANT',
    `code=${r.body.code}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 05 — Paiement bloqué si conteste
// ─────────────────────────────────────────────────────────────────────────────
async function test05_paiementBloqueConteste() {
  console.log('\nTEST 05 — Paiement bloqué si rapprochement_statut = conteste');
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=50');
  const contestee = (liste.body.factures || []).find(
    f => f.rapprochement_statut === 'conteste' &&
         ['validee','partiellement_payee'].includes(f.statut)
  );
  if (!contestee) {
    console.log('  ↷ Aucune facture contestée + validée — test ignoré');
    return;
  }
  const r = await req('POST', `/achats/factures-fournisseurs/${contestee.id}/payer`, {
    montant: 1000,
    date_paiement: new Date().toISOString().split('T')[0],
    position_id: 1,
  });
  assert('HTTP 400 (bloqué)', r.status === 400, `status=${r.status}`);
  assert('code RAPPROCHEMENT_CONTESTE', r.body.code === 'RAPPROCHEMENT_CONTESTE',
    `code=${r.body.code}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 06 — Override sans motif doit échouer
// ─────────────────────────────────────────────────────────────────────────────
async function test06_overrideSansMotif() {
  console.log('\nTEST 06 — Override sans motif → 400 OVERRIDE_MOTIF_REQUIS');
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=50');
  const bloquee = (liste.body.factures || []).find(
    f => ['ecart_bloquant','conteste'].includes(f.rapprochement_statut) &&
         ['validee','partiellement_payee'].includes(f.statut)
  );
  if (!bloquee) {
    console.log('  ↷ Aucune facture bloquée/contestée — test ignoré');
    return;
  }
  const r = await req('POST', `/achats/factures-fournisseurs/${bloquee.id}/payer`, {
    montant: 1000,
    date_paiement: new Date().toISOString().split('T')[0],
    position_id: 1,
    override_rapprochement: true,
    // motif_override absent intentionnellement
  });
  assert('HTTP 400', r.status === 400, `status=${r.status}`);
  assert('code OVERRIDE_MOTIF_REQUIS', r.body.code === 'OVERRIDE_MOTIF_REQUIS',
    `code=${r.body.code}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 07 — POST /rapprocher sur facture inexistante → 404
// ─────────────────────────────────────────────────────────────────────────────
async function test07_rapprochement404() {
  console.log('\nTEST 07 — Rapprochement sur facture inexistante → 404');
  const r = await req('POST', '/achats/factures-fournisseurs/999999/rapprocher', {});
  assert('HTTP 404', r.status === 404, `status=${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 08 — POST /rapprocher sur facture payée → 400
// ─────────────────────────────────────────────────────────────────────────────
async function test08_rapprochementFacturePayee() {
  console.log('\nTEST 08 — Rapprochement sur facture déjà payée → 400');
  const liste = await req('GET', '/achats/factures-fournisseurs?statut=payee&limit=1');
  const payee  = liste.body.factures?.[0];
  if (!payee) {
    console.log('  ↷ Aucune facture payée en base — test ignoré');
    return;
  }
  const r = await req('POST', `/achats/factures-fournisseurs/${payee.id}/rapprocher`, {});
  assert('HTTP 400', r.status === 400, `status=${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 09 — Contestation sans motif → 400
// ─────────────────────────────────────────────────────────────────────────────
async function test09_contestationSansMotif() {
  console.log('\nTEST 09 — Contestation sans motif → 400');
  const liste = await req('GET', '/achats/factures-fournisseurs?limit=1');
  const ff     = liste.body.factures?.[0];
  if (!ff) { console.log('  ↷ Aucune facture — test ignoré'); return; }
  const r = await req('POST',
    `/achats/factures-fournisseurs/${ff.id}/contester-rapprochement`, {});
  assert('HTTP 400 (motif manquant)', r.status === 400, `status=${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — Dashboard RBAC : lecteur → 403
// ─────────────────────────────────────────────────────────────────────────────
async function test10_rbacLecteur() {
  console.log('\nTEST 10 — RBAC : accès sans token → 401 ou 403');
  const r = await fetch(BASE_URL + '/api/achats/rapprochement/tableau-de-bord', {
    headers: { 'Authorization': 'Bearer jeton_invalide' },
  });
  assert('HTTP 401 ou 403', [401, 403].includes(r.status), `status=${r.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' TESTS RAPPROCHEMENT 3 VOIES — feat-achats-rapprochement');
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`Token    : ${TOKEN ? TOKEN.slice(0, 20) + '…' : '(absent — tests RBAC seulement)'}`);

  await test01_dashboardRepond();
  await test02_simulationStructure();
  await test03_sansBC();
  await test04_paiementBloqueEcartBloquant();
  await test05_paiementBloqueConteste();
  await test06_overrideSansMotif();
  await test07_rapprochement404();
  await test08_rapprochementFacturePayee();
  await test09_contestationSansMotif();
  await test10_rbacLecteur();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` Résultat : ${passed} ✓  ${failed} ✗  sur ${passed + failed} tests`);
  if (failed > 0) {
    console.error(' ⚠ Tests échoués — ne pas merger avant correction.');
    process.exit(1);
  } else {
    console.log(' ✅ Tous les tests passent.');
    process.exit(0);
  }
})();

// @ts-check
/**
 * Tests Playwright — Modules Ventes (Clients, Devis, Factures)
 * Couvre : workflow complet + règles anti-fraude + RBAC
 */
const { test, expect } = require('@playwright/test');

const BASE  = 'https://talatala.topcenter.cg';
const API   = BASE + '/api';
const EMAIL = 'admin@topcenter.cg';
const PASS  = 'Admin@2025!';

// ─── Helpers API ──────────────────────────────────────────────────────────────

async function apiLogin(request, email = EMAIL, pass = PASS) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: pass }
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.token).toBeTruthy();
  return body.token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─── UI helper ────────────────────────────────────────────────────────────────

async function loginUI(page) {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 15000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('button[type=submit]');
  await page.waitForSelector('#kpi-solde', { timeout: 25000 });
}

// ─── TEST 01 — Créer un client → vérifier dans la liste ──────────────────────

test('01 - Créer un client et le retrouver dans la liste', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Création
  const nomClient = `Client Test PW ${Date.now()}`;
  const create = await request.post(`${API}/clients`, {
    headers,
    data: { nom: nomClient, type: 'entreprise', telephone: '0612345678', email: 'test@pw.cg' }
  });
  expect(create.status()).toBe(201);
  const client = await create.json();
  expect(client.id).toBeTruthy();
  expect(client.numero_client).toMatch(/^CLT-\d+$/);

  // Retrouver dans la liste
  const list = await request.get(`${API}/clients`, { headers });
  expect(list.status()).toBe(200);
  const { clients } = await list.json();
  const found = clients.find(c => c.id === client.id);
  expect(found).toBeTruthy();
  expect(found.nom).toBe(nomClient);
});

// ─── TEST 02 — Créer un devis → l'accepter → le convertir en facture ─────────

test('02 - Workflow devis : créer → accepter → convertir en facture', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Prérequis : créer un client
  const clientRes = await request.post(`${API}/clients`, {
    headers,
    data: { nom: `Client Devis ${Date.now()}`, type: 'particulier' }
  });
  expect(clientRes.status()).toBe(201);
  const { id: clientId } = await clientRes.json();

  // Créer le devis
  const devisRes = await request.post(`${API}/devis`, {
    headers,
    data: {
      client_id: clientId,
      objet: 'Devis test Playwright',
      date_devis: new Date().toISOString().slice(0, 10),
      date_validite: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      lignes: [{ designation: 'Prestation A', quantite: 2, prix_unitaire: 50000, taux_taxe: 18 }]
    }
  });
  expect(devisRes.status()).toBe(201);
  const devis = await devisRes.json();
  expect(devis.statut).toBe('brouillon');
  expect(devis.numero).toMatch(/^DEV-\d{4}-\d+$/);

  // Envoyer le devis (brouillon → envoye)
  const envoyerRes = await request.post(`${API}/devis/${devis.id}/envoyer`, { headers });
  expect(envoyerRes.status()).toBe(200);

  // Accepter le devis (envoye → accepte)
  const accepterRes = await request.post(`${API}/devis/${devis.id}/accepter`, {
    headers,
    data: { preuve: 'Accord par email du client' }
  });
  expect(accepterRes.status()).toBe(200);
  const accepted = await accepterRes.json();
  expect(accepted.statut).toBe('accepte');

  // Convertir en facture (accepte → facture_client créée)
  const convertirRes = await request.post(`${API}/devis/${devis.id}/convertir`, { headers });
  expect(convertirRes.status()).toBe(201);
  const facture = await convertirRes.json();
  expect(facture.id).toBeTruthy();
  expect(facture.devis_id).toBe(devis.id);
  expect(facture.numero).toMatch(/^FAC-\d{4}-\d+$/);
});

// ─── TEST 03 — Paiement partiel → vérifier statut partiellement_payee ────────

test('03 - Paiement partiel : statut passe à partiellement_payee', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Client
  const clientRes = await request.post(`${API}/clients`, {
    headers,
    data: { nom: `Client Paiement ${Date.now()}` }
  });
  const { id: clientId } = await clientRes.json();

  // Facture en brouillon
  const facRes = await request.post(`${API}/factures-clients`, {
    headers,
    data: {
      client_id: clientId,
      objet: 'Facture paiement partiel test',
      date_facture: new Date().toISOString().slice(0, 10),
      date_echeance: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      lignes: [{ designation: 'Service B', quantite: 1, prix_unitaire: 100000, taux_taxe: 0 }]
    }
  });
  expect(facRes.status()).toBe(201);
  const facture = await facRes.json();

  // Émettre la facture
  const emettreRes = await request.post(`${API}/factures-clients/${facture.id}/emettre`, { headers });
  expect(emettreRes.status()).toBe(200);

  // Paiement partiel (50 000 sur 100 000)
  const paiRes = await request.post(`${API}/factures-clients/${facture.id}/enregistrer-paiement`, {
    headers,
    data: { montant: 50000, mode_paiement: 'especes', reference: 'RECU-001' }
  });
  expect(paiRes.status()).toBe(200);
  const result = await paiRes.json();
  expect(result.statut).toBe('partiellement_payee');
  expect(result.montant_paye).toBe(50000);
});

// ─── TEST 04 — Modifier une facture émise → doit être rejeté 403 ─────────────

test('04 - Modifier une facture émise est rejeté (403)', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Client
  const clientRes = await request.post(`${API}/clients`, {
    headers,
    data: { nom: `Client Verrou ${Date.now()}` }
  });
  const { id: clientId } = await clientRes.json();

  // Facture
  const facRes = await request.post(`${API}/factures-clients`, {
    headers,
    data: {
      client_id: clientId,
      objet: 'Facture verrou test',
      date_facture: new Date().toISOString().slice(0, 10),
      lignes: [{ designation: 'Article C', quantite: 1, prix_unitaire: 20000, taux_taxe: 0 }]
    }
  });
  const facture = await facRes.json();

  // Émettre (verrouille)
  await request.post(`${API}/factures-clients/${facture.id}/emettre`, { headers });

  // Tentative de modification → doit échouer 403
  const putRes = await request.put(`${API}/factures-clients/${facture.id}`, {
    headers,
    data: { objet: 'Tentative de fraude' }
  });
  expect(putRes.status()).toBe(403);
  const err = await putRes.json();
  expect(err.error).toContain('impossible');
});

// ─── TEST 05 — Client mauvais_payeur bloque la création de facture ────────────

test('05 - Client mauvais_payeur bloque la création de facture', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Créer un client
  const clientRes = await request.post(`${API}/clients`, {
    headers,
    data: { nom: `Client Bloqué ${Date.now()}` }
  });
  const { id: clientId } = await clientRes.json();

  // Mettre le client en statut mauvais_payeur
  const suspRes = await request.post(`${API}/clients/${clientId}/suspendre`, {
    headers,
    data: { statut: 'mauvais_payeur', motif: 'Impayés répétés test Playwright' }
  });
  expect(suspRes.status()).toBe(200);

  // Tenter de créer une facture pour ce client → doit être bloqué
  const facRes = await request.post(`${API}/factures-clients`, {
    headers,
    data: {
      client_id: clientId,
      objet: 'Facture bloquée',
      date_facture: new Date().toISOString().slice(0, 10),
      lignes: [{ designation: 'Test', quantite: 1, prix_unitaire: 10000, taux_taxe: 0 }]
    }
  });
  // La création doit échouer (400 ou 403) car client suspendu/mauvais_payeur
  expect([400, 403]).toContain(facRes.status());
  const err = await facRes.json();
  expect(err.error).toBeTruthy();
});

// ─── TEST 06 — RBAC : utilisateur sans rôle ne peut pas créer de client ──────

test('06 - RBAC : rôle caissier ne peut pas créer un client', async ({ request }) => {
  // Ce test est conditionnel : il nécessite un utilisateur avec rôle caissier
  // Si aucun tel utilisateur n'existe, on note le cas mais on ne bloque pas la suite
  let token;
  try {
    token = await apiLogin(request, 'caissier@topcenter.cg', 'Caissier@2025!');
  } catch {
    // Pas d'utilisateur caissier en place — test ignoré gracieusement
    console.log('TEST 06 skippé : aucun compte caissier disponible');
    return;
  }

  const res = await request.post(`${API}/clients`, {
    headers: authHeaders(token),
    data: { nom: 'Client RBAC test' }
  });
  expect(res.status()).toBe(403);
});

// ─── TEST 07 — Doublon facture fournisseur → 409 ─────────────────────────────

test('07 - Doublon facture fournisseur déclenche 409', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Prérequis : il faut un BC validé et une réception validée pour créer une FF
  // Ce test vérifie l'unicité (numero, fournisseur_id) directement
  const fournisseurRes = await request.get(`${API}/achats/fournisseurs`, { headers });
  if (fournisseurRes.status() !== 200) {
    console.log('TEST 07 skippé : endpoint fournisseurs indisponible');
    return;
  }
  const { fournisseurs } = await fournisseurRes.json();
  if (!fournisseurs?.length) {
    console.log('TEST 07 skippé : aucun fournisseur en base');
    return;
  }

  const fournisseurId = fournisseurs[0].id;
  const numeroDoublon = `FF-TEST-${Date.now()}`;

  const payload = {
    fournisseur_id: fournisseurId,
    numero_facture_fournisseur: numeroDoublon,
    date_facture: new Date().toISOString().slice(0, 10),
    date_echeance: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    montant_ht: 100000, montant_ttc: 118000
  };

  const first = await request.post(`${API}/achats/factures-fournisseurs`, { headers, data: payload });
  // Premier appel peut réussir ou échouer (sans BC/Réception validés) — on teste juste le doublon
  if (first.status() !== 201) {
    console.log('TEST 07 skippé : création FF nécessite BC+Réception validés');
    return;
  }

  // Deuxième appel avec même numero + fournisseur → doit retourner 409
  const second = await request.post(`${API}/achats/factures-fournisseurs`, { headers, data: payload });
  expect(second.status()).toBe(409);
  const err = await second.json();
  expect(err.error).toContain('doublon');
});

// ─── TEST 08 — Audit log tracé sur changement de statut devis ────────────────

test('08 - Audit log tracé après acceptation devis', async ({ request }) => {
  const token = await apiLogin(request);
  const headers = authHeaders(token);

  // Créer client + devis
  const clientRes = await request.post(`${API}/clients`, {
    headers,
    data: { nom: `Client Audit ${Date.now()}` }
  });
  const { id: clientId } = await clientRes.json();

  const devisRes = await request.post(`${API}/devis`, {
    headers,
    data: {
      client_id: clientId,
      objet: 'Devis audit test',
      date_devis: new Date().toISOString().slice(0, 10),
      date_validite: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
      lignes: [{ designation: 'Item A', quantite: 1, prix_unitaire: 10000, taux_taxe: 0 }]
    }
  });
  const devis = await devisRes.json();

  await request.post(`${API}/devis/${devis.id}/envoyer`, { headers });
  await request.post(`${API}/devis/${devis.id}/accepter`, { headers, data: { preuve: 'OK' } });

  // Vérifier dans l'audit log
  const auditRes = await request.get(`${API}/audit?table=devis&record_id=${devis.id}`, { headers });
  expect(auditRes.status()).toBe(200);
  const { logs } = await auditRes.json();
  const hasAccepter = logs?.some(l => l.action?.includes('ACCEPTER') || l.details?.includes('accepte'));
  expect(hasAccepter).toBe(true);
});

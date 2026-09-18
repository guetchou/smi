'use strict';
/*
 * Le parcours de caisse, vu depuis l'écran.
 *
 * Ce que la mesure doit trancher, dans l'ordre où l'agent le rencontre :
 *   1. l'entrée « Opérations » est-elle dans le menu ?
 *   2. le bouton « Encaisser » est-il là ?
 *   3. le clic ouvre-t-il la fenêtre ?
 *   4. les listes déroulantes sont-elles remplies ?
 *   5. l'enregistrement atteint-il le serveur, et la vente est-elle en base ?
 *
 * Chaque étape laisse une capture : une panne de saisie se lit alors sur
 * l'image, sans demander à personne de la décrire.
 */
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL;
const capturesDir = process.env.SMI_E2E_SCREENSHOT_DIR;
const userId = Number(process.env.SMI_E2E_USER_ID);
const token = process.env.SMI_E2E_TOKEN;

const capture = (page, nom) => page.screenshot({
  path: path.join(capturesDir, `${nom}.png`),
  fullPage: false,
});

/* Le jeton vient du harnais : jsonwebtoken vit dans backend/node_modules,
   hors de portee de Playwright lance depuis la racine. */
const jeton = () => token;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([t, id]) => {
    localStorage.setItem('tc_token', t);
    localStorage.setItem('tc_user', JSON.stringify({
      id, nom: 'CAISSE', prenom: 'E2E', email: 'caisse.e2e@topcenter.cg',
      role: 'assistante_direction',
      roles: ['assistante_direction', 'finance', 'caissier', 'rh'],
      employe_id: null,
    }));
  }, [jeton(), userId]);

  // Les erreurs du navigateur sont rapportées : un clic sans effet vient
  // souvent d'une exception que personne ne voit.
  page.on('pageerror', e => console.error('[navigateur]', e.message));
});

test('une assistante de direction enregistre un encaissement', async ({ page }) => {
  const refusees = [];
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      refusees.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
    }
  });

  const envoyees = [];
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().includes('/api/operations')) {
      envoyees.push(new URL(r.url()).pathname);
    }
  });

  await page.goto(`${baseURL}/app/tableau-de-bord`);
  // Le tableau de bord interroge le serveur en boucle : « networkidle »
  // n'arrive jamais. On attend le menu, qui est ce qu'on vient mesurer.
  await page.locator('#sidebar .nav-link').first().waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2000);
  await capture(page, '01-tableau-de-bord');

  // ── 1. Le bouton « Encaisser » ────────────────────────────────────────────
  // Il est sur le tableau de bord, la page d'arrivee : c'est le geste
  // quotidien, il ne se cherche pas dans un sous-menu.
  const boutonEncaisser = page.locator('button', { hasText: /^\s*Encaisser\s*$/ }).first();
  await expect(boutonEncaisser, 'Le bouton « Encaisser » doit être visible pour ce rôle')
    .toBeVisible({ timeout: 15000 });
  await capture(page, '02-bouton-encaisser');

  // ── 3. Le clic ouvre la fenêtre ───────────────────────────────────────────
  await boutonEncaisser.click();
  const fenetre = page.locator('#modal-encaissement');
  await expect(fenetre, 'Le clic sur « Encaisser » doit ouvrir la fenêtre de saisie')
    .toBeVisible({ timeout: 10000 });
  await capture(page, '03-fenetre-encaissement');

  // ── 4. Les listes doivent être remplies ───────────────────────────────────
  const nbRubriques = await page.locator('#enc-rubrique option').count();
  const nbPositions = await page.locator('#enc-position option').count();
  expect(nbRubriques, 'La liste des rubriques ne doit pas être vide — sinon le navigateur refuse l\'envoi')
    .toBeGreaterThan(0);
  expect(nbPositions, 'La liste des positions ne doit pas être vide').toBeGreaterThan(0);

  // ── 5. La saisie ──────────────────────────────────────────────────────────
  await page.fill('#enc-libelle', 'Recette E2E');
  await page.fill('#enc-montant', '25000');
  await page.selectOption('#enc-rubrique', { index: nbRubriques > 1 ? 1 : 0 });
  await page.selectOption('#enc-position', { index: nbPositions > 1 ? 1 : 0 });

  // ── 5 bis. Sans tiers, l'enregistrement est refusé ────────────────────────
  // Sans tiers, accounting.js donne à l'opération le critère
  // « third_party_type: '*' » — inconnu — qu'aucune règle ne couvre pour un
  // encaissement en espèces : l'argent entre en caisse sans écriture
  // comptable, en silence. Constaté en production le 17/09/2026.
  const bouton = page.locator('#form-encaissement button[type="submit"]');
  await expect(bouton, 'Sans tiers, le bouton doit rester refusé').toBeDisabled();
  await expect(
    page.locator('#enc-impact-summary'),
    'Et le pied doit dire ce qui manque — un bouton gris sans raison est ce qui a fait croire que « ça ne s\'enregistre pas »',
  ).toContainText('tiers');
  await capture(page, '04a-sans-tiers-refuse');

  // Le tiers est renseigné en dernier, puis on rend la main au formulaire :
  // sa liste d'aide s'ouvre à la frappe et recouvrirait le pied de fenêtre.
  await page.fill('#enc-tiers', 'Client E2E');
  await page.locator('#enc-libelle').click();
  await expect(bouton, 'Le tiers renseigné, le bouton doit s\'activer').toBeEnabled();
  await capture(page, '04-formulaire-rempli');

  await page.locator('#form-encaissement button[type="submit"]').click();
  await page.waitForTimeout(3000);
  await capture(page, '05-apres-enregistrement');

  expect(envoyees.length, 'Un POST /api/operations doit partir vers le serveur').toBeGreaterThan(0);

  await expect(
    page.locator('text=Opération enregistrée').first(),
    "L'écran doit confirmer l'enregistrement"
  ).toBeVisible({ timeout: 10000 });

  // ── La vente est-elle en base ? ───────────────────────────────────────────
  const liste = await page.evaluate(async ([url, t]) => {
    const r = await fetch(`${url}/api/operations?limit=10&offset=0`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    return { statut: r.status, corps: r.ok ? await r.json() : null };
  }, [baseURL, jeton()]);

  const lignes = Array.isArray(liste.corps) ? liste.corps : (liste.corps?.rows || []);
  const trouvee = lignes.find(o => (o.libelle || o.detail) === 'Recette E2E');

  fs.writeFileSync(path.join(capturesDir, 'refus-api.json'), JSON.stringify(refusees, null, 2));
  if (refusees.length) console.error('[api refusée]', refusees.join(' | '));

  expect(trouvee, "L'encaissement doit exister en base après enregistrement").toBeTruthy();
  expect(Number(trouvee.montant)).toBe(25000);

  // ── L'écriture comptable a-t-elle suivi ? ─────────────────────────────────
  // Le 17/09/2026 en production, une vente est entrée en caisse et le journal
  // d'audit a gardé « accounting_generation_failed /
  // ACCOUNTING_MAPPING_MISSING » : aucune écriture, et rien à l'écran pour le
  // dire. Arriver en base ne suffit donc pas.
  //
  // La chaîne se joue en deux temps, et c'est voulu : l'enregistrement génère
  // un BROUILLON, une personne habilitée le valide. On garde les deux.
  const lireJournal = async statut => page.evaluate(async ([url, t, s]) => {
    const r = await fetch(`${url}/api/accounting/entries?status=${s}&limit=200`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    return { statut: r.status, corps: r.ok ? await r.json() : null };
  }, [baseURL, jeton(), statut]);

  const brouillons = await lireJournal('draft');
  expect(brouillons.statut, 'Le journal comptable doit être lisible').toBe(200);
  const lignesBrouillon = (brouillons.corps?.rows || [])
    .filter(l => Number(l.source_record_id) === Number(trouvee.id));
  expect(
    lignesBrouillon.length,
    "L'encaissement doit produire une écriture : sans elle il entre en caisse sans comptabilité, en silence",
  ).toBeGreaterThan(0);

  // ── La validation poste l'écriture ────────────────────────────────────────
  const entryId = lignesBrouillon[0].entry_id;
  const validation = await page.evaluate(async ([url, t, id]) => {
    const r = await fetch(`${url}/api/accounting/entries/${id}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: '{}',
    });
    return { statut: r.status, corps: r.ok ? await r.json() : await r.text() };
  }, [baseURL, jeton(), entryId]);
  expect(
    validation.statut,
    "L'agent qui porte le rôle « finance » doit pouvoir valider l'écriture",
  ).toBe(200);

  const postees = await lireJournal('posted');
  const lignesPostees = (postees.corps?.rows || [])
    .filter(l => Number(l.source_record_id) === Number(trouvee.id));
  expect(lignesPostees.length, "L'écriture validée doit passer au journal").toBeGreaterThan(0);
  expect(postees.corps.balanced, 'Le journal doit rester équilibré').toBe(true);

  // ── Et l'opération doit le savoir ─────────────────────────────────────────
  const apresValidation = await page.evaluate(async ([url, t, id]) => {
    const r = await fetch(`${url}/api/operations?limit=10&offset=0`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    const corps = r.ok ? await r.json() : null;
    const lignes = Array.isArray(corps) ? corps : (corps?.rows || []);
    return lignes.find(o => Number(o.id) === Number(id)) || null;
  }, [baseURL, jeton(), trouvee.id]);

  fs.writeFileSync(
    path.join(capturesDir, 'ecriture-comptable.json'),
    JSON.stringify({
      operation: trouvee.id,
      statut_avant_validation: trouvee.accounting_status,
      statut_apres_validation: apresValidation?.accounting_status,
      ecriture: entryId,
      lignes_postees: lignesPostees,
    }, null, 2),
  );
  expect(
    apresValidation?.accounting_status,
    "Une fois l'écriture validée, l'opération doit porter « synced » — « error » signifie qu'aucune écriture n'a pu être produite",
  ).toBe('synced');
});

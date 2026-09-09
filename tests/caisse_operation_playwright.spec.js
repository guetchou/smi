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
});

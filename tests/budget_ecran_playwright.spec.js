'use strict';
/*
 * L'écran « Prévisions budgétaires », vu depuis le navigateur, à 1366×768.
 *
 *   1. l'entrée est dans le menu Comptabilité et ouvre la page ;
 *   2. la grille montre le réalisé des opérations validées ;
 *   3. une prévision saisie « 3 000 000 » part au serveur et revient affichée ;
 *   4. aucune erreur de navigateur, aucune requête refusée.
 * La vérification en base est faite par le harnais, après ce scénario.
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL;
const capturesDir = process.env.SMI_E2E_SCREENSHOT_DIR;
const userId = Number(process.env.SMI_E2E_USER_ID);
const token = process.env.SMI_E2E_TOKEN;
const categorie = process.env.SMI_E2E_CATEGORIE;

const capture = (page, nom) => page.screenshot({ path: path.join(capturesDir, `${nom}.png`), fullPage: false });
const espaces = s => String(s).replace(/[  ]/g, ' ');

test.use({ viewport: { width: 1366, height: 768 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([t, id]) => {
    localStorage.setItem('tc_token', t);
    localStorage.setItem('tc_user', JSON.stringify({
      id, nom: 'FINANCE', prenom: 'E2E', email: 'finance.e2e@topcenter.cg',
      role: 'finance', roles: ['finance'], employe_id: null,
    }));
  }, [token, userId]);
});

test('la finance saisit une prévision et la retrouve', async ({ page }) => {
  const erreurs = [];
  page.on('pageerror', e => erreurs.push('[navigateur] ' + e.message));
  const refusees = [];
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/api/')) refusees.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });

  await page.goto(`${baseURL}/app/finance/budget`);
  const grille = page.locator('#bud-grille');
  await expect(grille.locator('input[data-cat]').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#page-title')).toHaveText('Prévisions budgétaires');
  await capture(page, '01-grille-au-chargement');

  const lien = page.locator('a.nav-link[data-page="budget"]');
  await expect(lien).toHaveCount(1);
  await expect(lien).toHaveClass(/active/);

  const ligne = grille.locator('tr', { hasText: categorie });
  await expect(ligne).toHaveCount(1);
  const janvier = ligne.locator('input[data-mois="1"]');
  // Réalisé de janvier : l'encaissement semé de 1 200 000.
  expect(espaces(await ligne.locator('td').nth(1).locator('.bud-reel').innerText())).toBe('1 200 000');

  await janvier.fill('3 000 000');
  const envoi = page.waitForResponse(r => r.url().includes('/api/budgets') && r.request().method() === 'PUT');
  await page.locator('#bud-enregistrer').click();
  expect((await envoi).status()).toBe(200);

  await expect.poll(async () => espaces(await grille.locator('tr', { hasText: categorie }).locator('input[data-mois="1"]').inputValue())).toBe('3 000 000');
  await expect.poll(async () => espaces(await page.locator('#bud-synthese').innerText())).toContain('3 000 000');
  // Janvier : 1 200 000 réalisés pour 3 000 000 prévus ; février n'a pas de prévision.
  expect(espaces(await page.locator('#bud-synthese').innerText())).toContain('1 800 000');
  // Le montant saisi se lit en entier dans sa case.
  const largeurs = await janvier.evaluate(i => ({ contenu: i.scrollWidth, visible: i.clientWidth }));
  expect(largeurs.contenu, JSON.stringify(largeurs)).toBeLessThanOrEqual(largeurs.visible);
  await capture(page, '02-apres-enregistrement');

  await page.locator('#bud-type-decaissement').click();
  await expect(page.locator('#bud-type-decaissement')).toHaveAttribute('aria-pressed', 'true');
  await capture(page, '03-decaissements');

  expect(erreurs, erreurs.join('\n')).toEqual([]);
  expect(refusees, refusees.join('\n')).toEqual([]);
});

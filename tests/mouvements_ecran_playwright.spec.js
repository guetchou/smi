'use strict';
/*
 * Ecran « Mouvements caisse/banque » apres la refonte du 29/09/2026
 * (reference Finora) : journal au centre, synthese a droite, anomalies
 * repliees. Chaque ecran laisse une capture, defilement compris.
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL;
const capturesDir = process.env.SMI_E2E_SCREENSHOT_DIR;
const userId = Number(process.env.SMI_E2E_USER_ID);
const token = process.env.SMI_E2E_TOKEN;
const capture = (page, nom) => page.screenshot({ path: path.join(capturesDir, nom + '.png') });

test.use({ viewport: { width: 1366, height: 768 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([t, id]) => {
    localStorage.setItem('tc_token', t);
    localStorage.setItem('tc_user', JSON.stringify({
      id, nom: 'CAISSE', prenom: 'E2E', email: 'caisse.e2e@topcenter.cg',
      role: 'assistante_direction', roles: ['assistante_direction', 'finance', 'caissier', 'rh'], employe_id: null,
    }));
  }, [token, userId]);
  page.on('pageerror', e => console.error('[navigateur]', e.message));
});

test('le journal tient au centre, la synthese a droite, sans texte de developpement', async ({ page }) => {
  await page.goto(baseURL + '/app/finance/operations');
  await page.locator('#ops-tbody tr').first().waitFor({ timeout: 20000 });
  await page.evaluate(() => { if (typeof setOpsFilter === 'function') setOpsFilter('all'); });
  await expect(page.locator('#ops-tbody tr')).toHaveCount(15, { timeout: 15000 });
  await page.waitForTimeout(800);

  // Une ligne par mouvement : ni la date ni le montant ne passent a la ligne.
  const hauteurs = await page.$$eval('#ops-tbody tr', trs => trs.map(t => Math.round(t.getBoundingClientRect().height)));
  expect(Math.max(...hauteurs), JSON.stringify(hauteurs)).toBeLessThanOrEqual(72);

  /* Premiere maquette : le test verifiait que la synthese etait a droite,
     pas que tout tenait dans l ecran — quatre colonnes etaient cachees et la
     synthese coupait « XAF » au bord. On mesure ce que l oeil voit. */
  const largeur = page.viewportSize().width;
  for (const sel of ['.ops-journal', '.ops-synthese', '.ops-positions', '.ops-command-card']) {
    const b = await page.locator(sel).boundingBox();
    expect(b.x + b.width, sel + ' sort de l ecran').toBeLessThanOrEqual(largeur);
  }
  const tableau = await page.$eval('#page-operations .ops-table-scroll', e => ({ contenu: e.scrollWidth, visible: e.clientWidth }));
  expect(tableau.contenu, 'le tableau cache des colonnes').toBeLessThanOrEqual(tableau.visible + 1);
  // En-tete sur une ligne : les actions a la hauteur des espaces de travail.
  const espaces = await page.locator('.ops-workspace-switcher').boundingBox();
  const actions = await page.locator('.ops-page-actions').boundingBox();
  expect(Math.abs(espaces.y - actions.y), 'en-tete empile').toBeLessThan(20);

  // Soldes par position, la BCH negative en rouge.
  await expect(page.locator('#ops-positions-list .ops-position')).toHaveCount(2);
  await expect(page.locator('#ops-positions-list .text-rose-600')).toHaveCount(1);

  // Les anomalies sont repliees : leur liste ne prend aucune place.
  await expect(page.locator('#ops-sync-errors-panel')).toBeVisible();
  expect(await page.locator('#ops-sync-errors-list').isVisible()).toBe(false);

  const texte = await page.locator('#page-operations').innerText();
  expect(texte).not.toMatch(/Totaux calculés sur|pas seulement sur la page visible|Filtres du journal validé|non finalisés/);

  // Captures, defilement compris.
  const conteneur = '#app-page-container';
  const { hauteur, vue } = await page.$eval(conteneur, c => ({ hauteur: c.scrollHeight, vue: c.clientHeight }));
  let i = 0;
  for (let y = 0; y < hauteur; y += vue - 60) {
    await page.$eval(conteneur, (c, v) => { c.scrollTop = v; }, y);
    await page.waitForTimeout(300);
    await capture(page, 'mouvements-' + i++);
  }
  await page.$eval(conteneur, c => { c.scrollTop = 0; });
  await page.locator('#ops-sync-errors-panel summary').click();
  await expect(page.locator('#ops-sync-errors-list')).toBeVisible();
  await capture(page, 'mouvements-anomalies-ouvertes');
});

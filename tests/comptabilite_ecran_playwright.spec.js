'use strict';
/*
 * Les écrans de comptabilité générale, vus depuis le navigateur à 1366×768 :
 * le cockpit remplace la page actuelle, le journal filtre, la balance
 * regroupe ; aucune erreur de navigateur, aucune requête refusée, et le mot
 * « Dolibarr » n'apparaît nulle part à l'écran.
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL;
const capturesDir = process.env.SMI_E2E_SCREENSHOT_DIR;
const userId = Number(process.env.SMI_E2E_USER_ID);
const token = process.env.SMI_E2E_TOKEN;
const capture = (page, nom) => page.screenshot({ path: path.join(capturesDir, `${nom}.png`), fullPage: false });
const espaces = s => String(s).replace(/[  ]/g, ' ');

test.use({ viewport: { width: 1366, height: 768 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([t, id]) => {
    localStorage.setItem('tc_token', t);
    localStorage.setItem('tc_user', JSON.stringify({ id, nom: 'COMPTA', prenom: 'E2E', email: 'compta.e2e@topcenter.cg', role: 'finance', roles: ['finance'], employe_id: null }));
  }, [token, userId]);
});

test('le comptable parcourt cockpit, journal et balance', async ({ page }) => {
  const erreurs = [];
  page.on('pageerror', e => erreurs.push('[navigateur] ' + e.message));
  const refusees = [];
  page.on('response', r => { if (r.status() >= 400 && r.url().includes('/api/')) refusees.push(`${r.status()} ${new URL(r.url()).pathname}`); });

  await page.goto(`${baseURL}/app/comptabilite`);
  const racine = page.locator('#page-comptabilite-dashboard > .cg-racine');
  await expect(racine.locator('.cg-bandeau')).toBeVisible({ timeout: 15000 });
  await expect(racine.locator('.cg-bandeau')).toContainText('Passage au grand livre · À jour');
  await expect(page.locator('#cpta-dashboard-kpis')).toBeHidden();
  expect(espaces(await racine.innerText())).toContain('1 200 000');
  await expect(racine.locator('.cg-table tbody tr')).toHaveCount(6);
  await expect(racine.locator('.cg-carte-lien')).toContainText('Pièce de paie · août');
  // Les quatre cartes ont la même largeur : la carte-bouton ne laisse pas de trou.
  const largeurs = await racine.locator('.cg-cartes > *').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  expect(new Set(largeurs).size, JSON.stringify(largeurs)).toBe(1);
  await capture(page, '01-cockpit');

  // C4 : la pièce de paie d'août, validée et écrite depuis l'écran.
  await racine.locator('.cg-carte-lien').click();
  await expect(racine.locator('.cg-detail')).toBeVisible({ timeout: 15000 });
  await expect(racine.locator('.cg-detail')).toContainText('Équilibre débit/crédit ✓');
  await expect(racine.locator('.cg-puce')).toHaveText('Brouillons');
  await capture(page, '05-piece-paie');
  const ecriture = page.waitForResponse(r => r.url().includes('/pieces-paie/') && r.url().endsWith('/ecrire'));
  await racine.locator('[data-cg-ecrire]').click();
  expect((await ecriture).status()).toBe(200);
  await expect(racine.locator('.cg-puce')).toHaveText('Validées', { timeout: 15000 });
  await expect(racine.locator('[data-cg-ecrire]')).toBeDisabled();
  await capture(page, '06-piece-ecrite');
  await racine.locator('[data-cg-onglet="cockpit"]').first().click();
  await expect(racine.locator('.cg-bandeau')).toBeVisible();

  await racine.locator('[data-cg-onglet="journal"]').click();
  const journal = page.locator('#page-journal-comptable > .cg-racine');
  // 19 lignes du bac à sable + les 10 lignes de la pièce de paie d'août.
  await expect(journal.locator('.cg-table tbody tr')).toHaveCount(29, { timeout: 15000 });
  await capture(page, '02-journal');
  /* Vu en production le 29/09/2026 : l'ancienne carte du journal restait
     affichee sous le tableau — #page-journal-comptable .cpta-ledger-shell
     { display: grid } battait la classe hidden. On mesure l'affichage reel,
     pas la presence d'une classe. */
  const anciensVisibles = await page.$$eval('#page-journal-comptable > :not(.cg-racine)',
    els => els.filter(e => e.getClientRects().length > 0).map(e => e.className));
  expect(anciensVisibles, JSON.stringify(anciensVisibles)).toEqual([]);
  await journal.locator('select[name="journal"]').selectOption('BQ');
  await journal.locator('button[type="submit"]').click();
  await expect(journal.locator('.cg-table tbody tr')).toHaveCount(10);
  expect(espaces(await journal.locator('.cg-filtres').innerText())).toContain('10 lignes');
  await capture(page, '03-journal-banque');

  await journal.locator('[data-cg-onglet="balance"]').click();
  await expect(journal.locator('.cg-classe')).toHaveCount(4, { timeout: 15000 });
  await expect(journal.locator('.cg-ligne-alerte')).toHaveCount(1);
  await capture(page, '04-balance');

  expect(await page.locator('body').innerText()).not.toMatch(/dolibarr/i);
  expect(erreurs, erreurs.join('\n')).toEqual([]);
  expect(refusees, refusees.join('\n')).toEqual([]);
});

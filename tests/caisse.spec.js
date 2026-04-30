// @ts-check
const { test, expect } = require('@playwright/test');

const BASE = 'https://talatala.topcenter.cg';
const EMAIL = 'admin@topcenter.cg';
const PASS  = 'Admin@2025!';

async function login(page) {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 15000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('button[type=submit]');
  // Attendre que le dashboard soit chargé (kpi-solde est rendu après auth)
  await page.waitForSelector('#kpi-solde', { timeout: 25000 });
}

test('01 - Page login se charge', async ({ page }) => {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#email')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('button[type=submit]')).toBeVisible();
});

test('02 - Connexion admin reussie', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/dashboard/);
});

test('03 - Connexion invalide ne redirige pas', async ({ page }) => {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 10000 });
  await page.fill('#email', 'faux@test.cg');
  await page.fill('#password', 'mauvais');
  await page.click('button[type=submit]');
  await page.waitForTimeout(3000);
  await expect(page).not.toHaveURL(/dashboard/);
});

test('04 - Dashboard affiche KPI Solde Caisse', async ({ page }) => {
  await login(page);
  await expect(page.locator('#kpi-solde')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('text=Solde Caisse')).toBeVisible({ timeout: 5000 });
});

test('05 - Navigation page operations', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'operations\')"]');
  await page.waitForTimeout(500);
  await expect(page.locator('[onclick="openEncaissementModal()"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[onclick="openDecaissementModal()"]')).toBeVisible({ timeout: 5000 });
});

test('06 - Navigation page parametres', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await expect(page.locator('#ptab-entreprise')).toBeVisible({ timeout: 5000 });
});

test('07 - Modal decaissement 3 blocs', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'operations\')"]');
  await page.waitForTimeout(500);
  await page.click('[onclick="openDecaissementModal()"]');
  const modal = page.locator('#modal-decaissement');
  await expect(modal).not.toHaveClass(/hidden/, { timeout: 5000 });
  await expect(modal.locator('#dec-ref-interne')).toBeVisible();
  await expect(modal.locator('#dec-type-piece')).toBeVisible();
  await expect(modal.locator('#dec-benef-type')).toBeVisible();
  await expect(modal.locator('#dec-libelle')).toBeVisible();
  await expect(modal.locator('#dec-montant')).toBeVisible();
});

test('08 - Reference interne DEC-AAAA-XXXXXX auto', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'operations\')"]');
  await page.waitForTimeout(500);
  await page.click('[onclick="openDecaissementModal()"]');
  // Attendre que la réf soit générée (appel API async)
  await page.waitForFunction(() => {
    const v = document.getElementById('dec-ref-interne')?.value || '';
    return v.match(/^DEC-[0-9]{4}-[0-9]+$/);
  }, { timeout: 8000 });
  const refVal = await page.locator('#dec-ref-interne').inputValue();
  expect(refVal).toMatch(/^DEC-[0-9]{4}-[0-9]+$/);
});

test('09 - Beneficiaire employe affiche wrapper', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'operations\')"]');
  await page.waitForTimeout(500);
  await page.click('[onclick="openDecaissementModal()"]');
  await page.waitForTimeout(800);
  await page.selectOption('#dec-benef-type', 'employe');
  await page.waitForTimeout(400);
  await expect(page.locator('#dec-benef-employe-wrapper')).not.toHaveClass(/hidden/);
});

test('10 - Beneficiaire fournisseur affiche wrapper', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'operations\')"]');
  await page.waitForTimeout(500);
  await page.click('[onclick="openDecaissementModal()"]');
  await page.waitForTimeout(800);
  await page.selectOption('#dec-benef-type', 'fournisseur');
  await page.waitForTimeout(400);
  await expect(page.locator('#dec-benef-fournisseur-wrapper')).not.toHaveClass(/hidden/);
});

test('11 - Parametres 4 onglets presents', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await expect(page.locator('#ptab-entreprise')).toBeVisible();
  await expect(page.locator('#ptab-tresorerie')).toBeVisible();
  await expect(page.locator('#ptab-tiers')).toBeVisible();
  await expect(page.locator('#ptab-acces')).toBeVisible();
});

test('12 - Parametres onglet Tresorerie', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await page.click('#ptab-tresorerie');
  await expect(page.locator('#ptab-content-tresorerie')).not.toHaveClass(/hidden/);
});

test('13 - Parametres onglet Tiers', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await page.click('#ptab-tiers');
  await expect(page.locator('#ptab-content-tiers')).not.toHaveClass(/hidden/);
});

test('14 - Parametres onglet Acces', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await page.click('#ptab-acces');
  await expect(page.locator('#ptab-content-acces')).not.toHaveClass(/hidden/);
});

test('15 - Bouton ajouter fournisseur present', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await page.click('#ptab-tiers');
  await expect(page.locator('[onclick="openFournisseurModal()"]')).toBeVisible({ timeout: 5000 });
});

test('16 - Ajouter un fournisseur', async ({ page }) => {
  await login(page);
  await page.click('[onclick="showPage(\'parametres\')"]');
  await page.click('#ptab-tiers');
  await page.click('[onclick="openFournisseurModal()"]');
  const modal = page.locator('#modal-fournisseur');
  await expect(modal).not.toHaveClass(/hidden/, { timeout: 5000 });
  const ts = Date.now();
  const nom = 'Fourn Test ' + ts;
  await modal.locator('#four-nom').fill(nom);
  await modal.locator('#four-tel').fill('069000001');
  await modal.locator('button[type=submit]').click();
  await page.waitForTimeout(1500);
  await expect(page.locator('text=' + nom)).toBeVisible({ timeout: 5000 });
});

test('17 - API health repond ok', async ({ page }) => {
  const resp = await page.request.get(BASE + '/api/health');
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(body.status).toBe('ok');
});

test('18 - API fournisseurs retourne tableau', async ({ page }) => {
  await login(page);
  // Récupérer le token depuis localStorage
  const token = await page.evaluate(() => localStorage.getItem('tc_token'));
  expect(token).toBeTruthy();
  // Appeler l'API avec le token
  const resp = await page.request.get(BASE + '/api/config/fournisseurs', {
    headers: { Authorization: 'Bearer ' + token }
  });
  expect(resp.ok()).toBeTruthy();
  expect(Array.isArray(await resp.json())).toBeTruthy();
});

test('19 - Deconnexion retour login', async ({ page }) => {
  await login(page);
  await page.click('[onclick="logout()"]');
  await page.waitForTimeout(2000);
  await expect(page).toHaveURL(/index\.html|\/$/, { timeout: 10000 });
});

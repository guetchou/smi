// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const BASE       = 'https://talatala.topcenter.cg';
const EMAIL      = 'admin@topcenter.cg';
const PASS       = 'Admin@2025!';
const AUTH_FILE  = path.join(__dirname, '.auth.json');

// ── Login unique : crée .auth.json si absent ──────────────────────
async function ensureAuth() {
  if (fs.existsSync(AUTH_FILE)) return;

  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx     = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await ctx.newPage();

  // Obtenir un captcha valide
  const capRes  = await page.request.get(BASE + '/api/auth/captcha');
  const cap     = await capRes.json();
  const match   = cap.question.match(/(\d+)\s*([+\-×])\s*(\d+)/);
  let answer    = 0;
  if (match) {
    const a = Number(match[1]), op = match[2], b = Number(match[3]);
    if (op === '+') answer = a + b;
    else if (op === '-') answer = a - b;
    else answer = a * b; // ×
  }

  // Intercepter /auth/captcha pour que la page reçoive le même id
  await page.route('**/api/auth/captcha', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cap) })
  );

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#captcha-question', { timeout: 15000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.fill('#captcha-answer', String(answer));
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard.html', { timeout: 35000 });

  await ctx.storageState({ path: AUTH_FILE });
  await browser.close();
}

// ── Fixture : page déjà connectée ────────────────────────────────
const authTest = test.extend({
  page: async ({ browser }, use) => {
    await ensureAuth();
    const ctx  = await browser.newContext({ storageState: AUTH_FILE, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

// ── Tests ─────────────────────────────────────────────────────────
authTest('topbar-01 — tba-caisse visible dès le chargement', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  await expect(page.locator('#tba-caisse')).toBeVisible({ timeout: 5000 });
});

authTest('topbar-02 — sélecteur mois = mois courant', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  const sel = page.locator('#sel-mois');
  await expect(sel).toBeVisible({ timeout: 5000 });
  expect(await sel.inputValue()).toBe(String(new Date().getMonth() + 1));
});

authTest('topbar-03 — sélecteur année = année courante', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  const sel = page.locator('#sel-annee');
  await expect(sel).toBeVisible({ timeout: 5000 });
  expect(await sel.inputValue()).toBe(String(new Date().getFullYear()));
});

authTest('topbar-04 — boutons Encaisser / Décaisser / Virement visibles', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  await expect(page.locator('#tba-caisse button', { hasText: 'Encaisser' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#tba-caisse button', { hasText: 'Décaisser' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#tba-caisse button', { hasText: 'Virement' })).toBeVisible({ timeout: 5000 });
});

authTest('topbar-05 — navigation Agents masque tba-caisse, affiche tba-rh', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  await page.click('a[data-page="agents"]');
  await page.waitForTimeout(400);
  await expect(page.locator('#tba-caisse')).toBeHidden({ timeout: 3000 });
  await expect(page.locator('#tba-rh')).toBeVisible({ timeout: 3000 });
});

authTest('topbar-06 — retour dashboard réaffiche tba-caisse', async ({ page }) => {
  await page.goto(BASE + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kpi-solde', { timeout: 20000 });
  await page.click('a[data-page="agents"]');
  await page.waitForTimeout(400);
  await page.click('a[data-page="dashboard"]');
  await page.waitForTimeout(400);
  await expect(page.locator('#tba-caisse')).toBeVisible({ timeout: 3000 });
});

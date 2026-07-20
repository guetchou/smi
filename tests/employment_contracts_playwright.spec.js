'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL || 'http://127.0.0.1:3338';
const screenshotDir = process.env.SMI_E2E_SCREENSHOT_DIR
  || path.join(__dirname, '..', 'reports', 'screenshots', 'employment-contracts');

function solve(question) {
  const match = String(question).match(/(\d+)\s*([+\-×])\s*(\d+)/);
  if (!match) throw new Error(`Captcha illisible: ${question}`);
  const left = Number(match[1]);
  const right = Number(match[3]);
  if (match[2] === '+') return left + right;
  if (match[2] === '-') return left - right;
  return left * right;
}

async function authenticate(request, identifier = 'admin@topcenter.cg', password = 'Admin@2025!') {
  const captchaResponse = await request.get(`${baseURL}/api/auth/captcha`);
  expect(captchaResponse.ok()).toBeTruthy();
  const captcha = await captchaResponse.json();
  const loginResponse = await request.post(`${baseURL}/api/auth/login`, {
    data: {
      identifier,
      password,
      captchaId: captcha.id,
      captchaAnswer: solve(captcha.question),
    },
  });
  expect(loginResponse.ok()).toBeTruthy();
  return loginResponse.json();
}

async function installSession(page, auth) {
  await page.addInitScript(session => {
    localStorage.setItem('tc_token', session.token);
    localStorage.setItem('tc_user', JSON.stringify(session.user));
    localStorage.setItem(`wl_shown_${session.user.id}`, '1');
  }, auth);
}

test.describe.serial('employment contracts workspace', () => {
  let auth;
  let validatorAuth;

  test.beforeAll(async ({ request }) => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    auth = await authenticate(request);
    validatorAuth = await authenticate(request, 'validator.e2e@topcenter.cg', 'Admin@2025!');
  });

  test('creates a controlled draft through the complete wizard', async ({ page, request }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 500) browserErrors.push(`${response.status()} ${response.url()}`); });
    await installSession(page, auth);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${baseURL}/app/rh/contrats-travail`);
    await expect(page.locator('.ec-heading').first()).toHaveText('Contrats de travail');
    await expect(page.locator('#ec-content')).not.toContainText('Chargement');

    await page.locator('[data-ec-create]').click();
    await expect(page.locator('#ec-dialog')).toBeVisible();
    const e2eAgentValue = await page.locator('#ec-agent option').filter({ hasText: 'E2E-001' }).getAttribute('value');
    expect(e2eAgentValue).toBeTruthy();
    await page.selectOption('#ec-agent', e2eAgentValue);
    await page.selectOption('#ec-template', { index: 1 });
    await page.selectOption('#ec-rules', { index: 1 });
    await page.fill('#ec-title', 'Contrat operateur E2E');
    await page.locator('#ec-next').click();
    await page.fill('#ec-start', '2026-07-02');
    await page.fill('#ec-job', 'Operateur');
    await page.fill('#ec-service', 'Operations');
    await page.fill('#ec-place', 'Brazzaville');
    await page.fill('#ec-hours', '40');
    await page.fill('#ec-schedule', '08:00 - 17:00');
    await page.locator('#ec-next').click();
    await expect(page.locator('#ec-base')).toHaveValue('150000');
    await expect(page.locator('#ec-save')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, 'wizard-1440.png'), fullPage: true });
    await page.locator('#ec-save').click();

    await expect(page.locator('#ec-dialog')).not.toBeVisible();
    await expect(page.locator('#ec-content')).toContainText('Contrat operateur E2E');
    await expect(page.locator('#ec-content')).toContainText('Brouillon');

    const createdRow = page.locator('.ec-table tbody tr').filter({ hasText: 'Contrat operateur E2E' }).first();
    const contractId = Number(await createdRow.locator('[data-ec-open]').getAttribute('data-ec-open'));
    expect(contractId).toBeGreaterThan(0);
    await createdRow.locator('[data-ec-open]').click();
    await page.locator('[data-ec-action="edit"]').click();
    await expect(page.locator('#ec-agent')).toBeDisabled();
    await page.fill('#ec-title', 'Contrat operateur E2E corrige');
    await page.locator('[data-ec-step="2"]').click();
    await page.fill('#ec-tasks', 'Traiter les demandes clients\nDocumenter les incidents');
    await page.locator('[data-ec-step="3"]').click();
    await page.fill('#ec-local-clause', 'Le teletravail necessite une autorisation ecrite.');
    await page.locator('#ec-save').click();
    await expect(page.locator('#ec-dialog')).not.toBeVisible();
    await expect(page.locator('#ec-content')).toContainText('Contrat operateur E2E corrige');

    const call = async (url, method = 'GET', authToken = auth.token) => {
      const response = await request.fetch(`${baseURL}${url}`, {
        method,
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        data: method === 'GET' ? undefined : {},
      });
      return { status: response.status(), data: await response.json().catch(() => ({})) };
    };
    const submitted = await call(`/api/employment-contracts/${contractId}/submit`, 'POST');
    const selfValidated = await call(`/api/employment-contracts/${contractId}/validate`, 'POST');
    const validated = await call(`/api/employment-contracts/${contractId}/validate`, 'POST', validatorAuth.token);
    const detail = await call(`/api/employment-contracts/${contractId}`);
    const docx = await call(`/api/employment-contracts/${contractId}/documents/docx`, 'POST');
    const pdf = await call(`/api/employment-contracts/${contractId}/documents/pdf`, 'POST');
    const inspectFile = async document => {
      expect(document.status, JSON.stringify(document.data)).toBe(201);
      expect(document.data.downloadUrl, JSON.stringify(document.data)).toMatch(/^\/api\/employment-contracts\//);
      const response = await request.get(`${baseURL}${document.data.downloadUrl}`, { headers: { Authorization: `Bearer ${auth.token}` } });
      const bytes = new Uint8Array(await response.body());
      return { status: response.status(), size: bytes.length, signature: Array.from(bytes.slice(0, 4)) };
    };
    const workflow = { submitted, selfValidated, validated, detail, docx, pdf, docxFile: await inspectFile(docx), pdfFile: await inspectFile(pdf) };
    expect(workflow.submitted.status).toBe(200);
    expect(workflow.selfValidated.status).toBe(409);
    expect(workflow.selfValidated.data.error).toContain('createur ne peut pas valider');
    expect(workflow.validated.status).toBe(200);
    expect(workflow.detail.data.values_snapshot._input.tasks).toEqual(['Traiter les demandes clients', 'Documenter les incidents']);
    expect(workflow.detail.data.clauses_snapshot.articles.at(-1).body).toBe('Le teletravail necessite une autorisation ecrite.');
    expect(workflow.docx.status).toBe(201);
    expect(workflow.pdf.status).toBe(201);
    expect(workflow.docxFile.signature.slice(0, 2)).toEqual([80, 75]);
    expect(workflow.pdfFile.signature).toEqual([37, 80, 68, 70]);
    expect(workflow.docxFile.size).toBeGreaterThan(1000);
    expect(workflow.pdfFile.size).toBeGreaterThan(1000);
    await page.locator('[data-ec-refresh]').click();
    await expect(page.locator('#ec-content')).toContainText('Valide');
    await page.screenshot({ path: path.join(screenshotDir, 'workspace-1440.png'), fullPage: true });
    expect(browserErrors).toEqual([]);
  });

  for (const width of [320, 768, 1024]) {
    test(`has no viewport overflow at ${width}px`, async ({ page }) => {
      const browserErrors = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      await installSession(page, auth);
      await page.setViewportSize({ width, height: width === 320 ? 720 : 850 });
      await page.goto(`${baseURL}/app/rh/contrats-travail`);
      await expect(page.locator('.ec-heading').first()).toHaveText('Contrats de travail');
      const dimensions = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        pageWidth: document.getElementById('page-employment-contracts')?.scrollWidth || 0,
      }));
      expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
      expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
      await page.screenshot({ path: path.join(screenshotDir, `workspace-${width}.png`), fullPage: true });
      expect(browserErrors).toEqual([]);
    });
  }
});

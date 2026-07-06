// @ts-check
/**
 * Finance E2E guard.
 *
 * This spec is intentionally executable only against a Docker/MySQL runtime.
 * It must not be used as evidence with local SQLite or Node 24/better-sqlite3.
 */
const { test, expect } = require('@playwright/test');
const mysql = require('../backend/node_modules/mysql2/promise');

const BASE = process.env.FINANCE_E2E_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3337';
const API = `${BASE.replace(/\/$/, '')}/api`;

const ADMIN_LOGIN = process.env.FINANCE_E2E_ADMIN_LOGIN || 'admin@topcenter.cg';
const ADMIN_PASSWORD = process.env.FINANCE_E2E_ADMIN_PASSWORD || 'Admin@2025!';
const FORBIDDEN_LOGIN = process.env.FINANCE_E2E_FORBIDDEN_LOGIN || '';
const FORBIDDEN_PASSWORD = process.env.FINANCE_E2E_FORBIDDEN_PASSWORD || '';

const REQUIRE_MYSQL = process.env.FINANCE_E2E_REQUIRE_MYSQL === '1';
const DB_DRIVER = String(process.env.DB_DRIVER || '').toLowerCase();

test.describe.configure({ mode: 'serial' });
test.skip(!REQUIRE_MYSQL, 'Set FINANCE_E2E_REQUIRE_MYSQL=1 to run the Docker/MySQL finance E2E guard.');

function requireMysqlRuntime() {
  if (DB_DRIVER !== 'mysql') {
    throw new Error('DB_DRIVER=mysql is required; SQLite/local runtime is not valid evidence.');
  }
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE || !process.env.MYSQL_USER) {
    throw new Error('MYSQL_HOST, MYSQL_DATABASE and MYSQL_USER are required for direct MySQL verification.');
  }
  if (!FORBIDDEN_LOGIN || !FORBIDDEN_PASSWORD) {
    throw new Error('FINANCE_E2E_FORBIDDEN_LOGIN and FINANCE_E2E_FORBIDDEN_PASSWORD are required for the 403 permission proof.');
  }
}

async function mysqlConnection() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE,
    timezone: 'Z',
  });
}

function solveCaptcha(question) {
  const match = String(question || '').match(/(\d+)\s*([+\-×x*])\s*(\d+)/);
  if (!match) throw new Error(`Unsupported captcha question: ${question}`);
  const left = Number(match[1]);
  const right = Number(match[3]);
  switch (match[2]) {
    case '+': return left + right;
    case '-': return left - right;
    case '×':
    case 'x':
    case '*': return left * right;
    default: throw new Error(`Unsupported captcha operator: ${match[2]}`);
  }
}

async function apiLogin(request, identifier, password) {
  const captcha = await request.get(`${API}/auth/captcha`);
  expect(captcha.status(), 'captcha endpoint').toBe(200);
  const challenge = await captcha.json();
  const login = await request.post(`${API}/auth/login`, {
    data: {
      identifier,
      password,
      captchaId: challenge.id,
      captchaAnswer: solveCaptcha(challenge.question),
    },
  });
  expect(login.status(), `login for ${identifier}`).toBe(200);
  const body = await login.json();
  expect(body.token).toBeTruthy();
  return body;
}

async function loginUi(page, identifier = ADMIN_LOGIN, password = ADMIN_PASSWORD) {
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 15000 });
  await page.fill('#email', identifier);
  await page.fill('#password', password);
  const question = await page.locator('#captcha-question').textContent({ timeout: 10000 });
  await page.fill('#captcha-answer', String(solveCaptcha(question)));
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 25000 }),
    page.click('#submit-btn'),
  ]);
  await page.waitForSelector('#kpi-solde', { timeout: 25000 });
}

async function authHeaders(request, identifier = ADMIN_LOGIN, password = ADMIN_PASSWORD) {
  const session = await apiLogin(request, identifier, password);
  return {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
  };
}

async function chooseFirstRealOption(page, selector) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && Array.from(el.options).some((option) => option.value);
  }, selector);
  const value = await page.$eval(selector, (el) => Array.from(el.options).find((option) => option.value)?.value || '');
  expect(value, `first option for ${selector}`).toBeTruthy();
  await page.selectOption(selector, value);
  return value;
}

async function operationFromApi(request, headers, id) {
  const response = await request.get(`${API}/operations?limit=1000`, { headers });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.rows || payload.operations || [];
  const found = rows.find((row) => Number(row.id) === Number(id));
  expect(found, `operation ${id} returned by /api/operations`).toBeTruthy();
  return found;
}

async function auditOrNotificationExists(connection, operationId) {
  const [audits] = await connection.execute(
    'SELECT id, action FROM audit_logs WHERE table_name = ? AND record_id = ? ORDER BY id DESC LIMIT 5',
    ['operations', operationId],
  );
  if (audits.length > 0) return { source: 'audit_logs', rows: audits };

  const [notifications] = await connection.execute(
    `SELECT id, type, titre
     FROM notif_messages
     WHERE src_table = ? AND src_id = ?
     ORDER BY id DESC LIMIT 5`,
    ['operations', operationId],
  );
  return notifications.length > 0 ? { source: 'notif_messages', rows: notifications } : null;
}

test('finance encaissement and decaissement permissions are guarded on Docker/MySQL', async ({ page, request }) => {
  requireMysqlRuntime();

  const connection = await mysqlConnection();
  try {
    const [driverRows] = await connection.execute('SELECT DATABASE() AS db_name, VERSION() AS mysql_version');
    expect(driverRows[0].db_name).toBe(process.env.MYSQL_DATABASE);
    expect(String(driverRows[0].mysql_version)).toMatch(/\d+\.\d+/);

    await loginUi(page);
    const adminHeaders = await authHeaders(request);

    await page.click('[onclick="showPage(\'operations\')"]');
    await page.click('[onclick="openEncaissementModal()"]:visible');
    await expect(page.locator('#modal-encaissement')).not.toHaveClass(/hidden/, { timeout: 10000 });

    const encLabel = `PW ENC MYSQL ${Date.now()}`;
    await page.fill('#enc-tiers', 'Client Playwright MySQL');
    await page.fill('#enc-libelle', encLabel);
    await page.fill('#enc-montant', '12345');
    await chooseFirstRealOption(page, '#enc-rubrique');
    await chooseFirstRealOption(page, '#enc-position');
    await page.selectOption('#enc-mode', 'especes');

    const encPost = page.waitForResponse((response) =>
      response.url().endsWith('/api/operations')
        && response.request().method() === 'POST',
      { timeout: 15000 },
    );
    await page.click('#enc-submit');
    const encResponse = await encPost;
    expect(encResponse.status(), 'UI encaissement POST /api/operations').toBe(201);
    const encBody = await encResponse.json();
    expect(encBody.id).toBeTruthy();
    expect(encBody.type_op).toBe('encaissement');

    const [encRows] = await connection.execute(
      'SELECT id, type_op, libelle, montant, statut, created_by FROM operations WHERE id = ?',
      [encBody.id],
    );
    expect(encRows).toHaveLength(1);
    expect(encRows[0].libelle).toBe(encLabel);
    expect(Number(encRows[0].montant)).toBe(12345);

    const encApi = await operationFromApi(request, adminHeaders, encBody.id);
    expect(encApi.libelle || encApi.detail).toBe(encLabel);

    await expect.poll(async () => auditOrNotificationExists(connection, encBody.id), {
      timeout: 5000,
      message: 'encaissement should create an audit event or notification',
    }).not.toBeNull();

    await page.click('[onclick="openDecaissementModal()"]:visible');
    await expect(page.locator('#modal-decaissement')).not.toHaveClass(/hidden/, { timeout: 10000 });

    const decLabel = `PW DEC MYSQL ${Date.now()}`;
    await page.selectOption('#dec-benef-type', 'autre');
    await page.fill('#dec-tiers', 'Fournisseur Playwright MySQL');
    await page.fill('#dec-libelle', decLabel);
    await page.fill('#dec-montant', '1000');
    await chooseFirstRealOption(page, '#dec-rubrique');
    await chooseFirstRealOption(page, '#dec-position');
    await page.selectOption('#dec-mode', 'especes');

    const decPost = page.waitForResponse((response) =>
      response.url().endsWith('/api/operations')
        && response.request().method() === 'POST',
      { timeout: 15000 },
    );
    await page.click('#dec-submit');
    const decResponse = await decPost;
    expect(decResponse.status(), 'UI decaissement POST /api/operations').toBe(201);
    const decBody = await decResponse.json();
    expect(decBody.id).toBeTruthy();
    expect(decBody.type_op).toBe('decaissement');

    const [decRows] = await connection.execute(
      `SELECT id, type_op, libelle, montant, statut, dec_statut, created_by, submitted_by, validated_by, categorie_id, position_id
       FROM operations WHERE id = ?`,
      [decBody.id],
    );
    expect(decRows).toHaveLength(1);
    expect(decRows[0].libelle).toBe(decLabel);
    expect(decRows[0].statut).toBe('en_attente');
    expect(decRows[0].dec_statut).toBe('brouillon');

    const submit = await request.put(`${API}/operations/${decBody.id}/soumettre`, {
      headers: adminHeaders,
      data: {},
    });
    expect(submit.status(), 'creator submit decaissement').toBe(200);

    const [afterSubmitRows] = await connection.execute(
      'SELECT dec_statut, created_by, submitted_by, validated_by FROM operations WHERE id = ?',
      [decBody.id],
    );
    expect(afterSubmitRows[0].dec_statut).toBe('soumis');
    expect(Number(afterSubmitRows[0].created_by)).toBe(Number(afterSubmitRows[0].submitted_by));
    expect(afterSubmitRows[0].validated_by).toBeNull();

    const selfApprove = await request.put(`${API}/operations/${decBody.id}/valider`, {
      headers: adminHeaders,
      data: {},
    });
    expect(selfApprove.status(), 'creator/submitter cannot approve own decaissement').toBe(409);
    const selfApproveBody = await selfApprove.json();
    expect(selfApproveBody.code).toBe('CASH_OUT_SELF_APPROVAL_FORBIDDEN');

    const forbiddenHeaders = await authHeaders(request, FORBIDDEN_LOGIN, FORBIDDEN_PASSWORD);
    const forbidden = await request.post(`${API}/operations`, {
      headers: forbiddenHeaders,
      data: {
        type_op: 'decaissement',
        date: new Date().toISOString().slice(0, 10),
        libelle: `PW FORBIDDEN DEC ${Date.now()}`,
        tiers: 'Forbidden actor',
        montant: 1000,
        categorie_id: decRows[0].categorie_id || undefined,
        position_id: decRows[0].position_id || undefined,
        mode_reglement: 'especes',
      },
    });
    expect(forbidden.status(), 'non authorized user cannot create decaissement').toBe(403);
  } finally {
    await connection.end();
  }
});

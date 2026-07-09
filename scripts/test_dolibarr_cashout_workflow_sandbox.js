#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const bcrypt = require(path.join(PROJECT_DIR, 'backend', 'node_modules', 'bcryptjs'));

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited before health check: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError || new Error('Backend health check timeout');
}

async function readJson(res, label) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error(`${label} failed HTTP ${res.status}: ${body ? JSON.stringify(body) : text}`);
  return body;
}

function solveCaptcha(question) {
  const match = String(question || '').match(/(\d+)\s*([+\-x*])\s*(\d+)/i);
  if (!match) throw new Error(`Unsupported captcha question: ${question}`);
  const left = Number(match[1]);
  const right = Number(match[3]);
  const op = match[2].toLowerCase();
  if (op === '+') return left + right;
  if (op === '-') return left - right;
  return left * right;
}

async function login(baseUrl, email, password) {
  const captcha = await readJson(await fetch(`${baseUrl}/api/auth/captcha`), 'captcha');
  const auth = await readJson(await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      captchaId: captcha.id,
      captchaAnswer: solveCaptcha(captcha.question.replace('×', 'x')),
    }),
  }), `login ${email}`);
  assert(auth.token, `token expected for ${email}`);
  return auth.token;
}

async function api(baseUrl, token, method, route, payload) {
  return readJson(await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), `${method} ${route}`);
}

async function apiRaw(baseUrl, token, method, route, payload) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: res.status, body, text };
}

async function queryTempLinks(dbPath, operationId) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = dbPath;
  for (const modulePath of [
    path.join(PROJECT_DIR, 'backend', 'db.js'),
    path.join(PROJECT_DIR, 'backend', 'database.js'),
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
  const rows = await db.query(`
    SELECT *
    FROM integration_links
    WHERE provider='dolibarr' AND local_type IN ('operation', 'operation_tiers') AND local_id=?
    ORDER BY id
  `, [operationId]);
  if (db._raw?.close) db._raw.close();
  return rows;
}

async function queryTempIntegrationEvidence(dbPath, jobId, operationId) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = dbPath;
  for (const modulePath of [
    path.join(PROJECT_DIR, 'backend', 'db.js'),
    path.join(PROJECT_DIR, 'backend', 'database.js'),
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
  const job = await db.queryOne('SELECT * FROM integration_jobs WHERE id=?', [jobId]);
  const attempts = await db.query('SELECT * FROM integration_attempts WHERE job_id=? ORDER BY id', [jobId]);
  const links = await db.query(`
    SELECT *
    FROM integration_links
    WHERE provider='dolibarr' AND local_type IN ('operation', 'operation_tiers') AND local_id=?
    ORDER BY id
  `, [operationId]);
  if (db._raw?.close) db._raw.close();
  return { job, attempts, links };
}

async function seedTempDb(dbPath) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dolibarr-workflow-secret-123456789012345';

  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
  const hash = bcrypt.hashSync('Workflow@2026!', 10);

  async function ensureColumn(table, column, definition) {
    const columns = await db.query(`PRAGMA table_info(${table})`);
    if (!columns.some(existing => existing.name === column)) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  await ensureColumn('operations', 'business_status', "TEXT NOT NULL DEFAULT 'draft'");
  await ensureColumn('operations', 'approval_status', "TEXT NOT NULL DEFAULT 'draft'");
  await ensureColumn('operations', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'");
  await ensureColumn('operations', 'reconciliation_status', "TEXT NOT NULL DEFAULT 'pending'");
  await ensureColumn('cash_ledger', 'leg_code', 'TEXT DEFAULT NULL');
  const positionColumns = await db.query('PRAGMA table_info(positions)');
  if (!positionColumns.some(column => column.name === 'ledger_status')) {
    await db.execute("ALTER TABLE positions ADD COLUMN ledger_status TEXT NOT NULL DEFAULT 'legacy'");
  }

  await db.execute(`
    INSERT INTO users (nom, email, password_hash, role, actif, roles)
    VALUES (?, ?, ?, 'admin', 1, ?)
  `, ['Workflow Approver', 'workflow.approver@local.test', hash, JSON.stringify(['admin'])]);
  await db.execute(`
    UPDATE positions
    SET ledger_status = 'ready', solde_initial = 1000000
    WHERE id = 1
  `);
  await db.execute(`
    INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at)
    VALUES (1, 1000000, NULL, datetime('now'))
    ON CONFLICT(caisse_id) DO UPDATE SET
      solde_courant = excluded.solde_courant,
      derniere_operation_id = excluded.derniere_operation_id,
      updated_at = excluded.updated_at
  `);

  const category = await db.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('depense', 'decaissement') AND actif = 1
    ORDER BY id
    LIMIT 1
  `);
  assert(category?.id, 'expense category expected');

  if (db._raw?.close) db._raw.close();
  return { categoryId: Number(category.id) };
}

async function main() {
  loadEnv();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolibarr-cashout-e2e-'));
  const dbPath = path.join(tmpDir, 'caisse-workflow.db');
  const { categoryId } = await seedTempDb(dbPath);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'backend', 'server.js')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      DB_DRIVER: 'sqlite',
      DB_PATH: dbPath,
      PORT: String(port),
      DOLIBARR_ENABLED: 'true',
      DOLIBARR_ALLOW_LOCAL: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  try {
    await waitForServer(baseUrl, child);
    const makerToken = await login(baseUrl, 'admin@topcenter.cg', 'Admin@2025!');
    const approverToken = await login(baseUrl, 'workflow.approver@local.test', 'Workflow@2026!');

    const status = await api(baseUrl, approverToken, 'GET', '/api/integrations/dolibarr/status');
    assert.strictEqual(status.ready, true, 'Dolibarr integration status must be ready');
    assert.strictEqual(status.config.apiKeyConfigured, true, 'Dolibarr API key must be configured');
    assert(!JSON.stringify(status).includes(process.env.DOLIBARR_API_KEY || '__unset__'), 'status response must not expose API key');

    const connection = await api(baseUrl, approverToken, 'POST', '/api/integrations/dolibarr/test', {});
    assert.strictEqual(connection.ok, true, 'Dolibarr /test endpoint must succeed');
    assert(!JSON.stringify(connection).includes(process.env.DOLIBARR_API_KEY || '__unset__'), 'test response must not expose API key');

    const ref = `TALA-SANDBOX-WORKFLOW-${Date.now()}`;
    const created = await api(baseUrl, makerToken, 'POST', '/api/operations', {
      date: '2026-07-09',
      num_piece: ref,
      libelle: `Workflow decaissement Dolibarr sandbox ${ref}`,
      tiers: 'TALA-SANDBOX-WORKFLOW-SUPPLIER',
      montant: 2200,
      type_op: 'decaissement',
      position_id: 1,
      categorie_id: categoryId,
      mode_reglement: 'virement_bancaire',
      ref_externe: ref,
      decharge_signee: 1,
    });
    assert.strictEqual(created.dec_statut, 'brouillon');

    const submitted = await api(baseUrl, makerToken, 'PUT', `/api/operations/${created.id}/soumettre`, {});
    assert.strictEqual(submitted.dec_statut, 'soumis');

    const validated = await api(baseUrl, approverToken, 'PUT', `/api/operations/${created.id}/valider`, {});
    assert.strictEqual(validated.dec_statut, 'valide');

    const paid = await api(baseUrl, approverToken, 'POST', `/api/operations/${created.id}/payer`, {});
    assert.strictEqual(paid.dec_statut, 'paye');
    assert(Array.isArray(paid.ledger_ids) && paid.ledger_ids.length === 1, 'ledger id expected');

    const jobs = await api(baseUrl, approverToken, 'GET', `/api/integrations/dolibarr/jobs?local_type=operation&local_id=${created.id}`);
    const jobRows = Array.isArray(jobs) ? jobs : jobs.jobs || [];
    const job = jobRows.find(row => Number(row.local_id) === Number(created.id));
    assert(job, 'Dolibarr job expected after payment');
    assert.strictEqual(job.status, 'pending');

    const synced = await api(baseUrl, approverToken, 'POST', `/api/integrations/dolibarr/jobs/${job.id}/retry`, {});
    assert.strictEqual(synced.status, 'synced');

    const secondRetry = await apiRaw(baseUrl, approverToken, 'POST', `/api/integrations/dolibarr/jobs/${job.id}/retry`, {});
    assert.strictEqual(secondRetry.status, 409, 'retrying an already synced job must be refused');
    assert.strictEqual(secondRetry.body && secondRetry.body.code, 'JOB_NOT_RETRYABLE');

    const linkRows = await queryTempLinks(dbPath, created.id);
    const operationLink = linkRows.find(row => row.remote_type === 'bank_account_line');
    const thirdpartyLink = linkRows.find(row => row.remote_type === 'thirdparty');
    assert(operationLink, 'bank account line link expected');
    assert(thirdpartyLink, 'thirdparty link expected');

    const evidence = await queryTempIntegrationEvidence(dbPath, job.id, created.id);
    assert.strictEqual(evidence.job.status, 'synced');
    assert.strictEqual(evidence.job.attempts_count, 1, 'synced job must not increment attempts on refused second retry');
    assert.strictEqual(evidence.attempts.length, 2, 'thirdparty and bank line attempts expected');
    assert(evidence.attempts.every(row => Number(row.success) === 1), 'all sandbox attempts must be successful');
    assert.strictEqual(evidence.links.length, 2, 'exactly two links expected for operation and thirdparty');

    console.log(JSON.stringify({
      ok: true,
      httpWorkflow: ['status', 'test', 'create', 'submit', 'validate', 'pay', 'job_retry', 'double_retry_refused'],
      tempDb: dbPath,
      operation: {
        id: created.id,
        num_piece: ref,
        dec_statut: 'paye',
        amount: 2200,
      },
      dolibarrJob: {
        id: synced.id,
        status: synced.status,
        attempts_count: synced.attempts_count,
      },
      attempts: {
        total: evidence.attempts.length,
        success: evidence.attempts.filter(row => Number(row.success) === 1).length,
      },
      links: {
        thirdparty: { remote_type: thirdpartyLink.remote_type, remote_id: thirdpartyLink.remote_id },
        operation: {
          remote_type: operationLink.remote_type,
          remote_id: operationLink.remote_id,
          remote_ref: operationLink.remote_ref,
        },
      },
      serverPort: port,
      secretsPrinted: false,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, backendStderr: stderr, secretsPrinted: false }));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
}

main();

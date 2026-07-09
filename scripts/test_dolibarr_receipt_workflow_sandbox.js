#!/usr/bin/env node
'use strict';

const assert = require('assert');
const bcrypt = require('../backend/node_modules/bcryptjs');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
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
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited before health check: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Backend health check timeout');
}

async function readJson(res, label) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error(`${label} failed HTTP ${res.status}: ${body ? JSON.stringify(body) : text}`);
  return body;
}

function solveCaptcha(question) {
  const match = String(question || '').replace('×', 'x').match(/(\d+)\s*([+\-x*])\s*(\d+)/i);
  if (!match) throw new Error(`Unsupported captcha question: ${question}`);
  const left = Number(match[1]);
  const right = Number(match[3]);
  if (match[2] === '+') return left + right;
  if (match[2] === '-') return left - right;
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
      captchaAnswer: solveCaptcha(captcha.question),
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

async function seedTempDb(dbPath) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dolibarr-receipt-secret-123456789012345';

  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
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
  await ensureColumn('positions', 'ledger_status', "TEXT NOT NULL DEFAULT 'legacy'");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS finance_workflow_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      description TEXT,
      updated_by INTEGER,
      updated_at TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS finance_operation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      previous_status TEXT,
      next_status TEXT,
      reason TEXT,
      metadata_json TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const hash = bcrypt.hashSync('Workflow@2026!', 10);
  await db.execute(`
    INSERT INTO users (nom, email, password_hash, role, actif, roles)
    VALUES (?, ?, ?, 'admin', 1, ?)
  `, ['Receipt Approver', 'receipt.approver@local.test', hash, JSON.stringify(['admin'])]);
  await db.execute("UPDATE positions SET ledger_status='ready', solde_initial=1000000 WHERE id=1");
  await db.execute(`
    INSERT INTO cashbox_balances (caisse_id, solde_courant, derniere_operation_id, updated_at)
    VALUES (1, 1000000, NULL, datetime('now'))
    ON CONFLICT(caisse_id) DO UPDATE SET
      solde_courant=excluded.solde_courant,
      derniere_operation_id=excluded.derniere_operation_id,
      updated_at=excluded.updated_at
  `);
  await db.execute(`
    INSERT INTO finance_workflow_settings (setting_key, setting_value, description, updated_by, updated_at)
    VALUES ('cash_receipt_attachment_threshold', '999999999', 'sandbox receipt test', 1, datetime('now'))
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at
  `);

  const category = await db.queryOne(`
    SELECT id FROM categories
    WHERE type IN ('recette', 'encaissement') AND actif = 1
    ORDER BY id
    LIMIT 1
  `);
  assert(category?.id, 'receipt category expected');
  if (db._raw?.close) db._raw.close();
  return { categoryId: Number(category.id) };
}

async function queryEvidence(dbPath, jobId, operationId) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = dbPath;
  for (const modulePath of [
    path.join(PROJECT_DIR, 'backend', 'db.js'),
    path.join(PROJECT_DIR, 'backend', 'database.js'),
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
  const operation = await db.queryOne('SELECT * FROM operations WHERE id=?', [operationId]);
  const job = await db.queryOne('SELECT * FROM integration_jobs WHERE id=?', [jobId]);
  const attempts = await db.query('SELECT * FROM integration_attempts WHERE job_id=? ORDER BY id', [jobId]);
  const links = await db.query(`
    SELECT * FROM integration_links
    WHERE provider='dolibarr' AND local_type IN ('operation', 'operation_tiers') AND local_id=?
    ORDER BY id
  `, [operationId]);
  if (db._raw?.close) db._raw.close();
  return { operation, job, attempts, links };
}

async function main() {
  loadEnv();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolibarr-receipt-e2e-'));
  const dbPath = path.join(tmpDir, 'caisse-receipt.db');
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
    const approverToken = await login(baseUrl, 'receipt.approver@local.test', 'Workflow@2026!');
    const ref = `TALA-SANDBOX-RECEIPT-${Date.now()}`;

    const created = await api(baseUrl, makerToken, 'POST', '/api/operations', {
      date: '2026-07-09',
      num_piece: ref,
      libelle: `Workflow encaissement Dolibarr sandbox ${ref}`,
      tiers: 'TALA-SANDBOX-CLIENT-RECEIPT',
      montant: 3200,
      type_op: 'encaissement',
      position_id: 1,
      categorie_id: categoryId,
      mode_reglement: 'virement_bancaire',
      ref_externe: ref,
    });
    assert.strictEqual(created.workflow, 'cash_receipt_controlled');
    assert.strictEqual(created.business_status, 'draft');

    const submitted = await api(baseUrl, makerToken, 'PUT', `/api/operations/encaissements/${created.id}/soumettre`, {});
    assert.strictEqual(submitted.operation.business_status, 'submitted');

    const validated = await api(baseUrl, approverToken, 'PUT', `/api/operations/encaissements/${created.id}/valider`, {});
    assert.strictEqual(validated.operation.business_status, 'validated');

    const confirmed = await api(baseUrl, approverToken, 'POST', `/api/operations/encaissements/${created.id}/confirmer`, {});
    assert.strictEqual(confirmed.operation.business_status, 'confirmed');
    assert.strictEqual(confirmed.operation.statut, 'valide');
    assert(Array.isArray(confirmed.ledger_ids) && confirmed.ledger_ids.length === 1, 'ledger id expected');

    const jobs = await api(baseUrl, approverToken, 'GET', '/api/integrations/dolibarr/jobs');
    const job = jobs.find(row => Number(row.local_id) === Number(created.id) && row.job_type === 'export_customer_payment');
    assert(job, 'Dolibarr receipt job expected');
    assert.strictEqual(job.status, 'pending');

    const synced = await api(baseUrl, approverToken, 'POST', `/api/integrations/dolibarr/jobs/${job.id}/retry`, {});
    assert.strictEqual(synced.status, 'synced');

    const evidence = await queryEvidence(dbPath, job.id, created.id);
    assert.strictEqual(evidence.operation.business_status, 'confirmed');
    assert.strictEqual(evidence.operation.payment_status, 'paid');
    assert.strictEqual(evidence.job.status, 'synced');
    assert.strictEqual(evidence.attempts.length, 2);
    assert(evidence.attempts.every(row => Number(row.success) === 1));
    const operationLink = evidence.links.find(row => row.remote_type === 'bank_account_line');
    const thirdpartyLink = evidence.links.find(row => row.remote_type === 'thirdparty');
    assert(operationLink, 'bank line link expected');
    assert(thirdpartyLink, 'thirdparty link expected');

    console.log(JSON.stringify({
      ok: true,
      httpWorkflow: ['create', 'submit', 'validate', 'confirm', 'job_retry'],
      tempDb: dbPath,
      operation: {
        id: created.id,
        num_piece: ref,
        business_status: evidence.operation.business_status,
        payment_status: evidence.operation.payment_status,
        amount: 3200,
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

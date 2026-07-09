#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');

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

async function main() {
  loadEnv();
  process.env.DB_DRIVER = 'sqlite';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dolibarr-supplier-secret-123456789012345';

  const db = require(path.join(PROJECT_DIR, 'backend', 'db'));
  const { loadDolibarrConfig } = require(path.join(PROJECT_DIR, 'backend', 'services', 'dolibarr_config'));
  const { createDolibarrClient } = require(path.join(PROJECT_DIR, 'backend', 'services', 'dolibarr_client'));
  const { createDolibarrIntegrationService } = require(path.join(PROJECT_DIR, 'backend', 'services', 'dolibarr_integration'));

  const ref = `TALA-SANDBOX-SUPPLIER-${Date.now()}`;
  const insert = await db.execute(`
    INSERT INTO operations
      (date, num_piece, libelle, tiers, montant, type_op, position_id, categorie_id, mode_reglement, ref_externe, created_by, statut, dec_statut)
    VALUES (?, ?, ?, ?, ?, 'decaissement', 1, 1, 'virement_bancaire', ?, 1, 'valide', 'paye')
  `, [
    '2026-07-09',
    ref,
    `Paiement fournisseur Dolibarr sandbox ${ref}`,
    'TALA-SANDBOX-SUPPLIER-BANKLINE',
    1800,
    ref,
  ]);

  const operationId = Number(insert.insertId);
  assert(operationId > 0, 'operation id expected');

  const config = loadDolibarrConfig(process.env, { allowLocal: true });
  const client = createDolibarrClient(config);
  const service = createDolibarrIntegrationService({ db, client, config });

  const job = await service.enqueueSync('operation', operationId, 'export_supplier_payment', { id: 1 });
  const synced = await service.runJob(job.id, { id: 1 });
  assert.strictEqual(synced.status, 'synced', JSON.stringify(synced));

  const thirdpartyLink = await service.findExistingLink('dolibarr', 'operation_tiers', operationId);
  const operationLink = await service.findExistingLink('dolibarr', 'operation', operationId);
  assert(thirdpartyLink, 'thirdparty link expected');
  assert(operationLink, 'operation link expected');
  assert.strictEqual(thirdpartyLink.remote_type, 'thirdparty');
  assert.strictEqual(operationLink.remote_type, 'bank_account_line');

  console.log(JSON.stringify({
    ok: true,
    operation: { id: operationId, num_piece: ref, type_op: 'decaissement', dec_statut: 'paye' },
    job: { id: synced.id, status: synced.status, attempts_count: synced.attempts_count },
    thirdpartyLink: { remote_type: thirdpartyLink.remote_type, remote_id: thirdpartyLink.remote_id },
    operationLink: {
      remote_type: operationLink.remote_type,
      remote_id: operationLink.remote_id,
      remote_ref: operationLink.remote_ref,
    },
    secretsPrinted: false,
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message, secretsPrinted: false }));
  process.exit(1);
});

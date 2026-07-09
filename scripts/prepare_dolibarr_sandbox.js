#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const DB_CONTAINER = process.env.DOLIBARR_SANDBOX_DB_CONTAINER || 'dolibarr-sandbox-db';
const DB_NAME = process.env.DOLIBARR_SANDBOX_DB_NAME || 'dolibarr_sandbox';
const DB_USER = process.env.DOLIBARR_SANDBOX_DB_USER || 'dolibarr_user';
const API_USER = process.env.DOLIBARR_SANDBOX_API_LOGIN || 'smi_api';
const BANK_REF = process.env.DOLIBARR_SANDBOX_BANK_REF || 'TALA-SMI';

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

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mysql(sql) {
  const password = requireEnv('DOLIBARR_SANDBOX_DB_PASSWORD');
  const output = execFileSync('docker', [
    'exec',
    DB_CONTAINER,
    'mariadb',
    `-u${DB_USER}`,
    `-p${password}`,
    DB_NAME,
    '-N',
    '-B',
    '-e',
    sql,
  ], { encoding: 'utf8' });
  return output.trim();
}

async function api(resource, { method = 'GET', body = null } = {}) {
  const baseUrl = requireEnv('DOLIBARR_BASE_URL').replace(/\/+$/, '');
  const apiKey = requireEnv('DOLIBARR_API_KEY');
  const response = await fetch(`${baseUrl}/api/index.php/${resource.replace(/^\/+/, '')}`, {
    method,
    headers: {
      Accept: 'application/json',
      DOLAPIKEY: apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : text || `HTTP ${response.status}`;
    throw new Error(`Dolibarr API ${method} ${resource} failed: ${response.status} ${message}`);
  }
  return data;
}

function updateEnvKey(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) content = content.replace(regex, line);
  else content = `${content.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}
  process.env[key] = String(value);
}

function upsertDolibarrModulesAndRights() {
  mysql(`
START TRANSACTION;
INSERT INTO llx_const (name, entity, value, type, visible, note) VALUES
  ('MAIN_MODULE_API',0,'1','string',0,'Enabled for SMI sandbox integration'),
  ('MAIN_MODULE_USER',0,'1','string',0,'Enabled for SMI sandbox integration'),
  ('MAIN_MODULE_SOCIETE',0,'1','string',0,'Enabled for SMI sandbox thirdparties'),
  ('MAIN_MODULE_FACTURE',0,'1','string',0,'Enabled for SMI sandbox invoice/payment compatibility'),
  ('MAIN_MODULE_BANQUE',0,'1','string',0,'Enabled for SMI sandbox bank lines'),
  ('MAIN_MODULE_FOURNISSEUR',0,'1','string',0,'Enabled for SMI sandbox supplier flows')
ON DUPLICATE KEY UPDATE value='1', type='string', visible=0;

INSERT IGNORE INTO llx_rights_def (id, entity, libelle, module, module_position, family_position, perms, subperms, type, bydefault, enabled) VALUES
  (11,1,'Read invoices','facture',30,0,'lire',NULL,'a',0,'1'),
  (12,1,'Create and update invoices','facture',30,0,'creer',NULL,'a',0,'1'),
  (16,1,'Issue payments on invoices','facture',30,0,'paiement',NULL,'a',0,'1'),
  (111,1,'Read bank account and transactions','banque',85,0,'lire',NULL,'r',0,'1'),
  (112,1,'Create/update/delete bank transactions','banque',85,0,'modifier',NULL,'w',0,'1'),
  (113,1,'Configure bank accounts','banque',85,0,'configurer',NULL,'a',0,'1'),
  (121,1,'Read third parties','societe',1,0,'lire',NULL,'r',0,'1'),
  (122,1,'Create and update third parties','societe',1,0,'creer',NULL,'w',0,'1'),
  (262,1,'Read all third parties','societe',1,0,'client','voir','r',0,'1'),
  (1181,1,'Read suppliers','fournisseur',40,0,'lire',NULL,'r',0,'1'),
  (1231,1,'Read supplier invoices','fournisseur',40,0,'facture','lire','r',0,'1'),
  (1232,1,'Create supplier invoices','fournisseur',40,0,'facture','creer','w',0,'1');

INSERT IGNORE INTO llx_user_rights (entity, fk_user, fk_id)
SELECT e.entity, u.rowid, r.fk_id
FROM llx_user u
JOIN (
  SELECT 11 fk_id UNION SELECT 12 UNION SELECT 16 UNION SELECT 111 UNION SELECT 112 UNION SELECT 113
  UNION SELECT 121 UNION SELECT 122 UNION SELECT 262 UNION SELECT 1181 UNION SELECT 1231 UNION SELECT 1232
) r
JOIN (SELECT 0 entity UNION SELECT 1 entity) e
WHERE u.login='${API_USER.replace(/'/g, "''")}';
COMMIT;
`);
}

async function ensureBankAccount() {
  const existing = mysql(`SELECT rowid FROM llx_bank_account WHERE ref='${BANK_REF.replace(/'/g, "''")}' LIMIT 1;`);
  if (existing) return Number(existing.split(/\s+/)[0]);

  const created = await api('bankaccounts', {
    method: 'POST',
    body: {
      ref: BANK_REF,
      label: 'TALA SMI Sandbox Cash',
      type: 0,
      currency_code: 'XAF',
      country_id: 1,
      bank: 'TALA SMI Sandbox',
      number: 'TALA-SANDBOX',
      comment: 'Compte cible sandbox pour export operations Tala SMI',
    },
  });
  const id = Number(created && typeof created === 'object' ? (created.id || created.rowid) : created);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Dolibarr bank account creation returned no numeric id');
  return id;
}

async function main() {
  loadEnv();
  requireEnv('DOLIBARR_SANDBOX_DB_PASSWORD');
  requireEnv('DOLIBARR_BASE_URL');
  requireEnv('DOLIBARR_API_KEY');

  upsertDolibarrModulesAndRights();
  const bankAccountId = await ensureBankAccount();
  updateEnvKey('DOLIBARR_BANK_ACCOUNT_ID', bankAccountId);

  console.log(JSON.stringify({
    ok: true,
    dolibarrSandboxPrepared: true,
    apiUser: API_USER,
    bankAccountRef: BANK_REF,
    bankAccountId,
    secretsPrinted: false,
  }));
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    secretsPrinted: false,
  }));
  process.exit(1);
});

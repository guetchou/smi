'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3338);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-employment-contracts-'));
const dbPath = path.join(tempDir, 'smi-test.db');
const documentRoot = path.join(tempDir, 'documents');
const screenshotDir = path.join(tempDir, 'screenshots');
const logPath = path.join(tempDir, 'server.log');
const baseURL = `http://127.0.0.1:${port}`;
const systemChrome = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(candidate => fs.existsSync(candidate));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_DRIVER: 'sqlite',
  DB_PATH: dbPath,
  EMPLOYMENT_CONTRACT_DOCUMENT_ROOT: documentRoot,
  SMI_E2E_BASE_URL: baseURL,
  SMI_E2E_SCREENSHOT_DIR: screenshotDir,
};
if (!env.PLAYWRIGHT_CHROME_PATH && systemChrome) env.PLAYWRIGHT_CHROME_PATH = systemChrome;

let server;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertPortFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(`Port E2E ${port} indisponible: ${error.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function seedDatabase() {
  Object.assign(process.env, env);
  const db = require('../backend/database');
  const model = JSON.parse(fs.readFileSync(path.join(root, 'backend/templates/employment-contract-national.json'), 'utf8'));
  const admin = db.prepare("SELECT id,password_hash FROM users WHERE email='admin@topcenter.cg'").get();

  db.prepare(`
    INSERT INTO users (nom,prenom,email,login_identifier,password_hash,role,roles,actif)
    VALUES ('Validateur','E2E','validator.e2e@topcenter.cg','validator.e2e@topcenter.cg',?,'admin','["admin"]',1)
  `).run(admin.password_hash);
  db.prepare(`
    UPDATE entreprise SET raison_sociale='TOP CENTER E2E',forme_juridique='SARL',rccm='E2E-RCCM',
      nif='E2E-NIF',adresse='Brazzaville',telephone='+242000000000',email='e2e@topcenter.cg',
      directeur_general='Validateur E2E',actif=1
  `).run();
  db.prepare(`
    INSERT INTO employes
      (nom,prenom,poste,type,salaire_base,email,telephone,actif,matricule,sexe,date_naissance,
       lieu_naissance,nationalite,adresse,num_piece_identite,type_contrat,statut_dossier,
       prime_transport,prime_logement)
    VALUES
      ('Agent','Contrat','Operateur','permanent',150000,'agent.e2e@topcenter.cg','+242000000001',1,
       'E2E-001','M','1989-04-05','Brazzaville','Congolaise','Brazzaville','E2E-ID','CDD','actif',20000,0)
  `).run();
  const template = db.prepare(`
    INSERT INTO employment_contract_templates (code,nom,type_contrat,created_by)
    VALUES (?,?,?,?)
  `).run(model.code, `${model.name} E2E`, model.contractType, admin.id);
  db.prepare(`
    INSERT INTO employment_contract_template_versions
      (template_id,version,statut,titre,content_json,header_json,footer_json,variable_catalog_json,
       source_docx_name,source_docx_sha256,published_by,published_at,created_by)
    VALUES (?,1,'publie',?,?,?,?,?,?,?, ?,datetime('now'),?)
  `).run(
    template.lastInsertRowid, model.title, JSON.stringify(model.content), JSON.stringify(model.header),
    JSON.stringify(model.footer), JSON.stringify(model.variableCatalog), model.sourceDocxName,
    model.sourceDocxSha256, admin.id, admin.id,
  );
  db.prepare(`
    INSERT INTO payroll_rule_sets
      (code,version,libelle,pays_code,date_effet,statut,social_rules,tax_rules,rounding_rules,
       legal_references,validated_by,validated_at,created_by)
    VALUES
      ('E2E-ZERO',1,'Regles neutres E2E','CG','2026-01-01','publie',?,?,?,?,?,datetime('now'),?)
  `).run(
    JSON.stringify({ employeeRate: 0, employerRate: 0 }),
    JSON.stringify({ mode: 'progressive', brackets: [{ from: 0, to: 1000000000, rate: 0 }] }),
    JSON.stringify({ money: 'nearest' }),
    JSON.stringify(['Fixture E2E temporaire - non publiable']),
    admin.id,
    admin.id,
  );
  db.close();
}

async function waitForHealth() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error(`Serveur E2E non disponible sur ${baseURL}`);
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const cli = require.resolve('@playwright/test/cli');
    const child = spawn(process.execPath, [cli, 'test', 'tests/employment_contracts_playwright.spec.js', '--project=chromium', '--reporter=line', '--retries=0'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Playwright termine avec le code ${code}`)));
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function main() {
  await assertPortFree();
  seedDatabase();
  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, ['backend/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
  });
  await waitForHealth();
  await runPlaywright();
  console.log('employment_contracts_isolated_e2e: OK');
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    if (fs.existsSync(logPath)) {
      console.error('\n--- Logs serveur E2E ---');
      console.error(fs.readFileSync(logPath, 'utf8'));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    if (process.exitCode !== 1 && process.env.SMI_E2E_KEEP_ARTIFACTS !== '1') {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`Artefacts E2E conserves : ${tempDir}`);
    }
  });

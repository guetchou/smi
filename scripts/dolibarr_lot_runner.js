#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const REPORT_DIR = path.join(PROJECT_DIR, 'reports');

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function loadEnvValues() {
  const values = {};
  if (!fs.existsSync(ENV_FILE)) return values;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
    if (!process.env[key]) process.env[key] = value;
  }
  return values;
}

function secretValues(envValues) {
  return Object.entries(envValues)
    .filter(([key, value]) => value && /(SECRET|PASSWORD|API_KEY|TOKEN|KEY)/i.test(key))
    .map(([, value]) => value)
    .filter(value => String(value).length >= 4)
    .sort((a, b) => String(b).length - String(a).length);
}

function redact(text, secrets) {
  let output = String(text || '');
  for (const secret of secrets) {
    output = output.split(secret).join('[redacted]');
  }
  output = output.replace(/(DOLAPIKEY|DOLIBARR_API_KEY|MARIADB_PASSWORD|MYSQL_PASSWORD)\s*[:=]\s*[^\s,;"]+/gi, '$1=[redacted]');
  return output;
}

function parseJsonObject(output) {
  const text = String(output || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function runStep(step, secrets) {
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args || [], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ...(step.env || {}) },
    encoding: 'utf8',
    timeout: step.timeoutMs || 120000,
  });
  const durationMs = Date.now() - started;
  const stdout = redact(result.stdout || '', secrets);
  const stderr = redact(result.stderr || '', secrets);
  return {
    ...step,
    status: result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    durationMs,
    stdout,
    stderr,
    parsedJson: parseJsonObject(stdout),
    error: result.error ? result.error.message : null,
  };
}

function shellStep(name, command, options = {}) {
  return {
    name,
    cmd: 'bash',
    args: ['-lc', command],
    ...options,
  };
}

function nodeStep(name, script, options = {}) {
  return {
    name,
    cmd: process.execPath,
    args: [script],
    ...options,
  };
}

function npmStep(name, script, options = {}) {
  return {
    name,
    cmd: 'npm',
    args: ['run', script],
    ...options,
  };
}

function outputTail(text, max = 5000) {
  if (!text) return '';
  return text.length > max ? text.slice(-max) : text;
}

function jsonSummary(result) {
  const data = result.parsedJson;
  if (!data || typeof data !== 'object') return '';
  const lines = [];
  if (data.ok !== undefined) lines.push(`ok: ${data.ok}`);
  if (data.httpWorkflow) lines.push(`workflow: ${data.httpWorkflow.join(' -> ')}`);
  if (data.operation) lines.push(`operation: ${JSON.stringify(data.operation)}`);
  if (data.dolibarrJob) lines.push(`job: ${JSON.stringify(data.dolibarrJob)}`);
  if (data.attempts) lines.push(`attempts: ${JSON.stringify(data.attempts)}`);
  if (data.links) lines.push(`links: ${JSON.stringify(data.links)}`);
  if (data.bankAccountId) lines.push(`bankAccountId: ${data.bankAccountId}`);
  if (data.secretsPrinted !== undefined) lines.push(`secretsPrinted: ${data.secretsPrinted}`);
  return lines.join('\n');
}

function buildReport(results, options) {
  const failed = results.filter(result => !result.ok);
  const createdAt = new Date().toISOString();
  const lines = [];
  lines.push(`# Dolibarr sandbox verification`);
  lines.push('');
  lines.push(`- Date: ${createdAt}`);
  lines.push(`- Project: ${PROJECT_DIR}`);
  lines.push(`- Mode: ${options.quick ? 'quick' : 'full'}`);
  lines.push(`- Invoice source of truth: Dolibarr master invoice`);
  lines.push(`- Secrets printed: false (outputs redacted by runner)`);
  lines.push(`- Result: ${failed.length ? 'FAILED' : 'PASSED'}`);
  lines.push('');
  lines.push(`## Executive summary`);
  lines.push('');
  if (failed.length) {
    lines.push(`${failed.length} step(s) failed. See details below; no destructive rollback was attempted.`);
  } else {
    lines.push(`All selected Dolibarr sandbox verification steps passed.`);
  }
  lines.push('');
  lines.push(`## Steps`);
  lines.push('');
  for (const result of results) {
    lines.push(`### ${result.ok ? 'PASS' : 'FAIL'} - ${result.name}`);
    lines.push('');
    lines.push(`- Command: \`${[result.cmd, ...(result.args || [])].join(' ')}\``);
    lines.push(`- Duration: ${result.durationMs}ms`);
    lines.push(`- Status: ${result.status}${result.signal ? ` (${result.signal})` : ''}`);
    if (result.error) lines.push(`- Error: ${result.error}`);
    const summary = jsonSummary(result);
    if (summary) {
      lines.push('');
      lines.push('Summary:');
      lines.push('```text');
      lines.push(summary);
      lines.push('```');
    }
    const stdout = outputTail(result.stdout);
    const stderr = outputTail(result.stderr);
    if (stdout) {
      lines.push('');
      lines.push('Stdout tail:');
      lines.push('```text');
      lines.push(stdout.trim());
      lines.push('```');
    }
    if (stderr) {
      lines.push('');
      lines.push('Stderr tail:');
      lines.push('```text');
      lines.push(stderr.trim());
      lines.push('```');
    }
    lines.push('');
  }
  lines.push(`## Rollback`);
  lines.push('');
  lines.push('- No destructive action was executed by this runner.');
  lines.push('- Disable connector if needed: `DOLIBARR_ENABLED=false`.');
  lines.push('- Revert code changes with Git patch/revert.');
  lines.push('- Sandbox objects created by tests are kept as evidence; delete/correct them manually only after Finance/Admin validation.');
  lines.push('');
  lines.push(`## Residual risks`);
  lines.push('');
  lines.push('- Customer invoices are not generated by this runner because Dolibarr is confirmed as master invoice.');
  lines.push('- Production execution still requires explicit validation, dedicated API user, and backup/rollback plan.');
  lines.push('');
  return lines.join('\n');
}

function ensureReportsDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function main() {
  const args = new Set(process.argv.slice(2));
  const options = {
    quick: args.has('--quick'),
    noSql: args.has('--no-sql'),
    auditOnly: args.has('--audit-only'),
  };
  const envValues = loadEnvValues();
  const secrets = secretValues(envValues);

  const steps = [
    shellStep('audit: pwd', 'pwd', { timeoutMs: 10000 }),
    shellStep('audit: git status', 'git status --short', { timeoutMs: 10000 }),
    shellStep('audit: disk', 'df -h /opt/projet-smi /tmp', { timeoutMs: 10000 }),
    shellStep('audit: ports', 'ss -ltnp', { timeoutMs: 10000 }),
    shellStep('audit: dolibarr compose ps', 'docker compose -f docker-compose.dolibarr-sandbox.yml ps', { timeoutMs: 30000 }),
  ];

  if (!options.auditOnly) {
    steps.push(
      npmStep('sandbox: prepare Dolibarr', 'dolibarr:sandbox:prepare', { timeoutMs: 120000 }),
      npmStep('sandbox: supplier payment service proof', 'dolibarr:sandbox:test-supplier', { timeoutMs: 120000 }),
      npmStep('sandbox: cash-out HTTP workflow proof', 'dolibarr:sandbox:test-cashout-workflow', { timeoutMs: 120000 }),
      npmStep('sandbox: receipt HTTP workflow proof', 'dolibarr:sandbox:test-receipt-workflow', { timeoutMs: 120000 }),
      nodeStep('targeted: dolibarr integration tests', 'tests/dolibarr_integration_test.js', { timeoutMs: 120000 }),
      nodeStep('targeted: dolibarr route tests', 'tests/dolibarr_routes_test.js', { timeoutMs: 120000 }),
      nodeStep('targeted: dolibarr enqueue tests', 'tests/dolibarr_operation_enqueue_test.js', { timeoutMs: 120000 }),
      nodeStep('targeted: dolibarr sandbox script tests', 'tests/dolibarr_sandbox_prepare_script_test.js', { timeoutMs: 120000 }),
    );
    if (!options.noSql) {
      steps.push(shellStep(
        'sandbox: latest Dolibarr bank/thirdparty evidence',
        'docker exec dolibarr-sandbox-db sh -lc \'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "SELECT rowid,fk_account,datev,amount,num_releve FROM llx_bank ORDER BY rowid DESC LIMIT 5; SELECT rowid,nom,client,fournisseur FROM llx_societe ORDER BY rowid DESC LIMIT 5;"\'',
        { timeoutMs: 30000 },
      ));
    }
    if (!options.quick) {
      steps.push({ name: 'full: npm test', cmd: 'npm', args: ['test'], timeoutMs: 300000 });
    }
  }

  const results = [];
  for (const step of steps) {
    process.stdout.write(`[dolibarr-runner] ${step.name}... `);
    const result = runStep(step, secrets);
    results.push(result);
    process.stdout.write(result.ok ? 'OK\n' : 'FAILED\n');
    if (!result.ok && !args.has('--keep-going')) break;
  }

  ensureReportsDir();
  const reportPath = path.join(REPORT_DIR, `dolibarr_sandbox_verification_${timestamp()}.md`);
  fs.writeFileSync(reportPath, buildReport(results, options));
  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    reportPath,
    steps: results.map(result => ({ name: result.name, ok: result.ok, status: result.status, durationMs: result.durationMs })),
    failed: failed.map(result => result.name),
    secretsPrinted: false,
  }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main();

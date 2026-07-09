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

function shellStep(name, command, options = {}) {
  return { name, cmd: 'bash', args: ['-lc', command], ...options };
}

function nodeStep(name, script, options = {}) {
  return { name, cmd: process.execPath, args: [script], ...options };
}

function npmStep(name, script, extraArgs = [], options = {}) {
  return { name, cmd: 'npm', args: ['run', script, '--', ...extraArgs], ...options };
}

function runStep(step, secrets) {
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args || [], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ...(step.env || {}) },
    encoding: 'utf8',
    timeout: step.timeoutMs || 120000,
  });

  return {
    ...step,
    status: result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    durationMs: Date.now() - started,
    stdout: redact(result.stdout || '', secrets),
    stderr: redact(result.stderr || '', secrets),
    parsedJson: parseJsonObject(result.stdout || ''),
    error: result.error ? result.error.message : null,
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
  if (data.module) lines.push(`module: ${data.module}`);
  if (data.summary) lines.push(`summary: ${JSON.stringify(data.summary)}`);
  if (data.issues) lines.push(`issues: ${JSON.stringify(data.issues)}`);
  if (data.steps) lines.push(`steps: ${JSON.stringify(data.steps)}`);
  if (data.reportPath) lines.push(`reportPath: ${data.reportPath}`);
  return lines.join('\n');
}

function buildReport(results, options) {
  const failed = results.filter(result => !result.ok);
  const createdAt = new Date().toISOString();
  const lines = [];

  lines.push('# SMI remaining lots verification');
  lines.push('');
  lines.push(`- Date: ${createdAt}`);
  lines.push(`- Project: ${PROJECT_DIR}`);
  lines.push(`- Mode: ${options.auditOnly ? 'audit-only' : options.full ? 'full' : 'targeted'}`);
  lines.push(`- Scope: ${options.scopes.join(', ')}`);
  lines.push(`- Secrets printed: false`);
  lines.push(`- Result: ${failed.length ? 'FAILED' : 'PASSED'}`);
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(failed.length
    ? `${failed.length} step(s) failed. See the detailed step output below.`
    : 'All selected lot checks passed.');
  lines.push('');
  lines.push('## Steps');
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

  lines.push('## Rollback');
  lines.push('');
  lines.push('- No destructive action is executed by this runner.');
  lines.push('- Individual test scripts clean up their own records when they pass.');
  lines.push('- If you need to stop the connecteur, set `DOLIBARR_ENABLED=false`.');
  lines.push('- For code rollback, use `git revert` on the commit that introduced the runner.');
  lines.push('');
  lines.push('## Residual risks');
  lines.push('');
  lines.push('- Targeted scripts can still touch production-like data if run against the live database.');
  lines.push('- Use `--audit-only` first on a new environment.');
  lines.push('- Run `--full` only when the environment is isolated or explicitly approved.');
  lines.push('');

  return lines.join('\n');
}

function ensureReportsDir() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function buildSteps(options) {
  const steps = [
    shellStep('audit: pwd', 'pwd', { timeoutMs: 10000 }),
    shellStep('audit: git status', 'git status --short', { timeoutMs: 10000 }),
    shellStep('audit: disk', 'df -h /opt/projet-smi /tmp', { timeoutMs: 10000 }),
    shellStep('audit: ports', 'ss -ltnp', { timeoutMs: 10000 }),
  ];

  if (options.auditOnly) return steps;

  const scopeSet = new Set(options.scopes);
  const includeAll = scopeSet.has('all');

  if (includeAll || scopeSet.has('finance')) {
    steps.push(
      nodeStep('finance: integrity report', 'scripts/check_finance_integrity_mysql.js', { timeoutMs: 120000 }),
      nodeStep('finance: integrity contract', 'scripts/test_finance_integrity_mysql.js', { timeoutMs: 120000 }),
      nodeStep('finance: treasury ledger canonical', 'scripts/test_treasury_ledger_canonical_mysql.js', { timeoutMs: 120000 }),
      nodeStep('finance: cash receipt workflow', 'scripts/test_cash_receipt_workflow_mysql.js', { timeoutMs: 120000 }),
    );
  }

  if (includeAll || scopeSet.has('payroll')) {
    steps.push(
      nodeStep('payroll: unpaid leave impact', 'scripts/test_unpaid_leave_payroll_mysql.js', { timeoutMs: 120000 }),
      nodeStep('payroll: unpaid leave rectification', 'scripts/test_unpaid_leave_late_rectification_mysql.js', { timeoutMs: 120000 }),
      nodeStep('payroll: salary advance parapheur', 'scripts/test_salary_advance_parapheur_mysql.js', { timeoutMs: 120000 }),
      nodeStep('payroll: offboarding parapheur', 'scripts/test_offboarding_parapheur_mysql.js', { timeoutMs: 120000 }),
    );
  }

  if (includeAll || scopeSet.has('organization')) {
    steps.push(
      nodeStep('organization: department functions integrity', 'scripts/check_department_functions_mysql.js', { timeoutMs: 120000 }),
      nodeStep('organization: org event integrity', 'scripts/check_org_event_integrity_mysql.js', { timeoutMs: 120000 }),
      nodeStep('organization: department workflow', 'scripts/test_department_function_workflow_mysql.js', { timeoutMs: 120000 }),
    );
  }

  if (includeAll || scopeSet.has('dolibarr')) {
    steps.push(
      npmStep('dolibarr: sandbox verify all', 'dolibarr:sandbox:verify-all', ['--quick', '--keep-going'], { timeoutMs: 300000 }),
    );
  }

  if (options.full) {
    steps.push(shellStep('full: npm test', 'npm test', { timeoutMs: 300000 }));
  }

  return steps;
}

function parseArgs(argv) {
  const args = new Set(argv);
  const scopes = [];

  if (args.has('--audit-only')) {
    return { auditOnly: true, full: false, scopes: ['audit-only'] };
  }

  if (args.has('--full')) scopes.push('all');
  if (args.has('--all') || scopes.length === 0) scopes.push('all');
  if (args.has('--finance')) scopes.push('finance');
  if (args.has('--payroll')) scopes.push('payroll');
  if (args.has('--organization')) scopes.push('organization');
  if (args.has('--dolibarr')) scopes.push('dolibarr');

  const uniqueScopes = [...new Set(scopes)];
  return {
    auditOnly: false,
    full: args.has('--full'),
    scopes: uniqueScopes,
    keepGoing: args.has('--keep-going'),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const envValues = loadEnvValues();
  const secrets = secretValues(envValues);
  const steps = buildSteps(options);
  const results = [];

  for (const step of steps) {
    process.stdout.write(`[smi-lot-runner] ${step.name}... `);
    const result = runStep(step, secrets);
    results.push(result);
    process.stdout.write(result.ok ? 'OK\n' : 'FAILED\n');
    if (!result.ok && !options.keepGoing) break;
  }

  ensureReportsDir();
  const reportPath = path.join(REPORT_DIR, `smi_remaining_lots_${timestamp()}.md`);
  fs.writeFileSync(reportPath, buildReport(results, options));

  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    reportPath,
    steps: results.map(result => ({
      name: result.name,
      ok: result.ok,
      status: result.status,
      durationMs: result.durationMs,
    })),
    failed: failed.map(result => result.name),
    secretsPrinted: false,
  }, null, 2));

  process.exitCode = failed.length ? 1 : 0;
}

main();

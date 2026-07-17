'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const DEFAULT_DOCX = '/mnt/c/Users/Gess/OneDrive/Documents/Contrats-Agents-TopCenter/Contrat de travail des nationaux  MATOKO2.docx';
const LOCAL_NODE22_BIN = '/root/.nvm/versions/node/v22.22.0/bin';

function testRuntimeEnv() {
  const requestedBin = process.env.SMI_TEST_NODE_BIN;
  const nodeBin = requestedBin || (fs.existsSync(path.join(LOCAL_NODE22_BIN, 'node')) ? LOCAL_NODE22_BIN : null);
  return nodeBin ? { PATH: `${nodeBin}:${process.env.PATH}` } : {};
}

function run(name, command, args = [], options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    name,
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - started,
    command: [command, ...args].join(' '),
    stdout: String(result.stdout || '').slice(-5000),
    stderr: String(result.stderr || '').slice(-5000),
    error: result.error?.message || null,
  };
}

function fileCheck(name, relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const ok = fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
  return {
    name,
    ok,
    status: ok ? 0 : 1,
    durationMs: 0,
    command: `test -s ${relativePath}`,
    stdout: fs.existsSync(fullPath) ? relativePath : '',
    stderr: fs.existsSync(fullPath) ? '' : `Fichier manquant: ${relativePath}`,
    error: null,
  };
}

function buildSteps(mode) {
  const docx = process.env.SMI_CONTRACT_SOURCE_DOCX || DEFAULT_DOCX;
  const steps = [
    () => run('audit: project root', 'pwd'),
    () => run('audit: git state', 'git', ['status', '--short']),
    () => run('audit: disk', 'df', ['-h', ROOT]),
    () => run('audit: source DOCX', 'sha256sum', [docx]),
  ];
  if (mode === 'audit') return steps;

  steps.push(
    () => run('foundation: remuneration', 'node', ['tests/contract_remuneration_test.js']),
    () => run('foundation: template variables', 'node', ['tests/contract_template_engine_test.js']),
    () => run('foundation: schema', 'node', ['tests/employment_contract_schema_test.js']),
    () => run('foundation: workflow', 'node', ['tests/employment_contract_workflow_test.js']),
    () => run('foundation: route guards', 'node', ['tests/employment_contract_routes_test.js']),
    () => run('foundation: document generator', 'node', ['tests/employment_contract_documents_test.js']),
    () => run('templates: guarded source import', 'node', ['tests/employment_contract_template_import_test.js']),
    () => run('foundation: migration syntax markers', 'node', ['--check', 'backend/services/contract_remuneration.js']),
  );
  if (mode === 'foundation') return steps;

  steps.push(
    () => fileCheck('templates: API routes', 'backend/routes/employment_contracts.js'),
    () => fileCheck('documents: DOCX generator', 'backend/services/employment_contract_documents.js'),
    () => fileCheck('ui: contract workspace', 'frontend/js/modules/employment-contracts.js'),
    () => run('ui: contract workspace guards', 'node', ['tests/employment_contract_ui_test.js']),
    () => run('verify: isolated Playwright workflow', 'node', ['scripts/test_employment_contracts_isolated.js'], { timeout: 180000, env: testRuntimeEnv() }),
    () => run('verify: complete test suite', 'npm', ['test'], { timeout: 300000, env: testRuntimeEnv() }),
  );
  return steps;
}

function report(results, mode) {
  const lines = [
    '# Salary and employment contracts lot runner', '',
    `- Date: ${new Date().toISOString()}`,
    `- Mode: ${mode}`,
    `- Branch: ${spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()}`,
    `- Result: ${results.every(item => item.ok) ? 'PASSED' : 'FAILED'}`, '',
    '## Steps', '',
  ];
  for (const item of results) {
    lines.push(`### ${item.ok ? 'PASS' : 'FAIL'} - ${item.name}`, '', `- Command: \`${item.command}\``, `- Duration: ${item.durationMs}ms`);
    if (item.stdout.trim()) lines.push('', '```text', item.stdout.trim(), '```');
    if (item.stderr.trim()) lines.push('', '```text', item.stderr.trim(), '```');
    lines.push('');
  }
  lines.push('## Safety', '', '- No database migration or production deployment is executed by this runner.', '- The source DOCX is read-only.', '- Fiscal and social rules require explicit publication and human validation.', '');
  return lines.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has('--all') ? 'all' : args.has('--foundation') ? 'foundation' : 'audit';
  const keepGoing = args.has('--keep-going');
  const results = [];
  for (const execute of buildSteps(mode)) {
    const result = execute();
    results.push(result);
    process.stdout.write(`[salary-contract] ${result.name}: ${result.ok ? 'OK' : 'FAILED'}\n`);
    if (!result.ok && !keepGoing) break;
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  const reportPath = path.join(REPORT_DIR, `salary_contract_lots_${stamp}.md`);
  fs.writeFileSync(reportPath, report(results, mode));
  const ok = results.every(item => item.ok);
  process.stdout.write(`${JSON.stringify({ ok, mode, reportPath, steps: results.map(({ name, ok, durationMs }) => ({ name, ok, durationMs })) }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

main();

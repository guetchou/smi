const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const deploy = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/pr-checks.yml'), 'utf8');
const smoke = fs.readFileSync(path.join(root, 'scripts/check_department_functions_mysql.js'), 'utf8');
const events = fs.readFileSync(path.join(root, 'scripts/check_org_event_integrity_mysql.js'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'scripts/test_department_function_workflow_mysql.js'), 'utf8');
const jobs = fs.readFileSync(path.join(root, 'scripts/backfill_org_jobs_mysql.js'), 'utf8');
const functions = fs.readFileSync(path.join(root, 'scripts/backfill_department_functions_mysql.js'), 'utf8');

for (const source of [smoke, events, integration, jobs, functions]) new Function(source);

for (const script of [
  'backfill_org_jobs_mysql.js',
  'backfill_department_functions_mysql.js',
  'check_department_functions_mysql.js',
  'check_org_event_integrity_mysql.js',
]) assert(deploy.includes(script), `deploy missing ${script}`);

assert(workflow.includes('mysql:8.0'));
assert(workflow.includes('npm test'));
assert(workflow.includes('test_department_function_workflow_mysql.js'));
assert(workflow.includes('check_department_functions_mysql.js'));
assert(workflow.includes('check_org_event_integrity_mysql.js'));
assert(integration.includes('SELF_APPROVAL_FORBIDDEN'));
assert(integration.includes('UNIT_CYCLE_FORBIDDEN'));
assert(integration.includes('FUNCTION_VERSION_CONFLICT'));
assert(integration.includes('workflow.STATUS.ACTIVE'));
assert(integration.includes('workflow.STATUS.REFUSED'));

const swap = deploy.indexOf('docker compose up -d --wait --wait-timeout 120 caisse');
assert(deploy.indexOf('check_org_event_integrity_mysql.js') < swap);
assert(deploy.includes('mysqldump'));
assert(deploy.includes('/api/health'));
assert(smoke.includes('org_unites'));
assert(smoke.includes('poste_id'));
assert(smoke.includes('fk_employe_poste_officiel'));
assert(smoke.includes('uq_org_df_singleton_active'));
assert(smoke.includes('transaction_rollback'));
assert(events.includes('uq_org_dfe_version_event'));
assert(events.includes('HAVING COUNT(*)>1'));
assert(jobs.includes('UPDATE employes e'));
assert(jobs.includes('UPDATE org_departement_fonctions f'));
assert(functions.includes('NOT EXISTS'));
assert(functions.includes('legacy_import'));

console.log('OK - MySQL organization CI and deployment gates');

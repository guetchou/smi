const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const deploy = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
const smoke = fs.readFileSync(path.join(root, 'scripts/check_department_functions_mysql.js'), 'utf8');
const backfill = fs.readFileSync(path.join(root, 'scripts/backfill_department_functions_mysql.js'), 'utf8');

for (const source of [smoke, backfill]) new Function(source);

assert(deploy.includes('backfill_department_functions_mysql.js'));
assert(deploy.includes('check_department_functions_mysql.js'));
assert(deploy.indexOf('check_department_functions_mysql.js') < deploy.indexOf('docker compose up -d --wait --wait-timeout 120 caisse'));
assert(deploy.includes('mysqldump'));
assert(deploy.includes('/api/health'));
assert(smoke.includes('INFORMATION_SCHEMA.COLUMNS'));
assert(smoke.includes('uq_org_df_singleton_active'));
assert(smoke.includes('transaction_rollback'));
assert(smoke.includes('FOR UPDATE'));
assert(backfill.includes('NOT EXISTS'));
assert(backfill.includes('legacy_import'));

console.log('OK - MySQL organization deployment gates');

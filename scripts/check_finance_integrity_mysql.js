'use strict';

process.env.DB_DRIVER = 'mysql';

const db = require('../backend/db');
const { buildFinanceIntegrityReport } = require('../backend/services/finance-integrity');

function parseIds(prefix) {
  const argument = process.argv.slice(2).find(value => value.startsWith(`${prefix}=`));
  if (!argument) return [];
  return argument.slice(prefix.length + 1)
    .split(',')
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0);
}

async function main() {
  const report = await buildFinanceIntegrityReport({
    positionIds: parseIds('--position'),
    operationIds: parseIds('--operation'),
  });

  const compact = process.argv.includes('--json');
  process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      ok: false,
      read_only: true,
      error: error.message,
      code: error.code || 'FINANCE_INTEGRITY_CHECK_FAILED',
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db._pool.end(); } catch (_) {}
  });

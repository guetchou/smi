'use strict';

process.env.DB_DRIVER = 'mysql';

const db = require('../backend/db');
const { buildFinanceIntegrityReport } = require('../backend/services/finance-integrity');
const { expectedLedgerLegs } = require('../backend/services/treasury-ledger');

function idsFromArg(name) {
  const arg = process.argv.slice(2).find(value => value.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1).split(',').map(Number).filter(id => Number.isInteger(id) && id > 0) : [];
}

async function main() {
  if (!process.argv.includes('--dry-run')) throw new Error('Option --dry-run obligatoire');

  const requested = idsFromArg('--position');
  const integrity = await buildFinanceIntegrityReport({ positionIds: requested });
  const positionIds = requested.length ? requested : integrity.positions.map(row => Number(row.position_id));
  if (!positionIds.length) {
    console.log(JSON.stringify({ ok: true, dry_run: true, planned_legs: [] }, null, 2));
    return;
  }

  const marks = positionIds.map(() => '?').join(',');
  const operations = await db.query(`
    SELECT id, date, num_piece, libelle, montant, type_op, statut, dec_statut,
           position_id, position_source_id
    FROM operations
    WHERE statut='valide'
      AND (type_op IN ('encaissement','virement') OR (type_op='decaissement' AND dec_statut='paye'))
      AND (position_id IN (${marks}) OR position_source_id IN (${marks}))
    ORDER BY date, id
  `, [...positionIds, ...positionIds]);

  const existing = await db.query(`
    SELECT id, operation_id, caisse_id, type_mouvement, montant, leg_code
    FROM cash_ledger
    WHERE caisse_id IN (${marks})
    ORDER BY caisse_id, id
  `, positionIds);
  const canonicalKeys = new Set(existing
    .filter(row => row.operation_id && row.leg_code)
    .map(row => `${Number(row.operation_id)}:${row.leg_code}`));

  const plannedLegs = [];
  for (const operation of operations) {
    for (const leg of expectedLedgerLegs(operation)) {
      if (!positionIds.includes(Number(leg.caisse_id))) continue;
      const key = `${Number(operation.id)}:${leg.leg_code}`;
      plannedLegs.push({
        action: canonicalKeys.has(key) ? 'keep' : 'missing',
        operation_id: Number(operation.id),
        operation_date: String(operation.date).slice(0, 10),
        reference: operation.num_piece || null,
        ...leg,
      });
    }
  }

  const legacyRows = existing
    .filter(row => row.operation_id && !row.leg_code)
    .map(row => ({
      ledger_id: Number(row.id),
      operation_id: Number(row.operation_id),
      caisse_id: Number(row.caisse_id),
      type_mouvement: row.type_mouvement,
      montant: Number(row.montant),
    }));

  const output = {
    ok: integrity.ok && !legacyRows.length && plannedLegs.every(row => row.action === 'keep'),
    dry_run: true,
    generated_at: new Date().toISOString(),
    position_ids: positionIds,
    integrity_summary: integrity.summary,
    summary: {
      operations: operations.length,
      canonical_legs: plannedLegs.filter(row => row.action === 'keep').length,
      missing_legs: plannedLegs.filter(row => row.action === 'missing').length,
      legacy_rows: legacyRows.length,
    },
    planned_legs: plannedLegs,
    legacy_rows: legacyRows,
    warnings: [
      'Aucune donnée modifiée.',
      'Analyser les lignes historiques avant activation des positions.',
    ],
  };

  console.log(JSON.stringify(output, null, process.argv.includes('--json') ? 0 : 2));
  if (!output.ok) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(JSON.stringify({ ok: false, dry_run: true, error: error.message }));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db._pool.end(); } catch (_) {}
  });

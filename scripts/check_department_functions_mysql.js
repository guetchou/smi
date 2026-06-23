'use strict';

process.env.DB_DRIVER = 'mysql';
const db = require('../backend/db');

async function main() {
  const result = { ok: true, module: 'department-functions' };
  const columns = await db.queryOne(`SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_departement_fonctions' AND COLUMN_NAME IN ('entreprise_id','statut','version','motif','motif_refus','document_nom','document_url','document_hash','submitted_by','submitted_at','approved_at','refused_by','refused_at','cancelled_by','cancelled_at','effective_at','closed_by','closed_at','singleton_key')`);
  if (Number(columns?.total || 0) < 19) throw new Error('Colonnes workflow incomplètes');
  result.columns = Number(columns.total);
  console.log(JSON.stringify(result));
}

main().then(() => db._pool.end()).catch(async error => {
  console.error('[department-functions-mysql-check]', error.message);
  try { await db._pool.end(); } catch (_) {}
  process.exitCode = 1;
});

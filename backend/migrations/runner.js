'use strict';

const fs   = require('fs');
const path = require('path');

function stripLineComments(sql) {
  return sql
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n');
}

function splitStatements(sql) {
  return stripLineComments(sql)
    .split(/;[ \t]*(?:--[^\n]*)?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function isIdempotentMysqlError(err) {
  return [
    'ER_TABLE_EXISTS_ERROR',
    'ER_DUP_KEYNAME',
    'ER_DUP_FIELDNAME',
    'ER_FK_DUP_NAME',
  ].includes(err && err.code);
}

function isRetryableMysqlError(err) {
  return ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(err && err.code);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeStatementWithRetry(pool, stmt, { file = 'migration.sql', waitFn = wait } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.execute(stmt);
      return { status: 'executed', attempts: attempt };
    } catch (err) {
      if (isIdempotentMysqlError(err)) {
        console.log(`[migrations] ↷ ${file} — déjà présent: ${err.sqlMessage || err.message}`);
        return { status: 'already_present', attempts: attempt, error_code: err.code };
      }
      if (attempt < 3 && isRetryableMysqlError(err)) {
        console.log(`[migrations] ↻ ${file} — verrou MySQL, retry ${attempt}/3`);
        await waitFn(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Échec inattendu de la migration ${file}`);
}

async function runMigrations(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) NOT NULL PRIMARY KEY,
      executed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const dir   = __dirname;
  const files = fs.readdirSync(dir)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const [rows] = await pool.execute(
      'SELECT version FROM schema_migrations WHERE version = ?', [file]
    );
    if (rows.length > 0) {
      console.log(`[migrations] ✓ ${file} (déjà appliqué)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = splitStatements(sql);

    try {
      for (const stmt of statements) {
        await executeStatementWithRetry(pool, stmt, { file });
      }
      await pool.execute(
        'INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [file]
      );
      console.log(`[migrations] ✓ ${file} appliqué`);
    } catch (err) {
      console.error(`[migrations] ✗ ${file} — ERREUR: ${err.message}`);
      throw err;
    }
  }

  console.log('[migrations] Schéma MySQL à jour.');
}

module.exports = {
  runMigrations,
  stripLineComments,
  splitStatements,
  isIdempotentMysqlError,
  isRetryableMysqlError,
  executeStatementWithRetry,
};

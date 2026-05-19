'use strict';

const fs   = require('fs');
const path = require('path');

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

    const sql        = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = sql
      .split(/;[ \t]*\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    try {
      for (const stmt of statements) {
        await pool.execute(stmt);
      }
      await pool.execute(
        'INSERT INTO schema_migrations (version) VALUES (?)', [file]
      );
      console.log(`[migrations] ✓ ${file} appliqué`);
    } catch (err) {
      console.error(`[migrations] ✗ ${file} — ERREUR: ${err.message}`);
      throw err;
    }
  }

  console.log('[migrations] Schéma MySQL à jour.');
}

module.exports = { runMigrations };

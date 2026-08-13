'use strict';

const mysql = require('mysql2/promise');

function translate(sql) {
  return String(sql)
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO')
    .replace(
      /\s+ON\s+CONFLICT\s*\(\s*employe_id\s*,\s*mois\s*,\s*annee\s*\)\s+DO\s+UPDATE\s+SET\s+([\s\S]+?)\s+WHERE\s+bulletins_salaire\.statut\s*=\s*'brouillon'\s*$/i,
      (_, assignments) => {
        const mysqlAssignments = String(assignments)
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
          .map(part => {
            const match = part.match(/^(\w+)\s*=\s*(.+)$/);
            if (!match) return part;
            const column = match[1];
            const rawValue = match[2]
              .replace(/^excluded\.(\w+)$/i, 'VALUES($1)')
              .replace(/^datetime\s*\(\s*'now'\s*\)$/i, 'NOW()');
            return `${column}=IF(statut = 'brouillon', ${rawValue}, ${column})`;
          })
          .join(',\n      ');
        return ` ON DUPLICATE KEY UPDATE ${mysqlAssignments}, id = IF(statut = 'brouillon', LAST_INSERT_ID(id), id)`;
      }
    )
    .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, (_, col) => `DATE_FORMAT(${col.trim()}, '%Y-%m')`)
    .replace(/strftime\s*\(\s*'%m'\s*,\s*([^)]+?)\s*\)/gi, (_, col) => `DATE_FORMAT(${col.trim()}, '%m')`)
    .replace(/strftime\s*\(\s*'%Y'\s*,\s*([^)]+?)\s*\)/gi, (_, col) => `DATE_FORMAT(${col.trim()}, '%Y')`)
    .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/date\s*\(\s*'now'\s*\)/gi, 'CURDATE()')
    .replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
}

function splitStatements(sql) {
  return String(sql).split(/;[ \t]*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
}

function normalizeParam(value) {
  if (typeof value !== 'string') return value;
  const isoDatetime = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/);
  if (isoDatetime) return `${isoDatetime[1]} ${isoDatetime[2]}`;
  return value;
}

function normalizeParams(params = []) {
  return Array.isArray(params) ? params.map(normalizeParam) : params;
}

async function main() {
  const payload = JSON.parse(process.argv[2] || '{}');
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'mysql',
    port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
    user: process.env.MYSQL_USER || 'caisse_user',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'caisse_topcenter',
    charset: 'utf8mb4',
    timezone: '+01:00',
    waitForConnections: true,
    connectionLimit: 1,
    multipleStatements: false,
  });

  try {
    await pool.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");

    if (payload.kind === 'exec') {
      for (const stmt of splitStatements(payload.sql)) {
        await pool.query(translate(stmt), normalizeParams(payload.params || []));
      }
      process.stdout.write(JSON.stringify({ ok: true }));
      return;
    }

    const [rowsOrResult] = await pool.query(translate(payload.sql), normalizeParams(payload.params || []));
    if (payload.kind === 'all') {
      process.stdout.write(JSON.stringify({ rows: rowsOrResult }));
    } else if (payload.kind === 'get') {
      process.stdout.write(JSON.stringify({ row: Array.isArray(rowsOrResult) ? (rowsOrResult[0] || null) : null }));
    } else if (payload.kind === 'run') {
      process.stdout.write(JSON.stringify({
        result: {
          lastInsertRowid: rowsOrResult.insertId || 0,
          changes: rowsOrResult.affectedRows || 0,
        },
      }));
    } else {
      throw new Error(`mysql_sync_runner: kind invalide ${payload.kind}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  process.stderr.write(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

'use strict';

/**
 * db.js — Couche d'abstraction DB
 *
 * DB_DRIVER=sqlite (défaut) : wraps better-sqlite3 en async — zéro changement de comportement
 * DB_DRIVER=mysql           : pool mysql2/promise, même API async
 *
 * API exposée :
 *   query(sql, params)      → Promise<rows[]>
 *   queryOne(sql, params)   → Promise<row | null>
 *   execute(sql, params)    → Promise<{ insertId, affectedRows }>
 *   transaction(asyncFn)    → Promise<any>   — fn reçoit un objet tx avec la même API
 */

const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

// ── Mode SQLite (compatibilité — utilisé tant que DB_DRIVER != mysql) ────────
if (driver !== 'mysql') {
  const sqlite = require('./database');

  const wrap = {
    query(sql, params = []) {
      return Promise.resolve(sqlite.prepare(sql).all(Array.isArray(params) ? params : [params]));
    },
    queryOne(sql, params = []) {
      const row = sqlite.prepare(sql).get(Array.isArray(params) ? params : [params]);
      return Promise.resolve(row ?? null);
    },
    execute(sql, params = []) {
      const r = sqlite.prepare(sql).run(Array.isArray(params) ? params : [params]);
      return Promise.resolve({ insertId: r.lastInsertRowid, affectedRows: r.changes });
    },
    transaction(fn) {
      let result;
      sqlite.transaction(() => { result = fn(wrap); })();
      return Promise.resolve(result);
    },
    // Accès brut pour les fichiers non encore migrés
    _raw: sqlite,
  };

  module.exports = wrap;
}

// ── Mode MySQL ───────────────────────────────────────────────────────────────
if (driver === 'mysql') {
  const mysql = require('mysql2/promise');

  const pool = mysql.createPool({
    host:               process.env.MYSQL_HOST     || 'mysql',
    port:               parseInt(process.env.MYSQL_PORT, 10) || 3306,
    user:               process.env.MYSQL_USER     || 'caisse_user',
    password:           process.env.MYSQL_PASSWORD || '',
    database:           process.env.MYSQL_DATABASE || 'caisse_topcenter',
    charset:            'utf8mb4',
    timezone:           '+01:00',
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    supportBigNumbers:  true,
    bigNumberStrings:   false,
    dateStrings:        true,  // dates retournées comme strings 'YYYY-MM-DD HH:MM:SS'
  });

  function makeApi(exec) {
    return {
      async query(sql, params = []) {
        const [rows] = await exec(sql, params);
        return rows;
      },
      async queryOne(sql, params = []) {
        const [rows] = await exec(sql, params);
        return rows[0] ?? null;
      },
      async execute(sql, params = []) {
        const [result] = await exec(sql, params);
        return { insertId: result.insertId, affectedRows: result.affectedRows };
      },
      async transaction(fn) {
        const conn = await pool.getConnection();
        await conn.beginTransaction();
        try {
          const txApi = makeApi((sql, p) => conn.execute(sql, p));
          const result = await fn(txApi);
          await conn.commit();
          return result;
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      },
    };
  }

  const api = makeApi((sql, p) => pool.execute(sql, p));
  api._pool = pool;
  module.exports = api;
}

'use strict';

/**
 * db.js — Couche d'abstraction DB
 *
 * DB_DRIVER=sqlite (défaut) : wraps better-sqlite3 en async
 * DB_DRIVER=mysql           : pool mysql2/promise
 *
 * API exposée :
 *   query(sql, params)      → Promise<rows[]>
 *   queryOne(sql, params)   → Promise<row | null>
 *   execute(sql, params)    → Promise<{ insertId, affectedRows }>
 *   transaction(asyncFn)    → Promise<any>
 */

const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

function normalizeSqlParam(value) {
  if (typeof value !== 'string') return value;
  const isoDatetime = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/);
  if (isoDatetime) return `${isoDatetime[1]} ${isoDatetime[2]}`;
  return value;
}

function normalizeSqlParams(params = []) {
  return Array.isArray(params) ? params.map(normalizeSqlParam) : params;
}

const RE_LIMIT_OFFSET = /\bLIMIT\s+\?\s+OFFSET\s+\?/gi;
const RE_LIMIT        = /\bLIMIT\s+\?/gi;

function normalizeMysqlLimitPlaceholders(sql, params = []) {
  let nextParams = normalizeSqlParams(params);

  // Fast path — évite deux regex scans sur chaque requête sans LIMIT
  if (nextParams.length === 0 || !sql.includes('?')) return { sql, params: nextParams };
  const upper = sql.toUpperCase();
  if (!upper.includes('LIMIT')) return { sql, params: nextParams };

  let nextSql = sql;

  RE_LIMIT_OFFSET.lastIndex = 0;
  nextSql = nextSql.replace(RE_LIMIT_OFFSET, match => {
    if (nextParams.length < 2) return match;
    const offset = Number(nextParams[nextParams.length - 1]);
    const limit  = Number(nextParams[nextParams.length - 2]);
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) return match;
    nextParams = nextParams.slice(0, -2);
    return `LIMIT ${Math.max(1, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`;
  });

  RE_LIMIT.lastIndex = 0;
  nextSql = nextSql.replace(RE_LIMIT, match => {
    if (nextParams.length < 1) return match;
    const limit = Number(nextParams[nextParams.length - 1]);
    if (!Number.isFinite(limit)) return match;
    nextParams = nextParams.slice(0, -1);
    return `LIMIT ${Math.max(1, Math.floor(limit))}`;
  });

  return { sql: nextSql, params: nextParams };
}

// ── Traducteur MySQL → SQLite ─────────────────────────────────────────────────
// Appelé uniquement en mode SQLite. Traduit les fonctions MySQL en équivalents
// SQLite pour permettre aux routes converties de fonctionner sur les deux drivers.

function unitToSqlite(unit) {
  switch (unit.toUpperCase()) {
    case 'DAY':    return 'days';
    case 'HOUR':   return 'hours';
    case 'MINUTE': return 'minutes';
    case 'MONTH':  return 'months';
    case 'YEAR':   return 'years';
    default:       return unit.toLowerCase() + 's';
  }
}

// Extrait les arguments d'une fonction en gérant les parenthèses imbriquées.
// Retourne [args, endIndex] où endIndex pointe après la parenthèse fermante.
function extractFnArgs(s, openIdx) {
  let depth = 1, i = openIdx + 1, current = '', args = [];
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if      (ch === '(')            { depth++; current += ch; }
    else if (ch === ')') {
      depth--;
      if (depth === 0) args.push(current.trim());
      else             current += ch;
    }
    else if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; }
    else current += ch;
    i++;
  }
  return [args, i];
}

// Applique replacer sur toutes les occurrences de fnName(...) en gérant les imbrications.
function replaceFn(s, fnName, replacer) {
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'gi');
  let result = '', i = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    result += s.slice(i, m.index);
    const openParen = m.index + m[0].length - 1;
    const [args, end] = extractFnArgs(s, openParen);
    result += replacer(args);
    i = end;
    re.lastIndex = i;
  }
  return result + s.slice(i);
}

// Résout CONCAT marqués par \x00CONCAT\x00( en (a || b || c).
// Gère les parenthèses imbriquées (ex: CONCAT(a, COALESCE(b,''))).
function resolveConcat(s) {
  const MARKER = '\x00CONCAT\x00(';
  let result = '';
  let i = 0;
  while (i < s.length) {
    const idx = s.indexOf(MARKER, i);
    if (idx === -1) { result += s.slice(i); break; }
    result += s.slice(i, idx);
    let j = idx + MARKER.length;
    let depth = 1;
    const args = [];
    let current = '';
    while (j < s.length && depth > 0) {
      const ch = s[j];
      if      (ch === '(')            { depth++; current += ch; }
      else if (ch === ')') {
        depth--;
        if (depth === 0) args.push(current.trim());
        else             current += ch;
      }
      else if (ch === ',' && depth === 1) { args.push(current.trim()); current = ''; }
      else current += ch;
      j++;
    }
    result += '(' + args.join(' || ') + ')';
    i = j;
  }
  return result;
}

function mysqlToSqlite(sql) {
  let s = sql;

  // Passe 1 : patterns combinés DATE(NOW() ± INTERVAL N UNIT) avant les passes individuelles
  s = s.replace(
    /DATE\s*\(\s*NOW\s*\(\s*\)\s*([+-])\s*INTERVAL\s+(\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?\s*\)/gi,
    (_, sign, n, unit) => `date('now', '${sign}${n} ${unitToSqlite(unit)}')`
  );
  // CURDATE() ± INTERVAL N UNIT (arithmétique directe sans DATE_SUB/DATE_ADD)
  s = s.replace(
    /CURDATE\s*\(\s*\)\s*([+-])\s*INTERVAL\s+(\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?/gi,
    (_, sign, n, unit) => `date('now', '${sign}${n} ${unitToSqlite(unit)}')`
  );

  // Passe 2 : DATE_SUB / DATE_ADD
  s = s.replace(
    /DATE_SUB\s*\(\s*NOW\s*\(\s*\)\s*,\s*INTERVAL\s+(\?|\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?\s*\)/gi,
    (_, n, unit) => `datetime('now', '-${n} ${unitToSqlite(unit)}')`
  );
  s = s.replace(
    /DATE_ADD\s*\(\s*NOW\s*\(\s*\)\s*,\s*INTERVAL\s+(\?|\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?\s*\)/gi,
    (_, n, unit) => `datetime('now', '+${n} ${unitToSqlite(unit)}')`
  );
  s = s.replace(
    /DATE_ADD\s*\(\s*CURDATE\s*\(\s*\)\s*,\s*INTERVAL\s+(\?|\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?\s*\)/gi,
    (_, n, unit) => `date('now', '+${n} ${unitToSqlite(unit)}')`
  );
  // DATE_ADD(col, INTERVAL N UNIT) — colonne variable
  s = s.replace(
    /DATE_ADD\s*\(\s*([\w.]+)\s*,\s*INTERVAL\s+(\?|\d+)\s+(DAY|HOUR|MINUTE|MONTH|YEAR)S?\s*\)/gi,
    (_, col, n, unit) => `date(${col}, '+${n} ${unitToSqlite(unit)}')`
  );

  // Passe 3 : DATE_FORMAT
  s = s.replace(
    /DATE_FORMAT\s*\(\s*(NOW\s*\(\s*\)|CURDATE\s*\(\s*\)|[\w.]+)\s*,\s*'([^']+)'\s*\)/gi,
    (_, col, fmt) => {
      const sqliteCol = /^NOW\s*\(/i.test(col) || /^CURDATE\s*\(/i.test(col) ? "'now'" : col;
      const sqliteFmt = fmt
        .replace(/%i/g, '%M').replace(/%s/g, '%S')
        .replace(/%e/g, '%d').replace(/%c/g, '%m');
      return `strftime('${sqliteFmt}', ${sqliteCol})`;
    }
  );

  // Passe 4 : TIMESTAMPDIFF — extractFnArgs gère les imbrications (ex: datetime('now'))
  s = replaceFn(s, 'TIMESTAMPDIFF', ([unit, a, b]) => {
    if (!unit || !a || !b) return `TIMESTAMPDIFF(${[unit,a,b].join(',')})`;
    const jda = `julianday(${a})`, jdb = `julianday(${b})`;
    switch (unit.toUpperCase()) {
      case 'HOUR':   return `CAST((${jdb} - ${jda}) * 24 AS INTEGER)`;
      case 'MINUTE': return `CAST((${jdb} - ${jda}) * 1440 AS INTEGER)`;
      case 'DAY':    return `CAST(${jdb} - ${jda} AS INTEGER)`;
      case 'MONTH':  return `CAST((${jdb} - ${jda}) / 30.44 AS INTEGER)`;
      case 'YEAR':   return `CAST((${jdb} - ${jda}) / 365.25 AS INTEGER)`;
      default:       return `TIMESTAMPDIFF(${[unit,a,b].join(',')})`;
    }
  });

  // Passe 5 : DATEDIFF
  s = replaceFn(s, 'DATEDIFF', ([a, b]) => {
    if (!a || !b) return `DATEDIFF(${[a,b].join(',')})`;
    const toJd = v => (/^NOW\s*\(/i.test(v) || /^CURDATE\s*\(/i.test(v))
      ? `julianday('now')` : `julianday(${v})`;
    return `CAST(${toJd(a)} - ${toJd(b)} AS INTEGER)`;
  });

  // Passe 6 : fonctions scalaires simples
  s = s.replace(/\bDATE\s*\(\s*NOW\s*\(\s*\)\s*\)/gi, `date('now')`);
  s = s.replace(/\bNOW\s*\(\s*\)/gi, `datetime('now')`);
  s = s.replace(/\bCURDATE\s*\(\s*\)/gi, `date('now')`);
  s = s.replace(/\bYEAR\s*\(\s*([^)]+?)\s*\)/gi,  (_, col) => `strftime('%Y', ${col.trim()})`);
  s = s.replace(/\bMONTH\s*\(\s*([^)]+?)\s*\)/gi, (_, col) => `strftime('%m', ${col.trim()})`);
  s = s.replace(/\bISNULL\s*\(\s*([^)]+?)\s*\)/gi, (_, col) => `(${col.trim()} IS NULL)`);

  // Passe 7 : CONCAT
  s = s.replace(/\bCONCAT\s*\(/gi, '\x00CONCAT\x00(');
  s = resolveConcat(s);

  // Passe 8 : DML MySQL-spécifique
  s = s.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO');
  s = s.replace(/\s+FOR\s+UPDATE\b/gi, '');
  // VALUES(col) dans ON DUPLICATE KEY → excluded.col (avant de remplacer la clause)
  s = s.replace(/\bVALUES\s*\(\s*(\w+)\s*\)/gi, (_, col) => `excluded.${col}`);
  s = s.replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, 'ON CONFLICT DO UPDATE SET');

  return s;
}

// ── Mode SQLite ───────────────────────────────────────────────────────────────
if (driver !== 'mysql') {
  const sqlite = require('./database');

  const wrap = {
    query(sql, params = []) {
      return Promise.resolve(
        sqlite.prepare(mysqlToSqlite(sql)).all(Array.isArray(params) ? params : [params])
      );
    },
    queryOne(sql, params = []) {
      const row = sqlite.prepare(mysqlToSqlite(sql)).get(Array.isArray(params) ? params : [params]);
      return Promise.resolve(row ?? null);
    },
    execute(sql, params = []) {
      const r = sqlite.prepare(mysqlToSqlite(sql)).run(Array.isArray(params) ? params : [params]);
      return Promise.resolve({ insertId: r.lastInsertRowid, affectedRows: r.changes });
    },
    // Transaction async correcte sur SQLite : BEGIN/COMMIT/ROLLBACK manuels
    // (better-sqlite3 transaction() est synchrone et ne peut pas await des Promises)
    async transaction(fn) {
      sqlite.exec('BEGIN');
      try {
        const result = await fn(wrap);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        try { sqlite.exec('ROLLBACK'); } catch (_) {}
        throw err;
      }
    },
    _raw: sqlite,
  };

  module.exports = wrap;
}

// ── Mode MySQL ────────────────────────────────────────────────────────────────
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
    connectionLimit:    parseInt(process.env.DB_POOL_SIZE, 10) || 50,
    queueLimit:         500,
    supportBigNumbers:  true,
    bigNumberStrings:   false,
    dateStrings:        true,
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000,
  });

  function makeApi(exec) {
    return {
      async query(sql, params = []) {
        const normalized = normalizeMysqlLimitPlaceholders(sql, params);
        const [rows] = await exec(normalized.sql, normalized.params);
        return rows;
      },
      async queryOne(sql, params = []) {
        const normalized = normalizeMysqlLimitPlaceholders(sql, params);
        const [rows] = await exec(normalized.sql, normalized.params);
        return rows[0] ?? null;
      },
      async execute(sql, params = []) {
        const normalized = normalizeMysqlLimitPlaceholders(sql, params);
        const [result] = await exec(normalized.sql, normalized.params);
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

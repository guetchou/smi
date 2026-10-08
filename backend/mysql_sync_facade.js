'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const runner = path.join(__dirname, 'mysql_sync_runner.js');

function normalizeParams(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

function call(kind, sql, params = []) {
  const start=Date.now();
  try {
  const out = execFileSync(process.execPath, [runner, JSON.stringify({ kind, sql, params })], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out ? JSON.parse(out) : {};
  } catch(error) {
    const bb=require('./services/blackbox');
    bb.record('db_error',{code:error.code||'SYNC_QUERY_FAILED',query_kind:kind,fingerprint:bb.HASH(sql),duration_ms:Date.now()-start});
    throw error;
  }
}

function prepare(sql) {
  return {
    all(...args) {
      return call('all', sql, normalizeParams(args)).rows || [];
    },
    get(...args) {
      return call('get', sql, normalizeParams(args)).row || undefined;
    },
    run(...args) {
      return call('run', sql, normalizeParams(args)).result || { lastInsertRowid: 0, changes: 0 };
    },
  };
}

function exec(sql) {
  return call('exec', sql, []).ok;
}

function transaction(fn) {
  return (...args) => fn(...args);
}

function pragma() {
  return undefined;
}

/* Chaque requête ouvre et referme son propre processus : il n'y a pas de
   connexion à fermer. La fonction existe parce que le reste du code appelle
   close() — les quatre bancs isolés le font — et qu'une API qui manque une
   méthode que ses appelants utilisent n'est pas une façade, c'est un piège. */
function close() {}

module.exports = { prepare, exec, transaction, pragma, close };

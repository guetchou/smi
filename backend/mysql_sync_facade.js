'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const runner = path.join(__dirname, 'mysql_sync_runner.js');

function normalizeParams(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

function call(kind, sql, params = []) {
  const out = execFileSync(process.execPath, [runner, JSON.stringify({ kind, sql, params })], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out ? JSON.parse(out) : {};
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

module.exports = { prepare, exec, transaction, pragma };

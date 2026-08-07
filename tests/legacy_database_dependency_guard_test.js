'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backendRoot = path.join(root, 'backend');

// Dépendances better-sqlite3 explicitement limitées au mode/outillage SQLite.
// Elles ne doivent jamais charger mysql_sync_facade en DB_DRIVER=mysql.
const SQLITE_ONLY_ALLOWLIST = new Set([
  'backend/db.js',
  'backend/import-excel.js',
  'backend/services/organization_mutation_schema.js',
]);

// Dette runtime réellement susceptible d'être exécutée avec MySQL.
const MYSQL_RUNTIME_ALLOWLIST = new Set([
  'backend/routes/achats.js',
  'backend/routes/agents.js',
  'backend/routes/agents_ecosystem_safe.js',
  'backend/routes/agents_safe_write.js',
  'backend/routes/offboarding.js',
  'backend/routes/organigramme.js',
  'backend/routes/organization_integrity_safe.js',
  'backend/routes/salaires.js',
  'backend/services/organization_assignment.js',
  'backend/services/organization_department_hierarchy.js',
]);

const LEGACY_ALLOWLIST = new Set([...SQLITE_ONLY_ALLOWLIST, ...MYSQL_RUNTIME_ALLOWLIST]);

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

const legacyRequire = /require\(\s*['"](?:\.\.\/|\.\/)database['"]\s*\)/;
const actual = walk(backendRoot)
  .filter(file => legacyRequire.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(root, file).replace(/\\/g, '/'))
  .sort();

const unexpected = actual.filter(file => !LEGACY_ALLOWLIST.has(file));
const staleAllowlist = [...LEGACY_ALLOWLIST].filter(file => !actual.includes(file)).sort();

assert.deepStrictEqual(unexpected, [], `Nouvelle dépendance interdite à backend/database.js: ${unexpected.join(', ')}`);
assert.deepStrictEqual(staleAllowlist, [], `Allowlist legacy à réduire après migration: ${staleAllowlist.join(', ')}`);

const importExcel = fs.readFileSync(path.join(backendRoot, 'import-excel.js'), 'utf8');
const mutationSchema = fs.readFileSync(path.join(backendRoot, 'services', 'organization_mutation_schema.js'), 'utf8');
assert(importExcel.indexOf("DB_DRIVER || 'sqlite'") < importExcel.indexOf("require('./database')"), 'import-excel must reject MySQL before loading database.js');
assert(mutationSchema.includes("IS_MYSQL_DRIVER ? null : require('../database')"), 'SQLite organization schema helper must not load database.js in MySQL');

console.log(`legacy_database_dependency_guard_test: OK (${MYSQL_RUNTIME_ALLOWLIST.size} dépendances runtime MySQL + ${SQLITE_ONLY_ALLOWLIST.size} exceptions SQLite suivies)`);

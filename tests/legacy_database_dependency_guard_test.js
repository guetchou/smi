'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const backendRoot = path.join(root, 'backend');

// Dette existante au démarrage de P0 #43. Cette liste ne peut que diminuer.
// Toute nouvelle dépendance à backend/database.js doit faire échouer la CI.
const LEGACY_ALLOWLIST = new Set([
  'backend/db.js',
  'backend/import-excel.js',
  'backend/server.js',
  'backend/routes/achats.js',
  'backend/routes/agents.js',
  'backend/routes/agents_ecosystem_safe.js',
  'backend/routes/agents_safe_write.js',
  'backend/routes/offboarding.js',
  'backend/routes/organigramme.js',
  'backend/routes/organization_integrity_safe.js',
  'backend/routes/organization_mutation_workflow.js',
  'backend/routes/salaires.js',
  'backend/routes/users.js',
  'backend/services/organization_assignment.js',
  'backend/services/organization_department_hierarchy.js',
  'backend/services/organization_integrity_audit.js',
  'backend/services/organization_mutation_schema.js',
  'backend/services/organization_mutation_workflow.js',
  'backend/services/parapheur.js',
]);

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

console.log(`legacy_database_dependency_guard_test: OK (${actual.length} dépendances legacy suivies)`);

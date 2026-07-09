'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitStatements } = require('../backend/migrations/runner');

const migrationPath = path.join(__dirname, '..', 'backend', 'migrations', '045_dolibarr_integration_foundation.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const sqlitePath = path.join(__dirname, '..', 'backend', 'database.js');
const sqlite = fs.readFileSync(sqlitePath, 'utf8');
const statements = splitStatements(migration);

assert.strictEqual(statements.length, 3, 'Dolibarr foundation migration must create exactly 3 tables');
assert(statements.every(stmt => /^CREATE TABLE IF NOT EXISTS integration_/i.test(stmt)), 'Migration must only create integration_* tables');
assert(!/\bALTER\s+TABLE\b/i.test(migration), 'Dolibarr foundation migration must not alter existing business tables');
assert(
  statements.every(stmt => !/^(UPDATE|DELETE|TRUNCATE|DROP)\b/i.test(stmt)),
  'Dolibarr foundation migration must not mutate existing data'
);

for (const table of ['integration_links', 'integration_jobs', 'integration_attempts']) {
  assert(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(migration),
    `${table} table is required`
  );
  assert(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sqlite),
    `${table} SQLite fallback is required`
  );
}

assert(/UNIQUE KEY uq_integration_links_provider_local \(provider, local_type, local_id\)/.test(migration));
assert(/UNIQUE KEY uq_integration_links_provider_idempotency \(provider, idempotency_key\)/.test(migration));
assert(/UNIQUE KEY uq_integration_jobs_provider_object \(provider, job_type, local_type, local_id\)/.test(migration));
assert(/status ENUM\('pending','running','synced','failed','retrying','cancelled','blocked'\)/.test(migration));
assert(/request_hash VARCHAR\(128\)/.test(migration));
assert(/CONSTRAINT fk_integration_attempts_job/.test(migration));
assert(/FOREIGN KEY \(job_id\) REFERENCES integration_jobs\(id\)/.test(sqlite));
assert(!/DOLIBARR_API_KEY|DOLAPIKEY|api_key|password|secret/i.test(migration), 'Migration must not contain secrets');

console.log('dolibarr_integration_schema_test: OK');

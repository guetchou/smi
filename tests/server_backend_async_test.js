'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
new Function(source);

assert(source.includes("require('./db')"), 'server must use backend/db.js');
assert(!source.includes("require('./database')"), 'server must not use legacy database.js');
assert(!source.includes('.prepare('), 'server must not use synchronous prepare()');
assert(source.includes("db.execute('UPDATE users SET last_seen_at = NOW()"), 'last-seen write must use async db adapter');
assert(source.includes("CONCAT(e.nom, ' ', COALESCE(e.prenom, ''))"), 'offboarding list query must stay portable through db translator');
assert(source.includes('TIMESTAMPDIFF(HOUR, updated_at, NOW()) >= ?'), 'purchase reminder query must use portable async SQL');
assert(source.includes("const rows = await db.query('SELECT a.*"), 'audit API must use async db query');
assert(source.includes("if (DB_DRIVER !== 'sqlite') return;"), 'file backup must be restricted to SQLite mode');

console.log('server_backend_async_test: OK');

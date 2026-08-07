'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'users.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'users route must use backend/db.js');
assert(!source.includes("require('../database')"), 'users route must not use legacy database.js');
assert(!source.includes('.prepare('), 'users route must not use synchronous prepare()');
assert(source.includes('db.transaction(async tx =>'), 'parameter updates must use a real async transaction');
assert(source.includes("await tx.execute('UPDATE parametres SET valeur=? WHERE cle=?'"), 'parameter updates must run through tx');
assert(source.includes("await tx.execute('INSERT INTO parametres (cle, valeur) VALUES (?, ?)'"), 'new parameters must be inserted through tx');
assert(source.includes("INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES ('parametres'"), 'parameter audit must remain in the same transaction');

console.log('users_backend_async_test: OK');

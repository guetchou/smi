'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'grilles.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'grilles route must use backend/db.js');
assert(!source.includes("require('../database')"), 'grilles route must not use legacy database.js');
assert(!source.includes('.prepare('), 'grilles route must not use synchronous prepare()');
assert(source.includes('await db.query('), 'grilles route must use async query()');
assert(source.includes('await db.queryOne('), 'grilles route must use async queryOne()');
assert(source.includes('await db.execute('), 'grilles route must use async execute()');

console.log('payroll_grids_backend_async_test: OK');

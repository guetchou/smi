'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'services', 'parapheur.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'parapheur connector must use backend/db.js');
assert(!source.includes("require('../database')"), 'parapheur connector must not use legacy database.js');
assert(!source.includes('.prepare('), 'parapheur connector must not use synchronous prepare()');
assert(source.includes('async function creerEntreeParapheur'), 'parapheur connector must expose async creation');
assert(source.includes('await findActiveDuplicate('), 'duplicate lookup must be awaited');
assert(source.includes('await db.execute(`\n      INSERT INTO parapheur'), 'parapheur insert must use async execute');
assert(source.includes('await notifyParapheurTarget('), 'target notification must stay ordered after creation');
assert(source.includes("await auditConnector('created'"), 'connector creation audit must be awaited');

console.log('parapheur_backend_async_test: OK');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'revisions_salaire.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'salary revisions must use backend/db.js');
assert(!source.includes("require('../database')"), 'salary revisions must not use legacy database.js');
assert(!source.includes('.prepare('), 'salary revisions must not use synchronous prepare()');
assert(source.includes("require('../services/parapheur_async')"), 'salary revisions must use async parapheur connector');
assert(source.includes('creerEntreeParapheurDansTransaction'), 'salary revisions must create parapheur inside transaction');
assert(source.includes('db.transaction(async tx =>'), 'salary revisions must use real async transactions');
assert(source.includes('await applyRevision('), 'salary revision application must be awaited');
assert(source.includes('historique_salaires'), 'salary revision application must preserve salary history');

console.log('payroll_revisions_backend_async_test: OK');

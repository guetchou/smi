'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routePath = path.join(__dirname, '..', 'backend', 'routes', 'offboarding_parapheur_required_safe.js');
const asyncServicePath = path.join(__dirname, '..', 'backend', 'services', 'parapheur_async.js');
const routeSource = fs.readFileSync(routePath, 'utf8');
const serviceSource = fs.readFileSync(asyncServicePath, 'utf8');

assert(routeSource.includes("require('../db')"), 'offboarding must use backend/db.js');
assert(!routeSource.includes("require('../database')"), 'offboarding must not use legacy database.js');
assert(!routeSource.includes('.prepare('), 'offboarding must not use synchronous prepare()');
assert(!routeSource.includes('db.transaction(() =>'), 'offboarding must not use pseudo transaction');
assert(routeSource.includes('await dbc.transaction(async (tx) =>'), 'offboarding must use async transaction');
assert(routeSource.includes('failAfterDossier'), 'rollback test hook must exist');
assert(routeSource.includes('await notifierParapheurTarget'), 'notification must run after transaction');
assert(serviceSource.includes('creerEntreeParapheurDansTransaction'), 'async parapheur connector missing');
assert(serviceSource.includes('Transaction DB asynchrone requise'), 'async connector must reject invalid transaction');
assert(serviceSource.includes('connector_${status}'), 'connector audit missing');

console.log('offboarding_parapheur_atomicity_test: OK');

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routePath = path.join(__dirname, '..', 'backend', 'routes', 'offboarding_parapheur_required_safe.js');
const workflowPath = path.join(__dirname, '..', 'backend', 'services', 'offboarding_workflow.js');
const asyncServicePath = path.join(__dirname, '..', 'backend', 'services', 'parapheur_async.js');
const routeSource = fs.readFileSync(routePath, 'utf8');
const workflowSource = fs.readFileSync(workflowPath, 'utf8');
const serviceSource = fs.readFileSync(asyncServicePath, 'utf8');

assert(routeSource.includes("require('../db')"), 'offboarding route must use backend/db.js');
assert(routeSource.includes("require('../services/offboarding_workflow')"), 'route must delegate to isolated workflow');
assert(!routeSource.includes("require('../database')"), 'route must not use legacy database.js');
assert(!routeSource.includes('.prepare('), 'route must not use synchronous prepare()');

assert(workflowSource.includes("require('../db')"), 'workflow must use backend/db.js');
assert(!workflowSource.includes("require('../database')"), 'workflow must not use legacy database.js');
assert(!workflowSource.includes('.prepare('), 'workflow must not use synchronous prepare()');
assert(!workflowSource.includes('db.transaction(() =>'), 'workflow must not use pseudo transaction');
assert(workflowSource.includes('await dbc.transaction(async (tx) =>'), 'workflow must use async transaction');
assert(workflowSource.includes('failAfterDossier'), 'rollback test hook must exist');
assert(workflowSource.includes('await notifierParapheurTarget'), 'notification must run after transaction');

assert(serviceSource.includes('creerEntreeParapheurDansTransaction'), 'async parapheur connector missing');
assert(serviceSource.includes('Transaction DB asynchrone requise'), 'async connector must reject invalid transaction');
assert(serviceSource.includes('connector_${status}'), 'connector audit missing');

console.log('offboarding_parapheur_atomicity_test: OK');

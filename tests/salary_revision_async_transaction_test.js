'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'revisions_salaire.js'), 'utf8');
new Function(source);

assert(source.includes("require('../db')"), 'salary revisions must use backend/db.js');
assert(!source.includes("require('../database')"), 'salary revisions must not use legacy database.js');
assert(!source.includes('.prepare('), 'salary revisions must not use synchronous prepare()');
assert(source.includes('creerEntreeParapheurDansTransaction'), 'RH → parapheur transition must use transaction-aware connector');
assert(source.includes('await db.transaction'), 'salary revisions must use real async transactions');
assert(source.includes('applyRevisionInTransaction'), 'salary application must be isolated inside transaction');
assert(source.includes('SALARY_REVISION_TEST_FAILURE_AFTER_EMPLOYEE_UPDATE'), 'rollback test hook must remain available');
assert(source.includes("INSERT INTO historique_salaires"), 'salary history must remain part of application');

console.log('salary_revision_async_transaction_test: OK');

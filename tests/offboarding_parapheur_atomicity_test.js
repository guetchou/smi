'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('./offboarding_route_async_test');

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
assert(routeSource.includes("router.put('/:id/sortie/valider'"), 'async validation route must intercept legacy validation');
assert(routeSource.includes('await validateOffboarding({'), 'validation route must use async workflow');

assert(workflowSource.includes("require('../db')"), 'workflow must use backend/db.js');
assert(!workflowSource.includes("require('../database')"), 'workflow must not use legacy database.js');
assert(!workflowSource.includes('.prepare('), 'workflow must not use synchronous prepare()');
assert(!workflowSource.includes('db.transaction(() =>'), 'workflow must not use pseudo transaction');
assert(workflowSource.includes('await dbc.transaction(async (tx) =>'), 'workflow must use async transaction');
assert(workflowSource.includes('failAfterDossier'), 'initiation rollback test hook must exist');
assert(workflowSource.includes('failAfterDossierUpdate'), 'validation rollback test hook must exist');
assert(workflowSource.includes('OFFBOARDING_TEST_FAILURE_AFTER_VALIDATION_DOSSIER'), 'validation rollback marker missing');
assert(workflowSource.includes('async function validateOffboarding'), 'async validation workflow missing');
assert(workflowSource.includes("SET statut='valide'"), 'dossier validation update missing');
assert(workflowSource.includes("statut_dossier='sorti'"), 'employee exit update missing');
assert(workflowSource.includes('await notifierParapheurTarget'), 'notification must run after transaction');

assert(serviceSource.includes('creerEntreeParapheurDansTransaction'), 'async parapheur connector missing');
assert(serviceSource.includes('Transaction DB asynchrone requise'), 'async connector must reject invalid transaction');
assert(serviceSource.includes('connector_${status}'), 'connector audit missing');

/* ── La sortie validée referme sa demande au parapheur ──
   Initier une sortie crée une entrée au parapheur ; la valider par la route
   directe ne la refermait pas. La demande restait « en attente assistante »
   pour toujours, et devenait meme intraitable : syncOffboarding ecarte tout
   dossier deja « valide ».
   Constate en production le 10/09/2026 : parapheur 20, « Offboarding — AWELE
   Destie Prephina (demission) », marque urgent, toujours en attente, alors
   que employes_sortie 17 etait validee depuis le 01/09 a 18:46 et que la
   personne etait partie le 03/08. Une personne sortie occupait la file de
   travail de l'assistante, sans aucun moyen de l'en retirer.
   Deux tables tenues separement finissent toujours par diverger. */
const corpsValidation = workflowSource.slice(
  workflowSource.indexOf('async function validateOffboarding'),
);
assert(
  /UPDATE parapheur/.test(corpsValidation),
  'validateOffboarding doit refermer la demande au parapheur : sans cela une '
  + 'sortie validee laisse sa demande ouverte et intraitable',
);
assert(
  /ref_source_table\s*=\s*'employes_sortie'|ref_source_table=\?/.test(corpsValidation),
  'la fermeture doit viser la demande de CE dossier de sortie',
);
assert(
  /statut\s*=\s*'approuve'|statut='approuve'/.test(corpsValidation),
  "la demande doit passer a un statut terminal ('approuve'), sinon "
  + 'findActiveDuplicate la considere toujours active',
);

console.log('offboarding_parapheur_atomicity_test: OK');

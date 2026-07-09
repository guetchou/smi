'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'frontend', 'dashboard.html'), 'utf8');

assert(dashboard.includes('id="dolibarr-integration-panel"'));
assert(dashboard.includes('refreshDolibarrIntegration'));
assert(dashboard.includes('testDolibarrConnection'));
assert(dashboard.includes('retryDolibarrJob'));
assert(dashboard.includes("api('/integrations/dolibarr/status'"));
assert(dashboard.includes("api('/integrations/dolibarr/jobs?limit=25'"));
assert(dashboard.includes("api('/integrations/dolibarr/test'"));
assert(dashboard.includes('`/integrations/dolibarr/jobs/${id}/retry`'));
assert(dashboard.includes("if (tab === 'acces')"));
assert(dashboard.includes('refreshDolibarrIntegration(false)'));
assert(!dashboard.includes('DOLIBARR_API_KEY'));
assert(!dashboard.includes('DOLAPIKEY'));
assert(!/apiKey/i.test(dashboard), 'UI must not reference or expose Dolibarr API keys');

console.log('dolibarr_ui_test: OK');

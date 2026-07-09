'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'backend', 'routes', 'integrations_dolibarr.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');

new Function(route);

assert(route.includes("const { hasRole } = require('./auth');"));
assert(route.includes("const { can } = require('../services/permissions');"));
assert(route.includes('function sanitizeJob(row)'));
assert(route.includes('function sanitizeLink(row)'));
assert(route.includes("router.get('/status'"));
assert(route.includes("router.post('/test'"));
assert(route.includes("router.get('/jobs'"));
assert(route.includes("router.post('/jobs/:id/retry'"));
assert(route.includes("router.get('/links/:type/:id'"));
assert(route.includes('requireIntegrationRead'));
assert(route.includes('requireIntegrationManage'));
assert(route.includes('publicDolibarrConfig'));
assert(!/res\.json\([^)]*apiKey/i.test(route), 'Routes must not serialize apiKey');
assert(!/DOLIBARR_API_KEY|process\.env\.DOLIBARR_API_KEY/.test(route), 'Routes must not read or expose raw API key directly');

assert(server.includes("const dolibarrIntegrationRouter = require('./routes/integrations_dolibarr');"));
assert(server.includes("app.use('/api/integrations/dolibarr', protectedRoute(), dolibarrIntegrationRouter);"));

console.log('dolibarr_routes_test: OK');

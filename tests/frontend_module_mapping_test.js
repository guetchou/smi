// Vérifie que toute page déclarée dans la navigation a un mapping d'accès.
// Ce test évite qu'un module backend assigné devienne invisible côté frontend.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dashboardPath = path.join(__dirname, '..', 'frontend', 'dashboard.html');
const html = fs.readFileSync(dashboardPath, 'utf8');

const navPages = [...html.matchAll(/data-page="([^"]+)"/g)]
  .map(match => match[1]);
const uniqueNavPages = [...new Set(navPages)].sort();

const pageModulesMatch = html.match(/const PAGE_MODULES = \{([\s\S]*?)\n\};/);
assert(pageModulesMatch, 'PAGE_MODULES introuvable dans frontend/dashboard.html');

const mappedPages = [...pageModulesMatch[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)]
  .map(match => match[1]);

const missing = uniqueNavPages.filter(page => !mappedPages.includes(page));
assert.deepStrictEqual(missing, [], `Pages sans mapping PAGE_MODULES: ${missing.join(', ')}`);

console.log(JSON.stringify({ ok: true, navPages: uniqueNavPages.length, mappedPages: mappedPages.length }));

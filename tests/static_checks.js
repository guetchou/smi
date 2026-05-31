// Contrôles statiques anti-dette exécutables sans dépendances externes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function checkFrontendModuleMapping() {
  const html = read('frontend/dashboard.html');
  const navPages = [...html.matchAll(/data-page="([^"]+)"/g)].map(match => match[1]);
  const uniqueNavPages = [...new Set(navPages)].sort();

  const pageModulesMatch = html.match(/const PAGE_MODULES = \{([\s\S]*?)\n\};/);
  assert(pageModulesMatch, 'PAGE_MODULES introuvable dans frontend/dashboard.html');

  const mappedPages = [...pageModulesMatch[1].matchAll(/['"]?([a-zA-Z0-9_-]+)['"]?\s*:/g)]
    .map(match => match[1]);

  const missing = uniqueNavPages.filter(page => !mappedPages.includes(page));
  assert.deepStrictEqual(missing, [], `Pages sans mapping PAGE_MODULES: ${missing.join(', ')}`);

  return { navPages: uniqueNavPages.length, mappedPages: mappedPages.length };
}

function checkComposeNoObsoleteVersion() {
  const compose = read('docker-compose.yml');
  assert(
    !/^\s*version\s*:/m.test(compose),
    'docker-compose.yml contient encore la clé obsolète version:'
  );
  return { composeVersionKey: false };
}

const result = {
  frontendModuleMapping: checkFrontendModuleMapping(),
  compose: checkComposeNoObsoleteVersion(),
};

console.log(JSON.stringify({ ok: true, ...result }));

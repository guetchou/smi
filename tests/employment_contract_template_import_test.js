'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateTemplate } = require('../backend/services/contract_template_engine');

const root = path.join(__dirname, '..');
const model = JSON.parse(fs.readFileSync(
  path.join(root, 'backend/templates/employment-contract-national.json'),
  'utf8',
));
const importer = fs.readFileSync(
  path.join(root, 'scripts/import_employment_contract_source_model.js'),
  'utf8',
);

assert.strictEqual(model.status, 'draft_requires_legal_review');
assert.match(model.sourceDocxSha256, /^[a-f0-9]{64}$/);
assert.strictEqual(
  model.sourceDocxSha256,
  'c638f98d03d2a6167cb7c2b4f1fabb8ced740f596a0077529dbffb49383ec032',
);
assert.strictEqual(validateTemplate(
  { header: model.header, content: model.content, footer: model.footer },
  model.variableCatalog,
).ok, true);

const serializedModel = JSON.stringify(model);
assert(!/employeeRate|employerRate|tax\.brackets|\d+(?:[.,]\d+)?\s*%/i.test(serializedModel), 'Aucun taux legal ne doit etre code dans le modele');
assert(!serializedModel.includes('contact@topcenter.cgm'), 'Adresse historique invalide interdite');

assert(importer.includes("process.env.DB_DRIVER !== 'mysql'"));
assert(importer.includes("process.env.SMI_DB_WRITE_CONFIRMED !== '1'"));
assert(importer.includes('SMI_ACTOR_USER_ID valide requis'));
assert(importer.includes('source_docx_sha256=?'), 'L import doit etre idempotent par checksum source');
assert(importer.includes("'brouillon'"), 'Le modele importe ne doit jamais etre publie automatiquement');

console.log('employment_contract_template_import_test: OK');

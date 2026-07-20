'use strict';

const assert = require('assert');
const { extractVariables, validateTemplate, renderTemplate } = require('../backend/services/contract_template_engine');

const content = {
  title: 'Contrat de {{contrat.type}}',
  articles: [
    { title: 'Parties', paragraphs: ['{{employeur.raison_sociale}} engage {{agent.nom_complet}}.'] },
    { title: 'Salaire', paragraphs: ['Brut : {{remuneration.brut_total}}'] },
  ],
};
const catalog = [
  { path: 'contrat.type', required: true },
  { path: 'employeur.raison_sociale', required: true },
  { path: 'agent.nom_complet', required: true },
  { path: 'remuneration.brut_total', required: true },
];

assert.deepStrictEqual(extractVariables(content), [
  'agent.nom_complet',
  'contrat.type',
  'employeur.raison_sociale',
  'remuneration.brut_total',
]);
assert.strictEqual(validateTemplate(content, catalog).ok, true);

const missing = renderTemplate(content, {
  contrat: { type: 'CDD' },
  employeur: { raison_sociale: 'TOP CENTER' },
  agent: { nom_complet: '' },
  remuneration: { brut_total: '150 000 XAF' },
}, catalog);
assert.strictEqual(missing.ok, false);
assert.deepStrictEqual(missing.missing, ['agent.nom_complet']);
assert(!JSON.stringify(missing.rendered).includes('{{'));

const rendered = renderTemplate(content, {
  contrat: { type: 'CDD' },
  employeur: { raison_sociale: 'TOP CENTER' },
  agent: { nom_complet: 'MATOKO Valmaure Jernhice' },
  remuneration: { brut_total: '150 000 XAF' },
}, catalog);
assert.strictEqual(rendered.ok, true);
assert(JSON.stringify(rendered.rendered).includes('MATOKO Valmaure Jernhice'));

assert.throws(() => validateTemplate({ paragraph: '<script>alert(1)</script>' }, catalog), /dangereux/);
assert.strictEqual(validateTemplate({ paragraph: '{{agent.inconnue}}' }, catalog).ok, false);

console.log('contract_template_engine_test: OK');

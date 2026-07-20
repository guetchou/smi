'use strict';

const assert = require('assert');
const { buildDocx, buildHtml, escapeHtml, money } = require('../backend/services/employment_contract_documents');

const contract = {
  reference: 'CT-TEST-001',
  values_snapshot: JSON.stringify({
    entreprise: { raison_sociale: 'TOP & CENTER', forme_juridique: 'SARL', rccm: 'RCCM', nif: 'NIF', adresse: 'Brazzaville', representant: 'DG' },
    agent: { civilite: 'Monsieur', prenom: 'Jean', nom: '<MATOKO>', matricule: 'MAT-1', date_naissance: '1989-04-05', lieu_naissance: 'Brazzaville', adresse: 'Brazzaville' },
    contrat: { type: 'CDD', fonction: 'Operateur', service: 'Operations', lieu_travail: 'Brazzaville', date_debut: '2026-07-02', date_fin: '2027-01-01' },
  }),
  remuneration_snapshot: JSON.stringify({
    currency: 'XAF', grossTotal: 170000,
    components: [{ label: 'Salaire de base', amount: 150000, displayOnContract: true }],
  }),
  clauses_snapshot: JSON.stringify({ articles: [{ title: 'Objet', body: 'Le salarie exerce ses fonctions.' }] }),
};

assert.strictEqual(escapeHtml('<script>&"'), '&lt;script&gt;&amp;&quot;');
assert.strictEqual(money('invalide'), 'A verifier');
const html = buildHtml(contract);
assert(!html.includes('<MATOKO>'));
assert(html.includes('&lt;MATOKO&gt;'));
assert(html.includes('170\u202f000 XAF') || html.includes('170 000 XAF'));

buildDocx(contract).then(buffer => {
  assert(Buffer.isBuffer(buffer));
  assert(buffer.length > 1000);
  assert.strictEqual(buffer.subarray(0, 2).toString('binary'), 'PK');
  console.log('employment_contract_documents_test: OK');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

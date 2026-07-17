'use strict';

const assert = require('assert');
const {
  assertTransition,
  buildReference,
  validateContractDraft,
} = require('../backend/services/employment_contract_workflow');

assert.doesNotThrow(() => assertTransition('brouillon', 'en_verification'));
assert.doesNotThrow(() => assertTransition('en_verification', 'valide'));
assert.throws(() => assertTransition('brouillon', 'valide'), /Transition interdite/);
assert.throws(() => assertTransition('valide', 'brouillon'), /Transition interdite/);
assert.throws(() => assertTransition('signe', 'annule'), /Transition interdite/);

const employee = {
  id: 7, actif: 1, matricule: 'MAT-0007', nom: 'MATOKO', prenom: 'Valmaura', sexe: 'M',
  date_naissance: '1989-04-05', lieu_naissance: 'Brazzaville', nationalite: 'Congolaise',
  adresse: 'Brazzaville', num_piece_identite: 'ID-001', cnss: 'CNSS-001',
};
const company = {
  id: 1, raison_sociale: 'TOP CENTER', forme_juridique: 'SARL', rccm: 'RCCM-CG', nif: 'NIF-CG',
  adresse: 'Brazzaville', ville: 'Brazzaville', pays: 'Congo', telephone: '+242',
  email: 'contact@topcenter.cg', directeur_general: 'Direction generale', devise: 'XAF',
};
const templateVersion = {
  id: 2,
  statut: 'publie',
  content_json: JSON.stringify({ articles: [{ title: 'Objet', body: '{{agent.prenom}} exerce comme {{contrat.fonction}}.' }] }),
  variable_catalog_json: JSON.stringify([
    { path: 'agent.prenom', required: true },
    { path: 'contrat.fonction', required: true },
  ]),
};
const ruleSet = {
  statut: 'publie',
  social_rules: JSON.stringify({ employeeRate: 4, employerRate: 8 }),
  tax_rules: JSON.stringify({ mode: 'progressive', brackets: [{ from: 0, to: null, rate: 10 }] }),
  rounding_rules: '{}',
};
const input = {
  typeContrat: 'CDD', intitule: 'Contrat operateur', dateDebut: '2026-07-02',
  dureeValeur: 6, dureeUnite: 'mois', dateEndConvention: 'inclusive', fonction: 'Operateur',
  classification: 'A1', service: 'Operations', lieuTravail: 'Brazzaville',
  components: [
    { code: 'BASE', label: 'Salaire de base', category: 'salaire_base', amount: 150000, socialSubject: true, taxSubject: true },
    { code: 'TRANSPORT', label: 'Transport', category: 'indemnite', amount: 20000, socialSubject: false, taxSubject: false },
  ],
  employeeTaxProfile: {},
};

const valid = validateContractDraft({ employee, company, templateVersion, ruleSet, input });
assert.strictEqual(valid.ok, true);
assert.strictEqual(valid.input.dateFin, '2027-01-01');
assert.strictEqual(valid.remuneration.grossTotal, 170000);
assert.match(valid.clauses.articles[0].body, /Valmaura exerce comme Operateur/);

const missingRules = validateContractDraft({ employee, company, templateVersion, ruleSet: null, input });
assert.strictEqual(missingRules.ok, false);
assert(missingRules.errors.includes('regles_sociales_publiees'));
assert(missingRules.errors.includes('bareme_fiscal_publie'));

const badTemplate = validateContractDraft({
  employee, company,
  templateVersion: { ...templateVersion, content_json: '{"body":"{{agent.champ_inconnu}}"}' },
  ruleSet,
  input,
});
assert.strictEqual(badTemplate.ok, false);
assert(badTemplate.errors.includes('variable_inconnue:agent.champ_inconnu'));

const wrongType = validateContractDraft({
  employee, company,
  templateVersion: { ...templateVersion, template_type: 'CDI' },
  ruleSet,
  input,
});
assert(wrongType.errors.includes('modele_incompatible_avec_type_contrat'));

const expiredRules = validateContractDraft({
  employee, company, templateVersion,
  ruleSet: { ...ruleSet, date_effet: '2025-01-01', date_fin: '2025-12-31' },
  input,
});
assert(expiredRules.errors.includes('jeu_regles_hors_periode'));

const invalidDates = validateContractDraft({
  employee, company, templateVersion, ruleSet,
  input: { ...input, dateDebut: '2026-02-31', dateFin: '2026-13-01', dateSignature: 'pas-une-date' },
});
assert(invalidDates.errors.includes('contrat.date_debut'));
assert(invalidDates.errors.includes('contrat.date_fin'));
assert(invalidDates.errors.includes('contrat.date_signature'));

assert.match(buildReference(employee, new Date('2026-07-15T10:00:00Z')), /^CT-20260715-MAT-0007-[A-F0-9]{6}$/);

console.log('employment_contract_workflow_test: OK');

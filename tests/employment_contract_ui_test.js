'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const moduleSource = fs.readFileSync(path.join(root, 'frontend/js/modules/employment-contracts.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');
const navigation = fs.readFileSync(path.join(root, 'frontend/js/core/navigation.js'), 'utf8');

assert(moduleSource.includes('window.TalaEmploymentContracts = { create, escapeHtml }'));
assert(moduleSource.includes('clearTimeout(state.searchTimer)'), 'Recherche non temporisee');
assert(moduleSource.includes('max-height:68vh'), 'Table sans scroll interne borne');
assert(moduleSource.includes('@media(max-width:768px)') && moduleSource.includes('@media(max-width:360px)'), 'Breakpoints mobile absents');
assert(moduleSource.includes('dialog.showModal()'), 'Dialogue natif accessible absent');
assert(moduleSource.includes('escapeHtml(contract.reference)'), 'Donnees serveur non echappees');
assert(moduleSource.includes('getToken()'), 'Telechargement authentifie absent');
assert(moduleSource.includes("can('employment_contract.create')"), 'Actions non filtrees par permission');
assert(moduleSource.includes('Number(contract.created_by) !== Number(getUserId())'), 'Validation propre non masquee');
assert(moduleSource.includes("data-ec-action=\"edit\""), 'Correction des brouillons absente');
assert(moduleSource.includes("method: isEditing ? 'PUT' : 'POST'"), 'Enregistrement des corrections absent');
assert(moduleSource.includes('ec-local-clause'), 'Dispositions particulieres absentes');
assert(moduleSource.includes('modifications non enregistrees'), 'Dirty state absent');
assert(dashboard.includes('id="page-employment-contracts"'));
assert(dashboard.includes('window.initEmploymentContracts = initEmploymentContracts'));
assert(navigation.includes("'employment-contracts': '/app/rh/contrats-travail'"));
assert(navigation.includes("'employment-contracts': ['hr', 'salary']"));

console.log('employment_contract_ui_test: OK');

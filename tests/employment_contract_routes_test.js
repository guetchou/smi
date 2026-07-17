'use strict';

const assert = require('assert');
const fs = require('fs');

const routes = fs.readFileSync(require.resolve('../backend/routes/employment_contracts'), 'utf8');
const server = fs.readFileSync(require.resolve('../backend/server'), 'utf8');
const permissions = fs.readFileSync(require.resolve('../backend/services/permissions'), 'utf8');

[
  "router.post('/', requirePermission('employment_contract.create')",
  "router.put('/:id', requirePermission('employment_contract.create')",
  "router.post('/:id/submit', requirePermission('employment_contract.submit')",
  "router.post('/:id/validate', requirePermission('employment_contract.validate')",
  "router.post('/:id/sign', requirePermission('employment_contract.validate')",
  "router.post('/:id/revise', requirePermission('employment_contract.create')",
  "router.post('/:id/cancel', requirePermission('employment_contract.validate')",
  "router.post('/:id/documents/:format', requirePermission('employment_contract.generate')",
  "router.get('/:id/documents/:documentId/download', requirePermission('employment_contract.view')",
].forEach(marker => assert(routes.includes(marker), `Route ou permission absente: ${marker}`));

assert(routes.includes("current.statut !== 'brouillon'"), 'Immutabilite apres brouillon absente');
assert(routes.includes('le createur ne peut pas valider'), 'Separation createur/validateur absente');
assert(!routes.includes("&& !hasRole(req.user, 'admin')"), 'Aucun role ne doit contourner la separation createur/validateur');
assert(routes.includes('Un contrat actif chevauche cette periode'), 'Detection de chevauchement absente');
assert(routes.includes('L agent d un brouillon existant ne peut pas etre remplace'));
assert(routes.includes("localClause: body.localClause ?? existing.localClause ?? ''"));
assert(routes.includes('header: parseJson(version.header_json, {})'));
assert(routes.includes('footer: parseJson(version.footer_json, {})'));
assert(routes.includes('validatePayrollRules(social, tax)'));
assert((routes.match(/affectedRows !== 1/g) || []).length >= 8, 'Les transitions concurrentes doivent etre detectees');
assert(routes.includes("fs.writeFileSync(storagePath, buffer, { flag: 'wx' })"), 'Ecriture documentaire doit interdire les ecrasements');
assert(routes.includes('fs.unlinkSync(storagePath)'), 'Nettoyage fichier orphelin absent');
assert(routes.includes("resolved.startsWith(path.resolve(documentRoot) + path.sep)"), 'Protection path traversal absente');
assert(routes.includes('process.env.EMPLOYMENT_CONTRACT_DOCUMENT_ROOT'), 'Stockage documentaire E2E non isolable');
assert(server.includes("app.use('/api/employment-contracts', protectedRoute(requireModule(['hr', 'salary'])), employmentContractsRouter)"));
assert(permissions.includes("'employment_contract.validate':           ['admin', 'dg']"));

console.log('employment_contract_routes_test: OK');

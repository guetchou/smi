const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/js/modules/agents.js'),
  'utf8'
);

function loadModule() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'frontend/js/modules/agents.js' });
  return context.window.TalaAgentDossier;
}

function createDocument(initial = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) { return elements.get(id); },
    querySelectorAll() { return []; },
  };
  const set = (id, value = '', checked = false) => {
    elements.set(id, {
      value,
      checked,
      classList: { contains: () => false, add() {}, remove() {} },
    });
  };
  for (const [id, value] of Object.entries(initial)) set(id, value);
  return { document, set };
}

async function testCreateAgentWithPendingChild() {
  const TalaAgentDossier = loadModule();
  const { document, set } = createDocument({
    'agent-id': '',
    'ag-nom': 'BAYI',
    'ag-prenom': 'Caley',
    'enf-prenom': 'Alix',
    'enf-nom': 'Bayi',
  });
  set('enf-charge', '', true);
  const calls = [];
  const dossier = TalaAgentDossier.create({
    document,
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/agents') return { id: 42, nom: 'BAYI' };
      if (url === '/agents/42/enfants') return { id: 8, prenom: 'Alix' };
      if (url === '/config/employes') return [{ id: 42, nom: 'BAYI' }];
      return null;
    },
  });

  const result = await dossier.saveAgent();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.created, true);
  assert.strictEqual(result.agentId, 42);
  assert.deepStrictEqual(calls.map(call => call.url), [
    '/agents',
    '/agents/42/enfants',
    '/config/employes',
  ]);
  assert.strictEqual(result.savedSubforms.length, 1);
  assert.strictEqual(result.savedSubforms[0].type, 'enfant');
}

async function testSalaryRevisionOnUpdate() {
  const TalaAgentDossier = loadModule();
  const { document, set } = createDocument({
    'agent-id': '7',
    'ag-nom': 'BAYI',
    'ag-prenom': 'Caley',
    'ag-salaire-base': '120000',
  });
  let updatedPayload;
  const dossier = TalaAgentDossier.create({
    document,
    requestSalaryRevision: async () => 'Ajustement contractuel',
    request: async (url, options = {}) => {
      if (url === '/agents/7') {
        updatedPayload = JSON.parse(options.body);
        return { ok: true, id: 7 };
      }
      if (url === '/config/employes') return [];
      return null;
    },
  });
  dossier.setInitialSalarySnapshot({ salaire_base: 100000, prime_transport: 0, prime_logement: 0 });

  const result = await dossier.saveAgent();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.created, false);
  assert.strictEqual(updatedPayload.motif, 'Ajustement contractuel');
  assert.strictEqual(updatedPayload.type_revision, 'correction');
}

async function testForcedAnnualLeave() {
  const TalaAgentDossier = loadModule();
  const { document } = createDocument({
    'cg-type': 'annuel',
    'cg-debut': '2026-06-15',
    'cg-fin': '2026-06-17',
  });
  let confirmation;
  let leavePayload;
  const dossier = TalaAgentDossier.create({
    document,
    getLeaveBalance: () => ({ solde: 1 }),
    canForceLeave: () => true,
    confirmLeaveOverdraft: async details => {
      confirmation = details;
      return true;
    },
    request: async (url, options = {}) => {
      assert.strictEqual(url, '/agents/7/conges');
      leavePayload = JSON.parse(options.body);
      return { id: 19 };
    },
  });

  const result = await dossier.saveSubform('conge', 7);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(confirmation.available, 1);
  assert.strictEqual(confirmation.requested, 3);
  assert.strictEqual(leavePayload.force_creation, true);
}

async function testPartialPendingSaveIsReported() {
  const TalaAgentDossier = loadModule();
  const { document } = createDocument({
    'enf-prenom': 'Alix',
    'dip-etablissement': 'Université',
    'dip-intitule': '',
  });
  const calls = [];
  const dossier = TalaAgentDossier.create({
    document,
    request: async url => {
      calls.push(url);
      if (url === '/agents/9/enfants') return { id: 3, prenom: 'Alix' };
      return null;
    },
  });

  const result = await dossier.savePendingSubforms(9);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.type, 'diplome');
  assert.strictEqual(result.saved.length, 1);
  assert.deepStrictEqual(calls, ['/agents/9/enfants']);
}

async function testCancelledConfirmationsDoNotWrite() {
  const TalaAgentDossier = loadModule();
  const salaryForm = createDocument({
    'agent-id': '7',
    'ag-nom': 'BAYI',
    'ag-prenom': 'Caley',
    'ag-salaire-base': '120000',
  });
  let salaryWrites = 0;
  const salaryDossier = TalaAgentDossier.create({
    document: salaryForm.document,
    requestSalaryRevision: async () => null,
    request: async () => {
      salaryWrites++;
      return { ok: true };
    },
  });
  salaryDossier.setInitialSalarySnapshot({ salaire_base: 100000 });
  const salaryResult = await salaryDossier.saveAgent();
  assert.strictEqual(salaryResult.ok, false);
  assert.strictEqual(salaryResult.cancelled, true);
  assert.strictEqual(salaryWrites, 0);

  const leaveForm = createDocument({
    'cg-type': 'annuel',
    'cg-debut': '2026-06-15',
    'cg-fin': '2026-06-17',
  });
  let leaveWrites = 0;
  const leaveDossier = TalaAgentDossier.create({
    document: leaveForm.document,
    getLeaveBalance: () => ({ solde: 1 }),
    canForceLeave: () => true,
    confirmLeaveOverdraft: async () => false,
    request: async () => {
      leaveWrites++;
      return { id: 1 };
    },
  });
  const leaveResult = await leaveDossier.saveSubform('conge', 7);
  assert.strictEqual(leaveResult.ok, false);
  assert.strictEqual(leaveResult.cancelled, true);
  assert.strictEqual(leaveWrites, 0);
}

(async () => {
  await testCreateAgentWithPendingChild();
  await testSalaryRevisionOnUpdate();
  await testForcedAnnualLeave();
  await testPartialPendingSaveIsReported();
  await testCancelledConfirmationsDoNotWrite();
  console.log(JSON.stringify({
    agentDossierWorkflow: true,
    createWithPendingSubform: true,
    salaryRevision: true,
    forcedLeave: true,
    partialSaveReporting: true,
    cancelledConfirmationsDoNotWrite: true,
  }));
})().catch(error => {
  console.error(error);
  process.exit(1);
});

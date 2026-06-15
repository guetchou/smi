const assert = require('assert');

global.window = {};
require('../frontend/js/modules/payroll-revisions.js');

function classList() {
  const values = new Set(['hidden', 'translate-x-full']);
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    toggle: (value, force) => force ? values.add(value) : values.delete(value),
    contains: value => values.has(value),
  };
}

function element(value = '') {
  return { value, textContent: '', innerHTML: '', className: '', classList: classList(), onclick: null };
}

async function run() {
  const ids = [
    'revisions-tbody', 'btn-new-revision', 'rev-search', 'rev-filter-statut', 'rev-filter-type',
    'revisions-nav-badge', 'rev-drawer-agent', 'rev-drawer-badge', 'rev-drawer-infos',
    'rev-drawer-comparateur', 'rev-drawer-motif-text', 'rev-drawer-workflow',
    'rev-drawer-motif-rejet', 'revision-drawer', 'revision-drawer-overlay',
    'rev-drawer-motif-rejet-label', 'rev-drawer-motif-input', 'rev-drawer-motif-confirm',
    'rev-agent-id', 'agent-id', 'ag-nom', 'ag-prenom', 'ag-salaire-base', 'ag-prime-transport',
    'ag-prime-logement', 'rev-agent-nom', 'rev-salaire-actuel', 'rev-salaire-propose',
    'rev-transport', 'rev-logement', 'rev-date-effet', 'rev-motif', 'rev-type', 'rev-comparateur',
    'modal-revision', 'ag-historique-salaire-list', 'dg-revisions-banner', 'dg-revisions-count',
    'dg-revisions-list', 'btn-proposer-revision', 'rev-comp-actuel', 'rev-comp-propose',
    'rev-comp-delta', 'rev-comp-pct',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements['agent-id'].value = '42';
  elements['ag-nom'].value = 'Agent';
  elements['ag-prenom'].value = 'Test';
  elements['ag-salaire-base'].value = '100000';
  elements['ag-prime-transport'].value = '5000';
  elements['ag-prime-logement'].value = '10000';
  elements['rev-agent-id'].value = '42';
  elements['rev-salaire-propose'].value = '120000';
  elements['rev-transport'].value = '5000';
  elements['rev-logement'].value = '10000';
  elements['rev-date-effet'].value = '2026-07-01';
  elements['rev-motif'].value = 'Promotion';
  elements['rev-type'].value = 'promotion';

  const calls = [];
  const notices = [];
  const module = window.TalaPayrollRevisions.create({
    document: { getElementById: id => elements[id] || element() },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/revisions-salaire?limit=100') {
        return [{ id: 9, employe_nom: 'Agent Test', statut: 'soumis_dg', type_revision: 'promotion', salaire_actuel: 100000, salaire_propose: 120000 }];
      }
      if (path === '/revisions-salaire/9') {
        return { id: 9, employe_nom: 'Agent Test', statut: 'soumis_dg', type_revision: 'promotion', salaire_actuel: 100000, salaire_propose: 120000 };
      }
      if (path === '/revisions-salaire') return { id: 10 };
      if (path === '/revisions-salaire/en-attente') return { count: 1, items: [{ id: 9, employe_nom: 'Agent Test', salaire_actuel: 100000, salaire_propose: 120000, type_revision: 'promotion' }] };
      if (path === '/agents/42/historique-salaires') return { historique: [{ ancien_salaire: 100000, nouveau_salaire: 120000, type_revision: 'promotion' }] };
      return { ok: true };
    },
    hasAnyRole: (...roles) => roles.includes('dg') || roles.includes('rh'),
    notify: (message, type) => notices.push({ message, type }),
    setBadge: (id, count) => { elements[id].textContent = String(count); },
  });

  await module.load();
  assert(elements['revisions-tbody'].innerHTML.includes('Agent Test'));
  assert.strictEqual(elements['revisions-nav-badge'].textContent, '1');

  await module.openDrawer(9);
  assert(elements['rev-drawer-workflow'].innerHTML.includes('valider-dg'));
  await module.action(9, 'valider-dg');
  assert(calls.some(call => call.path === '/revisions-salaire/9/valider-dg'));

  await module.save('soumettre');
  const createCall = calls.find(call => call.path === '/revisions-salaire');
  assert.deepStrictEqual(JSON.parse(createCall.options.body), {
    employe_id: 42,
    type_revision: 'promotion',
    date_effet: '2026-07-01',
    salaire_propose: 120000,
    transport_propose: 5000,
    logement_propose: 10000,
    motif: 'Promotion',
  });
  assert(calls.some(call => call.path === '/revisions-salaire/10/soumettre-rh'));

  await module.loadDgBanner();
  assert(elements['dg-revisions-list'].innerHTML.includes('Décider'));
  assert(notices.some(item => item.type === 'success'));

  console.log(JSON.stringify({ payrollRevisionsModule: true, workflow: true, createAndSubmit: true, dgBanner: true }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

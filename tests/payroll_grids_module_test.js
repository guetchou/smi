const assert = require('assert');

global.window = { confirm: () => true };
require('../frontend/js/modules/payroll-grids.js');

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
  return {
    value,
    textContent: '',
    innerHTML: '',
    className: '',
    selectedOptions: [{ value: '', dataset: {} }],
    classList: classList(),
    onchange: null,
  };
}

async function run() {
  const ids = [
    'grilles-tbody', 'btn-new-grille', 'grille-search', 'grille-filter-statut',
    'grille-drawer-titre', 'grille-drawer-code', 'grille-drawer-badge',
    'grille-drawer-infos', 'grille-drawer-workflow', 'categories-tbody',
    'btn-add-categorie', 'echelons-section', 'grille-drawer', 'grille-drawer-overlay',
    'echelons-cat-name', 'btn-add-echelon', 'echelons-tbody', 'agent-id',
    'affg-categorie-id', 'affg-echelon-id', 'affg-grille-id', 'affg-fourchette-info',
    'ag-grille-categorie', 'ag-grille-echelon', 'ag-grille-nom', 'ag-grille-fourchette',
    'ag-hors-borne-alert', 'ag-hors-borne-msg', 'btn-modifier-affectation',
    'modal-affectation-grille',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements['agent-id'].value = '99';
  elements['affg-categorie-id'].value = '10';
  elements['affg-echelon-id'].value = '20';

  const calls = [];
  const notices = [];
  const module = window.TalaPayrollGrids.create({
    document: { getElementById: id => elements[id] || element() },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/grilles') return { grilles: [{ id: 1, code: 'G1', libelle: 'Grille 1', statut: 'brouillon', nb_categories: 1 }] };
      if (path === '/grilles/1') return { grille: { id: 1, code: 'G1', libelle: 'Grille 1', statut: 'soumis' }, categories: [{ id: 10, code: 'A', libelle: 'Cadre' }] };
      if (path === '/grilles/categories/10/echelons') return { echelons: [{ id: 20, echelon: 1, salaire_reference: 100000 }] };
      if (path === '/grilles?statut=valide') return { grilles: [{ id: 2, code: 'GV', libelle: 'Validée' }] };
      if (path === '/grilles/1/valider-dg') return { ok: true };
      if (path === '/grilles/agent/99/affecter') return { ok: true };
      return { ok: true };
    },
    hasAnyRole: (...roles) => roles.includes('dg') || roles.includes('finance'),
    isAdmin: () => false,
    notify: (message, type) => notices.push({ message, type }),
    confirmAction: () => true,
  });

  await module.load();
  assert(elements['grilles-tbody'].innerHTML.includes('Grille 1'));

  await module.openDrawer(1);
  assert(elements['grille-drawer-workflow'].innerHTML.includes('valider-dg'));
  assert(elements['categories-tbody'].innerHTML.includes('Cadre'));

  await module.loadEchelons(10, 'Cadre');
  assert(elements['echelons-tbody'].innerHTML.includes('100\u202f000') || elements['echelons-tbody'].innerHTML.includes('100 000'));

  assert.strictEqual(await module.workflowAction(1, 'valider-dg'), true);
  assert(calls.some(call => call.path === '/grilles/1/valider-dg'));

  assert.strictEqual(await module.saveAssignment(), true);
  const assignmentCall = calls.find(call => call.path === '/grilles/agent/99/affecter');
  assert.deepStrictEqual(JSON.parse(assignmentCall.options.body), {
    grille_categorie_id: 10,
    grille_echelon_id: 20,
  });
  assert(notices.some(item => item.type === 'success'));

  console.log(JSON.stringify({ payrollGridsModule: true, workflow: true, assignment: true }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

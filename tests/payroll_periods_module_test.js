const assert = require('assert');

global.window = {};
require('../frontend/js/modules/payroll-periods.js');

function classList() {
  const values = new Set(['hidden', 'translate-x-full']);
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    toggle: (value, force) => force ? values.add(value) : values.delete(value),
    contains: value => values.has(value),
  };
}

function element() {
  return { textContent: '', innerHTML: '', value: '', className: '', classList: classList(), onclick: null };
}

async function run() {
  const ids = [
    'periodes-timeline', 'periodes-nav-badge', 'btn-new-periode', 'pd-titre', 'pd-sous-titre',
    'pd-badge', 'pd-kpis', 'pd-bulletins-bar', 'pd-anomalies', 'pd-details-content',
    'pd-entrants-sortants', 'pd-info-validation', 'pd-workflow', 'pd-notes-panel',
    'periode-drawer', 'periode-drawer-overlay', 'pd-rouvrir-motif-wrap', 'pd-notes-input',
    'pd-notes-confirm', 'pd-rouvrir-motif',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  const calls = [];
  const notices = [];
  const period = {
    id: 7, mois: 6, annee: 2026, statut: 'controle_finance',
    synthese: {
      nb_total: 2, nb_paye: 0, nb_valide: 2, nb_brouillon: 0,
      total_brut: 200000, total_net: 170000, total_charges_patronales: 30000,
      total_avances_retenues: 0, total_primes: 10000,
      anomalies: [{ gravite: 'bloquant', message: 'Bulletin incomplet' }],
    },
  };
  const periods = window.TalaPayrollPeriods.create({
    document: { getElementById: id => elements[id] },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/paie/periodes') return [period];
      if (path === '/paie/periodes/7') return period;
      return { ok: true };
    },
    hasAnyRole: (...roles) => roles.includes('finance'),
    isAdmin: () => false,
    notify: (message, type) => notices.push({ message, type }),
    formatMoney: value => `${value || 0} XAF`,
  });

  const loaded = await periods.load();
  assert.strictEqual(loaded.length, 1);
  assert(elements['periodes-timeline'].innerHTML.includes('Juin 2026'));

  await periods.openDrawer(7);
  assert(elements['pd-workflow'].innerHTML.includes('disabled'));
  assert(elements['pd-workflow'].innerHTML.includes('Soumettre au DG'));

  period.synthese.anomalies = [];
  await periods.openDrawer(7);
  assert(!elements['pd-workflow'].innerHTML.includes('disabled'));
  await periods.action(7, 'soumettre-dg');
  const actionCall = calls.find(call => call.path === '/paie/periodes/7/soumettre-dg');
  assert(actionCall);
  assert.deepStrictEqual(JSON.parse(actionCall.options.body), {});
  assert(notices.some(item => item.type === 'success'));

  console.log(JSON.stringify({
    payrollPeriodsModule: true,
    blockingAnomalyGuard: true,
    workflowAction: true,
  }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');

global.window = {};
require('../frontend/js/modules/payroll-rectifications.js');

function element(value = '') {
  const classes = new Set(['hidden']);
  return {
    value,
    textContent: '',
    className: '',
    disabled: false,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

async function run() {
  const elements = {
    'rectif-agent': element(),
    'rectif-periode': element(),
    'rectif-net': element(),
    'rectif-type': element(),
    'rectif-sens': element(),
    'rectif-montant': element(),
    'rectif-motif': element(),
    'rectif-error': element(),
    'rectif-preview': element(),
    'rectif-submit': element(),
    'modal-rectification-bulletin': element(),
  };
  const calls = [];
  let reloadCount = 0;

  const workflow = window.TalaPayrollRectifications.create({
    document: { getElementById: id => elements[id] },
    getRows: () => [{
      nom: 'BAYI',
      prenom: 'Caley',
      bulletin: { id: 7, statut: 'paye', mois: 5, annee: 2026, net_a_payer: 250000 },
    }],
    canRectify: () => true,
    request: async (path, options) => {
      calls.push({ path, options });
      return { id: 12 };
    },
    confirmAction: async () => true,
    notify: () => {},
    formatMoney: value => String(value),
    reload: () => { reloadCount += 1; },
    monthNames: ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai'],
  });

  assert.strictEqual(workflow.open(7), true);
  assert.strictEqual(elements['rectif-agent'].textContent, 'BAYI Caley');
  assert.strictEqual(elements['modal-rectification-bulletin'].classList.contains('hidden'), false);

  elements['rectif-montant'].value = '15 000';
  elements['rectif-motif'].value = 'Prime oubliée';
  elements['rectif-type'].value = 'erreur_prime';
  elements['rectif-sens'].value = 'credit_agent';

  assert.strictEqual(await workflow.submit(), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, '/salaires/bulletin/7/rectification');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    type: 'erreur_prime',
    sens: 'credit_agent',
    montant: 15000,
    motif: 'Prime oubliée',
  });
  assert.strictEqual(reloadCount, 1);
  assert.strictEqual(workflow.getCurrentBulletinId(), null);

  console.log(JSON.stringify({ payrollRectificationsModule: true }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});


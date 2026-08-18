const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = {};
require('../frontend/js/modules/payroll-cycle.js');

function element(value = '') {
  const classes = new Set(['hidden']);
  return {
    value,
    textContent: '',
    title: '',
    checked: false,
    indeterminate: false,
    disabled: false,
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

async function run() {
  const elements = {
    'sal-mois': element('5'),
    'sal-annee': element('2026'),
    'sal-bulk-actions': element(),
    'sal-selection-summary': element(),
    'sal-bulk-validate': element(),
    'sal-bulk-pay': element(),
    'sal-select-all': element(),
  };
  const calls = [];
  const notifications = [];
  let periodAllowed = false;

  const cycle = window.TalaPayrollCycle.create({
    document: { getElementById: id => elements[id] },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.startsWith('/salaires/rapport')) {
        return { periode_paie: { statut: periodAllowed ? 'validee_dg' : 'brouillon' } };
      }
      if (path.endsWith('/payer')) return { net_a_payer: 250000 };
      return { traites: [1], refuses: [], erreurs: [] };
    },
    confirmAction: async () => true,
    notify: (message, type) => notifications.push({ message, type }),
    formatMoney: value => String(value),
    canFinance: () => true,
    canPayPeriod: period => period?.statut === 'validee_dg',
    renderPeriodGate: () => {},
  });

  cycle.setRows([
    { nom: 'A', prenom: 'Un', bulletin: { id: 1, statut: 'brouillon', net_a_payer: 100000 } },
    { nom: 'B', prenom: 'Deux', bulletin: { id: 2, statut: 'valide', net_a_payer: 250000 } },
    { nom: 'C', prenom: 'Trois', bulletin: { id: 3, statut: 'paye', net_a_payer: 300000 } },
  ]);

  assert.strictEqual(cycle.toggleSelection(3, true), false, 'Un bulletin payé reste non sélectionnable');
  assert.strictEqual(cycle.toggleSelection(2, true), true);
  assert.deepStrictEqual(cycle.getSelectedRows().map(row => row.bulletin.id), [2]);

  assert.strictEqual(await cycle.payOne(2, 'B Deux'), false, 'Paiement bloqué avant validation DG');
  assert.strictEqual(calls.filter(call => call.path.endsWith('/payer')).length, 0);

  periodAllowed = true;
  assert.strictEqual(await cycle.payOne(2, 'B Deux'), true);
  assert.strictEqual(calls.filter(call => call.path === '/salaires/bulletin/2/payer').length, 1);
  assert(notifications.some(item => item.type === 'success'));

  assert.strictEqual(typeof window.TalaPayrollCycle.openProfessionalPreview, 'function');
  assert.strictEqual(typeof window.TalaPayrollCycle.openAgentFromBulletin, 'function');
  assert.strictEqual(typeof window.TalaPayrollCycle.openAgentCompensation, 'function');

  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/modules/payroll-cycle.js'), 'utf8');
  assert(source.includes("window.showPage('agents')"), 'Modifier doit ouvrir la page Agents');
  assert(source.includes("document.getElementById('ag-salaire-base')"), 'Le dossier doit cibler la section rémunération');
  assert(source.includes('BULLETIN DE SALAIRE'), 'L’aperçu professionnel doit utiliser le nouveau bulletin');
  assert(source.includes('Ouvrir le dossier rémunération'), 'L’aperçu doit relier vers le dossier rémunération');
  assert(source.includes("dialog.addEventListener('cancel'"), 'Le dialogue doit gérer la fermeture clavier');
  assert(source.includes('opener?.focus?.()'), 'Le focus doit revenir au déclencheur après fermeture');

  console.log(JSON.stringify({
    payrollCycleModule: true,
    paidBulletinLocked: true,
    dgGateEnforced: true,
    professionalPreview: true,
    compensationDeepLink: true,
  }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

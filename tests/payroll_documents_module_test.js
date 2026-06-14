const assert = require('assert');

global.window = { fetch: () => {} };
require('../frontend/js/modules/payroll-documents.js');

function element(value = '') {
  return { value, disabled: false, textContent: '', innerHTML: '' };
}

async function run() {
  const elements = {
    'sal-mois': element('5'),
    'sal-annee': element('2026'),
    'btn-envoi-groupe': element(),
    'btn-email-bulletin': element(),
  };
  const calls = [];
  const notices = [];
  const documents = window.TalaPayrollDocuments.create({
    document: {
      getElementById: id => elements[id],
      createElement: () => ({ click() {} }),
    },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.startsWith('/salaires/rapport')) {
        return { employes: [{ email: 'agent@example.com', bulletin: { statut: 'paye' } }] };
      }
      if (path === '/salaires/envoyer-groupe') {
        return { envoyes: 1, echecs: 0, ignores: 0, sans_email: 0, total_bulletins: 1 };
      }
      if (path.endsWith('/email')) return { ok: true, envoye_a: 'agent@example.com' };
      return [];
    },
    confirmAction: async () => true,
    promptAction: async () => 'agent@example.com',
    notify: (message, type) => notices.push({ message, type }),
    alertAction: () => {},
    reload: () => {},
    monthNames: ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai'],
  });

  assert.strictEqual(await documents.sendGroup({ seulement_echecs: true }), true);
  const groupCall = calls.find(call => call.path === '/salaires/envoyer-groupe');
  assert.deepStrictEqual(JSON.parse(groupCall.options.body), {
    mois: 5,
    annee: 2026,
    seulement_echecs: true,
    forcer_renvoi: false,
  });

  assert.strictEqual(await documents.sendEmail(42, '', 'Agent Test'), true);
  const emailCall = calls.find(call => call.path === '/salaires/bulletin/42/email');
  assert.deepStrictEqual(JSON.parse(emailCall.options.body), { email_override: 'agent@example.com' });
  assert(notices.some(item => item.type === 'success'));

  console.log(JSON.stringify({ payrollDocumentsModule: true, groupPayload: true, emailValidation: true }));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});


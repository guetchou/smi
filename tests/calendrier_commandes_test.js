'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/dashboard.html'), 'utf8');
const code = source.match(/^async function calFiscalLoad\(\) \{[\s\S]*?^\}/m)[0];
const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
(async () => {
  for (const notes of ['', 'L’échéance "ACME" : l\'original & <annexe>\nDeuxième ligne']) {
    const elements = {};
    const doc = { getElementById: id => elements[id] || (elements[id] = { value:'2026', textContent:'', innerHTML:'' }) };
    const record = { id:9, statut:'en_retard', montant_du:123, notes, type_obligation:'test', periode_libelle:'Octobre', date_echeance:'2026-10-01' };
    const context = { document:doc, api:async()=>({stats:{},list:[record]}), setNavBadge(){}, CAL_FISCAL_TYPES:{test:{label:'Test',color:''}}, CAL_FISCAL_STATUTS:{en_retard:{label:'En retard',cls:''}}, esc };
    await vm.runInNewContext(code + ';calFiscalLoad()', context);
    const html = elements['cal-fiscal-tbody'].innerHTML;
    const handlers = [...html.matchAll(/onclick="([^"]*)"/g)];
    assert.equal(handlers.length, 2, 'La ligne et le bouton ont chacun une commande complète');
    for (const [, encoded] of handlers) {
      const handler = encoded.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
      let received;
      new Function('openCalFiscalModal','event',handler)((...args)=>{received=args}, {stopPropagation(){}});
      assert.deepEqual(received,[9,'en_retard',123,notes]);
    }
  }
  console.log('Calendrier : commandes complètes et notes avec guillemets, apostrophes et retours à la ligne vérifiées');
})().catch(error=>{console.error(error);process.exitCode=1});

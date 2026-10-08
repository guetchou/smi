const fs = require('fs'), assert = require('assert');
let chromium; try { ({chromium}=require('@playwright/test')); } catch(error) { if(error.code!=='MODULE_NOT_FOUND')throw error; ({chromium}=require('playwright')); }
const path = require('path');
const dir = fs.mkdtempSync(require('os').tmpdir() + '/smi-form-tests-');
const frontend = path.resolve(__dirname, '../frontend');
const source = fs.readFileSync(frontend + '/dashboard.html', 'utf8');
const moduleCode = fs.readFileSync(frontend + '/form-experience.js', 'utf8');
function modal(id) {
  const start = source.indexOf('<div id="' + id + '"');
  const tokens = /<div\b[^>]*>|<\/div>/g; tokens.lastIndex = start;
  let depth = 0, match;
  while ((match = tokens.exec(source))) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return source.slice(start, tokens.lastIndex);
  }
  throw Error('Modal incomplete: ' + id);
}
const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(x => x[1]).join('\n');
const fixture = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + styles +
  '\n*{box-sizing:border-box}.hidden{display:none!important}.fixed{position:fixed}.inset-0{inset:0}.modal-overlay{display:flex;align-items:center;justify-content:center}.border-b{border-bottom:1px solid var(--c-border)}.border-t{border-top:1px solid var(--c-border)}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.items-center{align-items:center}.ml-auto{margin-left:auto}.text-xs{font-size:12px}.text-lg{font-size:18px}.gap-3{gap:12px}.block{display:block}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}</style>' +
  ['modal-encaissement','modal-decaissement','modal-virement'].map(modal).join('');
let checks = 0, browser;
function check(actual, expected, note) { assert.deepStrictEqual(actual, expected, note); checks++; }
(async () => {
  const options = { headless:true, args:['--no-sandbox'] };
  for (const executable of ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome']) if (fs.existsSync(executable)) { options.executablePath=executable; break; }
  browser = await chromium.launch(options);
  const context = await browser.newContext({viewport:{width:1024,height:768}});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.fulfill({status:200,contentType:'text/html',body:fixture}));
  async function load(user=9001, changed=false) {
    await page.goto('http://smi-fixture.test/');
    await page.evaluate(({user,changed}) => {
      localStorage.setItem('tc_user',JSON.stringify({id:user}));
      window.fixtureConfirmation = false;
      window.fixtureSubmissions = 0;
      window.showConfirm = async () => window.fixtureConfirmation;
      window.closeOperationModals = () => ['modal-encaissement','modal-decaissement','modal-virement'].forEach(id => document.getElementById(id).classList.add('hidden'));
      for(const el of document.querySelectorAll('[oninput],[onchange],[onfocus]')) {
        for(const attr of ['oninput','onchange','onfocus']) for(const m of (el.getAttribute(attr)||'').matchAll(/\b([A-Za-z_]\w*)\(/g)) {
          if(!(m[1] in window)) window[m[1]] = () => {};
        }
      }
      window.updateSimpleOperationImpact = () => { document.getElementById('enc-submit').disabled=false; document.getElementById('dec-submit').disabled=false; };
      window.updateVirementImpact = () => { document.getElementById('vir-submit').disabled=false; };
      for(const el of document.querySelectorAll('select')) {
        const values=el.id.endsWith('-mode') ? [['especes','Espèces'],['cheque','Chèque'],['virement','Virement'],['mobile','Mobile money'],['compensation','Compensation'],['autre','Autre'],['carte','Carte']] :
          /position|source|destination/.test(el.id) ? [['1','Compte A'],['2','Compte B'],['3','Compte C']] : [['1','Type A'],['2','Type B']];
        el.replaceChildren(new Option('Choisir',''),...values.map(([v,t])=>new Option(t,v)));
      }
      for(const id of ['enc-date','dec-date','vir-date']) document.getElementById(id).value=changed?'2026-10-08':'2026-10-07';
    },{user,changed});
    await page.evaluate(()=>{const date=document.getElementById('enc-date');date._flatpickr={setDate(value){window.fixturePickerDate=value;}};});
    await page.addScriptTag({content:moduleCode});
    await page.evaluate(() => {
      for(const id of ['form-encaissement','form-decaissement','form-virement']) document.getElementById(id).addEventListener('submit',event=>{event.preventDefault();window.fixtureSubmissions++;});
      document.getElementById('modal-encaissement').classList.remove('hidden');
      SmiForms.open('modal-encaissement');
    });
  }
  await load();
  check(await page.locator('#enc-submit').isVisible(),false,'Final action hidden on first step');
  check(await page.locator('#enc-nuit').isVisible(),false,'Balance summary hidden before final step');
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 1 sur 5 — Date');
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-field-error:visible').count(),0,'No pristine errors');
  await page.fill('#enc-date','');
  await page.getByRole('button',{name:/^Continuer$/}).click();
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 1 sur 5 — Date','Missing date blocks progress');
  check(await page.locator('#enc-date-smi-error').textContent(),'Renseignez ce champ.');
  await page.fill('#enc-date','2026-10-06');
  await page.press('#enc-date','Enter');
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 2 sur 5 — Origine et montant','Enter moves one step without submitting');
  await page.fill('#enc-tiers','Fixture QA');
  await page.fill('#enc-montant','0');
  check(await page.locator('#enc-montant-smi-error').isVisible(),true,'Inline amount error');
  await page.getByRole('button',{name:/^Continuer$/}).click();
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 2 sur 5 — Origine et montant','Invalid amount blocks step');
  await page.fill('#enc-montant','12000');
  await page.fill('#enc-libelle','Description du test isolé.');
  check(await page.locator('#enc-montant-smi-error').isVisible(),false,'Correction clears error');
  await page.getByRole('button',{name:/^Continuer$/}).click();
  check(await page.locator('#enc-position').isVisible(),false,'Small select replaced by radios');
  await page.locator('#enc-rubrique-smi-label').locator('..').getByRole('radio',{name:'Type A'}).check();
  await page.getByRole('button',{name:/^Continuer$/}).click();
  await page.locator('#enc-position-smi-label').locator('..').getByRole('radio',{name:'Compte A'}).check();
  await page.getByRole('button',{name:/^Continuer$/}).click();
  check(await page.locator('#enc-submit').isVisible(),true,'Final action appears on last step');
  check(await page.evaluate(()=>document.getElementById('enc-nuit').parentElement.classList.contains('operation-modal-footer')),true,'Balance summary stays in footer');
  await page.evaluate(()=>{
    document.getElementById('enc-nuit-avant').textContent='12 575 000 XAF';
    document.getElementById('enc-nuit-apres').textContent='12 575 001 XAF';
    updateSimpleOperationImpact('enc');
  });
  check(await page.evaluate(()=>{const c=document.getElementById('enc-nuit-carte');const r=c.getBoundingClientRect();return r.width>=78&&r.width<=250&&c.scrollWidth<=c.clientWidth+1;}),true,'Footer balance is compact without truncating large amounts');
  check(await page.evaluate(()=>document.getElementById('enc-nuit-carte').getAttribute('aria-label').includes('12 575 001 XAF')),true,'Accessible balance updates with displayed amounts');

  await page.locator('#enc-nuit-carte').click();
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 4 sur 5 — Compte destinataire','Balance button returns to account choice');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  check(await page.locator('#enc-mode').isVisible(),true,'Large list remains select');

  await page.selectOption('#enc-mode','especes');
  check(await page.locator('#enc-position').inputValue(),'1','Radio writes original data field');
  await page.locator('#enc-submit').click();
  check(await page.evaluate(()=>window.fixtureSubmissions),1,'Only final valid step reaches submit handler');
  check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('smi-form-v1:9001:modal-encaissement:'))),true,'Failure leaves draft');
  await load();
  check(await page.locator('#enc-tiers').inputValue(),'Fixture QA','Refresh resumes same-account draft');
  check(await page.locator('#enc-montant').inputValue(),'12000','Amount restored');
  check(await page.locator('#enc-date').inputValue(),'2026-10-06','Draft date survives calendar initialization');
  check(await page.evaluate(()=>window.fixturePickerDate),'2026-10-06','Calendar selection matches restored draft');
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 5 sur 5 — Paiement','Step restored');
  await page.getByRole('button',{name:'Annuler',exact:true}).click();
  check(await page.locator('#modal-encaissement').isVisible(),true,'Declining closure preserves open form');
  await page.evaluate(()=>window.fixtureConfirmation=true);
  await page.getByRole('button',{name:'Annuler',exact:true}).click();
  check(await page.locator('#modal-encaissement').isVisible(),false,'Confirmed closure works');
  check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('smi-form-v1:9001:modal-encaissement:'))),true,'Closure preserves draft');
  await load(9002);
  check(await page.locator('#enc-tiers').inputValue(),'','Other account does not receive draft');
  await load(9001,true);
  check(await page.locator('#enc-tiers').inputValue(),'','Stale draft does not overwrite changed baseline');
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-draft-notice').textContent(),'Les données ont changé. La fiche à jour est affichée.');
  await load();
  await page.evaluate(()=>SmiForms.saved());
  check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('smi-form-v1:9001:modal-encaissement:'))),false,'Success clears draft');
  for(const width of [320,768,1024,1440]) {
    await page.setViewportSize({width,height:800});
    const layout=await page.evaluate(()=>{const m=document.querySelector('#modal-encaissement>.modal');const b=m.getBoundingClientRect();return {left:b.left,right:b.right,viewport:innerWidth,columns:getComputedStyle([...document.querySelectorAll('#modal-encaissement .operation-modal-grid')].find(el=>el.getClientRects().length)).gridTemplateColumns};});
    check(layout.left>=0&&layout.right<=layout.viewport,true,'Modal contained at '+width);
    check(layout.columns.split(' ').length,1,'Single column at '+width);
  }
  await page.evaluate(()=>{
    closeOperationModals();document.getElementById('modal-virement').classList.remove('hidden');SmiForms.open('modal-virement');
  });
  await page.getByRole('button',{name:/^Continuer$/}).click();
  await page.locator('#vir-source-smi-label').locator('..').getByRole('radio',{name:'Compte A'}).check();
  check(await page.locator('#vir-destination-smi-error').isVisible(),false,'No warning on untouched destination');
  await page.locator('#vir-destination-smi-label').locator('..').getByRole('radio',{name:'Compte A'}).check();
  check(await page.locator('#vir-destination-smi-error').textContent(),'Choisissez un compte différent du compte source.','Same-account transfer rejected inline');
  await page.locator('#vir-destination-smi-label').locator('..').getByRole('radio',{name:'Compte B'}).check();
  check(await page.locator('#vir-destination-smi-error').isVisible(),false,'Transfer correction clears error');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 3 sur 4 — Montant');
  await page.fill('#vir-montant','1');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 4 sur 4 — Description');
  check(await page.evaluate(()=>document.getElementById('vir-nuit').parentElement.classList.contains('operation-modal-footer')),true,'Transfer balance is compact in footer');
  await page.evaluate(()=>{
    closeOperationModals();document.getElementById('modal-decaissement').classList.remove('hidden');SmiForms.open('modal-decaissement');
  });
  check(await page.locator('.smi-guided-modal:not(.hidden) .smi-form-step').textContent(),'Étape 1 sur 5 — Justificatif','Expense flow attached');
  await page.evaluate(()=>{const el=document.getElementById('dec-mode');el.options[el.options.length-1].remove();SmiForms.open('modal-decaissement');});
  check(await page.evaluate(()=>document.getElementById('dec-mode').hidden),true,'Six choices use cards, not a dropdown');
  check(await page.locator('#dec-mode').locator('..').locator('input[type=radio]').count(),6,'Six native radio choices');
  check(errors,[],'No runtime errors');
  fs.writeFileSync(dir+'/browser-test-results.json',JSON.stringify({checks,passed:true,environment:'isolated fixtures, no production connection'}));
  console.log(JSON.stringify({browserChecks:checks,passed:true,productionWrites:0}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close()});

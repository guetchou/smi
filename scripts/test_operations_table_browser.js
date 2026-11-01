'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{chromium}=require('playwright');
const root=path.join(__dirname,'..');
(async()=>{const browser=await chromium.launch({headless:true});try{
const page=await browser.newPage({viewport:{width:1024,height:900}});
await page.setContent('<style>*{box-sizing:border-box}body{margin:12px;font-family:Arial}main{min-width:0}</style><main id="table"></main>');
await page.addStyleTag({path:path.join(root,'frontend/css/operations-table.css')});
await page.addScriptTag({path:path.join(root,'frontend/js/modules/operations-table.js')});
await page.evaluate(()=>{
 window.__requests=[];window.__fail=false;
 const records=Array.from({length:31},(_,i)=>({id:i+1,date:'2026-10-'+String(i%28+1).padStart(2,'0'),num_piece:'REC-'+String(i+1).padStart(3,'0'),libelle:i===0?'<img src=x onerror="window.injected=true">':'Opération '+(i+1),tiers:i%2?'Alice':'Bob',montant:i+0.25,type_op:i%3?'encaissement':'decaissement',position_libelle:'Caisse principale',position_id:1,mode_reglement:'especes'}));
 window.__controller=new TalaOperationsTable.Controller(async url=>{
 __requests.push(url);if(url==='/operations/positions')return [{id:1,libelle:'Caisse principale'}];
 if(__fail)return null;const q=new URLSearchParams(url.split('?')[1]);let rows=records.filter(o=>(!q.get('search')||(o.libelle+' '+o.tiers+' '+o.num_piece).toLowerCase().includes(q.get('search').toLowerCase()))&&(!q.get('type_op')||o.type_op===q.get('type_op')));
 const totaux={total_enc:rows.filter(o=>o.type_op==='encaissement').reduce((s,o)=>s+o.montant,0),total_dec:rows.filter(o=>o.type_op==='decaissement').reduce((s,o)=>s+o.montant,0)};
 const field={reference:'num_piece',libelle:'libelle',compte:'position_libelle',montant:'montant',date:'date'}[q.get('sort')];rows.sort((a,b)=>(a[field]>b[field]?1:a[field]<b[field]?-1:0)*(q.get('order')==='ASC'?1:-1));const total=rows.length;return {total,totaux,rows:rows.slice(+q.get('offset'),+q.get('offset')+(+q.get('limit')))};
 });__controller.mount(document.getElementById('table'));
});
await page.getByText('1–10 sur 31 mouvements',{exact:true}).waitFor();
assert.equal(await page.locator('tbody tr').count(),10);
await page.getByRole('button',{name:'Suivant',exact:true}).click();await page.getByText('11–20 sur 31 mouvements',{exact:true}).waitFor();
await page.getByRole('button',{name:'Trier par Montant',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('tbody tr .smi-ot-amount')?.textContent.includes('0,25'));
assert((await page.locator('tbody tr').first().innerText()).includes('<img src=x'));
assert.equal(await page.evaluate(()=>window.injected),undefined);
await page.locator('[data-detail="1"]').click();await page.getByRole('dialog').waitFor();
assert(await page.getByRole('heading',{name:'Détail du mouvement'}).isVisible());await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.evaluate(()=>document.activeElement.dataset.detail),'1');
await page.locator('[data-filter="search"]').fill('Alice');await page.getByText('1–10 sur 15 mouvements',{exact:true}).waitFor();
await page.locator('[data-filter="type"]').selectOption('decaissement');await page.getByText('1–5 sur 5 mouvements',{exact:true}).waitFor();
assert((await page.locator('.smi-ot-totals').innerText()).includes('Encaissements\n0 XAF'));
await page.evaluate(()=>{window.__csv='';URL.createObjectURL=blob=>{blob.text().then(text=>window.__csv=text);return 'blob:test'};HTMLAnchorElement.prototype.click=function(){};});
await page.getByRole('button',{name:'Exporter CSV',exact:true}).click();await page.waitForFunction(()=>window.__csv.includes('REC-'));
assert.equal((await page.evaluate(()=>__csv)).split('\r\n').length,6);
assert(await page.evaluate(()=>__requests.some(u=>u.includes('limit=500')&&u.includes('search=Alice')&&u.includes('type_op=decaissement'))));
await page.evaluate(()=>window.__fail=true);await page.getByRole('button',{name:'Actualiser',exact:true}).click();await page.getByRole('button',{name:'Réessayer',exact:true}).waitFor();assert(await page.getByRole('button',{name:'Exporter CSV',exact:true}).isDisabled());
await page.evaluate(()=>window.__fail=false);await page.getByRole('button',{name:'Réessayer',exact:true}).click();await page.getByText('1–5 sur 5 mouvements',{exact:true}).waitFor();
await page.getByRole('button',{name:'Réinitialiser',exact:true}).click();await page.getByText('1–10 sur 31 mouvements',{exact:true}).waitFor();
await page.locator('summary').click();await page.locator('[data-column="reference"]').uncheck();assert.equal(await page.getByRole('button',{name:'Trier par Référence'}).count(),0);await page.locator('summary').click();
for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page overflow '+width);}
await page.locator('[data-filter="period"]').selectOption('custom');await page.locator('[data-filter="from"]').fill('2026-11-10');await page.locator('[data-filter="to"]').fill('2026-11-01');assert.equal(await page.locator('[data-filter="to"]').evaluate(el=>el.validity.valid),false);
console.log('Tableau: tri global, pagination, filtres, CSV complet, detail, clavier, erreurs et quatre largeurs verifies');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

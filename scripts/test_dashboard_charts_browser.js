'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'frontend/dashboard.html'),'utf8');
const css=source.match(/<style id="smi-dashboard-charts-20261022">([\s\S]*?)<\/style>/)[1];
(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1024,height:768}});
await page.setContent('<style>*{box-sizing:border-box}body{margin:16px;font-family:Arial}#positions-list{max-width:360px}'+css+'</style><div id="positions-list"></div><div class="dc-monthly"><h4>Évolution du mois</h4><div id="dashboard-monthly-chart"></div></div><div id="recent-ops"></div>');
await page.addScriptTag({path:path.join(root,'frontend/js/modules/dashboard-charts.js')});
await page.evaluate(()=>{TalaDashboardCharts.renderPositions([{libelle:'Caisse principale (Bureau)',solde:10000000},{libelle:'Banque',solde:-1000000},{libelle:'Chèques',solde:0}]);TalaDashboardCharts.renderMonthly([{date:'2026-10-01',recettes:100000,depenses:50000},{date:'2026-10-03',recettes:250000,depenses:70000}])});
assert(await page.getByText('-1 000 000 XAF',{exact:true}).isVisible());assert.equal(await page.locator('.dc-bar-negative').count(),1);
await page.getByText('Voir les montants quotidiens',{exact:true}).click();assert(await page.getByText('2026-10-02',{exact:true}).isVisible());

const renderer=source.slice(source.indexOf('function renderFluxRecents('),source.indexOf('\nfunction switchFluxPeriode('));
await page.evaluate(fn=>{
window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
window.fmt=n=>new Intl.NumberFormat('fr-FR',{maximumFractionDigits:2}).format(Number(n))+' XAF';
window.fmtDate=d=>d;window._fluxPeriodes=[{key:'aujourd_hui',label:"Aujourd'hui"},{key:'mois',label:'Ce mois'}];
window.eval(fn);window.__tableFixture={aujourd_hui:{encaissements:100.25,decaissements:25.5},dernieres_ops_scope:'today',dernieres_ops:[
{date:'2026-10-01',type_op:'encaissement',montant:100.25,libelle:'<script>window.__qaInjected=true</script>',categorie_nom:'Prestation',position_libelle:'Caisse'},
{date:'2026-10-02',type_op:'decaissement',montant:25.5,libelle:'Dépense',position_libelle:'Banque'},
{date:'2026-10-03',type_op:'virement',montant:50,libelle:'Transfert',position_libelle:'Caisse'},
{date:'2026-10-04',type_op:'encaissement',montant:1,libelle:'Libellé très long '.repeat(25),position_libelle:'Compte'.repeat(30)}]};
renderFluxRecents(window.__tableFixture,'aujourd_hui');
},renderer);
assert.deepEqual(await page.locator('#recent-ops thead th').allTextContents(),['Date','Opération','Compte','Montant']);
assert.equal(await page.locator('#recent-ops tbody tr').count(),4);
assert(await page.locator('#recent-ops table').getByText('+100,25 XAF',{exact:true}).isVisible());assert(await page.locator('#recent-ops table').getByText('-25,5 XAF',{exact:true}).isVisible());
assert.equal(await page.locator('#recent-ops script').count(),0);assert.equal(await page.evaluate(()=>window.__qaInjected),undefined);

for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:800});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Aucun débordement '+width);assert(await page.locator('#dashboard-monthly-chart svg').isVisible())}

await page.evaluate(()=>renderFluxRecents({dernieres_ops:[]},'aujourd_hui'));assert(await page.getByText('Aucune opération validée disponible.',{exact:true}).isVisible());assert.equal(await page.locator('#recent-ops tbody td[colspan="4"]').count(),1);
await page.evaluate(()=>TalaDashboardCharts.renderMonthly([]));assert(await page.getByText('Aucun mouvement sur le mois sélectionné.',{exact:true}).isVisible());assert.equal(await page.locator('#dashboard-monthly-chart svg').count(),0);console.log('Graphiques : solde negatif, donnees quotidiennes, mois vide et 4 largeurs verifies');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});

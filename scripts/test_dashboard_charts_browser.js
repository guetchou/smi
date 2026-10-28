'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'frontend/dashboard.html'),'utf8');
const css=source.match(/<style id="smi-dashboard-charts-20261022">([\s\S]*?)<\/style>/)[1];
(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1024,height:768}});
await page.setContent('<style>*{box-sizing:border-box}body{margin:16px;font-family:Arial}#positions-list{max-width:360px}'+css+'</style><div id="positions-list"></div><div class="dc-monthly"><h4>Évolution du mois</h4><div id="dashboard-monthly-chart"></div></div>');
await page.addScriptTag({path:path.join(root,'frontend/js/modules/dashboard-charts.js')});
await page.evaluate(()=>{TalaDashboardCharts.renderPositions([{libelle:'Caisse principale (Bureau)',solde:10000000},{libelle:'Banque',solde:-1000000},{libelle:'Chèques',solde:0}]);TalaDashboardCharts.renderMonthly([{date:'2026-10-01',recettes:100000,depenses:50000},{date:'2026-10-03',recettes:250000,depenses:70000}])});
assert(await page.getByText('-1 000 000 XAF',{exact:true}).isVisible());assert.equal(await page.locator('.dc-bar-negative').count(),1);
await page.getByText('Voir les montants quotidiens',{exact:true}).click();assert(await page.getByText('2026-10-02',{exact:true}).isVisible());
for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:800});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Aucun débordement '+width);assert(await page.locator('#dashboard-monthly-chart svg').isVisible())}
await page.evaluate(()=>TalaDashboardCharts.renderMonthly([]));assert(await page.getByText('Aucun mouvement sur le mois sélectionné.',{exact:true}).isVisible());assert.equal(await page.locator('#dashboard-monthly-chart svg').count(),0);console.log('Graphiques : solde negatif, donnees quotidiennes, mois vide et 4 largeurs verifies');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});

const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const s=fs.readFileSync(path.join(__dirname,'../frontend/dashboard.html'),'utf8');
const elements=new Map();function node(id){if(!elements.has(id))elements.set(id,{classList:{toggle(){}},hidden:false,textContent:'',innerHTML:'',getContext:()=>({})});return elements.get(id)}
const charts=[];function Chart(ctx,config){this.config=config;this.destroy=()=>{this.destroyed=true};charts.push(this)}
const c={document:{getElementById:node,querySelector:node},Chart,shortMoney:v=>String(v),esc:v=>String(v).replace(/</g,'&lt;'),_bilanChart:null};vm.createContext(c);
vm.runInContext(s.slice(s.indexOf('function renderBilanChart('),s.indexOf('async function loadBilan() {',s.indexOf('function renderBilanChart('))),c);
const data={meta:{devise:'XAF'},tresorerie:{evolution:[{date:'2026-05-07',encaissements:'1200000',decaissements:0},{date:'2026-05-12',encaissements:1800000,decaissements:0}]}};
c.renderBilanChart(data);let config=charts.at(-1).config;
assert.deepEqual(Array.from(config.data.datasets[0].data),[1200000,1800000]);assert.equal(config.data.datasets.length,1);
assert.equal(config.options.plugins.datalabels.display,false,'Pas de doubles valeurs');assert.equal(config.options.scales.y.beginAtZero,true);assert.equal(config.options.animation,false);
data.tresorerie.evolution[1].decaissements='25000';c.renderBilanChart(data);config=charts.at(-1).config;assert.equal(config.data.datasets.length,2);assert.deepEqual(Array.from(config.data.datasets[1].data),[0,25000]);assert(charts[0].destroyed);
data.tresorerie.evolution=[];c.renderBilanChart(data);assert.equal(c._bilanChart,null);assert.equal(node('#page-bilan .bf-chart-wrap').hidden,true);
console.log('Bilan graphique : nombres MySQL, deux flux, période vide et absence de doublons vérifiés');

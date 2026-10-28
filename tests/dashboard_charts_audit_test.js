'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const charts=require('../frontend/js/modules/dashboard-charts');
const m=charts.positionModel([{libelle:'Caisse',solde:'1000'},{libelle:'Banque',solde:-250},{libelle:'Chèques',solde:0}]);
assert.equal(m[0].value,1000);assert.equal(m[1].value,-250);assert.equal(m[1].width,12.5);assert.equal(m[2].width,0);
const markup=charts.positionsMarkup([{libelle:'<script>alerte</script>',solde:-250}]);
assert(!markup.includes('<script>'));assert(markup.includes('dc-bar-negative'));assert(markup.includes('left:0%;width:50%'));
assert(charts.monthlyMarkup([]).includes('Aucun mouvement'));
assert(!charts.monthlyMarkup([{date:'2026-10-01',recettes:0,depenses:0}]).includes('<svg'));
assert.deepEqual(charts.dailyModel([{date:'2026-10-02',recettes:'100',depenses:5},{date:'2026-10-01',encaissements:20,decaissements:3},{date:'2026-10-02',recettes:7,depenses:2}]),[{date:'2026-10-01',receipt:20,payment:3},{date:'2026-10-02',receipt:107,payment:7}]);
const graphic=charts.monthlyMarkup([{date:'2026-10-01',recettes:1000,depenses:500}]);assert(graphic.includes('Voir les montants quotidiens'));assert(graphic.includes('height="120"'));assert(graphic.includes('height="60"'));
const {buildAuditFilters}=require('../backend/services/audit_read');const a=buildAuditFilters({action:'created,create,creer'});
assert(a.where.includes('IN (?,?,?)'));assert.deepEqual(a.params,['created','create','creer']);assert.deepEqual(buildAuditFilters({action:'create,create'}).params,['create']);
assert.throws(()=>buildAuditFilters({action:'create,,creer'}));const injection=buildAuditFilters({action:"x' OR 1=1 --,create"});assert(!injection.where.includes('OR 1'));assert.equal(injection.params[0],"x' OR 1=1 --");
const source=fs.readFileSync(path.join(__dirname,'../frontend/dashboard.html'),'utf8');const fn=source.match(/^function _fillAuditSelects\([^\n]*[\s\S]*?^\}/m)[0];const selects={};for(const id of ['audit-filter-module','audit-filter-action','audit-filter-user'])selects[id]={options:[],appendChild(o){this.options.push(o)}};
const ctx={document:{getElementById:id=>selects[id],createElement:()=>({})},_auditModuleLabels:{},_auditActionLabels:{create:'Créé',created:'Créé',creer:'Créé',updated:'Modifié'}};vm.createContext(ctx);vm.runInContext(fn,ctx);ctx._fillAuditSelects({modules:[],users:[],actions:['create','created','creer','updated']});assert.equal(selects['audit-filter-action'].options.length,2);assert.equal(selects['audit-filter-action'].options[0].value,'create,created,creer');
console.log('Graphiques signes, echelle commune, vide, protection HTML et filtres regroupes verifies');

assert.equal(charts.dailyModel([{date:'2026-10-01',recettes:100},{date:'2026-10-03',recettes:200}])[1].receipt,0);

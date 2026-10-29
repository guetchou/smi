'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const Database=require(path.join(__dirname,'../backend/node_modules/better-sqlite3'));
const sql=new Database(':memory:');
sql.function('CURDATE',()=> '2026-10-29');sql.function('NOW',()=> '2026-10-29');
sql.function('DATE_FORMAT',(v,f)=>String(v).slice(0,7));
sql.exec(`
CREATE TABLE operations(id INTEGER,date TEXT,num_piece TEXT,libelle TEXT,type_op TEXT,montant REAL,statut TEXT,dec_statut TEXT,position_id INTEGER,position_source_id INTEGER,categorie_id INTEGER,created_by INTEGER,created_at TEXT);
CREATE TABLE positions(id INTEGER,code TEXT,libelle TEXT,type TEXT,solde_initial REAL,actif INTEGER);
CREATE TABLE categories(id INTEGER,nom TEXT);CREATE TABLE users(id INTEGER,nom TEXT);
CREATE TABLE parametres(cle TEXT,valeur TEXT);CREATE TABLE parapheur(statut TEXT);
CREATE TABLE rapprochements_lignes(operation_id INTEGER,rapproche INTEGER);
INSERT INTO positions VALUES(1,'CAISSE','Caisse','caisse',0,1);
INSERT INTO parametres VALUES('seuil_alerte','100');
`);
const ins=sql.prepare("INSERT INTO operations(id,date,type_op,montant,statut,dec_statut,position_id,created_by,created_at) VALUES(?,'2026-10-29',?,?,?,?,1,1,'2026-10-29')");
[[1,'encaissement',1200.5,'valide',null],[2,'decaissement',300.25,'valide','paye'],[3,'encaissement',900000,'annule',null],[4,'encaissement',200000,'brouillon',null],[5,'decaissement',70000,'brouillon','soumis'],[6,'virement',150,'valide',null]].forEach(r=>ins.run(...r));
function query(text,params=[]){assert.match(text.trim(),/^SELECT/i);text=text.replace(/NOW\(\) - INTERVAL (\d+) DAY/g,(_,n)=>"'2026-10-29','-"+n+" days'");return sql.prepare(text).all(...params)}
const db={query:async(...a)=>query(...a),queryOne:async(...a)=>query(...a)[0]};
const routes={};const router={get:(p,f)=>routes[p]=f};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/routes/dashboard.js'),'utf8'),{require:n=>{if(n==='express')return {Router:()=>router};if(n==='../db')return db;if(n==='./auth')return {hasRole:(u,...r)=>r.includes(u.role)};throw Error(n)},module:{exports:{}},console,Date,Number});
async function invoke(route,role,query={}){let result,status=200;await routes[route]({user:{id:1,role},query},{status(n){status=n;return this},json(v){result=v}});assert.equal(status,200,JSON.stringify(result));return result}
(async()=>{
for(const role of ['admin','dg','finance','caissier','assistante_direction','lecteur']){
const r=await invoke('/home',role);const d=r.data;
if(role==='finance'){for(const p of ['jour','semaine','mois'])assert.deepEqual(JSON.parse(JSON.stringify(d.flux[p])),{enc:1200.5,dec:300.25})}
else{assert.equal(d.today.enc,1200.5);assert.equal(d.today.dec,300.25);assert.equal(d.today.net,900.25);if(d.today.nb!==undefined)assert.equal(d.today.nb,2);if(d.mois)assert.equal(d.mois.nb,2)}
console.log('OK /home '+role+' : seuls flux validés et décimales exactes');
}
for(const periode of ['jour','semaine','mois']){const r=await invoke('/flux','admin',{periode});assert.equal(r.encaissements,1200.5);assert.equal(r.decaissements,300.25);assert.equal(r.nb_ops,2);assert.equal(r.solde_net,900.25);console.log('OK /flux '+periode)}
sql.close();
})().catch(e=>{console.error(e);process.exitCode=1});

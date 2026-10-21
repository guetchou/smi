'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'backend/routes/parapheur.js'),'utf8'),html=fs.readFileSync(path.join(root,'frontend/dashboard.html'),'utf8');
const handler=source.match(/^async function listParapheurUsers\([\s\S]*?^\}/m)[0];
const client=html.match(/^async function loadParapheurUsersList\([\s\S]*?^\}/m)[0];
(async()=>{
 let calls=0;
 for(const role of ['admin','dg','manager','assistante_direction','delegue','caissier','lecteur']){
  let status=200,data;
  const res={status(code){status=code;return this},json(value){data=value;return this}};
  await vm.runInNewContext(handler+';listParapheurUsers(req,res)',{req:{user:{role}},res,requireAnyRole:(user,...roles)=>roles.includes(user.role),db:{query:async sql=>{calls++;assert(sql.startsWith('SELECT id, nom, prenom, role'));assert(sql.includes('actif = 1'));assert(!/email|password/i.test(sql));return [{id:2,nom:'Nom',prenom:null,role:'dg'}]}}});
  if(['caissier','lecteur'].includes(role))assert.equal(status,403);else{assert.equal(status,200);assert.equal(data.data[0].id,2)}
 }
 assert.equal(calls,5);
 let requests=0;const selectors={absent:{replaceChildren(...options){this.options=options}},'pi-remplacant':{replaceChildren(...options){this.options=options}}};
 const context={document:{getElementById:id=>selectors[id]},Option:function(text,value){this.text=text;this.value=value},api:async route=>{requests++;assert.equal(route,'/parapheur/utilisateurs');return {ok:true,data:[{id:2,nom:'<Personne>',prenom:null,role:'dg'}]}},_roleLabels:{dg:'Directeur général'}};
 const list=await vm.runInNewContext(client+";loadParapheurUsersList('absent')",context);
 context.existing=list;await vm.runInNewContext("loadParapheurUsersList('pi-remplacant',existing)",context);
 assert.equal(requests,1);assert.equal(selectors.absent.options[0].value,'');assert.equal(selectors['pi-remplacant'].options[0].text,'Aucun remplaçant');assert.equal(selectors.absent.options[1].text,'<Personne> — Directeur général');
 console.log('Parapheur : route active, droits, liste minimale, noms lisibles et absence de sélection implicite vérifiés');
})().catch(error=>{console.error(error);process.exitCode=1});

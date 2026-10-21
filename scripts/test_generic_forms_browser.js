'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'frontend/dashboard.html'),'utf8');
const functions=['ensureGenericModal','closeGenericModal','prepareGenericForm','openGenericModal'].map(name=>{
 const code=source.match(new RegExp('^(?:async )?function '+name+'\\([^\\n]*[\\s\\S]*?^\\}','m'))?.[0];
 assert(code,'Fonction '+name+' présente'); return code;
}).join('\n');
const styles=['smi-ui-review-20261021','smi-generic-form-progress'].map(id=>source.match(new RegExp('<style id="'+id+'">([\\s\\S]*?)<\\/style>'))?.[1]||'').join('\n');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.setContent('<style>'+fs.readFileSync(path.join(root,'frontend/tailwind.css'),'utf8')+'\n'+styles+'</style>');
  await page.evaluate(code=>(0,eval)(code),functions);
  await page.evaluate(()=>{
   window.confirmed=0;
   const fields=Array.from({length:9},(_,i)=>'<div><label class="label" for="field'+i+'">'+(i===0?'Nom *':i===1?'Email *':'Champ '+i)+'</label><input class="input-field" id="field'+i+'" type="'+(i===1?'email':i===3?'date':i===4?'number':'text')+'"></div>').join('');
   openGenericModal({title:'Création',size:'lg',body:'<div class="grid grid-cols-2 gap-4">'+fields+'</div>',onConfirm:()=>{window.confirmed++;return false}});
  });
  assert(await page.getByText('Étape 1 sur 2',{exact:true}).isVisible());
  assert(!await page.locator('#generic-modal-confirm').isVisible());
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  assert(await page.getByText('Étape 1 sur 2',{exact:true}).isVisible());
  await page.locator('#field0').fill('Exemple');await page.locator('#field1').fill('invalide');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  assert(await page.getByText('Étape 1 sur 2',{exact:true}).isVisible());
  await page.locator('#field1').fill('exemple@example.invalid');
  const positions=await page.evaluate(()=>{const label=document.querySelector('label[for=field0]').getBoundingClientRect(),field=document.getElementById('field0').getBoundingClientRect();return {above:label.bottom<=field.top+1,date:document.getElementById('field3').getBoundingClientRect().width,box:document.getElementById('generic-modal').firstElementChild.getBoundingClientRect().width}});
  assert(positions.above);assert(positions.date<=180);assert(positions.box<=640);
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  await page.locator('#field8').fill('Saisie conservée');
  await page.getByRole('button',{name:'Retour',exact:true}).click();
  assert.equal(await page.locator('#field0').inputValue(),'Exemple');
  await page.getByRole('button',{name:'Continuer',exact:true}).click();
  assert.equal(await page.locator('#field8').inputValue(),'Saisie conservée');
  await page.locator('#generic-modal-confirm').click();
  assert.equal(await page.evaluate(()=>confirmed),1);
  await page.setViewportSize({width:320,height:700});
  const overflow=await page.evaluate(()=>{const box=document.getElementById('generic-modal').firstElementChild.getBoundingClientRect();return box.left<0||box.right>innerWidth+1||[...document.querySelectorAll('#generic-modal-body input')].filter(e=>e.getBoundingClientRect().width>0).some(e=>e.getBoundingClientRect().right>innerWidth+1)});
  assert(!overflow);
  await page.evaluate(async()=>{await closeGenericModal(true);openGenericModal({title:'Lecture',body:'<p>Consultation</p>',confirmLabel:null,cancelLabel:'Fermer'})});
  assert(await page.getByRole('button',{name:'Fermer',exact:true}).isVisible());
  assert.equal(await page.getByRole('button',{name:'Continuer',exact:true}).count(),0);
  console.log('Formulaires : étapes, erreurs, retour sans perte, confirmation, libellés et largeur mobile vérifiés');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});

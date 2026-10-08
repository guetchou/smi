'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require('path').join(__dirname,'../frontend/dashboard.html'),'utf8');
const extract=name=>{const m=html.match(new RegExp('(?:async )?function '+name+'\\([^)]*\\)[\\s\\S]*?\\n}'));assert(m,name);return m[0];};
(async()=>{
 let release,calls=0,refreshes=0,closed=0,toasts=[];
 const wait=new Promise(r=>release=r);
 const ctx={window:{SmiForms:{saved(){}}},document:{getElementById:()=>({classList:{contains:()=>true}})},showToast:(...x)=>toasts.push(x),closeOperationModals:()=>closed++,cadrerTableauDeBordSurOperation(){},refreshDashboard:()=>refreshes++,cadrerListeSurOperation(){},loadOperations(){},esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),api:async()=>{calls++;await wait;return{id:42,num_piece:'REC-42',date:'2026-10-08'};}};
 vm.createContext(ctx);vm.runInContext('const _actionLock=new Set();\n'+['withLock','afterOperationSaved','submitOperation'].map(extract).join('\n'),ctx);
 const first=ctx.withLock('form-encaissement',()=>ctx.submitOperation('',{date:'2026-10-08'}));
 await ctx.withLock('form-encaissement',()=>ctx.submitOperation('',{}));
 assert.equal(calls,1);release();await first;
 assert.equal(closed,1);assert.equal(refreshes,1);assert(toasts.some(x=>x[0]==='Opération enregistrée — REC-42'&&x[1]==='success'&&x[2]===6000));
 ctx.afterOperationSaved('2026-10-08',{num_piece:'<img>'});assert(toasts.at(-1)[0].includes('&lt;img&gt;'));
 ctx.api=async()=>null;const before=closed;await ctx.submitOperation('',{});assert.equal(closed,before);
 let tried=0;await assert.rejects(ctx.withLock('x',async()=>{throw Error('test');}));await ctx.withLock('x',async()=>tried++);assert.equal(tried,1);
 console.log('Operation submit: one request while busy, reference confirmation, escaping, failure preservation and lock release passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

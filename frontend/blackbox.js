(function(){
'use strict';if(window.SmiBlackBox)return;
const traceId=crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2);
let queue=[],sender=null,sending=false,timer=0,backoff=0;
const last=new Map(),safe=s=>String(s||'').replace(/[^a-zA-Z0-9_:.\/-]/g,'').slice(0,160);
const route=()=>location.pathname.split('?')[0].slice(0,160);
function fingerprint(s){let h=2166136261;for(const c of String(s||''))h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0).toString(16);}
function record(type,data={}){
 try{const key=type+':'+JSON.stringify(data),now=Date.now();if(now-(last.get(key)||0)<1000)return;last.set(key,now);if(last.size>100)last.delete(last.keys().next().value);
 queue.push({type,trace_id:traceId,path:route(),...data});if(queue.length>80)queue.shift();schedule();
 }catch(_){}
}
function schedule(){if(!timer)timer=setTimeout(()=>{timer=0;void flush();},5000);}
async function flush(){if(!sender||sending||!queue.length||Date.now()<backoff)return;sending=true;const batch=queue.splice(0,20);
 try{const response=await sender(batch);if(!response.ok){if(response.status!==401&&response.status!==403)queue=batch.concat(queue).slice(-80);backoff=Date.now()+60000;}}
 catch(_){queue=batch.concat(queue).slice(-80);backoff=Date.now()+60000;}
 finally{sending=false;if(queue.length)schedule();}
}
addEventListener('error',e=>{
 if(e.target!==window){record('ui_resource_error',{code:'RESOURCE_FAILED',field:safe(e.target?.tagName)});return;}
 record('ui_error',{fingerprint:fingerprint(e.message),code:safe(e.error?.name||'JS_ERROR'),file:(()=>{try{return new URL(e.filename,location.href).pathname;}catch(_){return '';}})(),line:e.lineno||0,column:e.colno||0});
},true);
addEventListener('unhandledrejection',e=>record('ui_rejection',{code:safe(e.reason?.name||'PROMISE_ERROR'),fingerprint:fingerprint(e.reason?.message||e.reason)}));
document.addEventListener('invalid',e=>record('ui_invalid',{field:safe(e.target.id||e.target.name||e.target.tagName),code:e.target.validity?.valueMissing?'REQUIRED':e.target.validity?.rangeUnderflow?'TOO_SMALL':e.target.validity?.rangeOverflow?'TOO_LARGE':'INVALID'}),true);
document.addEventListener('click',e=>{const el=e.target.closest?.('button,a,[role="button"]');if(el)record('ui_action',{action:safe(el.id||el.getAttribute('onclick')?.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1]||el.tagName),field:safe(el.closest('form')?.id)});},true);
document.addEventListener('submit',e=>record('ui_submit',{field:safe(e.target.id)}),true);
let layoutTimer=0;
function layout(){clearTimeout(layoutTimer);layoutTimer=setTimeout(()=>{
 if(document.documentElement.scrollWidth>innerWidth+4)record('ui_layout',{code:'PAGE_OVERFLOW'});
 for(const el of [...document.querySelectorAll('[role="dialog"],.modal.open')].slice(0,10)){const r=el.getBoundingClientRect();if(r.width&&r.height&&(r.left< -4||r.right>innerWidth+4||r.top< -4||r.bottom>innerHeight+4))record('ui_layout',{code:'DIALOG_OUTSIDE_VIEW',field:safe(el.id)});}
},1000);}
addEventListener('resize',layout);document.addEventListener('DOMContentLoaded',()=>{layout();new MutationObserver(changes=>{layout();for(const x of changes){if(x.type==='attributes'&&x.target.getAttribute('aria-invalid')==='true')record('ui_invalid',{code:'INVALID',field:safe(x.target.id||x.target.name||x.target.tagName)});}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-invalid']});},{once:true});
addEventListener('popstate',()=>record('ui_route',{code:'NAVIGATION'}));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flush();});
window.SmiBlackBox={traceId,record,flush,configure(fn){sender=fn;schedule();},network(path,method,status,requestId){
 if(String(path).includes('/diagnostics'))return;
 if(status>=400)record('ui_network',{status,code:safe(method),request_id:safe(requestId)});
},status:()=>({queued:queue.length,active:!!sender})};
})();

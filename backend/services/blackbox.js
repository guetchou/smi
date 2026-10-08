'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const {AsyncLocalStorage}=require('async_hooks');
const context=new AsyncLocalStorage();
const HASH=s=>crypto.createHash('sha256').update(String(s||'')).digest('hex').slice(0,24);
const build=(()=>{try{return HASH(fs.readFileSync(path.join(__dirname,'..','..','frontend','dashboard.html')));}catch(_){return 'unknown';}})();
const id=s=>String(s||'').slice(0,300).replace(/[^a-zA-Z0-9_:.\/-]/g,'').slice(0,160);
function errorOrigin(e){const m=String(e?.stack||'').split('\n').slice(1).join('\n').match(/(\/[a-zA-Z0-9_./-]+):(\d+):(\d+)/);return m?{file:m[1],line:Number(m[2]),column:Number(m[3])}:{};}
const safePath=s=>String(s||'').split('?')[0].split('#')[0].replace(/[^a-zA-Z0-9_\/.-]/g,'').slice(0,220);
function createRecorder(dir=path.join(__dirname,'..','data','blackbox'),options={}){
 const maxBytes=options.maxBytes||1024*1024, retentionMs=30*86400000;
 const file=path.join(dir,'events.jsonl');let queue=[],running=false,dropped=0,written=0,lastFailure=null;
 const ready=fs.promises.mkdir(dir,{recursive:true,mode:0o700}).then(()=>prune()).catch(e=>{lastFailure=e.code||'IO_ERROR';});
 async function prune(){for(const name of ['events.jsonl','events.jsonl.1','events.jsonl.2','events.jsonl.3','fatal.json']){
  try{const p=path.join(dir,name),st=await fs.promises.stat(p);if(Date.now()-st.mtimeMs>retentionMs)await fs.promises.unlink(p);}catch(e){if(e.code!=='ENOENT')throw e;}
 }}
 async function rotate(){let n=0;try{n=(await fs.promises.stat(file)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(n<maxBytes)return;
 try{await fs.promises.unlink(file+'.3');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(let k=2;k>=0;k--){try{await fs.promises.rename(k?file+'.'+k:file,file+'.'+(k+1));}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 async function drain(){if(running)return;running=true;await ready;
 while(queue.length){const batch=queue.splice(0,20).join('');try{await prune();await rotate();await fs.promises.appendFile(file,batch,{mode:0o600});written+=batch.split('\n').length-1;lastFailure=null;}catch(e){dropped+=batch.split('\n').length-1;lastFailure=e.code||'IO_ERROR';}}
 running=false;
 }
 function record(type,data={}){
 try{if(queue.length>=500){dropped++;return;}
 const c=context.getStore(),r={t:new Date().toISOString(),type:id(type),request_id:c?.requestId||null,user_id:c?.req?.user?.id||null,build};
 const fields=['source','file','code','fingerprint','method','path','status','duration_ms','field','action','trace_id','build','line','column','query_kind','request_id'];
 for(const key of fields){const v=data[key];if(v===undefined)continue;r[key]=typeof v==='number'&&Number.isFinite(v)?v:(key==='path'?safePath(v):id(v));}
 queue.push(JSON.stringify(r)+'\n');void drain();
 }catch(_){dropped++;}
 }
 async function read(limit=100,requestId=''){
 await ready;const rows=[];
 for(const name of ['events.jsonl.3','events.jsonl.2','events.jsonl.1','events.jsonl']){
 try{const s=await fs.promises.readFile(path.join(dir,name),'utf8');for(const line of s.split('\n')){try{const x=JSON.parse(line);if(Date.now()-Date.parse(x.t)<=retentionMs&&(!requestId||x.request_id===requestId))rows.push(x);}catch(_){}}}catch(e){if(e.code!=='ENOENT')lastFailure=e.code||'IO_ERROR';}
 }
 try{const x=JSON.parse(await fs.promises.readFile(path.join(dir,'fatal.json'),'utf8'));if(Date.now()-Date.parse(x.t)<=retentionMs&&(!requestId||x.request_id===requestId))rows.push(x);}catch(_){}
 rows.sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
 return rows.slice(-Math.min(200,Math.max(1,Number(limit)||100))).reverse();
 }
 return {record,read,status:()=>({build,pending:queue.length,dropped,written,storage_error:lastFailure,max_files:5,max_file_bytes:maxBytes,retention_days:30}),async flush(){await ready;while(running||queue.length)await new Promise(r=>setTimeout(r,5));}};
}
const recorder=createRecorder();
function observeDb(api){
 if(!api||api.__blackbox)return api;
 Object.defineProperty(api,'__blackbox',{value:true});
 for(const key of ['query','queryOne','execute','transaction']){
 if(typeof api[key]!=='function')continue;const original=api[key].bind(api);
 api[key]=async(...args)=>{const start=Date.now();try{
 if(key==='transaction'){const fn=args[0];args[0]=tx=>fn(observeDb(tx));}
 const value=await original(...args);
 if(Date.now()-start>1500)recorder.record('db_slow',{duration_ms:Date.now()-start,query_kind:key,fingerprint:HASH(args[0])});
 return value;
 }catch(e){recorder.record('db_error',{...errorOrigin(e),code:e.code||e.name||'DB_ERROR',fingerprint:HASH(args[0]),query_kind:key,duration_ms:Date.now()-start});throw e;}
 };
 }
 return api;
}
function middleware(req,res,next){
 const requestId=crypto.randomUUID();req.requestId=requestId;res.setHeader('X-Request-Id',requestId);
 context.run({requestId,req},()=>{
 const start=Date.now();let ended=false;const finish=aborted=>{
 if(ended)return;ended=true;const p=safePath(req.originalUrl);
 if(p.startsWith('/api/diagnostics'))return;
 if(p.startsWith('/api/')||res.statusCode>=400)recorder.record(aborted?'http_aborted':res.statusCode>=500?'http_error':res.statusCode>=400?'request_refused':'http_request',{method:req.method,path:p,status:res.statusCode,duration_ms:Date.now()-start,trace_id:req.headers['x-smi-trace']});
 };
 res.once('finish',()=>finish(false));res.once('close',()=>{if(!res.writableFinished)finish(true);});next();
 });
}
function installProcessObservers(){
 process.on('uncaughtExceptionMonitor',e=>{try{const dir=path.join(__dirname,'..','data','blackbox');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'fatal.json'),JSON.stringify({t:new Date().toISOString(),type:'process_fatal',...errorOrigin(e),request_id:context.getStore()?.requestId||null,user_id:context.getStore()?.req?.user?.id||null,code:id(e.code||e.name),fingerprint:HASH(e.message),build}),{mode:0o600});}catch(_){}recorder.record('process_fatal',{code:e.code||e.name,fingerprint:HASH(e.message)});});
 const original=console.error.bind(console);
 console.error=(...args)=>{recorder.record('server_error',{...errorOrigin(args.find(x=>x instanceof Error)),fingerprint:HASH(args.map(x=>x instanceof Error?x.message:String(x)).join(' ')),code:args.find(x=>x instanceof Error)?.code||'CONSOLE_ERROR'});original(...args);};
 recorder.record('server_started',{build:process.env.DEPLOY_SHA||'runtime'});
}
module.exports={...recorder,createRecorder,observeDb,middleware,installProcessObservers,context,HASH,id,safePath};

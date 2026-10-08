'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const bb=require('../backend/services/blackbox');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smi-blackbox-test-'));
 const rec=bb.createRecorder(dir,{maxBytes:400});
 rec.record('ui_error',{code:'BUG',password:'NEVER_SECRET',body:'NEVER_SECRET',path:'/app?token=NEVER_SECRET'});
 await rec.flush();let rows=await rec.read();assert.equal(rows.length,1);assert.equal(rows[0].path,'/app');assert(!JSON.stringify(rows).includes('NEVER_SECRET'));
 for(let i=0;i<35;i++){rec.record('http_request',{status:200,action:'event'+i});await rec.flush();}
 rows=await rec.read(200);assert(rows.some(x=>x.action==='event34'));assert(fs.readdirSync(dir).length<=4);assert.equal(rec.status().storage_error,null);
 const stale=path.join(dir,'events.jsonl.3');fs.writeFileSync(stale,'stale');fs.utimesSync(stale,new Date(0),new Date(0));rec.record('test');await rec.flush();assert(!fs.existsSync(stale)||!fs.readFileSync(stale,'utf8').includes('stale'));
 const bad=path.join(dir,'not-a-dir');fs.writeFileSync(bad,'x');const unavailable=bb.createRecorder(bad);unavailable.record('test');await unavailable.flush();assert(unavailable.status().storage_error);assert.equal(unavailable.status().dropped,1);
 const error=Object.assign(new Error('NEVER_SECRET SQL with private value'),{code:'ER_TEST'});
 const api=bb.observeDb({query:async()=>{throw error;},execute:async()=>({affectedRows:1}),transaction:async fn=>fn({query:async()=>{throw error;}})});
 assert.equal(await api.execute('UPDATE users SET password=?',['NEVER_SECRET']).then(x=>x.affectedRows),1);
 const req={originalUrl:'/api/test?password=NEVER_SECRET',method:'POST',headers:{'x-smi-trace':'trace-test'},user:{id:777}};
 const res=new EventEmitter();res.statusCode=500;res.writableFinished=true;res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;
 await new Promise((resolve,reject)=>bb.middleware(req,res,()=>{(async()=>{await assert.rejects(api.query('SELECT ?',['NEVER_SECRET']),e=>e===error);await assert.rejects(api.transaction(tx=>tx.query('SELECT ?',['NEVER_SECRET'])),e=>e===error);res.emit('finish');resolve();})().catch(reject);}));
 await bb.flush();rows=await bb.read(200,req.requestId);assert(rows.some(x=>x.type==='db_error'&&x.code==='ER_TEST'&&x.user_id===777));assert(rows.some(x=>x.type==='http_error'&&x.trace_id==='trace-test'));assert(!JSON.stringify(rows).includes('NEVER_SECRET'));assert.equal(res.headers['X-Request-Id'],req.requestId);
 const express=require('express'),app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:1,role:req.headers['x-test-role']||'caissier',roles:[req.headers['x-test-role']||'caissier']};next();});app.use('/diagnostics',require('../backend/routes/diagnostics'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/diagnostics')).status,403);let r=await fetch(base+'/diagnostics',{headers:{'x-test-role':'admin'}});assert.equal(r.status,200);assert(Array.isArray((await r.json()).rows));
 r=await fetch(base+'/diagnostics/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:[{type:'ui_invalid',field:'amount',password:'NEVER_SECRET'}]})});assert.equal(r.status,202);
 r=await fetch(base+'/diagnostics/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:new Array(21).fill({type:'ui_error'})})});assert.equal(r.status,400);
 for(let i=0;i<12;i++)await fetch(base+'/diagnostics/events',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"events":[]}'});
 assert.equal((await fetch(base+'/diagnostics/events',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"events":[]}'})).status,429);
 }finally{await new Promise(r=>server.close(r));}
 await bb.flush();assert(!(JSON.stringify(await bb.read(200))).includes('NEVER_SECRET'));
 console.log('Blackbox: privacy, retention, rotation, storage failure, DB error preservation, transaction context, HTTP correlation, admin rights, input bounds and rate limits passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});

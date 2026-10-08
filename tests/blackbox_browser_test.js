'use strict';
const assert=require('assert/strict'),fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require('@playwright/test');
(async()=>{
 const root=path.resolve(__dirname,'..');let events=[];
 const server=http.createServer((req,res)=>{
 if(req.url==='/api/diagnostics/events'){let body='';req.on('data',x=>body+=x);req.on('end',()=>{events.push(...JSON.parse(body).events);res.writeHead(202,{'Content-Type':'application/json'});res.end('{"ok":true}');});return;}
 if(req.url.startsWith('/api/diagnostics')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:{dropped:0,storage_error:null},rows:[{t:new Date().toISOString(),type:'ui_error',path:'/app/test',request_id:'request-test',user_id:777}]}));return;}
 if(req.url==='/api/fail'){res.writeHead(422,{'Content-Type':'application/json','X-Request-Id':'server-request-test'});res.end('{"error":"Saisie à vérifier"}');return;}
 const assets={'/blackbox.js':'frontend/blackbox.js','/blackbox-admin.js':'frontend/blackbox-admin.js','/transport.js':'frontend/js/core/transport.js'};
 if(assets[req.url]){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(root,assets[req.url])));return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><script src="/blackbox.js"></script><script src="/blackbox-admin.js"></script><script src="/transport.js"></script><style>body{margin:8px;font-family:sans-serif}button{padding:8px}dialog{box-sizing:border-box}</style><p id="audit-count">Historique</p><form id="qa-form"><label for="qa-field">Adresse email</label><input id="qa-field" type="email" required><button id="qa-send">Valider</button></form><script>const currentUser={role:"admin",roles:["admin"]};const transport=TalaTransport.create({getToken:()=> "not-a-production-token"});async function api(p,o){return transport.request(p,o)}SmiBlackBox.attachAudit();</script>');
 });
 server.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.SMI_TEST_CHROME?{executablePath:process.env.SMI_TEST_CHROME}:{})});for(const width of [320,768,1024,1440]){
 const page=await browser.newPage({viewport:{width,height:800}});
 await page.goto(origin+'/');await page.fill('#qa-field','NEVER_SECRET');
 await page.click('#qa-send');await page.evaluate(()=>{dispatchEvent(new ErrorEvent('error',{message:'NEVER_SECRET',error:new TypeError('NEVER_SECRET'),lineno:123}));});
 await page.evaluate(async()=>{await api('/fail');await SmiBlackBox.flush();});
 assert(events.some(x=>x.type==='ui_error'&&x.line===123));assert(events.some(x=>x.type==='ui_invalid'&&x.field==='qa-field'));assert(events.some(x=>x.type==='ui_network'&&x.request_id==='server-request-test'));assert(!JSON.stringify(events).includes('NEVER_SECRET'));
 await page.click('#smi-incidents-button');await page.getByText('Collecte active',{exact:true}).waitFor();const bounds=await page.locator('dialog').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);
 assert.equal(await page.locator('dialog summary').count(),1);await page.locator('dialog summary').click();await page.getByText('Référence : request-test',{exact:true}).waitFor();
 fs.mkdirSync('/tmp/smi-blackbox-evidence',{recursive:true});await page.screenshot({path:'/tmp/smi-blackbox-evidence/incidents-'+width+'.png'});
 await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});await page.click('#smi-incidents-button');await page.getByText('Collecte active',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});await page.close();
 }
 console.log('Browser: native validation, JS errors, request correlation, no field values, admin consultation, keyboard/dialog close, widths 320/768/1024/1440 passed.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('frontend/dashboard.html');
function route(file,needle,extras={}){
 const source=read(file),start=source.indexOf(needle);assert(start>=0,needle);
 const end=source.indexOf('\n});',start);assert(end>start);
 let handler;const context={router:{get:(_path,fn)=>{handler=fn}},...extras};
 vm.runInNewContext(source.slice(start,end+4),context);return handler;
}
function response(){return {statusCode:200,status(c){this.statusCode=c;return this},json(data){this.body=data;return this}}}
function node(){const classes=new Set(['hidden']);return {innerHTML:'',textContent:'',dataset:{},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){if(on)classes.add(c);else classes.delete(c)}}}}
async function main(){
 const documents=[{id:1,initiateur_id:2,statut:'en_attente_assistante'},{id:2,initiateur_id:2,statut:'transmis_dg'},{id:3,initiateur_id:2,statut:'approuve'},{id:4,initiateur_id:2,statut:'rejete'},{id:5,initiateur_id:2,statut:'en_attente_assistante',operation_annulee:1}];
 const handler=route('backend/routes/parapheur.js',"router.get('/',",{
  requireAnyRole:(user,...roles)=>[user.role,...(user.roles||[])].some(role=>roles.includes(role)),
  httpError:(_res,error)=>{throw error},
  db:{query:async(sql,params)=>{
   assert(sql.includes("COALESCE(source_operation.statut,'') <> 'annule'"));
   const visible=documents.filter(p=>!p.operation_annulee);
   if(sql.includes("NOT IN ('approuve','rejete')"))return visible.filter(p=>!['approuve','rejete'].includes(p.statut));
   if(sql.includes("p.statut IN ('transmis_dg'"))return visible.filter(p=>['transmis_dg','en_avis','delegue'].includes(p.statut));
   if(sql.includes("p.statut = 'en_attente_assistante'"))return visible.filter(p=>p.statut==='en_attente_assistante');
   assert(sql.includes('p.initiateur_id = ?'));return documents.filter(p=>p.initiateur_id===params[0]);
  }}
 });
 for(const [user,ids] of [[{id:1,role:'admin'},[1,2]],[{id:1,role:'finance',roles:['admin']},[1,2]],[{id:1,role:'dg'},[2]],[{id:1,role:'assistante_direction'},[1]],[{id:1,role:'lecteur'},[]]]){
  const res=response();await handler({user},res);assert.deepStrictEqual(Array.from(res.body.data,x=>x.id),ids);
 }
 const bilan=route('backend/routes/operations.js',"router.get('/bilan-mensuel'",{
  hasRole:(u,...roles)=>roles.includes(u.role),rolesAdmisSurLEcran:()=>['admin','dg'],safe:v=>Number(v)||0,getSoldePosition:async()=>0,
  db:{query:async()=>[],queryOne:async()=>({derniere_date:'2026-04-29',total:0,c:0,nb:0,encaissements:0,decaissements:0,nb_operations:0})}
 });
 for(const [query,end] of [[{mois:2,annee:2026},'2026-02-28'],[{mois:2,annee:2024},'2024-02-29']]){
  const res=response();await bilan({user:{role:'admin'},query},res);assert.strictEqual(res.body.meta.fin,end);assert.strictEqual(res.body.meta.derniere_date_operation,'2026-04-29');assert.strictEqual(res.body.tresorerie.encaissements,0);
 }
 const forbidden=response();await bilan({user:{role:'caissier'},query:{}},forbidden);assert.strictEqual(forbidden.statusCode,403);
 const invalid=response();await bilan({user:{role:'admin'},query:{mois:13,annee:2026}},invalid);assert.strictEqual(invalid.statusCode,400);
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id)};
 const periodStart=html.indexOf('function renderBilanPeriodContext('),periodEnd=html.indexOf('function showLatestBilan(',periodStart);assert(periodStart>=0);
 const context=vm.createContext({document:{getElementById:get},Date});vm.runInContext(html.slice(periodStart,periodEnd),context);
 const monthly={meta:{mois:10,annee:2026,debut:'2026-10-01',derniere_date_operation:'2026-04-29'},tresorerie:{nb_operations:0}};
 context.renderBilanPeriodContext(monthly);assert(get('bilan-period-text').textContent.includes('octobre 2026'));assert.strictEqual(get('bilan-latest-button').dataset.date,'2026-04-29');assert(get('bilan-latest-button').textContent.includes('avril 2026'));
 monthly.meta.mois=4;monthly.meta.debut='2026-04-01';monthly.tresorerie.nb_operations=3;context.renderBilanPeriodContext(monthly);assert(get('bilan-latest-button').classList.contains('hidden'));assert.strictEqual(get('bilan-latest-button').dataset.date,undefined);
 const pendingStart=html.indexOf('async function loadPendingDec()'),pendingEnd=html.indexOf('function decIdentifiantExploitable',pendingStart);assert(pendingStart>=0);
 let admin=true,mode='rows';const calls=[];
 const pendingContext=vm.createContext({document:{getElementById:get},_decPendingForceVisible:true,hasExactRole:()=>admin,api:async url=>{calls.push(url);return mode==='error'?null:mode==='empty'?[]:[{id:13,libelle:'<img src=x onerror=bad()>',montant:514075,dec_statut:'brouillon'}]},pollPendingBadge:()=>{},canSubmitDec:()=>false,canApproveDec:()=>false,canPayDec:()=>false,decValidableParMoi:()=>false,DEC_STATUT_CLASS:{},DEC_STATUT_LABELS:{brouillon:'Brouillon'},fmt:String,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
 vm.runInContext(html.slice(pendingStart,pendingEnd),pendingContext);
 await pendingContext.loadPendingDec();assert.strictEqual(calls[0],'/operations/decaissements/pending');assert(get('dec-pending-tbody').innerHTML.includes('514075'));assert(!get('dec-pending-tbody').innerHTML.includes('<img'));assert(!get('dec-pending-section').classList.contains('hidden'));
 admin=false;mode='empty';calls.length=0;await pendingContext.loadPendingDec();assert(calls[0].includes('scope=actionable'));assert(!get('dec-pending-section').classList.contains('hidden'));assert(get('dec-pending-tbody').innerHTML.includes('Aucun décaissement'));
 mode='error';await pendingContext.loadPendingDec();assert(get('dec-pending-tbody').innerHTML.includes('Impossible de charger'));assert.strictEqual(get('dec-pending-count').textContent,'—');
 assert(html.includes('<span>Achats à approuver</span>'));assert(html.includes('onclick="openDecaissements()"'));assert(html.includes('id="bilan-evolution-empty"'));assert(html.includes("p.operation_annulee ? 'Décaissement annulé'"));assert(html.includes('Voir l’historique'));
 console.log('visibility_approvals_test: OK — admin/global and restricted queues, monthly boundaries, latest month, explicit empty/error states and escaped labels');
}
main().catch(error=>{console.error(error);process.exitCode=1});

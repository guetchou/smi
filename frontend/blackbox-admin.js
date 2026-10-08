(function(){
'use strict';
const labels={ui_error:'Erreur à l’écran',ui_rejection:'Action interrompue',ui_resource_error:'Élément non chargé',ui_invalid:'Saisie à vérifier',ui_action:'Action à l’écran',ui_submit:'Formulaire envoyé',ui_layout:'Affichage à vérifier',ui_network:'Connexion ou requête refusée',ui_route:'Navigation',db_error:'Erreur de base de données',db_slow:'Accès aux données lent',http_error:'Erreur du serveur',request_refused:'Demande refusée',http_aborted:'Demande interrompue',http_request:'Demande traitée',server_error:'Erreur du serveur',server_started:'Application démarrée',process_fatal:'Application arrêtée'};
function element(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
async function open(){
 if(!window.SmiBlackBox||typeof api!=='function')return;
 const d=element('dialog');d.setAttribute('aria-label','Incidents');Object.assign(d.style,{width:'min(900px,calc(100vw - 32px))',maxWidth:'calc(100vw - 32px)',maxHeight:'80vh',padding:'20px',border:'1px solid #dce1ea',borderRadius:'16px',color:'#17223b',background:'#fff'});
 const header=element('div');Object.assign(header.style,{display:'flex',gap:'12px',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap'});
 header.append(element('h2','Incidents'));const controls=element('div');Object.assign(controls.style,{display:'flex',gap:'8px'});
 const refresh=element('button','Actualiser'),close=element('button','Fermer');for(const b of [refresh,close]){b.type='button';b.className='btn btn-secondary btn-sm';controls.append(b);}header.append(controls);d.append(header);
 const state=element('p','Chargement…');state.setAttribute('aria-live','polite');d.append(state);
 const list=element('div');Object.assign(list.style,{overflow:'auto',maxHeight:'55vh'});d.append(list);
 close.onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});document.body.append(d);d.showModal();
 async function load(){
 refresh.disabled=true;try{const result=await api('/diagnostics?limit=100',{noCache:true});if(!d.isConnected)return;
 if(!result){state.textContent='La consultation des incidents est indisponible.';return;}
 state.textContent=result.status.storage_error?'Enregistrement interrompu. Prévenez l’administrateur.':result.status.dropped?'Certains événements n’ont pas pu être conservés.':'Collecte active';
 list.replaceChildren();
 if(!result.rows.length){list.append(element('p','Aucun événement conservé.'));return;}
 for(const r of result.rows){const item=element('details');Object.assign(item.style,{borderBottom:'1px solid #e3e7ef',padding:'10px 0'});
 const summary=element('summary',new Date(r.t).toLocaleString('fr-FR')+' — '+(labels[r.type]||'Événement'));item.append(summary);
 const info=element('p',(r.path||'')+(r.status?' · Réponse '+r.status:'')+(r.user_id?' · Compte '+r.user_id:''));info.style.overflowWrap='anywhere';item.append(info);
 const ref=element('p',r.request_id?'Référence : '+r.request_id:r.trace_id?'Référence : '+r.trace_id:'');ref.style.overflowWrap='anywhere';item.append(ref);

 list.append(item);}
 }catch(_){state.textContent='Impossible de charger les incidents.';}finally{refresh.disabled=false;}
 }
 refresh.onclick=()=>void load();await load();
}
window.SmiBlackBox.open=open;
window.SmiBlackBox.attachAudit=()=>{
 if(typeof currentUser==='undefined'||![currentUser.role,...(Array.isArray(currentUser.roles)?currentUser.roles:[])].includes('admin'))return;
 if(document.getElementById('smi-incidents-button'))return;
 const parent=document.getElementById('audit-count')?.parentElement;if(!parent)return;
 const b=element('button','Incidents');b.id='smi-incidents-button';b.type='button';b.className='btn btn-secondary btn-sm';b.onclick=()=>void open();parent.append(b);
};
})();

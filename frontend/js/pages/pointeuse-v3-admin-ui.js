(function(){
  'use strict';
  const API='/api/pointeuse/v3';
  const MANAGER=new Set(['admin','dg','rh']);
  function token(){return localStorage.getItem('tc_token')||'';}
  function roles(){try{const u=JSON.parse(localStorage.getItem('tc_user')||'{}');return new Set([u.role,u.sous_role,...(Array.isArray(u.roles)?u.roles:[])].filter(Boolean).map(x=>String(x).toLowerCase()));}catch(_){return new Set();}}
  function allowed(){return [...roles()].some(r=>MANAGER.has(r));}
  function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
  function notify(m,t='success'){if(typeof showToast==='function')return showToast(m,t);if(typeof toast==='function')return toast(m,t);if(t==='error')alert(m);}
  async function api(path,opt={}){const r=await fetch(API+path,{...opt,headers:{'Content-Type':'application/json',...(token()?{Authorization:`Bearer ${token()}`}:{ }),...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||`Erreur ${r.status}`);e.status=r.status;e.payload=d;throw e;}return d;}
  function fmt(v){return v?new Date(`${String(v).slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR'):'—';}
  let config=null, corrections=[];

  function styles(){if(document.getElementById('p3-admin-styles'))return;const s=document.createElement('style');s.id='p3-admin-styles';s.textContent=`
    #pointeuse-v3-admin-console{margin-top:14px}.p3a-shell{border:1px solid #dbe3ee;border-radius:14px;background:#fff;overflow:hidden}.p3a-head{padding:14px 18px;border-bottom:1px solid #dbe3ee;display:flex;justify-content:space-between;align-items:center}.p3a-head h2{margin:0;font-size:15px}.p3a-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px}.p3a-card{border:1px solid #e2e8f0;border-radius:10px;padding:12px}.p3a-card h3{margin:0 0 10px;font-size:13px}.p3a-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.p3a-form label{font-size:10px;color:#64748b;font-weight:700}.p3a-form input,.p3a-form select{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:7px;font:inherit;font-size:12px;margin-top:3px}.p3a-form button,.p3a-btn{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:7px 9px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.p3a-form button{background:#163b71;color:#fff;border-color:#163b71;align-self:end}.p3a-wide{grid-column:1/-1}.p3a-table{width:100%;border-collapse:collapse;font-size:11px}.p3a-table th,.p3a-table td{padding:7px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.p3a-table th{font-size:9px;text-transform:uppercase;color:#64748b}.p3a-actions{display:flex;gap:5px;flex-wrap:wrap}.p3a-note{font-size:11px;color:#64748b}.p3a-pill{display:inline-block;border:1px solid #cbd5e1;border-radius:999px;padding:3px 6px;font-size:10px}.p3a-modal{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px}.p3a-modal[hidden]{display:none}.p3a-modal-box{background:#fff;border-radius:14px;padding:18px 20px;width:min(440px,100%);box-shadow:0 20px 50px -20px rgba(15,23,42,.5)}.p3a-modal-box h3{margin:0 0 12px;font-size:14px}.p3a-modal-box textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px;font:inherit;font-size:13px;resize:vertical;margin-top:4px}.p3a-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.p3a-modal-actions .primaire{background:#163b71;color:#fff;border-color:#163b71}.p3a-sub{font-size:11px;color:#64748b;margin:10px 0 4px}@media(max-width:900px){.p3a-grid{grid-template-columns:1fr}.p3a-form{grid-template-columns:1fr}}
  `;document.head.appendChild(s);}

  async function load(){config=await api('/admin/config');try{const c=await api('/corrections?status=submitted');corrections=c.corrections||[];}catch(_){corrections=[];}}
  function options(rows,label){return (rows||[]).map(x=>`<option value="${x.id}">${esc(x.code||x.matricule||x.id)}${x.libelle?` · ${esc(x.libelle)}`:''}${label&&x[label]?` · ${esc(x[label])}`:''}</option>`).join('');}

  function etat(r){return (Number(r.actif)===0)?'Désactivé':'Actif';}
  function actions(kind,r){return `<div class="p3a-actions"><button class="p3a-btn" data-edit="${kind}" data-id="${r.id}">Modifier</button>${Number(r.actif)===0?'':`<button class="p3a-btn" data-off="${kind}" data-id="${r.id}">Désactiver</button>`}</div>`;}
  function oui(v){return Number(v)?'Oui':'Non';}
  function table(entetes,lignes){return lignes.length?`<table class="p3a-table"><thead><tr>${entetes.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${lignes.join('')}</tbody></table>`:'';}

  function listeSites(){return table(['Code','Libellé','Latitude','Longitude','Rayon (m)','GPS requis','Actif','Actions'],
    (config?.sites||[]).map(r=>`<tr><td>${esc(r.code)}</td><td>${esc(r.libelle)}</td><td>${r.latitude??'—'}</td><td>${r.longitude??'—'}</td><td>${r.rayon_m??'—'}</td><td>${oui(r.gps_requis)}</td><td>${etat(r)}</td><td>${actions('site',r)}</td></tr>`));}

  function listePlannings(){return table(['Code','Libellé','Début','Fin','Pause min','Déduction auto','Seuil déduction min','Tolérance retard','Actif','Actions'],
    (config?.schedules||[]).map(r=>`<tr><td>${esc(r.code)}</td><td>${esc(r.libelle)}</td><td>${esc(String(r.heure_debut||'').slice(0,5))}</td><td>${esc(String(r.heure_fin||'').slice(0,5))}</td><td>${r.pause_minutes??0}</td><td>${oui(r.pause_auto_deduction)}</td><td>${r.pause_seuil_minutes??360}</td><td>${r.tolerance_retard_minutes??0}</td><td>${etat(r)}</td><td>${actions('schedule',r)}</td></tr>`));}

  function listeCalendriers(){return table(['Code','Libellé','Jours ouvrés','Actif','Actions'],
    (config?.calendars||[]).map(r=>`<tr><td>${esc(r.code)}</td><td>${esc(r.libelle)}</td><td>${esc(r.jours_ouvres||'')}</td><td>${etat(r)}</td><td>${actions('calendar',r)}</td></tr>`));}

  function listeAffectations(){return table(['Agent','Planning','Calendrier','Site','Mode','Début','Fin'],
    (config?.assignments||[]).map(r=>`<tr><td>${esc(r.matricule||'')} · ${esc(r.prenom||'')} ${esc(r.nom||'')}</td><td>${esc(r.schedule_code||'')}</td><td>${esc(r.calendar_code||'—')}</td><td>${esc(r.site_code||'—')}</td><td>${esc(r.mode_autorise||'')}</td><td>${fmt(r.date_debut)}</td><td>${r.date_fin?fmt(r.date_fin):'—'}</td></tr>`));}

  function periodButtons(p){const out=[];if(['open','reopened','calculated'].includes(p.status))out.push(`<button class="p3a-btn" data-paction="calculate" data-id="${p.id}">Calculer</button>`);if(p.status==='calculated')out.push(`<button class="p3a-btn" data-paction="review" data-id="${p.id}">Revue</button>`);if(p.status==='review')out.push(`<button class="p3a-btn" data-paction="approve" data-id="${p.id}">Approuver</button>`);if(p.status==='approved')out.push(`<button class="p3a-btn" data-paction="close" data-id="${p.id}">Clôturer</button>`);if(p.status==='closed'){out.push(`<button class="p3a-btn" data-paction="snapshot" data-id="${p.id}">Snapshot paie</button>`);out.push(`<button class="p3a-btn" data-paction="reopen" data-id="${p.id}">Réouvrir</button>`);}return out.join('');}

  function html(){return `<div class="p3a-shell"><div class="p3a-head"><h2>Administration des temps</h2><span class="p3a-pill">Mode ${esc(config?.mode||'shadow')}</span></div><div class="p3a-grid">
    <section class="p3a-card"><h3>Site / géofence</h3><form id="p3a-site" class="p3a-form"><label>Code<input name="code" required placeholder="BRAZZAVILLE-SIEGE"></label><label>Libellé<input name="libelle" required></label><label>Latitude<input name="latitude" type="number" step="0.0000001"></label><label>Longitude<input name="longitude" type="number" step="0.0000001"></label><label>Rayon (m)<input name="rayon_m" type="number" min="10" value="300"></label><label>GPS requis<select name="gps_requis"><option value="0">Non</option><option value="1">Oui</option></select></label><button class="p3a-wide">Enregistrer le site</button></form>${listeSites()?`<p class="p3a-sub">Actifs</p>${listeSites()}`:''}</section>
    <section class="p3a-card"><h3>Planning</h3><form id="p3a-schedule" class="p3a-form"><label>Code<input name="code" required placeholder="JOUR-0800"></label><label>Libellé<input name="libelle" required></label><label>Début<input name="heure_debut" type="time" required></label><label>Fin<input name="heure_fin" type="time" required></label><label>Pause min<input name="pause_minutes" type="number" min="0" value="60"></label><label>Déduction auto<select name="pause_auto_deduction"><option value="1">Oui</option><option value="0">Non</option></select></label><label>Seuil déduction min<input name="pause_seuil_minutes" type="number" min="0" value="360"></label><label>Tolérance retard<input name="tolerance_retard_minutes" type="number" min="0" value="15"></label><label>Nuit début<input name="nuit_debut" type="time" value="22:00"></label><label>Nuit fin<input name="nuit_fin" type="time" value="05:00"></label><label>Traverse minuit<select name="nuit_traverse_minuit"><option value="0">Non</option><option value="1">Oui</option></select></label><label>Durée max min<input name="max_duree_minutes" type="number" value="960"></label><button class="p3a-wide">Enregistrer le planning</button></form>${listePlannings()?`<p class="p3a-sub">Actifs</p>${listePlannings()}`:''}</section>
    <section class="p3a-card"><h3>Calendrier de travail</h3>${listeCalendriers()?`${listeCalendriers()}<p class="p3a-sub">&nbsp;</p>`:''}<form id="p3a-calendar" class="p3a-form"><label>Code<input name="code" required placeholder="CG-STANDARD"></label><label>Libellé<input name="libelle" required></label><label>Jours ouvrés<input name="jours_ouvres" value="1,2,3,4,5"></label><button>Enregistrer</button></form><form id="p3a-day" class="p3a-form" style="margin-top:12px"><label>Calendrier<select name="calendar_id" required>${options(config?.calendars)}</select></label><label>Date<input name="work_date" type="date" required></label><label>Type<select name="day_type"><option value="holiday">Férié</option><option value="rest">Repos</option><option value="exception">Exception travaillée</option><option value="workday">Ouvré</option></select></label><label>Libellé<input name="libelle"></label><button class="p3a-wide">Ajouter l’exception</button></form></section>
    <section class="p3a-card"><h3>Affectation agent</h3>${listeAffectations()?`${listeAffectations()}<p class="p3a-sub">&nbsp;</p>`:''}<form id="p3a-assignment" class="p3a-form"><label>ID agent<input name="employe_id" type="number" min="1" required></label><label>Planning<select name="schedule_id" required>${options(config?.schedules)}</select></label><label>Calendrier<select name="calendar_id"><option value="">—</option>${options(config?.calendars)}</select></label><label>Site<select name="site_code"><option value="">—</option>${(config?.sites||[]).map(x=>`<option value="${esc(x.code)}">${esc(x.code)} · ${esc(x.libelle)}</option>`).join('')}</select></label><label>Début<input name="date_debut" type="date" required></label><label>Fin<input name="date_fin" type="date"></label><label>Mode<select name="mode_autorise"><option>bureau</option><option>teletravail</option><option>terrain</option><option>hybride</option></select></label><button>Affecter</button></form></section>
    <section class="p3a-card p3a-wide"><h3>Corrections à revoir</h3>${corrections.length?`<table class="p3a-table"><thead><tr><th>Agent</th><th>Date</th><th>Demande</th><th>Motif</th><th>Actions</th></tr></thead><tbody>${corrections.map(c=>`<tr><td>${esc(c.matricule)} · ${esc(c.prenom||'')} ${esc(c.nom||'')}</td><td>${fmt(c.work_date)}</td><td>${esc(c.requested_event_type||'rectification')}</td><td>${esc(c.reason)}</td><td class="p3a-actions"><button class="p3a-btn" data-correction="${c.id}" data-decision="approved">Approuver</button><button class="p3a-btn" data-correction="${c.id}" data-decision="rejected">Refuser</button></td></tr>`).join('')}</tbody></table>`:'<p class="p3a-note">Aucune correction soumise.</p>'}</section>
    <section class="p3a-card p3a-wide"><h3>Périodes & paie</h3><form id="p3a-period" class="p3a-form" style="max-width:520px;margin-bottom:12px"><label>Du<input name="date_debut" type="date" required></label><label>Au<input name="date_fin" type="date" required></label><button class="p3a-wide">Créer la période</button></form>${config?.periods?.length?`<table class="p3a-table"><thead><tr><th>Période</th><th>État</th><th>Calcul</th><th>Actions</th></tr></thead><tbody>${config.periods.map(p=>`<tr><td>${fmt(p.date_debut)} → ${fmt(p.date_fin)}</td><td><span class="p3a-pill">${esc(p.status)}</span></td><td>${esc(p.calc_version||'—')}</td><td class="p3a-actions">${periodButtons(p)}</td></tr>`).join('')}</tbody></table>`:'<p class="p3a-note">Aucune période V3.</p>'}</section>
    <section class="p3a-card p3a-wide"><h3>Bascule contrôlée</h3><div class="p3a-form" style="max-width:520px"><label>Mode V3<select id="p3a-mode"><option value="shadow" ${config?.mode==='shadow'?'selected':''}>Shadow</option><option value="active" ${config?.mode==='active'?'selected':''}>Actif</option><option value="disabled" ${config?.mode==='disabled'?'selected':''}>Désactivé</option></select></label><button id="p3a-mode-save" type="button">Appliquer</button></div></section>
  </div></div>${dialogue()}`;}

  function dialogue(){return `<div class="p3a-modal" id="p3a-dialog" role="dialog" aria-modal="true" aria-labelledby="p3a-dialog-title" hidden><div class="p3a-modal-box"><h3 id="p3a-dialog-title"></h3><label id="p3a-dialog-field" hidden>Motif<textarea id="p3a-dialog-text" rows="3"></textarea></label><div class="p3a-modal-actions"><button class="p3a-btn" type="button" id="p3a-dialog-cancel">Annuler</button><button class="p3a-btn primaire" type="button" id="p3a-dialog-ok"></button></div></div></div>`;}

  let repondre=null;
  function fermerDialogue(valeur){const m=document.getElementById('p3a-dialog');if(!m)return;m.hidden=true;const t=document.getElementById('p3a-dialog-text');if(t)t.value='';const r=repondre;repondre=null;if(r)r(valeur);}
  function demander({titre,confirmer,motif=false,minLength=0}){
    return new Promise(resolve=>{
      const m=document.getElementById('p3a-dialog');if(!m)return resolve(null);
      repondre=resolve;
      document.getElementById('p3a-dialog-title').textContent=titre;
      document.getElementById('p3a-dialog-ok').textContent=confirmer;
      const champ=document.getElementById('p3a-dialog-field');
      champ.hidden=!motif; m.dataset.min=String(minLength); m.hidden=false;
      if(motif)document.getElementById('p3a-dialog-text').focus();else document.getElementById('p3a-dialog-ok').focus();
    });
  }
  function lierDialogue(){
    const m=document.getElementById('p3a-dialog');if(!m)return;
    m.addEventListener('click',e=>{if(e.target===m)fermerDialogue(null);});
    document.getElementById('p3a-dialog-cancel').addEventListener('click',()=>fermerDialogue(null));
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!m.hidden)fermerDialogue(null);});
    document.getElementById('p3a-dialog-ok').addEventListener('click',()=>{
      const champ=document.getElementById('p3a-dialog-field');
      if(champ.hidden)return fermerDialogue(true);
      const v=(document.getElementById('p3a-dialog-text').value||'').trim();
      if(v.length<Number(m.dataset.min||0))return;
      fermerDialogue(v);
    });
  }

  const CHAMPS={
    site:r=>({code:r.code,libelle:r.libelle,latitude:r.latitude,longitude:r.longitude,rayon_m:r.rayon_m,gps_requis:Number(r.gps_requis)?'1':'0'}),
    schedule:r=>({code:r.code,libelle:r.libelle,heure_debut:String(r.heure_debut||'').slice(0,5),heure_fin:String(r.heure_fin||'').slice(0,5),pause_minutes:r.pause_minutes,pause_auto_deduction:Number(r.pause_auto_deduction)?'1':'0',pause_seuil_minutes:r.pause_seuil_minutes,tolerance_retard_minutes:r.tolerance_retard_minutes,nuit_debut:String(r.nuit_debut||'').slice(0,5),nuit_fin:String(r.nuit_fin||'').slice(0,5),nuit_traverse_minuit:Number(r.nuit_traverse_minuit)?'1':'0',max_duree_minutes:r.max_duree_minutes}),
    calendar:r=>({code:r.code,libelle:r.libelle,jours_ouvres:r.jours_ouvres}),
  };
  const COLLECTIONS={site:'sites',schedule:'schedules',calendar:'calendars'};
  const FORMULAIRES={site:'p3a-site',schedule:'p3a-schedule',calendar:'p3a-calendar'};

  function remplir(kind,id){
    const r=(config?.[COLLECTIONS[kind]]||[]).find(x=>String(x.id)===String(id));
    const f=document.getElementById(FORMULAIRES[kind]);
    if(!r||!f)return;
    for(const [nom,val] of Object.entries(CHAMPS[kind](r))){const el=f.elements[nom];if(el)el.value=val==null?'':String(val);}
    f.scrollIntoView({block:'nearest',behavior:'smooth'});
    f.elements.libelle?.focus();
  }

  function data(form){const o=Object.fromEntries(new FormData(form).entries());for(const k of ['latitude','longitude','rayon_m','pause_minutes','pause_seuil_minutes','tolerance_retard_minutes','max_duree_minutes','employe_id','schedule_id','calendar_id'])if(o[k]!=='')o[k]=Number(o[k]);for(const k of ['gps_requis','nuit_traverse_minuit','pause_auto_deduction'])o[k]=o[k]==='1';return o;}
  async function post(path,body){return api(path,{method:'POST',body:JSON.stringify(body)});}
  async function refresh(){try{await load();render();}catch(e){if(e.status!==403)notify(e.message,'error');}}
  function bind(){
    lierDialogue();
    document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>remplir(b.dataset.edit,b.dataset.id)));
    document.querySelectorAll('[data-off]').forEach(b=>b.addEventListener('click',async()=>{
      const kind=b.dataset.off,id=b.dataset.id;
      const r=(config?.[COLLECTIONS[kind]]||[]).find(x=>String(x.id)===String(id));
      const ok=await demander({titre:esc(r?.code||''),confirmer:'Désactiver'});
      if(!ok)return;
      try{await post(`/admin/${COLLECTIONS[kind]}/${id}/deactivate`,{});notify('Enregistré');await refresh();}catch(e){notify(e.message,'error');}
    }));
    const forms={site:'/admin/sites',schedule:'/admin/schedules',calendar:'/admin/calendars',assignment:'/admin/assignments',period:'/admin/periods'};
    for(const [id,path] of Object.entries(forms))document.getElementById(`p3a-${id}`)?.addEventListener('submit',async e=>{e.preventDefault();try{await post(path,data(e.currentTarget));notify('Enregistré');await refresh();}catch(err){notify(err.message,'error');}});
    document.getElementById('p3a-day')?.addEventListener('submit',async e=>{e.preventDefault();const b=data(e.currentTarget);const id=b.calendar_id;delete b.calendar_id;try{await post(`/admin/calendars/${id}/days`,b);notify('Jour calendrier enregistré');await refresh();}catch(err){notify(err.message,'error');}});
    document.querySelectorAll('[data-correction]').forEach(b=>b.addEventListener('click',async()=>{const reason=await demander({titre:b.dataset.decision==='approved'?'Motif d’approbation':'Motif du refus',confirmer:b.textContent.trim(),motif:true,minLength:1});if(!reason)return;try{await post(`/corrections/${b.dataset.correction}/review`,{decision:b.dataset.decision,reason});notify('Correction traitée');await refresh();}catch(e){notify(e.message,'error');}}));
    document.querySelectorAll('[data-paction]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.id,a=b.dataset.paction;try{if(a==='snapshot')await post(`/periods/${id}/payroll-snapshot`,{});else if(a==='reopen'){const reason=await demander({titre:'Motif de réouverture (minimum 10 caractères)',confirmer:b.textContent.trim(),motif:true,minLength:10});if(!reason)return;await post(`/admin/periods/${id}/reopen`,{reason});}else if(a==='close')await post(`/periods/${id}/close`,{});else await post(`/admin/periods/${id}/${a}`,{});notify(`Période : ${a}`);await refresh();}catch(e){notify(e.message,'error');}}));
    document.getElementById('p3a-mode-save')?.addEventListener('click',async()=>{const mode=document.getElementById('p3a-mode').value;const ok=mode!=='active'||await demander({titre:'Activer V3 pour les pointages réels ? Vérifiez d’abord le rapprochement V2/V3.',confirmer:'Appliquer'});if(!ok)return;try{await post('/admin/runtime-mode',{mode});notify(`Mode V3 : ${mode}`);location.reload();}catch(e){notify(e.message,'error');}});
  }
  function render(){if(!allowed()||!location.pathname.startsWith('/app/rh/pointeuse'))return;const root=document.getElementById('pointeuse-v3-root');if(!root)return;styles();let box=document.getElementById('pointeuse-v3-admin-console');if(!box){box=document.createElement('section');box.id='pointeuse-v3-admin-console';box.setAttribute('aria-label','Administration Pointeuse V3');(document.getElementById('pointeuse-v3-legacy-store')||root).appendChild(box);}box.innerHTML=html();bind();}
  async function init(){if(!allowed())return;try{await load();render();}catch(e){if(e.status!==403)notify(`Administration Pointeuse : ${e.message}`,'error');}}
  let t;const obs=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(()=>{if(!document.getElementById('pointeuse-v3-admin-console'))init();},100);});obs.observe(document.documentElement,{subtree:true,childList:true});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

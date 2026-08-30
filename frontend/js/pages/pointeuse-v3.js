(function () {
  'use strict';

  const API = '/api/pointeuse/v3';
  const MANAGER_ROLES = new Set(['admin','dg','rh']);
  const state = { status:null, capabilities:null, anomalies:[], config:null, reconciliation:null, tab:'today', loading:false };

  function token(){ return localStorage.getItem('tc_token') || ''; }
  function roles(){
    try {
      const u=JSON.parse(localStorage.getItem('tc_user')||'{}');
      return new Set([u.role,u.sous_role,...(Array.isArray(u.roles)?u.roles:[])].filter(Boolean).flatMap(v=>String(v).toLowerCase().split(/[\s,;|]+/)));
    } catch(_){ return new Set(); }
  }
  function canManage(){ return [...roles()].some(r=>MANAGER_ROLES.has(r)); }
  function esc(v){ return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function notify(msg,type='success'){
    if(typeof window.showToast==='function') return window.showToast(msg,type);
    if(typeof window.toast==='function') return window.toast(msg,type);
    if(type==='error') alert(msg);
  }
  async function api(path, options={}){
    const response=await fetch(API+path,{...options,headers:{'Content-Type':'application/json',...(token()?{Authorization:`Bearer ${token()}`}:{ }),...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){ const e=new Error(data.error||`Erreur HTTP ${response.status}`); e.status=response.status; e.payload=data; throw e; }
    return data;
  }
  function idempotency(){ return `web:${Date.now()}:${crypto.getRandomValues(new Uint32Array(2)).join('-')}`; }
  function fmtMinutes(n){ n=Number(n||0); const h=Math.floor(n/60); const m=n%60; return `${h}h${String(m).padStart(2,'0')}`; }
  function fmtDate(v){ if(!v)return '—'; const d=new Date(`${String(v).slice(0,10)}T12:00:00`); return Number.isNaN(d.getTime())?esc(v):d.toLocaleDateString('fr-FR'); }
  function actionLabel(type){ return ({clock_in:'Commencer la journée',break_start:'Commencer la pause',break_end:'Reprendre le travail',clock_out:'Terminer la journée'})[type]||type; }
  function statusLabel(s){ return ({open:'Ouvert',calculated:'Calculé',exception:'Anomalie',approved:'Approuvé',closed:'Clôturé'})[s]||s||'—'; }
  function currentAction(){ return state.status?.allowed_events?.[0] || null; }

  function styles(){
    if(document.getElementById('pointeuse-v3-styles'))return;
    const s=document.createElement('style'); s.id='pointeuse-v3-styles'; s.textContent=`
      #pointeuse-v3-root{--p3-border:#dbe3ee;--p3-muted:#64748b;--p3-ink:#10233f;--p3-soft:#f7f9fc;margin:0 0 18px;font-family:inherit;color:var(--p3-ink)}
      .pointeuse-v3-active>:not(#pointeuse-v3-root){display:none!important}
      .p3-shell{background:#fff;border:1px solid var(--p3-border);border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.05)}
      .p3-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding:18px 20px;border-bottom:1px solid var(--p3-border)}
      .p3-title{font-size:20px;font-weight:800;letter-spacing:-.02em}.p3-sub{font-size:12px;color:var(--p3-muted);margin-top:4px}.p3-mode{font-size:11px;font-weight:800;border:1px solid #cbd5e1;border-radius:999px;padding:5px 9px;text-transform:uppercase;letter-spacing:.04em}.p3-mode.active{color:#166534;background:#f0fdf4;border-color:#bbf7d0}.p3-mode.shadow{color:#92400e;background:#fffbeb;border-color:#fde68a}.p3-mode.disabled{color:#991b1b;background:#fef2f2;border-color:#fecaca}
      .p3-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--p3-border);overflow:auto}.p3-tab{appearance:none;border:0;background:transparent;padding:11px 10px;font:inherit;font-size:12px;font-weight:700;color:#64748b;cursor:pointer;border-bottom:2px solid transparent}.p3-tab[aria-selected=true]{color:#1d4ed8;border-bottom-color:#1d4ed8}.p3-body{padding:18px 20px}.p3-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.p3-stat{border:1px solid var(--p3-border);border-radius:10px;padding:12px;background:#fff}.p3-stat b{display:block;font-size:20px;margin-top:3px}.p3-stat span{font-size:10px;color:#64748b;text-transform:uppercase;font-weight:800;letter-spacing:.04em}
      .p3-today{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(280px,.6fr);gap:14px;align-items:start}.p3-panel{border:1px solid var(--p3-border);border-radius:12px;padding:16px;background:#fff}.p3-panel h3{margin:0 0 12px;font-size:14px}.p3-action{width:100%;min-height:54px;border:0;border-radius:10px;background:#163b71;color:#fff;font:inherit;font-weight:800;font-size:15px;cursor:pointer}.p3-action:disabled{background:#94a3b8;cursor:not-allowed}.p3-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.p3-meta div{background:var(--p3-soft);padding:9px;border-radius:8px}.p3-meta small{display:block;color:#64748b;font-size:10px}.p3-meta strong{font-size:12px}.p3-note{font-size:12px;color:#475569;line-height:1.5}.p3-alert{border-left:3px solid #d97706;background:#fffbeb;padding:9px 11px;margin:8px 0;font-size:12px}.p3-ok{border-left-color:#16a34a;background:#f0fdf4}.p3-table{width:100%;border-collapse:collapse;font-size:12px}.p3-table th{text-align:left;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:8px;border-bottom:1px solid var(--p3-border)}.p3-table td{padding:9px 8px;border-bottom:1px solid #eef2f7;vertical-align:top}.p3-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:7px 10px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.p3-btn.primary{background:#163b71;border-color:#163b71;color:#fff}.p3-btn.danger{color:#991b1b;border-color:#fecaca}.p3-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.p3-input,.p3-select{border:1px solid #cbd5e1;border-radius:8px;padding:8px 9px;font:inherit;font-size:12px;background:#fff}.p3-empty{text-align:center;color:#64748b;padding:28px 12px}.p3-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .pointeuse-v3-merged>:not(#pointeuse-v3-root):not(#pointeuse-v3-legacy-store):not([id^="pt-modal-"]){display:none!important}
      #pointeuse-v3-legacy-store{display:none!important}
      .p3-slot{display:block}.p3-slot>*{margin-bottom:12px!important}.p3-slot>*:last-child{margin-bottom:0!important}.p3-slot:empty{display:none}
      @media(max-width:900px){.p3-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.p3-today{grid-template-columns:1fr}}@media(max-width:560px){.p3-head{padding:14px}.p3-body{padding:12px}.p3-grid{grid-template-columns:1fr 1fr}.p3-meta{grid-template-columns:1fr}.p3-title{font-size:18px}}
    `; document.head.appendChild(s);
  }

  function target(){ return document.getElementById('page-pointeuse') || document.querySelector('[data-page="pointeuse"]'); }

  const LEGACY = {
    agentPanel: () => document.getElementById('pt-agent-panel'),
    controls: () => document.querySelector('.pt-control-bar'),
    kpis: () => document.getElementById('pt-kpis'),
    journee: () => document.getElementById('pt-journee-tbody')?.closest('.rounded-2xl') || null,
    histo: () => document.getElementById('pt-histo-tbody')?.closest('.rounded-2xl') || null,
    adminConsole: () => document.getElementById('pointeuse-v3-admin-console'),
  };
  function legacyStore(){
    let store=document.getElementById('pointeuse-v3-legacy-store');
    if(!store){ const t=target(); if(!t) return null; store=document.createElement('div'); store.id='pointeuse-v3-legacy-store'; t.appendChild(store); }
    return store;
  }
  function stashLegacy(){
    const store=legacyStore(); if(!store) return;
    Object.keys(LEGACY).forEach(key=>{ const node=LEGACY[key](); if(node && node.parentElement!==store) store.appendChild(node); });
  }
  function mountLegacy(scope){
    scope.querySelectorAll('[data-legacy]').forEach(slot=>{ const node=LEGACY[slot.dataset.legacy]?.(); if(node) slot.appendChild(node); });
  }
  function agentPanelUsable(){ const n=LEGACY.agentPanel(); return !!n && !n.classList.contains('hidden') && n.childElementCount>0; }
  function syncTopbarAction(){
    const btn=document.getElementById('btn-pt-entree'); if(!btn) return;
    const mode=state.capabilities?.mode||'shadow';
    btn.style.display=(mode==='active'||agentPanelUsable())?'none':'';
  }
  function isRoute(){ return location.pathname.replace(/\/+$/,'')==='/app/rh/pointeuse' || location.hash==='#pointeuse'; }

  function header(){
    const mode=state.capabilities?.mode||'shadow';
    const tabs=[['today','Aujourd’hui'],['history','Historique'],['corrections','Corrections']];
    if(canManage()) tabs.push(['manager','Pilotage RH'],['settings','Planning & règles'],['reconcile','Rapprochement']);
    return `<div class="p3-head"><div><div class="p3-title">Temps & présence</div><div class="p3-sub">Événements immuables · planning · anomalies · validation · paie</div></div><span class="p3-mode ${esc(mode)}">${esc(mode)}</span></div><div class="p3-tabs" role="tablist" aria-label="Pointeuse">${tabs.map(([id,l])=>`<button class="p3-tab" role="tab" data-tab="${id}" aria-selected="${state.tab===id}">${l}</button>`).join('')}</div>`;
  }

  function todayView(){
    const s=state.status||{}, d=s.summary||{}, a=s.assignment||{}, cal=s.calendar||{}; const action=currentAction(); const mode=state.capabilities?.mode||'shadow';
    const anomalyCount=Number(d.anomaly_count??d.anomalyCount??d.anomalies?.length??0);
    return `<div class="p3-today"><section class="p3-panel" aria-labelledby="p3-day-title"><h3 id="p3-day-title">Journée du ${fmtDate(s.work_date)}</h3><div class="p3-grid"><div class="p3-stat"><span>Travaillé</span><b>${fmtMinutes(d.worked_minutes??d.workedMinutes)}</b></div><div class="p3-stat"><span>Pause</span><b>${fmtMinutes(d.break_minutes??d.breakMinutes)}</b></div><div class="p3-stat"><span>Retard</span><b>${fmtMinutes(d.late_minutes)}</b></div><div class="p3-stat"><span>Heures supp.</span><b>${fmtMinutes(d.overtime_minutes)}</b></div></div><div class="p3-meta"><div><small>Planning</small><strong>${esc(a.schedule_libelle||a.schedule_code||'Non affecté')}</strong></div><div><small>Calendrier</small><strong>${esc(cal.libelle||cal.day_type||'Standard')}</strong></div><div><small>Mode autorisé</small><strong>${esc(a.mode_autorise||'bureau')}</strong></div><div><small>État</small><strong>${esc(statusLabel(d.status))}</strong></div></div>${anomalyCount?`<div class="p3-alert">${anomalyCount} anomalie(s) à traiter avant validation.</div>`:`<div class="p3-alert p3-ok">Aucune anomalie active sur la synthèse courante.</div>`}</section><section class="p3-panel"><h3>Action</h3><p class="p3-note">L’heure, l’identité, le périmètre et l’ordre des actions sont contrôlés par le serveur.</p>${mode==='active'?`<button class="p3-action" id="p3-main-action" data-event="${esc(action||'')}" ${!action?'disabled':''}>${action?actionLabel(action):'Journée terminée'}</button>`:`<p class="p3-note">Mode observation — actions V2 maintenues</p><div class="p3-slot" data-legacy="agentPanel"></div>`}<p class="p3-note" style="margin-top:10px">Dernier événement : <strong>${esc(s.last_event?.event_type||'aucun')}</strong>${s.last_event?.local_time?` à ${esc(String(s.last_event.local_time).slice(0,5))}`:''}</p></section></div>`;
  }

  async function historyView(){ const end=new Date().toISOString().slice(0,10); const start=new Date(Date.now()-14*86400000).toISOString().slice(0,10); let data={events:[]}; try{data=await api(`/me/events?debut=${start}&fin=${end}`);}catch(e){notify(e.message,'error');} return `<div class="p3-panel"><h3>Événements — 15 derniers jours</h3>${data.events?.length?`<table class="p3-table"><thead><tr><th>Date de travail</th><th>Événement</th><th>Heure</th><th>Mode</th><th>Site</th></tr></thead><tbody>${data.events.map(e=>`<tr><td>${fmtDate(e.work_date)}</td><td>${esc(actionLabel(e.event_type))}</td><td>${esc(String(e.local_time||'').slice(0,5))}</td><td>${esc(e.mode)}</td><td>${esc(e.site_code||'—')}</td></tr>`).join('')}</tbody></table>`:'<div class="p3-empty">Aucun événement V3 sur la période.</div>'}</div>`; }

  function correctionsView(){ const s=state.status||{}; return `<div class="p3-panel"><h3>Demander une correction</h3><form id="p3-correction-form" class="p3-toolbar"><label>Journée <input class="p3-input" name="work_date" type="date" required value="${esc(s.work_date||'')}"></label><label>Événement <select class="p3-select" name="requested_event_type"><option value="">Rectification générale</option><option value="clock_in">Entrée</option><option value="break_start">Début pause</option><option value="break_end">Fin pause</option><option value="clock_out">Sortie</option></select></label><label>Heure proposée <input class="p3-input" name="requested_at_utc" type="datetime-local"></label><label style="flex:1;min-width:220px">Motif <input class="p3-input" name="reason" minlength="5" required style="width:100%" placeholder="Expliquez la rectification"></label><button class="p3-btn primary" type="submit">Soumettre</button></form><p class="p3-note">Une correction approuvée crée un ajustement traçable ; l’événement physique d’origine reste immuable.</p></div>`; }

  function managerView(){
    const rows=state.anomalies||[];
    return `<div class="p3-slot" data-legacy="controls"></div><div class="p3-slot" data-legacy="kpis"></div><div class="p3-panel"><div class="p3-toolbar"><h3 style="margin:0;flex:1">File des anomalies</h3><button class="p3-btn" id="p3-refresh-manager">Actualiser</button></div>${rows.length?`<table class="p3-table"><thead><tr><th>Agent</th><th>Date</th><th>Type</th><th>Gravité</th><th>État</th><th></th></tr></thead><tbody>${rows.map(a=>`<tr><td>${esc(a.matricule||'')} · ${esc(a.prenom||'')} ${esc(a.nom||'')}</td><td>${fmtDate(a.work_date)}</td><td>${esc(a.anomaly_type)}</td><td>${esc(a.severity)}</td><td>${esc(a.status)}</td><td><button class="p3-btn" data-resolve="${a.id}">Traiter</button></td></tr>`).join('')}</tbody></table>`:'<div class="p3-empty">Aucune anomalie dans la file.</div>'}</div><div class="p3-slot" data-legacy="journee"></div><div class="p3-slot" data-legacy="histo"></div>`;
  }

  function settingsView(){ const c=state.config||{}; return `<div class="p3-grid"><div class="p3-panel"><h3>Sites</h3><div class="p3-stat"><span>Configurés</span><b>${c.sites?.length||0}</b></div></div><div class="p3-panel"><h3>Plannings</h3><div class="p3-stat"><span>Actifs</span><b>${c.schedules?.filter(x=>Number(x.actif)!==0).length||0}</b></div></div><div class="p3-panel"><h3>Calendriers</h3><div class="p3-stat"><span>Calendriers</span><b>${c.calendars?.length||0}</b></div></div><div class="p3-panel"><h3>Périodes</h3><div class="p3-stat"><span>Cycles</span><b>${c.periods?.length||0}</b></div></div></div><div class="p3-panel" style="margin-top:12px"><h3>Cycle industriel</h3><p class="p3-note">Journée : calculée → anomalies résolues → approuvée → clôturée. Période : ouverte → calculée → revue → approuvée → clôturée → snapshot paie. La réouverture est contrôlée et interdite après consommation paie.</p></div><div class="p3-slot" data-legacy="adminConsole"></div>`; }

  function reconcileView(){ const r=state.reconciliation; const today=new Date().toISOString().slice(0,10); const start=new Date(Date.now()-6*86400000).toISOString().slice(0,10); return `<div class="p3-panel"><h3>Parallèle V2 / V3</h3><div class="p3-toolbar"><label>Du <input id="p3-rec-start" class="p3-input" type="date" value="${start}"></label><label>Au <input id="p3-rec-end" class="p3-input" type="date" value="${today}"></label><button id="p3-shadow-sync" class="p3-btn">Synchroniser V2 → V3</button><button id="p3-reconcile" class="p3-btn primary">Rapprocher</button></div>${r?`<div class="p3-grid"><div class="p3-stat"><span>Lignes</span><b>${r.total}</b></div><div class="p3-stat"><span>Concordance</span><b>${r.match_rate}%</b></div><div class="p3-stat"><span>Écarts</span><b>${r.mismatches}</b></div><div class="p3-stat"><span>V3 seuls</span><b>${r.v3_only}</b></div></div>${r.rows?.filter(x=>!x.match).length?`<table class="p3-table" style="margin-top:12px"><thead><tr><th>Agent</th><th>Date</th><th>Présence</th><th>Écart durée</th><th>Entrée</th><th>Sortie</th></tr></thead><tbody>${r.rows.filter(x=>!x.match).slice(0,100).map(x=>`<tr><td>${esc(x.matricule||x.employe_id)}</td><td>${fmtDate(x.work_date)}</td><td>${esc(x.presence)}</td><td>${x.delta_minutes??'—'} min</td><td>${x.entry_match?'OK':'Écart'}</td><td>${x.exit_match?'OK':'Écart'}</td></tr>`).join('')}</tbody></table>`:'<div class="p3-alert p3-ok" style="margin-top:12px">Aucun écart sur la période rapprochée.</div>'}`:'<p class="p3-note">Synchronisez d’abord les pointages V2 en mode shadow, puis comparez les résultats avant activation.</p>'}</div>`; }

  async function renderBody(){
    const root=document.getElementById('pointeuse-v3-root'); if(!root)return;
    const body=root.querySelector('.p3-body'); stashLegacy(); body.innerHTML='<div class="p3-empty">Chargement…</div>';
    if(state.tab==='history') body.innerHTML=await historyView();
    else if(state.tab==='corrections') body.innerHTML=correctionsView();
    else if(state.tab==='manager') { await loadManager(); body.innerHTML=managerView(); }
    else if(state.tab==='settings') { await loadConfig(); body.innerHTML=settingsView(); }
    else if(state.tab==='reconcile') body.innerHTML=reconcileView();
    else body.innerHTML=todayView();
    mountLegacy(body);
    syncTopbarAction();
    bindBody();
  }

  async function loadStatus(){ state.capabilities=await api('/capabilities'); state.status=await api('/me/status'); }
  async function loadManager(){ try{ const d=await api('/anomalies'); state.anomalies=d.anomalies||[]; }catch(e){ if(e.status!==403)notify(e.message,'error'); state.anomalies=[]; } }
  async function loadConfig(){ try{ state.config=await api('/admin/config'); }catch(e){ if(e.status!==403)notify(e.message,'error'); state.config={}; } }

  function geolocation(){ return new Promise(resolve=>{ if(!navigator.geolocation)return resolve({}); navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,precision_gps:p.coords.accuracy}),()=>resolve({}),{enableHighAccuracy:true,timeout:7000,maximumAge:30000}); }); }
  async function sendEvent(type){ if(!type)return; const b=await geolocation(); try{ await api('/events',{method:'POST',headers:{'Idempotency-Key':idempotency()},body:JSON.stringify({event_type:type,mode:'bureau',...b})}); notify('Pointage enregistré'); await loadStatus(); render(); }catch(e){notify(e.message,'error');} }

  function bindBody(){
    document.getElementById('p3-main-action')?.addEventListener('click',e=>sendEvent(e.currentTarget.dataset.event));
    document.getElementById('p3-correction-form')?.addEventListener('submit',async e=>{e.preventDefault(); const f=new FormData(e.currentTarget); const local=f.get('requested_at_utc'); const body={work_date:f.get('work_date'),requested_event_type:f.get('requested_event_type')||null,requested_at_utc:local?new Date(local).toISOString():null,reason:f.get('reason')}; try{await api('/corrections',{method:'POST',body:JSON.stringify(body)});notify('Demande de correction soumise');e.currentTarget.reset();}catch(err){notify(err.message,'error');}});
    document.getElementById('p3-refresh-manager')?.addEventListener('click',renderBody);
    document.querySelectorAll('[data-resolve]').forEach(btn=>btn.addEventListener('click',async()=>{const justification=prompt('Justification de résolution (minimum 5 caractères)');if(!justification)return;try{await api(`/admin/anomalies/${btn.dataset.resolve}/resolve`,{method:'POST',body:JSON.stringify({status:'regularized',justification})});notify('Anomalie régularisée');renderBody();}catch(e){notify(e.message,'error');}}));
    document.getElementById('p3-shadow-sync')?.addEventListener('click',async()=>{const debut=document.getElementById('p3-rec-start').value,fin=document.getElementById('p3-rec-end').value;try{const r=await api('/admin/shadow-sync',{method:'POST',body:JSON.stringify({debut,fin})});notify(`${r.inserted_events} événement(s) synchronisé(s)`);}catch(e){notify(e.message,'error');}});
    document.getElementById('p3-reconcile')?.addEventListener('click',async()=>{const debut=document.getElementById('p3-rec-start').value,fin=document.getElementById('p3-rec-end').value;try{state.reconciliation=await api(`/admin/reconciliation?debut=${encodeURIComponent(debut)}&fin=${encodeURIComponent(fin)}`);renderBody();}catch(e){notify(e.message,'error');}});
  }

  function render(){
    const t=target(); if(!t||!isRoute())return;
    styles(); let root=document.getElementById('pointeuse-v3-root'); if(!root){root=document.createElement('section');root.id='pointeuse-v3-root';root.setAttribute('aria-label','Pointeuse industrielle');t.prepend(root);}
    const mode=state.capabilities?.mode||'shadow'; t.classList.toggle('pointeuse-v3-active',mode==='active'); t.classList.add('pointeuse-v3-merged');
    stashLegacy();
    root.innerHTML=`<div class="p3-shell">${header()}<div class="p3-body" role="tabpanel" aria-live="polite"></div></div><div id="p3-live" class="p3-sr" aria-live="assertive"></div>`;
    root.querySelectorAll('.p3-tab').forEach(btn=>btn.addEventListener('click',()=>{state.tab=btn.dataset.tab;render();}));
    renderBody();
  }

  async function init(){ if(!isRoute())return; const t=target(); if(!t)return; try{await loadStatus();render();}catch(e){notify(`Pointeuse V3 : ${e.message}`,'error');} }
  let timer=null; function schedule(){clearTimeout(timer);timer=setTimeout(init,80);}
  const obs=new MutationObserver(()=>{if(isRoute()&&!document.getElementById('pointeuse-v3-root'))schedule();});
  obs.observe(document.documentElement,{subtree:true,childList:true});
  window.addEventListener('popstate',schedule); window.addEventListener('hashchange',schedule); document.addEventListener('click',e=>{if(e.target.closest('[data-page="pointeuse"]'))setTimeout(schedule,120);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
})();

(function () {
  'use strict';

  const API='/api/org';
  const token=()=>localStorage.getItem('tc_token')||'';
  async function api(path,options={}){const r=await fetch(API+path,{...options,headers:{'Content-Type':'application/json',...(token()?{Authorization:`Bearer ${token()}`}:{})}});const p=await r.json().catch(()=>({}));if(!r.ok)throw new Error(p.error||`Erreur HTTP ${r.status}`);return p;}
  function toast(message,type='success'){if(typeof window.showToast==='function')return window.showToast(message,type);if(typeof window.toast==='function')return window.toast(message,type);if(type==='error')alert(message);}
  function toBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=reject;reader.readAsDataURL(file);});}
  async function chooseAndUpload(id){const detail=await api(`/fonctions/${id}`);const input=document.createElement('input');input.type='file';input.accept='application/pdf,image/jpeg,image/png';input.addEventListener('change',async()=>{const file=input.files?.[0];if(!file)return;try{const content=await toBase64(file);await api(`/fonctions/${id}/document`,{method:'POST',body:JSON.stringify({version:detail.version,file_name:file.name,mime_type:file.type,content_base64:content})});toast('Décision signée enregistrée.');if(typeof window.refreshDepartmentFunctions==='function')await window.refreshDepartmentFunctions();}catch(error){toast(error.message,'error');}});input.click();}
  function install(){const list=document.getElementById('org-functions-list');if(!list)return false;list.addEventListener('click',event=>{const button=event.target.closest('[data-action="document"]');if(!button)return;event.preventDefault();event.stopImmediatePropagation();chooseAndUpload(button.dataset.id).catch(error=>toast(error.message,'error'));},true);return true;}
  function boot(){let attempts=0;const timer=setInterval(()=>{attempts+=1;if(install()||attempts>=120)clearInterval(timer);},100);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();

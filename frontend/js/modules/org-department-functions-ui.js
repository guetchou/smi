(function () {
  'use strict';

  const API_BASE = '/api/org';
  const state = {
    initialized: false,
    canManage: false,
    departments: [],
    agents: [],
    types: {},
    currentDepartmentId: null,
    currentFunctions: [],
    renderTimer: null,
  };

  function token() { return localStorage.getItem('tc_token') || ''; }
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Erreur HTTP ${response.status}`);
    return payload;
  }
  function notify(message, type = 'success') {
    if (typeof window.showToast === 'function') return window.showToast(message, type);
    if (typeof window.toast === 'function') return window.toast(message, type);
    if (type === 'error') window.alert(message);
  }
  function label(row) { return row.fonction_libelle || state.types[row.fonction_type] || row.fonction_type || 'Fonction'; }
  function employeeName(row) {
    return row.employe_nom_complet
      || `${row.employe_nom || ''} ${row.employe_prenom || ''}`.trim()
      || `Agent #${row.employe_id}`;
  }
  function department(id) { return state.departments.find(row => Number(row.id) === Number(id)) || null; }

  function installStyles() {
    if (document.getElementById('org-department-functions-styles')) return;
    const style = document.createElement('style');
    style.id = 'org-department-functions-styles';
    style.textContent = `
      .org-dept-functions-summary{margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;display:grid;gap:6px}
      .org-dept-function-line{display:flex;gap:8px;align-items:flex-start;font-size:11px;color:#475569}
      .org-dept-function-role{min-width:96px;font-weight:700;color:#334155}
      #modal-org-department-functions .org-functions-shell{width:min(860px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}
      #org-functions-list{display:grid;gap:8px}.org-function-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;border:1px solid #e2e8f0;border-radius:12px;padding:11px;background:#fff}
      #form-org-department-function{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}#form-org-department-function .full{grid-column:1/-1}
      #form-org-department-function label{display:block;margin-bottom:5px;font-size:12px;font-weight:600;color:#475569}#form-org-department-function input,#form-org-department-function select{width:100%}
      @media(max-width:680px){.org-function-row,#form-org-department-function{grid-template-columns:1fr}#form-org-department-function .full{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  function summaryHtml(dept) {
    const functions = Array.isArray(dept.fonctions) ? dept.fonctions : [];
    const head = functions.find(row => row.fonction_type === 'interimaire')
      || functions.find(row => row.fonction_type === 'chef');
    const rows = [];
    const headName = head ? employeeName(head) : (dept.responsable_nom || 'Non désigné');
    const headRole = head ? label(head) : (dept.responsable_fonction || 'Chef de département');
    const headTitle = head?.employe_poste || dept.responsable_poste || 'Poste non renseigné';
    rows.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(headRole)}</span><span><strong>${escapeHtml(headName)}</strong><br>${escapeHtml(headTitle)}</span></div>`);
    for (const row of functions.filter(item => ['premier_adjoint', 'adjoint', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur'].includes(item.fonction_type))) {
      rows.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(label(row))}</span><span><strong>${escapeHtml(employeeName(row))}</strong><br>${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</span></div>`);
    }
    return rows.join('');
  }

  function enrichCards() {
    const cards = document.getElementById('org-dept-cards');
    if (!cards) return;
    for (const dept of state.departments) {
      const card = cards.querySelector(`[data-department-id="${Number(dept.id)}"]`);
      if (!card) continue;
      let summary = card.querySelector('.org-dept-functions-summary');
      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'org-dept-functions-summary';
        const actions = card.querySelector('.org-dept-card-actions');
        if (actions) card.insertBefore(summary, actions); else card.appendChild(summary);
      }
      const html = summaryHtml(dept);
      if (summary.innerHTML !== html) summary.innerHTML = html;
      if (state.canManage) {
        let actions = card.querySelector('.org-dept-card-actions');
        if (!actions) { actions = document.createElement('div'); actions.className = 'org-dept-card-actions'; card.appendChild(actions); }
        if (!actions.querySelector('[data-manage-department-functions]')) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'btn btn-secondary btn-xs';
          button.dataset.manageDepartmentFunctions = String(dept.id); button.textContent = 'Fonctions';
          button.addEventListener('click', () => openModal(dept.id)); actions.appendChild(button);
        }
      }
    }
  }
  function scheduleEnrichment() {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(enrichCards, 30);
  }

  function ensureModal() {
    if (document.getElementById('modal-org-department-functions')) return;
    const modal = document.createElement('div');
    modal.id = 'modal-org-department-functions';
    modal.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-3';
    modal.innerHTML = `
      <div class="modal card rounded-2xl org-functions-shell">
        <div class="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h2 id="org-functions-title" class="text-lg font-bold text-slate-900">Fonctions du département</h2><p class="text-xs text-slate-500 mt-1">Chef, adjoints, intérim, suppléance et responsables internes.</p></div><button type="button" class="btn btn-secondary btn-xs" id="org-functions-close">×</button></div>
        <div class="p-5 space-y-5"><section><h3 class="text-sm font-semibold text-slate-900 mb-3">Fonctions actives</h3><div id="org-functions-list"></div></section>
          <section id="org-functions-form-section" class="rounded-xl border border-slate-200 bg-slate-50 p-4"><h3 class="text-sm font-semibold text-slate-900 mb-3">Ajouter une fonction</h3>
            <form id="form-org-department-function">
              <div class="full"><label>Agent *</label><select id="org-function-employee" required></select></div>
              <div><label>Fonction *</label><select id="org-function-type" required></select></div><div><label>Rang / ordre</label><input id="org-function-rank" type="number" min="0" value="0"></div>
              <div><label>Début *</label><input id="org-function-start" type="date" required></div><div><label>Fin</label><input id="org-function-end" type="date"></div>
              <div class="full"><label>Périmètre</label><input id="org-function-scope" maxlength="255" placeholder="Administration, Opérations, Maintenance"></div>
              <div class="full"><label>Référence de décision</label><input id="org-function-reference" maxlength="255" placeholder="Note de service, décision, acte de nomination"></div>
              <div id="org-function-error" class="full hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"></div>
              <div class="full flex justify-end"><button id="org-function-save" type="submit" class="btn btn-primary">Enregistrer la fonction</button></div>
            </form>
          </section>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    modal.querySelector('#org-functions-close').addEventListener('click', closeModal);
    modal.querySelector('#form-org-department-function').addEventListener('submit', saveFunction);
    modal.querySelector('#org-function-type').addEventListener('change', updateEndRequirement);
    modal.querySelector('#org-functions-list').addEventListener('click', closeFunction);
  }

  function updateEndRequirement() {
    const type = document.getElementById('org-function-type')?.value;
    const end = document.getElementById('org-function-end');
    if (end) end.required = ['interimaire', 'suppleant'].includes(type);
  }
  function renderFunctions() {
    const list = document.getElementById('org-functions-list');
    if (!list) return;
    if (!state.currentFunctions.length) { list.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Aucune fonction structurée active.</div>'; return; }
    list.innerHTML = state.currentFunctions.map(row => `
      <article class="org-function-row"><div><div class="flex flex-wrap items-center gap-2"><strong class="text-sm text-slate-900">${escapeHtml(employeeName(row))}</strong><span class="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">${escapeHtml(label(row))}</span></div><div class="text-xs text-slate-600 mt-1">${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</div><div class="text-[11px] text-slate-500 mt-1">Du ${escapeHtml(row.date_debut)}${row.date_fin ? ` au ${escapeHtml(row.date_fin)}` : ''}${row.decision_reference ? ` · ${escapeHtml(row.decision_reference)}` : ''}</div></div>${state.canManage ? `<button class="btn btn-danger btn-xs" data-close-function="${Number(row.id)}">Clôturer</button>` : ''}</article>`).join('');
  }
  function fillForm() {
    const dept = department(state.currentDepartmentId);
    const eligible = state.agents.filter(agent => String(agent.departement || '').trim() === String(dept?.libelle || '').trim());
    document.getElementById('org-function-employee').innerHTML = '<option value="">— Sélectionner —</option>' + eligible.map(agent => `<option value="${Number(agent.id)}">${escapeHtml(`${agent.nom || ''} ${agent.prenom || ''}`.trim())}${agent.poste ? ` — ${escapeHtml(agent.poste)}` : ''}</option>`).join('');
    document.getElementById('org-function-type').innerHTML = Object.entries(state.types).map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('');
    document.getElementById('org-function-start').value = new Date().toISOString().slice(0, 10);
    ['org-function-end', 'org-function-scope', 'org-function-reference'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('org-function-rank').value = '0';
    document.getElementById('org-function-error').classList.add('hidden'); updateEndRequirement();
  }
  async function loadFunctions(id) {
    const payload = await api(`/departements/${Number(id)}/fonctions`);
    state.types = payload.types || state.types; state.currentFunctions = Array.isArray(payload.rows) ? payload.rows : []; renderFunctions();
  }
  async function openModal(id) {
    state.currentDepartmentId = Number(id); const dept = department(id);
    document.getElementById('org-functions-title').textContent = `Fonctions — ${dept?.libelle || 'Département'}`;
    document.getElementById('org-functions-form-section').classList.toggle('hidden', !state.canManage);
    await loadFunctions(id); fillForm(); document.getElementById('modal-org-department-functions').classList.remove('hidden');
  }
  function closeModal() { document.getElementById('modal-org-department-functions')?.classList.add('hidden'); state.currentDepartmentId = null; state.currentFunctions = []; }
  function showError(message) { const box = document.getElementById('org-function-error'); box.textContent = message; box.classList.remove('hidden'); }

  async function refreshDepartments() {
    const [departments, tree] = await Promise.all([api('/departements'), api('/arbre')]);
    state.departments = Array.isArray(departments) ? departments : []; state.agents = Array.isArray(tree.agents) ? tree.agents : [];
    if (typeof window.loadOrgDepartements === 'function') await window.loadOrgDepartements(); scheduleEnrichment();
  }
  async function saveFunction(event) {
    event.preventDefault(); const button = document.getElementById('org-function-save'); button.disabled = true;
    try {
      const payload = { employe_id: Number(document.getElementById('org-function-employee').value), fonction_type: document.getElementById('org-function-type').value, rang: Number(document.getElementById('org-function-rank').value || 0), date_debut: document.getElementById('org-function-start').value, date_fin: document.getElementById('org-function-end').value || null, perimetre: document.getElementById('org-function-scope').value.trim(), decision_reference: document.getElementById('org-function-reference').value.trim() };
      if (!payload.employe_id || !payload.fonction_type || !payload.date_debut) return showError('Agent, fonction et date de début sont obligatoires.');
      const result = await api(`/departements/${state.currentDepartmentId}/fonctions`, { method: 'POST', body: JSON.stringify(payload) });
      notify(result.hierarchy_warning || 'Fonction départementale enregistrée.', result.hierarchy_warning ? 'warning' : 'success');
      await refreshDepartments(); await loadFunctions(state.currentDepartmentId); fillForm();
    } catch (error) { showError(error.message); } finally { button.disabled = false; }
  }
  async function closeFunction(event) {
    const button = event.target.closest('[data-close-function]'); if (!button || !window.confirm('Clôturer cette fonction départementale ?')) return;
    button.disabled = true;
    try { await api(`/departements/${state.currentDepartmentId}/fonctions/${Number(button.dataset.closeFunction)}`, { method: 'DELETE' }); notify('Fonction clôturée.'); await refreshDepartments(); await loadFunctions(state.currentDepartmentId); }
    catch (error) { notify(error.message, 'error'); } finally { button.disabled = false; }
  }

  async function initialize() {
    if (state.initialized) return; const cards = document.getElementById('org-dept-cards'); if (!cards) return;
    state.initialized = true; installStyles(); ensureModal();
    try {
      const [capabilities, departments, tree] = await Promise.all([api('/departements/capabilities'), api('/departements'), api('/arbre')]);
      state.canManage = capabilities.can_manage_functions === true; state.departments = departments || []; state.agents = tree.agents || [];
      enrichCards(); new MutationObserver(scheduleEnrichment).observe(cards, { childList: true }); window.refreshDepartmentFunctions = refreshDepartments;
    } catch (error) { console.error('[org-department-functions-ui]', error); }
  }
  function boot() { let attempts = 0; const timer = window.setInterval(() => { attempts += 1; initialize(); if (state.initialized || attempts >= 120) window.clearInterval(timer); }, 100); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();

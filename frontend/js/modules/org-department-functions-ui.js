(function () {
  'use strict';

  const API_BASE = '/api/org';
  const state = {
    initialized: false,
    loading: false,
    canManage: false,
    departments: [],
    agents: [],
    currentDepartmentId: null,
    currentFunctions: [],
    functionTypes: {},
  };

  function token() {
    return localStorage.getItem('tc_token') || '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
    if (!response.ok) {
      const error = new Error(payload.error || `Erreur HTTP ${response.status}`);
      error.code = payload.code;
      error.details = payload.details;
      throw error;
    }
    return payload;
  }

  function notify(message, type = 'success') {
    if (typeof window.showToast === 'function') return window.showToast(message, type);
    if (typeof window.toast === 'function') return window.toast(message, type);
    if (type === 'error') window.alert(message);
  }

  function installStyles() {
    if (document.getElementById('org-department-functions-styles')) return;
    const style = document.createElement('style');
    style.id = 'org-department-functions-styles';
    style.textContent = `
      .org-dept-functions-summary { margin-top:10px; padding-top:10px; border-top:1px solid #e2e8f0; display:grid; gap:6px; }
      .org-dept-function-line { display:flex; gap:8px; align-items:flex-start; font-size:11px; color:#475569; }
      .org-dept-function-role { min-width:90px; font-weight:700; color:#334155; }
      #modal-org-department-functions .org-functions-shell { width:min(860px,calc(100vw - 24px)); max-height:calc(100dvh - 24px); overflow:auto; }
      #org-functions-list { display:grid; gap:8px; }
      .org-function-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; border:1px solid #e2e8f0; border-radius:12px; padding:11px; background:#fff; }
      #form-org-department-function { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      #form-org-department-function .full { grid-column:1/-1; }
      #form-org-department-function label { display:block; margin-bottom:5px; font-size:12px; font-weight:600; color:#475569; }
      #form-org-department-function input,#form-org-department-function select,#form-org-department-function textarea { width:100%; }
      @media(max-width:680px){.org-function-row{grid-template-columns:1fr}#form-org-department-function{grid-template-columns:1fr}#form-org-department-function .full{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  function departmentById(id) {
    return state.departments.find(item => Number(item.id) === Number(id)) || null;
  }

  function activeFunctions(department) {
    return Array.isArray(department?.fonctions) ? department.fonctions : [];
  }

  function functionLabel(row) {
    return row.fonction_libelle || state.functionTypes[row.fonction_type] || row.fonction_type || 'Fonction';
  }

  function employeeLabel(row) {
    return row.employe_nom_complet
      || `${row.employe_nom || ''} ${row.employe_prenom || ''}`.trim()
      || `Agent #${row.employe_id}`;
  }

  function renderSummary(department) {
    const functions = activeFunctions(department);
    const head = functions.find(row => row.fonction_type === 'interimaire')
      || functions.find(row => row.fonction_type === 'chef');
    const deputies = functions.filter(row => ['premier_adjoint', 'adjoint', 'suppleant'].includes(row.fonction_type));
    const internal = functions.filter(row => ['chef_service', 'chef_section', 'coordonnateur'].includes(row.fonction_type));

    const managerName = head ? employeeLabel(head) : (department.responsable_nom || 'Non désigné');
    const managerTitle = head?.employe_poste || department.responsable_poste || 'Poste non renseigné';
    const managerRole = head ? functionLabel(head) : (department.responsable_fonction || 'Chef de département');

    const lines = [
      `<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(managerRole)}</span><span><strong>${escapeHtml(managerName)}</strong><br>${escapeHtml(managerTitle)}</span></div>`,
    ];
    for (const row of deputies) {
      lines.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(functionLabel(row))}</span><span><strong>${escapeHtml(employeeLabel(row))}</strong><br>${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</span></div>`);
    }
    for (const row of internal) {
      lines.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(functionLabel(row))}</span><span>${escapeHtml(employeeLabel(row))}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</span></div>`);
    }
    return lines.join('');
  }

  function enrichCards() {
    const cards = document.getElementById('org-dept-cards');
    if (!cards) return;
    for (const department of state.departments) {
      const card = cards.querySelector(`[data-department-id="${Number(department.id)}"]`);
      if (!card) continue;
      let summary = card.querySelector('.org-dept-functions-summary');
      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'org-dept-functions-summary';
        const actions = card.querySelector('.org-dept-card-actions');
        if (actions) card.insertBefore(summary, actions);
        else card.appendChild(summary);
      }
      summary.innerHTML = renderSummary(department);

      if (state.canManage) {
        let actions = card.querySelector('.org-dept-card-actions');
        if (!actions) {
          actions = document.createElement('div');
          actions.className = 'org-dept-card-actions';
          card.appendChild(actions);
        }
        if (!actions.querySelector('[data-manage-department-functions]')) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-secondary btn-xs';
          button.dataset.manageDepartmentFunctions = String(department.id);
          button.textContent = 'Fonctions';
          button.addEventListener('click', () => openModal(department.id));
          actions.appendChild(button);
        }
      }
    }
  }

  function ensureModal() {
    if (document.getElementById('modal-org-department-functions')) return;
    const modal = document.createElement('div');
    modal.id = 'modal-org-department-functions';
    modal.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-3';
    modal.innerHTML = `
      <div class="modal card rounded-2xl org-functions-shell">
        <div class="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><h2 id="org-functions-title" class="text-lg font-bold text-slate-900">Fonctions du département</h2><p class="text-xs text-slate-500 mt-1">Chef, adjoints, intérim, suppléance et responsables internes.</p></div>
          <button type="button" class="btn btn-secondary btn-xs" id="org-functions-close">×</button>
        </div>
        <div class="p-5 space-y-5">
          <section>
            <h3 class="text-sm font-semibold text-slate-900 mb-3">Fonctions actives</h3>
            <div id="org-functions-list"></div>
          </section>
          <section id="org-functions-form-section" class="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 class="text-sm font-semibold text-slate-900 mb-3">Ajouter une fonction</h3>
            <form id="form-org-department-function">
              <div class="full"><label for="org-function-employee">Agent *</label><select id="org-function-employee" required></select></div>
              <div><label for="org-function-type">Fonction *</label><select id="org-function-type" required></select></div>
              <div><label for="org-function-rank">Rang / ordre</label><input id="org-function-rank" type="number" min="0" value="0"></div>
              <div><label for="org-function-start">Début *</label><input id="org-function-start" type="date" required></div>
              <div><label for="org-function-end">Fin</label><input id="org-function-end" type="date"></div>
              <div class="full"><label for="org-function-scope">Périmètre</label><input id="org-function-scope" type="text" maxlength="255" placeholder="Ex. Administration, Opérations, Maintenance"></div>
              <div class="full"><label for="org-function-reference">Référence de décision</label><input id="org-function-reference" type="text" maxlength="255" placeholder="Note de service, décision, acte de nomination"></div>
              <div id="org-function-error" class="full hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"></div>
              <div class="full flex justify-end"><button id="org-function-save" type="submit" class="btn btn-primary">Enregistrer la fonction</button></div>
            </form>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    modal.querySelector('#org-functions-close').addEventListener('click', closeModal);
    modal.querySelector('#form-org-department-function').addEventListener('submit', saveFunction);
    modal.querySelector('#org-function-type').addEventListener('change', updateTemporaryRequirement);
    modal.querySelector('#org-functions-list').addEventListener('click', handleFunctionAction);
  }

  function updateTemporaryRequirement() {
    const type = document.getElementById('org-function-type')?.value;
    const end = document.getElementById('org-function-end');
    if (!end) return;
    end.required = ['interimaire', 'suppleant'].includes(type);
    end.closest('div')?.classList.toggle('ring-1', end.required);
  }

  function renderFunctionList() {
    const container = document.getElementById('org-functions-list');
    if (!container) return;
    if (!state.currentFunctions.length) {
      container.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Aucune fonction structurée active.</div>';
      return;
    }
    container.innerHTML = state.currentFunctions.map(row => `
      <article class="org-function-row">
        <div>
          <div class="flex flex-wrap items-center gap-2"><strong class="text-sm text-slate-900">${escapeHtml(employeeLabel(row))}</strong><span class="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">${escapeHtml(functionLabel(row))}</span></div>
          <div class="text-xs text-slate-600 mt-1">${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</div>
          <div class="text-[11px] text-slate-500 mt-1">Du ${escapeHtml(row.date_debut)}${row.date_fin ? ` au ${escapeHtml(row.date_fin)}` : ''}${row.decision_reference ? ` · ${escapeHtml(row.decision_reference)}` : ''}</div>
        </div>
        ${state.canManage ? `<button type="button" class="btn btn-danger btn-xs" data-close-function="${Number(row.id)}" ${row.fonction_type === 'chef' ? 'title="Nommez un remplaçant avant clôture"' : ''}>Clôturer</button>` : ''}
      </article>
    `).join('');
  }

  function fillForm() {
    const department = departmentById(state.currentDepartmentId);
    const agents = state.agents.filter(agent => String(agent.departement || '').trim() === String(department?.libelle || '').trim());
    const employee = document.getElementById('org-function-employee');
    employee.innerHTML = '<option value="">— Sélectionner un agent du département —</option>' + agents
      .sort((a, b) => `${a.nom || ''} ${a.prenom || ''}`.localeCompare(`${b.nom || ''} ${b.prenom || ''}`, 'fr'))
      .map(agent => `<option value="${Number(agent.id)}">${escapeHtml(`${agent.nom || ''} ${agent.prenom || ''}`.trim())}${agent.poste ? ` — ${escapeHtml(agent.poste)}` : ''}</option>`)
      .join('');

    const type = document.getElementById('org-function-type');
    type.innerHTML = Object.entries(state.functionTypes)
      .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
      .join('');
    document.getElementById('org-function-start').value = new Date().toISOString().slice(0, 10);
    document.getElementById('org-function-end').value = '';
    document.getElementById('org-function-rank').value = '0';
    document.getElementById('org-function-scope').value = '';
    document.getElementById('org-function-reference').value = '';
    document.getElementById('org-function-error').classList.add('hidden');
    updateTemporaryRequirement();
  }

  async function loadFunctions(departmentId) {
    const payload = await api(`/departements/${Number(departmentId)}/fonctions`);
    state.currentFunctions = Array.isArray(payload.rows) ? payload.rows : [];
    state.functionTypes = payload.types || state.functionTypes;
    renderFunctionList();
  }

  async function openModal(departmentId) {
    ensureModal();
    state.currentDepartmentId = Number(departmentId);
    const department = departmentById(departmentId);
    document.getElementById('org-functions-title').textContent = `Fonctions — ${department?.libelle || 'Département'}`;
    document.getElementById('org-functions-form-section').classList.toggle('hidden', !state.canManage);
    await loadFunctions(departmentId);
    fillForm();
    document.getElementById('modal-org-department-functions').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-org-department-functions')?.classList.add('hidden');
    state.currentDepartmentId = null;
    state.currentFunctions = [];
  }

  function showFormError(message) {
    const box = document.getElementById('org-function-error');
    if (!box) return;
    box.textContent = message;
    box.classList.remove('hidden');
  }

  async function saveFunction(event) {
    event.preventDefault();
    const button = document.getElementById('org-function-save');
    button.disabled = true;
    document.getElementById('org-function-error').classList.add('hidden');
    try {
      const payload = {
        employe_id: Number(document.getElementById('org-function-employee').value),
        fonction_type: document.getElementById('org-function-type').value,
        rang: Number(document.getElementById('org-function-rank').value || 0),
        date_debut: document.getElementById('org-function-start').value,
        date_fin: document.getElementById('org-function-end').value || null,
        perimetre: document.getElementById('org-function-scope').value.trim(),
        decision_reference: document.getElementById('org-function-reference').value.trim(),
      };
      if (!payload.employe_id || !payload.fonction_type || !payload.date_debut) {
        return showFormError('Agent, fonction et date de début sont obligatoires.');
      }
      const result = await api(`/departements/${state.currentDepartmentId}/fonctions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.hierarchy_warning) notify(result.hierarchy_warning, 'warning');
      else notify('Fonction départementale enregistrée.');
      await refreshDepartments();
      await loadFunctions(state.currentDepartmentId);
      fillForm();
    } catch (error) {
      showFormError(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function handleFunctionAction(event) {
    const button = event.target.closest('[data-close-function]');
    if (!button) return;
    const functionId = Number(button.dataset.closeFunction);
    if (!window.confirm('Clôturer cette fonction départementale ?')) return;
    button.disabled = true;
    try {
      await api(`/departements/${state.currentDepartmentId}/fonctions/${functionId}`, { method: 'DELETE' });
      notify('Fonction clôturée.');
      await refreshDepartments();
      await loadFunctions(state.currentDepartmentId);
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function refreshDepartments() {
    const rows = await api('/departements');
    state.departments = Array.isArray(rows) ? rows : [];
    if (typeof window.loadOrgDepartements === 'function') await window.loadOrgDepartements();
    window.setTimeout(enrichCards, 80);
  }

  async function loadInitialData() {
    const [capabilities, departments, tree] = await Promise.all([
      api('/departements/capabilities'),
      api('/departements'),
      api('/arbre'),
    ]);
    state.canManage = capabilities.can_manage_functions === true;
    state.departments = Array.isArray(departments) ? departments : [];
    state.agents = Array.isArray(tree.agents) ? tree.agents : [];
  }

  async function initialize() {
    if (state.initialized) return;
    const cards = document.getElementById('org-dept-cards');
    if (!cards) return;
    state.initialized = true;
    installStyles();
    ensureModal();
    try {
      await loadInitialData();
      enrichCards();
      const observer = new MutationObserver(() => window.setTimeout(enrichCards, 20));
      observer.observe(cards, { childList: true, subtree: true });
      window.refreshDepartmentFunctions = refreshDepartments;
    } catch (error) {
      console.error('[org-department-functions-ui]', error);
    }
  }

  function boot() {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      initialize();
      if (state.initialized || attempts >= 120) window.clearInterval(timer);
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

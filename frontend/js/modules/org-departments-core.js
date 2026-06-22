(function () {
  'use strict';

  const API_BASE = '/api/org';
  const state = {
    departments: new Map(),
    agents: [],
    canManage: false,
    initialized: false,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function loadCapabilities() {
    try {
      if (!window.TalaOrgCapabilities) return false;
      await window.TalaOrgCapabilities.load();
      return window.TalaOrgCapabilities.can('manage_departments');
    } catch (_) {
      return false;
    }
  }

  async function api(path, options = {}) {
    const token = localStorage.getItem('tc_token');
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Erreur HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function notify(message, type = 'success') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }
    if (typeof window.toast === 'function') {
      window.toast(message, type);
      return;
    }
    if (type === 'error') window.alert(message);
  }

  function installStyles() {
    if (document.getElementById('org-departments-crud-styles')) return;
    const style = document.createElement('style');
    style.id = 'org-departments-crud-styles';
    style.textContent = `
      #org-departments-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
      #org-departments-toolbar .org-dept-toolbar-copy { min-width:0; }
      #org-dept-cards .org-dept-card { display:flex; flex-direction:column; min-height:180px; }
      #org-dept-cards .org-dept-card-actions { margin-top:auto; padding-top:14px; display:flex; flex-wrap:wrap; gap:8px; }
      #modal-org-departement .org-dept-modal-shell { width:min(680px, calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:hidden; display:flex; flex-direction:column; }
      #modal-org-departement .org-dept-modal-body { overflow-y:auto; padding:20px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
      #modal-org-departement .org-dept-field-full { grid-column:1 / -1; }
      #modal-org-departement .org-dept-modal-footer { display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid #e2e8f0; background:#fff; }
      #modal-org-departement label { display:block; margin-bottom:6px; font-size:12px; font-weight:600; color:#475569; }
      #modal-org-departement input, #modal-org-departement select, #modal-org-departement textarea { width:100%; }
      @media (max-width:640px) {
        #org-departments-toolbar { align-items:flex-start; flex-direction:column; }
        #modal-org-departement .org-dept-modal-body { grid-template-columns:1fr; padding:16px; }
        #modal-org-departement .org-dept-field-full { grid-column:auto; }
      }
    `;
    document.head.appendChild(style);
  }

  function installToolbar() {
    const panel = document.getElementById('org-panel-departements');
    const cards = document.getElementById('org-dept-cards');
    if (!panel || !cards || document.getElementById('org-departments-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'org-departments-toolbar';
    toolbar.innerHTML = `
      <div class="org-dept-toolbar-copy">
        <h3 class="text-sm font-semibold text-slate-900">Référentiel des départements</h3>
        <p class="text-xs text-slate-500 mt-1">Créer, désigner un responsable et maintenir les unités RH.</p>
      </div>
      ${state.canManage ? '<button type="button" class="btn btn-primary text-sm" onclick="orgNewDepartement()">+ Nouveau département</button>' : '<span class="text-xs text-slate-400">Consultation seule</span>'}
    `;
    panel.insertBefore(toolbar, cards);
  }

  function installModal() {
    if (document.getElementById('modal-org-departement')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'modal-org-departement';
    wrapper.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-4';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-labelledby', 'org-dept-modal-title');
    wrapper.addEventListener('click', event => {
      if (event.target === wrapper) closeDepartmentModal();
    });
    wrapper.innerHTML = `
      <div class="modal card rounded-2xl org-dept-modal-shell fade-in">
        <div class="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2 id="org-dept-modal-title" class="text-lg font-bold text-slate-900">Nouveau département</h2>
            <p class="text-xs text-slate-500 mt-1">Les champs marqués d’un astérisque sont obligatoires.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-xs" onclick="orgCloseDepartement()" aria-label="Fermer">×</button>
        </div>
        <form id="form-org-departement" novalidate>
          <input type="hidden" id="org-dept-id">
          <input type="hidden" id="org-dept-original-libelle">
          <input type="hidden" id="org-dept-nb-agents" value="0">
          <div class="org-dept-modal-body">
            <div>
              <label for="org-dept-libelle">Libellé *</label>
              <input id="org-dept-libelle" type="text" maxlength="255" required autocomplete="organization-title" placeholder="Ex. Ressources humaines">
            </div>
            <div>
              <label for="org-dept-code">Code</label>
              <input id="org-dept-code" type="text" maxlength="50" placeholder="Ex. RH">
            </div>
            <div class="org-dept-field-full">
              <label for="org-dept-responsable">Responsable *</label>
              <select id="org-dept-responsable" required><option value="" disabled>— Sélectionner un responsable —</option></select>
            </div>
            <div class="org-dept-field-full">
              <label for="org-dept-description">Description</label>
              <textarea id="org-dept-description" rows="4" maxlength="2000" placeholder="Mission et périmètre du département"></textarea>
            </div>
            <div id="org-dept-form-warning" class="org-dept-field-full hidden rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"></div>
            <div id="org-dept-form-error" class="org-dept-field-full hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert"></div>
          </div>
          <div class="org-dept-modal-footer">
            <button type="button" class="btn btn-secondary" onclick="orgCloseDepartement()">Annuler</button>
            <button id="org-dept-submit" type="submit" class="btn btn-primary">Enregistrer</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(wrapper);
    document.getElementById('form-org-departement').addEventListener('submit', saveDepartment);
  }

  function populateResponsibleSelect(selectedId = '') {
    const select = document.getElementById('org-dept-responsable');
    if (!select) return;
    const options = state.agents
      .slice()
      .sort((a, b) => `${a.nom || ''} ${a.prenom || ''}`.localeCompare(`${b.nom || ''} ${b.prenom || ''}`, 'fr'))
      .map(agent => {
        const label = `${agent.nom || ''} ${agent.prenom || ''}`.trim() || agent.matricule || `Agent #${agent.id}`;
        return `<option value="${Number(agent.id)}" ${String(agent.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(label)}${agent.poste ? ` — ${escapeHtml(agent.poste)}` : ''}</option>`;
      })
      .join('');
    select.innerHTML = `<option value="" disabled ${selectedId ? '' : 'selected'}>— Sélectionner un responsable —</option>${options}`;
  }

  async function loadAgents() {
    try {
      const data = await api('/arbre');
      state.agents = Array.isArray(data.agents) ? data.agents : [];
    } catch (_) {
      state.agents = [];
    }
  }

  function renderDepartmentCards(rows) {
    const cards = document.getElementById('org-dept-cards');
    if (!cards) return;

    if (!rows.length) {
      cards.innerHTML = `
        <div class="col-span-3 card rounded-2xl p-8 text-center">
          <div class="text-sm font-semibold text-slate-700">Aucun département</div>
          <div class="text-xs text-slate-500 mt-1">Créez le premier département pour structurer l’organigramme.</div>
          ${state.canManage ? '<button type="button" class="btn btn-primary text-sm mt-4" onclick="orgNewDepartement()">+ Nouveau département</button>' : ''}
        </div>`;
      return;
    }

    cards.innerHTML = rows.map(department => {
      const id = Number(department.id);
      const count = Number(department.nb_agents || 0);
      return `
        <article class="card rounded-2xl p-4 org-dept-card" data-department-id="${id}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-sm font-bold text-slate-900 break-words">${escapeHtml(department.libelle)}</h3>
                ${department.code ? `<span class="text-[11px] font-semibold rounded-full bg-blue-50 text-blue-700 px-2 py-0.5">${escapeHtml(department.code)}</span>` : ''}
              </div>
              <p class="text-xs text-slate-500 mt-2 line-clamp-3">${escapeHtml(department.description || 'Aucune description')}</p>
            </div>
            <div class="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center font-bold flex-shrink-0">${count}</div>
          </div>
          <div class="mt-4 space-y-2 text-xs text-slate-600">
            <div><span class="font-semibold text-slate-700">Agents :</span> ${count}</div>
            <div><span class="font-semibold text-slate-700">Responsable :</span> ${escapeHtml(department.responsable_nom || 'Non désigné')}</div>
          </div>
          ${state.canManage ? `
            <div class="org-dept-card-actions">
              <button type="button" class="btn btn-secondary btn-xs" onclick="orgEditDepartement(${id})">Modifier</button>
              <button type="button" class="btn btn-danger btn-xs" onclick="orgDeactivateDepartement(${id})">Désactiver</button>
            </div>` : ''}
        </article>`;
    }).join('');
  }

  async function renderDepartments() {
    const cards = document.getElementById('org-dept-cards');
    if (!cards) return;
    cards.innerHTML = '<div class="col-span-3 text-center py-12 text-slate-400">Chargement…</div>';
    try {
      const rows = await api('/departements');
      const list = Array.isArray(rows) ? rows : [];
      state.departments = new Map(list.map(row => [Number(row.id), row]));
      renderDepartmentCards(list);

      const filter = document.getElementById('org-filtre-dept');
      if (filter) {
        const current = filter.value;
        filter.innerHTML = '<option value="">Tous les départements</option>' + list
          .map(row => `<option value="${escapeHtml(row.libelle)}">${escapeHtml(row.libelle)}</option>`)
          .join('');
        if ([...filter.options].some(option => option.value === current)) filter.value = current;
      }
    } catch (error) {
      cards.innerHTML = `<div class="col-span-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">${escapeHtml(error.message)}</div>`;
    }
  }

  function openDepartmentModal(department = null) {
    if (!state.canManage) {
      notify('Permission de modification RH requise.', 'error');
      return;
    }
    const modal = document.getElementById('modal-org-departement');
    if (!modal) return;

    const isEdit = Boolean(department);
    document.getElementById('org-dept-modal-title').textContent = isEdit ? 'Modifier le département' : 'Nouveau département';
    document.getElementById('org-dept-id').value = department?.id || '';
    document.getElementById('org-dept-original-libelle').value = department?.libelle || '';
    document.getElementById('org-dept-nb-agents').value = department?.nb_agents || 0;
    document.getElementById('org-dept-libelle').value = department?.libelle || '';
    document.getElementById('org-dept-code').value = department?.code || '';
    document.getElementById('org-dept-description').value = department?.description || '';
    document.getElementById('org-dept-form-error').classList.add('hidden');

    const warning = document.getElementById('org-dept-form-warning');
    const count = Number(department?.nb_agents || 0);
    if (isEdit && count > 0) {
      warning.textContent = `Ce département contient ${count} agent(s). Son libellé ne peut pas être renommé depuis cet écran afin d’éviter de rompre leurs rattachements historiques.`;
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
      warning.textContent = '';
    }

    populateResponsibleSelect(department?.responsable_id || '');
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('org-dept-libelle')?.focus(), 0);
  }

  function closeDepartmentModal() {
    document.getElementById('modal-org-departement')?.classList.add('hidden');
  }

  function showFormError(message) {
    const box = document.getElementById('org-dept-form-error');
    if (!box) return;
    box.textContent = message;
    box.classList.remove('hidden');
  }

  async function saveDepartment(event) {
    event.preventDefault();
    if (!state.canManage) return showFormError('Permission de modification RH requise.');

    const id = document.getElementById('org-dept-id').value;
    const originalLabel = document.getElementById('org-dept-original-libelle').value.trim();
    const agentCount = Number(document.getElementById('org-dept-nb-agents').value || 0);
    const libelle = document.getElementById('org-dept-libelle').value.trim();
    const code = document.getElementById('org-dept-code').value.trim();
    const responsableId = document.getElementById('org-dept-responsable').value;
    const description = document.getElementById('org-dept-description').value.trim();

    if (!libelle) return showFormError('Le libellé du département est obligatoire.');
    if (!responsableId) return showFormError('Le responsable du département est obligatoire.');
    if (id && agentCount > 0 && originalLabel && libelle !== originalLabel) {
      return showFormError('Renommage bloqué : ce département contient encore des agents. Transférez-les d’abord ou mettez en place une migration transactionnelle.');
    }

    const submit = document.getElementById('org-dept-submit');
    submit.disabled = true;
    submit.textContent = 'Enregistrement…';
    document.getElementById('org-dept-form-error').classList.add('hidden');

    try {
      const payload = {
        libelle,
        code,
        responsable_id: Number(responsableId),
        description,
      };
      await api(id ? `/departements/${Number(id)}` : '/departements', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeDepartmentModal();
      notify(id ? 'Département modifié.' : 'Département créé.');
      await renderDepartments();
      if (typeof window.loadOrgArbre === 'function') await window.loadOrgArbre();
    } catch (error) {
      showFormError(error.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Enregistrer';
    }
  }

  async function deactivateDepartment(id) {
    const department = state.departments.get(Number(id));
    if (!department || !state.canManage) return;
    const count = Number(department.nb_agents || 0);
    if (count > 0) {
      notify(`Désactivation impossible : ${count} agent(s) sont encore rattachés à ce département.`, 'error');
      return;
    }
    if (!window.confirm(`Désactiver le département « ${department.libelle} » ?`)) return;

    try {
      await api(`/departements/${Number(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ actif: false }),
      });
      notify('Département désactivé.');
      await renderDepartments();
      if (typeof window.loadOrgArbre === 'function') await window.loadOrgArbre();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function initialize() {
    if (state.initialized) return;
    const panel = document.getElementById('org-panel-departements');
    const cards = document.getElementById('org-dept-cards');
    if (!panel || !cards) return;

    state.initialized = true;
    state.canManage = await loadCapabilities();
    installStyles();
    installToolbar();
    installModal();
    await loadAgents();

    window.loadOrgDepartements = renderDepartments;
    window.orgNewDepartement = () => openDepartmentModal();
    window.orgEditDepartement = id => openDepartmentModal(state.departments.get(Number(id)) || null);
    window.orgCloseDepartement = closeDepartmentModal;
    window.orgSaveDepartement = saveDepartment;
    window.orgDeactivateDepartement = deactivateDepartment;

    await renderDepartments();
  }

  function boot() {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (document.getElementById('org-panel-departements') && document.getElementById('org-dept-cards')) {
        window.clearInterval(timer);
        initialize().catch(error => notify(error.message, 'error'));
      } else if (attempts >= 100) {
        window.clearInterval(timer);
      }
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

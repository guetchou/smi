(function () {
  'use strict';

  const API_ROOT = '/api';
  const FIELD_CONFIG = {
    'ag-poste': { key: 'postes', placeholder: '— Sélectionner un poste —' },
    'ag-departement': { key: 'departements', placeholder: '— Sélectionner un département —' },
    'ag-site': { key: 'sites', placeholder: '— Sélectionner un site —' },
    'ag-superieur': { key: 'agents', placeholder: '— Aucun supérieur hiérarchique —' },
  };

  const state = { postes: [], departements: [], sites: [], agents: [], loading: null, loadedAt: 0, lastAgentId: null, controlsReady: false };

  function token() { return localStorage.getItem('tc_token') || ''; }
  async function request(path, options = {}) {
    // Les lectures passent par le transport partage : son cache et sa
    // deduplication valent alors pour tous les modules, pas seulement pour
    // celui qui a appele en premier. Le contrat est conserve : on leve.
    if (String(options.method || 'GET').toUpperCase() === 'GET' && typeof window.api === 'function') {
      const donnees = await window.api(API_ROOT.replace(/^\/api/, '') + path, options);
      if (donnees === null) throw new Error('Erreur de chargement');
      return donnees;
    }
    const response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(options.headers || {}) },
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
  function currentAgentId() {
    const parsed = Number(document.getElementById('agent-id')?.value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function ensureSupervisorIdField() {
    let hidden = document.getElementById('ag-superieur-id');
    if (hidden) return hidden;
    hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.id = 'ag-superieur-id';
    document.getElementById('ag-superieur')?.insertAdjacentElement('afterend', hidden);
    return hidden;
  }
  function optionRows(key) {
    if (key === 'agents') {
      const selfId = currentAgentId();
      return state.agents.filter(a => Number(a.id) !== selfId).map(a => ({
        value: `${a.nom || ''} ${a.prenom || ''}`.trim(),
        label: `${a.nom || ''} ${a.prenom || ''}`.trim() + (a.matricule ? ` — ${a.matricule}` : '') + (a.poste ? ` · ${a.poste}` : ''),
        employeeId: Number(a.id),
      }));
    }
    const rows = key === 'departements'
      ? state.departements.filter(row => row.responsable_id && row.responsable_nom)
      : state[key];
    return rows.map(row => ({ value: row.libelle || '', label: row.libelle || '', id: Number(row.id) }));
  }
  function ensureProxySelect(fieldId) {
    const source = document.getElementById(fieldId);
    if (!source) return null;
    if (source.tagName === 'SELECT') return source;
    const proxyId = `${fieldId}-select`;
    let proxy = document.getElementById(proxyId);
    if (proxy) return proxy;
    proxy = document.createElement('select'); proxy.id = proxyId; proxy.dataset.organizationProxyFor = fieldId; proxy.className = source.className;
    proxy.disabled = source.disabled; proxy.required = source.required;
    source.insertAdjacentElement('afterend', proxy); source.classList.add('hidden'); source.setAttribute('aria-hidden', 'true');
    const label = document.querySelector(`label[for="${fieldId}"]`); if (label) label.setAttribute('for', proxyId);
    proxy.addEventListener('change', () => {
      source.value = proxy.value; source.dispatchEvent(new Event('change', { bubbles: true }));
      if (fieldId === 'ag-superieur') ensureSupervisorIdField().value = proxy.selectedOptions[0]?.dataset.employeeId || '';
      if (fieldId === 'ag-departement') applyDepartmentManager({ notifyUser: true });
    });
    return proxy;
  }
  function populateSelect(fieldId) {
    const config = FIELD_CONFIG[fieldId], source = document.getElementById(fieldId), select = ensureProxySelect(fieldId);
    if (!config || !source || !select) return;
    const currentValue = source.value || select.value || '', rows = optionRows(config.key);
    select.innerHTML = `<option value="">${config.placeholder}</option>`;
    rows.forEach(row => {
      const option = document.createElement('option'); option.value = row.value; option.textContent = row.label;
      if (row.employeeId) option.dataset.employeeId = String(row.employeeId); if (row.id) option.dataset.referenceId = String(row.id);
      select.appendChild(option);
    });
    if (currentValue && !rows.some(row => row.value === currentValue)) {
      const legacy = document.createElement('option'); legacy.value = currentValue; legacy.textContent = `${currentValue} — valeur historique`; select.appendChild(legacy);
    }
    select.value = currentValue;
    if (fieldId === 'ag-superieur') ensureSupervisorIdField().value = select.selectedOptions[0]?.dataset.employeeId || '';
  }
  function selectedDepartment() {
    const value = document.getElementById('ag-departement')?.value || '';
    return state.departements.find(row => row.libelle === value) || null;
  }
  function ensureDepartmentManagerHint() {
    let hint = document.getElementById('ag-departement-responsable-hint'); if (hint) return hint;
    const select = document.getElementById('ag-departement-select') || document.getElementById('ag-departement'); if (!select) return null;
    hint = document.createElement('div'); hint.id = 'ag-departement-responsable-hint'; hint.className = 'mt-1 text-xs text-slate-500'; select.insertAdjacentElement('afterend', hint); return hint;
  }
  function setSupervisorLocked(locked) {
    const select = document.getElementById('ag-superieur-select') || document.getElementById('ag-superieur');
    if (!select) return;
    select.disabled = !!locked;
    select.title = locked ? 'Défini automatiquement par le responsable du département' : '';
  }
  function selectSupervisorById(employeeId) {
    const select = document.getElementById('ag-superieur-select') || document.getElementById('ag-superieur');
    const source = document.getElementById('ag-superieur');
    if (!select || !source || select.tagName !== 'SELECT') return false;
    const option = [...select.options].find(item => Number(item.dataset.employeeId) === Number(employeeId)); if (!option) return false;
    select.value = option.value; source.value = option.value; ensureSupervisorIdField().value = String(employeeId); return true;
  }
  function renderDepartmentManagerHint() {
    const hint = ensureDepartmentManagerHint(); if (!hint) return;
    const department = selectedDepartment();
    hint.className = 'mt-1 text-xs text-slate-500';
    if (!department) { hint.textContent = ''; return; }
    if (!department.responsable_id || !department.responsable_nom) {
      hint.className = 'mt-1 text-xs text-rose-700';
      hint.textContent = 'Affectation impossible : ce département ne possède aucun responsable actif.';
      return;
    }
    if (Number(department.responsable_id) === currentAgentId()) {
      hint.className = 'mt-1 text-xs text-amber-700';
      hint.textContent = 'Cet agent est le responsable du département : choisissez son supérieur de niveau supérieur pour éviter l’auto-supervision.';
      return;
    }
    hint.textContent = '';
  }
  function applyDepartmentManager({ notifyUser = false } = {}) {
    const department = selectedDepartment();
    if (!department) { setSupervisorLocked(false); renderDepartmentManagerHint(); return true; }
    if (!department.responsable_id || !department.responsable_nom) {
      setSupervisorLocked(true); ensureSupervisorIdField().value = ''; renderDepartmentManagerHint();
      if (notifyUser) notify('Ce département doit d’abord recevoir un responsable actif.', 'error');
      return false;
    }
    if (Number(department.responsable_id) === currentAgentId()) {
      setSupervisorLocked(false); renderDepartmentManagerHint(); return true;
    }
    const applied = selectSupervisorById(department.responsable_id);
    setSupervisorLocked(applied);
    renderDepartmentManagerHint();
    if (!applied) {
      if (notifyUser) notify('Le responsable du département est introuvable ou inactif.', 'error');
      return false;
    }
    if (notifyUser) notify('Supérieur hiérarchique synchronisé avec le département.');
    return true;
  }
  function enforceDepartmentResponsibleField() {
    const select = document.getElementById('org-dept-responsable');
    if (!select) return;
    select.required = true;
    const empty = [...select.options].find(option => option.value === '');
    if (empty) { empty.textContent = '— Sélectionner un responsable —'; empty.disabled = true; }
    const label = document.querySelector('label[for="org-dept-responsable"]');
    if (label && !label.textContent.includes('*')) label.textContent = 'Responsable *';
  }
  function syncSourceValues() {
    Object.keys(FIELD_CONFIG).forEach(fieldId => {
      const source = document.getElementById(fieldId), proxy = document.getElementById(`${fieldId}-select`); if (source && proxy) source.value = proxy.value;
    });
    const supervisor = document.getElementById('ag-superieur-select') || document.getElementById('ag-superieur');
    if (supervisor?.tagName === 'SELECT') ensureSupervisorIdField().value = supervisor.selectedOptions[0]?.dataset.employeeId || '';
  }
  function syncAgentFields(agent) {
    if (!agent || Number(agent.id) !== currentAgentId()) return;
    const values = {
      'ag-poste': agent.poste || '',
      'ag-departement': agent.departement || '',
      'ag-site': agent.site || '',
      'ag-superieur': agent.superieur_hierarchique || '',
    };
    Object.entries(values).forEach(([fieldId, value]) => {
      const source = document.getElementById(fieldId);
      if (source) source.value = value;
    });
    ensureSupervisorIdField().value = agent.superieur_id || '';
    Object.keys(FIELD_CONFIG).forEach(populateSelect);
    if (agent.superieur_id) selectSupervisorById(agent.superieur_id);
    applyDepartmentManager();
  }
  async function loadReferences(force = false) {
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 10000) return state; if (state.loading) return state.loading;
    state.loading = Promise.all([request('/org/postes'), request('/org/departements'), request('/org/sites'), request('/org/arbre')])
      .then(([postes, departements, sites, tree]) => {
        state.postes = Array.isArray(postes) ? postes : []; state.departements = Array.isArray(departements) ? departements : [];
        state.sites = Array.isArray(sites) ? sites : []; state.agents = Array.isArray(tree?.agents) ? tree.agents : []; state.loadedAt = Date.now();
        Object.keys(FIELD_CONFIG).forEach(populateSelect); applyDepartmentManager(); return state;
      }).finally(() => { state.loading = null; });
    return state.loading;
  }
  async function syncEditedAgent() {
    const agentId = currentAgentId(); if (!agentId || agentId === state.lastAgentId) return; state.lastAgentId = agentId;
    try {
      const payload = await request(`/agents/${agentId}?include=`);
      syncAgentFields(payload?.agent);
    } catch (_) {}
  }
  async function refreshAfterAgentWrite(agent) {
    state.lastAgentId = null;
    await loadReferences(true).catch(() => {});
    syncAgentFields(agent);
    for (const name of ['loadAgents', 'loadOrgArbre', 'loadOrgDepartements']) {
      if (typeof window[name] !== 'function') continue;
      try { await window[name](); } catch (_) {}
    }
  }
  function installAgentWriteObserver() {
    if (window.__talaAgentOrganizationFetchObserver) return;
    window.__talaAgentOrganizationFetchObserver = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function observedFetch(input, init = {}) {
      const response = await originalFetch(input, init);
      try {
        const rawUrl = typeof input === 'string' ? input : input?.url || '';
        const method = String(init.method || input?.method || 'GET').toUpperCase();
        const pathname = new URL(rawUrl, window.location.origin).pathname.replace(/\/+$/, '');
        const isDirectAgentWrite = ['POST', 'PUT', 'PATCH'].includes(method) && (
          pathname === '/api/agents' || /^\/api\/agents\/\d+$/.test(pathname)
        );
        if (response.ok && isDirectAgentWrite) {
          response.clone().json().then(agent => {
            window.setTimeout(() => refreshAfterAgentWrite(agent), 0);
          }).catch(() => {
            window.setTimeout(() => refreshAfterAgentWrite(null), 0);
          });
        }
      } catch (_) {}
      return response;
    };
  }
  function patchAgentDossier(api) {
    if (!api || api.__organizationBridgePatched || typeof api.create !== 'function') return;
    const originalCreate = api.create;
    api.create = function patchedCreate(options) {
      const dossier = originalCreate.call(api, options); if (!dossier || typeof dossier.saveAgent !== 'function') return dossier;
      const originalSave = dossier.saveAgent.bind(dossier);
      dossier.saveAgent = async function saveAgentWithOrganization() {
        if (!applyDepartmentManager({ notifyUser: true })) return { ok: false, error: 'Responsable du département requis', cancelled: false, savedSubforms: [] };
        syncSourceValues();
        const result = await originalSave(); if (!result?.ok || !result.agentId) return result;
        await refreshAfterAgentWrite(result.response || null); return result;
      };
      return dossier;
    };
    api.__organizationBridgePatched = true;
  }
  function hookAgentDossier() {
    if (window.TalaAgentDossier) return patchAgentDossier(window.TalaAgentDossier);
    let assigned;
    try { Object.defineProperty(window, 'TalaAgentDossier', { configurable: true, enumerable: true, get() { return assigned; }, set(value) { assigned = value; patchAgentDossier(value); } }); }
    catch (_) { const timer = setInterval(() => { if (!window.TalaAgentDossier) return; clearInterval(timer); patchAgentDossier(window.TalaAgentDossier); }, 20); }
  }
  function installFieldWatchers() {
    document.addEventListener('focusin', event => {
      const id = event.target?.id || ''; if (Object.keys(FIELD_CONFIG).some(fieldId => id === fieldId || id === `${fieldId}-select`)) loadReferences().catch(error => notify(error.message, 'error'));
    });
    document.addEventListener('submit', event => {
      if (event.target?.id !== 'form-org-departement') return;
      enforceDepartmentResponsibleField();
      if (document.getElementById('org-dept-responsable')?.value) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const box = document.getElementById('org-dept-form-error');
      if (box) { box.textContent = 'Le responsable du département est obligatoire.'; box.classList.remove('hidden'); }
    }, true);
    setInterval(() => {
      enforceDepartmentResponsibleField();
      if (!document.getElementById('ag-departement')) return;
      if (!state.controlsReady) { state.controlsReady = true; ensureSupervisorIdField(); loadReferences(true).catch(error => notify(error.message, 'error')); }
      syncEditedAgent();
      let departmentChanged = false;
      Object.keys(FIELD_CONFIG).forEach(fieldId => {
        const source = document.getElementById(fieldId), proxy = document.getElementById(`${fieldId}-select`);
        if (source && proxy && source.value !== proxy.value) {
          if (source.value && ![...proxy.options].some(option => option.value === source.value)) populateSelect(fieldId);
          proxy.value = source.value; if (fieldId === 'ag-departement') departmentChanged = true;
        }
      });
      if (departmentChanged) applyDepartmentManager(); else renderDepartmentManagerHint();
    }, 250);
  }
  installAgentWriteObserver();
  hookAgentDossier();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFieldWatchers, { once: true }); else installFieldWatchers();
})();

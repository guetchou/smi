(function () {
  'use strict';

  const API_ROOT = '/api';
  const FIELD_CONFIG = {
    'ag-poste': { key: 'postes', placeholder: '— Sélectionner un poste —' },
    'ag-departement': { key: 'departements', placeholder: '— Sélectionner un département —' },
    'ag-site': { key: 'sites', placeholder: '— Sélectionner un site —' },
    'ag-superieur': { key: 'agents', placeholder: '— Aucun supérieur hiérarchique —' },
  };

  const state = {
    postes: [],
    departements: [],
    sites: [],
    agents: [],
    loading: null,
    loadedAt: 0,
    lastAgentId: null,
    controlsReady: false,
  };

  function token() {
    return localStorage.getItem('tc_token') || '';
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
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

  function currentAgentId() {
    const value = document.getElementById('agent-id')?.value;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function ensureSupervisorIdField() {
    let hidden = document.getElementById('ag-superieur-id');
    if (hidden) return hidden;
    hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = 'ag-superieur-id';
    const source = document.getElementById('ag-superieur');
    source?.insertAdjacentElement('afterend', hidden);
    return hidden;
  }

  function optionRows(configKey) {
    if (configKey === 'agents') {
      const selfId = currentAgentId();
      return state.agents
        .filter(agent => Number(agent.id) !== selfId)
        .map(agent => ({
          value: `${agent.nom || ''} ${agent.prenom || ''}`.trim(),
          label: `${agent.nom || ''} ${agent.prenom || ''}`.trim() + (agent.matricule ? ` — ${agent.matricule}` : '') + (agent.poste ? ` · ${agent.poste}` : ''),
          employeeId: Number(agent.id),
        }));
    }
    return state[configKey].map(row => ({
      value: row.libelle || '',
      label: row.libelle || '',
      id: Number(row.id),
    }));
  }

  function copyPresentation(source, target) {
    target.className = source.className;
    target.disabled = source.disabled;
    target.required = source.required;
    target.setAttribute('aria-label', source.getAttribute('aria-label') || source.id);
    if (source.getAttribute('style')) target.setAttribute('style', source.getAttribute('style'));
  }

  function ensureProxySelect(fieldId) {
    const source = document.getElementById(fieldId);
    if (!source) return null;
    if (source.tagName === 'SELECT') return source;

    const proxyId = `${fieldId}-select`;
    let proxy = document.getElementById(proxyId);
    if (!proxy) {
      proxy = document.createElement('select');
      proxy.id = proxyId;
      proxy.dataset.organizationProxyFor = fieldId;
      copyPresentation(source, proxy);
      source.insertAdjacentElement('afterend', proxy);
      source.classList.add('hidden');
      source.setAttribute('aria-hidden', 'true');
      const label = document.querySelector(`label[for="${fieldId}"]`);
      if (label) label.setAttribute('for', proxyId);
      proxy.addEventListener('change', () => {
        source.value = proxy.value;
        source.dispatchEvent(new Event('change', { bubbles: true }));
        if (fieldId === 'ag-superieur') {
          ensureSupervisorIdField().value = proxy.selectedOptions[0]?.dataset.employeeId || '';
        }
        if (fieldId === 'ag-departement') renderDepartmentManagerHint();
      });
    }
    return proxy;
  }

  function populateSelect(fieldId) {
    const config = FIELD_CONFIG[fieldId];
    const source = document.getElementById(fieldId);
    const select = ensureProxySelect(fieldId);
    if (!config || !source || !select) return;

    const currentValue = source.value || select.value || '';
    const rows = optionRows(config.key);
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = config.placeholder;
    select.appendChild(placeholder);

    rows.forEach(row => {
      const option = document.createElement('option');
      option.value = row.value;
      option.textContent = row.label;
      if (row.employeeId) option.dataset.employeeId = String(row.employeeId);
      if (row.id) option.dataset.referenceId = String(row.id);
      select.appendChild(option);
    });

    if (currentValue && !rows.some(row => row.value === currentValue)) {
      const legacy = document.createElement('option');
      legacy.value = currentValue;
      legacy.textContent = `${currentValue} — valeur historique`;
      legacy.dataset.legacy = 'true';
      select.appendChild(legacy);
    }
    select.value = currentValue;

    if (fieldId === 'ag-superieur') {
      const selected = select.selectedOptions[0];
      if (selected?.dataset.employeeId) ensureSupervisorIdField().value = selected.dataset.employeeId;
    }
  }

  function ensureDepartmentManagerHint() {
    let hint = document.getElementById('ag-departement-responsable-hint');
    if (hint) return hint;
    const select = document.getElementById('ag-departement-select') || document.getElementById('ag-departement');
    if (!select) return null;
    hint = document.createElement('div');
    hint.id = 'ag-departement-responsable-hint';
    hint.className = 'mt-1 text-xs text-slate-500';
    select.insertAdjacentElement('afterend', hint);
    return hint;
  }

  function selectSupervisorById(employeeId) {
    const select = document.getElementById('ag-superieur-select') || document.getElementById('ag-superieur');
    const source = document.getElementById('ag-superieur');
    if (!select || !source) return false;
    const option = [...select.options].find(item => Number(item.dataset.employeeId) === Number(employeeId));
    if (!option) return false;
    select.value = option.value;
    source.value = option.value;
    ensureSupervisorIdField().value = String(employeeId);
    return true;
  }

  function renderDepartmentManagerHint() {
    const hint = ensureDepartmentManagerHint();
    if (!hint) return;
    const value = document.getElementById('ag-departement')?.value || '';
    const department = state.departements.find(row => row.libelle === value);
    if (!department?.responsable_id) {
      hint.textContent = department ? 'Aucun responsable désigné pour ce département.' : '';
      return;
    }

    hint.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = `Responsable du département : ${department.responsable_nom || `Agent #${department.responsable_id}`}. `;
    hint.appendChild(text);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'font-semibold text-blue-700 hover:underline';
    button.textContent = 'Utiliser comme supérieur hiérarchique';
    button.addEventListener('click', () => {
      if (selectSupervisorById(department.responsable_id)) {
        notify('Responsable du département défini comme supérieur hiérarchique.');
      } else {
        notify('Le responsable désigné n’est pas disponible dans la liste des agents actifs.', 'error');
      }
    });
    hint.appendChild(button);
  }

  function syncSourceValues() {
    Object.keys(FIELD_CONFIG).forEach(fieldId => {
      const source = document.getElementById(fieldId);
      const proxy = document.getElementById(`${fieldId}-select`);
      if (source && proxy) source.value = proxy.value;
    });
    const supervisor = document.getElementById('ag-superieur-select') || document.getElementById('ag-superieur');
    if (supervisor?.tagName === 'SELECT') {
      ensureSupervisorIdField().value = supervisor.selectedOptions[0]?.dataset.employeeId || '';
    }
  }

  async function loadReferences(force = false) {
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 10000) return state;
    if (state.loading) return state.loading;

    state.loading = Promise.all([
      request('/org/postes'),
      request('/org/departements'),
      request('/org/sites'),
      request('/org/arbre'),
    ]).then(([postes, departements, sites, tree]) => {
      state.postes = Array.isArray(postes) ? postes : [];
      state.departements = Array.isArray(departements) ? departements : [];
      state.sites = Array.isArray(sites) ? sites : [];
      state.agents = Array.isArray(tree?.agents) ? tree.agents : [];
      state.loadedAt = Date.now();
      Object.keys(FIELD_CONFIG).forEach(populateSelect);
      renderDepartmentManagerHint();
      return state;
    }).finally(() => {
      state.loading = null;
    });

    return state.loading;
  }

  async function syncEditedAgent() {
    const agentId = currentAgentId();
    if (!agentId || agentId === state.lastAgentId) return;
    state.lastAgentId = agentId;
    try {
      const payload = await request(`/agents/${agentId}?include=`);
      const agent = payload?.agent;
      if (agent?.superieur_id) selectSupervisorById(agent.superieur_id);
      else ensureSupervisorIdField().value = '';
    } catch (_) {}
  }

  function patchAgentDossier(api) {
    if (!api || api.__organizationBridgePatched || typeof api.create !== 'function') return;
    const originalCreate = api.create;
    api.create = function patchedCreate(options) {
      const dossier = originalCreate.call(api, options);
      if (!dossier || typeof dossier.saveAgent !== 'function') return dossier;
      const originalSave = dossier.saveAgent.bind(dossier);
      dossier.saveAgent = async function saveAgentWithOrganization() {
        syncSourceValues();
        const supervisorIdValue = ensureSupervisorIdField().value;
        const supervisorId = supervisorIdValue ? Number(supervisorIdValue) : null;
        const result = await originalSave();
        if (!result?.ok || !result.agentId) return result;

        try {
          await request(`/org/${result.agentId}/superieur`, {
            method: 'PUT',
            body: JSON.stringify({
              superieur_id: supervisorId,
              motif: 'Affectation depuis la fiche agent',
            }),
          });
        } catch (error) {
          result.organization_warning = error.message;
          notify(`Agent enregistré, mais rattachement hiérarchique non appliqué : ${error.message}`, 'error');
        }
        await loadReferences(true).catch(() => {});
        return result;
      };
      return dossier;
    };
    api.__organizationBridgePatched = true;
  }

  function hookAgentDossier() {
    if (window.TalaAgentDossier) {
      patchAgentDossier(window.TalaAgentDossier);
      return;
    }

    let assigned;
    try {
      Object.defineProperty(window, 'TalaAgentDossier', {
        configurable: true,
        enumerable: true,
        get() { return assigned; },
        set(value) {
          assigned = value;
          patchAgentDossier(value);
        },
      });
    } catch (_) {
      const timer = setInterval(() => {
        if (!window.TalaAgentDossier) return;
        clearInterval(timer);
        patchAgentDossier(window.TalaAgentDossier);
      }, 20);
    }
  }

  function installFieldWatchers() {
    document.addEventListener('focusin', event => {
      const id = event.target?.id || '';
      if (Object.keys(FIELD_CONFIG).some(fieldId => id === fieldId || id === `${fieldId}-select`)) {
        loadReferences().catch(error => notify(error.message, 'error'));
      }
    });

    setInterval(() => {
      if (!document.getElementById('ag-departement')) return;
      if (!state.controlsReady) {
        state.controlsReady = true;
        ensureSupervisorIdField();
        loadReferences(true).catch(error => notify(error.message, 'error'));
      }
      syncEditedAgent();
      Object.keys(FIELD_CONFIG).forEach(fieldId => {
        const source = document.getElementById(fieldId);
        const proxy = document.getElementById(`${fieldId}-select`);
        if (source && proxy && source.value !== proxy.value) {
          const exists = [...proxy.options].some(option => option.value === source.value);
          if (source.value && !exists) populateSelect(fieldId);
          proxy.value = source.value;
        }
      });
      renderDepartmentManagerHint();
    }, 250);
  }

  hookAgentDossier();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installFieldWatchers, { once: true });
  } else {
    installFieldWatchers();
  }
})();

(function () {
  'use strict';

  const API_BASE = '/api/org';
  const MANAGER_ROLES = new Set(['admin', 'rh', 'dg']);
  const state = {
    report: null,
    simulation: null,
    loading: false,
    initialized: false,
    filter: 'all',
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function currentRoles() {
    try {
      const user = JSON.parse(localStorage.getItem('tc_user') || '{}');
      const values = [user.role, user.sous_role, ...(Array.isArray(user.roles) ? user.roles : [])]
        .filter(Boolean)
        .flatMap(value => String(value).toLowerCase().split(/[\s,;|]+/));
      return new Set(values);
    } catch (_) {
      return new Set();
    }
  }

  function canManage() {
    return [...currentRoles()].some(role => MANAGER_ROLES.has(role));
  }

  function token() {
    return localStorage.getItem('tc_token') || '';
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
      error.payload = payload;
      error.status = response.status;
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
    if (document.getElementById('org-integrity-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'org-integrity-ui-styles';
    style.textContent = `
      #org-integrity-panel { margin-bottom:16px; }
      #org-integrity-panel .org-integrity-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
      #org-integrity-panel .org-integrity-stat { border:1px solid #e2e8f0; border-radius:14px; padding:12px; background:#fff; }
      #org-integrity-panel .org-integrity-list { display:grid; gap:8px; max-height:430px; overflow:auto; padding-right:4px; }
      #org-integrity-panel .org-integrity-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; border:1px solid #e2e8f0; border-radius:12px; padding:12px; background:#fff; }
      #org-integrity-panel .org-integrity-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; color:#64748b; }
      #org-integrity-panel .org-integrity-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      #org-integrity-confirmation { text-transform:uppercase; }
      @media (max-width:820px) {
        #org-integrity-panel .org-integrity-summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
        #org-integrity-panel .org-integrity-row { grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function severityBadge(severity) {
    const config = {
      critical: ['Critique', 'bg-rose-100 text-rose-800'],
      error: ['Erreur', 'bg-amber-100 text-amber-800'],
      warning: ['Attention', 'bg-slate-100 text-slate-700'],
    }[severity] || ['Information', 'bg-slate-100 text-slate-700'];
    return `<span class="inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${config[1]}">${config[0]}</span>`;
  }

  function ensurePanel() {
    const host = document.getElementById('org-panel-departements');
    const cards = document.getElementById('org-dept-cards');
    if (!host || !cards) return null;

    let panel = document.getElementById('org-integrity-panel');
    if (panel) return panel;

    panel = document.createElement('section');
    panel.id = 'org-integrity-panel';
    panel.className = 'hidden rounded-2xl border border-slate-200 bg-slate-50 p-4';
    panel.innerHTML = `
      <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-bold text-slate-900">Contrôle d’intégrité organisationnelle</h3>
            <span id="org-integrity-health" class="hidden rounded-full px-2 py-1 text-[10px] font-semibold"></span>
          </div>
          <p class="text-xs text-slate-500 mt-1">Détecter les incohérences historiques avant toute correction.</p>
        </div>
        <button type="button" class="btn btn-secondary btn-xs" id="org-integrity-close">Fermer</button>
      </div>
      <div id="org-integrity-error" class="hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 mb-3" role="alert"></div>
      <div id="org-integrity-result" class="hidden rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-3"></div>
      <div id="org-integrity-summary" class="org-integrity-summary mb-4"></div>
      <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div class="org-integrity-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="org-integrity-refresh">Actualiser le diagnostic</button>
          <button type="button" class="btn btn-secondary btn-sm" id="org-integrity-simulate">Simuler la réparation</button>
        </div>
        <label class="text-xs text-slate-600">Filtre
          <select id="org-integrity-filter" class="ml-2 text-xs rounded-lg border-slate-300">
            <option value="all">Toutes</option>
            <option value="critical">Critiques</option>
            <option value="error">Erreurs</option>
            <option value="warning">Avertissements</option>
            <option value="repairable">Réparables</option>
            <option value="manual">Décision RH</option>
          </select>
        </label>
      </div>
      <div id="org-integrity-simulation" class="hidden rounded-xl border border-blue-200 bg-blue-50 p-3 mb-3">
        <div id="org-integrity-simulation-copy" class="text-sm text-blue-900"></div>
        <div class="mt-3 flex flex-wrap items-end gap-2">
          <label class="text-xs font-semibold text-blue-900">Saisissez REPARER pour confirmer
            <input id="org-integrity-confirmation" type="text" autocomplete="off" class="block mt-1 rounded-lg border-blue-300 bg-white" placeholder="REPARER">
          </label>
          <button type="button" class="btn btn-danger btn-sm" id="org-integrity-execute" disabled>Appliquer les corrections sûres</button>
        </div>
      </div>
      <div id="org-integrity-list" class="org-integrity-list"></div>
    `;
    host.insertBefore(panel, cards);

    panel.querySelector('#org-integrity-close').addEventListener('click', () => panel.classList.add('hidden'));
    panel.querySelector('#org-integrity-refresh').addEventListener('click', () => loadReport(true));
    panel.querySelector('#org-integrity-simulate').addEventListener('click', simulateRepair);
    panel.querySelector('#org-integrity-execute').addEventListener('click', executeRepair);
    panel.querySelector('#org-integrity-filter').addEventListener('change', event => {
      state.filter = event.target.value;
      renderAnomalies();
    });
    panel.querySelector('#org-integrity-confirmation').addEventListener('input', event => {
      panel.querySelector('#org-integrity-execute').disabled = event.target.value.trim().toUpperCase() !== 'REPARER';
    });
    return panel;
  }

  function installToolbarButton() {
    const toolbar = document.getElementById('org-departments-toolbar');
    if (!toolbar || document.getElementById('org-integrity-open')) return;
    const button = document.createElement('button');
    button.id = 'org-integrity-open';
    button.type = 'button';
    button.className = 'btn btn-secondary text-sm';
    button.textContent = 'Contrôle d’intégrité';
    button.addEventListener('click', async () => {
      const panel = ensurePanel();
      if (!panel) return;
      panel.classList.remove('hidden');
      await loadReport();
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toolbar.appendChild(button);
  }

  function showError(message) {
    const box = document.getElementById('org-integrity-error');
    if (!box) return;
    box.textContent = message;
    box.classList.remove('hidden');
  }

  function clearMessages() {
    for (const id of ['org-integrity-error', 'org-integrity-result']) {
      const box = document.getElementById(id);
      if (!box) continue;
      box.textContent = '';
      box.classList.add('hidden');
    }
  }

  function setBusy(busy) {
    state.loading = busy;
    for (const id of ['org-integrity-refresh', 'org-integrity-simulate', 'org-integrity-execute']) {
      const button = document.getElementById(id);
      if (button) button.disabled = busy || (id === 'org-integrity-execute' && document.getElementById('org-integrity-confirmation')?.value.trim().toUpperCase() !== 'REPARER');
    }
  }

  function renderSummary() {
    const container = document.getElementById('org-integrity-summary');
    const health = document.getElementById('org-integrity-health');
    if (!container || !health) return;
    const summary = state.report?.summary;
    if (!summary) {
      container.innerHTML = '<div class="col-span-4 text-sm text-slate-500">Aucun diagnostic chargé.</div>';
      health.classList.add('hidden');
      return;
    }
    container.innerHTML = `
      <div class="org-integrity-stat"><div class="text-[11px] text-slate-500">Anomalies</div><div class="text-xl font-bold text-slate-900 mt-1">${Number(summary.total_anomalies || 0)}</div></div>
      <div class="org-integrity-stat"><div class="text-[11px] text-slate-500">Critiques</div><div class="text-xl font-bold text-rose-700 mt-1">${Number(summary.by_severity?.critical || 0)}</div></div>
      <div class="org-integrity-stat"><div class="text-[11px] text-slate-500">Réparables</div><div class="text-xl font-bold text-emerald-700 mt-1">${Number(summary.repairable_anomalies || 0)}</div></div>
      <div class="org-integrity-stat"><div class="text-[11px] text-slate-500">Décision RH</div><div class="text-xl font-bold text-amber-700 mt-1">${Number(summary.manual_anomalies || 0)}</div></div>
    `;
    const healthy = Number(summary.total_anomalies || 0) === 0;
    health.textContent = healthy ? 'Intégrité conforme' : 'Anomalies détectées';
    health.className = `rounded-full px-2 py-1 text-[10px] font-semibold ${healthy ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`;
  }

  function filteredAnomalies() {
    const rows = Array.isArray(state.report?.anomalies) ? state.report.anomalies : [];
    if (state.filter === 'all') return rows;
    if (state.filter === 'repairable') return rows.filter(row => row.repairable);
    if (state.filter === 'manual') return rows.filter(row => !row.repairable);
    return rows.filter(row => row.severity === state.filter);
  }

  function renderAnomalies() {
    const list = document.getElementById('org-integrity-list');
    if (!list) return;
    if (state.loading) {
      list.innerHTML = '<div class="text-center py-8 text-sm text-slate-500">Analyse en cours…</div>';
      return;
    }
    const rows = filteredAnomalies();
    if (!rows.length) {
      list.innerHTML = '<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">Aucune anomalie pour ce filtre.</div>';
      return;
    }
    list.innerHTML = rows.map(row => `
      <article class="org-integrity-row">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            ${severityBadge(row.severity)}
            <span class="org-integrity-code">${escapeHtml(row.code)}</span>
            <span class="text-xs font-semibold text-slate-700">${escapeHtml(row.label || `${row.entity_type} #${row.entity_id}`)}</span>
          </div>
          <p class="text-sm text-slate-800 mt-2">${escapeHtml(row.message)}</p>
          ${row.details ? `<details class="mt-2 text-xs text-slate-500"><summary class="cursor-pointer">Détails techniques</summary><pre class="mt-2 whitespace-pre-wrap break-words">${escapeHtml(JSON.stringify(row.details, null, 2))}</pre></details>` : ''}
        </div>
        <span class="inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${row.repairable ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${row.repairable ? 'Correction sûre' : 'Décision RH'}</span>
      </article>
    `).join('');
  }

  function renderReport() {
    renderSummary();
    renderAnomalies();
  }

  async function loadReport(force = false) {
    if (state.loading) return;
    if (state.report && !force) {
      renderReport();
      return;
    }
    clearMessages();
    setBusy(true);
    renderAnomalies();
    try {
      state.report = await api('/anomalies');
      state.simulation = null;
      const simulation = document.getElementById('org-integrity-simulation');
      if (simulation) simulation.classList.add('hidden');
      renderReport();
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
      renderAnomalies();
    }
  }

  async function simulateRepair() {
    if (state.loading) return;
    clearMessages();
    setBusy(true);
    try {
      state.simulation = await api('/reparer-integrite', {
        method: 'POST',
        body: JSON.stringify({ dry_run: true }),
      });
      state.report = state.simulation.before;
      renderReport();
      const planned = Number(state.simulation.before?.summary?.planned_employee_changes || 0);
      const simulation = document.getElementById('org-integrity-simulation');
      const copy = document.getElementById('org-integrity-simulation-copy');
      const confirmation = document.getElementById('org-integrity-confirmation');
      if (copy) copy.textContent = planned
        ? `${planned} modification(s) sûre(s) seront appliquées. Les anomalies ambiguës resteront inchangées.`
        : 'Aucune correction automatique sûre n’est nécessaire.';
      if (simulation) simulation.classList.toggle('hidden', planned === 0 || !canManage());
      if (confirmation) confirmation.value = '';
      const execute = document.getElementById('org-integrity-execute');
      if (execute) execute.disabled = true;
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function executeRepair() {
    if (state.loading || !canManage()) return;
    const confirmation = document.getElementById('org-integrity-confirmation');
    if (confirmation?.value.trim().toUpperCase() !== 'REPARER') {
      showError('Saisissez REPARER pour confirmer l’exécution.');
      return;
    }
    clearMessages();
    setBusy(true);
    try {
      const result = await api('/reparer-integrite', {
        method: 'POST',
        body: JSON.stringify({ dry_run: false, confirmation: 'REPARER' }),
      });
      state.report = result.after;
      state.simulation = null;
      document.getElementById('org-integrity-simulation')?.classList.add('hidden');
      const box = document.getElementById('org-integrity-result');
      if (box) {
        box.textContent = `${Number(result.applied_changes?.length || 0)} correction(s) appliquée(s), ${Number(result.skipped_changes?.length || 0)} ignorée(s). Référence : ${result.run_id}.`;
        box.classList.remove('hidden');
      }
      renderReport();
      if (typeof window.loadOrgDepartements === 'function') await window.loadOrgDepartements();
      if (typeof window.loadOrgArbre === 'function') await window.loadOrgArbre();
      notify('Réparation d’intégrité terminée.');
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function initialize() {
    if (state.initialized) return;
    if (!document.getElementById('org-panel-departements') || !document.getElementById('org-departments-toolbar')) return;
    state.initialized = true;
    installStyles();
    ensurePanel();
    installToolbarButton();
    window.loadOrgIntegrity = () => loadReport(true);
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

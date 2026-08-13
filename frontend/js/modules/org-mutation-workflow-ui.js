(function () {
  'use strict';

  const API_BASE = '/api/org';
  const SUPERVISOR_TYPES = new Set(['chef', 'interimaire', 'premier_adjoint', 'adjoint', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur']);
  const state = { initialized: false, loading: false, rows: [], agents: [], postes: [], departments: [], sites: [], permissions: {}, editingId: null, filter: '' };

  function token() { return localStorage.getItem('tc_token') || ''; }
  function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Erreur HTTP ${response.status}`);
      error.code = payload.code;
      error.details = payload.details;
      throw error;
    }
    return payload;
  }
  function notify(message, type = 'success') { if (typeof window.showToast === 'function') return window.showToast(message, type); if (typeof window.toast === 'function') return window.toast(message, type); if (type === 'error') window.alert(message); }
  function can(code) { return state.permissions[code] === true; }
  function currentUserId() { try { return Number(JSON.parse(localStorage.getItem('tc_user') || '{}').id || 0); } catch (_) { return 0; } }
  function canEditMutation(row) { return ['brouillon', 'refuse', 'a_corriger'].includes(row?.statut) && can('hr.mutation.create') && Number(row?.created_by || 0) === currentUserId(); }
  function dateInputValue(value) { return String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || ''; }
  function optionRows(rows, valueKey, labelBuilder, selected = '') { return rows.map(row => `<option value="${escapeHtml(row[valueKey])}" ${String(row[valueKey]) === String(selected) ? 'selected' : ''}>${escapeHtml(labelBuilder(row))}</option>`).join(''); }
  function statusLabel(status) { return ({ brouillon: 'Brouillon', soumis: 'Soumis', approuve: 'Approuvé', refuse: 'Refusé', a_corriger: 'À corriger', effectif: 'Effectif', annule: 'Annulé' })[status] || status; }
  function statusClass(status) { return ({ brouillon: 'bg-slate-100 text-slate-700', soumis: 'bg-blue-100 text-blue-800', approuve: 'bg-violet-100 text-violet-800', refuse: 'bg-rose-100 text-rose-800', a_corriger: 'bg-amber-100 text-amber-800', effectif: 'bg-emerald-100 text-emerald-800', annule: 'bg-slate-200 text-slate-600' })[status] || 'bg-slate-100 text-slate-700'; }

  function ensureStyles() {
    if (document.getElementById('org-mutation-workflow-styles')) return;
    const style = document.createElement('style'); style.id = 'org-mutation-workflow-styles';
    style.textContent = `#org-mutation-panel{margin-bottom:16px}#org-mutation-list{display:grid;gap:10px;max-height:520px;overflow:auto}.org-mutation-row{border:1px solid #e2e8f0;border-radius:14px;padding:13px;background:white}.org-mutation-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}#modal-org-mutation .org-mutation-shell{width:min(780px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}#form-org-mutation{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}#form-org-mutation .full{grid-column:1/-1}#form-org-mutation label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:5px}#form-org-mutation input,#form-org-mutation select,#form-org-mutation textarea{width:100%}@media(max-width:680px){#form-org-mutation{grid-template-columns:1fr}#form-org-mutation .full{grid-column:auto}}`;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    const host = document.getElementById('org-panel-departements'); const cards = document.getElementById('org-dept-cards');
    if (!host || !cards) return null; let panel = document.getElementById('org-mutation-panel'); if (panel) return panel;
    panel = document.createElement('section'); panel.id = 'org-mutation-panel'; panel.className = 'hidden rounded-2xl border border-slate-200 bg-slate-50 p-4';
    panel.innerHTML = `<div class="flex flex-wrap items-start justify-between gap-3 mb-4"><div><h3 class="text-sm font-bold text-slate-900">Mutations organisationnelles</h3><p class="text-xs text-slate-500 mt-1">Brouillon → soumission → approbation → prise d’effet.</p></div><div class="flex gap-2 flex-wrap">${can('hr.mutation.create') ? '<button type="button" class="btn btn-primary btn-sm" id="org-mutation-new">+ Nouvelle mutation</button>' : ''}<button type="button" class="btn btn-secondary btn-sm" id="org-mutation-refresh">Actualiser</button><button type="button" class="btn btn-secondary btn-sm" id="org-mutation-close">Fermer</button></div></div><div class="flex flex-wrap items-center justify-between gap-3 mb-3"><div id="org-mutation-summary" class="text-xs text-slate-600"></div><select id="org-mutation-filter" class="rounded-lg border-slate-300 text-xs"><option value="">Tous les statuts</option><option value="brouillon">Brouillons</option><option value="soumis">Soumis</option><option value="approuve">Approuvés</option><option value="refuse">Refusés</option><option value="a_corriger">À corriger</option><option value="effectif">Effectifs</option><option value="annule">Annulés</option></select></div><div id="org-mutation-error" class="hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 mb-3"></div><div id="org-mutation-list"></div>`;
    host.insertBefore(panel, cards);
    panel.querySelector('#org-mutation-close').addEventListener('click', () => panel.classList.add('hidden'));
    panel.querySelector('#org-mutation-refresh').addEventListener('click', loadRows);
    panel.querySelector('#org-mutation-new')?.addEventListener('click', () => openModal());
    panel.querySelector('#org-mutation-filter').addEventListener('change', event => { state.filter = event.target.value; renderRows(); });
    panel.querySelector('#org-mutation-list').addEventListener('click', handleAction); return panel;
  }

  function ensureToolbarButton() {
    const toolbar = document.getElementById('org-departments-toolbar'); if (!toolbar || document.getElementById('org-mutation-open')) return;
    const button = document.createElement('button'); button.id = 'org-mutation-open'; button.type = 'button'; button.className = 'btn btn-secondary text-sm'; button.textContent = 'Mutations RH';
    button.addEventListener('click', async () => { const panel = ensurePanel(); if (!panel) return; panel.classList.remove('hidden'); await loadRows(); panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); toolbar.appendChild(button);
  }

  function ensureModal() {
    if (document.getElementById('modal-org-mutation')) return;
    const modal = document.createElement('div'); modal.id = 'modal-org-mutation'; modal.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-3';
    modal.innerHTML = `<div class="modal card rounded-2xl org-mutation-shell"><div class="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h2 id="org-mutation-title" class="text-lg font-bold text-slate-900">Nouvelle mutation</h2><p class="text-xs text-slate-500 mt-1">Le responsable du département cible sera imposé automatiquement. Un adjoint actif peut être choisi pour son périmètre.</p></div><button type="button" class="btn btn-secondary btn-xs" id="org-mutation-modal-close">×</button></div><form id="form-org-mutation" class="p-5"><input type="hidden" id="org-mutation-id"><div class="full"><label>Agent *</label><select id="org-mutation-agent" required></select></div><div><label>Type *</label><select id="org-mutation-type"><option value="modification">Modification</option><option value="promotion">Promotion</option><option value="transfert">Transfert</option><option value="reintegration">Réintégration</option></select></div><div><label>Date d’effet *</label><input id="org-mutation-date" type="date" required></div><div><label>Nouveau poste</label><select id="org-mutation-poste"></select></div><div><label>Nouveau département *</label><select id="org-mutation-dept" required></select></div><div><label>Nouveau site</label><select id="org-mutation-site"></select></div><div><label>Supérieur fonctionnel</label><select id="org-mutation-supervisor"><option value="">Responsable effectif automatique</option></select></div><div class="full"><label>Motif *</label><textarea id="org-mutation-motif" rows="4" required></textarea></div><div id="org-mutation-form-error" class="full hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"></div><div class="full flex justify-end gap-2"><button type="button" class="btn btn-secondary" id="org-mutation-cancel-form">Annuler</button><button type="submit" class="btn btn-primary" id="org-mutation-save">Enregistrer le brouillon</button></div></form></div>`;
    document.body.appendChild(modal); modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    modal.querySelector('#org-mutation-modal-close').addEventListener('click', closeModal); modal.querySelector('#org-mutation-cancel-form').addEventListener('click', closeModal);
    modal.querySelector('#form-org-mutation').addEventListener('submit', saveDraft); modal.querySelector('#org-mutation-dept').addEventListener('change', () => fillSupervisorOptions());
  }

  function selectedDepartment() { const label = document.getElementById('org-mutation-dept')?.value || ''; return state.departments.find(row => row.libelle === label) || null; }
  function fillSupervisorOptions(selected = '') {
    const select = document.getElementById('org-mutation-supervisor'); if (!select) return;
    const agentId = Number(document.getElementById('org-mutation-agent')?.value || 0); const dept = selectedDepartment();
    const functions = (Array.isArray(dept?.fonctions) ? dept.fonctions : []).filter(row => SUPERVISOR_TYPES.has(row.fonction_type) && Number(row.employe_id) !== agentId);
    select.innerHTML = '<option value="">Responsable effectif automatique</option>' + functions.map(row => `<option value="${Number(row.employe_id)}" ${String(row.employe_id) === String(selected) ? 'selected' : ''}>${escapeHtml(row.fonction_libelle || row.fonction_type)} — ${escapeHtml(row.employe_nom_complet || `${row.employe_nom || ''} ${row.employe_prenom || ''}`.trim())}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</option>`).join('');
  }

  function fillModal(row = null, employeeId = null) {
    state.editingId = row?.id || null; document.getElementById('org-mutation-title').textContent = row ? 'Corriger la mutation' : 'Nouvelle mutation';
    const selectedAgent = row?.employe_id || employeeId || ''; document.getElementById('org-mutation-agent').innerHTML = '<option value="">— Sélectionner —</option>' + optionRows(state.agents, 'id', agent => `${agent.nom || ''} ${agent.prenom || ''} — ${agent.matricule || 'sans matricule'}`, selectedAgent); document.getElementById('org-mutation-agent').disabled = Boolean(row);
    document.getElementById('org-mutation-type').value = row?.type_mutation || 'modification'; document.getElementById('org-mutation-date').value = dateInputValue(row?.date_effective || row?.date_effet) || new Date().toISOString().slice(0, 10);
    document.getElementById('org-mutation-poste').innerHTML = '<option value="">— Conserver / non renseigné —</option>' + optionRows(state.postes, 'libelle', item => item.libelle, row?.nouveau_poste || '');
    document.getElementById('org-mutation-dept').innerHTML = '<option value="">— Sélectionner —</option>' + optionRows(state.departments.filter(item => item.responsable_id), 'libelle', item => item.libelle, row?.nouveau_dept || '');
    document.getElementById('org-mutation-site').innerHTML = '<option value="">— Conserver / non renseigné —</option>' + optionRows(state.sites, 'libelle', item => item.libelle, row?.nouveau_site || '');
    document.getElementById('org-mutation-motif').value = row?.motif || ''; document.getElementById('org-mutation-form-error').classList.add('hidden'); fillSupervisorOptions(row?.nouveau_sup_id || '');
  }
  function openModal(row = null, employeeId = null) { ensureModal(); fillModal(row, employeeId); document.getElementById('modal-org-mutation').classList.remove('hidden'); }
  function closeModal() { document.getElementById('modal-org-mutation')?.classList.add('hidden'); state.editingId = null; }
  function showError(message, form = false) { const box = document.getElementById(form ? 'org-mutation-form-error' : 'org-mutation-error'); if (!box) return; box.textContent = message; box.classList.remove('hidden'); }

  function actionButtons(row) {
    const buttons = []; if (canEditMutation(row)) buttons.push(`<button class="btn btn-secondary btn-xs" data-action="edit" data-id="${row.id}">Modifier</button>`);
    if (row.statut === 'brouillon' && can('hr.mutation.submit') && Number(row.created_by || 0) === currentUserId()) buttons.push(`<button class="btn btn-primary btn-xs" data-action="submit" data-id="${row.id}">Soumettre</button>`);
    if (row.statut === 'soumis' && can('hr.mutation.approve')) { buttons.push(`<button class="btn btn-primary btn-xs" data-action="approve" data-id="${row.id}">Approuver</button>`); buttons.push(`<button class="btn btn-danger btn-xs" data-action="refuse" data-id="${row.id}">Refuser</button>`); }
    if (row.statut === 'approuve' && can('hr.mutation.apply') && String(row.date_effective || row.date_effet) <= new Date().toISOString().slice(0, 10)) buttons.push(`<button class="btn btn-primary btn-xs" data-action="apply" data-id="${row.id}">Appliquer</button>`);
    if (['brouillon', 'soumis', 'approuve', 'refuse', 'a_corriger'].includes(row.statut) && can('hr.mutation.cancel')) buttons.push(`<button class="btn btn-secondary btn-xs" data-action="cancel" data-id="${row.id}">Annuler</button>`); return buttons.join('');
  }
  function renderRows() {
    const list = document.getElementById('org-mutation-list'); const summary = document.getElementById('org-mutation-summary'); if (!list || !summary) return;
    const rows = state.filter ? state.rows.filter(row => row.statut === state.filter) : state.rows; summary.textContent = `${rows.length} mutation(s) affichée(s) — ${state.rows.filter(row => row.statut === 'soumis').length} en attente d’approbation`;
    if (state.loading) { list.innerHTML = '<div class="text-center py-8 text-sm text-slate-500">Chargement…</div>'; return; }
    if (!rows.length) { list.innerHTML = '<div class="rounded-xl border border-slate-200 bg-white p-5 text-center text-sm text-slate-500">Aucune mutation pour ce filtre.</div>'; return; }
    list.innerHTML = rows.map(row => `<article class="org-mutation-row" data-mutation-id="${Number(row.id)}"><div class="flex flex-wrap items-start justify-between gap-3"><div><div class="flex items-center gap-2 flex-wrap"><strong class="text-sm text-slate-900">${escapeHtml(`${row.employe_nom || ''} ${row.employe_prenom || ''}`.trim())}</strong><span class="rounded-full px-2 py-1 text-[10px] font-semibold ${statusClass(row.statut)}">${escapeHtml(statusLabel(row.statut))}</span></div><div class="text-xs text-slate-500 mt-1">Effet prévu : ${escapeHtml(row.date_effective || row.date_effet || '—')} · Révision ${Number(row.revision || 1)}</div></div><span class="text-xs font-semibold text-slate-600">${escapeHtml(row.type_mutation || 'modification')}</span></div><div class="grid grid-cols-1 md:grid-cols-3 gap-2 mt-3 text-xs text-slate-700"><div><strong>Poste :</strong> ${escapeHtml(row.ancien_poste || '—')} → ${escapeHtml(row.nouveau_poste || '—')}</div><div><strong>Département :</strong> ${escapeHtml(row.ancien_dept || '—')} → ${escapeHtml(row.nouveau_dept || '—')}</div><div><strong>Site :</strong> ${escapeHtml(row.ancien_site || '—')} → ${escapeHtml(row.nouveau_site || '—')}</div></div><div class="mt-2 text-xs text-slate-600"><strong>Supérieur cible :</strong> ${escapeHtml(row.nouveau_sup_nom || 'Automatique selon département')}</div><div class="mt-2 text-xs text-slate-600"><strong>Motif :</strong> ${escapeHtml(row.motif || '—')}</div>${row.motif_refus ? `<div class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong>Observation :</strong> ${escapeHtml(row.motif_refus)}</div>` : ''}<div class="org-mutation-actions">${actionButtons(row)}</div></article>`).join('');
  }

  function activeMutationForEmployee(employeeId) {
    const active = new Set(['brouillon', 'soumis', 'approuve', 'a_corriger']);
    return state.rows.find(row => Number(row.employe_id) === Number(employeeId) && active.has(row.statut)) || null;
  }

  async function openForEmployee(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return;
    const panel = ensurePanel();
    if (!panel) throw new Error('Le panneau Mutations RH est indisponible.');
    panel.classList.remove('hidden');
    await loadRows();
    state.filter = '';
    const filter = document.getElementById('org-mutation-filter');
    if (filter) filter.value = '';
    renderRows();
    const existing = activeMutationForEmployee(id);
    if (existing) {
      if (canEditMutation(existing)) {
        openModal(existing);
      } else {
        document.querySelector(`[data-mutation-id="${Number(existing.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        notify(`La mutation #${existing.id} est déjà ${statusLabel(existing.statut).toLowerCase()}.`, 'success');
      }
      return;
    }
    if (!can('hr.mutation.create')) {
      notify('Vous pouvez consulter les mutations, mais vous ne pouvez pas en créer.', 'error');
      return;
    }
    openModal(null, id);
  }

  async function loadReferences() {
    const [capabilities, tree, postes, departments, sites] = await Promise.all([api('/mutations/capabilities'), api('/arbre'), api('/postes'), api('/departements'), api('/sites')]);
    state.permissions = capabilities.permissions || {}; state.agents = tree.agents || []; state.postes = postes || []; state.departments = departments || []; state.sites = sites || [];
  }
  async function loadRows() { if (state.loading) return; state.loading = true; document.getElementById('org-mutation-error')?.classList.add('hidden'); renderRows(); try { const payload = await api('/mutations'); state.rows = payload.rows || []; } catch (error) { showError(error.message); } finally { state.loading = false; renderRows(); } }
  async function saveDraft(event) {
    event.preventDefault(); document.getElementById('org-mutation-form-error').classList.add('hidden');
    const payload = { employe_id: Number(document.getElementById('org-mutation-agent').value), type_mutation: document.getElementById('org-mutation-type').value, date_effective: document.getElementById('org-mutation-date').value, nouveau_poste: document.getElementById('org-mutation-poste').value, nouveau_dept: document.getElementById('org-mutation-dept').value, nouveau_site: document.getElementById('org-mutation-site').value, nouveau_sup_id: document.getElementById('org-mutation-supervisor').value || null, motif: document.getElementById('org-mutation-motif').value.trim() };
    if (!payload.employe_id || !payload.date_effective || !payload.nouveau_dept || !payload.motif) return showError('Agent, département, date d’effet et motif sont obligatoires.', true);
    const button = document.getElementById('org-mutation-save'); button.disabled = true;
    try { await api(state.editingId ? `/mutations/${state.editingId}` : '/mutations', { method: state.editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeModal(); notify('Brouillon de mutation enregistré.'); await loadRows(); }
    catch (error) {
      if (error.code === 'ACTIVE_MUTATION_EXISTS') {
        await loadRows();
        const existing = state.rows.find(row => Number(row.id) === Number(error.details?.mutation_id));
        if (existing && canEditMutation(existing)) openModal(existing);
      }
      showError(error.message, true);
    } finally { button.disabled = false; }
  }
  async function transition(id, path, body = {}) { await api(`/mutations/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) }); await loadRows(); }
  async function handleAction(event) {
    const button = event.target.closest('[data-action]'); if (!button) return; const id = Number(button.dataset.id); const row = state.rows.find(item => Number(item.id) === id); if (!row) return; button.disabled = true;
    try { if (button.dataset.action === 'edit') return openModal(row); if (button.dataset.action === 'submit') await transition(id, 'soumettre'); if (button.dataset.action === 'approve') await transition(id, 'approuver'); if (button.dataset.action === 'apply') await transition(id, 'appliquer'); if (button.dataset.action === 'refuse') { const reason = window.prompt('Motif obligatoire du refus :'); if (!reason?.trim()) return; await transition(id, 'refuser', { motif: reason.trim() }); } if (button.dataset.action === 'cancel') { const reason = window.prompt('Motif de l’annulation :', 'Annulation demandée'); if (reason === null) return; await transition(id, 'annuler', { motif: reason.trim() }); } notify('Workflow de mutation mis à jour.'); }
    catch (error) { showError(error.message); } finally { button.disabled = false; }
  }
  async function initialize() { if (state.initialized) return; if (!document.getElementById('org-departments-toolbar') || !document.getElementById('org-panel-departements')) return; state.initialized = true; ensureStyles(); try { await loadReferences(); ensurePanel(); ensureToolbarButton(); ensureModal(); } catch (error) { console.error('[org-mutation-workflow-ui]', error); } }
  document.addEventListener('org:mutation:open', event => {
    openForEmployee(event.detail?.employeeId).catch(error => notify(error.message, 'error'));
  });
  function boot() { let attempts = 0; const timer = window.setInterval(() => { attempts += 1; initialize(); if (state.initialized || attempts >= 120) window.clearInterval(timer); }, 100); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();

(function () {
  'use strict';

  const API_BASE = '/api/org';
  const state = {
    initialized: false,
    permissions: {},
    departments: [],
    agents: [],
    types: {},
    currentDepartmentId: null,
    rows: [],
    editingId: null,
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
  function normalizeDepartments(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.departements)) return payload.departements;
    if (Array.isArray(payload?.departments)) return payload.departments;
    return [];
  }
  function can(code) { return state.permissions[code] === true; }
  function department(id) { return state.departments.find(row => Number(row.id) === Number(id)) || null; }
  function employeeName(row) {
    return row.employe_nom_complet
      || `${row.employe_nom || ''} ${row.employe_prenom || ''}`.trim()
      || `Agent #${row.employe_id}`;
  }
  function functionLabel(row) { return row.fonction_libelle || state.types[row.fonction_type] || row.fonction_type || 'Fonction'; }
  function statusLabel(status) {
    return ({ brouillon: 'Brouillon', soumis: 'Soumis', approuve: 'Approuvé', refuse: 'Refusé', actif: 'Actif', a_corriger: 'À corriger', annule: 'Annulé', cloture: 'Clôturé' })[status] || status;
  }
  function statusClass(status) {
    return ({ brouillon: 'bg-slate-100 text-slate-700', soumis: 'bg-blue-100 text-blue-800', approuve: 'bg-violet-100 text-violet-800', refuse: 'bg-rose-100 text-rose-800', actif: 'bg-emerald-100 text-emerald-800', a_corriger: 'bg-amber-100 text-amber-800', annule: 'bg-slate-200 text-slate-600', cloture: 'bg-slate-200 text-slate-600' })[status] || 'bg-slate-100 text-slate-700';
  }

  function installStyles() {
    if (document.getElementById('org-department-functions-styles')) return;
    const style = document.createElement('style');
    style.id = 'org-department-functions-styles';
    style.textContent = `
      .org-dept-functions-summary{margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;display:grid;gap:6px}
      .org-dept-function-line{display:flex;gap:8px;align-items:flex-start;font-size:11px;color:#475569}
      .org-dept-function-role{min-width:102px;font-weight:700;color:#334155}
      #modal-org-department-functions .org-functions-shell{width:min(980px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}
      #org-functions-list{display:grid;gap:9px}.org-function-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;border:1px solid #e2e8f0;border-radius:14px;padding:12px;background:#fff}
      .org-function-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-content:flex-start}
      #form-org-department-function{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}#form-org-department-function .full{grid-column:1/-1}
      #form-org-department-function label{display:block;margin-bottom:5px;font-size:12px;font-weight:600;color:#475569}#form-org-department-function input,#form-org-department-function select,#form-org-department-function textarea{width:100%}
      #org-functions-report{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.org-report-card{border:1px solid #e2e8f0;border-radius:12px;padding:11px;background:#fff}
      @media(max-width:720px){.org-function-row,#form-org-department-function{grid-template-columns:1fr}#form-org-department-function .full{grid-column:auto}.org-function-actions{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function summaryHtml(dept) {
    const functions = Array.isArray(dept.fonctions) ? dept.fonctions : [];
    const head = functions.find(row => row.fonction_type === 'interimaire') || functions.find(row => row.fonction_type === 'chef');
    const lines = [];
    lines.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(head ? functionLabel(head) : (dept.responsable_fonction || 'Chef de département'))}</span><span><strong>${escapeHtml(head ? employeeName(head) : (dept.responsable_nom || 'Non désigné'))}</strong><br>${escapeHtml(head?.employe_poste || dept.responsable_poste || 'Poste non renseigné')}</span></div>`);
    for (const row of functions.filter(item => ['premier_adjoint', 'adjoint', 'suppleant', 'chef_service', 'chef_section', 'coordonnateur'].includes(item.fonction_type))) {
      lines.push(`<div class="org-dept-function-line"><span class="org-dept-function-role">${escapeHtml(functionLabel(row))}</span><span><strong>${escapeHtml(employeeName(row))}</strong><br>${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</span></div>`);
    }
    return lines.join('');
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
  function scheduleEnrichment() { window.clearTimeout(state.renderTimer); state.renderTimer = window.setTimeout(enrichCards, 30); }

  function ensureToolbarButton() {
    const toolbar = document.getElementById('org-departments-toolbar');
    if (!toolbar || document.getElementById('org-functions-report-open') || !can('hr.department_function.report')) return;
    const button = document.createElement('button');
    button.id = 'org-functions-report-open'; button.type = 'button'; button.className = 'btn btn-secondary text-sm'; button.textContent = 'Rapport fonctions';
    button.addEventListener('click', openReport); toolbar.appendChild(button);
  }

  function ensureModal() {
    if (document.getElementById('modal-org-department-functions')) return;
    const modal = document.createElement('div');
    modal.id = 'modal-org-department-functions'; modal.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-3';
    modal.innerHTML = `
      <div class="modal card rounded-2xl org-functions-shell">
        <div class="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h2 id="org-functions-title" class="text-lg font-bold text-slate-900">Fonctions du département</h2><p class="text-xs text-slate-500 mt-1">Brouillon → soumission → approbation → prise d’effet → clôture.</p></div><button type="button" class="btn btn-secondary btn-xs" id="org-functions-close">×</button></div>
        <div class="p-5 space-y-5">
          <div class="flex flex-wrap items-center justify-between gap-3"><select id="org-functions-filter" class="rounded-lg border-slate-300 text-xs"><option value="">Tous les statuts</option><option value="brouillon">Brouillons</option><option value="soumis">Soumis</option><option value="approuve">Approuvés</option><option value="actif">Actifs</option><option value="refuse">Refusés</option><option value="a_corriger">À corriger</option><option value="cloture">Clôturés</option><option value="annule">Annulés</option></select><button type="button" class="btn btn-secondary btn-xs" id="org-functions-refresh">Actualiser</button></div>
          <section><div id="org-functions-list"></div></section>
          <section id="org-functions-form-section" class="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 id="org-function-form-title" class="text-sm font-semibold text-slate-900 mb-3">Nouveau brouillon</h3>
            <form id="form-org-department-function"><input type="hidden" id="org-function-id"><input type="hidden" id="org-function-version">
              <div class="full"><label>Agent *</label><select id="org-function-employee" required></select></div>
              <div><label>Fonction *</label><select id="org-function-type" required></select></div><div><label>Rang / ordre</label><input id="org-function-rank" type="number" min="0" value="0"></div>
              <div><label>Début *</label><input id="org-function-start" type="date" required></div><div><label>Fin</label><input id="org-function-end" type="date"></div>
              <div class="full"><label>Périmètre</label><input id="org-function-scope" maxlength="255" placeholder="Administration, Opérations, Maintenance"></div>
              <div class="full"><label>Motif *</label><textarea id="org-function-motive" rows="3" required></textarea></div>
              <div class="full"><label>Référence de décision *</label><input id="org-function-reference" maxlength="255" required placeholder="Note de service, décision, acte de nomination"></div>
              <div class="full"><label>Décision signée — PDF, JPEG ou PNG, 7 Mo maximum</label><input id="org-function-document" type="file" accept="application/pdf,image/jpeg,image/png"></div>
              <div id="org-function-error" class="full hidden rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"></div>
              <div class="full flex justify-end gap-2"><button type="button" class="btn btn-secondary" id="org-function-form-reset">Réinitialiser</button><button id="org-function-save" type="submit" class="btn btn-primary">Enregistrer le brouillon</button></div>
            </form>
          </section>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    modal.querySelector('#org-functions-close').addEventListener('click', closeModal);
    modal.querySelector('#org-functions-refresh').addEventListener('click', () => loadFunctions(state.currentDepartmentId));
    modal.querySelector('#org-functions-filter').addEventListener('change', renderFunctions);
    modal.querySelector('#form-org-department-function').addEventListener('submit', saveDraft);
    modal.querySelector('#org-function-form-reset').addEventListener('click', resetForm);
    modal.querySelector('#org-function-type').addEventListener('change', updateEndRequirement);
    modal.querySelector('#org-functions-list').addEventListener('click', handleAction);
  }

  function ensureReportModal() {
    if (document.getElementById('modal-org-functions-report')) return;
    const modal = document.createElement('div'); modal.id = 'modal-org-functions-report'; modal.className = 'hidden fixed inset-0 modal-overlay z-50 flex items-center justify-center p-3';
    modal.innerHTML = `<div class="modal card rounded-2xl" style="width:min(900px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto"><div class="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h2 class="text-lg font-bold text-slate-900">Rapport des fonctions départementales</h2><p class="text-xs text-slate-500 mt-1">Indicateurs, échéances et anomalies métier.</p></div><button class="btn btn-secondary btn-xs" id="org-functions-report-close">×</button></div><div class="p-5 space-y-5"><div id="org-functions-report"></div><div><h3 class="text-sm font-semibold mb-2">Échéances à 30 jours</h3><div id="org-functions-expiring" class="space-y-2"></div></div><div><h3 class="text-sm font-semibold mb-2">Anomalies</h3><div id="org-functions-anomalies" class="space-y-2"></div></div></div></div>`;
    document.body.appendChild(modal); modal.addEventListener('click', event => { if (event.target === modal) modal.classList.add('hidden'); }); modal.querySelector('#org-functions-report-close').addEventListener('click', () => modal.classList.add('hidden'));
  }

  function actionButtons(row) {
    const buttons = [];
    if (['brouillon', 'refuse', 'a_corriger'].includes(row.statut) && can('hr.department_function.create')) buttons.push(`<button class="btn btn-secondary btn-xs" data-action="edit" data-id="${row.id}">Modifier</button>`);
    if (['brouillon', 'refuse', 'a_corriger', 'soumis'].includes(row.statut) && can('hr.department_function.attach_document')) buttons.push(`<button class="btn btn-secondary btn-xs" data-action="document" data-id="${row.id}">Document</button>`);
    if (['brouillon', 'refuse', 'a_corriger'].includes(row.statut) && can('hr.department_function.submit')) buttons.push(`<button class="btn btn-primary btn-xs" data-action="submit" data-id="${row.id}">Soumettre</button>`);
    if (row.statut === 'soumis' && can('hr.department_function.approve')) {
      buttons.push(`<button class="btn btn-primary btn-xs" data-action="approve" data-id="${row.id}">Approuver</button>`);
      buttons.push(`<button class="btn btn-danger btn-xs" data-action="refuse" data-id="${row.id}">Refuser</button>`);
    }
    if (row.statut === 'approuve' && can('hr.department_function.activate') && String(row.date_debut) <= new Date().toISOString().slice(0, 10)) buttons.push(`<button class="btn btn-primary btn-xs" data-action="activate" data-id="${row.id}">Activer</button>`);
    if (row.statut === 'actif' && can('hr.department_function.close')) buttons.push(`<button class="btn btn-danger btn-xs" data-action="close" data-id="${row.id}">Clôturer</button>`);
    if (['brouillon', 'soumis', 'approuve', 'refuse', 'a_corriger'].includes(row.statut) && can('hr.department_function.close')) buttons.push(`<button class="btn btn-secondary btn-xs" data-action="cancel" data-id="${row.id}">Annuler</button>`);
    buttons.push(`<button class="btn btn-secondary btn-xs" data-action="history" data-id="${row.id}">Historique</button>`);
    return buttons.join('');
  }

  function renderFunctions() {
    const list = document.getElementById('org-functions-list'); if (!list) return;
    const filter = document.getElementById('org-functions-filter')?.value || '';
    const rows = filter ? state.rows.filter(row => row.statut === filter) : state.rows;
    if (!rows.length) { list.innerHTML = '<div class="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Aucune fonction pour ce filtre.</div>'; return; }
    list.innerHTML = rows.map(row => `
      <article class="org-function-row"><div><div class="flex flex-wrap items-center gap-2"><strong class="text-sm text-slate-900">${escapeHtml(employeeName(row))}</strong><span class="rounded-full px-2 py-1 text-[10px] font-semibold ${statusClass(row.statut)}">${escapeHtml(statusLabel(row.statut))}</span><span class="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">${escapeHtml(functionLabel(row))}</span></div><div class="text-xs text-slate-600 mt-1">${escapeHtml(row.employe_poste || 'Poste non renseigné')}${row.perimetre ? ` · ${escapeHtml(row.perimetre)}` : ''}</div><div class="text-[11px] text-slate-500 mt-1">Du ${escapeHtml(row.date_debut)}${row.date_fin ? ` au ${escapeHtml(row.date_fin)}` : ''} · version ${Number(row.version || 1)}</div><div class="text-xs text-slate-600 mt-2"><strong>Motif :</strong> ${escapeHtml(row.motif || '—')}</div><div class="text-xs text-slate-600 mt-1"><strong>Décision :</strong> ${row.document_url ? `<a class="text-blue-700 hover:underline" href="${escapeHtml(row.document_url)}" target="_blank" rel="noopener">${escapeHtml(row.document_nom || row.decision_reference || 'Ouvrir')}</a>` : escapeHtml(row.decision_reference || 'Non jointe')}</div>${row.motif_refus ? `<div class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong>Observation :</strong> ${escapeHtml(row.motif_refus)}</div>` : ''}</div><div class="org-function-actions">${actionButtons(row)}</div></article>`).join('');
  }

  function updateEndRequirement() {
    const type = document.getElementById('org-function-type')?.value;
    const end = document.getElementById('org-function-end'); if (end) end.required = ['interimaire', 'suppleant'].includes(type);
  }
  function resetForm() {
    state.editingId = null;
    document.getElementById('org-function-form-title').textContent = 'Nouveau brouillon';
    document.getElementById('org-function-id').value = ''; document.getElementById('org-function-version').value = '';
    const dept = department(state.currentDepartmentId);
    const eligible = state.agents.filter(agent => String(agent.departement || '').trim() === String(dept?.libelle || '').trim());
    document.getElementById('org-function-employee').disabled = false;
    document.getElementById('org-function-type').disabled = false;
    document.getElementById('org-function-employee').innerHTML = '<option value="">— Sélectionner —</option>' + eligible.map(agent => `<option value="${Number(agent.id)}">${escapeHtml(`${agent.nom || ''} ${agent.prenom || ''}`.trim())}${agent.poste ? ` — ${escapeHtml(agent.poste)}` : ''}</option>`).join('');
    document.getElementById('org-function-type').innerHTML = Object.entries(state.types).map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('');
    document.getElementById('org-function-start').value = new Date().toISOString().slice(0, 10);
    ['org-function-end', 'org-function-scope', 'org-function-motive', 'org-function-reference', 'org-function-document'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('org-function-rank').value = '0'; document.getElementById('org-function-error').classList.add('hidden'); updateEndRequirement();
  }
  function editRow(row) {
    state.editingId = Number(row.id);
    document.getElementById('org-function-form-title').textContent = `Modifier le brouillon #${row.id}`;
    document.getElementById('org-function-id').value = row.id; document.getElementById('org-function-version').value = row.version;
    document.getElementById('org-function-employee').value = row.employe_id; document.getElementById('org-function-employee').disabled = true;
    document.getElementById('org-function-type').value = row.fonction_type; document.getElementById('org-function-type').disabled = true;
    document.getElementById('org-function-rank').value = row.rang || 0; document.getElementById('org-function-start').value = row.date_debut || '';
    document.getElementById('org-function-end').value = row.date_fin || ''; document.getElementById('org-function-scope').value = row.perimetre || '';
    document.getElementById('org-function-motive').value = row.motif || ''; document.getElementById('org-function-reference').value = row.decision_reference || '';
    document.getElementById('org-function-document').value = ''; updateEndRequirement(); document.getElementById('org-functions-form-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function showError(message) { const box = document.getElementById('org-function-error'); box.textContent = message; box.classList.remove('hidden'); }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file);
    });
  }
  async function uploadDocument(row, file) {
    if (!file) return row;
    const content = await fileToBase64(file);
    return api(`/fonctions/${row.id}/document`, { method: 'POST', body: JSON.stringify({ version: row.version, file_name: file.name, mime_type: file.type, content_base64: content }) });
  }
  async function saveDraft(event) {
    event.preventDefault(); const button = document.getElementById('org-function-save'); button.disabled = true; document.getElementById('org-function-error').classList.add('hidden');
    try {
      const payload = { employe_id: Number(document.getElementById('org-function-employee').value), fonction_type: document.getElementById('org-function-type').value, rang: Number(document.getElementById('org-function-rank').value || 0), date_debut: document.getElementById('org-function-start').value, date_fin: document.getElementById('org-function-end').value || null, perimetre: document.getElementById('org-function-scope').value.trim(), motif: document.getElementById('org-function-motive').value.trim(), decision_reference: document.getElementById('org-function-reference').value.trim(), version: Number(document.getElementById('org-function-version').value || 0) };
      if (!payload.employe_id || !payload.fonction_type || !payload.date_debut || !payload.motif || !payload.decision_reference) return showError('Agent, fonction, date de début, motif et référence sont obligatoires.');
      let row = state.editingId ? await api(`/fonctions/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) }) : await api(`/departements/${state.currentDepartmentId}/fonctions`, { method: 'POST', body: JSON.stringify(payload) });
      const file = document.getElementById('org-function-document').files?.[0]; if (file) row = await uploadDocument(row, file);
      notify('Brouillon de fonction enregistré.'); await refreshAll(); resetForm();
    } catch (error) { showError(error.message); } finally { button.disabled = false; }
  }

  async function loadFunctions(id) {
    const payload = await api(`/departements/${Number(id)}/fonctions?historique=1`); state.types = payload.types || state.types; state.rows = payload.rows || []; renderFunctions();
  }
  async function openModal(id) {
    state.currentDepartmentId = Number(id); const dept = department(id); document.getElementById('org-functions-title').textContent = `Fonctions — ${dept?.libelle || 'Département'}`;
    document.getElementById('org-functions-form-section').classList.toggle('hidden', !can('hr.department_function.create'));
    await loadFunctions(id); resetForm(); document.getElementById('modal-org-department-functions').classList.remove('hidden');
  }
  function closeModal() { document.getElementById('modal-org-department-functions')?.classList.add('hidden'); state.currentDepartmentId = null; state.rows = []; state.editingId = null; }
  async function refreshAll() {
    const [departments, tree] = await Promise.all([api('/departements'), api('/arbre')]); state.departments = normalizeDepartments(departments); state.agents = tree.agents || [];
    if (state.currentDepartmentId) await loadFunctions(state.currentDepartmentId); if (typeof window.loadOrgDepartements === 'function') await window.loadOrgDepartements(); scheduleEnrichment();
  }

  async function transition(row, action, body = {}) {
    return api(`/fonctions/${row.id}/${action}`, { method: 'POST', body: JSON.stringify({ version: row.version, ...body }) });
  }
  async function handleAction(event) {
    const button = event.target.closest('[data-action]'); if (!button) return; const row = state.rows.find(item => Number(item.id) === Number(button.dataset.id)); if (!row) return;
    button.disabled = true;
    try {
      const action = button.dataset.action;
      if (action === 'edit') { editRow(row); return; }
      if (action === 'document') { editRow(row); document.getElementById('org-function-document').click(); return; }
      if (action === 'submit') await transition(row, 'soumettre');
      if (action === 'approve') await transition(row, 'approuver');
      if (action === 'activate') await transition(row, 'activer');
      if (action === 'refuse') { const motif = window.prompt('Motif obligatoire du refus :'); if (!motif?.trim()) return; await transition(row, 'refuser', { motif: motif.trim() }); }
      if (action === 'close') { const motif = window.prompt('Motif obligatoire de clôture :'); if (!motif?.trim()) return; await transition(row, 'cloturer', { motif: motif.trim() }); }
      if (action === 'cancel') { const motif = window.prompt('Motif obligatoire d’annulation :'); if (!motif?.trim()) return; await transition(row, 'annuler', { motif: motif.trim() }); }
      if (action === 'history') { const detail = await api(`/fonctions/${row.id}`); const history = (detail.events || []).map(ev => `${String(ev.created_at || '').replace('T', ' ').slice(0, 19)} — ${ev.event_type} — ${ev.actor_nom || 'système'}`).join('\n'); window.alert(history || 'Aucun événement.'); return; }
      notify('Workflow de fonction mis à jour.'); await refreshAll();
    } catch (error) { notify(error.message, 'error'); } finally { button.disabled = false; }
  }

  async function openReport() {
    ensureReportModal(); const payload = await api('/fonctions-rapport');
    document.getElementById('org-functions-report').innerHTML = (payload.summary || []).map(row => `<div class="org-report-card"><div class="text-xs text-slate-500">${escapeHtml(statusLabel(row.statut))} · ${escapeHtml(state.types[row.fonction_type] || row.fonction_type)}</div><div class="text-xl font-bold text-slate-900 mt-1">${Number(row.total || 0)}</div></div>`).join('') || '<div class="text-sm text-slate-500">Aucune donnée.</div>';
    document.getElementById('org-functions-expiring').innerHTML = (payload.expiring || []).map(row => `<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>${escapeHtml(row.departement_libelle)}</strong> — ${escapeHtml(row.employe_nom_complet)} · ${escapeHtml(state.types[row.fonction_type] || row.fonction_type)} · fin ${escapeHtml(row.date_fin)}</div>`).join('') || '<div class="text-sm text-slate-500">Aucune échéance proche.</div>';
    document.getElementById('org-functions-anomalies').innerHTML = (payload.anomalies || []).map(row => `<div class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><strong>${escapeHtml(row.code)}</strong> — ${escapeHtml(row.libelle || '')}${row.fonction_id ? ` · fonction #${Number(row.fonction_id)}` : ''}</div>`).join('') || '<div class="text-sm text-emerald-700">Aucune anomalie détectée.</div>';
    document.getElementById('modal-org-functions-report').classList.remove('hidden');
  }

  async function initialize() {
    if (state.initialized) return; const cards = document.getElementById('org-dept-cards'); if (!cards) return;
    state.initialized = true; installStyles(); ensureModal(); ensureReportModal();
    try {
      const [capabilities, departments, tree] = await Promise.all([api('/departements/capabilities'), api('/departements'), api('/arbre')]);
      state.permissions = capabilities.permissions || {}; state.departments = normalizeDepartments(departments); state.agents = tree.agents || [];
      ensureToolbarButton(); enrichCards(); new MutationObserver(scheduleEnrichment).observe(cards, { childList: true }); window.refreshDepartmentFunctions = refreshAll;
    } catch (error) { console.error('[org-department-functions-ui]', error); }
  }
  function boot() { let attempts = 0; const timer = window.setInterval(() => { attempts += 1; initialize(); if (state.initialized || attempts >= 120) window.clearInterval(timer); }, 100); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
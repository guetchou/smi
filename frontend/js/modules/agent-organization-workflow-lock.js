(function () {
  'use strict';

  const FIELD_IDS = ['ag-poste', 'ag-departement', 'ag-site', 'ag-superieur'];
  let lastAgentId = undefined;

  function currentAgentId() {
    const parsed = Number(document.getElementById('agent-id')?.value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function notify(message, type = 'error') {
    if (typeof window.showToast === 'function') return window.showToast(message, type);
    if (typeof window.toast === 'function') return window.toast(message, type);
    window.alert(message);
  }

  function fieldControls(fieldId) {
    return [
      document.getElementById(fieldId),
      document.getElementById(`${fieldId}-select`),
    ].filter(Boolean);
  }

  function ensureHint() {
    let hint = document.getElementById('ag-organization-workflow-lock-hint');
    if (hint) return hint;

    const anchor = document.getElementById('ag-departement-responsable-hint')
      || document.getElementById('ag-departement-select')
      || document.getElementById('ag-departement');
    if (!anchor) return null;

    hint = document.createElement('div');
    hint.id = 'ag-organization-workflow-lock-hint';
    hint.className = 'hidden mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900';
    hint.innerHTML = `
      <div class="font-semibold">Modification organisationnelle contrôlée</div>
      <div class="mt-1">Pour un agent existant, le poste, le département, le site et le supérieur passent par le workflow Mutations RH.</div>
      <button type="button" id="ag-open-mutation-workflow" class="mt-2 font-semibold text-blue-700 hover:underline">Ouvrir Mutations RH</button>
    `;
    anchor.insertAdjacentElement('afterend', hint);
    hint.querySelector('#ag-open-mutation-workflow').addEventListener('click', openWorkflow);
    return hint;
  }

  function openWorkflow() {
    const button = document.getElementById('org-mutation-open');
    if (!button) {
      notify('Ouvrez Organigramme → Départements → Mutations RH pour créer la demande.');
      return;
    }
    document.dispatchEvent(new CustomEvent('org:mutation:open', {
      detail: { employeeId: currentAgentId() },
    }));
  }

  function applyLock() {
    const agentId = currentAgentId();
    const locked = Boolean(agentId);

    for (const fieldId of FIELD_IDS) {
      for (const control of fieldControls(fieldId)) {
        if (locked) {
          control.dataset.workflowLocked = 'true';
          control.disabled = true;
          control.title = 'Modification via le workflow Mutations RH';
        } else if (control.dataset.workflowLocked === 'true') {
          delete control.dataset.workflowLocked;
          control.disabled = false;
          control.title = '';
        }
      }
    }

    const hint = ensureHint();
    if (hint) hint.classList.toggle('hidden', !locked);
    lastAgentId = agentId;
  }

  function boot() {
    window.setInterval(() => {
      const agentId = currentAgentId();
      const needsRefresh = agentId !== lastAgentId
        || FIELD_IDS.some(fieldId => fieldControls(fieldId).some(control => Boolean(agentId) && !control.disabled));
      if (needsRefresh) applyLock();
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

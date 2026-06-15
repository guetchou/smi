(function () {
  'use strict';

  const STATUS_LABELS = {
    brouillon: 'Brouillon', soumis_rh: 'Soumis RH', soumis_dg: 'En attente DG',
    approuve: 'Approuvé', applique: 'Appliqué', rejete: 'Rejeté', ajourne: 'Ajourné', annule: 'Annulé'
  };
  const STATUS_COLORS = {
    brouillon: 'bg-slate-100 text-slate-600',
    soumis_rh: 'bg-amber-100 text-amber-700',
    soumis_dg: 'bg-rose-100 text-rose-700',
    approuve: 'bg-emerald-100 text-emerald-700',
    applique: 'bg-green-100 text-green-700',
    rejete: 'bg-red-100 text-red-700',
    ajourne: 'bg-slate-200 text-slate-600',
    annule: 'bg-slate-200 text-slate-500',
  };
  const TYPE_LABELS = {
    augmentation: 'Augmentation',
    correction: 'Correction',
    promotion: 'Promotion',
    indexation: 'Indexation',
    regularisation: 'Régularisation',
    embauche: 'Embauche'
  };

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const notify = options.notify || (() => {});
    const hasAnyRole = options.hasAnyRole || (() => false);
    const setBadge = options.setBadge || (() => {});
    let revisions = [];
    let drawerData = null;
    let currentSalary = 0;

    function byId(id) {
      return doc.getElementById(id);
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollRevisions: request adapter requis');
      }
    }

    function badge(status) {
      const classes = STATUS_COLORS[status] || 'bg-slate-100 text-slate-500';
      return `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${classes}">${STATUS_LABELS[status] || status}</span>`;
    }

    function money(value) {
      return Number(value || 0).toLocaleString('fr-FR');
    }

    async function load() {
      requireRequest();
      const data = await request('/revisions-salaire?limit=100');
      revisions = Array.isArray(data) ? data : [];
      render(revisions);
      updateNavBadge();
      byId('btn-new-revision')?.classList.toggle('hidden', !hasAnyRole('admin', 'rh', 'finance'));
      return revisions;
    }

    function render(list) {
      const tbody = byId('revisions-tbody');
      if (!tbody) return;
      if (!list || !list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-10 text-slate-400 text-sm">Aucune révision salariale</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(item => {
        const delta = (item.salaire_propose || 0) - (item.salaire_actuel || 0);
        const pct = item.salaire_actuel ? Math.round(delta / item.salaire_actuel * 100) : 0;
        const deltaHtml = item.salaire_propose
          ? `<span class="${delta >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-semibold">${delta >= 0 ? '+' : ''}${money(delta)}</span>`
          : '—';
        return `<tr class="hover:bg-slate-50 cursor-pointer" onclick="openRevisionDrawer(${item.id})">
          <td class="px-4 py-3">
            <div class="font-medium text-slate-800 text-sm">${item.employe_nom || '—'}</div>
            <div class="text-xs text-slate-400">${item.employe_poste || ''}</div>
          </td>
          <td class="px-4 py-3 text-xs">${TYPE_LABELS[item.type_revision] || item.type_revision || '—'}</td>
          <td class="px-4 py-3 text-right font-mono text-xs">${money(item.salaire_actuel)}</td>
          <td class="px-4 py-3 text-right text-xs">
            <div class="font-mono">${money(item.salaire_propose)}</div>
            <div class="text-xs">${deltaHtml} <span class="text-slate-400">(${pct >= 0 ? '+' : ''}${pct}%)</span></div>
          </td>
          <td class="px-4 py-3 text-xs text-slate-500">${item.date_effet || '—'}</td>
          <td class="px-4 py-3">${badge(item.statut)}</td>
          <td class="px-4 py-3 text-right">
            <button onclick="event.stopPropagation();openRevisionDrawer(${item.id})" class="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-400" title="Détail">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            </button>
          </td>
        </tr>`;
      }).join('');
    }

    function filter() {
      const query = (byId('rev-search')?.value || '').toLowerCase();
      const status = byId('rev-filter-statut')?.value || '';
      const type = byId('rev-filter-type')?.value || '';
      render(revisions.filter(item =>
        (!query || (item.employe_nom || '').toLowerCase().includes(query)) &&
        (!status || item.statut === status) &&
        (!type || item.type_revision === type)
      ));
    }

    function updateNavBadge() {
      const pending = revisions.filter(item => item.statut === 'soumis_dg').length;
      setBadge('revisions-nav-badge', pending, `${pending} révision${pending > 1 ? 's' : ''} salariale${pending > 1 ? 's' : ''} à valider`);
    }

    async function openDrawer(id) {
      requireRequest();
      const data = await request(`/revisions-salaire/${id}`);
      if (!data || data.error) return false;
      drawerData = data;
      byId('rev-drawer-agent').textContent = `${data.employe_nom || '—'} — ${data.employe_poste || ''}`;
      const statusBadge = byId('rev-drawer-badge');
      const classes = STATUS_COLORS[data.statut] || 'bg-slate-100 text-slate-600';
      statusBadge.className = `px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`;
      statusBadge.textContent = STATUS_LABELS[data.statut] || data.statut;
      const delta = (data.salaire_propose || 0) - (data.salaire_actuel || 0);
      const pct = data.salaire_actuel ? (delta / data.salaire_actuel * 100).toFixed(1) : 0;
      byId('rev-drawer-infos').innerHTML = `
        <div><div class="text-xs text-slate-400 mb-1">Type</div><div class="font-medium text-slate-700">${TYPE_LABELS[data.type_revision] || data.type_revision}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Date d'effet</div><div class="font-medium text-slate-700">${data.date_effet || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Proposé par</div><div class="font-medium text-slate-700">${data.created_by_nom || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Validé RH</div><div class="font-medium text-slate-700">${data.valide_rh_nom || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Validé DG</div><div class="font-medium text-slate-700">${data.valide_dg_nom || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Créé le</div><div class="font-medium text-slate-700">${(data.created_at || '').substring(0, 10)}</div></div>`;
      byId('rev-drawer-comparateur').innerHTML = `
        <div class="font-semibold text-slate-500 uppercase tracking-wider text-xs mb-2">Comparateur salaire</div>
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-white rounded-lg p-2 border border-slate-200">
            <div class="text-slate-400 text-xs mb-1">Avant</div>
            <div class="font-mono font-semibold text-slate-700">${money(data.salaire_actuel)} XAF</div>
            <div class="text-xs text-slate-400">Transport: ${money(data.transport_actuel)} · Log: ${money(data.logement_actuel)}</div>
          </div>
          <div class="bg-indigo-50 rounded-lg p-2 border border-indigo-200">
            <div class="text-indigo-500 text-xs mb-1">Après</div>
            <div class="font-mono font-semibold text-indigo-700">${money(data.salaire_propose)} XAF</div>
            <div class="text-xs text-indigo-400">Transport: ${money(data.transport_propose)} · Log: ${money(data.logement_propose)}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-2 text-xs">
          <span class="text-slate-400">Delta :</span>
          <span class="${delta >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-mono font-semibold">${delta >= 0 ? '+' : ''}${money(delta)} XAF (${delta >= 0 ? '+' : ''}${pct}%)</span>
        </div>`;
      byId('rev-drawer-motif-text').textContent = data.motif || '—';
      renderWorkflow(data);
      byId('rev-drawer-motif-rejet').classList.add('hidden');
      byId('revision-drawer').classList.remove('translate-x-full');
      byId('revision-drawer-overlay').classList.remove('hidden');
      return true;
    }

    function closeDrawer() {
      byId('revision-drawer').classList.add('translate-x-full');
      byId('revision-drawer-overlay').classList.add('hidden');
      drawerData = null;
    }

    function renderWorkflow(item) {
      const canRh = hasAnyRole('admin', 'rh');
      const canDg = hasAnyRole('admin', 'dg');
      const canWrite = hasAnyRole('admin', 'rh', 'finance');
      const workflow = byId('rev-drawer-workflow');
      let html = '';
      if (item.statut === 'brouillon' && canWrite) html += `<button onclick="revisionAction(${item.id},'soumettre-rh')" class="px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-200">Soumettre au RH</button>`;
      if (item.statut === 'soumis_rh' && canRh) html += `<button onclick="revisionAction(${item.id},'valider-rh')" class="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold hover:bg-blue-200">Valider (RH)</button>`;
      if (item.statut === 'soumis_dg' && canDg) {
        html += `<button onclick="revisionAction(${item.id},'valider-dg')" class="px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold hover:bg-emerald-200">Approuver (DG)</button>`;
        html += `<button onclick="showRevisionMotifPanel(${item.id},'ajourner')" class="px-3 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-300 ml-1">Ajourner</button>`;
        html += `<button onclick="showRevisionMotifPanel(${item.id},'rejeter')" class="px-3 py-1.5 bg-rose-100 text-rose-700 rounded-lg text-xs font-semibold hover:bg-rose-200 ml-1">Rejeter</button>`;
      }
      if (item.statut === 'approuve' && canDg) html += `<button onclick="revisionAction(${item.id},'appliquer')" class="px-3 py-1.5 bg-green-100 text-green-700 rounded-lg text-xs font-semibold hover:bg-green-200">Appliquer la révision</button>`;
      if (['brouillon', 'soumis_rh'].includes(item.statut) && canWrite) html += `<button onclick="showRevisionMotifPanel(${item.id},'annuler')" class="px-3 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-300 ml-auto">Annuler</button>`;
      workflow.innerHTML = html || '<span class="text-xs text-slate-400">Aucune action disponible</span>';
    }

    async function action(id, actionName, motif = null) {
      const body = motif ? { motif } : {};
      const result = await request(`/revisions-salaire/${id}/${actionName}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!result || result.error) return false;
      notify('Révision mise à jour', 'success');
      byId('rev-drawer-motif-rejet').classList.add('hidden');
      await load();
      await openDrawer(id);
      await loadDgBanner();
      return true;
    }

    function showMotifPanel(id, actionName) {
      const labels = { ajourner: 'Motif d\'ajournement *', rejeter: 'Motif de rejet *', annuler: 'Motif d\'annulation *' };
      byId('rev-drawer-motif-rejet-label').textContent = labels[actionName] || 'Motif *';
      byId('rev-drawer-motif-input').value = '';
      byId('rev-drawer-motif-rejet').classList.remove('hidden');
      byId('rev-drawer-motif-confirm').onclick = async () => {
        const motif = byId('rev-drawer-motif-input').value.trim();
        if (!motif) {
          notify('Motif obligatoire', 'warn');
          return;
        }
        await action(id, actionName, motif);
      };
    }

    function openModal(agentId = null, agentName = null, salary = 0) {
      const id = agentId || byId('agent-id')?.value;
      const name = agentName || `${byId('ag-nom')?.value || ''} ${byId('ag-prenom')?.value || ''}`;
      const baseSalary = salary || Number.parseFloat(byId('ag-salaire-base')?.value || 0);
      currentSalary = baseSalary;
      byId('rev-agent-id').value = id || '';
      byId('rev-agent-nom').textContent = name || '—';
      byId('rev-salaire-actuel').textContent = money(baseSalary);
      byId('rev-salaire-propose').value = baseSalary || '';
      byId('rev-transport').value = Number.parseFloat(byId('ag-prime-transport')?.value || 0);
      byId('rev-logement').value = Number.parseFloat(byId('ag-prime-logement')?.value || 0);
      byId('rev-date-effet').value = new Date().toISOString().substring(0, 10);
      byId('rev-motif').value = '';
      byId('rev-type').value = 'augmentation';
      byId('rev-comparateur').classList.add('hidden');
      byId('modal-revision').classList.remove('hidden');
      byId('modal-revision').classList.add('flex');
    }

    function closeModal() {
      byId('modal-revision').classList.add('hidden');
      byId('modal-revision').classList.remove('flex');
    }

    function updateComparator() {
      const proposed = Number.parseFloat(byId('rev-salaire-propose').value || 0);
      const transport = Number.parseFloat(byId('rev-transport').value || 0);
      const housing = Number.parseFloat(byId('rev-logement').value || 0);
      if (!proposed) {
        byId('rev-comparateur').classList.add('hidden');
        return;
      }
      byId('rev-comparateur').classList.remove('hidden');
      const cnss = 0.04725;
      const camu = 0.0225;
      const currentCost = currentSalary * (1 + cnss + camu);
      const proposedCost = proposed * (1 + cnss + camu) + transport + housing;
      const delta = proposedCost - currentCost;
      const pct = currentCost ? (delta / currentCost * 100).toFixed(1) : 0;
      byId('rev-comp-actuel').textContent = `${money(Math.round(currentCost))} XAF/mois`;
      byId('rev-comp-propose').textContent = `${money(Math.round(proposedCost))} XAF/mois`;
      byId('rev-comp-delta').textContent = `${delta >= 0 ? '+' : ''}${money(Math.round(delta))} XAF`;
      byId('rev-comp-delta').className = `font-mono font-bold ${delta >= 0 ? 'text-rose-600' : 'text-emerald-600'}`;
      byId('rev-comp-pct').textContent = `${delta >= 0 ? '+' : ''}${pct}%`;
      byId('rev-comp-pct').className = `font-semibold ${delta >= 0 ? 'text-rose-600' : 'text-emerald-600'}`;
    }

    async function save(mode) {
      const agentId = byId('rev-agent-id').value;
      const salary = Number.parseFloat(byId('rev-salaire-propose').value || 0);
      const transport = Number.parseFloat(byId('rev-transport').value || 0);
      const housing = Number.parseFloat(byId('rev-logement').value || 0);
      const motif = byId('rev-motif').value.trim();
      const date_effet = byId('rev-date-effet').value;
      const type_revision = byId('rev-type').value;
      if (!agentId) { notify('Agent non sélectionné', 'warn'); return false; }
      if (!salary) { notify('Salaire proposé obligatoire', 'warn'); return false; }
      if (!motif) { notify('Motif obligatoire', 'warn'); return false; }
      if (!date_effet) { notify('Date d\'effet obligatoire', 'warn'); return false; }
      const result = await request('/revisions-salaire', {
        method: 'POST',
        body: JSON.stringify({
          employe_id: Number.parseInt(agentId, 10),
          type_revision,
          date_effet,
          salaire_propose: salary,
          transport_propose: transport,
          logement_propose: housing,
          motif,
        }),
      });
      if (!result || result.error) return false;
      if (mode === 'soumettre') {
        const submitted = await request(`/revisions-salaire/${result.id}/soumettre-rh`, { method: 'POST', body: '{}' });
        if (submitted && !submitted.error) notify('Révision créée et soumise au RH', 'success');
      } else {
        notify('Révision sauvegardée en brouillon', 'success');
      }
      closeModal();
      await load();
      await loadSalaryHistory(agentId);
      await loadDgBanner();
      return true;
    }

    async function loadSalaryHistory(agentId) {
      if (!agentId) return false;
      const data = await request(`/agents/${agentId}/historique-salaires`);
      const list = Array.isArray(data) ? data : (data?.historique || []);
      const container = byId('ag-historique-salaire-list');
      if (!container) return false;
      if (!list.length) {
        container.innerHTML = '<div class="text-xs text-slate-400 text-center py-4">Aucun historique salarial</div>';
        return true;
      }
      container.innerHTML = list.slice(0, 8).map(item => {
        const delta = (item.nouveau_salaire || 0) - (item.ancien_salaire || 0);
        return `<div class="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
          <div class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${delta >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-medium text-slate-700">${TYPE_LABELS[item.type_revision] || item.type_revision || '—'}</span>
              <span class="text-xs font-mono ${delta >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-semibold">${delta >= 0 ? '+' : ''}${money(delta)} XAF</span>
            </div>
            <div class="text-xs text-slate-400 mt-0.5">${item.date_effet || ''} · ${money(item.nouveau_salaire)} XAF · ${item.approved_by_nom || '—'}</div>
            <div class="text-xs text-slate-500 mt-0.5 truncate">${item.motif || ''}</div>
          </div>
        </div>`;
      }).join('');
      return true;
    }

    async function loadDgBanner() {
      const banner = byId('dg-revisions-banner');
      if (!banner) return false;
      if (!hasAnyRole('admin', 'dg')) {
        banner.classList.add('hidden');
        return false;
      }
      const data = await request('/revisions-salaire/en-attente');
      if (!data) {
        banner.classList.add('hidden');
        return false;
      }
      const count = data.count || 0;
      byId('dg-revisions-count').textContent = count;
      if (count === 0) {
        banner.classList.add('hidden');
        return false;
      }
      banner.classList.remove('hidden');
      byId('dg-revisions-list').innerHTML = (data.items || []).slice(0, 3).map(item => {
        const delta = (item.salaire_propose || 0) - (item.salaire_actuel || 0);
        const pct = item.salaire_actuel ? (delta / item.salaire_actuel * 100).toFixed(1) : 0;
        return `<div class="flex items-center justify-between bg-white rounded-lg border border-rose-100 px-3 py-2 text-xs">
          <div>
            <span class="font-semibold text-slate-700">${item.employe_nom || '—'}</span>
            <span class="text-slate-400 ml-2">${TYPE_LABELS[item.type_revision] || item.type_revision}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="font-mono text-emerald-600 font-semibold">+${money(delta)} XAF (${pct}%)</span>
            <button onclick="openRevisionDrawer(${item.id})" class="px-2 py-1 bg-rose-100 text-rose-700 rounded font-semibold hover:bg-rose-200">Décider</button>
          </div>
        </div>`;
      }).join('');
      return true;
    }

    function refreshAgentRemunerationTab() {
      const agentId = byId('agent-id')?.value;
      const canPropose = hasAnyRole('admin', 'rh', 'finance');
      byId('btn-proposer-revision')?.classList.toggle('hidden', !canPropose);
      if (agentId) loadSalaryHistory(agentId);
    }

    return {
      load,
      render,
      filter,
      updateNavBadge,
      openDrawer,
      closeDrawer,
      renderWorkflow,
      action,
      showMotifPanel,
      openModal,
      closeModal,
      updateComparator,
      save,
      loadSalaryHistory,
      loadDgBanner,
      refreshAgentRemunerationTab,
      getRevisions: () => revisions,
      getDrawerData: () => drawerData,
    };
  }

  window.TalaPayrollRevisions = { create, STATUS_LABELS, STATUS_COLORS, TYPE_LABELS };
})();

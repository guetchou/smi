(function () {
  'use strict';

  const MONTH_NAMES = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const STATUS_LABELS = {
    ouverte: 'Ouverte',
    preparation: 'En préparation',
    controle_rh: 'Contrôle RH',
    controle_finance: 'Contrôle Finance',
    soumis_dg: 'En attente DG',
    validee_dg: 'Validée DG',
    paiement_en_cours: 'Paiement en cours',
    payee_partielle: 'Payée partielle',
    payee: 'Payée',
    cloturee: 'Clôturée',
    rouverte_exception: 'Réouverte (exception)',
  };
  const STATUS_COLORS = {
    ouverte: 'bg-blue-100 text-blue-700',
    preparation: 'bg-indigo-100 text-indigo-700',
    controle_rh: 'bg-amber-100 text-amber-700',
    controle_finance: 'bg-orange-100 text-orange-700',
    soumis_dg: 'bg-rose-100 text-rose-700',
    validee_dg: 'bg-emerald-100 text-emerald-700',
    paiement_en_cours: 'bg-teal-100 text-teal-700',
    payee_partielle: 'bg-yellow-100 text-yellow-700',
    payee: 'bg-green-100 text-green-700',
    cloturee: 'bg-slate-200 text-slate-600',
    rouverte_exception: 'bg-red-100 text-red-700',
  };

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const hasAnyRole = options.hasAnyRole || (() => false);
    const isAdmin = options.isAdmin || (() => false);
    const notify = options.notify || (() => {});
    const refreshDgBanner = options.refreshDgBanner || (() => {});
    const formatMoney = options.formatMoney || (value =>
      `${Number(value || 0).toLocaleString('fr-FR')} XAF`);
    let periods = [];
    let drawerData = null;

    function byId(id) {
      return doc.getElementById(id);
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollPeriods: request adapter requis');
      }
    }

    function badge(status) {
      const classes = STATUS_COLORS[status] || 'bg-slate-100 text-slate-500';
      return `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${classes}">${STATUS_LABELS[status] || status}</span>`;
    }

    function render(list) {
      const container = byId('periodes-timeline');
      if (!container) return;
      if (!list.length) {
        container.innerHTML = '<div class="text-center py-10 text-slate-400 text-sm">Aucune période enregistrée</div>';
        return;
      }
      container.innerHTML = list.map(period => `
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm hover:border-indigo-300 cursor-pointer transition-all p-4 flex items-center justify-between gap-4"
             onclick="openPeriodeDrawer(${period.id})">
          <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-xl bg-indigo-50 flex flex-col items-center justify-center text-indigo-700 flex-shrink-0">
              <div class="text-lg font-bold leading-tight">${String(period.mois).padStart(2, '0')}</div>
              <div class="text-xs">${period.annee}</div>
            </div>
            <div>
              <div class="font-semibold text-slate-800">${MONTH_NAMES[period.mois] || period.mois} ${period.annee}</div>
              <div class="flex items-center gap-3 mt-1 text-xs text-slate-500">
                <span>${Number(period.total_net || 0).toLocaleString('fr-FR')} XAF net</span>
                <span>·</span>
                <span>${period.nb_bulletins || 0} bulletins</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3">
            ${badge(period.statut)}
            <span class="text-slate-400" aria-hidden="true">›</span>
          </div>
        </div>`).join('');
    }

    function updateNavBadge(list) {
      const navBadge = byId('periodes-nav-badge');
      if (!navBadge) return;
      const pending = list.filter(period => period.statut === 'soumis_dg').length;
      navBadge.textContent = pending;
      navBadge.classList.toggle('hidden', pending === 0);
    }

    async function load() {
      requireRequest();
      const data = await request('/paie/periodes');
      periods = Array.isArray(data) ? data : [];
      render(periods);
      updateNavBadge(periods);
      byId('btn-new-periode')?.classList.toggle('hidden', !hasAnyRole('admin', 'rh', 'finance'));
      return periods;
    }

    async function openCurrent() {
      requireRequest();
      const now = new Date();
      const mois = now.getMonth() + 1;
      const annee = now.getFullYear();
      const result = await request('/paie/periodes', {
        method: 'POST',
        body: JSON.stringify({ mois, annee }),
      });
      if (!result || result.error) return false;
      notify(`Période ${MONTH_NAMES[mois]} ${annee} ouverte`, 'success');
      await load();
      return true;
    }

    function renderSummary(data) {
      const summary = data.synthese || {};
      byId('pd-titre').textContent = `${MONTH_NAMES[data.mois] || data.mois} ${data.annee}`;
      byId('pd-sous-titre').textContent = `Période ${data.mois}/${data.annee}`;
      const statusBadge = byId('pd-badge');
      const classes = STATUS_COLORS[data.statut] || 'bg-slate-100 text-slate-600';
      statusBadge.className = `px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`;
      statusBadge.textContent = STATUS_LABELS[data.statut] || data.statut;

      byId('pd-kpis').innerHTML = [
        { label: 'Total brut', val: formatMoney(summary.total_brut), color: 'text-slate-700' },
        { label: 'Total net', val: formatMoney(summary.total_net), color: 'text-emerald-600' },
        { label: 'Charges patronales', val: formatMoney(summary.total_charges_patronales), color: 'text-amber-600' },
        { label: 'Avances retenues', val: formatMoney(summary.total_avances_retenues), color: 'text-rose-500' },
      ].map(item => `<div class="bg-slate-50 rounded-xl border border-slate-200 p-3">
        <div class="text-xs text-slate-400 mb-1">${item.label}</div>
        <div class="font-mono font-bold ${item.color} text-sm">${item.val}</div>
      </div>`).join('');

      const total = summary.nb_total || 0;
      const percentage = value => total ? Math.round(value / total * 100) : 0;
      byId('pd-bulletins-bar').innerHTML = `
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Bulletins (${total} total)</div>
        <div class="space-y-2 text-xs">
          ${[
            { label: 'Payés', val: summary.nb_paye || 0, color: 'bg-emerald-400' },
            { label: 'Validés', val: summary.nb_valide || 0, color: 'bg-blue-400' },
            { label: 'Brouillon', val: summary.nb_brouillon || 0, color: 'bg-slate-300' },
          ].map(item => `<div class="flex items-center gap-2">
            <div class="w-20 text-slate-600">${item.label}</div>
            <div class="flex-1 bg-slate-200 rounded-full h-2 overflow-hidden">
              <div class="${item.color} h-2 rounded-full" style="width:${percentage(item.val)}%"></div>
            </div>
            <div class="w-12 text-right font-semibold text-slate-700">${item.val}</div>
          </div>`).join('')}
        </div>`;

      const anomalies = summary.anomalies || [];
      byId('pd-anomalies').innerHTML = anomalies.length
        ? anomalies.map(anomaly => {
          const colors = {
            bloquant: 'bg-red-50 border-red-200 text-red-700',
            avertissement: 'bg-amber-50 border-amber-200 text-amber-700',
            info: 'bg-blue-50 border-blue-200 text-blue-700',
          };
          const labels = { bloquant: 'Bloquant', avertissement: 'Attention', info: 'Information' };
          return `<div class="rounded-lg border px-3 py-2 text-xs ${colors[anomaly.gravite] || 'bg-slate-50 border-slate-200 text-slate-600'}">
            <strong>${labels[anomaly.gravite] || 'Contrôle'} :</strong> ${anomaly.message}
          </div>`;
        }).join('')
        : '<div class="text-xs text-emerald-600">Aucune anomalie détectée</div>';

      byId('pd-details-content').innerHTML = [
        { label: 'Primes', val: formatMoney(summary.total_primes) },
        { label: 'Coût total employeur', val: formatMoney((summary.total_net || 0) + (summary.total_charges_patronales || 0)) },
      ].map(item => `<div><div class="text-xs text-slate-400 mb-1">${item.label}</div>
        <div class="font-mono font-semibold text-slate-700">${item.val}</div></div>`).join('');

      byId('pd-entrants-sortants').innerHTML = [
        { label: 'Agents entrants', val: summary.entrants || 0, color: 'text-emerald-600', bg: 'bg-emerald-50' },
        { label: 'Agents sortants', val: summary.sortants || 0, color: 'text-rose-600', bg: 'bg-rose-50' },
      ].map(item => `<div class="rounded-xl border border-slate-200 p-3 ${item.bg}">
        <div class="text-xs text-slate-500 mb-1">${item.label}</div>
        <div class="text-2xl font-bold ${item.color}">${item.val}</div>
      </div>`).join('');

      byId('pd-info-validation').innerHTML = [
        data.soumis_dg_nom ? `Soumis par : ${data.soumis_dg_nom} le ${(data.soumis_dg_at || '').substring(0, 10)}` : null,
        data.valide_dg_nom ? `Validé DG : ${data.valide_dg_nom} le ${(data.valide_dg_at || '').substring(0, 10)}` : null,
      ].filter(Boolean).map(text => `<div>${text}</div>`).join('');
      renderWorkflow(data, anomalies);
    }

    async function openDrawer(id) {
      requireRequest();
      const data = await request(`/paie/periodes/${id}`);
      if (!data || data.error) return false;
      drawerData = data;
      renderSummary(data);
      byId('pd-notes-panel').classList.add('hidden');
      byId('periode-drawer').classList.remove('translate-x-full');
      byId('periode-drawer-overlay').classList.remove('hidden');
      return true;
    }

    function closeDrawer() {
      byId('periode-drawer').classList.add('translate-x-full');
      byId('periode-drawer-overlay').classList.add('hidden');
      drawerData = null;
    }

    function renderWorkflow(period, anomalies) {
      const canFinance = hasAnyRole('admin', 'finance', 'rh', 'dg');
      const canDg = hasAnyRole('admin', 'dg');
      const blockingCount = (anomalies || []).filter(item => item.gravite === 'bloquant').length;
      const workflow = byId('pd-workflow');
      let html = '';
      if (['ouverte', 'preparation', 'controle_rh', 'controle_finance'].includes(period.statut) && canFinance) {
        const disabled = blockingCount > 0 ? 'opacity-50 cursor-not-allowed' : '';
        html += `<button onclick="periodeAction(${period.id},'soumettre-dg')" class="px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-200 ${disabled}"
          ${blockingCount > 0 ? 'title="Anomalies bloquantes à corriger" disabled' : ''}>Soumettre au DG</button>`;
      }
      if (period.statut === 'soumis_dg' && canDg) {
        html += `<button onclick="showPeriodeNotesPanel(${period.id},'valider-dg')" class="px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold hover:bg-emerald-200">Valider la masse salariale (DG)</button>`;
      }
      if (['payee', 'paiement_en_cours', 'payee_partielle', 'validee_dg'].includes(period.statut) && isAdmin()) {
        html += `<button onclick="periodeAction(${period.id},'cloturer')" class="px-3 py-1.5 bg-slate-600 text-white rounded-lg text-xs font-semibold hover:bg-slate-700 ml-1">Clôturer la période</button>`;
      }
      if (period.statut === 'cloturee' && isAdmin()) {
        html += `<button onclick="showPeriodeReouvrir(${period.id})" class="px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-semibold hover:bg-red-200 ml-auto">Réouvrir (exception)</button>`;
      }
      workflow.innerHTML = html || '<span class="text-xs text-slate-400">Aucune action disponible pour ce statut</span>';
    }

    async function action(id, actionName, body = {}) {
      requireRequest();
      const result = await request(`/paie/periodes/${id}/${actionName}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!result || result.error) return false;
      notify(result.auto_approved ? 'Période validée directement par le DG' : 'Période mise à jour', 'success');
      byId('pd-notes-panel').classList.add('hidden');
      await load();
      await openDrawer(id);
      refreshDgBanner();
      return true;
    }

    function showNotes(id, actionName) {
      byId('pd-rouvrir-motif-wrap').classList.add('hidden');
      byId('pd-notes-input').value = '';
      byId('pd-notes-panel').classList.remove('hidden');
      byId('pd-notes-confirm').onclick = () => {
        const notes = byId('pd-notes-input').value.trim();
        action(id, actionName, { notes });
      };
    }

    function showReopen(id) {
      byId('pd-rouvrir-motif-wrap').classList.remove('hidden');
      byId('pd-notes-input').value = '';
      byId('pd-rouvrir-motif').value = '';
      byId('pd-notes-panel').classList.remove('hidden');
      byId('pd-notes-confirm').onclick = () => {
        const motif = byId('pd-rouvrir-motif').value.trim();
        if (!motif) {
          notify('Motif obligatoire', 'warn');
          return;
        }
        action(id, 'rouvrir-exception', { motif });
      };
    }

    async function loadDgBanner() {
      requireRequest();
      const banner = byId('dg-periode-banner');
      if (!banner) return false;
      if (!hasAnyRole('admin', 'dg')) {
        banner.classList.add('hidden');
        return false;
      }
      const data = await request('/paie/periodes');
      const submitted = (Array.isArray(data) ? data : []).filter(period => period.statut === 'soumis_dg');
      if (!submitted.length) {
        banner.classList.add('hidden');
        return false;
      }
      const period = submitted[0];
      banner.classList.remove('hidden');
      byId('dg-periode-label').textContent = `${MONTH_NAMES[period.mois]} ${period.annee}`;
      byId('dg-periode-chiffres').textContent =
        `Net : ${Number(period.total_net || 0).toLocaleString('fr-FR')} XAF · ${period.nb_bulletins || 0} bulletins`;
      byId('dg-periode-btn-valider').onclick = () => action(period.id, 'valider-dg', {});
      byId('dg-periode-btn-detail').onclick = () => {
        window.showPage('periodes');
        openDrawer(period.id);
      };
      return true;
    }

    return {
      load,
      render,
      updateNavBadge,
      openCurrent,
      openDrawer,
      closeDrawer,
      renderWorkflow,
      action,
      showNotes,
      showReopen,
      loadDgBanner,
      getPeriods: () => periods,
      getDrawerData: () => drawerData,
    };
  }

  window.TalaPayrollPeriods = { create, MONTH_NAMES, STATUS_LABELS, STATUS_COLORS };
})();

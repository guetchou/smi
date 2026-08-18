(function () {
  'use strict';

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const confirmAction = options.confirmAction || (async () => false);
    const promptAction = options.promptAction || (async () => null);
    const notify = options.notify || (() => {});
    const formatMoney = options.formatMoney || (value => String(value || 0));
    const reload = options.reload || (() => {});
    const withLock = options.withLock || (async (_key, action) => action());
    const canFinance = options.canFinance || (() => false);
    const canPayPeriod = options.canPayPeriod || (() => false);
    const renderPeriodGate = options.renderPeriodGate || (() => {});
    const closeBulletin = options.closeBulletin || (() => {});
    const monthNames = options.monthNames || [];
    let rows = [];
    const selection = new Set();

    function byId(id) {
      return doc.getElementById(id);
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollCycle: request adapter requis');
      }
    }

    function setRows(nextRows) {
      rows = Array.isArray(nextRows) ? nextRows : [];
      const selectableIds = new Set(
        rows.filter(row => row.bulletin && row.bulletin.statut !== 'paye').map(row => row.bulletin.id)
      );
      [...selection].forEach(id => {
        if (!selectableIds.has(id)) selection.delete(id);
      });
      updateSelectionUI();
    }

    function isSelected(id) {
      return selection.has(id);
    }

    function getSelectedRows() {
      return rows.filter(row => row.bulletin && selection.has(row.bulletin.id));
    }

    function toggleSelection(id, checked) {
      const row = rows.find(item => item.bulletin?.id === id);
      if (!row?.bulletin || row.bulletin.statut === 'paye') {
        updateSelectionUI();
        return false;
      }
      if (checked) selection.add(id);
      else selection.delete(id);
      updateSelectionUI();
      return true;
    }

    function toggleAll(checked) {
      rows.forEach(row => {
        if (!row.bulletin || row.bulletin.statut === 'paye') return;
        if (checked) selection.add(row.bulletin.id);
        else selection.delete(row.bulletin.id);
      });
      reload();
    }

    function clearSelection() {
      selection.clear();
      reload();
    }

    function updateSelectionUI() {
      const selectedRows = getSelectedRows();
      const totalNet = selectedRows.reduce((sum, row) => sum + (row.bulletin?.net_a_payer || 0), 0);
      const draftCount = selectedRows.filter(row => row.bulletin?.statut === 'brouillon').length;
      const validatedCount = selectedRows.filter(row => row.bulletin?.statut === 'valide').length;
      const bar = byId('sal-bulk-actions');
      const summary = byId('sal-selection-summary');
      const validateButton = byId('sal-bulk-validate');
      const payButton = byId('sal-bulk-pay');
      const selectAll = byId('sal-select-all');
      const selectableRows = rows.filter(row => row.bulletin && row.bulletin.statut !== 'paye');

      if (bar) bar.classList.toggle('hidden', selectedRows.length === 0);
      if (summary) {
        summary.textContent =
          `${selectedRows.length} bulletin(s) sélectionné(s) — Total net : ${formatMoney(totalNet)} XAF`;
      }
      if (validateButton) {
        validateButton.disabled = draftCount === 0 || !canFinance();
        validateButton.classList.toggle('opacity-50', validateButton.disabled);
        validateButton.title = draftCount
          ? `${draftCount} bulletin(s) brouillon à valider`
          : 'Aucun bulletin brouillon sélectionné';
      }
      if (payButton) {
        payButton.disabled = validatedCount === 0 || !canFinance();
        payButton.classList.toggle('opacity-50', payButton.disabled);
        payButton.title = validatedCount
          ? `${validatedCount} bulletin(s) validé(s) à payer`
          : 'Aucun bulletin validé sélectionné';
      }
      if (selectAll) {
        selectAll.checked =
          selectableRows.length > 0 && selectableRows.every(row => selection.has(row.bulletin.id));
        selectAll.indeterminate = selectedRows.length > 0 && !selectAll.checked;
      }
    }

    function selectionSummary(status) {
      const selectedRows = getSelectedRows();
      const compatibleRows = selectedRows.filter(row => row.bulletin?.statut === status);
      return {
        rows: selectedRows,
        compatibles: compatibleRows,
        ids: compatibleRows.map(row => row.bulletin.id),
        totalNet: compatibleRows.reduce((sum, row) => sum + (row.bulletin?.net_a_payer || 0), 0),
        agents: compatibleRows.map(row => `${row.nom} ${row.prenom}`),
      };
    }

    async function validateSelection() {
      requireRequest();
      const selected = selectionSummary('brouillon');
      if (!selected.compatibles.length) {
        notify('Aucun bulletin brouillon sélectionné', 'info');
        return false;
      }
      const message =
        `Valider ${selected.compatibles.length} bulletin(s) brouillon ?\n\n` +
        `Total net : ${formatMoney(selected.totalNet)} XAF\n` +
        `Agents : ${selected.agents.slice(0, 8).join(', ')}${selected.agents.length > 8 ? '…' : ''}`;
      if (!await confirmAction(message, 'Validation de la sélection', 'Valider sélection', 'btn-success')) {
        return false;
      }
      const result = await request('/salaires/bulletins/valider-selection', {
        method: 'POST',
        body: JSON.stringify({ ids: selected.ids })
      });
      if (!result) return false;
      selection.clear();
      notify(
        `${result.traites?.length || 0} bulletin(s) validé(s)` +
          `${result.refuses?.length ? ` — ${result.refuses.length} refusé(s)` : ''}`,
        result.erreurs?.length ? 'warning' : 'success'
      );
      reload();
      return true;
    }

    function currentPeriod() {
      return {
        mois: byId('sal-mois')?.value || '',
        annee: byId('sal-annee')?.value || '',
      };
    }

    async function requirePayablePeriod() {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const data = await request(`/salaires/rapport?mois=${mois}&annee=${annee}`);
      if (data && canPayPeriod(data.periode_paie)) return data;
      renderPeriodGate(data?.periode_paie || null, Number.parseInt(mois, 10), Number.parseInt(annee, 10));
      notify(`Masse salariale ${mois}/${annee} non validée par le DG`, 'error');
      return null;
    }

    async function paySelection() {
      if (!await requirePayablePeriod()) return false;
      const selected = selectionSummary('valide');
      if (!selected.compatibles.length) {
        notify('Aucun bulletin validé sélectionné', 'info');
        return false;
      }
      const message =
        `Payer ${selected.compatibles.length} bulletin(s) validé(s) ?\n\n` +
        `Total net : ${formatMoney(selected.totalNet)} XAF\n` +
        `Agents : ${selected.agents.slice(0, 8).join(', ')}${selected.agents.length > 8 ? '…' : ''}\n\n` +
        'Cette action est irréversible.';
      if (!await confirmAction(message, 'Paiement de la sélection', 'Payer sélection', 'btn-success')) {
        return false;
      }
      return withLock('salaires-bulk-pay', async () => {
        const result = await request('/salaires/bulletins/payer-selection', {
          method: 'POST',
          body: JSON.stringify({ ids: selected.ids })
        });
        if (!result) return false;
        selection.clear();
        notify(
          `${result.traites?.length || 0} bulletin(s) payé(s)` +
            `${result.refuses?.length ? ` — ${result.refuses.length} refusé(s)` : ''}`,
          result.erreurs?.length ? 'warning' : 'success'
        );
        reload();
        return true;
      });
    }

    async function generateAll() {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const month = Number.parseInt(mois, 10);
      const year = Number.parseInt(annee, 10);
      if (!await confirmAction(
        `Générer les bulletins de ${monthNames[month]} ${year} pour tous les employés actifs ?`,
        'Génération des bulletins',
        'Générer',
        'btn-primary'
      )) return false;
      const result = await request('/salaires/generer', {
        method: 'POST',
        body: JSON.stringify({ mois: month, annee: year })
      });
      if (!result) return false;
      const message = `${result.count} bulletin(s) généré(s)`;
      if (result.ignores?.length) {
        notify(
          `${message} — ${result.ignores.length} ignoré(s) sans salaire : ` +
            result.ignores.map(agent => `${agent.nom} ${agent.prenom}`).join(', '),
          'info'
        );
      } else {
        notify(message, 'success');
      }
      reload();
      return true;
    }

    async function generateOne(employeeId) {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const result = await request('/salaires/generer', {
        method: 'POST',
        body: JSON.stringify({
          mois: Number.parseInt(mois, 10),
          annee: Number.parseInt(annee, 10),
          employe_id: employeeId
        })
      });
      if (!result) return false;
      notify('Bulletin généré', 'success');
      reload();
      return true;
    }

    async function validateOne(bulletinId) {
      requireRequest();
      if (!await confirmAction(
        'Confirmer la validation de ce bulletin ? Il ne pourra plus être modifié sans annulation.',
        'Validation du bulletin',
        'Valider',
        'btn-success'
      )) return false;
      const result = await request(`/salaires/bulletin/${bulletinId}/valider`, {
        method: 'PUT',
        body: '{}'
      });
      if (!result?.ok) return false;
      notify('Bulletin validé', 'success');
      reload();
      return true;
    }

    async function cancelValidation(bulletinId) {
      requireRequest();
      const reason = await promptAction(
        'Motif d’annulation de validation (obligatoire) :',
        '',
        'Annuler la validation',
        'Confirmer'
      );
      if (reason === null) return false;
      if (!reason.trim()) {
        notify('Motif requis', 'error');
        return false;
      }
      const result = await request(`/salaires/bulletin/${bulletinId}/annuler`, {
        method: 'PUT',
        body: JSON.stringify({ motif: reason })
      });
      if (!result?.ok) return false;
      notify('Validation annulée — bulletin repassé en brouillon', 'success');
      reload();
      closeBulletin();
      return true;
    }

    async function validateAll() {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const data = await request(`/salaires/rapport?mois=${mois}&annee=${annee}`);
      if (!data) return false;
      const drafts = data.employes.filter(row => row.bulletin?.statut === 'brouillon');
      if (!drafts.length) {
        notify('Aucun bulletin brouillon à valider', 'info');
        return false;
      }
      if (!await confirmAction(
        `Valider ${drafts.length} bulletin(s) ?`,
        'Validation groupée',
        'Valider',
        'btn-success'
      )) return false;
      for (const row of drafts) {
        await request(`/salaires/bulletin/${row.bulletin.id}/valider`, { method: 'PUT', body: '{}' });
      }
      notify(`${drafts.length} bulletin(s) validé(s)`, 'success');
      reload();
      return true;
    }

    async function payOne(bulletinId, employeeName) {
      requireRequest();
      if (!await requirePayablePeriod()) return false;
      if (!await confirmAction(
        `Confirmer le paiement du salaire de ${employeeName} ?\n\nCette action est irréversible.`,
        'Paiement du salaire',
        'Confirmer le paiement',
        'btn-success'
      )) return false;
      return withLock(`salaire-${bulletinId}`, async () => {
        const result = await request(`/salaires/bulletin/${bulletinId}/payer`, {
          method: 'POST',
          body: '{}'
        });
        if (!result) return false;
        notify(`Salaire de ${employeeName} payé — ${formatMoney(result.net_a_payer)}`, 'success');
        reload();
        return true;
      });
    }

    return {
      setRows,
      isSelected,
      getSelectedRows,
      toggleSelection,
      toggleAll,
      clearSelection,
      updateSelectionUI,
      selectionSummary,
      validateSelection,
      paySelection,
      generateAll,
      generateOne,
      validateOne,
      cancelValidation,
      validateAll,
      payOne,
    };
  }

  const MONTHS = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function money(value) {
    const n = Number(value || 0);
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0)} XAF`;
  }

  function extractActionId(button) {
    const direct = button.dataset?.bulletinId || button.dataset?.id;
    if (/^\d+$/.test(String(direct || ''))) return Number(direct);
    let node = button;
    while (node && node !== document.body) {
      const attrs = ['onclick', 'data-action', 'data-bulletin-id'];
      for (const attr of attrs) {
        const raw = node.getAttribute?.(attr) || '';
        const match = raw.match(/(?:bulletin|bul|preview|aper|modif)[^0-9]{0,40}(\d+)/i) || raw.match(/\b(\d+)\b/);
        if (match) return Number(match[1]);
      }
      node = node.parentElement;
    }
    return null;
  }

  function isPayrollContext() {
    return /^\/app\/rh\/paie(?:\/|$)/.test(location.pathname) ||
      !!document.querySelector('#page-salaires:not(.hidden)');
  }

  async function requestBulletin(id) {
    if (typeof window.api !== 'function') throw new Error('API frontend indisponible');
    const result = await window.api(`/salaires/bulletin/${id}`);
    if (!result?.bulletin || !result?.employe) throw new Error('Bulletin ou agent introuvable');
    return result;
  }

  function closeProfessionalPreview() {
    const dialog = document.getElementById('payroll-professional-preview');
    if (!dialog) return;
    const opener = dialog._opener;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    dialog.remove();
    opener?.focus?.();
  }

  function renderProfessionalPreview(data, opener) {
    closeProfessionalPreview();
    const b = data.bulletin;
    const e = data.employe;
    const lines = [];
    const gain = (label, amount) => { if (Number(amount || 0) > 0) lines.push([label, money(amount), '—']); };
    const deduction = (label, amount) => { if (Number(amount || 0) > 0) lines.push([label, '—', money(amount)]); };
    gain('Salaire de base', b.salaire_base);
    gain('Prime de transport', b.prime_transport);
    gain('Prime de logement', b.prime_logement);
    gain('Autres primes', b.autres_primes);
    let custom = [];
    try { custom = JSON.parse(b.lignes_custom || '[]'); } catch (_) {}
    custom.forEach(line => line.type === 'prime' ? gain(line.nom || line.libelle, line.montant) : deduction(line.nom || line.libelle, Math.abs(Number(line.montant || 0))));
    deduction('CNSS salarié', b.cnss_employe);
    deduction('CAMU salarié', b.camu_employe);
    deduction('IRPP', b.irpp);
    deduction('Retenue avance sur salaire', b.retenue_avance);
    const net = Number(b.retenue_avance || 0) > 0 && Number(b.net_a_verser || 0) > 0 ? b.net_a_verser : b.net_a_payer;

    const dialog = document.createElement('dialog');
    dialog.id = 'payroll-professional-preview';
    dialog._opener = opener || document.activeElement;
    dialog.setAttribute('aria-labelledby', 'payroll-preview-title');
    dialog.innerHTML = `<div class="payroll-preview-shell">
      <header class="payroll-preview-head">
        <div><div class="payroll-brand"><span>TOP</span> CENTER</div><div class="payroll-muted">Brazzaville, République du Congo</div></div>
        <div class="payroll-preview-title"><h2 id="payroll-preview-title">BULLETIN DE SALAIRE</h2><div>${esc(MONTHS[Number(b.mois)] || b.mois)} ${esc(b.annee)}</div></div>
      </header>
      <section class="payroll-identity">
        <div><h3>ENTREPRISE</h3><dl><dt>Entreprise</dt><dd>TOP CENTER</dd><dt>Devise</dt><dd>${esc(data.devise || 'XAF')}</dd></dl></div>
        <div><h3>SALARIÉ / EMPLOI</h3><dl><dt>Nom et prénom</dt><dd>${esc(`${e.nom || ''} ${e.prenom || ''}`.trim())}</dd><dt>Matricule</dt><dd>${esc(e.matricule || '—')}</dd><dt>Poste</dt><dd>${esc(e.poste || '—')}</dd><dt>N° CNSS</dt><dd>${esc(e.cnss || '—')}</dd></dl></div>
      </section>
      <table class="payroll-preview-table"><thead><tr><th>Rubrique</th><th>Gains</th><th>Retenues</th></tr></thead><tbody>
        ${lines.map(line => `<tr><td>${esc(line[0] || 'Rubrique')}</td><td class="num">${esc(line[1])}</td><td class="num">${esc(line[2])}</td></tr>`).join('')}
      </tbody></table>
      <div class="payroll-summary"><div><span>SALAIRE BRUT</span><strong>${esc(money(b.brut))}</strong></div><div><span>TOTAL RETENUES</span><strong>${esc(money(Number(b.total_retenues || 0) + Number(b.retenue_avance || 0)))}</strong></div></div>
      <div class="payroll-net"><span>NET À PAYER</span><strong>${esc(money(net))}</strong></div>
      <footer class="payroll-preview-actions"><button type="button" data-payroll-close>Fermer</button><button type="button" class="btn btn-primary" data-payroll-agent="${Number(e.id)}">Ouvrir le dossier rémunération</button></footer>
    </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeProfessionalPreview(); });
    dialog.querySelector('[data-payroll-close]')?.addEventListener('click', closeProfessionalPreview);
    dialog.querySelector('[data-payroll-agent]')?.addEventListener('click', () => openAgentCompensation(Number(e.id), dialog._opener));
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('[data-payroll-close]')?.focus();
  }

  async function openProfessionalPreview(bulletinId, opener) {
    const data = await requestBulletin(bulletinId);
    renderProfessionalPreview(data, opener);
    return true;
  }

  async function openAgentCompensation(employeeId, opener) {
    closeProfessionalPreview();
    if (typeof window.showPage === 'function') window.showPage('agents');
    await new Promise(resolve => setTimeout(resolve, 80));
    if (typeof window.openAgentModal === 'function') {
      await window.openAgentModal(Number(employeeId));
      await new Promise(resolve => setTimeout(resolve, 80));
      const salary = document.getElementById('ag-salaire-base');
      if (salary) {
        salary.scrollIntoView({ behavior: 'smooth', block: 'center' });
        salary.focus();
      }
      return true;
    }
    opener?.focus?.();
    return false;
  }

  async function openAgentFromBulletin(bulletinId, opener) {
    const data = await requestBulletin(bulletinId);
    return openAgentCompensation(data.employe.id, opener);
  }

  function ensureProfessionalStyles() {
    if (document.getElementById('payroll-professional-preview-style')) return;
    const style = document.createElement('style');
    style.id = 'payroll-professional-preview-style';
    style.textContent = `
      #payroll-professional-preview{width:min(900px,94vw);max-height:94vh;border:0;border-radius:12px;padding:0;box-shadow:0 24px 70px rgba(15,23,42,.28);color:#17233d}
      #payroll-professional-preview::backdrop{background:rgba(15,23,42,.48)}
      .payroll-preview-shell{padding:28px 32px 22px;background:#fff;overflow:auto;max-height:94vh}
      .payroll-preview-head{display:flex;justify-content:space-between;gap:24px;align-items:center;border-bottom:2px solid #123e78;padding-bottom:20px}
      .payroll-brand{font-size:25px;font-weight:800;color:#174fa8}.payroll-brand span{color:#f26a21}.payroll-muted{font-size:12px;color:#64748b;margin-top:3px}
      .payroll-preview-title{text-align:right}.payroll-preview-title h2{font-size:22px;color:#123e78;margin:0 0 4px}.payroll-preview-title div{font-size:12px;color:#64748b}
      .payroll-identity{display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #d9e0ea;padding:20px 0}.payroll-identity>div{padding-right:24px}.payroll-identity>div+div{border-left:1px solid #d9e0ea;padding:0 0 0 24px}.payroll-identity h3{font-size:11px;letter-spacing:.06em;color:#123e78;margin:0 0 10px}.payroll-identity dl{display:grid;grid-template-columns:140px 1fr;gap:7px;margin:0;font-size:12px}.payroll-identity dt{color:#64748b}.payroll-identity dd{margin:0;font-weight:600}
      .payroll-preview-table{width:100%;border-collapse:collapse;margin-top:20px;border:1px solid #d5dce7;font-size:12px}.payroll-preview-table th{background:#f8fafc;color:#123e78;text-align:left;padding:10px;border-bottom:1px solid #b9c5d6}.payroll-preview-table td{padding:9px 10px;border-bottom:1px solid #edf0f4}.payroll-preview-table .num{text-align:right}
      .payroll-summary{margin-top:10px}.payroll-summary>div{display:flex;justify-content:space-between;padding:9px 4px;border-bottom:1px solid #aebbd0;color:#123e78;font-weight:800;font-size:12px}.payroll-net{display:flex;justify-content:space-between;align-items:center;border-top:2px solid #f26a21;border-bottom:2px solid #f26a21;margin-top:8px;padding:13px 4px;color:#f05b14;font-weight:800}.payroll-net span{font-size:18px}.payroll-net strong{font-size:24px}
      .payroll-preview-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.payroll-preview-actions button{border:1px solid #cbd5e1;border-radius:8px;padding:9px 14px;background:#fff;cursor:pointer}.payroll-preview-actions .btn-primary{background:#174fa8;color:#fff;border-color:#174fa8}
      @media(max-width:700px){.payroll-preview-shell{padding:20px 16px}.payroll-preview-head{align-items:flex-start}.payroll-identity{grid-template-columns:1fr}.payroll-identity>div+div{border-left:0;border-top:1px solid #d9e0ea;padding:16px 0 0;margin-top:16px}.payroll-preview-title h2{font-size:17px}.payroll-identity dl{grid-template-columns:115px 1fr}}
    `;
    document.head.appendChild(style);
  }

  function installPayrollUxBridge() {
    if (window.__talaPayrollUxBridgeInstalled) return;
    window.__talaPayrollUxBridgeInstalled = true;
    ensureProfessionalStyles();
    document.addEventListener('click', event => {
      if (!isPayrollContext()) return;
      const button = event.target.closest?.('button,a');
      if (!button || button.closest('#payroll-professional-preview')) return;
      const label = String(button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const id = extractActionId(button);
      if (!id) return;
      if (/^(modifier|éditer|editer)$/.test(label) || label.includes('modifier le bulletin')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openAgentFromBulletin(id, button).catch(err => window.showToast?.(err.message || 'Impossible d’ouvrir le dossier rémunération', 'error'));
        return;
      }
      if (label.includes('aperçu') || label.includes('apercu') || label === 'bulletin de paie' || label.includes('voir bulletin')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openProfessionalPreview(id, button).catch(err => window.showToast?.(err.message || 'Impossible d’afficher le bulletin', 'error'));
      }
    }, true);
  }

  window.TalaPayrollCycle = { create, openProfessionalPreview, openAgentFromBulletin, openAgentCompensation };
  if (typeof document !== 'undefined') installPayrollUxBridge();
})();

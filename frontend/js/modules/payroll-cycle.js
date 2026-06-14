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

  window.TalaPayrollCycle = { create };
})();


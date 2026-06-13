(function () {
  'use strict';

  function create(options = {}) {
    const doc = options.document || window.document;
    const getRows = options.getRows || (() => []);
    const canRectify = options.canRectify || (() => false);
    const request = options.request;
    const confirmAction = options.confirmAction || (async () => false);
    const notify = options.notify || (() => {});
    const formatMoney = options.formatMoney || (value => String(value || 0));
    const reload = options.reload || (() => {});
    const monthNames = options.monthNames || [];
    let currentBulletinId = null;

    function byId(id) {
      return doc.getElementById(id);
    }

    function findRow(bulletinId) {
      return getRows().find(row => row.bulletin?.id === bulletinId) || null;
    }

    function setError(message = '') {
      const element = byId('rectif-error');
      if (!element) return;
      element.textContent = message;
      element.classList.toggle('hidden', !message);
    }

    function updatePreview() {
      const rawAmount = (byId('rectif-montant')?.value || '').replace(/\s/g, '').replace(',', '.');
      const amount = Number(rawAmount);
      const direction = byId('rectif-sens')?.value || 'credit_agent';
      const preview = byId('rectif-preview');
      if (!preview) return;

      if (!Number.isFinite(amount) || amount <= 0) {
        preview.textContent = 'Saisir un montant positif pour afficher l’impact.';
        preview.className = 'rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500';
        return;
      }

      const label = direction === 'credit_agent'
        ? 'Complément à payer à l’agent sur une prochaine paie'
        : 'Retenue/récupération sur une prochaine paie';
      preview.textContent = `${label} : ${formatMoney(amount)} XAF`;
      preview.className = direction === 'credit_agent'
        ? 'rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700'
        : 'rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700';
    }

    function open(bulletinId) {
      if (!canRectify()) {
        notify('Rôle RH, Finance, DG ou Admin requis', 'error');
        return false;
      }

      const row = findRow(bulletinId);
      const bulletin = row?.bulletin;
      if (!bulletin || bulletin.statut !== 'paye') {
        notify('Seul un bulletin payé peut faire l’objet d’une rectification', 'error');
        return false;
      }

      currentBulletinId = bulletinId;
      byId('rectif-agent').textContent = `${row.nom || ''} ${row.prenom || ''}`.trim() || '—';
      byId('rectif-periode').textContent =
        `${monthNames[bulletin.mois] || bulletin.mois || '—'} ${bulletin.annee || ''}`.trim();
      byId('rectif-net').textContent = `${formatMoney(bulletin.net_a_payer || 0)} XAF`;
      byId('rectif-type').value = 'erreur_prime';
      byId('rectif-sens').value = 'credit_agent';
      byId('rectif-montant').value = '';
      byId('rectif-motif').value = '';
      setError('');
      updatePreview();
      byId('modal-rectification-bulletin').classList.remove('hidden');
      return true;
    }

    function close() {
      byId('modal-rectification-bulletin').classList.add('hidden');
      currentBulletinId = null;
      setError('');
    }

    async function submit() {
      if (!currentBulletinId) return false;
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollRectifications: request adapter requis');
      }

      const type = byId('rectif-type').value;
      const direction = byId('rectif-sens').value;
      const rawAmount = (byId('rectif-montant').value || '').replace(/\s/g, '').replace(',', '.');
      const amount = Number(rawAmount);
      const reason = byId('rectif-motif').value.trim();

      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Montant de correction invalide.');
        return false;
      }
      if (!reason) {
        setError('Motif obligatoire.');
        return false;
      }

      const confirmed = await confirmAction(
        `Créer une rectification de ${formatMoney(amount)} XAF ?\n\nLe bulletin payé restera verrouillé. La correction sera appliquée via le workflow de rectification.`,
        'Confirmer la rectification',
        'Créer la rectification',
        'btn-warning'
      );
      if (!confirmed) return false;

      const button = byId('rectif-submit');
      if (button) {
        button.disabled = true;
        button.textContent = 'Création...';
      }

      try {
        const result = await request(`/salaires/bulletin/${currentBulletinId}/rectification`, {
          method: 'POST',
          body: JSON.stringify({ type, sens: direction, montant: amount, motif: reason })
        });
        if (!result) return false;
        close();
        notify('Rectification créée — en attente d’approbation', 'success');
        reload();
        return true;
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = 'Créer la rectification';
        }
      }
    }

    return {
      open,
      close,
      submit,
      updatePreview,
      setError,
      getCurrentBulletinId: () => currentBulletinId,
    };
  }

  window.TalaPayrollRectifications = { create };
})();


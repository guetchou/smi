(function () {
  'use strict';

  const TRANSIENT_FORM_IDS = [
    'enfant-form',
    'document-form',
    'diplome-form',
    'experience-form',
    'avance-form',
    'conge-form',
  ];

  const SUBFORM_TYPES = ['enfant', 'document', 'diplome', 'experience', 'avance', 'conge'];

  function create(options = {}) {
    const doc = options.document || window.document;

    function byId(id) {
      return doc.getElementById(id);
    }

    function value(id) {
      return byId(id)?.value?.trim() || '';
    }

    function checked(id) {
      return !!byId(id)?.checked;
    }

    function selectValue(id) {
      return byId(id)?.value || '';
    }

    function hasSubformDraft(type) {
      if (type === 'enfant') {
        return !!(value('enf-prenom') || value('enf-nom') || value('enf-dob') || checked('enf-sco'));
      }
      if (type === 'document') {
        return !!(value('doc-emission') || value('doc-expiration') || value('doc-observation') ||
          (selectValue('doc-type') && selectValue('doc-type') !== 'contrat_travail') ||
          (selectValue('doc-statut') && selectValue('doc-statut') !== 'valide'));
      }
      if (type === 'diplome') {
        return !!(value('dip-intitule') || value('dip-etablissement') || value('dip-observation') ||
          value('dip-annee') || (selectValue('dip-niveau') && selectValue('dip-niveau') !== 'autre'));
      }
      if (type === 'experience') {
        return !!(value('exp-poste') || value('exp-entreprise') || value('exp-debut') ||
          value('exp-fin') || value('exp-description') ||
          (selectValue('exp-type-contrat') && selectValue('exp-type-contrat') !== 'cdi'));
      }
      if (type === 'avance') {
        return !!(value('av-montant') || value('av-motif') || value('av-notes') ||
          (selectValue('av-echeances') && selectValue('av-echeances') !== '1'));
      }
      if (type === 'conge') {
        return !!(value('cg-debut') || value('cg-fin') || value('cg-motif') || value('cg-notes') ||
          (selectValue('cg-type') && selectValue('cg-type') !== 'annuel'));
      }
      return false;
    }

    function hasReimbursementDraft() {
      return [...doc.querySelectorAll('[id^="rmb-form-"]')].some(el => {
        if (el.classList.contains('hidden')) return false;
        return !!el.querySelector('input[type="number"]')?.value ||
          [...el.querySelectorAll('input[type="text"], textarea')].some(input => input.value.trim());
      });
    }

    function hasOnboardingAccountDraft() {
      const form = byId('ob-create-user-form');
      if (!form || form.classList.contains('hidden')) return false;
      const role = selectValue('ob-role-select') || 'lecteur';
      const email = value('ob-email-input');
      return !!(email || role !== 'lecteur');
    }

    function hasOpenWorkInProgress() {
      return SUBFORM_TYPES.some(hasSubformDraft) || hasReimbursementDraft() || hasOnboardingAccountDraft();
    }

    function resetFields(container) {
      container.querySelectorAll('input, textarea, select').forEach(field => {
        if (field.type === 'checkbox' || field.type === 'radio') field.checked = field.defaultChecked;
        else if (field.tagName === 'SELECT') field.selectedIndex = 0;
        else field.value = field.defaultValue || '';
      });
    }

    function resetTransientForms() {
      TRANSIENT_FORM_IDS.forEach(id => {
        const container = byId(id);
        if (!container) return;
        container.classList.add('hidden');
        resetFields(container);
      });
      doc.querySelectorAll('[id^="rmb-form-"]').forEach(form => {
        form.classList.add('hidden');
        form.querySelectorAll('input[type="number"], input[type="text"], textarea').forEach(field => { field.value = ''; });
      });
      const obForm = byId('ob-create-user-form');
      if (obForm) {
        obForm.classList.add('hidden');
        const role = byId('ob-role-select');
        const email = byId('ob-email-input');
        if (role) role.value = 'lecteur';
        if (email) email.value = '';
      }
    }

    return {
      value,
      checked,
      hasSubformDraft,
      hasOpenWorkInProgress,
      resetTransientForms,
    };
  }

  window.TalaAgentDossier = {
    SUBFORM_TYPES,
    TRANSIENT_FORM_IDS,
    create,
  };
})();

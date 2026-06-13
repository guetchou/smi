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
  const SUBFORM_ENDPOINTS = {
    enfant: 'enfants',
    document: 'documents',
    diplome: 'diplomes',
    experience: 'experiences',
    avance: 'avances',
    conge: 'conges',
  };

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const requestSalaryRevision = options.requestSalaryRevision;
    const confirmLeaveOverdraft = options.confirmLeaveOverdraft;
    const getLeaveBalance = options.getLeaveBalance || (() => null);
    const canForceLeave = options.canForceLeave || (() => false);
    let initialSalarySnapshot = { salaire_base: 0, prime_transport: 0, prime_logement: 0 };

    function byId(id) {
      return doc.getElementById(id);
    }

    function value(id) {
      return byId(id)?.value?.trim() || '';
    }

    function rawValue(id) {
      return byId(id)?.value || '';
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
        // Le niveau peut avoir une valeur par défaut.
        // Il ne doit pas, seul, transformer un sous-formulaire vide en diplôme à sauvegarder.
        return !!(value('dip-intitule') || value('dip-etablissement') || value('dip-observation') ||
          value('dip-annee'));
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

    function moneyValue(input) {
      const number = Number.parseFloat(input);
      return Number.isFinite(number) ? number : 0;
    }

    function integerValue(input, fallback = 0) {
      const number = Number.parseInt(input, 10);
      return Number.isFinite(number) ? number : fallback;
    }

    function setInitialSalarySnapshot(agent) {
      initialSalarySnapshot = {
        salaire_base: moneyValue(agent?.salaire_base),
        prime_transport: moneyValue(agent?.prime_transport),
        prime_logement: moneyValue(agent?.prime_logement),
      };
    }

    function readSalaryForm() {
      return {
        salaire_base: moneyValue(rawValue('ag-salaire-base')),
        prime_transport: moneyValue(rawValue('ag-prime-transport')),
        prime_logement: moneyValue(rawValue('ag-prime-logement')),
      };
    }

    function salaryChanged(currentSalary) {
      return ['salaire_base', 'prime_transport', 'prime_logement']
        .some(field => currentSalary[field] !== initialSalarySnapshot[field]);
    }

    function buildAgentPayload() {
      const salary = readSalaryForm();
      const payload = {
        matricule: rawValue('ag-matricule'),
        nom: value('ag-nom'),
        prenom: value('ag-prenom'),
        sexe: rawValue('ag-sexe'),
        date_naissance: rawValue('ag-date-naissance') || null,
        lieu_naissance: rawValue('ag-lieu-naissance'),
        nationalite: rawValue('ag-nationalite'),
        situation_matrimoniale: rawValue('ag-situation'),
        statut_dossier: rawValue('ag-statut-dossier'),
        telephone: rawValue('ag-telephone'),
        telephone2: rawValue('ag-telephone2'),
        email: rawValue('ag-email'),
        adresse: rawValue('ag-adresse'),
        type_piece_identite: rawValue('ag-type-piece-id'),
        num_piece_identite: rawValue('ag-num-piece-id'),
        date_expiration_identite: rawValue('ag-exp-piece-id') || null,
        poste: rawValue('ag-poste'),
        departement: rawValue('ag-departement'),
        site: rawValue('ag-site'),
        superieur_hierarchique: rawValue('ag-superieur'),
        type_contrat: rawValue('ag-type-contrat'),
        type: rawValue('ag-type'),
        date_embauche: rawValue('ag-date-embauche') || null,
        date_debut_contrat: rawValue('ag-date-debut-contrat') || null,
        date_fin_contrat: rawValue('ag-date-fin-contrat') || null,
        periode_essai_mois: integerValue(rawValue('ag-periode-essai')),
        date_fin_essai: rawValue('ag-date-fin-essai') || null,
        motif_sortie: rawValue('ag-motif-sortie'),
        date_sortie: rawValue('ag-date-sortie') || null,
        salaire_base: salary.salaire_base,
        prime_transport: salary.prime_transport,
        prime_logement: salary.prime_logement,
        mode_paiement: rawValue('ag-mode-paiement'),
        banque: rawValue('ag-banque'),
        numero_compte: rawValue('ag-numero-compte'),
      };
      if (!payload.nom || !payload.prenom) {
        return { ok: false, payload, salary, error: 'Nom et prénom obligatoires' };
      }
      return { ok: true, payload, salary, error: '' };
    }

    function buildSubformPayload(type, options = {}) {
      let payload;
      if (type === 'enfant') {
        payload = {
          prenom: value('enf-prenom'),
          nom: value('enf-nom'),
          date_naissance: rawValue('enf-dob') || null,
          sexe: rawValue('enf-sexe'),
          est_charge: checked('enf-charge') ? 1 : 0,
          scolarise: checked('enf-sco') ? 1 : 0,
        };
        if (!payload.prenom) return { ok: false, payload, error: 'Prénom enfant requis avant d’enregistrer l’agent' };
      } else if (type === 'document') {
        payload = {
          type_document: rawValue('doc-type'),
          statut: rawValue('doc-statut'),
          date_emission: rawValue('doc-emission') || null,
          date_expiration: rawValue('doc-expiration') || null,
          observation: rawValue('doc-observation'),
        };
      } else if (type === 'diplome') {
        payload = {
          intitule: value('dip-intitule'),
          etablissement: rawValue('dip-etablissement'),
          pays: rawValue('dip-pays'),
          annee_obtention: rawValue('dip-annee') || null,
          niveau: rawValue('dip-niveau'),
          observation: rawValue('dip-observation'),
        };
        if (!payload.intitule) {
          return { ok: false, payload, error: 'Intitulé du diplôme requis uniquement si vous ajoutez un diplôme avant d’enregistrer l’agent' };
        }
      } else if (type === 'experience') {
        payload = {
          poste: value('exp-poste'),
          entreprise: rawValue('exp-entreprise'),
          date_debut: rawValue('exp-debut') || null,
          date_fin: rawValue('exp-fin') || null,
          type_contrat: rawValue('exp-type-contrat'),
          description: rawValue('exp-description'),
        };
        if (!payload.poste) return { ok: false, payload, error: 'Poste expérience requis avant d’enregistrer l’agent' };
      } else if (type === 'avance') {
        payload = {
          date: rawValue('av-date'),
          montant: moneyValue(rawValue('av-montant')),
          motif: rawValue('av-motif'),
          nb_echeances: integerValue(rawValue('av-echeances'), 1) || 1,
          notes: rawValue('av-notes'),
        };
        if (!payload.date || payload.montant <= 0) {
          return { ok: false, payload, error: 'Date et montant avance requis avant d’enregistrer l’agent' };
        }
      } else if (type === 'conge') {
        const dateDebut = rawValue('cg-debut');
        const dateFin = rawValue('cg-fin');
        payload = {
          type_conge: rawValue('cg-type'),
          date_debut: dateDebut,
          date_fin: dateFin,
          force_creation: !!options.forceCreation,
          motif: rawValue('cg-motif'),
          notes: rawValue('cg-notes'),
        };
        if (!dateDebut || !dateFin) return { ok: false, payload, error: 'Dates congé requises avant d’enregistrer l’agent' };
        if (dateFin < dateDebut) return { ok: false, payload, error: 'Date fin congé antérieure à date début' };
        const days = Math.max(1, Math.round((new Date(dateFin) - new Date(dateDebut)) / 86400000) + 1);
        return { ok: true, payload, error: '', days };
      } else {
        return { ok: false, payload: null, error: `Sous-fiche agent inconnue: ${type}` };
      }
      return { ok: true, payload, error: '' };
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaAgentDossier: request adapter requis pour les sauvegardes');
      }
    }

    async function prepareLeaveForm() {
      let form = buildSubformPayload('conge');
      if (!form.ok) return form;

      const balance = getLeaveBalance();
      if (form.payload.type_conge !== 'annuel' || !balance || form.days <= balance.solde || !canForceLeave()) {
        return form;
      }
      if (typeof confirmLeaveOverdraft !== 'function') {
        return { ok: false, payload: form.payload, error: 'Confirmation du dépassement de congé indisponible' };
      }
      const confirmed = await confirmLeaveOverdraft({ available: balance.solde, requested: form.days });
      if (!confirmed) return { ok: false, cancelled: true, payload: form.payload, error: '' };
      return buildSubformPayload('conge', { forceCreation: true });
    }

    async function saveSubform(type, agentId) {
      requireRequest();
      const endpoint = SUBFORM_ENDPOINTS[type];
      if (!endpoint) return { ok: false, type, record: null, error: `Sous-fiche agent inconnue: ${type}` };

      const form = type === 'conge' ? await prepareLeaveForm() : buildSubformPayload(type);
      if (!form.ok) {
        return { ok: false, type, record: null, error: form.error, cancelled: !!form.cancelled };
      }
      const record = await request(`/agents/${agentId}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(form.payload),
      });
      if (!record?.id) return { ok: false, type, record: null, error: '', cancelled: false };
      return { ok: true, type, record, error: '', cancelled: false };
    }

    async function savePendingSubforms(agentId) {
      const saved = [];
      for (const type of SUBFORM_TYPES) {
        if (!hasSubformDraft(type)) continue;
        const result = await saveSubform(type, agentId);
        if (!result.ok) return { ...result, saved };
        saved.push({ type, record: result.record });
      }
      return { ok: true, saved, error: '', cancelled: false };
    }

    async function saveAgent() {
      requireRequest();
      const id = rawValue('agent-id');
      const form = buildAgentPayload();
      if (!form.ok) return { ok: false, error: form.error, cancelled: false, savedSubforms: [] };

      const payload = form.payload;
      if (id && salaryChanged(form.salary)) {
        if (typeof requestSalaryRevision !== 'function') {
          return { ok: false, error: 'Motif de révision de rémunération indisponible', cancelled: false, savedSubforms: [] };
        }
        const motif = await requestSalaryRevision();
        if (!motif) {
          return { ok: false, error: 'Motif obligatoire pour modifier la rémunération', cancelled: true, savedSubforms: [] };
        }
        payload.motif = motif;
        payload.type_revision = 'correction';
      }

      const response = await request(id ? `/agents/${id}` : '/agents', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      if (!(response && (response.id || response.ok || response.nom))) {
        return { ok: false, error: '', cancelled: false, savedSubforms: [] };
      }

      const agentId = id || response.id;
      const pending = agentId
        ? await savePendingSubforms(agentId)
        : { ok: true, saved: [], error: '', cancelled: false };
      if (!pending.ok) {
        return {
          ok: false,
          error: pending.error,
          cancelled: pending.cancelled,
          agentId,
          created: !id,
          response,
          savedSubforms: pending.saved,
        };
      }

      const employees = await request('/config/employes');
      return {
        ok: true,
        error: '',
        cancelled: false,
        agentId,
        created: !id,
        response,
        employees,
        savedSubforms: pending.saved,
      };
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
      rawValue,
      checked,
      moneyValue,
      setInitialSalarySnapshot,
      readSalaryForm,
      salaryChanged,
      buildAgentPayload,
      buildSubformPayload,
      saveAgent,
      savePendingSubforms,
      saveSubform,
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

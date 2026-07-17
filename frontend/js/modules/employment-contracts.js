(function () {
  'use strict';

  const STATUS = {
    brouillon: ['Brouillon', 'neutral'],
    en_verification: ['En verification', 'warning'],
    valide: ['Valide', 'info'],
    signe: ['Signe', 'success'],
    archive: ['Archive', 'neutral'],
    annule: ['Annule', 'danger'],
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function money(value) {
    if (value === null || value === undefined || value === '') return 'A verifier';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 'A verifier';
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(amount) + ' XAF';
  }

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const notify = options.notify || (() => {});
    const getToken = options.getToken || (() => '');
    const can = options.can || (() => false);
    const apiBase = options.apiBase || '/api';
    const state = { bootstrap: null, contracts: [], selected: null, activeTab: 'contracts', initialized: false };

    function byId(id) { return doc.getElementById(id); }

    function injectStyles() {
      if (byId('employment-contract-styles')) return;
      const style = doc.createElement('style');
      style.id = 'employment-contract-styles';
      style.textContent = `
        #page-employment-contracts{--ec-border:#d9e1ea;--ec-muted:#607086;--ec-ink:#172033;--ec-primary:#1a50d9;--ec-surface:#fff;--ec-soft:#f6f8fb;color:var(--ec-ink)}
        .ec-header,.ec-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.ec-heading{font-size:18px;font-weight:700}.ec-subtitle{font-size:12px;color:var(--ec-muted);margin-top:3px}.ec-actions,.ec-filters,.ec-tabs{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ec-btn{min-height:36px;border:1px solid var(--ec-border);border-radius:6px;background:#fff;color:#26364a;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer}.ec-btn:hover{background:#f3f6fa}.ec-btn:disabled{opacity:.5;cursor:not-allowed}.ec-btn-primary{background:var(--ec-primary);border-color:var(--ec-primary);color:#fff}.ec-btn-primary:hover{background:#1545b5}.ec-btn-danger{color:#b42318;border-color:#f3b7b2;background:#fff8f7}.ec-icon-btn{width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:18px}.ec-tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:9px 3px;color:var(--ec-muted);font-size:13px;font-weight:600;cursor:pointer}.ec-tab.is-active{border-color:var(--ec-primary);color:var(--ec-primary)}.ec-filter{height:36px;border:1px solid var(--ec-border);border-radius:6px;background:#fff;padding:0 10px;font-size:13px;max-width:240px}.ec-table-wrap{background:var(--ec-surface);border:1px solid var(--ec-border);border-radius:8px;overflow:auto;max-height:68vh}.ec-table{width:100%;border-collapse:collapse;min-width:850px;font-size:13px}.ec-table th{position:sticky;top:0;background:#f3f6fa;color:#55657a;font-size:11px;text-transform:uppercase;text-align:left;padding:10px 12px;border-bottom:1px solid var(--ec-border);z-index:1}.ec-table td{padding:11px 12px;border-bottom:1px solid #edf1f5;vertical-align:middle}.ec-table tr:hover td{background:#fafbfd}.ec-ref{font-weight:700;color:#173b66}.ec-muted{color:var(--ec-muted);font-size:12px}.ec-badge{display:inline-flex;padding:3px 8px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap}.ec-badge-neutral{background:#edf1f5;color:#46566b}.ec-badge-warning{background:#fff2d6;color:#8a4b08}.ec-badge-info{background:#e9f0ff;color:#1749b6}.ec-badge-success{background:#e5f6eb;color:#146c37}.ec-badge-danger{background:#feeceb;color:#a82a22}.ec-empty{padding:48px 18px;text-align:center;color:var(--ec-muted)}.ec-dialog{width:min(980px,calc(100vw - 24px));max-height:calc(100dvh - 24px);border:0;border-radius:8px;padding:0;box-shadow:0 24px 70px rgba(15,23,42,.28)}.ec-dialog::backdrop{background:rgba(15,23,42,.52)}.ec-dialog-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 24px)}.ec-dialog-head,.ec-dialog-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--ec-border);background:#fff}.ec-dialog-foot{border-top:1px solid var(--ec-border);border-bottom:0;justify-content:flex-end}.ec-dialog-body{padding:18px;overflow:auto;background:var(--ec-soft)}.ec-step-nav{display:flex;gap:6px;margin-bottom:16px;overflow:auto}.ec-step{border:1px solid var(--ec-border);background:#fff;border-radius:6px;padding:8px 12px;white-space:nowrap;font-size:12px;color:var(--ec-muted)}.ec-step.is-active{border-color:var(--ec-primary);color:var(--ec-primary);background:#eef3ff}.ec-form-section{background:#fff;border:1px solid var(--ec-border);border-radius:8px;padding:16px}.ec-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.ec-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}.ec-field{display:flex;flex-direction:column;gap:5px;min-width:0}.ec-field label{font-size:12px;font-weight:650;color:#42536a}.ec-field input,.ec-field select,.ec-field textarea{width:100%;border:1px solid var(--ec-border);border-radius:6px;padding:8px 10px;font-size:13px;background:#fff}.ec-field textarea{min-height:76px;resize:vertical}.ec-field-wide{grid-column:1/-1}.ec-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px}.ec-metric{border:1px solid var(--ec-border);background:#fff;border-radius:8px;padding:12px}.ec-metric-label{font-size:11px;color:var(--ec-muted)}.ec-metric-value{font-size:16px;font-weight:750;margin-top:4px}.ec-alert{border:1px solid #efc78e;background:#fff8e8;color:#75420a;border-radius:6px;padding:10px 12px;font-size:12px;line-height:1.5}.ec-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ec-panel{border:1px solid var(--ec-border);border-radius:8px;background:#fff;padding:14px}.ec-panel h3{font-size:13px;font-weight:700;margin:0 0 10px}.ec-kv{display:grid;grid-template-columns:140px 1fr;gap:5px 10px;font-size:12px}.ec-kv dt{color:var(--ec-muted)}.ec-kv dd{margin:0;font-weight:600;overflow-wrap:anywhere}.ec-loading{display:inline-block;width:16px;height:16px;border:2px solid #c7d2e3;border-top-color:var(--ec-primary);border-radius:50%;animation:ec-spin .7s linear infinite}@keyframes ec-spin{to{transform:rotate(360deg)}}
        @media(max-width:768px){.ec-grid,.ec-grid-3,.ec-detail-grid{grid-template-columns:1fr}.ec-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.ec-dialog{width:calc(100vw - 12px);max-height:calc(100dvh - 12px)}.ec-dialog-shell{max-height:calc(100dvh - 12px)}.ec-dialog-body{padding:12px}.ec-filter{max-width:100%;flex:1 1 150px}}
        @media(max-width:360px){.ec-summary{grid-template-columns:1fr}.ec-actions{width:100%}.ec-actions .ec-btn{flex:1}.ec-heading{font-size:16px}}
      `;
      doc.head.appendChild(style);
    }

    function shell() {
      return `<div class="ec-header"><div><div class="ec-heading">Contrats de travail</div><div class="ec-subtitle">Preparation, controle, validation et documents contractuels versionnes</div></div><div class="ec-actions"><button class="ec-btn" type="button" data-ec-refresh>Actualiser</button>${can('employment_contract.create') ? '<button class="ec-btn ec-btn-primary" type="button" data-ec-create>Nouveau contrat</button>' : ''}</div></div>
        <div class="ec-toolbar"><div class="ec-tabs"><button class="ec-tab is-active" data-ec-tab="contracts">Contrats</button><button class="ec-tab" data-ec-tab="references">Modeles et regles</button></div><div class="ec-filters" data-ec-contract-filters><input class="ec-filter" id="ec-search" type="search" placeholder="Reference, agent, matricule"><select class="ec-filter" id="ec-status"><option value="">Tous les statuts</option>${Object.keys(STATUS).map(key => `<option value="${key}">${STATUS[key][0]}</option>`).join('')}</select></div></div>
        <div id="ec-content"><div class="ec-empty"><span class="ec-loading" aria-label="Chargement"></span></div></div>`;
    }

    function statusBadge(status) {
      const config = STATUS[status] || [status || 'Inconnu', 'neutral'];
      return `<span class="ec-badge ec-badge-${config[1]}">${escapeHtml(config[0])}</span>`;
    }

    function renderContracts() {
      const mount = byId('ec-content');
      if (!mount) return;
      if (!state.contracts.length) {
        mount.innerHTML = '<div class="ec-table-wrap"><div class="ec-empty">Aucun contrat ne correspond aux filtres.</div></div>';
        return;
      }
      mount.innerHTML = `<div class="ec-table-wrap"><table class="ec-table"><thead><tr><th>Reference</th><th>Agent</th><th>Type</th><th>Periode</th><th>Version</th><th>Statut</th><th>Action</th></tr></thead><tbody>${state.contracts.map(contract => `<tr><td><div class="ec-ref">${escapeHtml(contract.reference)}</div><div class="ec-muted">${escapeHtml(contract.intitule)}</div></td><td>${escapeHtml(contract.agent_nom)} ${escapeHtml(contract.agent_prenom)}<div class="ec-muted">${escapeHtml(contract.agent_matricule || '')}</div></td><td>${escapeHtml(String(contract.type_contrat || '').toUpperCase())}</td><td>${escapeHtml(contract.date_debut || '')}<div class="ec-muted">${escapeHtml(contract.date_fin || 'Sans terme')}</div></td><td>v${Number(contract.version || 1)}</td><td>${statusBadge(contract.statut)}</td><td><button class="ec-btn" type="button" data-ec-open="${Number(contract.id)}">Ouvrir</button></td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderReferences() {
      const mount = byId('ec-content');
      const templates = state.bootstrap?.templates || [];
      const rules = state.bootstrap?.ruleSets || [];
      mount.innerHTML = `<div class="ec-detail-grid"><section class="ec-panel"><h3>Modeles publies</h3>${templates.length ? `<div class="ec-table-wrap"><table class="ec-table" style="min-width:520px"><thead><tr><th>Code</th><th>Modele</th><th>Version</th><th>Type</th></tr></thead><tbody>${templates.map(item => `<tr><td class="ec-ref">${escapeHtml(item.code)}</td><td>${escapeHtml(item.nom)}</td><td>v${Number(item.version)}</td><td>${escapeHtml(item.type_contrat)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ec-alert">Aucun modele publie. Importer le modele source, puis le faire valider juridiquement avant publication.</div>'}</section><section class="ec-panel"><h3>Jeux de regles publies</h3>${rules.length ? `<div class="ec-table-wrap"><table class="ec-table" style="min-width:520px"><thead><tr><th>Code</th><th>Libelle</th><th>Effet</th><th>Version</th></tr></thead><tbody>${rules.map(item => `<tr><td class="ec-ref">${escapeHtml(item.code)}</td><td>${escapeHtml(item.libelle)}</td><td>${escapeHtml(item.date_effet)}</td><td>v${Number(item.version)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="ec-alert">Aucun jeu de regles publie. Les calculs sociaux et fiscaux restent volontairement bloques.</div>'}</section></div>`;
    }

    async function loadBootstrap() {
      state.bootstrap = await request('/api/employment-contracts/bootstrap', { noCache: true });
      return state.bootstrap;
    }

    async function loadContracts() {
      const search = byId('ec-search')?.value?.trim() || '';
      const status = byId('ec-status')?.value || '';
      const query = new URLSearchParams({ limit: '100' });
      if (search) query.set('search', search);
      if (status) query.set('status', status);
      const data = await request(`/api/employment-contracts?${query}`, { noCache: true });
      state.contracts = data?.contracts || [];
      renderContracts();
    }

    function ensureDialog() {
      let dialog = byId('ec-dialog');
      if (dialog) return dialog;
      dialog = doc.createElement('dialog');
      dialog.id = 'ec-dialog';
      dialog.className = 'ec-dialog';
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        if (dialog.dataset.dirty === '1' && !doc.defaultView.confirm('Abandonner les modifications non enregistrees ?')) return;
        dialog.close();
      });
      doc.body.appendChild(dialog);
      return dialog;
    }

    function createForm(existingContract = null) {
      const bootstrap = state.bootstrap || { agents: [], templates: [], ruleSets: [] };
      const existingInput = existingContract?.values_snapshot?._input || {};
      const isEditing = Boolean(existingContract?.id);
      const dialog = ensureDialog();
      dialog.dataset.dirty = '0';
      dialog.innerHTML = `<form method="dialog" class="ec-dialog-shell" id="ec-contract-form"><div class="ec-dialog-head"><div><div class="ec-heading">${isEditing ? 'Corriger le brouillon' : 'Nouveau contrat'}</div><div class="ec-subtitle">Les donnees inconnues bloquent la soumission.</div></div><button class="ec-btn ec-icon-btn" value="cancel" aria-label="Fermer" title="Fermer">&times;</button></div><div class="ec-dialog-body">
        ${!bootstrap.templates.length || !bootstrap.ruleSets.length ? '<div class="ec-alert" style="margin-bottom:14px">Un modele et un jeu de regles publies sont obligatoires avant creation.</div>' : ''}
        <div class="ec-step-nav" role="tablist"><button type="button" class="ec-step is-active" data-ec-step="1">1. Agent et modele</button><button type="button" class="ec-step" data-ec-step="2">2. Conditions</button><button type="button" class="ec-step" data-ec-step="3">3. Remuneration</button></div>
        <section class="ec-form-section" data-ec-panel="1"><div class="ec-grid"><div class="ec-field"><label for="ec-agent">Agent</label><select id="ec-agent" required><option value="">Selectionner</option>${bootstrap.agents.map(agent => `<option value="${agent.id}" data-base="${Number(agent.salaire_base || 0)}" data-transport="${Number(agent.prime_transport || 0)}" data-logement="${Number(agent.prime_logement || 0)}" data-poste="${escapeHtml(agent.poste || '')}" data-type="${escapeHtml(agent.type_contrat || 'cdd')}">${escapeHtml(agent.matricule || '')} - ${escapeHtml(agent.nom)} ${escapeHtml(agent.prenom)}</option>`).join('')}</select></div><div class="ec-field"><label for="ec-template">Modele publie</label><select id="ec-template" required><option value="">Selectionner</option>${bootstrap.templates.map(item => `<option value="${item.id}" data-type="${escapeHtml(item.type_contrat)}">${escapeHtml(item.nom)} - v${Number(item.version)}</option>`).join('')}</select></div><div class="ec-field"><label for="ec-rules">Regles sociales et fiscales</label><select id="ec-rules" required><option value="">Selectionner</option>${bootstrap.ruleSets.map(item => `<option value="${item.id}">${escapeHtml(item.libelle)} - v${Number(item.version)}</option>`).join('')}</select></div><div class="ec-field"><label for="ec-title">Intitule</label><input id="ec-title" required value="Contrat de travail"></div></div></section>
        <section class="ec-form-section" data-ec-panel="2" hidden><div class="ec-grid ec-grid-3"><div class="ec-field"><label for="ec-type">Type</label><select id="ec-type"><option value="CDD">CDD</option><option value="CDI">CDI</option><option value="stage">Stage</option><option value="consultant">Consultant</option></select></div><div class="ec-field"><label for="ec-start">Date de debut</label><input id="ec-start" type="date" required></div><div class="ec-field"><label for="ec-end">Date de fin</label><input id="ec-end" type="date"></div><div class="ec-field"><label for="ec-duration">Duree</label><input id="ec-duration" type="number" min="1" value="6"></div><div class="ec-field"><label for="ec-unit">Unite</label><select id="ec-unit"><option value="mois">Mois</option><option value="jour">Jours</option><option value="annee">Annees</option></select></div><div class="ec-field"><label for="ec-convention">Convention date fin</label><select id="ec-convention"><option value="inclusive">Date incluse</option><option value="exclusive">Date exclue</option></select></div><div class="ec-field"><label for="ec-job">Fonction</label><input id="ec-job" required></div><div class="ec-field"><label for="ec-classification">Classification</label><input id="ec-classification"></div><div class="ec-field"><label for="ec-service">Service</label><input id="ec-service" required></div><div class="ec-field"><label for="ec-place">Lieu de travail</label><input id="ec-place" value="Brazzaville" required></div><div class="ec-field"><label for="ec-hours">Heures par semaine</label><input id="ec-hours" type="number" min="1" max="80" value="40" required></div><div class="ec-field"><label for="ec-schedule">Horaires</label><input id="ec-schedule" required></div><div class="ec-field"><label for="ec-trial">Periode d'essai (mois)</label><input id="ec-trial" type="number" min="0" value="1"></div><div class="ec-field ec-field-wide"><label for="ec-tasks">Missions principales, une par ligne</label><textarea id="ec-tasks" maxlength="4000"></textarea></div></div></section>
        <section class="ec-form-section" data-ec-panel="3" hidden><div class="ec-grid ec-grid-3"><div class="ec-field"><label for="ec-base">Salaire de base</label><input id="ec-base" type="number" min="0" required></div><div class="ec-field"><label for="ec-transport">Indemnite transport</label><input id="ec-transport" type="number" min="0" value="0"></div><div class="ec-field"><label for="ec-housing">Indemnite logement</label><input id="ec-housing" type="number" min="0" value="0"></div><div class="ec-field"><label for="ec-marital">Situation matrimoniale</label><select id="ec-marital"><option value="celibataire">Celibataire</option><option value="marie">Marie(e)</option><option value="divorce">Divorce(e)</option><option value="veuf">Veuf/veuve</option></select></div><div class="ec-field"><label for="ec-dependents">Personnes a charge</label><input id="ec-dependents" type="number" min="0" value="0"></div><div class="ec-field"><label for="ec-parts">Parts fiscales validees</label><input id="ec-parts" type="number" min="0.5" step="0.5" value="1"></div><div class="ec-field ec-field-wide"><label for="ec-local-clause">Dispositions particulieres</label><textarea id="ec-local-clause" maxlength="5000" placeholder="Clauses propres a ce contrat, sans modifier le modele publie"></textarea></div></div><div class="ec-alert" style="margin-top:14px">Les cases de soumission sociale et fiscale sont definies par rubrique. Aucun taux n'est saisi dans ce formulaire.</div></section>
        </div><div class="ec-dialog-foot"><button class="ec-btn" value="cancel">Annuler</button><button class="ec-btn" type="button" id="ec-prev" disabled>Precedent</button><button class="ec-btn" type="button" id="ec-next">Suivant</button><button class="ec-btn ec-btn-primary" type="submit" id="ec-save" hidden ${!bootstrap.templates.length || !bootstrap.ruleSets.length ? 'disabled' : ''}>${isEditing ? 'Enregistrer les corrections' : 'Enregistrer le brouillon'}</button></div></form>`;
      let step = 1;
      const setStep = next => {
        step = Math.max(1, Math.min(3, next));
        dialog.querySelectorAll('[data-ec-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.ecPanel) !== step; });
        dialog.querySelectorAll('[data-ec-step]').forEach(button => button.classList.toggle('is-active', Number(button.dataset.ecStep) === step));
        byId('ec-prev').disabled = step === 1;
        byId('ec-next').hidden = step === 3;
        byId('ec-save').hidden = step !== 3;
      };
      dialog.querySelectorAll('[data-ec-step]').forEach(button => button.addEventListener('click', () => setStep(Number(button.dataset.ecStep))));
      byId('ec-prev').addEventListener('click', () => setStep(step - 1));
      byId('ec-next').addEventListener('click', () => setStep(step + 1));
      byId('ec-agent').addEventListener('change', event => {
        const selected = event.target.selectedOptions[0];
        byId('ec-base').value = selected?.dataset.base || 0;
        byId('ec-transport').value = selected?.dataset.transport || 0;
        byId('ec-housing').value = selected?.dataset.logement || 0;
        byId('ec-job').value = selected?.dataset.poste || '';
      });
      byId('ec-template').addEventListener('change', event => { if (event.target.selectedOptions[0]?.dataset.type) byId('ec-type').value = event.target.selectedOptions[0].dataset.type.toUpperCase(); });
      byId('ec-contract-form').addEventListener('submit', async event => {
        if (event.submitter?.value === 'cancel') return;
        event.preventDefault();
        if (!event.currentTarget.reportValidity()) return;
        const saveButton = byId('ec-save');
        saveButton.disabled = true;
        saveButton.setAttribute('aria-busy', 'true');
        const payload = formPayload();
        try {
          const result = await request(isEditing ? `/api/employment-contracts/${existingContract.id}` : '/api/employment-contracts', { method: isEditing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
          if (!result?.id) return;
          dialog.dataset.dirty = '0';
          dialog.close();
          notify(result.readyToSubmit ? 'Brouillon complet enregistre' : `Brouillon enregistre avec ${result.validationErrors?.length || 0} controle(s) a traiter`, result.readyToSubmit ? 'success' : 'warning');
          await loadContracts();
        } finally {
          saveButton.disabled = false;
          saveButton.removeAttribute('aria-busy');
        }
      });
      if (isEditing) {
        const setValue = (id, value) => { if (byId(id) && value !== null && value !== undefined) byId(id).value = value; };
        const components = new Map((existingInput.components || []).map(item => [item.code, item]));
        setValue('ec-agent', existingInput.employeId);
        byId('ec-agent').disabled = true;
        setValue('ec-template', existingInput.templateVersionId);
        setValue('ec-rules', existingInput.payrollRuleSetId);
        setValue('ec-title', existingInput.intitule);
        setValue('ec-type', existingInput.typeContrat);
        setValue('ec-start', existingInput.dateDebut);
        setValue('ec-end', existingInput.dateFin || '');
        setValue('ec-duration', existingInput.dureeValeur);
        setValue('ec-unit', existingInput.dureeUnite);
        setValue('ec-convention', existingInput.dateEndConvention);
        setValue('ec-job', existingInput.fonction);
        setValue('ec-classification', existingInput.classification);
        setValue('ec-service', existingInput.service);
        setValue('ec-place', existingInput.lieuTravail);
        setValue('ec-hours', existingInput.tempsTravailHebdomadaire);
        setValue('ec-schedule', existingInput.horaires);
        setValue('ec-trial', existingInput.periodeEssaiValeur);
        setValue('ec-tasks', (existingInput.tasks || []).join('\n'));
        setValue('ec-base', components.get('BASE')?.amount ?? 0);
        setValue('ec-transport', components.get('TRANSPORT')?.amount ?? 0);
        setValue('ec-housing', components.get('LOGEMENT')?.amount ?? 0);
        setValue('ec-marital', existingInput.employeeTaxProfile?.maritalStatus);
        setValue('ec-dependents', existingInput.employeeTaxProfile?.dependents);
        setValue('ec-parts', existingInput.employeeTaxProfile?.fiscalParts);
        setValue('ec-local-clause', existingInput.localClause || '');
      }
      byId('ec-contract-form').addEventListener('input', () => { dialog.dataset.dirty = '1'; });
      byId('ec-contract-form').addEventListener('click', event => {
        if (event.target.closest('[value="cancel"]') && dialog.dataset.dirty === '1' && !doc.defaultView.confirm('Abandonner les modifications non enregistrees ?')) {
          event.preventDefault();
        }
      });
      dialog.showModal();
      byId('ec-agent').focus();
    }

    function formPayload() {
      const component = (code, label, category, field, socialSubject, taxSubject) => ({ code, label, category, amount: Number(byId(field).value || 0), includeInGross: true, socialSubject, taxSubject, displayOnContract: true });
      return {
        employeId: Number(byId('ec-agent').value), templateVersionId: Number(byId('ec-template').value), payrollRuleSetId: Number(byId('ec-rules').value),
        typeContrat: byId('ec-type').value, intitule: byId('ec-title').value.trim(), dateDebut: byId('ec-start').value, dateFin: byId('ec-end').value || null,
        dureeValeur: Number(byId('ec-duration').value || 0) || null, dureeUnite: byId('ec-unit').value, dateEndConvention: byId('ec-convention').value,
        periodeEssaiValeur: Number(byId('ec-trial').value || 0) || null, periodeEssaiUnite: 'mois', fonction: byId('ec-job').value.trim(), classification: byId('ec-classification').value.trim(), service: byId('ec-service').value.trim(), lieuTravail: byId('ec-place').value.trim(),
        tempsTravailHebdomadaire: Number(byId('ec-hours').value), horaires: byId('ec-schedule').value.trim(), employeeTaxProfile: { maritalStatus: byId('ec-marital').value, dependents: Number(byId('ec-dependents').value), fiscalParts: Number(byId('ec-parts').value) },
        tasks: byId('ec-tasks').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean), localClause: byId('ec-local-clause').value.trim(),
        components: [component('BASE', 'Salaire de base', 'salaire_base', 'ec-base', true, true), component('TRANSPORT', 'Indemnite transport', 'indemnite', 'ec-transport', false, false), component('LOGEMENT', 'Indemnite logement', 'indemnite', 'ec-housing', true, true)],
      };
    }

    async function openContract(id) {
      const contract = await request(`/api/employment-contracts/${id}`, { noCache: true });
      if (!contract) return;
      state.selected = contract;
      const remuneration = contract.remuneration_snapshot || {};
      const errors = contract.validation_errors_json || [];
      const actions = [];
      if (contract.statut === 'brouillon' && can('employment_contract.create')) actions.push('<button class="ec-btn" type="button" data-ec-action="edit">Modifier</button>');
      if (contract.statut === 'brouillon' && can('employment_contract.submit')) actions.push('<button class="ec-btn ec-btn-primary" type="button" data-ec-action="submit">Soumettre</button>');
      if (contract.statut === 'en_verification' && can('employment_contract.validate')) actions.push('<button class="ec-btn" type="button" data-ec-action="return">Retourner</button><button class="ec-btn ec-btn-primary" type="button" data-ec-action="validate">Valider</button>');
      if (contract.statut === 'valide' && can('employment_contract.generate')) actions.push('<button class="ec-btn" type="button" data-ec-action="docx">Generer Word</button><button class="ec-btn" type="button" data-ec-action="pdf">Generer PDF</button>');
      if (contract.statut === 'valide' && can('employment_contract.validate')) actions.push('<button class="ec-btn ec-btn-primary" type="button" data-ec-action="sign">Marquer signe</button>');
      if (['signe', 'archive'].includes(contract.statut) && can('employment_contract.generate')) actions.push('<button class="ec-btn" type="button" data-ec-action="docx">Word</button><button class="ec-btn" type="button" data-ec-action="pdf">PDF</button>');
      if (['signe', 'archive'].includes(contract.statut) && can('employment_contract.create')) actions.push('<button class="ec-btn" type="button" data-ec-action="revise">Creer un avenant</button>');
      if (contract.statut === 'signe' && can('employment_contract.validate')) actions.push('<button class="ec-btn" type="button" data-ec-action="archive">Archiver</button>');
      if (['brouillon', 'en_verification', 'valide'].includes(contract.statut) && can('employment_contract.validate')) actions.push('<button class="ec-btn ec-btn-danger" type="button" data-ec-action="cancel">Annuler</button>');
      const dialog = ensureDialog();
      dialog.dataset.dirty = '0';
      dialog.innerHTML = `<div class="ec-dialog-shell"><div class="ec-dialog-head"><div><div class="ec-heading">${escapeHtml(contract.reference)}</div><div class="ec-subtitle">${escapeHtml(contract.agent_matricule || '')} - ${escapeHtml(contract.agent_nom)} ${escapeHtml(contract.agent_prenom)}</div></div><button class="ec-btn ec-icon-btn" type="button" data-ec-close aria-label="Fermer" title="Fermer">&times;</button></div><div class="ec-dialog-body"><div class="ec-summary"><div class="ec-metric"><div class="ec-metric-label">Statut</div><div class="ec-metric-value">${statusBadge(contract.statut)}</div></div><div class="ec-metric"><div class="ec-metric-label">Brut</div><div class="ec-metric-value">${money(remuneration.grossTotal)}</div></div><div class="ec-metric"><div class="ec-metric-label">Net indicatif</div><div class="ec-metric-value">${money(remuneration.netPayable)}</div></div><div class="ec-metric"><div class="ec-metric-label">Version</div><div class="ec-metric-value">v${Number(contract.version)}</div></div></div>${errors.length ? `<div class="ec-alert" style="margin-bottom:14px"><strong>Controles bloquants</strong><br>${errors.map(escapeHtml).join('<br>')}</div>` : ''}<div class="ec-detail-grid"><section class="ec-panel"><h3>Conditions</h3><dl class="ec-kv"><dt>Type</dt><dd>${escapeHtml(contract.type_contrat)}</dd><dt>Fonction</dt><dd>${escapeHtml(contract.fonction || '')}</dd><dt>Debut</dt><dd>${escapeHtml(contract.date_debut)}</dd><dt>Fin</dt><dd>${escapeHtml(contract.date_fin || 'Sans terme')}</dd><dt>Modele</dt><dd>${escapeHtml(contract.template_title)} v${Number(contract.template_version)}</dd></dl></section><section class="ec-panel"><h3>Documents archives</h3>${contract.documents?.length ? contract.documents.map(document => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #edf1f5"><span>${escapeHtml(document.filename)}</span><button class="ec-btn" data-ec-download="${document.id}">Telecharger</button></div>`).join('') : '<div class="ec-muted">Aucun document genere</div>'}</section></div></div><div class="ec-dialog-foot">${actions.join('')}<button class="ec-btn" type="button" data-ec-close>Fermer</button></div></div>`;
      dialog.querySelectorAll('[data-ec-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
      dialog.querySelectorAll('[data-ec-action]').forEach(button => button.addEventListener('click', () => contractAction(button.dataset.ecAction)));
      dialog.querySelectorAll('[data-ec-download]').forEach(button => button.addEventListener('click', () => download(`/api/employment-contracts/${contract.id}/documents/${button.dataset.ecDownload}/download`, `contrat_${contract.reference}`)));
      dialog.showModal();
    }

    async function contractAction(action) {
      const contract = state.selected;
      if (!contract) return;
      if (action === 'edit') {
        ensureDialog().close();
        createForm(contract);
        return;
      }
      let path = action;
      let body = {};
      if (['return', 'cancel'].includes(action)) {
        const reason = window.prompt(action === 'return' ? 'Motif du retour au brouillon' : 'Motif de l’annulation');
        if (!reason?.trim()) return;
        body = { reason: reason.trim() };
      }
      if (['docx', 'pdf'].includes(action)) {
        const generated = await request(`/api/employment-contracts/${contract.id}/documents/${action}`, { method: 'POST', body: '{}' });
        if (generated?.downloadUrl) await download(generated.downloadUrl, generated.filename);
        return;
      }
      const result = await request(`/api/employment-contracts/${contract.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      if (!result) return;
      notify(action === 'revise' ? 'Avenant cree en brouillon' : 'Statut du contrat mis a jour', 'success');
      ensureDialog().close();
      await loadContracts();
    }

    async function download(url, filename) {
      const response = await window.fetch(url.startsWith('http') ? url : apiBase.replace(/\/api$/, '') + url, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!response.ok) return notify('Telechargement impossible', 'error');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = objectUrl;
      link.download = filename || 'contrat';
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
    }

    async function init() {
      const root = byId('page-employment-contracts');
      if (!root) return;
      injectStyles();
      if (!state.initialized) {
        root.innerHTML = shell();
        root.addEventListener('click', event => {
          const createButton = event.target.closest('[data-ec-create]');
          const refreshButton = event.target.closest('[data-ec-refresh]');
          const openButton = event.target.closest('[data-ec-open]');
          const tabButton = event.target.closest('[data-ec-tab]');
          if (createButton) createForm();
          if (refreshButton) refresh();
          if (openButton) openContract(Number(openButton.dataset.ecOpen));
          if (tabButton) {
            state.activeTab = tabButton.dataset.ecTab;
            root.querySelectorAll('[data-ec-tab]').forEach(button => button.classList.toggle('is-active', button === tabButton));
            root.querySelector('[data-ec-contract-filters]').style.display = state.activeTab === 'contracts' ? '' : 'none';
            state.activeTab === 'contracts' ? renderContracts() : renderReferences();
          }
        });
        root.addEventListener('change', event => { if (event.target.matches('#ec-status')) loadContracts(); });
        root.addEventListener('input', event => { if (event.target.matches('#ec-search')) { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(loadContracts, 250); } });
        state.initialized = true;
      }
      await refresh();
    }

    async function refresh() {
      await Promise.all([loadBootstrap(), loadContracts()]);
      if (state.activeTab === 'references') renderReferences();
    }

    return { init, refresh, openContract, escapeHtml };
  }

  window.TalaEmploymentContracts = { create, escapeHtml };
})();

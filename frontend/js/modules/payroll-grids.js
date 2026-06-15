(function () {
  'use strict';

  const STATUS_LABELS = { brouillon: 'Brouillon', soumis: 'Soumis', valide: 'Validé DG', archive: 'Archivé' };
  const STATUS_COLORS = {
    brouillon: 'bg-slate-100 text-slate-600',
    soumis: 'bg-amber-100 text-amber-700',
    valide: 'bg-emerald-100 text-emerald-700',
    archive: 'bg-slate-200 text-slate-500',
  };

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const notify = options.notify || (() => {});
    const confirmAction = options.confirmAction || window.confirm.bind(window);
    const hasAnyRole = options.hasAnyRole || (() => false);
    const isAdmin = options.isAdmin || (() => false);
    const reloadAgentGrid = options.reloadAgentGrid || (() => {});

    let grids = [];
    let drawerData = null;
    let drawerCategoryId = null;
    let echelonsCache = [];
    let agentGridsCache = null;

    function byId(id) {
      return doc.getElementById(id);
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollGrids: request adapter requis');
      }
    }

    function badge(status) {
      const classes = STATUS_COLORS[status] || 'bg-slate-100 text-slate-500';
      return `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${classes}">${STATUS_LABELS[status] || status}</span>`;
    }

    function numberValue(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      if (value === null || value === undefined || value === '') return 0;
      const normalized = String(value)
        .replace(/\u202f/g, '')
        .replace(/\s/g, '')
        .replace(',', '.')
        .replace(/[^\d.-]/g, '');
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function money(value) {
      return numberValue(value).toLocaleString('fr-FR');
    }

    async function load() {
      requireRequest();
      const data = await request('/grilles');
      grids = Array.isArray(data) ? data : (data?.grilles || []);
      render(grids);
      byId('btn-new-grille')?.classList.toggle('hidden', !hasAnyRole('admin', 'rh', 'finance', 'dg'));
      return grids;
    }

    function render(list) {
      const tbody = byId('grilles-tbody');
      if (!tbody) return;
      if (!list || !list.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-slate-400 text-sm">Aucune grille salariale enregistrée</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(grid => `
        <tr class="hover:bg-slate-50 cursor-pointer" onclick="openGrilleDrawer(${grid.id})">
          <td class="px-4 py-3 font-mono text-xs text-slate-700">${grid.code || '—'}</td>
          <td class="px-4 py-3 text-sm font-medium text-slate-800">${grid.libelle || '—'}</td>
          <td class="px-4 py-3 text-xs text-slate-500">${grid.date_debut || '—'}${grid.date_fin ? ' → ' + grid.date_fin : ''}</td>
          <td class="px-4 py-3">${badge(grid.statut)}</td>
          <td class="px-4 py-3 text-xs text-slate-500">${grid.nb_categories ?? 0} catégorie(s)</td>
          <td class="px-4 py-3 text-right">
            <button onclick="event.stopPropagation();openGrilleModal(${grid.id})" class="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-500 text-xs ${['valide', 'archive'].includes(grid.statut) ? 'opacity-40 cursor-not-allowed' : ''}" title="Modifier" ${['valide', 'archive'].includes(grid.statut) ? 'disabled' : ''}>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            </button>
          </td>
        </tr>`).join('');
    }

    function filter() {
      const query = (byId('grille-search')?.value || '').toLowerCase();
      const status = byId('grille-filter-statut')?.value || '';
      render(grids.filter(grid =>
        (!query || `${grid.code || ''} ${grid.libelle || ''}`.toLowerCase().includes(query)) &&
        (!status || grid.statut === status)
      ));
    }

    async function openDrawer(id) {
      requireRequest();
      const data = await request(`/grilles/${id}`);
      if (!data) return false;
      drawerData = data;
      drawerCategoryId = null;
      const grid = data.grille || data;
      const categories = data.categories || [];

      byId('grille-drawer-titre').textContent = grid.libelle || '—';
      byId('grille-drawer-code').textContent = grid.code || '—';
      const statusBadge = byId('grille-drawer-badge');
      const classes = STATUS_COLORS[grid.statut] || 'bg-slate-100 text-slate-500';
      statusBadge.className = `px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`;
      statusBadge.textContent = STATUS_LABELS[grid.statut] || grid.statut;
      byId('grille-drawer-infos').innerHTML = `
        <div><div class="text-xs text-slate-400 mb-1">Date début</div><div class="text-sm font-medium text-slate-700">${grid.date_debut || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Date fin</div><div class="text-sm font-medium text-slate-700">${grid.date_fin || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Créé par</div><div class="text-sm font-medium text-slate-700">${grid.created_by_nom || '—'}</div></div>
        <div><div class="text-xs text-slate-400 mb-1">Validé par</div><div class="text-sm font-medium text-slate-700">${grid.approved_by_nom || '—'}</div></div>`;
      renderWorkflow(grid);
      renderCategories(categories, grid.statut);
      byId('echelons-section').classList.add('hidden');
      byId('grille-drawer').classList.remove('translate-x-full');
      byId('grille-drawer-overlay').classList.remove('hidden');
      return true;
    }

    function renderWorkflow(grid) {
      const canWrite = hasAnyRole('admin', 'rh', 'finance', 'dg');
      const canDg = hasAnyRole('admin', 'dg');
      const workflow = byId('grille-drawer-workflow');
      let html = '';
      if (grid.statut === 'brouillon' && canWrite) {
        html += `<button onclick="grilleAction(${grid.id},'soumettre')" class="px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-200">Soumettre pour validation</button>`;
      }
      if (grid.statut === 'soumis' && canDg) {
        html += `<button onclick="grilleAction(${grid.id},'valider-dg')" class="px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold hover:bg-emerald-200">Valider (DG)</button>`;
      }
      if (['soumis', 'valide'].includes(grid.statut) && canDg) {
        html += `<button onclick="grilleAction(${grid.id},'archiver')" class="px-3 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-300 ml-1">Archiver</button>`;
      }
      workflow.innerHTML = html || '<span class="text-xs text-slate-400">Aucune action disponible</span>';
    }

    async function workflowAction(id, actionName) {
      const messages = {
        soumettre: 'Soumettre cette grille pour validation DG ?',
        'valider-dg': 'Valider définitivement cette grille ?',
        archiver: 'Archiver cette grille ?',
      };
      if (!confirmAction(messages[actionName] || 'Confirmer ?')) return false;
      const result = await request(`/grilles/${id}/${actionName}`, { method: 'POST' });
      if (!result || result.error) return false;
      notify(result.auto_approved ? 'Grille validée directement' : 'Grille mise à jour', 'success');
      await load();
      await openDrawer(id);
      return true;
    }

    function closeDrawer() {
      byId('grille-drawer').classList.add('translate-x-full');
      byId('grille-drawer-overlay').classList.add('hidden');
      drawerData = null;
    }

    function renderCategories(categories, gridStatus) {
      const canEdit = ['brouillon', 'soumis'].includes(gridStatus) && hasAnyRole('admin', 'rh', 'finance', 'dg');
      byId('btn-add-categorie')?.classList.toggle('hidden', !canEdit);
      const tbody = byId('categories-tbody');
      if (!categories || !categories.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-400 text-xs">Aucune catégorie — cliquez "+ Catégorie" pour en ajouter</td></tr>';
        return;
      }
      tbody.innerHTML = categories.map(category => `
        <tr class="hover:bg-slate-50 cursor-pointer" onclick="loadEchelonsDrawer(${category.id}, '${category.libelle || category.code}')">
          <td class="px-3 py-2 font-mono font-semibold text-indigo-600">${category.code}</td>
          <td class="px-3 py-2 text-slate-700">${category.libelle || '—'}</td>
          <td class="px-3 py-2 text-right font-mono">${money(category.salaire_min)}</td>
          <td class="px-3 py-2 text-right font-mono">${money(category.salaire_max)}</td>
          <td class="px-3 py-2 text-right">${category.coefficient_min || 1}–${category.coefficient_max || 1}</td>
          <td class="px-3 py-2 text-right text-slate-500">${category.nb_echelons ?? 0}</td>
          <td class="px-3 py-2 text-right">${canEdit ? `<button onclick="event.stopPropagation();openCategorieModal(${category.id})" class="p-1 rounded hover:bg-indigo-50 text-indigo-400" title="Modifier">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>` : ''}</td>
        </tr>`).join('');
    }

    async function loadEchelons(categoryId, categoryName) {
      drawerCategoryId = categoryId;
      byId('echelons-cat-name').textContent = categoryName;
      byId('echelons-section').classList.remove('hidden');
      const gridStatus = (drawerData?.grille || drawerData)?.statut;
      const canEdit = ['brouillon', 'soumis'].includes(gridStatus) && hasAnyRole('admin', 'rh', 'finance', 'dg');
      byId('btn-add-echelon')?.classList.toggle('hidden', !canEdit);
      const data = await request(`/grilles/categories/${categoryId}/echelons`);
      echelonsCache = Array.isArray(data) ? data : (data?.echelons || []);
      renderEchelons(echelonsCache, canEdit);
      return echelonsCache;
    }

    function renderEchelons(echelons, canEdit) {
      const tbody = byId('echelons-tbody');
      if (!echelons || !echelons.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-slate-400 text-xs">Aucun échelon</td></tr>';
        return;
      }
      tbody.innerHTML = echelons.map(item => `
        <tr class="hover:bg-slate-50">
          <td class="px-3 py-2 font-semibold text-slate-700">${item.echelon}</td>
          <td class="px-3 py-2 text-right font-mono">${money(item.salaire_reference)}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-500">${money(item.salaire_min)}</td>
          <td class="px-3 py-2 text-right font-mono text-slate-500">${money(item.salaire_max)}</td>
          <td class="px-3 py-2 text-right font-mono">${money(item.prime_transport)}</td>
          <td class="px-3 py-2 text-right font-mono">${money(item.prime_logement)}</td>
          <td class="px-3 py-2 text-right">${item.anciennete_min_ans || 0} ans</td>
          <td class="px-3 py-2 text-right">${canEdit ? `<button onclick="openEchelonModal(${item.id})" class="p-1 rounded hover:bg-indigo-50 text-indigo-400" title="Modifier">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>` : ''}</td>
        </tr>`).join('');
    }

    function showModal(id) {
      byId(id).classList.remove('hidden');
      byId(id).classList.add('flex');
    }

    function hideModal(id) {
      byId(id).classList.add('hidden');
      byId(id).classList.remove('flex');
    }

    async function openGridModal(id = null) {
      byId('grille-edit-id').value = id || '';
      byId('modal-grille-title').textContent = id ? 'Modifier la grille' : 'Nouvelle grille';
      if (id) {
        const grid = grids.find(item => item.id === id) || {};
        byId('grille-code').value = grid.code || '';
        byId('grille-libelle').value = grid.libelle || '';
        byId('grille-date-debut').value = grid.date_debut || '';
        byId('grille-date-fin').value = grid.date_fin || '';
      } else {
        ['grille-code', 'grille-libelle', 'grille-date-debut', 'grille-date-fin'].forEach(id => { byId(id).value = ''; });
      }
      showModal('modal-grille');
    }

    function closeGridModal() {
      hideModal('modal-grille');
    }

    async function saveGrid() {
      const id = byId('grille-edit-id').value;
      const body = {
        code: byId('grille-code').value.trim(),
        libelle: byId('grille-libelle').value.trim(),
        date_debut: byId('grille-date-debut').value || null,
        date_fin: byId('grille-date-fin').value || null,
      };
      if (!body.code || !body.libelle) {
        notify('Code et libellé obligatoires', 'warn');
        return false;
      }
      const result = await request(id ? `/grilles/${id}` : '/grilles', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      if (!result || result.error) return false;
      notify(id ? 'Grille modifiée' : 'Grille créée', 'success');
      closeGridModal();
      await load();
      return true;
    }

    async function openCategoryModal(id = null) {
      byId('categorie-edit-id').value = id || '';
      byId('modal-cat-grille-title').textContent = id ? 'Modifier la catégorie' : 'Nouvelle catégorie';
      if (id) {
        const category = (drawerData?.categories || []).find(item => item.id === id) || {};
        byId('cat-code').value = category.code || '';
        byId('cat-libelle').value = category.libelle || '';
        byId('cat-sal-min').value = category.salaire_min || 0;
        byId('cat-sal-max').value = category.salaire_max || 0;
        byId('cat-coef-min').value = category.coefficient_min || 1;
        byId('cat-coef-max').value = category.coefficient_max || 1;
      } else {
        ['cat-code', 'cat-libelle'].forEach(id => { byId(id).value = ''; });
        ['cat-sal-min', 'cat-sal-max'].forEach(id => { byId(id).value = 0; });
        ['cat-coef-min', 'cat-coef-max'].forEach(id => { byId(id).value = 1; });
      }
      showModal('modal-categorie');
    }

    function closeCategoryModal() {
      hideModal('modal-categorie');
    }

    async function saveCategory() {
      const id = byId('categorie-edit-id').value;
      const gridId = (drawerData?.grille || drawerData)?.id;
      if (!gridId) {
        notify('Erreur: grille non sélectionnée', 'error');
        return false;
      }
      const body = {
        grille_id: gridId,
        code: byId('cat-code').value.trim(),
        libelle: byId('cat-libelle').value.trim(),
        salaire_min: Number.parseFloat(byId('cat-sal-min').value) || 0,
        salaire_max: Number.parseFloat(byId('cat-sal-max').value) || 0,
        coefficient_min: Number.parseFloat(byId('cat-coef-min').value) || 1,
        coefficient_max: Number.parseFloat(byId('cat-coef-max').value) || 1,
      };
      if (!body.code || !body.libelle) {
        notify('Code et libellé obligatoires', 'warn');
        return false;
      }
      const result = await request(id ? `/grilles/${gridId}/categories/${id}` : `/grilles/${gridId}/categories`, {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      if (!result || result.error) return false;
      notify(id ? 'Catégorie modifiée' : 'Catégorie créée', 'success');
      closeCategoryModal();
      await openDrawer(gridId);
      return true;
    }

    function openEchelonModal(id = null) {
      byId('echelon-edit-id').value = id || '';
      byId('modal-echelon-title').textContent = id ? 'Modifier l\'échelon' : 'Nouvel échelon';
      if (id) {
        const item = echelonsCache.find(row => row.id === id) || {};
        byId('ech-num').value = item.echelon || 1;
        byId('ech-anciennete').value = item.anciennete_min_ans || 0;
        byId('ech-sal-ref').value = item.salaire_reference || 0;
        byId('ech-sal-min').value = item.salaire_min || 0;
        byId('ech-sal-max').value = item.salaire_max || 0;
        byId('ech-transport').value = item.prime_transport || 0;
        byId('ech-logement').value = item.prime_logement || 0;
      } else {
        ['ech-sal-ref', 'ech-sal-min', 'ech-sal-max', 'ech-transport', 'ech-logement', 'ech-anciennete'].forEach(id => { byId(id).value = 0; });
        byId('ech-num').value = 1;
      }
      showModal('modal-echelon');
    }

    function closeEchelonModal() {
      hideModal('modal-echelon');
    }

    async function saveEchelon() {
      const id = byId('echelon-edit-id').value;
      const categoryId = drawerCategoryId;
      if (!categoryId && !id) {
        notify('Erreur: catégorie non sélectionnée', 'error');
        return false;
      }
      const body = {
        echelon: Number.parseInt(byId('ech-num').value, 10) || 1,
        anciennete_min_ans: Number.parseInt(byId('ech-anciennete').value, 10) || 0,
        salaire_reference: Number.parseFloat(byId('ech-sal-ref').value) || 0,
        salaire_min: Number.parseFloat(byId('ech-sal-min').value) || 0,
        salaire_max: Number.parseFloat(byId('ech-sal-max').value) || 0,
        prime_transport: Number.parseFloat(byId('ech-transport').value) || 0,
        prime_logement: Number.parseFloat(byId('ech-logement').value) || 0,
      };
      const result = await request(id ? `/grilles/echelons/${id}` : `/grilles/categories/${categoryId}/echelons`, {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      if (!result || result.error) return false;
      notify(id ? 'Échelon modifié' : 'Échelon créé', 'success');
      closeEchelonModal();
      if (drawerCategoryId) await loadEchelons(drawerCategoryId, byId('echelons-cat-name')?.textContent || '');
      return true;
    }

    async function loadValidatedGrids() {
      if (agentGridsCache) return agentGridsCache;
      const data = await request('/grilles?statut=valide');
      agentGridsCache = Array.isArray(data) ? data : (data?.grilles || []);
      return agentGridsCache;
    }

    async function openAssignmentModal() {
      const validated = await loadValidatedGrids();
      byId('affg-grille-id').innerHTML = '<option value="">— Aucune grille —</option>' +
        validated.map(grid => `<option value="${grid.id}">${grid.code} — ${grid.libelle}</option>`).join('');
      byId('affg-categorie-id').innerHTML = '<option value="">— Sélectionner la grille d\'abord —</option>';
      byId('affg-echelon-id').innerHTML = '<option value="">— Sélectionner la catégorie d\'abord —</option>';
      byId('affg-fourchette-info').classList.add('hidden');
      showModal('modal-affectation-grille');
    }

    function closeAssignmentModal() {
      hideModal('modal-affectation-grille');
    }

    async function loadAssignmentCategories() {
      const gridId = byId('affg-grille-id').value;
      byId('affg-categorie-id').innerHTML = '<option value="">Chargement…</option>';
      byId('affg-echelon-id').innerHTML = '<option value="">—</option>';
      byId('affg-fourchette-info').classList.add('hidden');
      if (!gridId) {
        byId('affg-categorie-id').innerHTML = '<option value="">—</option>';
        return [];
      }
      const data = await request(`/grilles/${gridId}`);
      const categories = data?.categories || [];
      byId('affg-categorie-id').innerHTML = '<option value="">— Choisir —</option>' +
        categories.map(category => `<option value="${category.id}">${category.code} — ${category.libelle}</option>`).join('');
      return categories;
    }

    async function loadAssignmentEchelons() {
      const categoryId = byId('affg-categorie-id').value;
      byId('affg-echelon-id').innerHTML = '<option value="">Chargement…</option>';
      byId('affg-fourchette-info').classList.add('hidden');
      if (!categoryId) {
        byId('affg-echelon-id').innerHTML = '<option value="">—</option>';
        return [];
      }
      const data = await request(`/grilles/categories/${categoryId}/echelons`);
      const echelons = Array.isArray(data) ? data : (data?.echelons || []);
      byId('affg-echelon-id').innerHTML = '<option value="">— Choisir —</option>' +
        echelons.map(item => `<option value="${item.id}" data-min="${item.salaire_min}" data-max="${item.salaire_max}" data-ref="${item.salaire_reference}">Éch. ${item.echelon} — Réf. ${money(item.salaire_reference)} XAF</option>`).join('');
      byId('affg-echelon-id').onchange = () => {
        const option = byId('affg-echelon-id').selectedOptions[0];
        if (option && option.value) {
          byId('affg-fourchette-detail').textContent =
            `Min: ${money(option.dataset.min)} XAF — Réf: ${money(option.dataset.ref)} XAF — Max: ${money(option.dataset.max)} XAF`;
          byId('affg-fourchette-info').classList.remove('hidden');
        } else {
          byId('affg-fourchette-info').classList.add('hidden');
        }
      };
      return echelons;
    }

    async function saveAssignment() {
      const agentId = byId('agent-id')?.value;
      const categoryId = byId('affg-categorie-id').value;
      const echelonId = byId('affg-echelon-id').value;
      if (!agentId) {
        notify('Erreur: aucun agent sélectionné', 'error');
        return false;
      }
      const result = await request(`/grilles/agent/${agentId}/affecter`, {
        method: 'PUT',
        body: JSON.stringify({
          grille_categorie_id: categoryId ? Number.parseInt(categoryId, 10) : null,
          grille_echelon_id: echelonId ? Number.parseInt(echelonId, 10) : null,
        }),
      });
      if (!result || result.error) return false;
      notify('Affectation enregistrée', 'success');
      closeAssignmentModal();
      agentGridsCache = null;
      reloadAgentGrid(agentId);
      return true;
    }

    async function loadAgentGridInfo(agentId) {
      const data = await request(`/grilles/agent/${agentId}`);
      if (!data || data.error) {
        resetAgentGridInfo();
        return false;
      }
      const catEl = byId('ag-grille-categorie');
      const echelonEl = byId('ag-grille-echelon');
      const nameEl = byId('ag-grille-nom');
      const rangeEl = byId('ag-grille-fourchette');
      const alertEl = byId('ag-hors-borne-alert');
      const msgEl = byId('ag-hors-borne-msg');
      const assignButton = byId('btn-modifier-affectation');
      if (data.grille_categorie_id) {
        catEl.textContent = `${data.categorie_code || ''} — ${data.categorie_libelle || ''}`;
        echelonEl.textContent = data.grille_echelon_id ? `Éch. ${data.echelon_num}` : '—';
        nameEl.textContent = data.grille_libelle || '—';
        rangeEl.textContent = data.grille_echelon_id
          ? `${money(data.ech_salaire_min)} – ${money(data.ech_salaire_max)} XAF`
          : `${money(data.cat_salaire_min)} – ${money(data.cat_salaire_max)} XAF`;
        if (data.alerte_borne) {
          alertEl.classList.remove('hidden');
          msgEl.textContent = data.alerte_borne === 'inferieur_min'
            ? 'Salaire inférieur au minimum de l\'échelon'
            : 'Salaire supérieur au maximum de l\'échelon';
        } else {
          alertEl.classList.add('hidden');
        }
      } else {
        resetAgentGridInfo();
      }
      assignButton?.classList.toggle('hidden', !hasAnyRole('admin', 'rh', 'finance'));
      return true;
    }

    function resetAgentGridInfo() {
      ['ag-grille-categorie', 'ag-grille-echelon', 'ag-grille-nom', 'ag-grille-fourchette'].forEach(id => {
        const element = byId(id);
        if (element) element.textContent = '—';
      });
      byId('ag-hors-borne-alert')?.classList.add('hidden');
      byId('btn-modifier-affectation')?.classList.toggle('hidden', !hasAnyRole('admin', 'rh', 'finance'));
    }

    return {
      load,
      render,
      filter,
      openDrawer,
      renderWorkflow,
      workflowAction,
      closeDrawer,
      renderCategories,
      loadEchelons,
      renderEchelons,
      openGridModal,
      closeGridModal,
      saveGrid,
      openCategoryModal,
      closeCategoryModal,
      saveCategory,
      openEchelonModal,
      closeEchelonModal,
      saveEchelon,
      loadValidatedGrids,
      openAssignmentModal,
      closeAssignmentModal,
      loadAssignmentCategories,
      loadAssignmentEchelons,
      saveAssignment,
      loadAgentGridInfo,
      resetAgentGridInfo,
      getGrids: () => grids,
      getDrawerData: () => drawerData,
      getEchelons: () => echelonsCache,
    };
  }

  window.TalaPayrollGrids = { create, STATUS_LABELS, STATUS_COLORS };
})();

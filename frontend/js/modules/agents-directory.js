(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const MAX_PAGES = 25;
  let directoryReferenceAgents = [];
  let referenceLoadPromise = null;

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleDateString('fr-FR');
  }

  function formatTenure(dateValue) {
    if (!dateValue) return '—';
    const start = new Date(`${dateValue}T00:00:00`);
    const now = new Date();
    if (Number.isNaN(start.getTime()) || start > now) return '—';
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (now.getDate() < start.getDate()) months -= 1;
    if (months < 0) { years -= 1; months += 12; }
    const y = years > 0 ? `${years} an${years > 1 ? 's' : ''}` : '';
    const m = months > 0 ? `${months} mois` : '';
    return [y, m].filter(Boolean).join(' ') || '< 1 mois';
  }

  function initials(agent) {
    const p = String(agent?.prenom || '').trim().charAt(0);
    const n = String(agent?.nom || '').trim().charAt(0);
    return esc((p + n || '?').toUpperCase());
  }

  function statusMeta(status) {
    const map = {
      actif: ['Actif', 'is-active'],
      suspendu: ['Suspendu', 'is-warning'],
      sorti: ['Sorti', 'is-muted'],
      brouillon: ['Brouillon', 'is-draft'],
      en_conge: ['En congé', 'is-info'],
      fin_contrat: ['Fin contrat', 'is-danger'],
      archive: ['Archivé', 'is-muted'],
    };
    return map[status] || [status || 'Non défini', 'is-muted'];
  }

  function contractLabel(type) {
    return ({ cdi:'CDI', cdd:'CDD', stage:'Stage', consultant:'Consultant', journalier:'Journalier', prestataire:'Prestataire' })[type] || type || '—';
  }

  function contractAlert(agent) {
    if (!agent.date_fin_contrat) return '';
    const end = new Date(`${agent.date_fin_contrat}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.ceil((end - today) / 86400000);
    if (Number.isNaN(days)) return '';
    if (days < 0) return '<span class="agent-dir-alert is-danger" title="Contrat expiré">Expiré</span>';
    if (days <= 30) return `<span class="agent-dir-alert is-warning" title="Fin de contrat proche">J-${days}</span>`;
    return '';
  }

  async function fetchAllAgents(baseParams) {
    const collected = [];
    let total = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams(baseParams);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const data = await api('/agents?' + params.toString());
      if (!data) return null;
      const batch = Array.isArray(data.agents) ? data.agents : [];
      collected.push(...batch);
      total = Number.isFinite(Number(data.total)) ? Number(data.total) : collected.length;
      if (batch.length < PAGE_SIZE || collected.length >= total) break;
    }
    return { agents: collected, total: total ?? collected.length, truncated: total > collected.length };
  }

  function applyClientFilters(rows) {
    const site = document.getElementById('agent-filter-site')?.value || '';
    return site ? rows.filter(a => String(a.site || '') === site) : rows;
  }

  function injectStyles() {
    if (document.getElementById('agents-directory-v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'agents-directory-v2-styles';
    style.textContent = `
      #page-agents.agents-directory-v2 { --adir-border:#e2e8f0; --adir-muted:#64748b; --adir-bg:#f8fafc; }
      #page-agents.agents-directory-v2 #agents-kpi-bar { grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
      .agent-dir-kpi { background:#fff; border:1px solid var(--adir-border); border-radius:12px; padding:13px 15px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
      .agent-dir-kpi-label { color:#64748b; font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
      .agent-dir-kpi-value { color:#0f172a; font-size:22px; font-weight:750; line-height:1.2; margin-top:4px; }
      .agent-dir-kpi-note { color:#94a3b8; font-size:11px; margin-top:2px; }
      .agent-dir-extra-filter { min-width:150px; width:auto!important; font-size:13px!important; }
      #agent-results-count { color:#64748b; font-size:12px; white-space:nowrap; align-self:center; }
      .agent-dir-table thead th { background:#f8fafc; color:#64748b; font-size:10.5px; font-weight:750; letter-spacing:.045em; text-transform:uppercase; border-bottom:1px solid #e2e8f0; }
      .agent-dir-table tbody tr { cursor:pointer; transition:background .14s ease; }
      .agent-dir-table tbody tr:hover { background:#f8fafc; }
      .agent-dir-table tbody td { border-bottom:1px solid #eef2f7; vertical-align:middle; }
      .agent-dir-person { display:flex; align-items:center; gap:10px; min-width:220px; }
      .agent-dir-avatar { width:36px; height:36px; border-radius:10px; object-fit:cover; flex:0 0 auto; background:#eef3ff; color:#1a50d9; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px; }
      .agent-dir-name { color:#0f172a; font-weight:700; font-size:13.5px; line-height:1.25; }
      .agent-dir-meta { color:#64748b; font-size:11.5px; margin-top:2px; }
      .agent-dir-status { display:inline-flex; align-items:center; border-radius:999px; padding:4px 8px; font-size:11px; font-weight:700; border:1px solid transparent; }
      .agent-dir-status.is-active { background:#ecfdf5; color:#047857; border-color:#a7f3d0; }
      .agent-dir-status.is-warning { background:#fffbeb; color:#b45309; border-color:#fde68a; }
      .agent-dir-status.is-info { background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; }
      .agent-dir-status.is-danger { background:#fff1f2; color:#be123c; border-color:#fecdd3; }
      .agent-dir-status.is-draft,.agent-dir-status.is-muted { background:#f8fafc; color:#64748b; border-color:#e2e8f0; }
      .agent-dir-contract { display:inline-flex; border-radius:6px; background:#f1f5f9; color:#334155; padding:3px 7px; font-size:11px; font-weight:700; }
      .agent-dir-alert { margin-left:5px; border-radius:5px; padding:2px 5px; font-size:10px; font-weight:800; }
      .agent-dir-alert.is-warning { background:#fff7ed; color:#c2410c; }
      .agent-dir-alert.is-danger { background:#fff1f2; color:#be123c; }
      .agent-dir-open { border:1px solid #dbe4f0; background:#fff; color:#334155; border-radius:8px; padding:6px 9px; font-size:11.5px; font-weight:700; }
      .agent-dir-open:hover { border-color:#1a50d9; color:#1a50d9; background:#f8fbff; }
      #agent-snapshot-panel { position:fixed; inset:0; z-index:80; pointer-events:none; }
      #agent-snapshot-panel.is-open { pointer-events:auto; }
      .agent-snapshot-backdrop { position:absolute; inset:0; background:rgba(15,23,42,.28); opacity:0; transition:opacity .18s ease; }
      #agent-snapshot-panel.is-open .agent-snapshot-backdrop { opacity:1; }
      .agent-snapshot-sheet { position:absolute; top:0; right:0; width:min(430px,94vw); height:100%; background:#fff; box-shadow:-12px 0 36px rgba(15,23,42,.16); transform:translateX(100%); transition:transform .22s ease; display:flex; flex-direction:column; }
      #agent-snapshot-panel.is-open .agent-snapshot-sheet { transform:translateX(0); }
      .agent-snapshot-head { padding:22px; border-bottom:1px solid #e2e8f0; display:flex; gap:14px; align-items:flex-start; }
      .agent-snapshot-body { padding:20px 22px; overflow:auto; }
      .agent-snapshot-section { margin-bottom:22px; }
      .agent-snapshot-title { font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:800; color:#94a3b8; margin-bottom:10px; }
      .agent-snapshot-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 18px; }
      .agent-snapshot-field dt { color:#94a3b8; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.035em; }
      .agent-snapshot-field dd { color:#1e293b; font-size:13px; font-weight:550; margin-top:2px; word-break:break-word; }
      .agent-snapshot-actions { margin-top:auto; padding:16px 22px; border-top:1px solid #e2e8f0; display:flex; gap:8px; justify-content:flex-end; }
      @media (max-width:900px) { #page-agents.agents-directory-v2 #agents-kpi-bar { grid-template-columns:repeat(2,minmax(0,1fr)); } .agent-dir-table .hide-md { display:none; } }
      @media (max-width:640px) { .agent-dir-extra-filter { min-width:0; max-width:48%; } .agent-snapshot-grid { grid-template-columns:1fr; } }
    `;
    document.head.appendChild(style);
  }

  function ensureFilters() {
    const contract = document.getElementById('agent-filter-contrat');
    if (!contract) return;
    if (!document.getElementById('agent-filter-departement')) {
      const dept = document.createElement('select');
      dept.id = 'agent-filter-departement';
      dept.className = 'agent-dir-extra-filter';
      dept.innerHTML = '<option value="">Tous départements</option>';
      dept.addEventListener('change', () => filterAgents());
      contract.insertAdjacentElement('afterend', dept);
    }
    if (!document.getElementById('agent-filter-site')) {
      const site = document.createElement('select');
      site.id = 'agent-filter-site';
      site.className = 'agent-dir-extra-filter';
      site.innerHTML = '<option value="">Tous sites</option>';
      site.addEventListener('change', () => filterAgents());
      document.getElementById('agent-filter-departement').insertAdjacentElement('afterend', site);
    }
    if (!document.getElementById('agent-results-count')) {
      const count = document.createElement('span');
      count.id = 'agent-results-count';
      count.textContent = '';
      document.getElementById('agent-filter-site').insertAdjacentElement('afterend', count);
    }
  }

  function setSelectOptions(id, values, placeholder) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    const unique = [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, 'fr'));
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + unique.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (unique.includes(current)) select.value = current;
  }

  async function loadReferences() {
    if (referenceLoadPromise) return referenceLoadPromise;
    referenceLoadPromise = (async () => {
      const activeParams = new URLSearchParams({ statut:'actif' });
      const [postes, depts, sites, allActive] = await Promise.all([
        api('/org/postes'),
        api('/org/departements'),
        api('/org/sites'),
        fetchAllAgents(activeParams),
      ]);
      directoryReferenceAgents = allActive?.agents || [];
      const postLabels = Array.isArray(postes) ? postes.map(x => x.libelle) : directoryReferenceAgents.map(x => x.poste);
      const deptLabels = Array.isArray(depts) ? depts.map(x => x.libelle) : directoryReferenceAgents.map(x => x.departement);
      const siteLabels = Array.isArray(sites) ? sites.map(x => x.libelle) : directoryReferenceAgents.map(x => x.site);
      setSelectOptions('agent-filter-departement', deptLabels, 'Tous départements');
      setSelectOptions('agent-filter-site', siteLabels, 'Tous sites');
      const fillDatalist = (id, values) => {
        const dl = document.getElementById(id);
        if (dl) dl.innerHTML = [...new Set(values.filter(Boolean))].sort((a,b) => String(a).localeCompare(String(b), 'fr')).map(v => `<option value="${esc(v)}">`).join('');
      };
      fillDatalist('dl-postes', postLabels);
      fillDatalist('dl-departements', deptLabels);
      fillDatalist('dl-sites', siteLabels);
    })().finally(() => { referenceLoadPromise = null; });
    return referenceLoadPromise;
  }

  function patchTableHeader() {
    const table = document.getElementById('agents-tbody')?.closest('table');
    if (!table) return;
    table.classList.add('agent-dir-table');
    const head = table.querySelector('thead');
    if (!head) return;
    head.innerHTML = `<tr>
      <th class="px-4 py-3 text-left">Agent</th>
      <th class="px-4 py-3 text-left">Poste</th>
      <th class="px-4 py-3 text-left">Département</th>
      <th class="px-4 py-3 text-left hide-md">Site</th>
      <th class="px-4 py-3 text-left">Contrat</th>
      <th class="px-4 py-3 text-left hide-md">Ancienneté</th>
      <th class="px-4 py-3 text-left">Statut</th>
      <th class="px-4 py-3 text-right">Action</th>
    </tr>`;
  }

  function renderDirectory() {
    const tbody = document.getElementById('agents-tbody');
    if (!tbody) return;
    patchTableHeader();
    const rows = applyClientFilters(agentsList);
    const count = document.getElementById('agent-results-count');
    if (count) count.textContent = `${rows.length} agent${rows.length > 1 ? 's' : ''}`;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-14 text-center text-slate-500">Aucun agent ne correspond aux critères.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(a => {
      const [statusLabel, statusClass] = statusMeta(a.statut_dossier);
      const photo = a.photo_url
        ? `<img src="${esc(a.photo_url)}" alt="" class="agent-dir-avatar">`
        : `<div class="agent-dir-avatar">${initials(a)}</div>`;
      const contact = a.email || a.telephone || '';
      return `<tr onclick="openAgentSnapshot(${Number(a.id)})">
        <td class="px-4 py-3">
          <div class="agent-dir-person">${photo}<div>
            <div class="agent-dir-name">${esc(`${a.prenom || ''} ${a.nom || ''}`.trim())}</div>
            <div class="agent-dir-meta">${esc(a.matricule || 'Sans matricule')}${contact ? ` · ${esc(contact)}` : ''}</div>
          </div></div>
        </td>
        <td class="px-4 py-3 text-sm text-slate-700">${esc(a.poste || '—')}</td>
        <td class="px-4 py-3 text-sm text-slate-600">${esc(a.departement || '—')}</td>
        <td class="px-4 py-3 text-sm text-slate-500 hide-md">${esc(a.site || '—')}</td>
        <td class="px-4 py-3"><span class="agent-dir-contract">${esc(contractLabel(a.type_contrat))}</span>${contractAlert(a)}</td>
        <td class="px-4 py-3 text-sm text-slate-500 hide-md">${esc(formatTenure(a.date_embauche))}</td>
        <td class="px-4 py-3"><span class="agent-dir-status ${statusClass}">${esc(statusLabel)}</span></td>
        <td class="px-4 py-3 text-right"><button class="agent-dir-open" onclick="event.stopPropagation();openAgentModal(${Number(a.id)})">Ouvrir</button></td>
      </tr>`;
    }).join('');
  }

  function ensureSnapshotPanel() {
    let panel = document.getElementById('agent-snapshot-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'agent-snapshot-panel';
    panel.innerHTML = '<div class="agent-snapshot-backdrop" onclick="closeAgentSnapshot()"></div><aside class="agent-snapshot-sheet" role="dialog" aria-modal="true" aria-label="Aperçu agent"><div id="agent-snapshot-content" class="contents"></div></aside>';
    document.body.appendChild(panel);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAgentSnapshot(); });
    return panel;
  }

  window.openAgentSnapshot = function openAgentSnapshot(id) {
    const agent = agentsList.find(a => Number(a.id) === Number(id));
    if (!agent) return;
    const panel = ensureSnapshotPanel();
    const content = document.getElementById('agent-snapshot-content');
    const [statusLabel, statusClass] = statusMeta(agent.statut_dossier);
    content.innerHTML = `
      <div class="agent-snapshot-head">
        ${agent.photo_url ? `<img src="${esc(agent.photo_url)}" alt="" class="agent-dir-avatar" style="width:48px;height:48px">` : `<div class="agent-dir-avatar" style="width:48px;height:48px">${initials(agent)}</div>`}
        <div style="min-width:0;flex:1"><div class="text-lg font-bold text-slate-900">${esc(`${agent.prenom || ''} ${agent.nom || ''}`.trim())}</div><div class="text-sm text-slate-500 mt-0.5">${esc(agent.poste || 'Poste non renseigné')}</div><div class="mt-2"><span class="agent-dir-status ${statusClass}">${esc(statusLabel)}</span></div></div>
        <button onclick="closeAgentSnapshot()" class="text-slate-400 hover:text-slate-700 text-xl leading-none" aria-label="Fermer">×</button>
      </div>
      <div class="agent-snapshot-body">
        <section class="agent-snapshot-section"><div class="agent-snapshot-title">Emploi</div><dl class="agent-snapshot-grid">
          <div class="agent-snapshot-field"><dt>Matricule</dt><dd>${esc(agent.matricule || '—')}</dd></div>
          <div class="agent-snapshot-field"><dt>Département</dt><dd>${esc(agent.departement || '—')}</dd></div>
          <div class="agent-snapshot-field"><dt>Site</dt><dd>${esc(agent.site || '—')}</dd></div>
          <div class="agent-snapshot-field"><dt>Supérieur</dt><dd>${esc(agent.superieur_hierarchique || '—')}</dd></div>
          <div class="agent-snapshot-field"><dt>Contrat</dt><dd>${esc(contractLabel(agent.type_contrat))}</dd></div>
          <div class="agent-snapshot-field"><dt>Embauche</dt><dd>${fmtDate(agent.date_embauche)}</dd></div>
          <div class="agent-snapshot-field"><dt>Ancienneté</dt><dd>${esc(formatTenure(agent.date_embauche))}</dd></div>
          <div class="agent-snapshot-field"><dt>Fin contrat</dt><dd>${fmtDate(agent.date_fin_contrat)}</dd></div>
        </dl></section>
        <section class="agent-snapshot-section"><div class="agent-snapshot-title">Contact professionnel</div><dl class="agent-snapshot-grid">
          <div class="agent-snapshot-field"><dt>Email</dt><dd>${esc(agent.email || '—')}</dd></div>
          <div class="agent-snapshot-field"><dt>Téléphone</dt><dd>${esc(agent.telephone || '—')}</dd></div>
        </dl></section>
      </div>
      <div class="agent-snapshot-actions"><button onclick="closeAgentSnapshot()" class="agent-dir-open">Fermer</button><button onclick="closeAgentSnapshot();openAgentModal(${Number(agent.id)})" class="btn btn-primary">Ouvrir le dossier</button></div>`;
    panel.classList.add('is-open');
  };

  window.closeAgentSnapshot = function closeAgentSnapshot() {
    document.getElementById('agent-snapshot-panel')?.classList.remove('is-open');
  };

  loadAgentsKpis = async function loadAgentsKpisV2() {
    const data = await api('/agents/kpis');
    const bar = document.getElementById('agents-kpi-bar');
    if (!data || !bar) return;
    const cards = [
      ['Agents actifs', data.actifs ?? 0, 'Effectif opérationnel'],
      ['Suspendus', data.suspendus ?? 0, 'Dossiers temporairement suspendus'],
      ['Contrats ≤ 30 j', data.contratsExpirants ?? 0, 'Échéances à préparer'],
      ['Documents expirés', data.documentsExpires ?? 0, 'Conformité documentaire'],
    ];
    bar.innerHTML = cards.map(([label, value, note]) => `<div class="agent-dir-kpi"><div class="agent-dir-kpi-label">${esc(label)}</div><div class="agent-dir-kpi-value">${esc(value)}</div><div class="agent-dir-kpi-note">${esc(note)}</div></div>`).join('');
  };

  loadDocumentAlertes = async function loadDocumentAlertesV2() {
    const container = document.getElementById('agents-doc-alertes');
    if (!container) return;
    const alertes = await api('/agents/documents/alertes');
    if (!Array.isArray(alertes) || !alertes.length) { container.classList.add('hidden'); container.innerHTML = ''; return; }
    const now = new Date(); now.setHours(0,0,0,0);
    const items = alertes.slice(0, 8).map(a => {
      const date = new Date(`${a.date_expiration}T00:00:00`);
      const days = Math.ceil((date - now) / 86400000);
      const state = a.statut_calc === 'expiré' || days < 0 ? 'Expiré' : `J-${Math.max(0, days)}`;
      const name = `${a.prenom || ''} ${a.nom || ''}`.trim() || a.matricule || 'Agent';
      return `<span class="text-xs text-slate-600"><strong>${esc(name)}</strong> · ${esc(a.type_document || 'Document')} <span class="${days < 0 ? 'text-rose-700' : 'text-amber-700'} font-bold">${state}</span></span>`;
    });
    container.classList.remove('hidden');
    container.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap gap-x-4 gap-y-2"><span class="text-xs font-bold uppercase tracking-wide text-slate-500">Documents à surveiller (${alertes.length})</span>${items.join('')}</div>`;
  };

  renderAgents = renderDirectory;

  populateAgentDataLists = function populateAgentDataListsV2() {
    loadReferences().catch(() => {});
  };

  agSuperieurSearch = function agSuperieurSearchV2(q) {
    const drop = document.getElementById('ag-superieur-drop');
    if (!drop) return;
    const currentId = document.getElementById('agent-id')?.value;
    const term = String(q || '').trim().toLowerCase();
    const source = directoryReferenceAgents.length ? directoryReferenceAgents : agentsList;
    const matches = source
      .filter(a => String(a.id) !== String(currentId || ''))
      .filter(a => !term || `${a.prenom || ''} ${a.nom || ''} ${a.matricule || ''} ${a.poste || ''}`.toLowerCase().includes(term))
      .slice(0, 10);
    drop.innerHTML = matches.length ? matches.map(a => {
      const full = `${a.nom || ''} ${a.prenom || ''}`.trim();
      return `<div class="autocomplete-item" data-agent-name="${esc(full)}"><span class="font-medium">${esc(full)}</span><span class="text-slate-400 text-xs ml-2">${esc([a.poste, a.departement].filter(Boolean).join(' · '))}</span></div>`;
    }).join('') : '<div class="autocomplete-item text-slate-400 italic">Aucun agent trouvé</div>';
    drop.querySelectorAll('[data-agent-name]').forEach(item => item.addEventListener('mousedown', event => {
      event.preventDefault();
      document.getElementById('ag-superieur').value = item.dataset.agentName || '';
      drop.classList.add('hidden');
    }));
    drop.classList.remove('hidden');
  };

  loadAgents = async function loadAgentsV2() {
    loadAgentsKpis();
    loadDocumentAlertes();
    ensureFilters();
    const params = new URLSearchParams();
    if (agentStatutTab !== '') params.set('statut', agentStatutTab);
    const contrat = document.getElementById('agent-filter-contrat')?.value || '';
    const departement = document.getElementById('agent-filter-departement')?.value || '';
    const search = document.getElementById('agent-search')?.value?.trim() || '';
    if (contrat) params.set('type_contrat', contrat);
    if (departement) params.set('departement', departement);
    if (search) params.set('search', search);
    const tbody = document.getElementById('agents-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-10 text-center text-slate-400">Chargement des agents…</td></tr>';
    const data = await fetchAllAgents(params);
    if (!data) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-10 text-center text-rose-600">Impossible de charger les agents.</td></tr>';
      return;
    }
    agentsList = data.agents;
    renderDirectory();
    loadReferences().catch(() => {});
    if (data.truncated && typeof showToast === 'function') showToast(`Liste limitée à ${agentsList.length} agents. Affinez les filtres.`, 'warning');
  };

  filterAgents = function filterAgentsV2() {
    clearTimeout(window.__agentDirectorySearchTimer);
    window.__agentDirectorySearchTimer = setTimeout(() => loadAgents(), 250);
  };

  function init() {
    const page = document.getElementById('page-agents');
    if (!page || typeof api !== 'function') return;
    page.classList.add('agents-directory-v2');
    injectStyles();
    ensureFilters();
    patchTableHeader();
    ensureSnapshotPanel();
    loadReferences().catch(() => {});
    if (!page.classList.contains('hidden')) loadAgents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
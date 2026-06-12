(function () {
  'use strict';

  const PAGE_ROUTES = {
    dashboard: '/app/tableau-de-bord',
    parapheur: '/app/direction/parapheur',
    bilan: '/app/direction/bilan',
    audit: '/app/direction/audit',
    rapprochement: '/app/tresorerie/rapprochement',
    operations: '/app/finance/operations',
    'journal-comptable': '/app/comptabilite/journal',
    journal: '/app/tresorerie/journal',
    rapports: '/app/rapports',
    'rh-overview': '/app/rh/vue-ensemble',
    agents: '/app/rh/agents',
    absences: '/app/rh/absences-conges',
    sanctions: '/app/rh/registre-disciplinaire',
    'heures-sup': '/app/rh/heures-supplementaires',
    offboarding: '/app/rh/offboarding',
    pointeuse: '/app/rh/pointeuse',
    organigramme: '/app/rh/organigramme',
    salaires: '/app/rh/paie',
    periodes: '/app/rh/paie/periodes',
    grilles: '/app/rh/paie/grilles',
    revisions: '/app/rh/paie/revisions',
    cnss: '/app/rh/paie/cnss-camu',
    dgi: '/app/rh/paie/dgi-fiscalite',
    'calendrier-fiscal': '/app/direction/calendrier-fiscal',
    clients: '/app/ventes/clients',
    devis: '/app/ventes/devis',
    'factures-clients': '/app/ventes/factures-clients',
    produits: '/app/stock/produits',
    achats: '/app/achats/demandes',
    'bons-commandes': '/app/achats/bons-commandes',
    receptions: '/app/achats/receptions',
    'factures-fournisseurs': '/app/achats/factures-fournisseurs',
    contrats: '/app/contrats',
    parametres: '/app/parametres',
  };

  const LEGACY_ROUTE_PAGES = {
    '/app/rh/salaires': 'salaires',
    '/app/rh/periodes-paie': 'periodes',
    '/app/rh/grilles-salariales': 'grilles',
    '/app/rh/revisions-salariales': 'revisions',
    '/app/rh/cnss-camu': 'cnss',
    '/app/rh/dgi-fiscalite': 'dgi',
  };

  const PAGE_MODULES = {
    dashboard: ['dashboard'],
    parapheur: ['access', 'purchase'],
    bilan: ['dashboard', 'audit'],
    audit: ['audit'],
    rapprochement: ['cash'],
    operations: ['cash'],
    'journal-comptable': ['cash'],
    journal: ['cash'],
    rapports: ['cash', 'audit'],
    'rh-overview': ['hr'],
    agents: ['hr'],
    absences: ['hr'],
    sanctions: ['hr'],
    'heures-sup': ['hr'],
    offboarding: ['hr'],
    pointeuse: ['pointeuse'],
    organigramme: ['org', 'hr'],
    salaires: ['salary'],
    periodes: ['salary'],
    grilles: ['salary'],
    revisions: ['salary', 'hr'],
    cnss: ['salary'],
    dgi: ['salary'],
    'calendrier-fiscal': ['salary'],
    clients: ['commercial'],
    devis: ['commercial'],
    'factures-clients': ['commercial'],
    produits: ['stock'],
    achats: ['purchase'],
    'bons-commandes': ['purchase'],
    receptions: ['purchase'],
    'factures-fournisseurs': ['purchase'],
    contrats: ['project', 'commercial'],
    parametres: ['settings', 'access'],
  };

  const TOPBAR_ACTIONS_MAP = {
    dashboard: 'tba-caisse',
    operations: 'tba-operations',
    salaires: 'tba-salaires',
    periodes: 'tba-salaires',
    grilles: 'tba-salaires',
    revisions: 'tba-salaires',
    cnss: 'tba-salaires',
    dgi: 'tba-salaires',
    agents: 'tba-rh',
    'rh-overview': 'tba-rh',
    absences: 'tba-rh',
    organigramme: 'tba-rh',
    sanctions: 'tba-rh',
    'heures-sup': 'tba-rh',
    offboarding: 'tba-rh',
    pointeuse: 'tba-pointeuse',
    achats: 'tba-achats',
    'bons-commandes': 'tba-bons-commandes',
    clients: 'tba-clients',
    devis: 'tba-devis',
    'factures-clients': 'tba-factures-clients',
    produits: 'tba-produits',
    contrats: 'tba-contrats',
  };

  const TOPBAR_ACTION_ZONE_IDS = [
    'tba-caisse', 'tba-rh', 'tba-operations', 'tba-salaires',
    'tba-achats', 'tba-clients', 'tba-devis', 'tba-factures-clients',
    'tba-produits', 'tba-bons-commandes', 'tba-contrats', 'tba-pointeuse',
  ];

  const NAV_GROUPS = {
    bilan: 'nav-group-direction',
    audit: 'nav-group-direction',
    rapprochement: 'nav-group-direction',
    revisions: 'nav-group-direction',
    'calendrier-fiscal': 'nav-group-direction',
    'rh-overview': 'nav-group-rh',
    agents: 'nav-group-rh',
    salaires: 'nav-group-rh',
    absences: 'nav-group-rh',
    organigramme: 'nav-group-rh',
    cnss: 'nav-group-rh',
    dgi: 'nav-group-rh',
    grilles: 'nav-group-rh',
    periodes: 'nav-group-rh',
    sanctions: 'nav-group-rh',
    'heures-sup': 'nav-group-rh',
    offboarding: 'nav-group-rh',
    pointeuse: 'nav-group-rh',
    operations: 'nav-group-compta',
    journal: 'nav-group-compta',
    clients: 'nav-group-ventes',
    devis: 'nav-group-ventes',
    'factures-clients': 'nav-group-ventes',
    achats: 'nav-group-achats',
    'bons-commandes': 'nav-group-achats',
    receptions: 'nav-group-achats',
    'factures-fournisseurs': 'nav-group-achats',
  };

  const PAYROLL_WORKSPACE_PAGES = new Set(['salaires', 'periodes', 'cnss', 'dgi', 'grilles', 'revisions']);

  function normalizeAppPath(pathname) {
    const path = String(pathname || '/').replace(/\/+$/, '');
    return path || '/';
  }

  function routeForPage(page) {
    return PAGE_ROUTES[page] || PAGE_ROUTES.dashboard;
  }

  function create(options = {}) {
    const routePages = new Map(Object.entries(PAGE_ROUTES).map(([page, route]) => [route, page]));
    const legacyRoutePages = new Map(Object.entries(LEGACY_ROUTE_PAGES));
    const getPathname = options.getPathname || (() => window.location.pathname);
    const getHash = options.getHash || (() => window.location.hash);
    const pageExists = options.pageExists || (() => false);
    const navLinks = options.navLinks || (() => []);
    const canAccessModule = options.canAccessModule || (() => false);
    const hasExactRole = options.hasExactRole || (() => false);

    function pageFromLocation() {
      const path = normalizeAppPath(getPathname());
      const routePage = routePages.get(path) || legacyRoutePages.get(path);
      if (routePage) return routePage;

      const hashPage = String(getHash() || '').replace(/^#/, '').trim();
      if (hashPage && pageExists(hashPage)) return hashPage;
      return '';
    }

    function updatePageRoute(page, historyMode = 'push') {
      if (historyMode === 'none') return;
      const target = routeForPage(page);
      const alreadyCanonical = normalizeAppPath(getPathname()) === target && !getHash();
      if (alreadyCanonical) return;
      const method = historyMode === 'replace' ? 'replaceState' : 'pushState';
      window.history[method]({ page }, '', target);
    }

    function syncNavigationHrefs() {
      navLinks().forEach(link => {
        link.setAttribute('href', routeForPage(link.dataset.page));
      });
    }

    function canAccessPage(page) {
      if (hasExactRole('admin')) return true;
      const modules = PAGE_MODULES[page] || [];
      return modules.some(canAccessModule);
    }

    function firstAllowedPage(preferred = '') {
      if (preferred && canAccessPage(preferred) && pageExists(preferred)) return preferred;
      if (canAccessPage('pointeuse') && pageExists('pointeuse')) return 'pointeuse';
      const first = navLinks()
        .map(el => el.dataset.page)
        .find(page => canAccessPage(page) && pageExists(page));
      return first || 'pointeuse';
    }

    function activeNavPage(page) {
      return PAYROLL_WORKSPACE_PAGES.has(page) ? 'salaires' : page;
    }

    return {
      PAGE_ROUTES,
      PAGE_MODULES,
      LEGACY_ROUTE_PAGES,
      TOPBAR_ACTIONS_MAP,
      TOPBAR_ACTION_ZONE_IDS,
      normalizeAppPath,
      routeForPage,
      pageFromLocation,
      updatePageRoute,
      syncNavigationHrefs,
      canAccessPage,
      firstAllowedPage,
      activeNavPage,
      groupForPage(page) {
        return NAV_GROUPS[page] || '';
      },
    };
  }

  window.TalaNavigation = {
    PAGE_ROUTES,
    PAGE_MODULES,
    LEGACY_ROUTE_PAGES,
    TOPBAR_ACTIONS_MAP,
    TOPBAR_ACTION_ZONE_IDS,
    NAV_GROUPS,
    create,
    normalizeAppPath,
    routeForPage,
  };
})();

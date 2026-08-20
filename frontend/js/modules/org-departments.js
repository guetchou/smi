(function () {
  'use strict';

  const scripts = [
    '/js/modules/org-departments-core.js',
    '/js/modules/agent-organization.js',
    '/js/modules/org-integrity-ui.js',
    '/js/modules/org-mutation-workflow-ui.js',
    '/js/modules/agent-organization-workflow-lock.js',
    '/js/modules/org-doc-upload.js',
  ];
  const departmentFunctionsScript = '/js/modules/org-department-functions-ui.js';
  const organizationUnitsScript = '/js/modules/org-organization-units-ui.js';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function normalizedPath() {
    const path = String(window.location.pathname || '/').replace(/\/+$/, '');
    return path || '/';
  }

  function loadDepartmentFunctionsIfNeeded() {
    if (normalizedPath() !== '/app/rh/organigramme') return Promise.resolve(false);
    return Promise.all([
      loadScript(departmentFunctionsScript),
      loadScript(organizationUnitsScript),
    ]).then(() => true);
  }

  function installRouteObserver() {
    if (window.__talaOrgDepartmentFunctionsRouteObserver) return;
    window.__talaOrgDepartmentFunctionsRouteObserver = true;

    const notify = () => {
      window.setTimeout(() => {
        loadDepartmentFunctionsIfNeeded().catch(error => {
          console.error('[organization-loader:functions]', error);
        });
      }, 0);
    };

    window.addEventListener('popstate', notify);
    for (const method of ['pushState', 'replaceState']) {
      const original = window.history[method];
      if (typeof original !== 'function') continue;
      window.history[method] = function observedHistoryState(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }
  }

  scripts.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve())
    .then(() => {
      installRouteObserver();
      return loadDepartmentFunctionsIfNeeded();
    })
    .catch(error => {
      console.error('[organization-loader]', error);
    });
})();

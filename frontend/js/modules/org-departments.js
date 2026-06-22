(function () {
  'use strict';

  const scripts = [
    '/js/modules/org-departments-core.js',
    '/js/modules/agent-organization.js',
    '/js/modules/org-integrity-ui.js',
    '/js/modules/org-mutation-workflow-ui.js',
    '/js/modules/agent-organization-workflow-lock.js',
  ];

  scripts.reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    (document.head || document.documentElement).appendChild(script);
  })), Promise.resolve()).catch(error => {
    console.error('[organization-loader]', error);
  });
})();

(function () {
  'use strict';

  const styleId = 'tala-agent-organization-production-ui';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #ag-departement-responsable-hint.text-emerald-700 {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const scripts = [
    '/js/modules/org-departments-core.js',
    '/js/modules/agent-organization.js',
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

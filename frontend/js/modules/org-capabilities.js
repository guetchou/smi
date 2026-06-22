(function () {
  'use strict';

  const state = { loaded: false, loading: null, permissions: {}, capabilities: {} };

  function authHeaders() {
    const value = localStorage.getItem('tc_token') || '';
    return value ? { Authorization: `Bearer ${value}` } : {};
  }

  async function load(force = false) {
    if (state.loaded && !force) return state;
    if (state.loading) return state.loading;
    state.loading = fetch('/api/org/capabilities', { headers: { 'Content-Type': 'application/json', ...authHeaders() } })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Erreur HTTP ${response.status}`);
        state.permissions = payload.permissions || {};
        state.capabilities = payload.capabilities || {};
        state.loaded = true;
        return state;
      })
      .finally(() => { state.loading = null; });
    return state.loading;
  }

  function can(name) {
    return state.capabilities[name] === true || state.permissions[name] === true;
  }

  window.TalaOrgCapabilities = { load, can };
})();

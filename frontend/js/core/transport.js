(function () {
  'use strict';

  const DEFAULT_GET_CACHE_TTLS = [
    [/\/api\/notifs\/admin\/params(?:\?|$)/, 30000],
    [/\/api\/achats\/count-soumis(?:\?|$)/, 15000],
    [/\/api\/revisions-salaire\/en-attente(?:\?|$)/, 15000],
    [/\/api\/salaires\/taux(?:\?|$)/, 60000],
    [/\/api\/paie\/periodes(?:\?|$)/, 30000],
  ];

  function normalizeApiPath(path) {
    if (!path) return '/api';
    return path.startsWith('/api') ? path : '/api' + (path.startsWith('/') ? path : '/' + path);
  }
  function joinBaseAndPath(baseApiUrl, path) {
    if (!path) return baseApiUrl;
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith('/api')) {
      const origin = baseApiUrl.replace(/\/api\/?$/, '');
      return origin + path;
    }
    return baseApiUrl + (path.startsWith('/') ? path : '/' + path);
  }
  async function parseResponseJson(res) { return res.json().catch(() => ({})); }
  function formatErrorMessage(data, status) {
    const suffix = data && data.diagnostic_id ? ` (${data.diagnostic_id})` : '';
    return ((data && data.error) || `Erreur ${status}`) + suffix;
  }
  function cacheTtlFor(url, opts = {}) {
    if (opts.noCache) return 0;
    if (Number.isFinite(opts.cacheTtlMs)) return Math.max(0, Number(opts.cacheTtlMs));
    const match = DEFAULT_GET_CACHE_TTLS.find(([pattern]) => pattern.test(url));
    return match ? match[1] : 0;
  }

  function create(options = {}) {
    const fetchImpl = options.fetchImpl || window.fetch.bind(window);
    const baseApiUrl = options.baseApiUrl || (window.location.origin + '/api');
    const origin = options.origin || window.location.origin;
    const getToken = options.getToken || (() => '');
    const getBuildId = options.getBuildId || (() => '');
    const notify = options.notify || (() => {});
    const onUnauthorized = options.onUnauthorized || (() => {});
    const inflightGetRequests = new Map();
    const getResponseCache = new Map();

    function headers(extraHeaders = {}) {
      return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken(), 'X-Client-Build': getBuildId(), ...extraHeaders };
    }
    async function request(path, opts = {}) {
      const { silentStatuses = [], cacheTtlMs, noCache = false, ...fetchOpts } = opts;
      const method = String(fetchOpts.method || 'GET').toUpperCase();
      const url = joinBaseAndPath(baseApiUrl, path);
      const isGet = method === 'GET' && fetchOpts.body === undefined;
      const token = getToken();
      const cacheKey = `${token || 'anonymous'}::${url}`;
      const ttlMs = isGet ? cacheTtlFor(url, { cacheTtlMs, noCache }) : 0;
      const now = Date.now();
      if (ttlMs > 0) {
        const cached = getResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > now) return cached.data;
        if (cached) getResponseCache.delete(cacheKey);
      }
      if (isGet && inflightGetRequests.has(cacheKey)) return inflightGetRequests.get(cacheKey);
      const execute = async () => {
        try {
          const res = await fetchImpl(url, { ...fetchOpts, method, headers: headers(fetchOpts.headers) });
          if (res.status === 401) { onUnauthorized(); return null; }
          const data = await parseResponseJson(res);
          if (!res.ok) {
            if (silentStatuses.includes(res.status)) return null;
            notify(formatErrorMessage(data, res.status), 'error');
            return null;
          }
          if (ttlMs > 0) getResponseCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
          return data;
        } catch (err) { notify('Erreur de connexion au serveur', 'error'); return null; }
      };
      const promise = execute();
      if (isGet) {
        inflightGetRequests.set(cacheKey, promise);
        promise.finally(() => inflightGetRequests.delete(cacheKey));
      }
      return promise;
    }
    async function fetchApi(path, method, body, opts = {}) {
      const requestOpts = { ...opts, method };
      if (body !== undefined) requestOpts.body = JSON.stringify(body);
      return request(origin + normalizeApiPath(path), requestOpts);
    }
    return {
      normalizeApiPath, request, fetchApi,
      get(path, opts) { return fetchApi(path, 'GET', undefined, opts); },
      post(path, body, opts) { return fetchApi(path, 'POST', body, opts); },
      put(path, body, opts) { return fetchApi(path, 'PUT', body, opts); },
      patch(path, body, opts) { return fetchApi(path, 'PATCH', body, opts); },
      delete(path, opts) { return fetchApi(path, 'DELETE', undefined, opts); },
    };
  }

  window.TalaTransport = { create, normalizeApiPath, joinBaseAndPath, formatErrorMessage };

  function loadEnhancement(src, dataKey) {
    const selector = `script[data-${dataKey}]`;
    if (document.querySelector(selector)) return;
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    script.setAttribute(`data-${dataKey}`, 'true');
    document.head.appendChild(script);
  }
  function loadFrontendEnhancements() {
    loadEnhancement('/js/modules/agents-directory.js', 'tala-agents-directory');
    loadEnhancement('/js/pages/pointeuse-v3.js', 'tala-pointeuse-v3');
    loadEnhancement('/js/pages/pointeuse-v3-admin-ui.js', 'tala-pointeuse-v3-admin-ui');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadFrontendEnhancements, { once: true });
  else loadFrontendEnhancements();
})();

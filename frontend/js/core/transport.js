(function () {
  'use strict';

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

  async function parseResponseJson(res) {
    return res.json().catch(() => ({}));
  }

  function formatErrorMessage(data, status) {
    const suffix = data && data.diagnostic_id ? ` (${data.diagnostic_id})` : '';
    return ((data && data.error) || `Erreur ${status}`) + suffix;
  }

  function create(options = {}) {
    const fetchImpl = options.fetchImpl || window.fetch.bind(window);
    const baseApiUrl = options.baseApiUrl || (window.location.origin + '/api');
    const origin = options.origin || window.location.origin;
    const getToken = options.getToken || (() => '');
    const getBuildId = options.getBuildId || (() => '');
    const notify = options.notify || (() => {});
    const onUnauthorized = options.onUnauthorized || (() => {});

    function headers(extraHeaders = {}) {
      return {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken(),
        'X-Client-Build': getBuildId(),
        ...extraHeaders,
      };
    }

    async function request(path, opts = {}) {
      const { silentStatuses = [], ...fetchOpts } = opts;
      try {
        const res = await fetchImpl(joinBaseAndPath(baseApiUrl, path), {
          ...fetchOpts,
          headers: headers(fetchOpts.headers),
        });
        if (res.status === 401) {
          onUnauthorized();
          return null;
        }
        const data = await parseResponseJson(res);
        if (!res.ok) {
          if (silentStatuses.includes(res.status)) return null;
          notify(formatErrorMessage(data, res.status), 'error');
          return null;
        }
        return data;
      } catch (err) {
        notify('Erreur de connexion au serveur', 'error');
        return null;
      }
    }

    async function fetchApi(path, method, body, opts = {}) {
      const requestOpts = {
        ...opts,
        method,
      };
      if (body !== undefined) requestOpts.body = JSON.stringify(body);
      return request(origin + normalizeApiPath(path), requestOpts);
    }

    return {
      normalizeApiPath,
      request,
      fetchApi,
      get(path, opts) { return fetchApi(path, 'GET', undefined, opts); },
      post(path, body, opts) { return fetchApi(path, 'POST', body, opts); },
      put(path, body, opts) { return fetchApi(path, 'PUT', body, opts); },
      patch(path, body, opts) { return fetchApi(path, 'PATCH', body, opts); },
      delete(path, opts) { return fetchApi(path, 'DELETE', undefined, opts); },
    };
  }

  window.TalaTransport = {
    create,
    normalizeApiPath,
    joinBaseAndPath,
    formatErrorMessage,
  };
})();

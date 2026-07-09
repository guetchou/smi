'use strict';

class DolibarrApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DolibarrApiError';
    this.status = details.status || null;
    this.code = details.code || 'DOLIBARR_API_ERROR';
    this.category = details.category || 'unknown';
    this.retryable = Boolean(details.retryable);
    this.method = details.method || null;
    this.endpoint = details.endpoint || null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      method: this.method,
      endpoint: this.endpoint,
    };
  }
}

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function dolibarrApiRoot(baseUrl) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api/index.php')) return url.toString().replace(/\/$/, '');
  if (path.endsWith('/api')) {
    url.pathname = `${path}/index.php`;
  } else {
    url.pathname = `${path}/api/index.php`;
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function buildDolibarrUrl(baseUrl, resource, query = null) {
  const root = dolibarrApiRoot(baseUrl);
  const url = new URL(`${root}/${trimSlashes(resource)}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) {
    return { category: 'auth_failed', retryable: false, code: `DOLIBARR_HTTP_${status}` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { category: 'retryable_http', retryable: true, code: `DOLIBARR_HTTP_${status}` };
  }
  if (status >= 400) {
    return { category: 'blocked', retryable: false, code: `DOLIBARR_HTTP_${status}` };
  }
  return { category: 'ok', retryable: false, code: 'OK' };
}

function sanitizeErrorMessage(message) {
  return String(message || 'Dolibarr API error')
    .replace(/DOLAPIKEY\s*[:=]\s*[^\s,;]+/gi, 'DOLAPIKEY:[redacted]')
    .replace(/DOLIBARR_API_KEY\s*[:=]\s*[^\s,;]+/gi, 'DOLIBARR_API_KEY:[redacted]');
}

function parseResponseBody(rawText, contentType) {
  if (!rawText) return null;
  if (contentType && contentType.toLowerCase().includes('application/json')) {
    return JSON.parse(rawText);
  }
  try {
    return JSON.parse(rawText);
  } catch (_) {
    return rawText;
  }
}

function createDolibarrClient(config, options = {}) {
  if (!config || !config.enabled) {
    throw new DolibarrApiError('Dolibarr integration is disabled', {
      code: 'DOLIBARR_DISABLED',
      category: 'misconfigured',
      retryable: false,
    });
  }
  if (!config.baseUrl || !config.apiKey) {
    throw new DolibarrApiError('Dolibarr client is not configured', {
      code: 'DOLIBARR_MISCONFIGURED',
      category: 'misconfigured',
      retryable: false,
    });
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new DolibarrApiError('No fetch implementation available for Dolibarr client', {
      code: 'DOLIBARR_FETCH_UNAVAILABLE',
      category: 'misconfigured',
      retryable: false,
    });
  }

  const timeoutMs = config.timeoutMs || 10000;

  async function request(method, resource, { query = null, body = null } = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const url = buildDolibarrUrl(config.baseUrl, resource, query);
    const endpoint = new URL(url).pathname;
    const headers = {
      Accept: 'application/json',
      DOLAPIKEY: config.apiKey,
    };
    if (config.entityId) headers.DOLAPIENTITY = config.entityId;

    const init = {
      method: upperMethod,
      headers,
    };

    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeout = null;
    if (controller) {
      init.signal = controller.signal;
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      throw new DolibarrApiError(aborted ? 'Dolibarr API request timed out' : 'Dolibarr API network error', {
        code: aborted ? 'DOLIBARR_TIMEOUT' : 'DOLIBARR_NETWORK_ERROR',
        category: 'retryable_network',
        retryable: true,
        method: upperMethod,
        endpoint,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const contentType = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type')
      : '';
    const rawText = typeof response.text === 'function' ? await response.text() : '';
    let data;
    try {
      data = parseResponseBody(rawText, contentType);
    } catch (error) {
      throw new DolibarrApiError('Dolibarr API returned invalid JSON', {
        code: 'DOLIBARR_INVALID_JSON',
        category: 'blocked',
        retryable: false,
        status: response.status,
        method: upperMethod,
        endpoint,
      });
    }

    if (!response.ok) {
      const classification = classifyHttpStatus(response.status);
      const remoteMessage = data && typeof data === 'object'
        ? (data.error && (data.error.message || data.error.code)) || data.message
        : data;
      throw new DolibarrApiError(
        sanitizeErrorMessage(remoteMessage || `Dolibarr API HTTP ${response.status}`),
        {
          status: response.status,
          code: classification.code,
          category: classification.category,
          retryable: classification.retryable,
          method: upperMethod,
          endpoint,
        }
      );
    }

    return {
      status: response.status,
      data,
    };
  }

  return {
    request,
    get: (resource, query) => request('GET', resource, { query }),
    post: (resource, body) => request('POST', resource, { body }),
    put: (resource, body) => request('PUT', resource, { body }),
    delete: resource => request('DELETE', resource),
  };
}

module.exports = {
  DolibarrApiError,
  buildDolibarrUrl,
  classifyHttpStatus,
  createDolibarrClient,
  dolibarrApiRoot,
};

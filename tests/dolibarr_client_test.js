'use strict';

const assert = require('assert');
const {
  DolibarrApiError,
  buildDolibarrUrl,
  classifyHttpStatus,
  createDolibarrClient,
  dolibarrApiRoot,
} = require('../backend/services/dolibarr_client');

function response(status, payload, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
  };
}

const config = {
  enabled: true,
  baseUrl: 'https://dolibarr.example.test',
  apiKey: 'test-api-key',
  entityId: '2',
  timeoutMs: 1000,
};

assert.strictEqual(
  dolibarrApiRoot('https://dolibarr.example.test'),
  'https://dolibarr.example.test/api/index.php'
);
assert.strictEqual(
  dolibarrApiRoot('https://dolibarr.example.test/api'),
  'https://dolibarr.example.test/api/index.php'
);
assert.strictEqual(
  dolibarrApiRoot('https://dolibarr.example.test/api/index.php'),
  'https://dolibarr.example.test/api/index.php'
);
assert.strictEqual(
  buildDolibarrUrl('https://dolibarr.example.test', '/thirdparties', { limit: 1, empty: '' }),
  'https://dolibarr.example.test/api/index.php/thirdparties?limit=1'
);

assert.deepStrictEqual(classifyHttpStatus(400), {
  category: 'blocked',
  retryable: false,
  code: 'DOLIBARR_HTTP_400',
});
assert.deepStrictEqual(classifyHttpStatus(403), {
  category: 'auth_failed',
  retryable: false,
  code: 'DOLIBARR_HTTP_403',
});
assert.strictEqual(classifyHttpStatus(503).retryable, true);

async function run() {
  const calls = [];
  const client = createDolibarrClient(config, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, [{ id: 12, name: 'Client A' }]);
    },
  });

  const result = await client.get('thirdparties', { limit: 1 });
  assert.deepStrictEqual(result.data, [{ id: 12, name: 'Client A' }]);
  assert.strictEqual(calls[0].url, 'https://dolibarr.example.test/api/index.php/thirdparties?limit=1');
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(calls[0].init.headers.DOLAPIKEY, 'test-api-key');
  assert.strictEqual(calls[0].init.headers.DOLAPIENTITY, '2');

  const postCalls = [];
  const postClient = createDolibarrClient(config, {
    fetchImpl: async (url, init) => {
      postCalls.push({ url, init });
      return response(201, { id: 44 });
    },
  });
  const postResult = await postClient.post('products', { ref: 'P-001' });
  assert.deepStrictEqual(postResult.data, { id: 44 });
  assert.strictEqual(postCalls[0].init.headers['Content-Type'], 'application/json');
  assert.strictEqual(postCalls[0].init.body, JSON.stringify({ ref: 'P-001' }));

  const blockedClient = createDolibarrClient(config, {
    fetchImpl: async () => response(400, { error: { message: 'Invalid thirdparty' } }),
  });
  await assert.rejects(
    () => blockedClient.post('thirdparties', { name: '' }),
    error => error instanceof DolibarrApiError &&
      error.status === 400 &&
      error.category === 'blocked' &&
      error.retryable === false &&
      error.message === 'Invalid thirdparty'
  );

  const authClient = createDolibarrClient(config, {
    fetchImpl: async () => response(401, { error: { message: 'Bad DOLAPIKEY: test-api-key' } }),
  });
  await assert.rejects(
    () => authClient.get('users'),
    error => error instanceof DolibarrApiError &&
      error.category === 'auth_failed' &&
      !JSON.stringify(error).includes('test-api-key') &&
      !error.message.includes('test-api-key')
  );

  const retryClient = createDolibarrClient(config, {
    fetchImpl: async () => response(503, 'Service unavailable', 'text/plain'),
  });
  await assert.rejects(
    () => retryClient.get('status'),
    error => error instanceof DolibarrApiError &&
      error.status === 503 &&
      error.retryable === true &&
      error.category === 'retryable_http'
  );

  const networkClient = createDolibarrClient(config, {
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(
    () => networkClient.get('status'),
    error => error instanceof DolibarrApiError &&
      error.code === 'DOLIBARR_NETWORK_ERROR' &&
      error.retryable === true
  );

  const timeoutClient = createDolibarrClient(config, {
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  await assert.rejects(
    () => timeoutClient.get('status'),
    error => error instanceof DolibarrApiError &&
      error.code === 'DOLIBARR_TIMEOUT' &&
      error.retryable === true
  );

  const invalidJsonClient = createDolibarrClient(config, {
    fetchImpl: async () => response(200, '{bad json', 'application/json'),
  });
  await assert.rejects(
    () => invalidJsonClient.get('status'),
    error => error instanceof DolibarrApiError &&
      error.code === 'DOLIBARR_INVALID_JSON' &&
      error.retryable === false
  );

  assert.throws(
    () => createDolibarrClient({ enabled: false }),
    error => error instanceof DolibarrApiError && error.code === 'DOLIBARR_DISABLED'
  );

  console.log('dolibarr_client_test: OK');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

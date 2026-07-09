'use strict';

const assert = require('assert');
const {
  loadDolibarrConfig,
  publicDolibarrConfig,
  validateBaseUrl,
} = require('../backend/services/dolibarr_config');

const baseEnv = {
  NODE_ENV: 'production',
  DOLIBARR_ENABLED: 'false',
};

let config = loadDolibarrConfig(baseEnv);
assert.strictEqual(config.enabled, false);
assert.strictEqual(config.baseUrl, null);
assert.strictEqual(config.apiKey, null);
assert.strictEqual(config.bankAccountId, null);
assert.strictEqual(config.timeoutMs, 10000);
assert.strictEqual(config.syncMode, 'manual');

assert.throws(
  () => loadDolibarrConfig({ ...baseEnv, DOLIBARR_ENABLED: 'true' }),
  /DOLIBARR_BASE_URL is required/
);

assert.throws(
  () => loadDolibarrConfig({
    ...baseEnv,
    DOLIBARR_ENABLED: 'true',
    DOLIBARR_BASE_URL: 'https://dolibarr.example.test',
  }),
  /DOLIBARR_API_KEY is required/
);

assert.throws(
  () => loadDolibarrConfig({
    ...baseEnv,
    DOLIBARR_ENABLED: 'true',
    DOLIBARR_BASE_URL: 'http://dolibarr.example.test',
    DOLIBARR_API_KEY: 'test-api-key',
    DOLIBARR_BANK_ACCOUNT_ID: '1',
  }),
  /must use https in production/
);

assert.throws(
  () => loadDolibarrConfig({
    NODE_ENV: 'development',
    DOLIBARR_ENABLED: 'true',
    DOLIBARR_BASE_URL: 'http://localhost:8080',
    DOLIBARR_API_KEY: 'test-api-key',
    DOLIBARR_BANK_ACCOUNT_ID: '1',
  }),
  /blocked local or metadata host/
);

assert.throws(
  () => loadDolibarrConfig({
    NODE_ENV: 'development',
    DOLIBARR_ENABLED: 'true',
    DOLIBARR_BASE_URL: 'http://169.254.169.254/latest',
    DOLIBARR_API_KEY: 'test-api-key',
    DOLIBARR_BANK_ACCOUNT_ID: '1',
  }),
  /blocked local or metadata host/
);

config = loadDolibarrConfig({
  NODE_ENV: 'production',
  DOLIBARR_ENABLED: 'true',
  DOLIBARR_BASE_URL: 'https://dolibarr.example.test/api/',
  DOLIBARR_API_KEY: 'test-api-key',
  DOLIBARR_ENTITY_ID: '2',
  DOLIBARR_BANK_ACCOUNT_ID: '42',
  DOLIBARR_TIMEOUT_MS: '15000',
});
assert.strictEqual(config.enabled, true);
assert.strictEqual(config.baseUrl, 'https://dolibarr.example.test/api');
assert.strictEqual(config.apiKey, 'test-api-key');
assert.strictEqual(config.entityId, '2');
assert.strictEqual(config.bankAccountId, 42);
assert.strictEqual(config.timeoutMs, 15000);

const publicConfig = publicDolibarrConfig(config);
assert.deepStrictEqual(publicConfig, {
  enabled: true,
  baseUrl: 'https://dolibarr.example.test/api',
  apiKeyConfigured: true,
  entityId: '2',
  bankAccountConfigured: true,
  timeoutMs: 15000,
  syncMode: 'manual',
});
assert(!JSON.stringify(publicConfig).includes('test-api-key'));

assert.strictEqual(
  validateBaseUrl('http://localhost:8080/dolibarr', {
    nodeEnv: 'development',
    allowLocal: true,
  }),
  'http://localhost:8080/dolibarr'
);

assert.throws(
  () => loadDolibarrConfig({
    NODE_ENV: 'production',
    DOLIBARR_ENABLED: 'true',
    DOLIBARR_BASE_URL: 'https://dolibarr.example.test',
    DOLIBARR_API_KEY: 'test-api-key',
  }),
  /DOLIBARR_BANK_ACCOUNT_ID/
);

assert.throws(
  () => loadDolibarrConfig({ ...baseEnv, DOLIBARR_TIMEOUT_MS: 'abc' }),
  /DOLIBARR_TIMEOUT_MS/
);

assert.throws(
  () => loadDolibarrConfig({ ...baseEnv, DOLIBARR_SYNC_MODE: 'auto' }),
  /DOLIBARR_SYNC_MODE/
);

console.log('dolibarr_config_test: OK');

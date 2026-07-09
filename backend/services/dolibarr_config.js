'use strict';

const net = require('net');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_SYNC_MODE = 'manual';
const ALLOWED_SYNC_MODES = new Set(['manual', 'disabled']);

function parseBoolean(value) {
  if (value == null || value === '') return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function parseTimeout(value) {
  if (value == null || value === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120000) {
    throw new Error('DOLIBARR_TIMEOUT_MS must be an integer between 1 and 120000');
  }
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeSyncMode(value) {
  const mode = String(value || DEFAULT_SYNC_MODE).trim().toLowerCase();
  if (!ALLOWED_SYNC_MODES.has(mode)) {
    throw new Error(`DOLIBARR_SYNC_MODE must be one of: ${[...ALLOWED_SYNC_MODES].join(', ')}`);
  }
  return mode;
}

function isLoopbackIp(hostname) {
  const ipType = net.isIP(hostname);
  if (ipType === 4) return hostname === '0.0.0.0' || hostname.startsWith('127.');
  if (ipType === 6) return hostname === '::1' || hostname === '::';
  return false;
}

function isBlockedMetadataHost(hostname) {
  const lower = hostname.toLowerCase();
  return (
    lower === '169.254.169.254' ||
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower.endsWith('.metadata.google.internal')
  );
}

function isLocalHostname(hostname) {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || isLoopbackIp(lower);
}

function validateBaseUrl(rawUrl, { nodeEnv = process.env.NODE_ENV, allowLocal = false } = {}) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) throw new Error('DOLIBARR_BASE_URL is required when Dolibarr integration is enabled');

  let url;
  try {
    url = new URL(trimmed);
  } catch (_) {
    throw new Error('DOLIBARR_BASE_URL must be a valid URL');
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('DOLIBARR_BASE_URL must use http or https');
  }

  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('DOLIBARR_BASE_URL must use https in production');
  }

  if (!allowLocal && (isLocalHostname(url.hostname) || isBlockedMetadataHost(url.hostname))) {
    throw new Error('DOLIBARR_BASE_URL targets a blocked local or metadata host');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function loadDolibarrConfig(env = process.env, options = {}) {
  const enabled = parseBoolean(env.DOLIBARR_ENABLED);
  const syncMode = normalizeSyncMode(env.DOLIBARR_SYNC_MODE);
  const timeoutMs = parseTimeout(env.DOLIBARR_TIMEOUT_MS);

  if (!enabled || syncMode === 'disabled') {
    return {
      enabled: false,
      baseUrl: null,
      apiKey: null,
      entityId: null,
      bankAccountId: null,
      timeoutMs,
      syncMode,
    };
  }

  const baseUrl = validateBaseUrl(env.DOLIBARR_BASE_URL, {
    nodeEnv: env.NODE_ENV || options.nodeEnv,
    allowLocal: options.allowLocal === true || parseBoolean(env.DOLIBARR_ALLOW_LOCAL),
  });
  const apiKey = String(env.DOLIBARR_API_KEY || '').trim();
  if (!apiKey) throw new Error('DOLIBARR_API_KEY is required when Dolibarr integration is enabled');
  const bankAccountId = parsePositiveInteger(env.DOLIBARR_BANK_ACCOUNT_ID, 'DOLIBARR_BANK_ACCOUNT_ID');

  return {
    enabled: true,
    baseUrl,
    apiKey,
    entityId: String(env.DOLIBARR_ENTITY_ID || '').trim() || null,
    bankAccountId,
    timeoutMs,
    syncMode,
  };
}

function publicDolibarrConfig(config) {
  return {
    enabled: Boolean(config && config.enabled),
    baseUrl: config && config.baseUrl ? config.baseUrl : null,
    apiKeyConfigured: Boolean(config && config.apiKey),
    entityId: config && config.entityId ? config.entityId : null,
    bankAccountConfigured: Boolean(config && config.bankAccountId),
    timeoutMs: config && config.timeoutMs ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    syncMode: config && config.syncMode ? config.syncMode : DEFAULT_SYNC_MODE,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SYNC_MODE,
  loadDolibarrConfig,
  publicDolibarrConfig,
  validateBaseUrl,
};

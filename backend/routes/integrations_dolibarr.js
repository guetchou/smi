'use strict';

const express = require('express');
const db = require('../db');
const { hasRole } = require('./auth');
const { can } = require('../services/permissions');
const { loadDolibarrConfig, publicDolibarrConfig } = require('../services/dolibarr_config');
const { createDolibarrClient } = require('../services/dolibarr_client');
const { createDolibarrIntegrationService, DolibarrIntegrationError } = require('../services/dolibarr_integration');

function sanitizeJob(row) {
  return {
    id: row.id,
    provider: row.provider,
    job_type: row.job_type,
    local_type: row.local_type,
    local_id: row.local_id,
    status: row.status,
    attempts_count: row.attempts_count,
    next_retry_at: row.next_retry_at || null,
    last_error_code: row.last_error_code || null,
    last_error_message: row.last_error_message || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function sanitizeLink(row) {
  return row ? {
    id: row.id,
    provider: row.provider,
    local_type: row.local_type,
    local_id: row.local_id,
    remote_type: row.remote_type,
    remote_id: row.remote_id,
    remote_ref: row.remote_ref || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  } : null;
}

async function canReadIntegration(user) {
  if (hasRole(user, 'admin', 'finance', 'dg')) return true;
  return can(user, 'audit.view');
}

async function canManageIntegration(user) {
  if (hasRole(user, 'admin', 'finance')) return true;
  return can(user, 'settings.manage');
}

function requireIntegrationRead(req, res, next) {
  canReadIntegration(req.user)
    .then(allowed => {
      if (!allowed) return res.status(403).json({ error: 'Permission integration Dolibarr lecture requise' });
      next();
    })
    .catch(error => res.status(500).json({ error: error.message }));
}

function requireIntegrationManage(req, res, next) {
  canManageIntegration(req.user)
    .then(allowed => {
      if (!allowed) return res.status(403).json({ error: 'Permission integration Dolibarr gestion requise' });
      next();
    })
    .catch(error => res.status(500).json({ error: error.message }));
}

function runtime(deps = {}) {
  const env = deps.env || process.env;
  try {
    const config = deps.config || loadDolibarrConfig(env);
    const client = config.enabled ? (deps.client || createDolibarrClient(config)) : null;
    return {
      config,
      client,
      service: deps.service || createDolibarrIntegrationService({
        db: deps.db || db,
        client,
        config,
      }),
      error: null,
    };
  } catch (error) {
    return {
      config: {
        enabled: false,
        baseUrl: null,
        apiKey: null,
        entityId: null,
        timeoutMs: 10000,
        syncMode: 'manual',
      },
      client: null,
      service: deps.service || createDolibarrIntegrationService({
        db: deps.db || db,
        client: null,
        config: null,
      }),
      error,
    };
  }
}

function createRouter(deps = {}) {
  const router = express.Router();
  const dbc = deps.db || db;

  router.get('/status', requireIntegrationRead, async (_req, res) => {
    const rt = runtime(deps);
    res.json({
      provider: 'dolibarr',
      config: publicDolibarrConfig(rt.config),
      ready: Boolean(rt.config.enabled && !rt.error),
      error: rt.error ? { code: 'DOLIBARR_CONFIG_INVALID', message: rt.error.message } : null,
    });
  });

  router.post('/test', requireIntegrationManage, async (_req, res) => {
    const rt = runtime(deps);
    if (rt.error) return res.status(400).json({ error: rt.error.message, code: 'DOLIBARR_CONFIG_INVALID' });
    if (!rt.config.enabled || !rt.client) return res.status(400).json({ error: 'Integration Dolibarr desactivee', code: 'DOLIBARR_DISABLED' });

    try {
      const result = await rt.client.get('status');
      res.json({
        ok: true,
        provider: 'dolibarr',
        status: result.status,
        config: publicDolibarrConfig(rt.config),
      });
    } catch (error) {
      res.status(error.retryable ? 503 : 400).json({
        ok: false,
        error: error.message,
        code: error.code || 'DOLIBARR_TEST_FAILED',
        retryable: Boolean(error.retryable),
      });
    }
  });

  router.get('/jobs', requireIntegrationRead, async (req, res) => {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const params = ['dolibarr'];
    let where = 'WHERE provider=?';
    if (status) {
      where += ' AND status=?';
      params.push(status);
    }
    params.push(limit);
    const rows = await dbc.query(`
      SELECT *
      FROM integration_jobs
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, params);
    res.json(rows.map(sanitizeJob));
  });

  router.post('/jobs/:id/retry', requireIntegrationManage, async (req, res) => {
    const rt = runtime(deps);
    if (rt.error) return res.status(400).json({ error: rt.error.message, code: 'DOLIBARR_CONFIG_INVALID' });
    if (!rt.config.enabled || !rt.client) return res.status(400).json({ error: 'Integration Dolibarr desactivee', code: 'DOLIBARR_DISABLED' });

    try {
      const job = await rt.service.retryJob(Number(req.params.id), req.user);
      res.json(sanitizeJob(job));
    } catch (error) {
      if (error instanceof DolibarrIntegrationError && error.code === 'JOB_NOT_RETRYABLE') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      if (error instanceof DolibarrIntegrationError && error.code === 'JOB_NOT_FOUND') {
        return res.status(404).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message, code: error.code || 'DOLIBARR_RETRY_FAILED' });
    }
  });

  router.get('/links/:type/:id', requireIntegrationRead, async (req, res) => {
    const row = await dbc.queryOne(`
      SELECT *
      FROM integration_links
      WHERE provider='dolibarr' AND local_type=? AND local_id=?
      LIMIT 1
    `, [req.params.type, Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Lien Dolibarr introuvable' });
    res.json(sanitizeLink(row));
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports.createRouter = createRouter;
module.exports.sanitizeJob = sanitizeJob;
module.exports.sanitizeLink = sanitizeLink;

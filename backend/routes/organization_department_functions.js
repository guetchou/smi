'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { can } = require('../services/permissions');
const workflow = require('../services/department_function_workflow');
const { installDepartmentHierarchyRules } = require('../services/organization_department_hierarchy');
const { installMutationDepartmentFunctions } = require('../services/organization_mutation_department_functions');

installDepartmentHierarchyRules();
installMutationDepartmentFunctions();

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'org-functions');
const ALLOWED_MIME = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});
const MAX_DOCUMENT_BYTES = 7 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function hasPermission(user, code) {
  return Boolean(await can(user, code));
}

async function requirePermission(req, res, code) {
  if (await hasPermission(req.user, code)) return true;
  res.status(403).json({ error: `Permission ${code} requise`, permission: code });
  return false;
}

async function canRead(user) {
  return (await Promise.all([
    hasPermission(user, 'hr.department_function.view'),
    hasPermission(user, 'hr.department_function.create'),
    hasPermission(user, 'hr.department_function.approve'),
    hasPermission(user, 'hr.department_function.report'),
  ])).some(Boolean);
}

function sendWorkflowError(res, error) {
  if (!(error instanceof workflow.DepartmentFunctionWorkflowError) && !error?.code) return false;
  res.status(error.status || 400).json({
    error: error.message,
    code: error.code,
    details: error.details || undefined,
  });
  return true;
}

function decodeDocument(body) {
  const fileName = String(body?.file_name || '').trim();
  const mimeType = String(body?.mime_type || '').trim().toLowerCase();
  const raw = String(body?.content_base64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  const extension = ALLOWED_MIME[mimeType];
  if (!fileName || !raw || !extension) {
    throw new workflow.DepartmentFunctionWorkflowError(
      'Document PDF, JPEG ou PNG obligatoire.',
      'INVALID_DOCUMENT',
      400,
    );
  }
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch (_) { buffer = null; }
  if (!buffer || buffer.length === 0) {
    throw new workflow.DepartmentFunctionWorkflowError('Document illisible.', 'INVALID_DOCUMENT_CONTENT', 400);
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new workflow.DepartmentFunctionWorkflowError('Le document dépasse 7 Mo.', 'DOCUMENT_TOO_LARGE', 413);
  }
  return { fileName, mimeType, extension, buffer };
}

router.get('/departements/capabilities', async (req, res, next) => {
  try {
    const codes = [
      'hr.department_function.view',
      'hr.department_function.create',
      'hr.department_function.submit',
      'hr.department_function.approve',
      'hr.department_function.activate',
      'hr.department_function.close',
      'hr.department_function.attach_document',
      'hr.department_function.report',
    ];
    const values = await Promise.all(codes.map(code => hasPermission(req.user, code)));
    res.json({ permissions: Object.fromEntries(codes.map((code, index) => [code, values[index]])) });
  } catch (error) { next(error); }
});

router.get('/departements', async (req, res, next) => {
  try {
    if (!(await canRead(req.user))) return res.status(403).json({ error: 'Permission de consultation requise' });
    res.json(await workflow.departmentOverview());
  } catch (error) { next(error); }
});

router.get('/departements/:id/fonctions', async (req, res, next) => {
  try {
    if (!(await canRead(req.user))) return res.status(403).json({ error: 'Permission de consultation requise' });
    res.json({
      types: workflow.FUNCTION_LABELS,
      rows: await workflow.list({
        departement_id: req.params.id,
        statut: req.query?.statut,
        historique: req.query?.historique,
      }),
    });
  } catch (error) { next(error); }
});

router.get('/fonctions/:id', async (req, res, next) => {
  try {
    if (!(await canRead(req.user))) return res.status(403).json({ error: 'Permission de consultation requise' });
    const row = await workflow.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Fonction introuvable', code: 'FUNCTION_NOT_FOUND' });
    res.json(row);
  } catch (error) { next(error); }
});

router.post('/departements/:id/fonctions', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.create'))) return;
    const row = await workflow.createDraft({ ...req.body, departement_id: Number(req.params.id) }, req.user?.id);
    res.status(201).json(row);
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.put('/fonctions/:id', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.create'))) return;
    res.json(await workflow.updateDraft(req.params.id, req.body || {}, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/document', async (req, res, next) => {
  let storedPath = null;
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.attach_document'))) return;
    const document = decodeDocument(req.body || {});
    const safeBase = path.basename(document.fileName, path.extname(document.fileName))
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'decision';
    const fileName = `fonction-${Number(req.params.id)}-${Date.now()}-${safeBase}.${document.extension}`;
    storedPath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(storedPath, document.buffer, { flag: 'wx' });
    const hash = crypto.createHash('sha256').update(document.buffer).digest('hex');
    const row = await workflow.attachDocument(req.params.id, {
      version: req.body.version,
      document_nom: document.fileName,
      document_url: `/uploads/org-functions/${fileName}`,
      document_hash: hash,
    }, req.user?.id);
    res.json(row);
  } catch (error) {
    if (storedPath) { try { fs.unlinkSync(storedPath); } catch (_) {} }
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/soumettre', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.submit'))) return;
    res.json(await workflow.submit(req.params.id, req.body?.version, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/approuver', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.approve'))) return;
    res.json(await workflow.approve(req.params.id, req.body?.version, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/refuser', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.approve'))) return;
    res.json(await workflow.refuse(req.params.id, req.body?.version, req.body?.motif, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/activer', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.activate'))) return;
    res.json(await workflow.activate(req.params.id, req.body?.version, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/cloturer', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.close'))) return;
    res.json(await workflow.close(req.params.id, req.body?.version, req.body?.motif, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.delete('/departements/:departmentId/fonctions/:functionId', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.close'))) return;
    res.json(await workflow.close(
      req.params.functionId,
      req.body?.version,
      req.body?.motif || 'Clôture demandée depuis le département',
      req.user?.id,
    ));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.post('/fonctions/:id/annuler', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.close'))) return;
    res.json(await workflow.cancel(req.params.id, req.body?.version, req.body?.motif, req.user?.id));
  } catch (error) {
    if (sendWorkflowError(res, error)) return;
    next(error);
  }
});

router.get('/fonctions-rapport', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.report'))) return;
    res.json(await workflow.report());
  } catch (error) { next(error); }
});

router.post('/fonctions/process-due', async (req, res, next) => {
  try {
    if (!(await requirePermission(req, res, 'hr.department_function.activate'))) return;
    res.json(await workflow.processDue(req.user?.id));
  } catch (error) { next(error); }
});

const workflowTimer = setInterval(() => {
  workflow.processDue(null).catch(error => console.error('[ORG fonctions workflow]', error.message));
}, 60000);
if (typeof workflowTimer.unref === 'function') workflowTimer.unref();
setImmediate(() => workflow.processDue(null).catch(error => console.error('[ORG fonctions workflow initial]', error.message)));

module.exports = router;

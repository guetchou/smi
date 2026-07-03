'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IS_MYSQL = (process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql';
const DEFAULT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MIME_EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

function certificateError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

async function getParam(dbc, key, fallback) {
  const row = await dbc.queryOne('SELECT valeur FROM parametres WHERE cle = ?', [key]);
  return row?.valeur ?? fallback;
}

async function getMedicalCertificatePolicy(dbc) {
  const requiredRaw = String(await getParam(dbc, 'conges_certificat_maladie_obligatoire', '1'));
  const thresholdRaw = Number(await getParam(dbc, 'conges_certificat_maladie_seuil_jours', '1'));
  const maxMbRaw = Number(await getParam(dbc, 'conges_certificat_taille_max_mb', '10'));
  const mimeRaw = String(await getParam(
    dbc,
    'conges_certificat_types',
    DEFAULT_MIME_TYPES.join(','),
  ));

  const allowedMimeTypes = mimeRaw.split(',').map(value => value.trim()).filter(Boolean);
  return {
    required: ['1', 'true', 'oui', 'yes'].includes(requiredRaw.trim().toLowerCase()),
    thresholdDays: Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 1,
    maxBytes: (Number.isFinite(maxMbRaw) && maxMbRaw > 0 ? maxMbRaw : 10) * 1024 * 1024,
    allowedMimeTypes: allowedMimeTypes.length ? allowedMimeTypes : DEFAULT_MIME_TYPES,
  };
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw certificateError('Contenu du certificat médical obligatoire');
  }
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(normalized)) {
    throw certificateError('Certificat médical encodé en base64 invalide');
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) throw certificateError('Certificat médical vide');
  return buffer;
}

function detectedMimeType(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50
    && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a
    && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

function sanitizeOriginalName(value, mimeType) {
  const base = path.basename(String(value || `certificat${MIME_EXTENSIONS[mimeType] || ''}`))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^A-Za-z0-9À-ÿ._ -]/g, '_')
    .slice(0, 180);
  if (!base || base === '.' || base === '..') {
    return `certificat${MIME_EXTENSIONS[mimeType] || ''}`;
  }
  return base;
}

function prepareMedicalCertificate(document, policy) {
  if (!document) return null;
  const mimeType = String(document.mimeType || document.mimetype || '').trim().toLowerCase();
  const buffer = Buffer.isBuffer(document.buffer)
    ? document.buffer
    : decodeBase64(document.base64 || document.contentBase64 || document.content);

  if (buffer.length > policy.maxBytes) {
    throw certificateError(
      `Certificat médical trop volumineux (${buffer.length} octets)`,
      413,
      { max_bytes: policy.maxBytes },
    );
  }

  const actualMimeType = detectedMimeType(buffer);
  if (!actualMimeType) {
    throw certificateError('Signature de fichier certificat médical invalide', 415);
  }
  if (actualMimeType !== mimeType) {
    throw certificateError('Le type MIME déclaré ne correspond pas au contenu du certificat', 415);
  }
  if (!policy.allowedMimeTypes.includes(actualMimeType)) {
    throw certificateError(`Type de certificat non autorisé : ${actualMimeType}`, 415);
  }

  const extension = MIME_EXTENSIONS[actualMimeType];
  const originalName = sanitizeOriginalName(document.originalName || document.originalname, actualMimeType);
  const originalExtension = path.extname(originalName).toLowerCase();
  const acceptedExtensions = actualMimeType === 'image/jpeg' ? ['.jpg', '.jpeg'] : [extension];
  if (!acceptedExtensions.includes(originalExtension)) {
    throw certificateError('Extension du certificat incompatible avec son contenu', 415);
  }

  return {
    buffer,
    mimeType: actualMimeType,
    originalName,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    extension,
  };
}

async function ensureSqliteSchema(dbc) {
  if (IS_MYSQL) return;
  await dbc.execute(`
    CREATE TABLE IF NOT EXISTS employes_conges_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conge_id INTEGER NOT NULL,
      type_document TEXT NOT NULL,
      nom_original TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      taille_octets INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      statut TEXT NOT NULL DEFAULT 'actif',
      depose_par INTEGER NOT NULL,
      depose_at TEXT NOT NULL DEFAULT (datetime('now')),
      remplace_document_id INTEGER,
      supprime_logiquement_at TEXT,
      supprime_logiquement_par INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(conge_id, type_document, version)
    )
  `);
}

function storageRoot() {
  return path.resolve(
    process.env.LEAVE_DOCUMENTS_DIR
      || path.join(__dirname, '..', 'data', 'private', 'leave-documents'),
  );
}

async function persistMedicalCertificate(dbc, {
  leaveId,
  actorId,
  certificate,
  replaceDocumentId = null,
}) {
  if (!certificate) return null;
  await ensureSqliteSchema(dbc);

  const previous = await dbc.queryOne(`
    SELECT id, version
    FROM employes_conges_documents
    WHERE conge_id = ? AND type_document = 'certificat_medical' AND statut = 'actif'
    ORDER BY version DESC LIMIT 1
  `, [leaveId]);
  const version = Number(previous?.version || 0) + 1;

  const relativeKey = path.posix.join(
    'leave-documents',
    String(leaveId),
    `${crypto.randomUUID()}${certificate.extension}`,
  );
  if (relativeKey.includes('..')) throw certificateError('Clé de stockage invalide');

  const absolutePath = path.resolve(storageRoot(), String(leaveId), path.basename(relativeKey));
  const expectedRoot = `${storageRoot()}${path.sep}`;
  if (!absolutePath.startsWith(expectedRoot)) throw certificateError('Chemin de stockage invalide');

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, certificate.buffer, { mode: 0o600, flag: 'wx' });

  try {
    if (previous) {
      await dbc.execute(`
        UPDATE employes_conges_documents
        SET statut = 'remplace', updated_at = ${IS_MYSQL ? 'NOW()' : "datetime('now')"}
        WHERE id = ?
      `, [previous.id]);
    }

    const inserted = await dbc.execute(`
      INSERT INTO employes_conges_documents
        (conge_id, type_document, nom_original, mime_type, taille_octets,
         storage_key, sha256, version, statut, depose_par, remplace_document_id)
      VALUES (?, 'certificat_medical', ?, ?, ?, ?, ?, ?, 'actif', ?, ?)
    `, [
      leaveId,
      certificate.originalName,
      certificate.mimeType,
      certificate.size,
      relativeKey,
      certificate.sha256,
      version,
      actorId,
      replaceDocumentId || previous?.id || null,
    ]);

    await dbc.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      [
        'employes_conges_documents',
        inserted.insertId,
        previous ? 'replace' : 'deposit',
        JSON.stringify({
          conge_id: leaveId,
          type_document: 'certificat_medical',
          version,
          mime_type: certificate.mimeType,
          taille_octets: certificate.size,
          sha256: certificate.sha256,
          previous_document_id: previous?.id || null,
        }),
        actorId,
      ],
    );

    return {
      id: inserted.insertId,
      storageKey: relativeKey,
      absolutePath,
      sha256: certificate.sha256,
      version,
    };
  } catch (error) {
    fs.rmSync(absolutePath, { force: true });
    throw error;
  }
}

function cleanupPersistedCertificate(result) {
  if (result?.absolutePath) fs.rmSync(result.absolutePath, { force: true });
}

async function getActiveMedicalCertificate(dbc, leaveId) {
  await ensureSqliteSchema(dbc);
  return dbc.queryOne(`
    SELECT *
    FROM employes_conges_documents
    WHERE conge_id = ? AND type_document = 'certificat_medical' AND statut = 'actif'
    ORDER BY version DESC LIMIT 1
  `, [leaveId]);
}

async function softDeleteMedicalCertificate(dbc, {
  documentId,
  actorId,
  leaveStatus,
}) {
  if (['approuve', 'termine'].includes(String(leaveStatus || ''))) {
    throw certificateError(
      'Suppression interdite après approbation du congé',
      409,
    );
  }
  const result = await dbc.execute(`
    UPDATE employes_conges_documents
    SET statut = 'supprime',
        supprime_logiquement_at = ${IS_MYSQL ? 'NOW()' : "datetime('now')"},
        supprime_logiquement_par = ?,
        updated_at = ${IS_MYSQL ? 'NOW()' : "datetime('now')"}
    WHERE id = ? AND statut = 'actif'
  `, [actorId, documentId]);
  if (!result.affectedRows) throw certificateError('Certificat médical actif introuvable', 404);
}

module.exports = {
  certificateError,
  cleanupPersistedCertificate,
  detectedMimeType,
  getActiveMedicalCertificate,
  getMedicalCertificatePolicy,
  persistMedicalCertificate,
  prepareMedicalCertificate,
  sanitizeOriginalName,
  softDeleteMedicalCertificate,
};

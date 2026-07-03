'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  detectedMimeType,
  prepareMedicalCertificate,
  sanitizeOriginalName,
} = require('../backend/services/leave_medical_certificate');

const policy = {
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
};

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

assert.strictEqual(detectedMimeType(pdf), 'application/pdf');
assert.strictEqual(detectedMimeType(jpeg), 'image/jpeg');
assert.strictEqual(detectedMimeType(png), 'image/png');

const preparedPdf = prepareMedicalCertificate({
  originalName: '../../certificat.pdf',
  mimeType: 'application/pdf',
  base64: pdf.toString('base64'),
}, policy);

assert.strictEqual(preparedPdf.mimeType, 'application/pdf');
assert.strictEqual(preparedPdf.originalName, 'certificat.pdf');
assert.strictEqual(preparedPdf.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));

assert.throws(() => prepareMedicalCertificate({
  originalName: 'faux.pdf',
  mimeType: 'application/pdf',
  base64: Buffer.from('pas un pdf').toString('base64'),
}, policy), error => error.status === 415);

assert.throws(() => prepareMedicalCertificate({
  originalName: 'image.pdf',
  mimeType: 'application/pdf',
  base64: jpeg.toString('base64'),
}, policy), error => error.status === 415);

assert.throws(() => prepareMedicalCertificate({
  originalName: 'certificat.exe',
  mimeType: 'application/pdf',
  base64: pdf.toString('base64'),
}, policy), error => error.status === 415);

assert.throws(() => prepareMedicalCertificate({
  originalName: 'trop-grand.pdf',
  mimeType: 'application/pdf',
  base64: pdf.toString('base64'),
}, { ...policy, maxBytes: 4 }), error => error.status === 413);

assert.strictEqual(
  sanitizeOriginalName('../../../../secret.pdf', 'application/pdf'),
  'secret.pdf',
);

console.log('leave_medical_certificate_test: OK');

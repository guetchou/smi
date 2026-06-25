'use strict';

const DECIMAL_15_2_MAX = 9999999999999.99;
const DEFAULT_NUMERIC_FIELDS = [
  'montant',
  'recette',
  'depense',
  'cash_receipt_attachment_threshold',
];

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function normalizeScale(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseAmount(value, fallback = 0) {
  if (isBlank(value)) return fallback;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > DECIMAL_15_2_MAX) return NaN;
    return normalizeScale(value);
  }

  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (!Number.isSafeInteger(converted) || Math.abs(converted) > DECIMAL_15_2_MAX) return NaN;
    return converted;
  }

  if (typeof value !== 'string') return NaN;

  let raw = value
    .replace(/\u2212/g, '-')
    .replace(/\b(?:XAF|FCFA|CFA|F\s*CFA)\b/gi, '')
    .trim();

  if (!raw) return fallback;
  if (/[^0-9+\-.,\s\u00A0\u202F\u2009']/u.test(raw)) return NaN;

  raw = raw.replace(/[\s\u00A0\u202F\u2009']/g, '');
  if (!/^[+-]?[0-9][0-9.,]*$/.test(raw)) return NaN;
  if (/[+-]/.test(raw.slice(1))) return NaN;

  const sign = raw.startsWith('-') ? '-' : '';
  const unsigned = raw.replace(/^[+-]/, '');
  const commaCount = (unsigned.match(/,/g) || []).length;
  const dotCount = (unsigned.match(/\./g) || []).length;
  let normalized = unsigned;

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = unsigned.lastIndexOf(',') > unsigned.lastIndexOf('.') ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = unsigned.split(thousandsSeparator).join('');
    if ((normalized.match(new RegExp(`\\${decimalSeparator}`, 'g')) || []).length > 1) return NaN;
    if (decimalSeparator === ',') normalized = normalized.replace(',', '.');
  } else if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? ',' : '.';
    const parts = unsigned.split(separator);
    if (parts.some(part => part === '')) return NaN;

    if (parts.length === 2) {
      const [head, tail] = parts;
      if (tail.length <= 2) {
        normalized = `${head}.${tail}`;
      } else if (tail.length === 3 && head.length >= 1 && head.length <= 3) {
        normalized = `${head}${tail}`;
      } else {
        return NaN;
      }
    } else {
      const validThousands = parts[0].length >= 1
        && parts[0].length <= 3
        && parts.slice(1).every(part => part.length === 3);
      if (!validThousands) return NaN;
      normalized = parts.join('');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return NaN;

  const parsed = Number(`${sign}${normalized}`);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > DECIMAL_15_2_MAX) return NaN;
  return normalizeScale(parsed);
}

function normalizeNumericFieldsInPlace(body, fields = DEFAULT_NUMERIC_FIELDS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

  fields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      body[field] = parseAmount(body[field], 0);
    }
  });

  return body;
}

module.exports = {
  parseAmount,
  normalizeNumericFieldsInPlace,
};

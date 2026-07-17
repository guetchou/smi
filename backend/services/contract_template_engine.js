'use strict';

const PLACEHOLDER = /{{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*}}/gi;
const DANGEROUS_CONTENT = /<\s*script\b|\bon\w+\s*=|javascript\s*:|data\s*:\s*text\/html/i;

function walkStrings(value, visitor) {
  if (typeof value === 'string') return visitor(value);
  if (Array.isArray(value)) return value.map(item => walkStrings(item, visitor));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walkStrings(child, visitor)]));
  }
  return value;
}

function extractVariables(content) {
  const found = new Set();
  walkStrings(content, text => {
    for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]);
    return text;
  });
  return [...found].sort();
}

function getPath(values, path) {
  return path.split('.').reduce((current, key) => current?.[key], values);
}

function validateTemplate(content, catalog = []) {
  const serialized = JSON.stringify(content);
  if (DANGEROUS_CONTENT.test(serialized)) throw new Error('Contenu actif ou dangereux interdit');
  const variables = extractVariables(content);
  const allowed = new Set(catalog.map(item => typeof item === 'string' ? item : item.path));
  const unknown = variables.filter(variable => !allowed.has(variable));
  return { ok: unknown.length === 0, variables, unknown };
}

function renderTemplate(content, values, catalog = []) {
  const validation = validateTemplate(content, catalog);
  const required = new Set(catalog.filter(item => typeof item === 'object' && item.required).map(item => item.path));
  const missing = [];
  const rendered = walkStrings(content, text => text.replace(PLACEHOLDER, (_full, path) => {
    const value = getPath(values, path);
    if (value === null || value === undefined || value === '') {
      if (required.has(path) || validation.variables.includes(path)) missing.push(path);
      return '';
    }
    return String(value);
  }));
  return {
    ok: validation.unknown.length === 0 && missing.length === 0,
    rendered,
    unknown: validation.unknown,
    missing: [...new Set(missing)].sort(),
  };
}

module.exports = { extractVariables, validateTemplate, renderTemplate };

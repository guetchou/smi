'use strict';

const MONEY_PRECISION = 2;

function amount(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} doit etre un montant positif ou nul`);
  return number;
}

function round(value, precision = MONEY_PRECISION) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeComponent(component, index) {
  if (!component || !component.code || !component.label || !component.category) {
    throw new Error(`Rubrique ${index + 1}: code, label et category requis`);
  }
  return {
    code: String(component.code),
    label: String(component.label),
    category: String(component.category),
    amount: amount(component.amount, component.code),
    includeInGross: component.includeInGross !== false,
    socialSubject: component.socialSubject === true,
    taxSubject: component.taxSubject === true,
    displayOnContract: component.displayOnContract !== false,
    periodicity: component.periodicity || 'mensuel',
  };
}

function progressiveTax(base, taxRules, fiscalParts) {
  const brackets = Array.isArray(taxRules.brackets) ? taxRules.brackets : [];
  if (!brackets.length) throw new Error('Bareme fiscal publie requis');
  const parts = taxRules.divideByFiscalParts ? amount(fiscalParts, 'fiscalParts') : 1;
  if (parts <= 0) throw new Error('fiscalParts doit etre superieur a zero');
  const quotient = base / parts;
  let taxPerPart = 0;
  let previousTo = 0;
  const sortedBrackets = [...brackets].sort((left, right) => Number(left.from || 0) - Number(right.from || 0));
  for (const bracket of sortedBrackets) {
    const from = amount(bracket.from || 0, 'bracket.from');
    const to = bracket.to === null || bracket.to === undefined ? Infinity : amount(bracket.to, 'bracket.to');
    const rate = amount(bracket.rate, 'bracket.rate');
    if (to <= from || rate > 100) throw new Error('Tranche fiscale invalide');
    if (from < previousTo) throw new Error('Tranches fiscales chevauchantes');
    previousTo = to;
    if (quotient <= from) continue;
    taxPerPart += Math.max(0, Math.min(quotient, to) - from) * rate / 100;
  }
  return round(taxPerPart * parts);
}

function validatePayrollRules(social, tax) {
  const errors = [];
  for (const field of ['employeeRate', 'employerRate']) {
    const rate = Number(social?.[field]);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.push(`social.${field}`);
  }
  if (tax?.mode !== 'progressive' || !Array.isArray(tax.brackets) || !tax.brackets.length) {
    errors.push('tax.brackets');
  } else {
    try { progressiveTax(0, tax, 1); } catch (error) { errors.push(error.message); }
  }
  if (tax?.requiredPersonalFields !== undefined && !Array.isArray(tax.requiredPersonalFields)) {
    errors.push('tax.requiredPersonalFields');
  }
  return [...new Set(errors)];
}

function calculateContractRemuneration(input = {}) {
  const components = (input.components || []).map(normalizeComponent);
  const componentCodes = components.map(item => item.code);
  if (new Set(componentCodes).size !== componentCodes.length) {
    throw new Error('Un code de rubrique duplique est interdit');
  }
  if (!components.some(item => item.category === 'salaire_base')) {
    throw new Error('Une rubrique salaire_base est obligatoire');
  }

  const social = input.rules?.social || null;
  const tax = input.rules?.tax || null;
  const missingInputs = [];
  if (!social || !Number.isFinite(Number(social.employeeRate)) || !Number.isFinite(Number(social.employerRate))) {
    missingInputs.push('regles_sociales_publiees');
  }
  if (!tax || tax.mode !== 'progressive' || !Array.isArray(tax.brackets) || tax.brackets.length === 0) {
    missingInputs.push('bareme_fiscal_publie');
  }
  for (const field of tax?.requiredPersonalFields || []) {
    if (input.employeeTaxProfile?.[field] === null || input.employeeTaxProfile?.[field] === undefined || input.employeeTaxProfile?.[field] === '') {
      missingInputs.push(`profil_fiscal.${field}`);
    }
  }
  if (!missingInputs.length) {
    const ruleErrors = validatePayrollRules(social, tax);
    if (ruleErrors.length) throw new Error(`Jeu de regles invalide: ${ruleErrors.join(', ')}`);
  }

  const grossTotal = round(components.filter(item => item.includeInGross && item.category !== 'retenue').reduce((sum, item) => sum + item.amount, 0));
  const socialBase = round(components.filter(item => item.includeInGross && item.socialSubject && item.category !== 'retenue').reduce((sum, item) => sum + item.amount, 0));
  const rawTaxBase = round(components.filter(item => item.includeInGross && item.taxSubject && item.category !== 'retenue').reduce((sum, item) => sum + item.amount, 0));
  const otherDeductions = round(components.filter(item => item.category === 'retenue').reduce((sum, item) => sum + item.amount, 0));

  const employeeSocial = social ? round(socialBase * amount(social.employeeRate, 'social.employeeRate') / 100) : null;
  const employerSocial = social ? round(socialBase * amount(social.employerRate, 'social.employerRate') / 100) : null;
  const fiscalBase = employeeSocial === null
    ? null
    : round(Math.max(0, rawTaxBase - (tax?.deductEmployeeSocial === true ? employeeSocial : 0)));

  let incomeTax = null;
  if (!missingInputs.length) {
    incomeTax = progressiveTax(fiscalBase, tax, input.employeeTaxProfile?.fiscalParts || 1);
  }
  const totalDeductions = incomeTax === null || employeeSocial === null
    ? null
    : round(employeeSocial + incomeTax + otherDeductions);
  const netPayable = totalDeductions === null ? null : round(grossTotal - totalDeductions);
  if (netPayable !== null && netPayable < 0) throw new Error('Les retenues ne peuvent pas depasser le montant brut');

  return {
    status: missingInputs.length ? 'a_verifier' : 'calcule',
    currency: input.currency || 'XAF',
    components,
    grossTotal,
    socialBase,
    employeeSocial,
    employerSocial,
    fiscalBase,
    incomeTax,
    otherDeductions,
    totalDeductions,
    netPayable,
    missingInputs: [...new Set(missingInputs)],
    assumptions: [
      'Exoneration fiscale et soumission sociale evaluees separement par rubrique.',
      'Les taux et le bareme proviennent exclusivement du jeu de regles versionne.',
    ],
  };
}

function calculateContractEndDate(startDate, durationValue, durationUnit, convention) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) throw new Error('date_debut invalide');
  const value = Number(durationValue);
  if (!Number.isInteger(value) || value <= 0) throw new Error('duree positive obligatoire');
  if (!['jour', 'mois', 'annee'].includes(durationUnit)) throw new Error('unite de duree invalide');
  if (!['inclusive', 'exclusive'].includes(convention)) throw new Error('convention de date de fin obligatoire');

  const [year, month, day] = startDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('date_debut invalide');
  }
  if (durationUnit === 'jour') date.setUTCDate(date.getUTCDate() + value);
  if (durationUnit === 'mois' || durationUnit === 'annee') {
    const targetMonth = month - 1 + (durationUnit === 'mois' ? value : value * 12);
    const targetYear = year + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
    date.setUTCFullYear(targetYear, normalizedMonth, Math.min(day, lastDay));
  }
  if (convention === 'inclusive') date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

module.exports = {
  calculateContractRemuneration,
  calculateContractEndDate,
  progressiveTax,
  validatePayrollRules,
};

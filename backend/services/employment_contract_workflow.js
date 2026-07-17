'use strict';

const crypto = require('crypto');
const { calculateContractEndDate, calculateContractRemuneration } = require('./contract_remuneration');
const { renderTemplate } = require('./contract_template_engine');

const TRANSITIONS = Object.freeze({
  brouillon: new Set(['en_verification', 'annule']),
  en_verification: new Set(['brouillon', 'valide', 'annule']),
  valide: new Set(['signe', 'archive', 'annule']),
  signe: new Set(['archive']),
  archive: new Set(),
  annule: new Set(),
});

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function assertTransition(fromStatus, toStatus) {
  if (!TRANSITIONS[fromStatus]?.has(toStatus)) {
    throw new Error(`Transition interdite: ${fromStatus} -> ${toStatus}`);
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function buildReference(employee, now = new Date()) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const matricule = String(employee.matricule || employee.id).replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CT-${date}-${matricule}-${suffix}`;
}

function contractValues({ employee, company, input, remuneration }) {
  return {
    entreprise: {
      raison_sociale: cleanText(company.raison_sociale),
      forme_juridique: cleanText(company.forme_juridique),
      rccm: cleanText(company.rccm),
      nif: cleanText(company.nif),
      adresse: cleanText(company.adresse),
      ville: cleanText(company.ville),
      pays: cleanText(company.pays),
      telephone: cleanText(company.telephone),
      email: cleanText(company.email),
      representant: cleanText(company.directeur_general),
    },
    agent: {
      id: employee.id,
      matricule: cleanText(employee.matricule),
      nom: cleanText(employee.nom),
      prenom: cleanText(employee.prenom),
      civilite: employee.sexe === 'F' ? 'Madame' : 'Monsieur',
      date_naissance: employee.date_naissance,
      lieu_naissance: cleanText(employee.lieu_naissance),
      nationalite: cleanText(employee.nationalite),
      adresse: cleanText(employee.adresse),
      numero_identite: cleanText(employee.num_piece_identite),
      cnss: cleanText(employee.cnss),
    },
    contrat: {
      type: cleanText(input.typeContrat),
      intitule: cleanText(input.intitule),
      date_signature: input.dateSignature || null,
      date_debut: input.dateDebut,
      date_fin: input.dateFin,
      fonction: cleanText(input.fonction),
      classification: cleanText(input.classification),
      service: cleanText(input.service),
      lieu_travail: cleanText(input.lieuTravail),
      temps_travail_hebdomadaire: input.tempsTravailHebdomadaire,
      horaires: cleanText(input.horaires),
      periode_essai: input.periodeEssaiValeur
        ? `${input.periodeEssaiValeur} ${input.periodeEssaiUnite}`
        : '',
    },
    remuneration: {
      devise: remuneration.currency,
      brut: remuneration.grossTotal,
      base_sociale: remuneration.socialBase,
      cotisation_salariale: remuneration.employeeSocial,
      cotisation_employeur: remuneration.employerSocial,
      base_fiscale: remuneration.fiscalBase,
      impot: remuneration.incomeTax,
      net: remuneration.netPayable,
    },
  };
}

function validateContractDraft({ employee, company, templateVersion, ruleSet, input }) {
  const errors = [];
  if (!employee?.id || employee.actif === 0) errors.push('agent_actif_requis');
  if (!company?.id) errors.push('entreprise_active_requise');
  if (!templateVersion?.id || templateVersion.statut !== 'publie') errors.push('modele_publie_requis');
  if (templateVersion?.template_type && String(templateVersion.template_type).toLowerCase() !== String(input?.typeContrat || '').toLowerCase()) {
    errors.push('modele_incompatible_avec_type_contrat');
  }
  if (!input?.dateDebut) errors.push('contrat.date_debut');
  if (!input?.typeContrat) errors.push('contrat.type');
  if (!input?.intitule) errors.push('contrat.intitule');
  if (!input?.fonction) errors.push('contrat.fonction');

  let dateFin = input?.dateFin || null;
  if (!dateFin && input?.dureeValeur && input?.dureeUnite) {
    try {
      dateFin = calculateContractEndDate(
        input.dateDebut,
        Number(input.dureeValeur),
        input.dureeUnite,
        input.dateEndConvention
      );
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (String(input?.typeContrat || '').toLowerCase() === 'cdd' && !dateFin) {
    errors.push('contrat.date_fin_cdd');
  }
  if (dateFin && input?.dateDebut && dateFin < input.dateDebut) errors.push('contrat.date_fin_avant_date_debut');
  if (input?.dateSignature && input?.dateDebut && input.dateSignature > input.dateDebut) errors.push('contrat.signature_apres_date_debut');
  if (ruleSet?.statut === 'publie' && input?.dateDebut) {
    if (ruleSet.date_effet > input.dateDebut || (ruleSet.date_fin && ruleSet.date_fin < input.dateDebut)) {
      errors.push('jeu_regles_hors_periode');
    }
  }

  let remuneration = null;
  try {
    remuneration = calculateContractRemuneration({
      components: input?.components || [],
      employeeTaxProfile: input?.employeeTaxProfile || {},
      rules: ruleSet?.statut === 'publie' ? {
        social: parseJson(ruleSet.social_rules, null),
        tax: parseJson(ruleSet.tax_rules, null),
        rounding: parseJson(ruleSet.rounding_rules, null),
      } : null,
      currency: company?.devise || 'XAF',
    });
    errors.push(...remuneration.missingInputs);
  } catch (error) {
    errors.push(error.message);
  }

  const normalizedInput = { ...input, dateFin };
  const values = remuneration ? contractValues({ employee, company, input: normalizedInput, remuneration }) : {};
  const content = parseJson(templateVersion?.content_json, {});
  const catalog = parseJson(templateVersion?.variable_catalog_json, []);
  const rendered = renderTemplate(content, values, catalog);
  errors.push(...rendered.unknown.map(path => `variable_inconnue:${path}`));
  errors.push(...rendered.missing.map(path => `variable_manquante:${path}`));

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    input: normalizedInput,
    values,
    remuneration,
    clauses: rendered.rendered,
    missingVariables: rendered.missing,
  };
}

module.exports = {
  TRANSITIONS,
  assertTransition,
  buildReference,
  contractValues,
  parseJson,
  validateContractDraft,
};

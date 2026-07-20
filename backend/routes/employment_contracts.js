'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requirePermission } = require('../services/permissions');
const { validatePayrollRules } = require('../services/contract_remuneration');
const {
  assertTransition,
  buildReference,
  parseJson,
  validateContractDraft,
} = require('../services/employment_contract_workflow');
const { buildDocx, buildPdf } = require('../services/employment_contract_documents');

const router = express.Router();
const documentRoot = process.env.EMPLOYMENT_CONTRACT_DOCUMENT_ROOT
  || path.join(__dirname, '..', 'data', 'uploads', 'employment-contracts');

function json(value) {
  return JSON.stringify(value ?? null);
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function publicContract(row) {
  if (!row) return null;
  return {
    ...row,
    values_snapshot: parseJson(row.values_snapshot, {}),
    remuneration_snapshot: parseJson(row.remuneration_snapshot, {}),
    rules_snapshot: parseJson(row.rules_snapshot, null),
    clauses_snapshot: parseJson(row.clauses_snapshot, {}),
    missing_variables_json: parseJson(row.missing_variables_json, []),
    validation_errors_json: parseJson(row.validation_errors_json, []),
  };
}

async function loadContext(input, executor = db) {
  const [employee, company, templateVersion, ruleSet] = await Promise.all([
    executor.queryOne('SELECT * FROM employes WHERE id=?', [input.employeId]),
    executor.queryOne('SELECT * FROM entreprise WHERE actif=1 LIMIT 1'),
    executor.queryOne(`
      SELECT tv.*, t.code AS template_code, t.nom AS template_nom, t.type_contrat AS template_type
      FROM employment_contract_template_versions tv
      JOIN employment_contract_templates t ON t.id=tv.template_id
      WHERE tv.id=? AND t.actif=1
    `, [input.templateVersionId]),
    input.payrollRuleSetId
      ? executor.queryOne('SELECT * FROM payroll_rule_sets WHERE id=?', [input.payrollRuleSetId])
      : Promise.resolve(null),
  ]);
  return { employee, company, templateVersion, ruleSet };
}

function normalizeInput(body, existing = {}) {
  const components = Array.isArray(body.components) ? body.components : (existing.components || []);
  return {
    employeId: Number(body.employeId ?? existing.employeId),
    templateVersionId: Number(body.templateVersionId ?? existing.templateVersionId),
    payrollRuleSetId: numberOrNull(body.payrollRuleSetId ?? existing.payrollRuleSetId),
    typeContrat: body.typeContrat ?? existing.typeContrat,
    intitule: body.intitule ?? existing.intitule,
    dateSignature: body.dateSignature ?? existing.dateSignature ?? null,
    dateDebut: body.dateDebut ?? existing.dateDebut,
    dateFin: body.dateFin ?? existing.dateFin ?? null,
    dureeValeur: numberOrNull(body.dureeValeur ?? existing.dureeValeur),
    dureeUnite: body.dureeUnite ?? existing.dureeUnite ?? null,
    dateEndConvention: body.dateEndConvention ?? existing.dateEndConvention ?? null,
    periodeEssaiValeur: numberOrNull(body.periodeEssaiValeur ?? existing.periodeEssaiValeur),
    periodeEssaiUnite: body.periodeEssaiUnite ?? existing.periodeEssaiUnite ?? null,
    fonction: body.fonction ?? existing.fonction,
    classification: body.classification ?? existing.classification ?? null,
    service: body.service ?? existing.service ?? null,
    lieuTravail: body.lieuTravail ?? existing.lieuTravail ?? null,
    tempsTravailHebdomadaire: numberOrNull(body.tempsTravailHebdomadaire ?? existing.tempsTravailHebdomadaire),
    horaires: body.horaires ?? existing.horaires ?? null,
    tasks: Array.isArray(body.tasks) ? body.tasks : (existing.tasks || []),
    localClause: body.localClause ?? existing.localClause ?? '',
    employeeTaxProfile: body.employeeTaxProfile || existing.employeeTaxProfile || {},
    components,
  };
}

function rulesSnapshot(ruleSet) {
  if (!ruleSet) return null;
  return {
    id: ruleSet.id,
    code: ruleSet.code,
    version: ruleSet.version,
    date_effet: ruleSet.date_effet,
    date_fin: ruleSet.date_fin,
    social: parseJson(ruleSet.social_rules, null),
    tax: parseJson(ruleSet.tax_rules, null),
    rounding: parseJson(ruleSet.rounding_rules, null),
    legal_references: parseJson(ruleSet.legal_references, []),
  };
}

async function saveComponents(executor, contractId, components) {
  await executor.execute('DELETE FROM employment_contract_components WHERE contract_id=?', [contractId]);
  for (const [index, component] of components.entries()) {
    await executor.execute(`
      INSERT INTO employment_contract_components
        (contract_id,code,libelle,category,amount,include_in_gross,social_subject,tax_subject,
         display_on_contract,calculation_mode,calculation_config,periodicity,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,'fixe',NULL,?,?)
    `, [
      contractId, component.code, component.label, component.category, component.amount,
      component.includeInGross ? 1 : 0, component.socialSubject ? 1 : 0,
      component.taxSubject ? 1 : 0, component.displayOnContract ? 1 : 0,
      component.periodicity || 'mensuel', index,
    ]);
  }
}

async function addEvent(executor, contractId, eventType, fromStatus, toStatus, details, actorUserId) {
  await executor.execute(`
    INSERT INTO employment_contract_events
      (contract_id,event_type,from_status,to_status,details,actor_user_id)
    VALUES (?,?,?,?,?,?)
  `, [contractId, eventType, fromStatus, toStatus, json(details), actorUserId]);
}

async function hydrateContract(id) {
  const contract = await db.queryOne(`
    SELECT c.*, e.nom AS agent_nom, e.prenom AS agent_prenom, e.matricule AS agent_matricule,
           tv.titre AS template_title, tv.version AS template_version
    FROM employment_contracts c
    JOIN employes e ON e.id=c.employe_id
    JOIN employment_contract_template_versions tv ON tv.id=c.template_version_id
    WHERE c.id=?
  `, [id]);
  if (!contract) return null;
  const [components, documents, events] = await Promise.all([
    db.query('SELECT * FROM employment_contract_components WHERE contract_id=? ORDER BY sort_order,id', [id]),
    db.query('SELECT id,format,filename,sha256,file_size,generated_at,generated_by FROM employment_contract_documents WHERE contract_id=? ORDER BY generated_at DESC', [id]),
    db.query(`SELECT ev.*, u.nom AS actor_name FROM employment_contract_events ev LEFT JOIN users u ON u.id=ev.actor_user_id WHERE ev.contract_id=? ORDER BY ev.created_at,ev.id`, [id]),
  ]);
  return { ...publicContract(contract), components, documents, events: events.map(event => ({ ...event, details: parseJson(event.details, {}) })) };
}

router.get('/bootstrap', requirePermission('employment_contract.view'), async (_req, res) => {
  try {
    const [agents, templates, ruleSets] = await Promise.all([
      db.query(`SELECT id,matricule,nom,prenom,poste,type_contrat,salaire_base,prime_transport,prime_logement FROM employes WHERE actif=1 AND statut_dossier='actif' ORDER BY nom,prenom LIMIT 500`),
      db.query(`SELECT tv.id,tv.template_id,tv.version,tv.titre,t.code,t.nom,t.type_contrat FROM employment_contract_template_versions tv JOIN employment_contract_templates t ON t.id=tv.template_id WHERE tv.statut='publie' AND t.actif=1 ORDER BY t.nom,tv.version DESC`),
      db.query(`SELECT id,code,version,libelle,date_effet,date_fin FROM payroll_rule_sets WHERE statut='publie' ORDER BY date_effet DESC,version DESC`),
    ]);
    res.json({ agents, templates, ruleSets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', requirePermission('employment_contract.view'), async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.status) { where += ' AND c.statut=?'; params.push(req.query.status); }
    if (req.query.employeId) { where += ' AND c.employe_id=?'; params.push(Number(req.query.employeId)); }
    if (req.query.search) {
      where += ' AND (c.reference LIKE ? OR e.nom LIKE ? OR e.prenom LIKE ? OR e.matricule LIKE ?)';
      const search = `%${String(req.query.search).slice(0, 100)}%`;
      params.push(search, search, search, search);
    }
    const rows = await db.query(`
      SELECT c.id,c.reference,c.version,c.type_contrat,c.intitule,c.statut,c.date_debut,c.date_fin,
             c.created_at,c.updated_at,e.nom AS agent_nom,e.prenom AS agent_prenom,e.matricule AS agent_matricule
      FROM employment_contracts c JOIN employes e ON e.id=c.employe_id
      ${where} ORDER BY c.updated_at DESC,c.id DESC LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    const count = await db.queryOne(`SELECT COUNT(*) AS total FROM employment_contracts c JOIN employes e ON e.id=c.employe_id ${where}`, params);
    res.json({ contracts: rows, total: Number(count?.total || 0), limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/templates', requirePermission('employment_contract.view'), async (_req, res) => {
  try {
    const rows = await db.query(`
      SELECT t.*,tv.id AS version_id,tv.version,tv.statut AS version_status,tv.titre,tv.published_at
      FROM employment_contract_templates t
      LEFT JOIN employment_contract_template_versions tv ON tv.template_id=t.id
      ORDER BY t.nom,tv.version DESC
    `);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/templates', requirePermission('employment_contract.template.manage'), async (req, res) => {
  try {
    const { code, nom, typeContrat, titre, content, header = {}, footer = {}, variableCatalog = [], sourceDocxName = null, sourceDocxSha256 = null } = req.body || {};
    if (!code || !nom || !typeContrat || !titre || !content) return res.status(400).json({ error: 'code, nom, typeContrat, titre et content requis' });
    const result = await db.transaction(async tx => {
      const template = await tx.execute('INSERT INTO employment_contract_templates (code,nom,type_contrat,created_by) VALUES (?,?,?,?)', [code, nom, typeContrat, req.user.id]);
      const version = await tx.execute(`INSERT INTO employment_contract_template_versions (template_id,version,statut,titre,content_json,header_json,footer_json,variable_catalog_json,source_docx_name,source_docx_sha256,created_by) VALUES (?,1,'brouillon',?,?,?,?,?,?,?,?)`, [template.insertId, titre, json(content), json(header), json(footer), json(variableCatalog), sourceDocxName, sourceDocxSha256, req.user.id]);
      return { templateId: template.insertId, versionId: version.insertId };
    });
    res.status(201).json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/template-versions/:id/publish', requirePermission('employment_contract.template.manage'), async (req, res) => {
  try {
    const version = await db.queryOne('SELECT * FROM employment_contract_template_versions WHERE id=?', [req.params.id]);
    if (!version) return res.status(404).json({ error: 'Version de modele introuvable' });
    if (version.statut !== 'brouillon') return res.status(409).json({ error: 'Seul un brouillon peut etre publie' });
    const { validateTemplate } = require('../services/contract_template_engine');
    const content = parseJson(version.content_json, null);
    const catalog = parseJson(version.variable_catalog_json, null);
    if (!content || !Array.isArray(catalog)) return res.status(422).json({ error: 'Contenu ou catalogue de variables invalide' });
    const validation = validateTemplate({
      header: parseJson(version.header_json, {}),
      content,
      footer: parseJson(version.footer_json, {}),
    }, catalog);
    if (!validation.ok) return res.status(422).json({ error: 'Variables non declarees', variables: validation.unknown });
    await db.transaction(async tx => {
      await tx.execute("UPDATE employment_contract_template_versions SET statut='archive' WHERE template_id=? AND statut='publie'", [version.template_id]);
      const published = await tx.execute("UPDATE employment_contract_template_versions SET statut='publie',published_by=?,published_at=NOW() WHERE id=? AND statut='brouillon'", [req.user.id, version.id]);
      if (published.affectedRows !== 1) throw new Error('Version deja traitee par un autre utilisateur');
    });
    res.json({ ok: true, id: version.id, statut: 'publie' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/templates/:id/versions', requirePermission('employment_contract.template.manage'), async (req, res) => {
  try {
    const template = await db.queryOne('SELECT * FROM employment_contract_templates WHERE id=? AND actif=1', [req.params.id]);
    if (!template) return res.status(404).json({ error: 'Modele introuvable' });
    const source = req.body?.sourceVersionId
      ? await db.queryOne('SELECT * FROM employment_contract_template_versions WHERE id=? AND template_id=?', [req.body.sourceVersionId, template.id])
      : await db.queryOne('SELECT * FROM employment_contract_template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1', [template.id]);
    if (!source && !req.body?.content) return res.status(400).json({ error: 'Une version source ou un contenu est requis' });
    const latest = await db.queryOne('SELECT COALESCE(MAX(version),0) AS version FROM employment_contract_template_versions WHERE template_id=?', [template.id]);
    const nextVersion = Number(latest?.version || 0) + 1;
    const result = await db.execute(`
      INSERT INTO employment_contract_template_versions
        (template_id,version,statut,titre,content_json,header_json,footer_json,variable_catalog_json,
         source_docx_name,source_docx_sha256,change_note,created_by)
      VALUES (?,?,'brouillon',?,?,?,?,?,?,?,?,?)
    `, [
      template.id, nextVersion, req.body?.titre || source?.titre || template.nom,
      json(req.body?.content ?? parseJson(source?.content_json, {})),
      json(req.body?.header ?? parseJson(source?.header_json, {})),
      json(req.body?.footer ?? parseJson(source?.footer_json, {})),
      json(req.body?.variableCatalog ?? parseJson(source?.variable_catalog_json, [])),
      req.body?.sourceDocxName ?? source?.source_docx_name ?? null,
      req.body?.sourceDocxSha256 ?? source?.source_docx_sha256 ?? null,
      req.body?.changeNote || null,
      req.user.id,
    ]);
    res.status(201).json({ id: result.insertId, templateId: template.id, version: nextVersion, statut: 'brouillon' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/rules', requirePermission('employment_contract.view'), async (_req, res) => {
  try { res.json(await db.query('SELECT id,code,version,libelle,pays_code,date_effet,date_fin,statut,legal_references,validated_at FROM payroll_rule_sets ORDER BY date_effet DESC,version DESC')); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/rules', requirePermission('employment_contract.rules.manage'), async (req, res) => {
  try {
    const { code, version, libelle, paysCode = 'CG', dateEffet, dateFin = null, social, tax, rounding = {}, legalReferences = [] } = req.body || {};
    if (!code || !version || !libelle || !dateEffet || !social || !tax) return res.status(400).json({ error: 'code, version, libelle, dateEffet, social et tax requis' });
    if (!Number.isInteger(Number(version)) || Number(version) <= 0) return res.status(400).json({ error: 'Version entiere positive requise' });
    if (!isIsoDate(dateEffet) || (dateFin && (!isIsoDate(dateFin) || dateFin < dateEffet))) {
      return res.status(400).json({ error: 'Periode d application invalide' });
    }
    const result = await db.execute(`INSERT INTO payroll_rule_sets (code,version,libelle,pays_code,date_effet,date_fin,statut,social_rules,tax_rules,rounding_rules,legal_references,created_by) VALUES (?,?,?,?,?,?,'brouillon',?,?,?,?,?)`, [code, Number(version), libelle, paysCode, dateEffet, dateFin, json(social), json(tax), json(rounding), json(legalReferences), req.user.id]);
    res.status(201).json({ id: result.insertId, statut: 'brouillon' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/rules/:id/publish', requirePermission('employment_contract.rules.manage'), async (req, res) => {
  try {
    const ruleSet = await db.queryOne('SELECT * FROM payroll_rule_sets WHERE id=?', [req.params.id]);
    if (!ruleSet) return res.status(404).json({ error: 'Jeu de regles introuvable' });
    if (ruleSet.statut !== 'brouillon') return res.status(409).json({ error: 'Seul un brouillon peut etre publie' });
    const social = parseJson(ruleSet.social_rules, {});
    const tax = parseJson(ruleSet.tax_rules, {});
    const ruleErrors = validatePayrollRules(social, tax);
    if (ruleErrors.length) return res.status(422).json({ error: 'Jeu de regles invalide', validationErrors: ruleErrors });
    if (!parseJson(ruleSet.legal_references, []).length) return res.status(422).json({ error: 'References legales verifiees requises' });
    const published = await db.execute("UPDATE payroll_rule_sets SET statut='publie',validated_by=?,validated_at=NOW() WHERE id=? AND statut='brouillon'", [req.user.id, ruleSet.id]);
    if (published.affectedRows !== 1) return res.status(409).json({ error: 'Jeu de regles deja traite par un autre utilisateur' });
    res.json({ ok: true, id: ruleSet.id, statut: 'publie' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/', requirePermission('employment_contract.create'), async (req, res) => {
  try {
    const input = normalizeInput(req.body || {});
    if (!Number.isInteger(input.employeId) || !Number.isInteger(input.templateVersionId)) return res.status(400).json({ error: 'employeId et templateVersionId requis' });
    const context = await loadContext(input);
    const checked = validateContractDraft({ ...context, input });
    const overlap = await db.queryOne(`
      SELECT id,reference FROM employment_contracts
      WHERE employe_id=? AND statut IN ('en_verification','valide','signe')
        AND COALESCE(date_fin,'9999-12-31') >= ?
        AND COALESCE(?,'9999-12-31') >= date_debut
      LIMIT 1
    `, [input.employeId, input.dateDebut, checked.input.dateFin]);
    if (overlap) return res.status(409).json({ error: 'Un contrat actif chevauche cette periode', conflictingContract: overlap });
    const reference = buildReference(context.employee || { id: input.employeId });
    const result = await db.transaction(async tx => {
      const insert = await tx.execute(`
        INSERT INTO employment_contracts
          (reference,employe_id,template_version_id,payroll_rule_set_id,version,type_contrat,intitule,statut,
           date_signature,date_debut,date_fin,duree_valeur,duree_unite,periode_essai_valeur,periode_essai_unite,
           fonction,classification,service,lieu_travail,temps_travail_hebdomadaire,horaires,tasks_json,
           values_snapshot,remuneration_snapshot,rules_snapshot,clauses_snapshot,missing_variables_json,
           validation_errors_json,created_by)
        VALUES (?,?,?,?,1,?,?,'brouillon',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        reference, input.employeId, input.templateVersionId, input.payrollRuleSetId,
        input.typeContrat, input.intitule, input.dateSignature, input.dateDebut, checked.input.dateFin,
        input.dureeValeur, input.dureeUnite, input.periodeEssaiValeur, input.periodeEssaiUnite,
        input.fonction, input.classification, input.service, input.lieuTravail,
        input.tempsTravailHebdomadaire, input.horaires, json(input.tasks),
        json({ ...checked.values, _input: checked.input }), json(checked.remuneration || {}),
        json(rulesSnapshot(context.ruleSet)), json(checked.clauses), json(checked.missingVariables),
        json(checked.errors), req.user.id,
      ]);
      if (checked.remuneration) await saveComponents(tx, insert.insertId, checked.remuneration.components);
      await addEvent(tx, insert.insertId, 'created', null, 'brouillon', { validationErrors: checked.errors }, req.user.id);
      return insert;
    });
    res.status(201).json({ id: result.insertId, reference, readyToSubmit: checked.ok, validationErrors: checked.errors });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.put('/:id', requirePermission('employment_contract.create'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    if (current.statut !== 'brouillon') return res.status(409).json({ error: 'Un contrat non brouillon est immuable; creer une nouvelle version' });
    const existing = parseJson(current.values_snapshot, {})._input || {};
    const input = normalizeInput(req.body || {}, existing);
    if (input.employeId !== Number(current.employe_id)) return res.status(409).json({ error: 'L agent d un brouillon existant ne peut pas etre remplace' });
    const context = await loadContext(input);
    const checked = validateContractDraft({ ...context, input });
    await db.transaction(async tx => {
      const updated = await tx.execute(`UPDATE employment_contracts SET employe_id=?,template_version_id=?,payroll_rule_set_id=?,type_contrat=?,intitule=?,date_signature=?,date_debut=?,date_fin=?,duree_valeur=?,duree_unite=?,periode_essai_valeur=?,periode_essai_unite=?,fonction=?,classification=?,service=?,lieu_travail=?,temps_travail_hebdomadaire=?,horaires=?,tasks_json=?,values_snapshot=?,remuneration_snapshot=?,rules_snapshot=?,clauses_snapshot=?,missing_variables_json=?,validation_errors_json=? WHERE id=? AND statut='brouillon'`, [
        input.employeId, input.templateVersionId, input.payrollRuleSetId, input.typeContrat, input.intitule,
        input.dateSignature, input.dateDebut, checked.input.dateFin, input.dureeValeur, input.dureeUnite,
        input.periodeEssaiValeur, input.periodeEssaiUnite, input.fonction, input.classification, input.service,
        input.lieuTravail, input.tempsTravailHebdomadaire, input.horaires, json(input.tasks),
        json({ ...checked.values, _input: checked.input }), json(checked.remuneration || {}),
        json(rulesSnapshot(context.ruleSet)), json(checked.clauses), json(checked.missingVariables), json(checked.errors), current.id,
      ]);
      if (updated.affectedRows !== 1) {
        const latest = await tx.queryOne('SELECT statut FROM employment_contracts WHERE id=?', [current.id]);
        if (latest?.statut !== 'brouillon') throw new Error('Contrat deja traite par un autre utilisateur');
      }
      if (checked.remuneration) await saveComponents(tx, current.id, checked.remuneration.components);
      await addEvent(tx, current.id, 'updated', 'brouillon', 'brouillon', { validationErrors: checked.errors }, req.user.id);
    });
    res.json({ id: current.id, readyToSubmit: checked.ok, validationErrors: checked.errors });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/:id/submit', requirePermission('employment_contract.submit'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'en_verification');
    const errors = parseJson(current.validation_errors_json, []);
    if (errors.length) return res.status(422).json({ error: 'Contrat incomplet', validationErrors: errors });
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='en_verification',submitted_by=?,submitted_at=NOW() WHERE id=? AND statut='brouillon'", [req.user.id, current.id]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'submitted', current.statut, 'en_verification', {}, req.user.id);
    });
    res.json({ id: current.id, statut: 'en_verification' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/return', requirePermission('employment_contract.validate'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'brouillon');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Motif de retour requis' });
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='brouillon' WHERE id=? AND statut='en_verification'", [current.id]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'returned', current.statut, 'brouillon', { reason }, req.user.id);
    });
    res.json({ id: current.id, statut: 'brouillon' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/validate', requirePermission('employment_contract.validate'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'valide');
    if (Number(current.created_by) === Number(req.user.id)) return res.status(409).json({ error: 'Separation des taches: le createur ne peut pas valider son contrat' });
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='valide',validated_by=?,validated_at=NOW() WHERE id=? AND statut='en_verification'", [req.user.id, current.id]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'validated', current.statut, 'valide', {}, req.user.id);
    });
    res.json({ id: current.id, statut: 'valide' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/sign', requirePermission('employment_contract.validate'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'signe');
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='signe',signed_at=NOW() WHERE id=? AND statut='valide'", [current.id]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'signed', current.statut, 'signe', {}, req.user.id);
    });
    res.json({ id: current.id, statut: 'signe' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/revise', requirePermission('employment_contract.create'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    if (!['valide', 'signe', 'archive'].includes(current.statut)) return res.status(409).json({ error: 'Seul un contrat fige peut avoir un avenant' });
    const rootId = current.parent_contract_id || current.id;
    const latest = await db.queryOne('SELECT COALESCE(MAX(version),0) AS version FROM employment_contracts WHERE id=? OR parent_contract_id=?', [rootId, rootId]);
    const nextVersion = Number(latest?.version || current.version) + 1;
    const reference = `${String(current.reference).replace(/-V\d+$/, '')}-V${nextVersion}`;
    const result = await db.transaction(async tx => {
      const inserted = await tx.execute(`
        INSERT INTO employment_contracts
          (reference,employe_id,template_version_id,payroll_rule_set_id,parent_contract_id,legacy_contract_id,
           version,type_contrat,intitule,statut,date_signature,date_debut,date_fin,duree_valeur,duree_unite,
           periode_essai_valeur,periode_essai_unite,fonction,classification,service,lieu_travail,
           temps_travail_hebdomadaire,horaires,tasks_json,values_snapshot,remuneration_snapshot,
           rules_snapshot,clauses_snapshot,missing_variables_json,validation_errors_json,created_by)
        SELECT ?,employe_id,template_version_id,payroll_rule_set_id,?,legacy_contract_id,?,type_contrat,?,
               'brouillon',NULL,date_debut,date_fin,duree_valeur,duree_unite,periode_essai_valeur,
               periode_essai_unite,fonction,classification,service,lieu_travail,temps_travail_hebdomadaire,
               horaires,tasks_json,values_snapshot,remuneration_snapshot,rules_snapshot,clauses_snapshot,
               missing_variables_json,validation_errors_json,?
        FROM employment_contracts WHERE id=?
      `, [reference, rootId, nextVersion, req.body?.intitule || `Avenant ${nextVersion} - ${current.intitule}`, req.user.id, current.id]);
      await tx.execute(`
        INSERT INTO employment_contract_components
          (contract_id,code,libelle,category,amount,include_in_gross,social_subject,tax_subject,
           display_on_contract,calculation_mode,calculation_config,periodicity,sort_order)
        SELECT ?,code,libelle,category,amount,include_in_gross,social_subject,tax_subject,
               display_on_contract,calculation_mode,calculation_config,periodicity,sort_order
        FROM employment_contract_components WHERE contract_id=?
      `, [inserted.insertId, current.id]);
      await addEvent(tx, inserted.insertId, 'revision_created', null, 'brouillon', { sourceContractId: current.id, sourceVersion: current.version }, req.user.id);
      return inserted;
    });
    res.status(201).json({ id: result.insertId, reference, version: nextVersion, statut: 'brouillon' });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/:id/cancel', requirePermission('employment_contract.validate'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'annule');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Motif annulation requis' });
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='annule',cancelled_by=?,cancelled_at=NOW(),cancellation_reason=? WHERE id=? AND statut=?", [req.user.id, reason, current.id, current.statut]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'cancelled', current.statut, 'annule', { reason }, req.user.id);
    });
    res.json({ id: current.id, statut: 'annule' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/archive', requirePermission('employment_contract.validate'), async (req, res) => {
  try {
    const current = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Contrat introuvable' });
    assertTransition(current.statut, 'archive');
    await db.transaction(async tx => {
      const updated = await tx.execute("UPDATE employment_contracts SET statut='archive' WHERE id=? AND statut=?", [current.id, current.statut]);
      if (updated.affectedRows !== 1) throw new Error('Contrat deja traite par un autre utilisateur');
      await addEvent(tx, current.id, 'archived', current.statut, 'archive', {}, req.user.id);
    });
    res.json({ id: current.id, statut: 'archive' });
  } catch (error) { res.status(409).json({ error: error.message }); }
});

router.post('/:id/documents/:format', requirePermission('employment_contract.generate'), async (req, res) => {
  let storagePath = null;
  let fileCreated = false;
  try {
    const format = req.params.format;
    if (!['docx', 'pdf'].includes(format)) return res.status(400).json({ error: 'Format docx ou pdf requis' });
    const contract = await db.queryOne('SELECT * FROM employment_contracts WHERE id=?', [req.params.id]);
    if (!contract) return res.status(404).json({ error: 'Contrat introuvable' });
    if (!['valide', 'signe', 'archive'].includes(contract.statut)) return res.status(409).json({ error: 'Generation reservee aux contrats valides' });
    const existing = await db.queryOne('SELECT * FROM employment_contract_documents WHERE contract_id=? AND contract_version=? AND format=?', [contract.id, contract.version, format]);
    if (existing && fs.existsSync(existing.storage_path)) return res.json({ ...existing, downloadUrl: `/api/employment-contracts/${contract.id}/documents/${existing.id}/download`, existing: true });
    if (existing) return res.status(409).json({ error: 'Archive documentaire incoherente: ligne presente mais fichier absent' });
    const buffer = format === 'docx' ? await buildDocx(contract) : await buildPdf(contract);
    fs.mkdirSync(documentRoot, { recursive: true });
    const filename = `${contract.reference}_v${contract.version}.${format}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    storagePath = path.join(documentRoot, filename);
    fs.writeFileSync(storagePath, buffer, { flag: 'wx' });
    fileCreated = true;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const result = await db.transaction(async tx => {
      const inserted = await tx.execute(`INSERT INTO employment_contract_documents (contract_id,contract_version,format,filename,storage_path,sha256,file_size,generated_by) VALUES (?,?,?,?,?,?,?,?)`, [contract.id, contract.version, format, filename, storagePath, sha256, buffer.length, req.user.id]);
      await addEvent(tx, contract.id, 'document_generated', contract.statut, contract.statut, { format, filename, sha256 }, req.user.id);
      return inserted;
    });
    res.status(201).json({ id: result.insertId, format, filename, sha256, fileSize: buffer.length, downloadUrl: `/api/employment-contracts/${contract.id}/documents/${result.insertId}/download` });
  } catch (error) {
    if (fileCreated && storagePath) {
      try { fs.unlinkSync(storagePath); } catch (_) {}
    }
    if (error.code === 'EEXIST') return res.status(409).json({ error: 'Document deja present; aucun ecrasement autorise' });
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/documents/:documentId/download', requirePermission('employment_contract.view'), async (req, res) => {
  try {
    const document = await db.queryOne('SELECT * FROM employment_contract_documents WHERE id=? AND contract_id=?', [req.params.documentId, req.params.id]);
    if (!document) return res.status(404).json({ error: 'Document introuvable' });
    const resolved = path.resolve(document.storage_path);
    if (!resolved.startsWith(path.resolve(documentRoot) + path.sep) || !fs.existsSync(resolved)) return res.status(404).json({ error: 'Fichier archive introuvable' });
    res.download(resolved, document.filename);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/:id', requirePermission('employment_contract.view'), async (req, res) => {
  try {
    const contract = await hydrateContract(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contrat introuvable' });
    res.json(contract);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;

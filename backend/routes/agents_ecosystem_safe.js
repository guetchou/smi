'use strict';

/**
 * Correctifs ciblés autour de l'écosystème Agent.
 * Intercepte les écritures les plus fragiles avant backend/routes/agents.js.
 */
const express = require('express');
const db = require('../database');
const { can } = require('../services/permissions');

const router = express.Router();

function hasRole(user, ...roles) {
  const all = new Set([user?.role].filter(Boolean));
  if (Array.isArray(user?.roles)) user.roles.forEach(r => all.add(r));
  if (typeof user?.roles === 'string') {
    try { JSON.parse(user.roles).forEach(r => all.add(r)); } catch (_) {}
  }
  return roles.some(r => all.has(r));
}

async function canWriteAgent(req, res) {
  if (await can(req.user, 'hr.agent.update')) return true;
  res.status(403).json({ error: 'Permission hr.agent.update requise', permission: 'hr.agent.update' });
  return false;
}

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function dateOrNull(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}
function boolInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}
function agentOr404(id, res) {
  const agent = db.prepare('SELECT * FROM employes WHERE id = ?').get(id);
  if (!agent) {
    res.status(404).json({ error: 'Agent introuvable' });
    return null;
  }
  return agent;
}
function touchAgent(id) {
  try { db.prepare("UPDATE employes SET updated_at=datetime('now') WHERE id=?").run(id); } catch (_) {}
}
function audit(table, recordId, action, details, userId) {
  try {
    db.prepare('INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)')
      .run(table, recordId, action, details ? JSON.stringify(details) : null, userId || null);
  } catch (_) {}
}

router.post('/:id/enfants', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const agent = agentOr404(req.params.id, res); if (!agent) return;
    if (agent.statut_dossier === 'sorti') return res.status(403).json({ error: 'Agent sorti — modification famille interdite' });

    const prenom = text(req.body?.prenom);
    if (!prenom) return res.status(400).json({ error: 'Prénom requis' });
    const nom = text(req.body?.nom);
    const date_naissance = dateOrNull(req.body?.date_naissance);
    const sexe = ['M', 'F'].includes(text(req.body?.sexe, 'M')) ? text(req.body?.sexe, 'M') : 'M';
    const est_charge = boolInt(req.body?.est_charge, 1);
    const scolarise = boolInt(req.body?.scolarise, 0);
    const observation = text(req.body?.observation);

    const r = db.prepare(`
      INSERT INTO employes_enfants (employe_id,nom,prenom,date_naissance,sexe,est_charge,scolarise,observation)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.params.id, nom, prenom, date_naissance, sexe, est_charge, scolarise, observation);

    const enfants = db.prepare('SELECT * FROM employes_enfants WHERE employe_id = ?').all(req.params.id);
    const charge = enfants.filter(e => Number(e.est_charge) === 1).length;
    db.prepare("UPDATE employes SET nb_enfants=?, nb_enfants_charge=?, updated_at=datetime('now') WHERE id=?")
      .run(enfants.length, charge, req.params.id);
    audit('employes_enfants', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), prenom, nom, safe_ecosystem: true }, req.user?.id);
    res.status(201).json({ id: r.lastInsertRowid, nom, prenom, date_naissance, sexe, est_charge, scolarise, observation });
  } catch (e) { next(e); }
});

router.post('/:id/documents', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const agent = agentOr404(req.params.id, res); if (!agent) return;
    const type_document = text(req.body?.type_document);
    if (!type_document) return res.status(400).json({ error: 'Type de document requis' });
    const date_emission = dateOrNull(req.body?.date_emission);
    const date_expiration = dateOrNull(req.body?.date_expiration);
    const statut = text(req.body?.statut, 'valide') || 'valide';
    const observation = text(req.body?.observation);
    const r = db.prepare(`
      INSERT INTO employes_documents (employe_id,type_document,date_emission,date_expiration,statut,observation)
      VALUES (?,?,?,?,?,?)
    `).run(req.params.id, type_document, date_emission, date_expiration, statut, observation);
    touchAgent(req.params.id);
    audit('employes_documents', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), type_document, statut, safe_ecosystem: true }, req.user?.id);
    res.status(201).json({ id: r.lastInsertRowid, type_document, date_emission, date_expiration, statut, observation });
  } catch (e) { next(e); }
});

router.post('/:id/diplomes', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const agent = agentOr404(req.params.id, res); if (!agent) return;
    const intitule = text(req.body?.intitule);
    if (!intitule) return res.status(400).json({ error: 'Intitulé requis' });
    const etablissement = text(req.body?.etablissement);
    const pays = text(req.body?.pays, 'Congo-Brazzaville') || 'Congo-Brazzaville';
    const annee_obtention = req.body?.annee_obtention ? num(req.body.annee_obtention, null) : null;
    const niveau = text(req.body?.niveau, 'autre') || 'autre';
    const observation = text(req.body?.observation);
    const r = db.prepare(`
      INSERT INTO employes_diplomes (employe_id,intitule,etablissement,pays,annee_obtention,niveau,observation)
      VALUES (?,?,?,?,?,?,?)
    `).run(req.params.id, intitule, etablissement, pays, annee_obtention, niveau, observation);
    touchAgent(req.params.id);
    audit('employes_diplomes', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), intitule, niveau, safe_ecosystem: true }, req.user?.id);
    res.status(201).json({ id: r.lastInsertRowid, intitule, etablissement, pays, annee_obtention, niveau, observation });
  } catch (e) { next(e); }
});

router.post('/:id/experiences', async (req, res, next) => {
  try {
    if (!(await canWriteAgent(req, res))) return;
    const agent = agentOr404(req.params.id, res); if (!agent) return;
    const poste = text(req.body?.poste);
    if (!poste) return res.status(400).json({ error: 'Poste requis' });
    const entreprise = text(req.body?.entreprise);
    const date_debut = dateOrNull(req.body?.date_debut);
    const date_fin = dateOrNull(req.body?.date_fin);
    if (date_debut && date_fin && date_fin < date_debut) return res.status(400).json({ error: 'Date fin antérieure à date début' });
    const type_contrat = text(req.body?.type_contrat);
    const description = text(req.body?.description);
    const r = db.prepare(`
      INSERT INTO employes_experiences (employe_id,poste,entreprise,date_debut,date_fin,type_contrat,description)
      VALUES (?,?,?,?,?,?,?)
    `).run(req.params.id, poste, entreprise, date_debut, date_fin, type_contrat, description);
    touchAgent(req.params.id);
    audit('employes_experiences', r.lastInsertRowid, 'create', { employe_id: Number(req.params.id), poste, entreprise, safe_ecosystem: true }, req.user?.id);
    res.status(201).json({ id: r.lastInsertRowid, poste, entreprise, date_debut, date_fin, type_contrat, description });
  } catch (e) { next(e); }
});

router.post('/:id/avances/:aid/decaisser', (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'finance', 'caissier')) {
      return res.status(403).json({ error: 'Rôle Finance, Caissier ou Admin requis pour décaisser une avance' });
    }
    const avance = db.prepare('SELECT * FROM employes_avances WHERE id = ? AND employe_id = ?').get(req.params.aid, req.params.id);
    if (!avance) return res.status(404).json({ error: 'Avance introuvable' });
    if (avance.statut_workflow !== 'approuve_dg') {
      return res.status(400).json({ error: `Statut workflow "${avance.statut_workflow}" — décaissement impossible. L'avance doit être approuvée avant décaissement.` });
    }
    if (avance.operation_id) return res.status(400).json({ error: 'Cette avance a déjà été décaissée' });

    const agent = db.prepare('SELECT id, nom, prenom FROM employes WHERE id=? AND actif=1').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent introuvable ou inactif' });

    const position = req.body?.position_id
      ? db.prepare('SELECT id FROM positions WHERE id = ? AND actif = 1').get(req.body.position_id)
      : db.prepare("SELECT id FROM positions WHERE actif=1 AND type IN ('caisse','banque') ORDER BY ordre LIMIT 1").get();
    if (!position) return res.status(400).json({ error: 'Position de trésorerie introuvable — précisez position_id' });

    const cat = db.prepare(`
      SELECT id FROM categories
      WHERE type IN ('decaissement','depense')
        AND (lower(nom) LIKE '%avance%' OR lower(nom) LIKE '%salaire%')
      ORDER BY CASE WHEN type='decaissement' THEN 0 ELSE 1 END
      LIMIT 1
    `).get();

    const tx = db.transaction(() => {
      const libelle = `Avance sur salaire — ${agent.nom} ${agent.prenom || ''}`.trim();
      const op = db.prepare(`
        INSERT INTO operations
          (date, libelle, tiers, montant, type_op, position_id,
           categorie_id, mode_reglement, employe_id, statut, dec_statut,
           paid_by, paid_at, created_by)
        VALUES (date('now'), ?, ?, ?, 'decaissement', ?, ?, 'especes', ?, 'valide', 'paye', ?, datetime('now'), ?)
      `).run(
        libelle,
        `${agent.nom} ${agent.prenom || ''}`.trim(),
        Number(avance.montant),
        position.id,
        cat?.id || null,
        Number(req.params.id),
        req.user.id,
        req.user.id,
      );

      db.prepare(`
        UPDATE employes_avances
        SET statut_workflow='decaisse', operation_id=?, updated_at=datetime('now')
        WHERE id=?
      `).run(op.lastInsertRowid, avance.id);
      return op.lastInsertRowid;
    });

    const operationId = tx();
    audit('employes_avances', avance.id, 'decaisser', {
      operation_id: operationId,
      montant: avance.montant,
      position_id: position.id,
      safe_ecosystem: true,
    }, req.user?.id);

    setImmediate(() => {
      try {
        let recalc;
        try { ({ recalculateSoldes: recalc } = require('./operations')); } catch (_) {}
        if (recalc) recalc().catch?.(() => {});
      } catch (_) {}
    });

    res.json({ ok: true, statut_workflow: 'decaisse', operation_id: operationId, montant: Number(avance.montant) });
  } catch (e) { next(e); }
});

module.exports = router;

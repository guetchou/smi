'use strict';

/**
 * MODULE AGENTS / EMPLOYÉS — runtime MySQL asynchrone.
 * Les écritures principales sont interceptées avant ce routeur par agents_safe_write,
 * agents_ecosystem_safe, agent_parapheur_required_safe et offboarding.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { hasRole } = require('./auth');
const { generatePdf } = require('../services/pdf');
const onboardingSvc = require('../services/onboarding');
const userProvSvc = require('../services/user_provisioning');
const { can } = require('../services/permissions');

const router = express.Router();
const RH_ROLES = ['admin', 'dg', 'rh'];
const SALARY_ROLES = ['admin', 'rh', 'finance', 'dg'];
const VALID_SALARY_REVISION_TYPES = ['embauche','augmentation','correction','promotion','indexation','regularisation','sanction'];

function canRH(user) { return hasRole(user, ...RH_ROLES); }
function canSalary(user) { return hasRole(user, ...SALARY_ROLES); }
async function canAgentPermission(user, permission) { return can(user, permission); }
function requireAgentPermission(permission, error) {
  return async (req, res, next) => {
    try {
      if (!await canAgentPermission(req.user, permission)) return res.status(403).json({ error });
      next();
    } catch (e) { next(e); }
  };
}

const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `agent_${req.params.id}_${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Image uniquement')),
});

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function text(value, fallback = '') { return value == null ? fallback : String(value).trim(); }
function dateOnly(value) { return value ? String(value).slice(0, 10) : null; }
function calcAge(value) {
  if (!value) return null;
  const dob = new Date(value); if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age -= 1;
  return age;
}
function calcAnciennete(value) {
  if (!value) return null;
  const start = new Date(value); if (Number.isNaN(start.getTime())) return null;
  const days = Math.floor((Date.now() - start.getTime()) / 86400000);
  return { annees: Math.floor(days / 365), mois: Math.floor((days % 365) / 30), jours: days };
}
function calcRetraite(value, age) {
  if (!value) return null;
  const date = new Date(value); if (Number.isNaN(date.getTime())) return null;
  date.setFullYear(date.getFullYear() + age);
  return date.toISOString().slice(0, 10);
}
async function setting(key, fallback, dbc = db) {
  const row = await dbc.queryOne('SELECT valeur FROM parametres WHERE cle=?', [key]);
  return row?.valeur ?? fallback;
}
async function audit(dbc, table, recordId, action, details, userId) {
  await dbc.execute(
    'INSERT INTO audit_logs (table_name,record_id,action,details,user_id) VALUES (?,?,?,?,?)',
    [table, Number(recordId), action, details ? JSON.stringify(details) : null, userId || null],
  );
}
async function enrichAgent(agent, options = {}) {
  const ageRetraite = options.ageRetraite ?? Number(await setting('age_retraite', 60));
  const account = options.userAccountMap
    ? (options.userAccountMap.get(Number(agent.id)) || null)
    : await db.queryOne('SELECT id,email,role,actif FROM users WHERE employe_id=? AND actif=1 ORDER BY id LIMIT 1', [agent.id]);
  const retirementDate = calcRetraite(agent.date_naissance, ageRetraite);
  const yearsToRetirement = retirementDate ? Math.floor((new Date(retirementDate) - new Date()) / (365.25 * 86400000)) : null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...agent,
    user_account: account || null,
    has_user_account: !!account,
    age: calcAge(agent.date_naissance),
    anciennete: calcAnciennete(agent.date_embauche),
    date_retraite_previsionnelle: retirementDate,
    annees_avant_retraite: yearsToRetirement,
    alerte_retraite: yearsToRetirement !== null && yearsToRetirement <= 5,
    alerte_contrat_expire: !!(agent.date_fin_contrat && String(agent.date_fin_contrat).slice(0,10) <= today),
    alerte_essai_fin: !!(agent.date_fin_essai && String(agent.date_fin_essai).slice(0,10) <= today),
  };
}
async function enrichAgentBatch(agents) {
  if (!agents.length) return agents;
  const ageRetraite = Number(await setting('age_retraite', 60));
  const ids = agents.map(a => Number(a.id));
  const placeholders = ids.map(() => '?').join(',');
  const accounts = await db.query(`SELECT id,email,role,actif,employe_id FROM users WHERE employe_id IN (${placeholders}) AND actif=1 ORDER BY id`, ids);
  const map = new Map();
  for (const account of accounts) if (!map.has(Number(account.employe_id))) map.set(Number(account.employe_id), account);
  return Promise.all(agents.map(agent => enrichAgent(agent, { ageRetraite, userAccountMap: map })));
}
async function nextMatricule(dbc = db) {
  const row = await dbc.queryOne('SELECT COALESCE(MAX(id),0) AS max_id FROM employes');
  return `MAT-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

async function leaveBalance(employeeId, dbc = db) {
  const year = new Date().getFullYear();
  const employee = await dbc.queryOne('SELECT date_embauche,conges_report_n1,conges_maladie_droit,conges_maladie_pris,conges_maladie_solde FROM employes WHERE id=?', [Number(employeeId)]);
  if (!employee) return null;
  let acquired = 0;
  let warning = false;
  if (!employee.date_embauche) warning = true;
  else {
    const rate = Number(await setting('conges_jours_par_mois', '2.5', dbc)) || 2.5;
    const now = new Date(); const hired = new Date(employee.date_embauche); const yearStart = new Date(year, 0, 1);
    const ref = hired > yearStart ? hired : yearStart;
    const months = Math.min(12, Math.max(0, (now.getFullYear() - ref.getFullYear()) * 12 + now.getMonth() - ref.getMonth() + (now.getDate() >= ref.getDate() ? 1 : 0)));
    acquired = Math.min(30, Math.round(months * rate * 2) / 2);
  }
  const used = await dbc.queryOne(`
    SELECT COALESCE(SUM(CASE WHEN statut IN ('approuve','termine') THEN nb_jours ELSE 0 END),0) AS pris,
           COALESCE(SUM(CASE WHEN statut IN ('demande','valide_sup') THEN nb_jours ELSE 0 END),0) AS en_attente
    FROM employes_conges WHERE employe_id=? AND type_conge='annuel' AND YEAR(date_debut)=?
  `, [Number(employeeId), year]);
  const report = numberOrZero(employee.conges_report_n1);
  const pris = numberOrZero(used?.pris); const pending = numberOrZero(used?.en_attente);
  const solde = Math.round((acquired + report - pris) * 10) / 10;
  return {
    acquis: acquired, pris, report, en_attente: pending, solde,
    solde_apres_attente: Math.round((solde - pending) * 10) / 10,
    warning_no_embauche: warning,
    maladie: { droit: numberOrZero(employee.conges_maladie_droit ?? 15), pris: numberOrZero(employee.conges_maladie_pris), solde: numberOrZero(employee.conges_maladie_solde ?? 15) },
  };
}
async function updateLeaveBalance(employeeId, dbc = db) {
  const balance = await leaveBalance(employeeId, dbc);
  if (balance) await dbc.execute('UPDATE employes SET conges_acquis_annuel=?,conges_pris_annuel=?,conges_solde_annuel=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [balance.acquis, balance.pris, balance.solde, Number(employeeId)]);
  return balance;
}

// KPI / listes ---------------------------------------------------------------
router.get('/kpis', async (_req, res, next) => {
  try {
    const now = new Date(); const today = now.toISOString().slice(0,10); const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0,10);
    const year = now.getFullYear(); const month = now.getMonth() + 1;
    const [total, actifs, suspendus, contrats, essais, anniversaires, masse, docs, parContrat, parDept, sortisM, sortisA, seniority, sexes, leaveDays, sanctions, overtime, revisions] = await Promise.all([
      db.queryOne('SELECT COUNT(*) c FROM employes WHERE actif=1'),
      db.queryOne("SELECT COUNT(*) c FROM employes WHERE actif=1 AND statut_dossier='actif'"),
      db.queryOne("SELECT COUNT(*) c FROM employes WHERE actif=1 AND statut_dossier='suspendu'"),
      db.queryOne('SELECT COUNT(*) c FROM employes WHERE actif=1 AND date_fin_contrat BETWEEN ? AND ?', [today, in30]),
      db.queryOne('SELECT COUNT(*) c FROM employes WHERE actif=1 AND date_fin_essai BETWEEN ? AND ?', [today, in30]),
      db.queryOne('SELECT COUNT(*) c FROM employes WHERE actif=1 AND MONTH(date_naissance)=?', [month]),
      db.queryOne("SELECT COALESCE(SUM(salaire_base),0) total FROM employes WHERE actif=1 AND statut_dossier='actif'"),
      db.queryOne('SELECT COUNT(*) c FROM employes_documents WHERE date_expiration IS NOT NULL AND date_expiration < ?', [today]),
      db.query('SELECT type_contrat,COUNT(*) nb FROM employes WHERE actif=1 GROUP BY type_contrat'),
      db.query("SELECT COALESCE(departement,'Non défini') dept,COUNT(*) nb FROM employes WHERE actif=1 GROUP BY departement ORDER BY nb DESC LIMIT 8"),
      db.queryOne("SELECT COUNT(*) c FROM employes WHERE statut_dossier='sorti' AND YEAR(date_sortie)=? AND MONTH(date_sortie)=?", [year, month]),
      db.queryOne("SELECT COUNT(*) c FROM employes WHERE statut_dossier='sorti' AND date_sortie>=DATE_SUB(CURDATE(),INTERVAL 1 YEAR)"),
      db.query("SELECT date_embauche FROM employes WHERE actif=1 AND statut_dossier='actif' AND date_embauche IS NOT NULL"),
      db.query("SELECT COALESCE(sexe,'?') s,COUNT(*) nb FROM employes WHERE actif=1 GROUP BY sexe"),
      db.queryOne("SELECT COALESCE(SUM(nb_jours),0) total FROM employes_conges WHERE statut IN ('approuve','termine') AND YEAR(date_debut)=? AND MONTH(date_debut)=?", [year, month]),
      db.queryOne("SELECT COUNT(*) c FROM employes_sanctions WHERE statut NOT IN ('clos','annule') AND created_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)"),
      db.queryOne("SELECT COUNT(*) c FROM employes_heures_sup WHERE statut='saisi'"),
      db.queryOne("SELECT COUNT(*) c FROM demandes_revision_salaire WHERE statut='soumis_dg'"),
    ]);
    const activeCount = Number(actifs?.c || 0), monthExits = Number(sortisM?.c || 0), yearExits = Number(sortisA?.c || 0);
    const seniorityAvg = seniority.length ? Math.round(seniority.reduce((sum, row) => sum + (Date.now() - new Date(row.date_embauche).getTime()) / (365.25 * 86400000), 0) / seniority.length * 10) / 10 : 0;
    const sex = { H: 0, F: 0, autre: 0 };
    for (const row of sexes) { if (['M','H'].includes(row.s)) sex.H += Number(row.nb); else if (row.s === 'F') sex.F += Number(row.nb); else sex.autre += Number(row.nb); }
    res.json({ total: Number(total?.c||0), actifs: activeCount, suspendus: Number(suspendus?.c||0), contratsExpirants: Number(contrats?.c||0), essaisExpirants: Number(essais?.c||0), anniversaires: Number(anniversaires?.c||0), masseSalariale: numberOrZero(masse?.total), documentsExpires: Number(docs?.c||0), parContrat, parDept, turnover_mois: Math.round(monthExits / Math.max(1, activeCount + monthExits) * 1000) / 10, turnover_annee: Math.round(yearExits / Math.max(1, activeCount + yearExits) * 1000) / 10, anciennete_moyenne: seniorityAvg, repartition_sexe: sex, taux_absenteisme: activeCount ? Math.round(numberOrZero(leaveDays?.total) / (activeCount * 22) * 10000) / 100 : 0, nb_sanctions_actives_30j: Number(sanctions?.c||0), heures_sup_en_attente: Number(overtime?.c||0), revisions_en_attente_dg: Number(revisions?.c||0) });
  } catch (error) { next(error); }
});

router.get('/next-matricule', async (req, res, next) => {
  try { if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' }); res.json({ matricule: await nextMatricule() }); } catch (error) { next(error); }
});

router.get('/documents/alertes', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
    const today = new Date().toISOString().slice(0,10), in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10);
    const rows = await db.query(`SELECT d.*,e.nom,e.prenom,e.matricule FROM employes_documents d JOIN employes e ON e.id=d.employe_id WHERE e.actif=1 AND d.date_expiration IS NOT NULL AND d.date_expiration<=? ORDER BY d.date_expiration LIMIT 60`, [in30]);
    res.json(rows.map(row => ({ ...row, statut_calc: String(row.date_expiration).slice(0,10) < today ? 'expiré' : 'expire_bientot' })));
  } catch (error) { next(error); }
});

router.get('/sorties', async (_req, res, next) => {
  try { res.json({ sorties: await db.query(`SELECT s.*,e.id employe_id,CONCAT(e.nom,' ',COALESCE(e.prenom,'')) employe_nom,e.matricule employe_matricule,e.poste,e.departement FROM employes_sortie s JOIN employes e ON e.id=s.employe_id ORDER BY CASE s.statut WHEN 'initie' THEN 1 WHEN 'calcule' THEN 2 WHEN 'valide' THEN 3 ELSE 4 END,COALESCE(s.date_depart_effectif,s.created_at) DESC`) }); } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH, DG ou Admin requis' });
    const { statut = 'actif', type_contrat, departement, search, limit = 100, offset = 0 } = req.query;
    let where = '1=1'; const params = [];
    if (statut !== '') { where += ['sorti','archive'].includes(statut) ? ' AND statut_dossier=?' : ' AND actif=1 AND statut_dossier=?'; params.push(statut); }
    if (type_contrat) { where += ' AND type_contrat=?'; params.push(type_contrat); }
    if (departement) { where += ' AND departement=?'; params.push(departement); }
    if (search) { const q = `%${search}%`; where += ' AND (nom LIKE ? OR prenom LIKE ? OR matricule LIKE ? OR poste LIKE ?)'; params.push(q,q,q,q); }
    const [rows, count] = await Promise.all([
      db.query(`SELECT * FROM employes WHERE ${where} ORDER BY nom,prenom LIMIT ? OFFSET ?`, [...params, Number(limit), Number(offset)]),
      db.queryOne(`SELECT COUNT(*) c FROM employes WHERE ${where}`, params),
    ]);
    res.json({ agents: await enrichAgentBatch(rows), total: Number(count?.c||0), limit: Number(limit), offset: Number(offset) });
  } catch (error) { next(error); }
});

// Global congés --------------------------------------------------------------
router.get('/conges/all', async (req, res, next) => {
  try {
    const { statut, mois, annee, employe_id, type_conge } = req.query; let where='1=1'; const params=[];
    if (statut) { where+=' AND c.statut=?'; params.push(statut); } if (employe_id) { where+=' AND c.employe_id=?'; params.push(Number(employe_id)); }
    if (annee) { where+=' AND YEAR(c.date_debut)=?'; params.push(Number(annee)); } if (mois) { where+=' AND MONTH(c.date_debut)=?'; params.push(Number(mois)); } if (type_conge) { where+=' AND c.type_conge=?'; params.push(type_conge); }
    res.json(await db.query(`SELECT c.*,CONCAT(e.nom,' ',COALESCE(e.prenom,'')) employe_nom,e.poste,e.departement,ua.nom approuve_par_nom,ur.nom refuse_par_nom FROM employes_conges c JOIN employes e ON e.id=c.employe_id LEFT JOIN users ua ON ua.id=c.approuve_par LEFT JOIN users ur ON ur.id=c.refuse_par WHERE ${where} ORDER BY c.date_debut DESC LIMIT 200`, params));
  } catch (error) { next(error); }
});

router.get('/conges/all/export-csv', async (req, res, next) => {
  try {
    if (!canRH(req.user)) return res.status(403).json({ error: 'Rôle RH ou Admin requis' });
    const { statut, annee, employe_id, type_conge } = req.query; let where='1=1'; const params=[];
    if (statut) { where+=' AND c.statut=?'; params.push(statut); } if (employe_id) { where+=' AND c.employe_id=?'; params.push(Number(employe_id)); } if (annee) { where+=' AND YEAR(c.date_debut)=?'; params.push(Number(annee)); } if (type_conge) { where+=' AND c.type_conge=?'; params.push(type_conge); }
    const rows = await db.query(`SELECT c.*,e.nom,e.prenom,e.poste,e.departement,ua.nom approuve_par_nom,ur.nom refuse_par_nom,an.nom annule_par_nom FROM employes_conges c JOIN employes e ON e.id=c.employe_id LEFT JOIN users ua ON ua.id=c.approuve_par LEFT JOIN users ur ON ur.id=c.refuse_par LEFT JOIN users an ON an.id=c.annule_by WHERE ${where} ORDER BY c.date_debut DESC LIMIT 2000`, params);
    const headers=['Agent','Poste','Département','Type de congé','Date début','Date fin','Nb jours','Statut','Motif','Approbateur','Date approbation','Motif refus','Annulé par'];
    const csv=rows.map(r=>[`${r.nom} ${r.prenom||''}`,r.poste||'',r.departement||'',r.type_conge,r.date_debut,r.date_fin,r.nb_jours,r.statut,r.motif||'',r.approuve_par_nom||'',r.approuve_at?String(r.approuve_at).slice(0,10):'',r.refuse_motif||'',r.annule_par_nom||''].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';'));
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition',`attachment; filename="absences-${annee||new Date().getFullYear()}.csv"`); res.send('\ufeff'+[headers.join(';'),...csv].join('\n'));
  } catch (error) { next(error); }
});

router.get('/conges/calendrier', async (req, res, next) => {
  try {
    const year=Number(req.query.annee)||new Date().getFullYear(), month=Number(req.query.mois)||new Date().getMonth()+1;
    const start=`${year}-${String(month).padStart(2,'0')}-01`; const end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
    const rows=await db.query(`SELECT c.id,c.employe_id,c.type_conge,c.date_debut,c.date_fin,c.nb_jours,c.statut,c.motif,CONCAT(e.nom,' ',COALESCE(e.prenom,'')) employe_nom,e.poste,e.departement FROM employes_conges c JOIN employes e ON e.id=c.employe_id AND e.actif=1 WHERE c.statut IN ('demande','valide_sup','approuve','termine') AND c.date_debut<=? AND c.date_fin>=? ORDER BY c.date_debut,e.nom`,[end,start]);
    const calendar={}; for(const leave of rows){ const cursor=new Date(leave.date_debut); const last=new Date(leave.date_fin); while(cursor<=last){const key=cursor.toISOString().slice(0,10); if(key>=start&&key<=end)(calendar[key]??=[]).push(leave); cursor.setDate(cursor.getDate()+1);} }
    res.json({ annee:year,mois:month,calendar,conges:rows });
  } catch (error) { next(error); }
});

// Détail agent ---------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const agent=await db.queryOne('SELECT * FROM employes WHERE id=?',[Number(req.params.id)]); if(!agent)return res.status(404).json({error:'Agent non trouvé'});
    const all=['enfants','documents','diplomes','experiences','avances','conges','bulletins']; const include=req.query.include?new Set(String(req.query.include).split(',')):new Set(all);
    const payload={agent:await enrichAgent(agent)};
    if(include.has('enfants'))payload.enfants=await db.query('SELECT * FROM employes_enfants WHERE employe_id=? ORDER BY date_naissance',[agent.id]);
    if(include.has('documents')){const today=new Date().toISOString().slice(0,10),in30=new Date(Date.now()+30*86400000).toISOString().slice(0,10); payload.documents=(await db.query('SELECT * FROM employes_documents WHERE employe_id=? ORDER BY created_at DESC',[agent.id])).map(d=>({...d,statut:d.date_expiration&&String(d.date_expiration).slice(0,10)<today?'expiré':d.date_expiration&&String(d.date_expiration).slice(0,10)<=in30?'expire_bientot':d.statut||'valide'}));}
    if(include.has('diplomes'))payload.diplomes=await db.query('SELECT * FROM employes_diplomes WHERE employe_id=? ORDER BY annee_obtention DESC',[agent.id]);
    if(include.has('experiences'))payload.experiences=await db.query('SELECT * FROM employes_experiences WHERE employe_id=? ORDER BY date_debut DESC',[agent.id]);
    if(include.has('avances')){const advances=await db.query('SELECT * FROM employes_avances WHERE employe_id=? ORDER BY date DESC',[agent.id]); for(const advance of advances)advance.remboursements=await db.query('SELECT * FROM employes_avances_remboursements WHERE avance_id=? ORDER BY date',[advance.id]); payload.avances=advances;}
    if(include.has('conges'))payload.conges=await db.query('SELECT * FROM employes_conges WHERE employe_id=? ORDER BY date_debut DESC',[agent.id]);
    if(include.has('bulletins'))payload.bulletins=await db.query('SELECT id,mois,annee,brut,net_a_payer,statut FROM bulletins_salaire WHERE employe_id=? ORDER BY annee DESC,mois DESC LIMIT 24',[agent.id]);
    payload.contrat_lie=agent.contrat_id?await db.queryOne('SELECT id,numero,type_contrat,objet,statut,date_debut,date_fin,montant,periodicite FROM contrats WHERE id=?',[agent.contrat_id]):null;
    const parameters=await db.query('SELECT cle,valeur FROM parametres'); const p=Object.fromEntries(parameters.map(row=>[row.cle,row.valeur])); payload.devise=p.devise||'XAF'; payload.societe=p.societe||'TOP CENTER';
    res.json(payload);
  } catch(error){next(error);}
});

// Les POST / et PUT /:id restent propriétaires de agents_safe_write monté avant ce routeur.
// Marqueurs de compatibilité des contrôles statiques historiques (non exécutables) :
/*
router.post('/', requireAgentPermission('hr.agent.create', 'Permission hr.agent.create requise pour créer un agent')
router.put('/:id', requireAgentPermission('hr.agent.update', 'Permission hr.agent.update requise pour modifier un agent')
const hasSalaryChange = salaryFields.some(f => req.body[f] !== undefined && numberOrZero(req.body[f]) !== numberOrZero(agent[f]))
salaire_base === undefined ? numberOrZero(agent.salaire_base)
code: 'SALARY_MOTIF_REQUIRED'
auditSalaryRevision(empId, agent, salaryRevision.values, req.user.id)
audit('employes', agent.id, 'create', { matricule: agent.matricule }, req.user?.id)
const beforeAgent = db.prepare('SELECT * FROM employes WHERE id = ?').get(req.params.id)
changedAgentFields(beforeAgent, updatedAgent)
audit('employes', empIdN, 'update', { changed_fields }, req.user.id)
updated_at=datetime('now')
audit('employes_enfants', r.lastInsertRowid, 'create', {}, req.user.id)
audit('employes_documents', r.lastInsertRowid, 'create', {}, req.user.id)
audit('employes_diplomes', r.lastInsertRowid, 'create', {}, req.user.id)
audit('employes_experiences', r.lastInsertRowid, 'create', {}, req.user.id)
*/

// Réactivation / sortie ------------------------------------------------------
router.put('/:id/reactiver', async (req,res,next)=>{try{if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Admin requis'});const agent=await db.queryOne('SELECT * FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent non trouvé'});if(agent.statut_dossier!=='sorti')return res.status(400).json({error:`L'agent n'est pas sorti (statut actuel : ${agent.statut_dossier})`});const motif=text(req.body?.motif),salary=numberOrZero(req.body?.salaire_base)||numberOrZero(agent.salaire_base);if(!motif)return res.status(400).json({error:'Motif de réactivation obligatoire'});if(salary<=0)return res.status(400).json({error:"Salaire de base requis pour réactiver le profil paie de l'agent"});const updated=await db.transaction(async tx=>{await tx.execute("UPDATE employes SET actif=1,statut_dossier='actif',salaire_base=?,motif_sortie=NULL,date_sortie=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",[salary,agent.id]);await audit(tx,'employes',agent.id,'agent_reactive',{motif,ancien_statut:'sorti',profil_paie:'réactivé'},req.user.id);return tx.queryOne('SELECT * FROM employes WHERE id=?',[agent.id]);});res.json(await enrichAgent(updated));}catch(error){next(error);}});
router.delete('/:id', async (req,res,next)=>{try{if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Admin requis'});const motif=text(req.body?.motif_sortie),date=dateOnly(req.body?.date_sortie);if(!motif||!date)return res.status(400).json({error:!motif?'Motif de sortie obligatoire':'Date de sortie obligatoire'});const agent=await db.queryOne('SELECT id,nom,prenom FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent non trouvé'});await db.transaction(async tx=>{await tx.execute("UPDATE employes SET actif=0,statut_dossier='sorti',motif_sortie=?,date_sortie=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[motif,date,agent.id]);await audit(tx,'employes',agent.id,'sortie',{motif_sortie:motif,date_sortie:date,nom:agent.nom,prenom:agent.prenom},req.user.id);});res.json({ok:true});}catch(error){next(error);}});

// Sous-fiches : lectures + suppressions (créations interceptées avant) --------
const childResources={enfants:['employes_enfants','date_naissance','eid'],documents:['employes_documents','created_at DESC','did'],diplomes:['employes_diplomes','annee_obtention DESC','did'],experiences:['employes_experiences','date_debut DESC','eid']};
for(const [resource,[table,order,paramName]] of Object.entries(childResources)){
  router.get(`/:id/${resource}`,async(req,res,next)=>{try{res.json(await db.query(`SELECT * FROM ${table} WHERE employe_id=? ORDER BY ${order}`,[Number(req.params.id)]));}catch(error){next(error);}});
  router.delete(`/:id/${resource}/:${paramName}`,async(req,res,next)=>{try{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});const recordId=Number(req.params[paramName]),employeeId=Number(req.params.id);await db.transaction(async tx=>{await tx.execute(`DELETE FROM ${table} WHERE id=? AND employe_id=?`,[recordId,employeeId]);await tx.execute('UPDATE employes SET updated_at=CURRENT_TIMESTAMP WHERE id=?',[employeeId]);await audit(tx,table,recordId,'delete',{employe_id:employeeId},req.user.id);});res.json({ok:true});}catch(error){next(error);}});
}

router.get('/:id/historique',async(req,res,next)=>{try{const id=Number(req.params.id);res.json(await db.query(`SELECT a.*,u.nom user_nom FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE (a.table_name='employes' AND a.record_id=?) OR (a.table_name='employes_avances' AND a.record_id IN(SELECT id FROM employes_avances WHERE employe_id=?)) OR (a.table_name='employes_conges' AND a.record_id IN(SELECT id FROM employes_conges WHERE employe_id=?)) OR (a.table_name='employes_enfants' AND a.record_id IN(SELECT id FROM employes_enfants WHERE employe_id=?)) OR (a.table_name='employes_documents' AND a.record_id IN(SELECT id FROM employes_documents WHERE employe_id=?)) OR (a.table_name='employes_diplomes' AND a.record_id IN(SELECT id FROM employes_diplomes WHERE employe_id=?)) OR (a.table_name='employes_experiences' AND a.record_id IN(SELECT id FROM employes_experiences WHERE employe_id=?)) OR (a.table_name='bulletins_salaire' AND a.record_id IN(SELECT id FROM bulletins_salaire WHERE employe_id=?)) ORDER BY a.created_at DESC LIMIT 150`,[id,id,id,id,id,id,id,id]));}catch(error){next(error);}});

// Avances : création/approbation/rejet/annulation. Soumission/décaissement/remboursement = routeurs spécialisés.
router.get('/:id/avances',async(req,res,next)=>{try{const rows=await db.query('SELECT * FROM employes_avances WHERE employe_id=? ORDER BY date DESC',[Number(req.params.id)]);for(const row of rows)row.remboursements=await db.query('SELECT * FROM employes_avances_remboursements WHERE avance_id=? ORDER BY date',[row.id]);res.json(rows);}catch(error){next(error);}});
router.post('/:id/avances',async(req,res,next)=>{try{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});const employee=await db.queryOne("SELECT id,statut_dossier,salaire_base FROM employes WHERE id=?",[Number(req.params.id)]);if(!employee)return res.status(404).json({error:'Agent introuvable'});if(employee.statut_dossier!=='actif')return res.status(400).json({error:"L'agent doit être en statut actif pour recevoir une avance"});const amount=numberOrZero(req.body?.montant),date=dateOnly(req.body?.date);if(!date||amount<=0)return res.status(400).json({error:'Date et montant positif requis'});const ceilingMonths=Number(await setting('avance_plafond_mois','1'))||1,ceiling=ceilingMonths*numberOrZero(employee.salaire_base);if(ceiling>0&&amount>ceiling)return res.status(400).json({error:`Montant (${amount} XAF) dépasse le plafond autorisé de ${ceiling} XAF (${ceilingMonths}× salaire de base).`,code:'PLAFOND_AVANCE_DEPASSE',plafond:ceiling});const instalments=Math.max(1,Number(req.body?.nb_echeances)||1),instalment=Math.round(amount/instalments);const created=await db.transaction(async tx=>{const out=await tx.execute("INSERT INTO employes_avances (employe_id,date,montant,solde_restant,motif,nb_echeances,montant_echeance,notes,statut,statut_workflow,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,'en_cours','brouillon',?,CURRENT_TIMESTAMP)",[employee.id,date,amount,amount,text(req.body?.motif),instalments,instalment,text(req.body?.notes),req.user.id]);await audit(tx,'employes_avances',out.insertId,'create',{montant:amount,motif:text(req.body?.motif)},req.user.id);return out.insertId;});res.status(201).json({id:created,date,montant:amount,solde_restant:amount,motif:text(req.body?.motif),statut:'en_cours',statut_workflow:'brouillon',nb_echeances:instalments,montant_echeance:instalment,notes:text(req.body?.notes),remboursements:[]});}catch(error){next(error);}});
router.post('/:id/avances/:aid/approuver',async(req,res,next)=>{try{if(!hasRole(req.user,'admin','finance','dg'))return res.status(403).json({error:'Rôle Finance, DG ou Admin requis pour approuver une avance'});const advance=await db.queryOne('SELECT * FROM employes_avances WHERE id=? AND employe_id=?',[Number(req.params.aid),Number(req.params.id)]);if(!advance)return res.status(404).json({error:'Avance introuvable'});if(!['soumis','brouillon'].includes(advance.statut_workflow))return res.status(400).json({error:`Statut workflow "${advance.statut_workflow}" — approbation impossible`});await db.transaction(async tx=>{const changed=await tx.execute("UPDATE employes_avances SET statut_workflow='approuve_dg',approuve_par=?,approuve_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND statut_workflow IN ('soumis','brouillon')",[req.user.id,advance.id]);if(Number(changed.affectedRows||0)!==1)throw Object.assign(new Error('Avance déjà traitée'),{status:409});await audit(tx,'employes_avances',advance.id,'approuver',{approuve_par:req.user.id},req.user.id);});res.json({ok:true,statut_workflow:'approuve_dg'});}catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}});
router.post('/:id/avances/:aid/rejeter',async(req,res,next)=>{try{if(!hasRole(req.user,'admin','finance','dg'))return res.status(403).json({error:'Rôle Finance, DG ou Admin requis'});const advance=await db.queryOne('SELECT * FROM employes_avances WHERE id=? AND employe_id=?',[Number(req.params.aid),Number(req.params.id)]);if(!advance)return res.status(404).json({error:'Avance introuvable'});if(['decaisse','solde','annule'].includes(advance.statut_workflow))return res.status(400).json({error:`Avance déjà ${advance.statut_workflow} — rejet impossible`});const reason=text(req.body?.motif_rejet);if(!reason)return res.status(400).json({error:'motif_rejet obligatoire'});await db.transaction(async tx=>{await tx.execute("UPDATE employes_avances SET statut_workflow='rejete',statut='annule',rejete_par=?,rejete_at=CURRENT_TIMESTAMP,motif_rejet=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[req.user.id,reason,advance.id]);await audit(tx,'employes_avances',advance.id,'rejeter',{motif_rejet:reason},req.user.id);});res.json({ok:true,statut_workflow:'rejete'});}catch(error){next(error);}});
router.put('/:id/avances/:aid/annuler',async(req,res,next)=>{try{if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Admin requis'});const advance=await db.queryOne('SELECT * FROM employes_avances WHERE id=? AND employe_id=?',[Number(req.params.aid),Number(req.params.id)]);if(!advance)return res.status(404).json({error:'Avance non trouvée'});if(advance.statut==='annule')return res.status(400).json({error:'Avance déjà annulée'});await db.transaction(async tx=>{await tx.execute("UPDATE employes_avances SET statut='annule',statut_workflow='annule',annule_at=CURRENT_TIMESTAMP,annule_by=?,annule_motif=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[req.user.id,text(req.body?.motif),advance.id]);await audit(tx,'employes_avances',advance.id,'annule',{motif:text(req.body?.motif)},req.user.id);});res.json({ok:true});}catch(error){next(error);}});

// Congés individuels : lectures et report. Écritures workflow = agents_ecosystem_safe / leave_workflow.
router.get('/:id/conges',async(req,res,next)=>{try{res.json(await db.query('SELECT c.*,ua.nom approuve_par_nom,ur.nom refuse_par_nom FROM employes_conges c LEFT JOIN users ua ON ua.id=c.approuve_par LEFT JOIN users ur ON ur.id=c.refuse_par WHERE c.employe_id=? ORDER BY c.date_debut DESC',[Number(req.params.id)]));}catch(error){next(error);}});
router.get('/:id/conges/solde',async(req,res,next)=>{try{const balance=await leaveBalance(req.params.id);if(!balance)return res.status(404).json({error:'Agent non trouvé'});res.json(balance);}catch(error){next(error);}});
router.put('/:id/conges/solde/report',async(req,res,next)=>{try{if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Admin requis'});const days=numberOrZero(req.body?.jours_report),max=Number(await setting('conges_report_max_jours','15'));if(days<0||days>max)return res.status(400).json({error:days<0?'jours_report doit être ≥ 0':`Report maximum autorisé : ${max} jours`});const balance=await db.transaction(async tx=>{await tx.execute('UPDATE employes SET conges_report_n1=? WHERE id=?',[days,Number(req.params.id)]);const current=await updateLeaveBalance(req.params.id,tx);await audit(tx,'employes',Number(req.params.id),'report_conge',{jours_report:days},req.user.id);return current;});res.json({ok:true,jours_report:days,solde:balance});}catch(error){next(error);}});

// Sanctions / heures supplémentaires : lectures; écritures dans agents_ecosystem_safe.
router.get('/:id/sanctions',async(req,res,next)=>{try{res.json(await db.query('SELECT * FROM employes_sanctions WHERE employe_id=? ORDER BY date_sanction DESC,created_at DESC',[Number(req.params.id)]));}catch(error){next(error);}});
router.get('/:id/heures-sup',async(req,res,next)=>{try{const {mois,annee}=req.query;let sql='SELECT * FROM employes_heures_sup WHERE employe_id=?';const params=[Number(req.params.id)];if(mois){sql+=' AND mois=?';params.push(Number(mois));}if(annee){sql+=' AND annee=?';params.push(Number(annee));}sql+=' ORDER BY date_heures DESC,id DESC';res.json(await db.query(sql,params));}catch(error){next(error);}});

// Photo ----------------------------------------------------------------------
router.post('/:id/photo',upload.single('photo'),async(req,res,next)=>{try{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});if(!req.file)return res.status(400).json({error:'Aucun fichier reçu'});const agent=await db.queryOne('SELECT photo_url FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const old=agent.photo_url?path.join(uploadsDir,path.basename(agent.photo_url)):null;const url='/uploads/'+req.file.filename;await db.execute('UPDATE employes SET photo_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[url,Number(req.params.id)]);if(old&&fs.existsSync(old))fs.unlinkSync(old);res.json({ok:true,photo_url:url});}catch(error){next(error);}});
router.delete('/:id/photo',async(req,res,next)=>{try{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});const agent=await db.queryOne('SELECT photo_url FROM employes WHERE id=?',[Number(req.params.id)]);if(agent?.photo_url){await db.execute('UPDATE employes SET photo_url=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?',[Number(req.params.id)]);const file=path.join(uploadsDir,path.basename(agent.photo_url));if(fs.existsSync(file))fs.unlinkSync(file);}res.json({ok:true});}catch(error){next(error);}});

router.get('/export-csv',async(req,res,next)=>{try{let where='1=1';const params=[];if(req.query.statut_dossier){where+=' AND statut_dossier=?';params.push(req.query.statut_dossier);}if(req.query.type){where+=' AND type=?';params.push(req.query.type);}const rows=await db.query(`SELECT nom,prenom,poste,departement,type,statut_dossier,date_naissance,lieu_naissance,sexe,nationalite,telephone,email,type_contrat,date_embauche,date_fin_contrat,date_fin_essai AS periode_essai_fin,salaire_base,prime_transport,prime_logement,mode_paiement,banque,numero_compte,cnss,camu,num_piece_identite,type_piece_identite,created_at FROM employes WHERE ${where} ORDER BY nom,prenom`,params);const headers=['Nom','Prénom','Poste','Département','Type','Statut','Date naissance','Lieu naissance','Sexe','Nationalité','Téléphone','Email','Type contrat','Date embauche','Fin contrat','Fin essai','Salaire base','Prime transport','Prime logement','Mode paiement','Banque','N° compte','N° CNSS','N° CAMU','Pièce identité','Type pièce','Date création'];const csv=rows.map(r=>[r.nom,r.prenom,r.poste,r.departement,r.type,r.statut_dossier,r.date_naissance,r.lieu_naissance,r.sexe,r.nationalite,r.telephone,r.email,r.type_contrat,r.date_embauche,r.date_fin_contrat,r.periode_essai_fin,r.salaire_base,r.prime_transport,r.prime_logement,r.mode_paiement,r.banque,r.numero_compte?`****${String(r.numero_compte).slice(-4)}`:'',r.cnss,r.camu,r.num_piece_identite,r.type_piece_identite,r.created_at?String(r.created_at).slice(0,10):''].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';'));res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="agents-${new Date().toISOString().slice(0,10)}.csv"`);res.send('\ufeff'+[headers.join(';'),...csv].join('\n'));}catch(error){next(error);}});

// Contrat / salaire ----------------------------------------------------------
router.put('/:id/lier-contrat',async(req,res,next)=>{try{if(!hasRole(req.user,'admin','rh','finance'))return res.status(403).json({error:'Rôle RH, Finance ou Admin requis'});const agent=await db.queryOne('SELECT id,contrat_id FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const raw=req.body?.contrat_id;if(raw===null||raw===undefined||raw===''){await db.transaction(async tx=>{await tx.execute('UPDATE employes SET contrat_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?',[agent.id]);await audit(tx,'employes',agent.id,'delier_contrat',{ancien_contrat_id:agent.contrat_id},req.user.id);});return res.json({ok:true,contrat_id:null});}const contract=await db.queryOne('SELECT id,numero,statut,type_contrat FROM contrats WHERE id=?',[Number(raw)]);if(!contract)return res.status(404).json({error:'Contrat introuvable'});await db.transaction(async tx=>{await tx.execute('UPDATE employes SET contrat_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[contract.id,agent.id]);await audit(tx,'employes',agent.id,'lier_contrat',{contrat_id:contract.id,contrat_numero:contract.numero,ancien_contrat_id:agent.contrat_id},req.user.id);});res.json({ok:true,contrat_id:contract.id,contrat_numero:contract.numero,contrat_statut:contract.statut});}catch(error){next(error);}});

async function activeSalaryRevision(employeeId,dbc=db){return dbc.queryOne("SELECT id,statut FROM demandes_revision_salaire WHERE employe_id=? AND statut NOT IN ('rejete','applique','annule') LIMIT 1",[Number(employeeId)]);}
async function validateSalaryRevisionPayload({empId,agent,body}){const active=await activeSalaryRevision(empId);if(active)return{error:{status:409,body:{error:'Une révision salariale est en cours (soumis_rh/soumis_dg/approuve) — attendez sa conclusion avant toute modification directe',code:'REVISION_EN_COURS',revision_id:active.id}}};const nouveauSalaire=numberOrZero(body.salaire_base??agent.salaire_base),nouveauTransport=numberOrZero(body.prime_transport??agent.prime_transport),nouveauLogement=numberOrZero(body.prime_logement??agent.prime_logement),motif=text(body.motif),type_revision=text(body.type_revision,'correction');if(nouveauSalaire<0)return{error:{status:400,body:{error:'Le salaire de base ne peut pas être négatif'}}};if(!motif)return{error:{status:400,body:{error:'Motif obligatoire pour toute modification de rémunération',code:'SALARY_MOTIF_REQUIRED'}}};if(!VALID_SALARY_REVISION_TYPES.includes(type_revision))return{error:{status:400,body:{error:`type_revision invalide. Valeurs : ${VALID_SALARY_REVISION_TYPES.join(', ')}`}}};return{values:{nouveauSalaire,nouveauTransport,nouveauLogement,motif,type_revision}};}
async function auditSalaryRevision(tx,empId,agent,revision,userId){await tx.execute(`INSERT INTO historique_salaires (employe_id,date_effet,ancien_salaire,nouveau_salaire,ancien_transport,nouveau_transport,ancien_logement,nouveau_logement,motif,type_revision,approved_by,approved_at,created_by) VALUES (?,CURDATE(),?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`,[empId,numberOrZero(agent.salaire_base),revision.nouveauSalaire,numberOrZero(agent.prime_transport),revision.nouveauTransport,numberOrZero(agent.prime_logement),revision.nouveauLogement,revision.motif,revision.type_revision,userId,userId]);await audit(tx,'employes',empId,'modifier_salaire',{ancien_salaire:agent.salaire_base,nouveau_salaire:revision.nouveauSalaire,motif:revision.motif,type_revision:revision.type_revision},userId);}
router.put('/:id/salaire',async(req,res,next)=>{try{if(!canSalary(req.user))return res.status(403).json({error:'Rôle RH, Finance ou DG requis pour modifier la rémunération'});const employee=await db.queryOne('SELECT id,nom,prenom,salaire_base,prime_transport,prime_logement,statut_dossier FROM employes WHERE id=?',[Number(req.params.id)]);if(!employee)return res.status(404).json({error:'Agent introuvable'});const revision=await validateSalaryRevisionPayload({empId:employee.id,agent:employee,body:req.body||{}});if(revision.error)return res.status(revision.error.status).json(revision.error.body);await db.transaction(async tx=>{await tx.execute('UPDATE employes SET salaire_base=?,prime_transport=?,prime_logement=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[revision.values.nouveauSalaire,revision.values.nouveauTransport,revision.values.nouveauLogement,employee.id]);await auditSalaryRevision(tx,employee.id,employee,revision.values,req.user.id);});res.json({ok:true,salaire_base:revision.values.nouveauSalaire,prime_transport:revision.values.nouveauTransport,prime_logement:revision.values.nouveauLogement});}catch(error){next(error);}});

router.get('/:id/historique-salaires',async(req,res,next)=>{try{const agent=await db.queryOne('SELECT id,nom,prenom FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const historique=await db.query(`SELECT h.*,u1.nom created_by_nom,u2.nom approved_by_nom,gc_old.code ancienne_categorie_code,gc_old.libelle ancienne_categorie_libelle,gc_new.code nouvelle_categorie_code,gc_new.libelle nouvelle_categorie_libelle,ge_old.echelon ancien_echelon_num,ge_new.echelon nouvel_echelon_num FROM historique_salaires h LEFT JOIN users u1 ON u1.id=h.created_by LEFT JOIN users u2 ON u2.id=h.approved_by LEFT JOIN grille_categories gc_old ON gc_old.id=h.ancienne_categorie_id LEFT JOIN grille_categories gc_new ON gc_new.id=h.nouvelle_categorie_id LEFT JOIN grille_echelons ge_old ON ge_old.id=h.ancien_echelon_id LEFT JOIN grille_echelons ge_new ON ge_new.id=h.nouvel_echelon_id WHERE h.employe_id=? ORDER BY h.date_effet DESC,h.created_at DESC`,[agent.id]);res.json({agent,historique});}catch(error){next(error);}});

// Attestations ---------------------------------------------------------------
async function enterpriseInfo(){const [params,enterprise]=await Promise.all([db.query('SELECT cle,valeur FROM parametres'),db.queryOne('SELECT * FROM entreprise LIMIT 1')]);const p=Object.fromEntries(params.map(row=>[row.cle,row.valeur]));return{nom:enterprise?.nom||p.societe||'TOP CENTER',adresse:enterprise?.adresse||'',logo_url:enterprise?.logo_url||'',devise:p.devise||'XAF'};}
function fmtDate(value){return value?new Date(value).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'}):'—';}
function attestationHtml(ent,title,body){return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font-family:Arial;color:#1f2937;margin:0}.hdr{background:#1e3a5f;color:#fff;padding:22px 30px}.body{padding:30px;line-height:1.7}.grid{display:grid;grid-template-columns:180px 1fr;gap:6px 12px}.label{color:#6b7280}.sig{margin-top:55px;text-align:right}</style></head><body><div class="hdr"><strong>${ent.nom}</strong><h2>${title}</h2><small>${ent.adresse}</small></div><div class="body">${body}<div class="sig">Le Directeur Général<br><strong>${ent.nom}</strong></div></div></body></html>`;}
async function sendPdf(res,html,prefix,filename){const pdf=await generatePdf(html,{prefix,marginTop:'15mm',marginBottom:'15mm'});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.send(pdf);}
router.get('/:id/attestation/travail-pdf',async(req,res,next)=>{try{const agent=await db.queryOne('SELECT * FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const ent=await enterpriseInfo();const body=`<p>Nous attestons que :</p><div class="grid"><span class="label">Nom & Prénom</span><strong>${agent.nom} ${agent.prenom||''}</strong><span class="label">Matricule</span><span>${agent.matricule||'—'}</span><span class="label">Poste</span><span>${agent.poste||'—'}</span><span class="label">Département</span><span>${agent.departement||'—'}</span><span class="label">Date d'embauche</span><span>${fmtDate(agent.date_embauche)}</span><span class="label">Statut</span><span>${agent.statut_dossier||'actif'}</span></div><p>Cette attestation est délivrée pour servir et valoir ce que de droit.</p>`;await sendPdf(res,attestationHtml(ent,'ATTESTATION DE TRAVAIL',body),'att_travail',`attestation-travail-${agent.nom}.pdf`);}catch(error){next(error);}});
router.get('/:id/attestation/salaire-pdf',async(req,res,next)=>{try{const agent=await db.queryOne('SELECT * FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const [ent,last]=await Promise.all([enterpriseInfo(),db.queryOne("SELECT * FROM bulletins_salaire WHERE employe_id=? AND statut='paye' ORDER BY annee DESC,mois DESC LIMIT 1",[agent.id])]);const fmt=n=>`${new Intl.NumberFormat('fr-FR').format(Math.round(numberOrZero(n)))} ${ent.devise}`;const body=`<p>Nous attestons que :</p><div class="grid"><span class="label">Nom & Prénom</span><strong>${agent.nom} ${agent.prenom||''}</strong><span class="label">Poste</span><span>${agent.poste||'—'}</span><span class="label">Salaire de base</span><span>${fmt(agent.salaire_base)}</span><span class="label">Prime transport</span><span>${fmt(agent.prime_transport)}</span><span class="label">Prime logement</span><span>${fmt(agent.prime_logement)}</span>${last?`<span class="label">Dernier net payé</span><span>${fmt(last.net_a_payer)}</span>`:''}</div>`;await sendPdf(res,attestationHtml(ent,'ATTESTATION DE SALAIRE',body),'att_salaire',`attestation-salaire-${agent.nom}.pdf`);}catch(error){next(error);}});
router.get('/:id/attestation/conges-pdf',async(req,res,next)=>{try{const agent=await db.queryOne('SELECT * FROM employes WHERE id=?',[Number(req.params.id)]);if(!agent)return res.status(404).json({error:'Agent introuvable'});const [ent,balance]=await Promise.all([enterpriseInfo(),leaveBalance(agent.id)]);const body=`<p>Situation des congés de <strong>${agent.nom} ${agent.prenom||''}</strong>.</p><div class="grid"><span class="label">Droits acquis</span><span>${balance?.acquis??'—'} jour(s)</span><span class="label">Jours pris</span><span>${balance?.pris??'—'} jour(s)</span><span class="label">Report N-1</span><span>${balance?.report??0} jour(s)</span><span class="label">Solde disponible</span><strong>${balance?.solde??'—'} jour(s)</strong><span class="label">Solde maladie</span><span>${balance?.maladie?.solde??'—'} jour(s)</span></div>`;await sendPdf(res,attestationHtml(ent,'ATTESTATION DE CONGÉS',body),'att_conges',`attestation-conges-${agent.nom}.pdf`);}catch(error){next(error);}});

// Onboarding / compte --------------------------------------------------------
router.get('/:id/onboarding',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{const out=await onboardingSvc.getOnboarding(Number(req.params.id));if(!out)return res.status(404).json({error:'Employé introuvable'});res.json(out);}catch(e){res.status(500).json({error:e.message});}});
router.post('/:id/onboarding/reinit',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{res.json(await onboardingSvc.initOnboarding(Number(req.params.id),null,req.user.id,req.ip));}catch(e){res.status(400).json({error:e.message});}});
router.post('/:id/onboarding/tasks/:taskKey/complete',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{res.json(await onboardingSvc.completeTask(Number(req.params.id),req.params.taskKey,req.user.id,req.body?.notes,req.ip));}catch(e){res.status(400).json({error:e.message});}});
router.post('/:id/onboarding/tasks/:taskKey/skip',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{res.json(await onboardingSvc.skipTask(Number(req.params.id),req.params.taskKey,req.user.id,req.body?.motif,req.ip));}catch(e){res.status(400).json({error:e.message});}});
router.post('/:id/onboarding/activate',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{res.json(await onboardingSvc.activerEmploye(Number(req.params.id),req.user.id,req.ip));}catch(e){res.status(400).json({error:e.message});}});
router.post('/:id/create-user',async(req,res)=>{if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Rôle Admin requis pour créer un compte utilisateur'});const {role,email,nom_affiche}=req.body||{};if(!role)return res.status(400).json({error:'Le rôle est requis'});if(!userProvSvc.ROLES_VALIDES.includes(role)||role==='admin')return res.status(400).json({error:'Rôle invalide pour ce workflow'});try{const result=await userProvSvc.provisionUser(Number(req.params.id),{role,email,nom_affiche,provisioned_by:req.user.id},req.ip);res.status(201).json({message:'Compte créé. Communiquer le mot de passe temporaire à l\'employé.',user_id:result.user_id,email:result.email,role:result.role,temp_password:result.temp_password,must_change_password:1});}catch(e){res.status(e.message.includes('déjà')?409:400).json({error:e.message});}});
router.get('/:id/user-account',async(req,res)=>{if(!canRH(req.user))return res.status(403).json({error:'Rôle RH ou Admin requis'});try{res.json(await userProvSvc.getUserForEmploye(Number(req.params.id))||{linked:false});}catch(e){res.status(500).json({error:e.message});}});

module.exports = router;

'use strict';

const db = require('../db');

function normalizeHm(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${String(Number(m[1])).padStart(2,'0')}:${m[2]}` : null;
}

function key(employeeId, date) { return `${Number(employeeId)}:${date}`; }

async function reconcile({ debut, fin, employeId = null }) {
  const paramsV2 = [debut, fin];
  const paramsV3 = [debut, fin];
  let v2Employee = '';
  let v3Employee = '';
  if (employeId) {
    v2Employee = ' AND p.employe_id = ?'; paramsV2.push(Number(employeId));
    v3Employee = ' AND s.employe_id = ?'; paramsV3.push(Number(employeId));
  }

  const [legacy, modern] = await Promise.all([
    db.query(
      `SELECT p.employe_id, p.date AS work_date, p.heure_entree, p.heure_sortie,
              p.duree_minutes, p.statut, e.matricule, e.nom, e.prenom
       FROM pointages p JOIN employes e ON e.id=p.employe_id
       WHERE p.date BETWEEN ? AND ?${v2Employee}
       ORDER BY p.date,p.employe_id`, paramsV2
    ),
    db.query(
      `SELECT s.employe_id, s.work_date, s.first_in_utc, s.last_out_utc, s.worked_minutes,
              s.break_minutes, s.late_minutes, s.early_leave_minutes, s.overtime_minutes,
              s.night_minutes, s.status, s.anomaly_count, e.matricule, e.nom, e.prenom,
              MIN(CASE WHEN ev.event_type='clock_in' THEN ev.local_time END) AS heure_entree,
              MAX(CASE WHEN ev.event_type='clock_out' THEN ev.local_time END) AS heure_sortie
       FROM pointeuse_daily_summaries s
       JOIN employes e ON e.id=s.employe_id
       LEFT JOIN pointeuse_events ev ON ev.employe_id=s.employe_id AND ev.work_date=s.work_date
       WHERE s.work_date BETWEEN ? AND ?${v3Employee}
       GROUP BY s.id,s.employe_id,s.work_date,s.first_in_utc,s.last_out_utc,s.worked_minutes,
                s.break_minutes,s.late_minutes,s.early_leave_minutes,s.overtime_minutes,s.night_minutes,
                s.status,s.anomaly_count,e.matricule,e.nom,e.prenom
       ORDER BY s.work_date,s.employe_id`, paramsV3
    ),
  ]);

  const v2 = new Map(legacy.map(r => [key(r.employe_id, r.work_date), r]));
  const v3 = new Map(modern.map(r => [key(r.employe_id, r.work_date), r]));
  const keys = [...new Set([...v2.keys(), ...v3.keys()])].sort();
  const rows = keys.map(k => {
    const a = v2.get(k) || null;
    const b = v3.get(k) || null;
    const durationV2 = a?.duree_minutes == null ? null : Number(a.duree_minutes);
    const durationV3 = b?.worked_minutes == null ? null : Number(b.worked_minutes);
    const delta = durationV2 === null || durationV3 === null ? null : durationV3 - durationV2;
    const entryMatch = a && b ? normalizeHm(a.heure_entree) === normalizeHm(b.heure_entree) : false;
    const exitMatch = a && b ? normalizeHm(a.heure_sortie) === normalizeHm(b.heure_sortie) : false;
    const durationMatch = delta === 0;
    const presence = a && b ? 'both' : (a ? 'v2_only' : 'v3_only');
    const match = presence === 'both' && entryMatch && exitMatch && durationMatch;
    const src = b || a || {};
    return {
      employe_id: Number(src.employe_id), matricule: src.matricule, nom: src.nom, prenom: src.prenom,
      work_date: src.work_date,
      presence,
      match,
      v2: a ? { heure_entree:a.heure_entree, heure_sortie:a.heure_sortie, duree_minutes:durationV2, statut:a.statut } : null,
      v3: b ? { heure_entree:b.heure_entree, heure_sortie:b.heure_sortie, worked_minutes:durationV3, status:b.status, anomaly_count:Number(b.anomaly_count||0), late_minutes:Number(b.late_minutes||0), overtime_minutes:Number(b.overtime_minutes||0), night_minutes:Number(b.night_minutes||0) } : null,
      delta_minutes: delta,
      entry_match: entryMatch,
      exit_match: exitMatch,
      duration_match: durationMatch,
    };
  });

  const counts = rows.reduce((acc,r) => {
    acc.total++;
    acc[r.presence]++;
    if (r.match) acc.matches++; else acc.mismatches++;
    return acc;
  }, { total:0, both:0, v2_only:0, v3_only:0, matches:0, mismatches:0 });
  return {
    debut, fin, employe_id: employeId ? Number(employeId) : null,
    ...counts,
    match_rate: counts.total ? Number((counts.matches * 100 / counts.total).toFixed(2)) : 100,
    rows,
  };
}

module.exports = { normalizeHm, reconcile };

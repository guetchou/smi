'use strict';

const db = require('../db');
const workflow = require('./department_function_workflow');

async function enrichRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const ids = [...new Set(rows.map(row => Number(row.id)).filter(Boolean))];
  if (!ids.length) return rows;
  const details = await db.query(`
    SELECT f.id,
           u.libelle AS unite_libelle,
           u.type_unite,
           p.libelle AS poste_officiel_libelle,
           COALESCE(p.libelle, e.poste) AS poste_affiche
    FROM org_departement_fonctions f
    JOIN employes e ON e.id=f.employe_id
    LEFT JOIN org_unites u ON u.id=f.unite_id
    LEFT JOIN org_postes p ON p.id=f.poste_id
    WHERE f.id IN (${ids.map(() => '?').join(',')})
  `, ids);
  const byId = new Map(details.map(row => [Number(row.id), row]));
  return rows.map(row => ({ ...row, ...(byId.get(Number(row.id)) || {}) }));
}

async function list(filters = {}) {
  return enrichRows(await workflow.list(filters));
}

async function get(id) {
  const row = await workflow.get(id);
  if (!row) return null;
  const [enriched] = await enrichRows([row]);
  return enriched;
}

async function departmentOverview() {
  const departments = await workflow.departmentOverview();
  const result = [];
  for (const dept of departments) {
    const functions = await enrichRows(dept.fonctions || []);
    result.push({
      ...dept,
      fonctions: functions,
      adjoints: functions.filter(row => ['premier_adjoint', 'adjoint', 'suppleant'].includes(row.fonction_type)),
    });
  }
  return result;
}

module.exports = { ...workflow, list, get, departmentOverview };

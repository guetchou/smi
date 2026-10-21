'use strict';

function badRequest(message) { const error = new Error(message); error.status = 400; throw error; }
function dateFilter(value) {
  if (!value) return '';
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) badRequest('Date de filtre invalide');
  return date;
}
function buildAuditFilters(query = {}) {
  const clauses = [], params = [];
  if (query.user_id) {
    const id = Number(query.user_id);
    if (!Number.isSafeInteger(id) || id < 1) badRequest('Utilisateur invalide');
    clauses.push('a.user_id = ?'); params.push(id);
  }
  for (const key of ['table_name', 'action']) if (query[key]) {
    if (typeof query[key] !== 'string' || query[key].length > 100) badRequest('Filtre invalide');
    clauses.push('a.' + key + ' = ?'); params.push(query[key]);
  }
  const debut = dateFilter(query.debut), fin = dateFilter(query.fin);
  if (debut && fin && debut > fin) badRequest('La date de début doit précéder la date de fin');
  if (debut) { clauses.push('a.created_at >= ?'); params.push(debut); }
  if (fin) { clauses.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(fin); }
  if (query.search) {
    if (typeof query.search !== 'string' || query.search.length > 200) badRequest('Recherche trop longue');
    clauses.push('(a.action LIKE ? OR a.table_name LIKE ? OR a.details LIKE ? OR u.nom LIKE ? OR u.email LIKE ?)');
    for (let i = 0; i < 5; i++) params.push('%' + query.search + '%');
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
async function readAuditLogs(db, query = {}) {
  const { where, params } = buildAuditFilters(query);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) badRequest('Pagination invalide');
  const from = 'FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ';
  const [counts, rows] = await Promise.all([
    db.query('SELECT COUNT(*) AS total ' + from + where, params),
    db.query('SELECT a.*, u.nom AS user_nom, u.email AS user_email, u.role AS user_role ' + from + where + ' ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?', [...params, limit, offset])
  ]);
  const result = { total: Number(counts[0]?.total || 0), rows };
  if (String(query.include_meta || '1') !== '0') {
    const [modules, actions, users] = await Promise.all([
      db.query('SELECT DISTINCT table_name FROM audit_logs ORDER BY table_name'),
      db.query('SELECT DISTINCT action FROM audit_logs ORDER BY action'),
      db.query('SELECT DISTINCT u.id, u.nom, u.email FROM users u JOIN audit_logs a ON a.user_id = u.id ORDER BY u.nom')
    ]);
    result.meta = { modules: modules.map(row => row.table_name), actions: actions.map(row => row.action), users };
  }
  return result;
}
module.exports = { buildAuditFilters, readAuditLogs };

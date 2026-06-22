'use strict';

const db = require('../database');

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function addColumn(table, known, name, definition) {
  if (known.has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  known.add(name);
}

function ensureSqliteMutationWorkflowSchema() {
  if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') return;
  if (!tableExists('employes_mutations')) return;

  const known = columns('employes_mutations');
  addColumn('employes_mutations', known, 'submitted_by', 'INTEGER');
  addColumn('employes_mutations', known, 'submitted_at', 'TEXT');
  addColumn('employes_mutations', known, 'refused_by', 'INTEGER');
  addColumn('employes_mutations', known, 'refused_at', 'TEXT');
  addColumn('employes_mutations', known, 'cancelled_by', 'INTEGER');
  addColumn('employes_mutations', known, 'cancelled_at', 'TEXT');
  addColumn('employes_mutations', known, 'applied_by', 'INTEGER');
  addColumn('employes_mutations', known, 'applied_at', 'TEXT');
  addColumn('employes_mutations', known, 'updated_at', 'TEXT');
  addColumn('employes_mutations', known, 'revision', 'INTEGER NOT NULL DEFAULT 1');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutations_workflow_status
      ON employes_mutations(statut, date_effective, date_effet);
  `);

  db.prepare("UPDATE employes_mutations SET statut='soumis' WHERE statut='propose'").run();
  db.prepare(`
    UPDATE employes_mutations
    SET date_effective=COALESCE(date_effective, date_effet), revision=COALESCE(revision, 1)
  `).run();

  if (!tableExists('permissions') || !tableExists('profiles') || !tableExists('profile_permissions')) return;

  const permissions = [
    ['hr.mutation.create', 'mutation.create', 'Créer une mutation RH', 0],
    ['hr.mutation.submit', 'mutation.submit', 'Soumettre une mutation RH', 0],
    ['hr.mutation.approve', 'mutation.approve', 'Approuver ou refuser une mutation RH', 1],
    ['hr.mutation.apply', 'mutation.apply', 'Appliquer une mutation RH', 1],
    ['hr.mutation.cancel', 'mutation.cancel', 'Annuler une mutation RH', 0],
  ];
  const insertPermission = db.prepare(`
    INSERT OR IGNORE INTO permissions (code, module, action, libelle, sensitive, actif)
    VALUES (?, 'hr', ?, ?, ?, 1)
  `);
  permissions.forEach(row => insertPermission.run(...row));

  const grant = db.prepare(`
    INSERT OR IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
    SELECT pr.id, pm.id, 1
    FROM profiles pr, permissions pm
    WHERE pr.code=? AND pm.code=?
  `);
  ['admin', 'rh', 'dg'].forEach(profile => {
    ['hr.mutation.create', 'hr.mutation.submit', 'hr.mutation.cancel'].forEach(permission => grant.run(profile, permission));
  });
  ['admin', 'dg'].forEach(profile => {
    ['hr.mutation.approve', 'hr.mutation.apply'].forEach(permission => grant.run(profile, permission));
  });
}

module.exports = { ensureSqliteMutationWorkflowSchema };

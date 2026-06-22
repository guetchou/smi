'use strict';

const db = require('../database');
const { installDepartmentFunctionSafety } = require('./organization_department_functions_safety');

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ensureSqliteDepartmentFunctionsSchema() {
  if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') return;
  if (!tableExists('org_departements') || !tableExists('employes')) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS org_departement_fonctions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      departement_id INTEGER NOT NULL,
      employe_id INTEGER NOT NULL,
      fonction_type TEXT NOT NULL,
      rang INTEGER NOT NULL DEFAULT 0,
      perimetre TEXT,
      date_debut TEXT NOT NULL,
      date_fin TEXT,
      titulaire INTEGER NOT NULL DEFAULT 1,
      actif INTEGER NOT NULL DEFAULT 1,
      decision_reference TEXT,
      created_by INTEGER,
      approved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(departement_id, employe_id, fonction_type, date_debut)
    );
    CREATE INDEX IF NOT EXISTS idx_org_df_departement_actif
      ON org_departement_fonctions(departement_id, actif, fonction_type, rang);
    CREATE INDEX IF NOT EXISTS idx_org_df_employe_actif
      ON org_departement_fonctions(employe_id, actif);
    CREATE INDEX IF NOT EXISTS idx_org_df_dates
      ON org_departement_fonctions(date_debut, date_fin);
  `);

  db.prepare(`
    INSERT OR IGNORE INTO org_departement_fonctions
      (departement_id, employe_id, fonction_type, rang, perimetre, date_debut, titulaire, actif, decision_reference)
    SELECT d.id, d.responsable_id, 'chef', 0, 'Ensemble du département',
           COALESCE(e.date_embauche, date('now')), 1, 1, 'Reprise du responsable historique'
    FROM org_departements d
    JOIN employes e ON e.id = d.responsable_id
    WHERE d.actif = 1 AND d.responsable_id IS NOT NULL
  `).run();
}

installDepartmentFunctionSafety();

module.exports = { ensureSqliteDepartmentFunctionsSchema };

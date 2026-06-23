'use strict';

process.env.DB_DRIVER = 'mysql';
const db = require('../backend/db');

async function count(sql, params = []) {
  const row = await db.queryOne(sql, params);
  return Number(row?.total || 0);
}

async function main() {
  const result = { ok: true, module: 'department-organization' };

  result.workflow_columns = await count(`
    SELECT COUNT(*) AS total
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_departement_fonctions'
      AND COLUMN_NAME IN (
        'entreprise_id','statut','version','motif','motif_refus','document_nom','document_url','document_hash',
        'submitted_by','submitted_at','approved_at','refused_by','refused_at','cancelled_by','cancelled_at',
        'effective_at','closed_by','closed_at','singleton_key','unite_id','poste_id'
      )
  `);
  if (result.workflow_columns < 21) throw new Error(`Colonnes du module incomplètes: ${result.workflow_columns}/21`);

  result.event_table = await count(`
    SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_departement_fonction_events'
  `);
  if (result.event_table !== 1) throw new Error('Table des événements absente');

  result.units_table = await count(`
    SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_unites'
  `);
  if (result.units_table !== 1) throw new Error('Table des unités absente');

  result.employee_job_column = await count(`
    SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employes' AND COLUMN_NAME='poste_id'
  `);
  if (result.employee_job_column !== 1) throw new Error('Liaison employe.poste_id absente');

  result.singleton_index = await count(`
    SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_departement_fonctions'
      AND INDEX_NAME='uq_org_df_singleton_active' AND NON_UNIQUE=0
  `);
  if (result.singleton_index < 1) throw new Error('Index unique des fonctions singleton absent');

  result.foreign_keys = await count(`
    SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN (
      'fk_employe_poste_officiel','fk_org_df_unite','fk_org_df_poste','fk_org_unite_departement'
    )
  `);
  if (result.foreign_keys < 4) throw new Error(`Clés étrangères incomplètes: ${result.foreign_keys}/4`);

  result.permissions = await count(`
    SELECT COUNT(*) AS total FROM permissions
    WHERE code IN (
      'hr.department_function.view','hr.department_function.create','hr.department_function.submit',
      'hr.department_function.approve','hr.department_function.activate','hr.department_function.close',
      'hr.department_function.attach_document','hr.department_function.report'
    ) AND actif=1
  `);
  if (result.permissions < 8) throw new Error(`Permissions incomplètes: ${result.permissions}/8`);

  result.notification_rules = await count(`
    SELECT COUNT(*) AS total FROM notif_regles
    WHERE type IN (
      'ORG_FUNCTION_SUBMITTED','ORG_FUNCTION_APPROVED','ORG_FUNCTION_REFUSED',
      'ORG_FUNCTION_EFFECTIVE','ORG_FUNCTION_EXPIRING','ORG_FUNCTION_ENDED'
    ) AND actif=1
  `);
  if (result.notification_rules < 6) throw new Error(`Règles de notification incomplètes: ${result.notification_rules}/6`);

  const duplicates = await db.query(`
    SELECT departement_id, fonction_type, COUNT(*) AS total
    FROM org_departement_fonctions
    WHERE actif=1 AND fonction_type IN ('chef','premier_adjoint','interimaire')
    GROUP BY departement_id, fonction_type
    HAVING COUNT(*)>1
  `);
  if (duplicates.length) throw new Error(`Doublons actifs détectés: ${JSON.stringify(duplicates)}`);
  result.duplicate_singletons = 0;

  result.invalid_statuses = await count(`
    SELECT COUNT(*) AS total FROM org_departement_fonctions
    WHERE statut NOT IN ('brouillon','soumis','approuve','refuse','actif','a_corriger','annule','cloture')
  `);
  if (result.invalid_statuses !== 0) throw new Error(`Statuts invalides détectés: ${result.invalid_statuses}`);

  result.invalid_unit_links = await count(`
    SELECT COUNT(*) AS total
    FROM org_departement_fonctions f
    JOIN org_unites u ON u.id=f.unite_id
    WHERE f.unite_id IS NOT NULL AND f.departement_id<>u.departement_id
  `);
  if (result.invalid_unit_links !== 0) throw new Error(`Rattachements d’unités invalides: ${result.invalid_unit_links}`);

  let rollbackConfirmed = false;
  try {
    await db.transaction(async tx => {
      await tx.queryOne('SELECT id FROM org_departements ORDER BY id LIMIT 1 FOR UPDATE');
      throw new Error('ROLLBACK_PROBE');
    });
  } catch (error) {
    rollbackConfirmed = error.message === 'ROLLBACK_PROBE';
  }
  if (!rollbackConfirmed) throw new Error('Rollback transactionnel non confirmé');
  result.transaction_rollback = true;

  console.log(JSON.stringify(result, null, 2));
}

main().then(() => db._pool.end()).catch(async error => {
  console.error('[department-functions-mysql-check]', error.message);
  try { await db._pool.end(); } catch (_) {}
  process.exitCode = 1;
});

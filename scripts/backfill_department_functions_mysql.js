'use strict';

process.env.DB_DRIVER = 'mysql';
const db = require('../backend/db');

async function main() {
  const enterprise = await db.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
  const inserted = await db.execute(`
    INSERT INTO org_departement_fonctions
      (entreprise_id, departement_id, employe_id, fonction_type, statut, version,
       rang, perimetre, motif, date_debut, titulaire, actif,
       decision_reference, created_at, updated_at, effective_at)
    SELECT ?, d.id, d.responsable_id, 'chef', 'actif', 1,
           0, 'Ensemble du département', 'Reprise du responsable historique',
           COALESCE(e.date_embauche, CURDATE()), 1, 1,
           'Reprise du responsable historique', NOW(), NOW(), NOW()
    FROM org_departements d
    JOIN employes e ON e.id=d.responsable_id
    WHERE d.actif=1 AND d.responsable_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM org_departement_fonctions f
        WHERE f.departement_id=d.id AND f.fonction_type='chef'
          AND f.statut='actif' AND f.actif=1
      )
  `, [enterprise?.id || null]);

  const events = await db.execute(`
    INSERT INTO org_departement_fonction_events
      (entreprise_id, fonction_id, event_type, statut_avant, statut_apres,
       version_avant, version_apres, details, actor_user_id)
    SELECT f.entreprise_id, f.id, 'legacy_import', NULL, f.statut,
           NULL, f.version, JSON_OBJECT('source','post_import_backfill'), f.created_by
    FROM org_departement_fonctions f
    WHERE NOT EXISTS (
      SELECT 1 FROM org_departement_fonction_events ev WHERE ev.fonction_id=f.id
    )
  `);

  console.log(JSON.stringify({
    ok: true,
    inserted_chiefs: inserted.affectedRows,
    inserted_events: events.affectedRows,
  }, null, 2));
}

main().then(() => db._pool.end()).catch(async error => {
  console.error('[department-functions-backfill]', error.message);
  try { await db._pool.end(); } catch (_) {}
  process.exitCode = 1;
});

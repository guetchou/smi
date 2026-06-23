'use strict';

const db = require('../db');

const EDITABLE = new Set(['brouillon', 'refuse', 'a_corriger']);

class DepartmentFunctionStructureError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'DepartmentFunctionStructureError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function setStructure(functionId, input, actorUserId) {
  const expectedVersion = Number(input?.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new DepartmentFunctionStructureError('La version du dossier est obligatoire.', 'VERSION_REQUIRED', 409);
  }
  const unitId = input?.unite_id ? Number(input.unite_id) : null;
  let postId = input?.poste_id ? Number(input.poste_id) : null;

  return db.transaction(async tx => {
    const current = await tx.queryOne(`
      SELECT f.*, e.poste AS employe_poste, e.poste_id AS employe_poste_id
      FROM org_departement_fonctions f
      JOIN employes e ON e.id=f.employe_id
      WHERE f.id=? FOR UPDATE
    `, [Number(functionId)]);
    if (!current) throw new DepartmentFunctionStructureError('Fonction introuvable.', 'FUNCTION_NOT_FOUND', 404);
    if (!EDITABLE.has(current.statut)) {
      throw new DepartmentFunctionStructureError('La structure ne peut être modifiée qu’au stade brouillon ou correction.', 'FUNCTION_STRUCTURE_LOCKED', 409);
    }
    if (Number(current.version) !== expectedVersion) {
      throw new DepartmentFunctionStructureError('Version obsolète.', 'FUNCTION_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }

    if (unitId) {
      const unit = await tx.queryOne(`
        SELECT id, departement_id, actif FROM org_unites WHERE id=? FOR UPDATE
      `, [unitId]);
      if (!unit || !unit.actif || Number(unit.departement_id) !== Number(current.departement_id)) {
        throw new DepartmentFunctionStructureError('L’unité doit être active dans le même département.', 'FUNCTION_UNIT_MISMATCH', 409);
      }
    }

    if (!postId && current.employe_poste_id) postId = Number(current.employe_poste_id);
    if (!postId && current.employe_poste) {
      const official = await tx.queryOne(`
        SELECT id FROM org_postes
        WHERE actif=1 AND LOWER(TRIM(libelle))=LOWER(TRIM(?))
        LIMIT 1
      `, [current.employe_poste]);
      if (official) {
        postId = Number(official.id);
        await tx.execute('UPDATE employes SET poste_id=?, updated_at=NOW() WHERE id=?', [postId, current.employe_id]);
      }
    }
    if (postId) {
      const post = await tx.queryOne('SELECT id, actif FROM org_postes WHERE id=? FOR UPDATE', [postId]);
      if (!post || !post.actif) throw new DepartmentFunctionStructureError('Poste officiel introuvable ou inactif.', 'OFFICIAL_JOB_NOT_ACTIVE', 409);
    }

    const nextVersion = expectedVersion + 1;
    const result = await tx.execute(`
      UPDATE org_departement_fonctions
      SET unite_id=?, poste_id=?, version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [unitId, postId, nextVersion, current.id, expectedVersion]);
    if (result.affectedRows !== 1) throw new DepartmentFunctionStructureError('Conflit de modification.', 'FUNCTION_VERSION_CONFLICT', 409);

    await tx.execute(`
      INSERT INTO org_departement_fonction_events
        (entreprise_id, fonction_id, event_type, statut_avant, statut_apres,
         version_avant, version_apres, details, actor_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, [
      current.entreprise_id || null,
      current.id,
      'structure_updated',
      current.statut,
      current.statut,
      expectedVersion,
      nextVersion,
      JSON.stringify({ unite_id: unitId, poste_id: postId }),
      actorUserId || null,
    ]);
    await tx.execute(`
      INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
      VALUES ('org_departement_fonctions',?,?,?,?,NOW())
    `, [current.id, 'structure_updated', JSON.stringify({ unite_id: unitId, poste_id: postId, version: nextVersion }), actorUserId || null]);

    return tx.queryOne(`
      SELECT f.*, u.libelle AS unite_libelle, u.type_unite,
             p.libelle AS poste_officiel_libelle
      FROM org_departement_fonctions f
      LEFT JOIN org_unites u ON u.id=f.unite_id
      LEFT JOIN org_postes p ON p.id=f.poste_id
      WHERE f.id=?
    `, [current.id]);
  });
}

module.exports = { DepartmentFunctionStructureError, setStructure };

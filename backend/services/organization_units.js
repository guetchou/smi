'use strict';

const db = require('../db');

const UNIT_TYPES = Object.freeze({
  service: 'Service',
  section: 'Section',
  cellule: 'Cellule',
  bureau: 'Bureau',
  equipe: 'Équipe',
});

class OrganizationUnitError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'OrganizationUnitError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clean(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function versionOf(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new OrganizationUnitError('La version de l’unité est obligatoire.', 'UNIT_VERSION_REQUIRED', 409);
  }
  return version;
}

async function getUnit(id, executor = db, lock = false) {
  return executor.queryOne(`
    SELECT u.*, p.libelle AS parent_libelle, d.libelle AS departement_libelle
    FROM org_unites u
    JOIN org_departements d ON d.id=u.departement_id
    LEFT JOIN org_unites p ON p.id=u.parent_id
    WHERE u.id=? ${lock ? 'FOR UPDATE' : ''}
  `, [Number(id)]);
}

async function list(departmentId, includeInactive = false) {
  const rows = await db.query(`
    SELECT u.*, p.libelle AS parent_libelle,
           COUNT(DISTINCT f.id) AS fonctions_total
    FROM org_unites u
    LEFT JOIN org_unites p ON p.id=u.parent_id
    LEFT JOIN org_departement_fonctions f ON f.unite_id=u.id
      AND f.statut NOT IN ('annule','cloture')
    WHERE u.departement_id=? ${includeInactive ? '' : 'AND u.actif=1'}
    GROUP BY u.id, p.libelle
    ORDER BY FIELD(u.type_unite,'service','section','cellule','bureau','equipe'), u.libelle
  `, [Number(departmentId)]);
  return rows.map(row => ({ ...row, type_libelle: UNIT_TYPES[row.type_unite] || row.type_unite }));
}

async function validateParent(tx, departmentId, parentId, selfId = null) {
  if (!parentId) return null;
  const parent = await getUnit(parentId, tx, true);
  if (!parent || !parent.actif || Number(parent.departement_id) !== Number(departmentId)) {
    throw new OrganizationUnitError('L’unité parente doit être active dans le même département.', 'INVALID_PARENT_UNIT', 409);
  }
  if (selfId && Number(parent.id) === Number(selfId)) {
    throw new OrganizationUnitError('Une unité ne peut pas être son propre parent.', 'UNIT_SELF_PARENT', 409);
  }
  let cursor = parent;
  const visited = new Set();
  while (cursor?.parent_id) {
    if (visited.has(Number(cursor.id))) {
      throw new OrganizationUnitError('Boucle existante dans les unités.', 'UNIT_EXISTING_CYCLE', 409);
    }
    visited.add(Number(cursor.id));
    if (selfId && Number(cursor.parent_id) === Number(selfId)) {
      throw new OrganizationUnitError('Cette modification créerait une boucle d’unités.', 'UNIT_CYCLE_FORBIDDEN', 409);
    }
    cursor = await getUnit(cursor.parent_id, tx, true);
  }
  return parent;
}

async function audit(tx, unitId, action, details, actorUserId) {
  await tx.execute(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id, created_at)
    VALUES ('org_unites',?,?,?,?,NOW())
  `, [Number(unitId), action, JSON.stringify(details || {}), actorUserId || null]);
}

async function create(departmentId, input, actorUserId) {
  const type = clean(input?.type_unite);
  const libelle = clean(input?.libelle);
  const code = clean(input?.code) || null;
  const parentId = input?.parent_id ? Number(input.parent_id) : null;
  if (!UNIT_TYPES[type]) throw new OrganizationUnitError('Type d’unité invalide.', 'INVALID_UNIT_TYPE');
  if (!libelle) throw new OrganizationUnitError('Le libellé de l’unité est obligatoire.', 'UNIT_LABEL_REQUIRED');

  return db.transaction(async tx => {
    const dept = await tx.queryOne('SELECT id, actif FROM org_departements WHERE id=? FOR UPDATE', [Number(departmentId)]);
    if (!dept || !dept.actif) throw new OrganizationUnitError('Département introuvable ou inactif.', 'DEPARTMENT_NOT_ACTIVE', 404);
    await validateParent(tx, departmentId, parentId);
    const enterprise = await tx.queryOne('SELECT id FROM entreprise WHERE actif=1 ORDER BY id LIMIT 1');
    const inserted = await tx.execute(`
      INSERT INTO org_unites
        (entreprise_id, departement_id, parent_id, type_unite, code, libelle,
         description, version, actif, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,1,1,?,NOW(),NOW())
    `, [enterprise?.id || null, Number(departmentId), parentId, type, code, libelle, clean(input?.description) || null, actorUserId || null]);
    const row = await getUnit(inserted.insertId, tx);
    await audit(tx, row.id, 'organization_unit_created', { type_unite: type, parent_id: parentId }, actorUserId);
    return row;
  });
}

async function update(id, input, actorUserId) {
  const expectedVersion = versionOf(input?.version);
  return db.transaction(async tx => {
    const current = await getUnit(id, tx, true);
    if (!current) throw new OrganizationUnitError('Unité introuvable.', 'UNIT_NOT_FOUND', 404);
    if (Number(current.version) !== expectedVersion) {
      throw new OrganizationUnitError('L’unité a été modifiée par un autre utilisateur.', 'UNIT_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    }
    const type = clean(input?.type_unite, current.type_unite);
    const libelle = clean(input?.libelle, current.libelle);
    const parentId = input?.parent_id === undefined ? current.parent_id : (input.parent_id ? Number(input.parent_id) : null);
    if (!UNIT_TYPES[type]) throw new OrganizationUnitError('Type d’unité invalide.', 'INVALID_UNIT_TYPE');
    if (!libelle) throw new OrganizationUnitError('Le libellé est obligatoire.', 'UNIT_LABEL_REQUIRED');
    await validateParent(tx, current.departement_id, parentId, current.id);
    const nextVersion = expectedVersion + 1;
    const result = await tx.execute(`
      UPDATE org_unites
      SET parent_id=?, type_unite=?, code=?, libelle=?, description=?, version=?, updated_at=NOW()
      WHERE id=? AND version=?
    `, [parentId, type, clean(input?.code, current.code) || null, libelle, clean(input?.description, current.description) || null, nextVersion, current.id, expectedVersion]);
    if (result.affectedRows !== 1) throw new OrganizationUnitError('Conflit de modification.', 'UNIT_VERSION_CONFLICT', 409);
    const row = await getUnit(current.id, tx);
    await audit(tx, row.id, 'organization_unit_updated', { version_avant: expectedVersion, version_apres: nextVersion }, actorUserId);
    return row;
  });
}

async function deactivate(id, version, actorUserId) {
  const expectedVersion = versionOf(version);
  return db.transaction(async tx => {
    const current = await getUnit(id, tx, true);
    if (!current) throw new OrganizationUnitError('Unité introuvable.', 'UNIT_NOT_FOUND', 404);
    if (Number(current.version) !== expectedVersion) throw new OrganizationUnitError('Version obsolète.', 'UNIT_VERSION_CONFLICT', 409, { current_version: Number(current.version) });
    const child = await tx.queryOne('SELECT id FROM org_unites WHERE parent_id=? AND actif=1 LIMIT 1 FOR UPDATE', [current.id]);
    if (child) throw new OrganizationUnitError('Désactivez d’abord les unités enfants.', 'ACTIVE_CHILD_UNIT_EXISTS', 409, { child_id: child.id });
    const linked = await tx.queryOne(`
      SELECT id FROM org_departement_fonctions
      WHERE unite_id=? AND statut NOT IN ('annule','cloture') LIMIT 1 FOR UPDATE
    `, [current.id]);
    if (linked) throw new OrganizationUnitError('Une fonction active ou en workflow utilise cette unité.', 'UNIT_FUNCTION_EXISTS', 409, { function_id: linked.id });
    await tx.execute('UPDATE org_unites SET actif=0, version=version+1, updated_at=NOW() WHERE id=? AND version=?', [current.id, expectedVersion]);
    const row = await getUnit(current.id, tx);
    await audit(tx, row.id, 'organization_unit_deactivated', {}, actorUserId);
    return row;
  });
}

module.exports = { UNIT_TYPES, OrganizationUnitError, list, create, update, deactivate, getUnit };

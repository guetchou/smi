'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/db');

const modelPath = path.join(__dirname, '..', 'backend', 'templates', 'employment-contract-national.json');

async function main() {
  if (process.env.DB_DRIVER !== 'mysql') throw new Error('Import autorise uniquement avec DB_DRIVER=mysql');
  if (process.env.SMI_DB_WRITE_CONFIRMED !== '1') throw new Error('Definir SMI_DB_WRITE_CONFIRMED=1 apres sauvegarde MySQL verifiee');
  const actorUserId = Number(process.env.SMI_ACTOR_USER_ID);
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) throw new Error('SMI_ACTOR_USER_ID valide requis');
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

  const result = await db.transaction(async tx => {
    let template = await tx.queryOne('SELECT * FROM employment_contract_templates WHERE code=?', [model.code]);
    if (!template) {
      const inserted = await tx.execute('INSERT INTO employment_contract_templates (code,nom,type_contrat,created_by) VALUES (?,?,?,?)', [model.code, model.name, model.contractType, actorUserId]);
      template = { id: inserted.insertId };
    }
    const existing = await tx.queryOne('SELECT id,version,statut FROM employment_contract_template_versions WHERE template_id=? AND source_docx_sha256=?', [template.id, model.sourceDocxSha256]);
    if (existing) return { changed: false, templateId: template.id, versionId: existing.id, version: existing.version, status: existing.statut };
    const latest = await tx.queryOne('SELECT COALESCE(MAX(version),0) AS version FROM employment_contract_template_versions WHERE template_id=?', [template.id]);
    const version = Number(latest?.version || 0) + 1;
    const inserted = await tx.execute(`
      INSERT INTO employment_contract_template_versions
        (template_id,version,statut,titre,content_json,header_json,footer_json,variable_catalog_json,
         source_docx_name,source_docx_sha256,change_note,created_by)
      VALUES (?,?,'brouillon',?,?,?,?,?,?,?,'Import du document source; validation juridique obligatoire',?)
    `, [template.id, version, model.title, JSON.stringify(model.content), JSON.stringify(model.header), JSON.stringify(model.footer), JSON.stringify(model.variableCatalog), model.sourceDocxName, model.sourceDocxSha256, actorUserId]);
    return { changed: true, templateId: template.id, versionId: inserted.insertId, version, status: 'brouillon' };
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (db._pool) await db._pool.end();
}

main().catch(async error => {
  console.error(`[employment-contract-model] ${error.message}`);
  if (db._pool) await db._pool.end().catch(() => {});
  process.exitCode = 1;
});

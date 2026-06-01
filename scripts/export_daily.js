#!/usr/bin/env node
// =============================================================================
// export_daily.js — Export quotidien des données métier (≠ backup)
//
// Usage  : node export_daily.js [YYYY-MM-DD]
// Cron   : 30 1 * * * cd /opt/projet-smi && node scripts/export_daily.js
//
// Production : lit MySQL via backend/db.js. SQLite reste supporté seulement par
// la couche DB legacy si DB_DRIVER=sqlite est explicitement défini.
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();
process.env.DB_DRIVER = process.env.DB_DRIVER || 'mysql';

const db = require(path.join(PROJECT_DIR, 'backend', 'db'));

const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const YEAR = parseInt(TARGET_DATE.slice(0, 4), 10);
const EXPORT_BASE = '/opt/exports';
const EXPORT_DIR = path.join(EXPORT_BASE, TARGET_DATE);
const LOG_FILE = '/var/log/caisse-backup.log';

function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [EXPORT] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function writeJson(filename, data) {
  const filepath = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  const size = fs.statSync(filepath).size;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  log(`  ${filename} — ${count} entrée(s), ${(size / 1024).toFixed(1)} KB`);
  return count;
}

async function main() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stats = {};
  const startTime = Date.now();
  log(`DB driver : ${process.env.DB_DRIVER}`);
  log(`Export dir: ${EXPORT_DIR}`);

  const yearParam = String(YEAR);

  const agents = await db.query(`
    SELECT id, matricule, nom, prenom, poste, type, statut_dossier,
           salaire_base, mode_paiement, cnss, camu, email, telephone,
           date_embauche, type_contrat, departement, site,
           created_at, updated_at
    FROM employes
    ORDER BY nom, prenom
  `);
  stats.agents = writeJson('agents.json', agents);

  const bulletins = await db.query(`
    SELECT b.id, b.mois, b.annee, b.statut,
           e.matricule, e.nom, e.prenom, e.poste, e.type as type_employe,
           b.salaire_base, b.prime_transport, b.prime_logement, b.autres_primes,
           b.brut, b.cnss_employe, b.camu_employe, b.irpp,
           b.total_retenues, b.net_imposable, b.net_a_payer,
           b.retenue_avance, b.net_a_verser,
           b.cnss_patronal, b.camu_patronal, b.cout_total_employeur,
           b.created_at, b.updated_at
    FROM bulletins_salaire b
    JOIN employes e ON b.employe_id = e.id
    WHERE b.annee = ?
    ORDER BY b.annee, b.mois, e.nom
  `, [YEAR]);
  stats.bulletins = writeJson('bulletins.json', bulletins);

  const decaissements = await db.query(`
    SELECT o.id, o.date, o.num_piece, o.libelle, o.tiers, o.montant,
           o.mode_reglement, o.ref_externe, o.statut,
           o.dec_statut, o.decharge_signee,
           p.code as position_code, p.libelle as position_libelle,
           c.nom as categorie,
           e.nom as employe_nom, e.prenom as employe_prenom, e.matricule,
           u.nom as cree_par,
           o.created_at
    FROM operations o
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN employes e   ON o.employe_id = e.id
    LEFT JOIN users u      ON o.created_by = u.id
    WHERE o.type_op = 'decaissement'
      AND LEFT(o.date, 4) = ?
      AND o.statut != 'annule'
    ORDER BY o.date, o.id
  `, [yearParam]);
  stats.decaissements = writeJson('decaissements.json', decaissements);

  const encaissements = await db.query(`
    SELECT o.id, o.date, o.num_piece, o.libelle, o.tiers, o.montant,
           o.mode_reglement, o.ref_externe, o.statut,
           p.code as position_code, p.libelle as position_libelle,
           c.nom as categorie,
           u.nom as cree_par,
           o.created_at
    FROM operations o
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    LEFT JOIN users u      ON o.created_by = u.id
    WHERE o.type_op = 'encaissement'
      AND LEFT(o.date, 4) = ?
      AND o.statut != 'annule'
    ORDER BY o.date, o.id
  `, [yearParam]);
  stats.encaissements = writeJson('encaissements.json', encaissements);

  const journal = await db.query(`
    SELECT o.id, o.date, o.num_piece, o.libelle, o.tiers, o.montant,
           o.type_op, o.statut, o.mode_reglement,
           o.solde_position,
           p.code as position_code,
           c.nom as categorie,
           o.created_at
    FROM operations o
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE LEFT(o.date, 4) = ?
    ORDER BY o.date, o.id
  `, [yearParam]);
  stats.journal = writeJson('journal.json', journal);

  const auditLogs = await db.query(`
    SELECT a.id, a.table_name, a.record_id, a.action, a.details,
           u.nom as user_nom, u.email as user_email, u.role as user_role,
           a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
    ORDER BY a.created_at DESC
  `);
  stats.audit_logs = writeJson('audit_logs.json', auditLogs);

  const parametresRaw = await db.query('SELECT cle, valeur FROM parametres');
  const excludeKeys = ['smtp_password', 'secret', 'jwt', 'password'];
  const parametres = {};
  parametresRaw.forEach(p => {
    if (!excludeKeys.some(k => String(p.cle).toLowerCase().includes(k))) {
      parametres[p.cle] = p.valeur;
    }
  });
  stats.parametres_keys = writeJson('parametres.json', parametres);

  const summary = {
    date_export: TARGET_DATE,
    generated_at: new Date().toISOString(),
    annee_fiscale: YEAR,
    db_driver: process.env.DB_DRIVER,
    duration_ms: Date.now() - startTime,
    fichiers: Object.keys(stats).map(k => ({ nom: k, entrees: stats[k] })),
    total_entrees: Object.values(stats).reduce((a, b) => a + b, 0),
    note: 'Export métier — pas un backup. Pour restauration technique : utiliser les dumps MySQL.'
  };
  writeJson('summary.json', summary);

  log(`Export terminé en ${Date.now() - startTime}ms — ${summary.total_entrees} entrées totales`);

  const exportDirs = fs.readdirSync(EXPORT_BASE)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let deleted = 0;
  exportDirs.forEach(d => {
    if (d < cutoff) {
      fs.rmSync(path.join(EXPORT_BASE, d), { recursive: true, force: true });
      deleted++;
    }
  });
  if (deleted > 0) log(`Anciens exports supprimés (>90j) : ${deleted}`);
}

main()
  .catch(err => {
    log(`ERREUR export : ${err.message}`);
    process.exit(1);
  })
  .finally(async () => {
    if (db._pool) await db._pool.end().catch(() => {});
  });

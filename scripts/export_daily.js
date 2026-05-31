#!/usr/bin/env node
// =============================================================================
// export_daily.js — Export quotidien des données métier (≠ backup)
//
// Usage  : node export_daily.js [YYYY-MM-DD]
// Cron   : 30 1 * * * node /opt/projet-smi/scripts/export_daily.js
//
// Exporte vers /opt/exports/YYYY-MM-DD/ :
//   agents.json           — tous les agents (actifs et sortis)
//   bulletins.json        — bulletins de salaire de l'année en cours
//   decaissements.json    — opérations de type decaissement (année en cours)
//   encaissements.json    — opérations de type encaissement (année en cours)
//   journal.json          — toutes opérations de l'année en cours
//   audit_logs.json       — journal d'audit des 90 derniers jours
//   parametres.json       — configuration (sans hash ni secret)
//   summary.json          — méta-données de l'export
//
// IMPORTANT : export ≠ backup.
//   Le backup DB (caisse.db) permet la restauration technique.
//   L'export permet la reconstruction / vérification métier.
// =============================================================================
'use strict';

const path      = require('path');
const fs        = require('fs');
const SCRIPT_DIR = __dirname;
const BACKEND_DIR = path.join(SCRIPT_DIR, '..', 'backend');

// Résolution DB (même logique que backup_db.sh)
const DB_CANDIDATES = [
  '/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db',
  path.join(BACKEND_DIR, 'data', 'caisse.db'),
];

function findDb() {
  for (const p of DB_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { execSync } = require('child_process');
    const found = execSync('find /opt -name "caisse.db" -type f 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) {}
  return null;
}

// Chargement better-sqlite3 depuis le backend
let Database;
try {
  Database = require(path.join(BACKEND_DIR, 'node_modules', 'better-sqlite3'));
} catch (err) {
  console.error('ERREUR : impossible de charger better-sqlite3 depuis', BACKEND_DIR);
  process.exit(1);
}

// ── Date cible ────────────────────────────────────────────────────────────────
const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
const YEAR = parseInt(TARGET_DATE.slice(0, 4));

const EXPORT_BASE = '/opt/exports';
const EXPORT_DIR  = path.join(EXPORT_BASE, TARGET_DATE);

const LOG_FILE = '/var/log/caisse-backup.log';
function log(msg) {
  const line = `[${new Date().toISOString().replace('T',' ').slice(0,19)}] [EXPORT] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── Main ───────────────────────────────────────────────────────────────────────
const dbPath = findDb();
if (!dbPath) { log('ERREUR : caisse.db introuvable'); process.exit(1); }

log(`DB source : ${dbPath}`);
log(`Export dir: ${EXPORT_DIR}`);

fs.mkdirSync(EXPORT_DIR, { recursive: true });

const db = new Database(dbPath, { readonly: true });

function writeJson(filename, data) {
  const filepath = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
  const size = fs.statSync(filepath).size;
  const count = Array.isArray(data) ? data.length : Object.keys(data).length;
  log(`  ${filename} — ${count} entrée(s), ${(size/1024).toFixed(1)} KB`);
  return count;
}

const stats = {};
const startTime = Date.now();

try {

  // ── Agents ───────────────────────────────────────────────────────────────────
  const agents = db.prepare(`
    SELECT id, matricule, nom, prenom, poste, type, statut_dossier,
           salaire_base, mode_paiement, cnss, camu, email, telephone,
           date_embauche, type_contrat, departement, site,
           created_at, updated_at
    FROM employes
    ORDER BY nom, prenom
  `).all();
  stats.agents = writeJson('agents.json', agents);

  // ── Bulletins de salaire (année en cours) ─────────────────────────────────
  const bulletins = db.prepare(`
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
  `).all(YEAR);
  stats.bulletins = writeJson('bulletins.json', bulletins);

  // ── Décaissements (année en cours) ────────────────────────────────────────
  const decaissements = db.prepare(`
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
      AND substr(o.date, 1, 4) = ?
      AND o.statut != 'annule'
    ORDER BY o.date, o.id
  `).all(String(YEAR));
  stats.decaissements = writeJson('decaissements.json', decaissements);

  // ── Encaissements (année en cours) ────────────────────────────────────────
  const encaissements = db.prepare(`
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
      AND substr(o.date, 1, 4) = ?
      AND o.statut != 'annule'
    ORDER BY o.date, o.id
  `).all(String(YEAR));
  stats.encaissements = writeJson('encaissements.json', encaissements);

  // ── Journal complet (année en cours) ──────────────────────────────────────
  const journal = db.prepare(`
    SELECT o.id, o.date, o.num_piece, o.libelle, o.tiers, o.montant,
           o.type_op, o.statut, o.mode_reglement,
           o.solde_position,
           p.code as position_code,
           c.nom as categorie,
           o.created_at
    FROM operations o
    LEFT JOIN positions p  ON o.position_id = p.id
    LEFT JOIN categories c ON o.categorie_id = c.id
    WHERE substr(o.date, 1, 4) = ?
    ORDER BY o.date, o.id
  `).all(String(YEAR));
  stats.journal = writeJson('journal.json', journal);

  // ── Audit logs (90 derniers jours) ────────────────────────────────────────
  const auditLogs = db.prepare(`
    SELECT a.id, a.table_name, a.record_id, a.action, a.details,
           u.nom as user_nom, u.email as user_email, u.role as user_role,
           a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.created_at >= datetime('now', '-90 days')
    ORDER BY a.created_at DESC
  `).all();
  stats.audit_logs = writeJson('audit_logs.json', auditLogs);

  // ── Paramètres (sans secrets) ─────────────────────────────────────────────
  const parametresRaw = db.prepare('SELECT cle, valeur FROM parametres').all();
  // Exclure les clés potentiellement sensibles
  const EXCLUDE_KEYS = ['smtp_password', 'secret', 'jwt'];
  const parametres = {};
  parametresRaw.forEach(p => {
    if (!EXCLUDE_KEYS.some(k => p.cle.toLowerCase().includes(k))) {
      parametres[p.cle] = p.valeur;
    }
  });
  stats.parametres_keys = writeJson('parametres.json', parametres);

  // ── Résumé de l'export ────────────────────────────────────────────────────
  const summary = {
    date_export:    TARGET_DATE,
    generated_at:   new Date().toISOString(),
    annee_fiscale:  YEAR,
    db_source:      dbPath,
    duration_ms:    Date.now() - startTime,
    fichiers:       Object.keys(stats).map(k => ({ nom: k, entrees: stats[k] })),
    total_entrees:  Object.values(stats).reduce((a, b) => a + b, 0),
    note: "Export métier — pas un backup. Pour restauration : utiliser caisse.db"
  };
  writeJson('summary.json', summary);

  db.close();

  log(`Export terminé en ${Date.now() - startTime}ms — ${summary.total_entrees} entrées totales`);
  log(`Répertoire : ${EXPORT_DIR}`);

  // ── Nettoyage : conserver 90 jours d'exports ───────────────────────────────
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

} catch (err) {
  db.close();
  log(`ERREUR export : ${err.message}`);
  process.exit(1);
}

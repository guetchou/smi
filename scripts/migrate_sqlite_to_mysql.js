'use strict';

/**
 * Phase 4 — Migration données SQLite → MySQL
 *
 * Usage :
 *   node scripts/migrate_sqlite_to_mysql.js [--dry-run] [--tables=users,employes,...]
 *
 * Prérequis :
 *   - DB_DRIVER=mysql dans .env (ou variables MYSQL_* exportées)
 *   - Les migrations Phase 3 ont déjà été appliquées (schema_migrations complet)
 *   - La DB SQLite est accessible via DB_PATH (défaut : backend/data/caisse.db)
 *
 * Stratégie :
 *   - Ordre respectant les FK : tables parents avant tables enfants
 *   - TRUNCATE + INSERT (pas d'UPSERT) — script idempotent via --truncate
 *   - Les colonnes absentes de SQLite sont ignorées (elles ont des DEFAULT)
 *   - Colonnes renommées : periodes_clôturees → periodes_cloturees
 */

const path         = require('path');

function requireBackend(moduleName) {
  try {
    return require(moduleName);
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    return require(path.join(__dirname, '..', 'backend', 'node_modules', moduleName));
  }
}

const BetterSqlite = requireBackend('better-sqlite3');
const mysql        = requireBackend('mysql2/promise');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  // En production Docker, les variables sont injectées par docker compose.
}

const DRY_RUN    = process.argv.includes('--dry-run');
const ONLY_TABLES = process.argv.find(a => a.startsWith('--tables='))
  ?.replace('--tables=', '').split(',').filter(Boolean) ?? null;

const SQLITE_PATH = process.env.DB_PATH
  || path.join(__dirname, '..', 'backend', 'data', 'caisse.db');

// ── Ordre de migration (respecte les FK) ─────────────────────────────────────
const TABLE_ORDER = [
  // Core
  'users',
  'positions',
  'categories',
  'employes',
  'operations',
  'budgets',
  'parametres',
  // RH
  'fournisseurs',
  'employes_enfants',
  'employes_documents',
  'audit_logs',
  'employes_diplomes',
  'employes_experiences',
  'employes_avances',
  'employes_avances_remboursements',
  'employes_conges',
  // Bulletins (après employes_avances pour la FK avance_id)
  'bulletins_salaire',
  // Org
  'org_postes',
  'org_departements',
  'org_sites',
  'employes_mutations',
  'employes_sortie',
  'employes_sanctions',
  'employes_heures_sup',
  // Accès ERP
  'profiles',
  'permissions',
  'profile_permissions',
  'user_profiles',
  'user_permissions',
  'delegations',
  'delegations_approbation',
  'permission_audit_logs',
  'departments',
  'organization_units',
  'employee_assignments',
  // Notifications
  'notif_regles',
  'notif_messages',
  'notif_rappels',
  'alertes_actives',
  'notif_canaux',
  'notif_envois',
  'user_preferences',
  'push_souscriptions',
  // Commercial
  'clients',
  'devis',
  'devis_lignes',
  'factures_clients',
  'factures_clients_lignes',
  'factures_clients_paiements',
  'relances',
  // Stock
  'categories_produits',
  'produits',
  'stock_mouvements',
  // Achats
  'demandes_achat',
  'demandes_achat_lignes',
  'bons_commandes_fournisseurs',
  'bons_commandes_lignes',
  'receptions',
  'receptions_lignes',
  'factures_fournisseurs',
  // Paie avancée
  'periodes_paie',
  'rectifications_bulletins',
  'bulletin_envois',
  // Fiscal / contrats
  'cnss_declarations',
  'cnss_paiements',
  'dgi_declarations',
  'dgi_paiements',
  'contrats',
  'contrats_echeances',
  'rapprochements_bancaires',
  'rapprochements_lignes',
  'caisses_clotures',
  'calendrier_fiscal',
  // Table renommée (accent supprimé)
  'periodes_cloturees',
  // Grilles
  'grilles_salariales',
  'grille_categories',
  'grille_echelons',
  'demandes_revision_salaire',
  'historique_salaires',
  // Workflow
  'parapheur',
  'parapheur_actions',
  'parapheur_interim',
  'user_cashboxes',
  'operation_attachments',
  'cash_ledger',
  'cashbox_balances',
  'cashbox_closures',
  // Entreprise
  'entreprise',
  'entreprise_historique',
];

// Tables SQLite avec nom différent du nom MySQL cible
const TABLE_ALIASES = {
  'periodes_cloturees': 'periodes_clôturees',  // SQLite utilise l'accent
};

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Migration données SQLite → MySQL');
  console.log(DRY_RUN ? ' MODE : DRY-RUN (aucune écriture)' : ' MODE : RÉEL');
  console.log('═══════════════════════════════════════════════════════\n');

  // Ouvrir SQLite
  let sqlite;
  try {
    sqlite = new BetterSqlite(SQLITE_PATH, { readonly: true });
    console.log(`SQLite : ${SQLITE_PATH}`);
  } catch (e) {
    console.error('Impossible d\'ouvrir SQLite :', e.message);
    process.exit(1);
  }

  // Lister les tables SQLite disponibles
  const sqliteTables = new Set(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );

  // Connexion MySQL
  const pool = mysql.createPool({
    host:               process.env.MYSQL_HOST     || 'mysql',
    port:               parseInt(process.env.MYSQL_PORT, 10) || 3306,
    user:               process.env.MYSQL_USER     || 'caisse_user',
    password:           process.env.MYSQL_PASSWORD || '',
    database:           process.env.MYSQL_DATABASE || 'caisse_topcenter',
    charset:            'utf8mb4',
    timezone:           '+01:00',
    waitForConnections: true,
    connectionLimit:    5,
    multipleStatements: false,
    supportBigNumbers:  true,
    bigNumberStrings:   false,
  });

  try {
    const [ping] = await pool.execute('SELECT 1');
    console.log('MySQL : connecté ✓\n');
  } catch (e) {
    console.error('Impossible de se connecter à MySQL :', e.message);
    process.exit(1);
  }

  const tables = ONLY_TABLES ?? TABLE_ORDER;
  let totalInserted = 0;
  let totalSkipped  = 0;
  const errors = [];

  for (const mysqlTable of tables) {
    const sqliteTable = TABLE_ALIASES[mysqlTable] ?? mysqlTable;

    if (!sqliteTables.has(sqliteTable)) {
      console.log(`  ⏭  ${mysqlTable} — absente de SQLite, ignorée`);
      totalSkipped++;
      continue;
    }

    // Lire les colonnes MySQL réelles
    let mysqlCols;
    try {
      const [colRows] = await pool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [mysqlTable]
      );
      mysqlCols = colRows.map(r => r.COLUMN_NAME);
    } catch (e) {
      console.error(`  ✗ ${mysqlTable} — impossible de lire les colonnes MySQL: ${e.message}`);
      errors.push({ table: mysqlTable, error: e.message });
      continue;
    }

    if (!mysqlCols.length) {
      console.log(`  ⚠  ${mysqlTable} — table MySQL absente (migrations pas appliquées ?)`);
      errors.push({ table: mysqlTable, error: 'table MySQL absente' });
      continue;
    }

    // Lire les colonnes SQLite disponibles
    const sqliteCols = new Set(
      sqlite.prepare(`PRAGMA table_info(${sqliteTable})`).all().map(c => c.name)
    );

    // Colonnes communes (présentes dans les deux)
    const cols = mysqlCols.filter(c => sqliteCols.has(c));

    if (!cols.length) {
      console.log(`  ⚠  ${mysqlTable} — aucune colonne en commun`);
      continue;
    }

    // Lire les données SQLite
    let rows;
    try {
      rows = sqlite.prepare(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${sqliteTable}"`).all();
    } catch (e) {
      console.error(`  ✗ ${mysqlTable} — erreur lecture SQLite: ${e.message}`);
      errors.push({ table: mysqlTable, error: e.message });
      continue;
    }

    if (!rows.length) {
      console.log(`  ○  ${mysqlTable} — vide dans SQLite`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ✓  ${mysqlTable} — ${rows.length} lignes (dry-run, non écrites)`);
      totalInserted += rows.length;
      continue;
    }

    // Désactiver FK, TRUNCATE, réactiver FK
    const conn = await pool.getConnection();
    try {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
      await conn.execute(`TRUNCATE TABLE \`${mysqlTable}\``);

      const placeholders = `(${cols.map(() => '?').join(', ')})`;
      const insertSql = `INSERT INTO \`${mysqlTable}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES ${placeholders}`;

      // Insertion par lots de 500
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        for (const row of batch) {
          const vals = cols.map(c => {
            let v = row[c];
            // Convertir booléens SQLite (0/1) — déjà compatibles MySQL TINYINT(1)
            // Convertir undefined → null
            return v === undefined ? null : v;
          });
          await conn.execute(insertSql, vals);
        }
      }

      await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
      console.log(`  ✓  ${mysqlTable} — ${rows.length} ligne(s) insérée(s)`);
      totalInserted += rows.length;
    } catch (e) {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
      console.error(`  ✗ ${mysqlTable} — erreur insertion: ${e.message}`);
      errors.push({ table: mysqlTable, error: e.message });
    } finally {
      conn.release();
    }
  }

  // Réinitialiser les AUTO_INCREMENT après insertion avec IDs explicites
  if (!DRY_RUN && !errors.length) {
    console.log('\nRéinitialisation AUTO_INCREMENT...');
    for (const mysqlTable of tables) {
      try {
        const [r] = await pool.execute(`SELECT MAX(id) as max_id FROM \`${mysqlTable}\``);
        const maxId = r[0]?.max_id;
        if (maxId) {
          await pool.execute(`ALTER TABLE \`${mysqlTable}\` AUTO_INCREMENT = ?`, [maxId + 1]);
        }
      } catch (_) { /* table sans colonne id — ignoré */ }
    }
    console.log('AUTO_INCREMENT mis à jour ✓');
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(` Résultat : ${totalInserted} lignes migrées, ${totalSkipped} tables ignorées`);
  if (errors.length) {
    console.log(` ERREURS (${errors.length}) :`);
    errors.forEach(e => console.log(`   ✗ ${e.table}: ${e.error}`));
    process.exit(1);
  } else {
    console.log(' Migration terminée avec succès ✓');
  }
  console.log('═══════════════════════════════════════════════════════');

  await pool.end();
  sqlite.close();
}

main().catch(err => {
  console.error('Erreur fatale:', err.message);
  process.exit(1);
});

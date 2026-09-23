'use strict';
/*
 * Pont de socle : un banc isolé sur une vraie base MySQL.
 *
 * La production est MySQL. Les bancs isolés tournaient en SQLite sur un schéma
 * reconstruit à la main dans backend/database.js, miroir des migrations tenu à
 * jour par quelqu'un qui y pense. Le 23/09/2026 ce miroir s'était arrêté à la
 * migration 036 : hasCanonicalLedger() levait « no such column: leg_code » et
 * tout le chemin d'annulation d'une opération était inatteignable par les bancs
 * — que la CI exécute pourtant. Un vert qui n'atteint pas un chemin ne dit rien
 * de ce chemin.
 *
 * Ce pont sépare les deux choses que le socle SQLite mélangeait :
 *
 *   — le SCHÉMA vient des migrations MySQL, c'est-à-dire de la même source que
 *     la production. Plus de miroir à tenir, donc plus de dérive possible ;
 *   — les DONNÉES de semis viennent du socle SQLite, parce qu'elles n'existent
 *     nulle part ailleurs : après runMigrations sur une base neuve, « users »
 *     est vide, « admin@topcenter.cg » est absent, « profiles » et
 *     « profile_permissions » sont vides. Mesuré, pas supposé.
 *
 * La copie se fait sur l'intersection des colonnes, et elle COMPTE ce qu'elle
 * fait. Une copie qui échouerait en silence rendrait le banc vert sur une base
 * à moitié semée — exactement le genre de vert qu'on cherche à supprimer.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const racine = path.resolve(__dirname, '..', '..');
const mysql = require(path.join(racine, 'backend', 'node_modules', 'mysql2', 'promise'));
const Database = require(path.join(racine, 'backend', 'node_modules', 'better-sqlite3'));

/* Un banc ne doit jamais pouvoir écrire dans la base de production. Le serveur
   MySQL du VPS porte les deux ; seul le nom les distingue. */
const NOM_JETABLE = /_banc(_|$)/;
const INTERDITES = new Set(['caisse_topcenter', 'caisse_topcenter_staging']);

function verifierNomJetable(base) {
  if (INTERDITES.has(base) || !NOM_JETABLE.test(base)) {
    throw new Error(
      `Base « ${base} » refusée : un banc n'écrit que dans une base jetable, `
      + 'dont le nom porte « _banc ». C\'est le seul garde-fou entre un banc et la production.',
    );
  }
}

function connexionAdmin({ host, port, user, password }) {
  return mysql.createConnection({ host, port, user, password, multipleStatements: true });
}

/* Le socle SQLite est construit dans un processus séparé : backend/database.js
   choisit son moteur au moment du require, et le processus courant doit rester
   sur MySQL. */
function construireSocleSqlite(dossier) {
  const chemin = path.join(dossier, 'socle.db');
  execFileSync(
    process.execPath,
    ['-e', 'require("./backend/database");'],
    {
      cwd: racine,
      env: { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: chemin },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  if (!fs.existsSync(chemin)) throw new Error('Le socle SQLite n\'a pas été construit');
  return chemin;
}

const ERREURS_ATTENDUES = new Set(['ER_DUP_ENTRY', 'ER_DUP_KEY']);

/* Copie les lignes d'une table, sur l'intersection des colonnes. Renvoie le
   détail : ce qui est entré, ce qui existait déjà, ce qui a été refusé. */
async function copierTable(sqlite, conn, table, colonnesMySQL) {
  const colonnesSqlite = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  const communes = colonnesSqlite.filter(c => colonnesMySQL.has(c.toLowerCase()));
  if (!communes.length) return { table, lues: 0, ecrites: 0, doublons: 0, refusees: [] };

  const lignes = sqlite.prepare(`SELECT * FROM "${table}"`).all();
  if (!lignes.length) return { table, lues: 0, ecrites: 0, doublons: 0, refusees: [] };

  const liste = communes.map(c => `\`${c}\``).join(',');
  const trous = communes.map(() => '?').join(',');
  const sql = `INSERT INTO \`${table}\` (${liste}) VALUES (${trous})`;

  let ecrites = 0;
  let doublons = 0;
  const refusees = [];
  for (const ligne of lignes) {
    try {
      await conn.execute(sql, communes.map(c => (ligne[c] === undefined ? null : ligne[c])));
      ecrites += 1;
    } catch (e) {
      if (ERREURS_ATTENDUES.has(e.code)) doublons += 1;
      else if (refusees.length < 3) refusees.push(`${e.code}: ${e.message.slice(0, 110)}`);
      else refusees.push(null);
    }
  }
  return { table, lues: lignes.length, ecrites, doublons, refusees: refusees.filter(Boolean) };
}

/**
 * Crée une base MySQL jetable, y joue les migrations, y recopie le semis du
 * socle SQLite, et renvoie les variables d'environnement à passer au serveur.
 */
async function provisionner({ base, host, port, user, password, verbeux = true }) {
  verifierNomJetable(base);

  const admin = await connexionAdmin({ host, port, user, password });
  await admin.query(`DROP DATABASE IF EXISTS \`${base}\``);
  await admin.query(`CREATE DATABASE \`${base}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  const env = {
    DB_DRIVER: 'mysql',
    MYSQL_HOST: String(host),
    MYSQL_PORT: String(port),
    MYSQL_USER: user,
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: base,
  };
  Object.assign(process.env, env);

  const dbModule = require(path.join(racine, 'backend', 'db'));
  const { runMigrations } = require(path.join(racine, 'backend', 'migrations', 'runner'));
  await runMigrations(dbModule._pool);
  /* Le pool des migrations doit être refermé : laissé ouvert, il retient la
     boucle d evenements et le banc ne rend jamais la main — un succes qui
     finit en depassement de delai est le pire des diagnostics. */
  await dbModule._pool.end();
  if (verbeux) console.log(`[pont] schéma ${base} : migrations jouées`);

  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-socle-'));
  const cheminSqlite = construireSocleSqlite(dossier);
  const sqlite = new Database(cheminSqlite, { readonly: true });

  const conn = await mysql.createConnection({ host, port, user, password, database: base });
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  const [tablesMySQL] = await conn.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [base],
  );
  const connues = new Set(tablesMySQL.map(r => String(r.t).toLowerCase()));

  const tablesSqlite = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(r => r.name)
    .filter(t => connues.has(t.toLowerCase()) && t.toLowerCase() !== 'schema_migrations');

  let ecrites = 0;
  let doublons = 0;
  const problemes = [];
  for (const table of tablesSqlite) {
    const [cols] = await conn.query('SHOW COLUMNS FROM ??', [table]);
    const colonnesMySQL = new Set(cols.map(c => String(c.Field).toLowerCase()));
    const bilan = await copierTable(sqlite, conn, table, colonnesMySQL);
    ecrites += bilan.ecrites;
    doublons += bilan.doublons;
    if (bilan.refusees.length) problemes.push(`${table} → ${bilan.refusees[0]}`);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
  sqlite.close();
  fs.rmSync(dossier, { recursive: true, force: true });

  if (verbeux) {
    console.log(
      `[pont] semis : ${ecrites} ligne(s) copiées, ${doublons} déjà présente(s), `
      + `${tablesSqlite.length} table(s) parcourues`,
    );
    for (const p of problemes.slice(0, 5)) console.log(`[pont] refus : ${p}`);
  }

  return { env, problemes };
}

async function supprimer({ base, host, port, user, password }) {
  verifierNomJetable(base);
  const admin = await connexionAdmin({ host, port, user, password });
  await admin.query(`DROP DATABASE IF EXISTS \`${base}\``);
  await admin.end();
}

module.exports = { provisionner, supprimer, verifierNomJetable };

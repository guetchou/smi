#!/usr/bin/env node
// =============================================================================
// create_admin_secours.js — Crée ou réinitialise le compte admin de secours
//
// Usage : sudo node create_admin_secours.js [--force]
//
// - Génère un mot de passe fort aléatoire (ne jamais l'afficher dans les logs)
// - Hache avec bcryptjs (rounds=12)
// - Insère directement dans la DB SQLite
// - Écrit les credentials dans /root/.caisse_admin_secours (chmod 600)
//
// ⚠ Doit être exécuté en root (les credentials sont écrits dans /root/)
// =============================================================================
'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');

// ── Résolution des chemins ────────────────────────────────────────────────────
const SCRIPT_DIR  = __dirname;
const BACKEND_DIR = path.join(SCRIPT_DIR, '..', 'backend');

// Chemins possibles de la DB (même logique que backup_db.sh)
const DB_CANDIDATES = [
  '/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db',
  path.join(BACKEND_DIR, 'data', 'caisse.db'),
];

function findDb() {
  for (const p of DB_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  // Recherche générique de secours
  try {
    const { execSync } = require('child_process');
    const found = execSync('find /opt -name "caisse.db" -type f 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) {}
  return null;
}

// ── Chargement des dépendances ────────────────────────────────────────────────
let bcrypt, Database;
try {
  bcrypt   = require(path.join(BACKEND_DIR, 'node_modules', 'bcryptjs'));
  Database = require(path.join(BACKEND_DIR, 'node_modules', 'better-sqlite3'));
} catch (err) {
  console.error('ERREUR : impossible de charger bcryptjs ou better-sqlite3 depuis', BACKEND_DIR);
  console.error(err.message);
  process.exit(1);
}

// ── Génération du mot de passe fort ───────────────────────────────────────────
function generatePassword(length = 24) {
  // Caractères sans ambiguïté visuelle (pas de 0/O, 1/I/l)
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#%^&*';
  let pass = '';
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; i < bytes.length && pass.length < length; i++) {
    const idx = bytes[i] % chars.length;
    pass += chars[idx];
  }
  return pass;
}

// ── Logging (sans jamais écrire le mot de passe) ──────────────────────────────
const LOG_FILE = '/var/log/caisse-backup.log';
function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [ADMIN-SECOURS] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ── Main ───────────────────────────────────────────────────────────────────────
const FORCE = process.argv.includes('--force');
const ADMIN_EMAIL = 'admin.secours@caisse.local';
const CREDS_FILE  = '/root/.caisse_admin_secours';

const dbPath = findDb();
if (!dbPath) {
  log('ERREUR : base de données caisse.db introuvable');
  process.exit(1);
}
log(`DB : ${dbPath}`);

const db = new Database(dbPath);

// Vérifier si le compte existe déjà
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);

if (existing && !FORCE) {
  console.log(`\nLe compte ${ADMIN_EMAIL} existe déjà (id=${existing.id}).`);
  console.log('Utilisez --force pour réinitialiser son mot de passe.\n');
  process.exit(0);
}

// Générer et hasher le mot de passe (en mémoire, jamais loggué)
const password = generatePassword(24);
const hash     = bcrypt.hashSync(password, 12);

let action;
if (existing && FORCE) {
  db.prepare(`
    UPDATE users SET password_hash = ?, actif = 1, sous_role = 'secours'
    WHERE email = ?
  `).run(hash, ADMIN_EMAIL);
  action = 'Mot de passe réinitialisé';
} else {
  db.prepare(`
    INSERT INTO users (nom, email, password_hash, role, actif, sous_role)
    VALUES (?, ?, ?, 'admin', 1, 'secours')
  `).run('Admin Secours', ADMIN_EMAIL, hash);
  action = 'Compte créé';
}

db.close();

// Écrire les credentials dans un fichier root-only
const credsContent = [
  '# Compte admin de secours — Caisse TOP CENTER',
  `# Généré le : ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
  `# Action    : ${action}`,
  '#',
  '# ⚠ CHANGER CE MOT DE PASSE À LA PREMIÈRE CONNEXION',
  '# ⚠ Ce fichier contient des credentials sensibles — ne jamais committer',
  '#',
  `email:    ${ADMIN_EMAIL}`,
  `password: ${password}`,
  'role:     admin',
  '#',
  '# Connexion API :',
  '#   POST /api/auth/login',
  '#   {"email":"admin.secours@caisse.local","password":"<password ci-dessus>"}',
].join('\n') + '\n';

fs.writeFileSync(CREDS_FILE, credsContent, { mode: 0o600 });

// Effacer le mot de passe de la mémoire (best-effort en JS)
credsContent.replace(/./g, '0');

log(`${action} : ${ADMIN_EMAIL}`);
log(`Credentials écrits dans ${CREDS_FILE} (chmod 600, root uniquement)`);
log('Mot de passe NON affiché dans les logs.');

console.log('\n==============================================');
console.log(`  ${action}`);
console.log(`  Email       : ${ADMIN_EMAIL}`);
console.log(`  Credentials : ${CREDS_FILE}  (root only)`);
console.log('  ⚠  Changer le mot de passe à la 1re connexion');
console.log('==============================================\n');

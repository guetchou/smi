#!/usr/bin/env node
// =============================================================================
// create_admin_secours.js — Crée ou réinitialise le compte admin de secours
//
// Usage : sudo node scripts/create_admin_secours.js [--force]
//
// - Production : écrit dans MySQL via backend/db.js
// - Génère un mot de passe fort aléatoire (jamais dans les logs)
// - Écrit les credentials dans /root/.caisse_admin_secours (chmod 600)
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

const bcrypt = require(path.join(PROJECT_DIR, 'backend', 'node_modules', 'bcryptjs'));
const db = require(path.join(PROJECT_DIR, 'backend', 'db'));

function generatePassword(length = 24) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#%^&*';
  let pass = '';
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; i < bytes.length && pass.length < length; i++) pass += chars[bytes[i] % chars.length];
  return pass;
}

const LOG_FILE = '/var/log/caisse-backup.log';
function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [ADMIN-SECOURS] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

async function main() {
  const force = process.argv.includes('--force');
  const adminEmail = 'admin.secours@caisse.local';
  const credsFile = '/root/.caisse_admin_secours';

  const existing = await db.queryOne('SELECT id FROM users WHERE email = ?', [adminEmail]);
  if (existing && !force) {
    console.log(`\nLe compte ${adminEmail} existe déjà (id=${existing.id}).`);
    console.log('Utilisez --force pour réinitialiser son mot de passe.\n');
    return;
  }

  const password = generatePassword(24);
  const hash = bcrypt.hashSync(password, 12);
  let action;

  if (existing && force) {
    await db.execute(
      "UPDATE users SET password_hash = ?, actif = 1, sous_role = 'secours' WHERE email = ?",
      [hash, adminEmail]
    );
    action = 'Mot de passe réinitialisé';
  } else {
    await db.execute(
      "INSERT INTO users (nom, email, password_hash, role, actif, sous_role) VALUES (?, ?, ?, 'admin', 1, 'secours')",
      ['Admin Secours', adminEmail, hash]
    );
    action = 'Compte créé';
  }

  const credsContent = [
    '# Compte admin de secours — Tala SMI',
    `# Généré le : ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `# Action    : ${action}`,
    '#',
    '# CHANGER CE MOT DE PASSE A LA PREMIERE CONNEXION',
    '# Ce fichier contient des credentials sensibles — ne jamais committer',
    '#',
    `email:    ${adminEmail}`,
    `password: ${password}`,
    'role:     admin',
    '#',
    '# Connexion API : POST /api/auth/login',
  ].join('\n') + '\n';

  fs.writeFileSync(credsFile, credsContent, { mode: 0o600 });
  try { fs.chmodSync(credsFile, 0o600); } catch (_) {}
  log(`${action} : ${adminEmail} — credentials écrits dans ${credsFile}`);
}

main()
  .catch(err => {
    log(`ERREUR : ${err.message}`);
    process.exit(1);
  })
  .finally(async () => {
    if (db._pool) await db._pool.end().catch(() => {});
  });

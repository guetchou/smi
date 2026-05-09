const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'topcenter-caisse-secret-2025';

// ── Blacklist JWT (révocation tokens) ────────────────────────────────────────
// Map jti → expiresAt (ms). Purgée automatiquement à chaque vérification.
const _tokenBlacklist = new Map();

function blacklistToken(decoded) {
  if (!decoded?.jti || !decoded?.exp) return;
  _tokenBlacklist.set(decoded.jti, decoded.exp * 1000);
}

function isBlacklisted(decoded) {
  if (!decoded?.jti) return false;
  const exp = _tokenBlacklist.get(decoded.jti);
  if (exp === undefined) return false;
  if (Date.now() > exp) { _tokenBlacklist.delete(decoded.jti); return false; } // expiré naturellement
  return true;
}

// Purge automatique entrées expirées (toutes les 10 min)
setInterval(() => {
  const now = Date.now();
  _tokenBlacklist.forEach((exp, jti) => { if (now > exp) _tokenBlacklist.delete(jti); });
}, 10 * 60_000);

// ── CAPTCHA (math challenge in-memory) ───────────────────────────────────────
const captchaStore = new Map(); // id → { answer, expiresAt }

function generateCaptcha() {
  const ops = ['+', '-', '×'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a, b, answer;
  if (op === '+') { a = Math.floor(Math.random()*20)+1; b = Math.floor(Math.random()*20)+1; answer = a + b; }
  else if (op === '-') { a = Math.floor(Math.random()*20)+10; b = Math.floor(Math.random()*10)+1; answer = a - b; }
  else { a = Math.floor(Math.random()*9)+2; b = Math.floor(Math.random()*9)+2; answer = a * b; }
  const id = crypto.randomBytes(16).toString('hex');
  captchaStore.set(id, { answer, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min
  // Cleanup old entries
  if (captchaStore.size > 500) {
    const now = Date.now();
    captchaStore.forEach((v, k) => { if (v.expiresAt < now) captchaStore.delete(k); });
  }
  return { id, question: `${a} ${op} ${b} = ?` };
}

router.get('/captcha', (req, res) => {
  res.json(generateCaptcha());
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password, captchaId, captchaAnswer } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis' });

  // Vérifier captcha
  const cap = captchaStore.get(captchaId);
  if (!cap || cap.expiresAt < Date.now()) {
    if (captchaId) captchaStore.delete(captchaId);
    return res.status(400).json({ captchaExpired: true });
  }
  if (Number(captchaAnswer) !== cap.answer) {
    captchaStore.delete(captchaId); // invalide après échec
    return res.status(400).json({ error: 'Code de sécurité incorrect', captchaExpired: true });
  }
  captchaStore.delete(captchaId); // usage unique

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND actif = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiants incorrects' });

  // Lire les rôles multiples (colonne roles JSON) ou fallback sur role
  let roles;
  try { roles = user.roles ? JSON.parse(user.roles) : [user.role]; } catch { roles = [user.role]; }
  if (!roles.includes(user.role)) roles.unshift(user.role); // role principal toujours présent

  const jti   = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, roles, nom: user.nom, jti },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token, user: { id: user.id, nom: user.nom, email: user.email, role: user.role, roles } });
});

router.post('/logout', requireAuth, (req, res) => {
  blacklistToken(req.user); // invalide le token immédiatement
  res.json({ ok: true });
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
router.post('/change-password', requireAuth, (req, res) => {
  const { ancien, nouveau } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(ancien, user.password_hash))
    return res.status(400).json({ error: 'Ancien mot de passe incorrect' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(nouveau, 10), req.user.id);
  blacklistToken(req.user); // invalide le token courant → forcer reconnexion
  res.json({ ok: true });
});

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
const resetTokens = new Map(); // token → { userId, expiresAt }

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND actif = 1').get(email);
  // Toujours répondre OK (sécurité anti-enumeration)
  if (!user) return res.json({ ok: true });

  const token = crypto.randomBytes(32).toString('hex');
  resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 3600_000 });

  const baseUrl = process.env.APP_URL || 'https://talatala.topcenter.cg';
  const resetUrl = `${baseUrl}/index.html?reset=${token}`;

  try {
    const { sendPasswordReset } = require('../services/email');
    await sendPasswordReset(user.email, user.nom, resetUrl);
  } catch (e) {
    console.error('Email reset error:', e.message);
  }
  res.json({ ok: true });
});

router.post('/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Données manquantes' });
  const entry = resetTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    resetTokens.delete(token);
    return res.status(400).json({ error: 'Lien expiré ou invalide' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), entry.userId);
  resetTokens.delete(token);
  res.json({ ok: true });
});

// ── REQUIREAUTH ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  // Support SSE : EventSource ne peut pas envoyer de headers → token dans ?auth=
  const auth = req.headers.authorization || (req.query.auth ? `Bearer ${req.query.auth}` : null);
  if (!auth) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    if (isBlacklisted(decoded)) return res.status(401).json({ error: 'Session révoquée — reconnectez-vous' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// ── HASROLE : vérifie si l'utilisateur possède AU MOINS UN des rôles demandés ──
// Supporte les multi-rôles (req.user.roles = ["caissier","rh"])
// L'admin a toujours accès à tout.
function hasRole(user, ...roles) {
  if (!user) return false;
  if (user.role === 'admin') return true; // admin = super-user
  const userRoles = Array.isArray(user.roles) ? user.roles : [user.role];
  return roles.some(r => userRoles.includes(r));
}

// ── REQUIREROLE ───────────────────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!hasRole(req.user, ...roles)) {
      return res.status(403).json({ error: `Accès refusé — rôle requis : ${roles.join(' ou ')}` });
    }
    next();
  };
}

module.exports = { router, requireAuth, requireRole, hasRole, JWT_SECRET };

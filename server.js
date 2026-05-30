const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// ── Gmail REST API (pas de SMTP bloqué) ──────────────────────────────────────
async function getGmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID     || '',
      client_secret: process.env.GMAIL_CLIENT_SECRET || '',
      refresh_token: process.env.GMAIL_REFRESH_TOKEN || '',
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth2 token error: ${data.error_description || data.error}`);
  return data.access_token;
}

function buildRawEmail(from, to, subject, htmlBody) {
  const boundary = `boundary_${Date.now()}`;
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    htmlBody.replace(/<[^>]+>/g, ''),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:Arial,sans-serif;background:#0d0d1a;color:#c8c8e8;margin:0;padding:0}
      .container{max-width:520px;margin:40px auto;background:#12122a;border-radius:16px;border:1px solid rgba(167,139,250,0.12);padding:32px}
      .logo{font-size:1.5rem;font-weight:800;color:#a78bfa;margin-bottom:24px}
      .amount{font-size:2rem;font-weight:800;color:#a78bfa;text-align:center;margin:20px 0;padding:16px;background:rgba(167,139,250,0.08);border-radius:12px}
      .badge{display:inline-block;padding:6px 14px;border-radius:20px;border:1px solid rgba(167,139,250,0.3);background:rgba(167,139,250,0.08);color:#a78bfa;font-size:.85rem}
      .code-box{font-size:2.5rem;font-weight:900;letter-spacing:12px;text-align:center;color:#a78bfa;background:rgba(167,139,250,0.08);border-radius:12px;padding:20px;margin:20px 0;border:2px dashed rgba(167,139,250,0.3)}
      .divider{border:none;border-top:1px solid rgba(255,255,255,0.08);margin:20px 0}
      .footer{margin-top:24px;font-size:.75rem;color:#5a5a7a;text-align:center}
    </style></head><body><div class="container">
      <div class="logo">⚡ QuestInvest</div>
      ${htmlBody}
      <div class="footer">QuestInvest — Ne répondez pas à cet email.</div>
    </div></body></html>`,
    '',
    `--${boundary}--`
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

async function sendEmail(to, subject, bodyHtml, title) {
  const MAIL_USER_LOCAL = process.env.MAIL_USER || '';
  let status = 'sent', errorMsg = null;
  try {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN || !MAIL_USER_LOCAL) {
      throw new Error('Variables OAuth2 manquantes');
    }
    const accessToken = await getGmailAccessToken();
    const raw = buildRawEmail(`QuestInvest <${MAIL_USER_LOCAL}>`, to, subject, bodyHtml);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.error?.message || 'Gmail API error');
    }
    console.log(`[mail] Sent "${title}" → ${to}`);
  } catch (e) {
    status = 'failed';
    errorMsg = e.message;
    console.error(`[mail] Failed "${title}" → ${to} : ${e.message}`);
  }
  try {
    await db.run(
      'INSERT INTO email_logs (recipient, subject, status, error_message) VALUES (?, ?, ?, ?)',
      [to, subject, status, errorMsg]
    );
  } catch (_) {}
  return { success: status === 'sent', error: errorMsg };
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const MAIL_USER = process.env.MAIL_USER || '';
const MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || '150');

app.set('trust proxy', 1);

// ── Secrets persistants ───────────────────────────────────────────────────────
function getPersistentConfigPath(name) {
  const baseDir = process.env.TURSO_DATABASE_URL
    ? '/tmp'
    : path.join(__dirname, '.data');
  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, `${name}.txt`);
}

function getOrCreatePersistentSecret(name, generator) {
  if (process.env[name]) return process.env[name];
  const secretPath = getPersistentConfigPath(name);
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const value = generator();
  try { fs.writeFileSync(secretPath, value, { mode: 0o600 }); } catch (_) {}
  console.warn(`${name} was not provided; generated a persistent value`);
  return value;
}

const SESSION_SECRET  = getOrCreatePersistentSecret('SESSION_SECRET',  () => crypto.randomBytes(32).toString('hex'));
const DEFAULT_DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'TYyUwQELkUW957jE7Svt42LSaeQWneWtQG';
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL    || 'admin@questinvest.com';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || (isProduction
  ? getOrCreatePersistentSecret('ADMIN_PASSWORD', () => crypto.randomBytes(24).toString('base64url'))
  : 'admin123');
const ADMIN_ACCESS_CODE = '1289';

// ── Settings cache (lecture sync, écriture async) ────────────────────────────
const settingsCache = {};

async function loadSettingsCache() {
  try {
    const rows = await db.all('SELECT key, value FROM settings');
    for (const row of rows) settingsCache[row.key] = row.value;
  } catch (_) {}
}

function getSetting(key) {
  return settingsCache[key] ?? null;
}

async function setSetting(key, value) {
  settingsCache[key] = String(value);
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

// ── Email helpers ─────────────────────────────────────────────────────────────
function isEmailEnabled(type) {
  if (getSetting('email_all_disabled') === '1') return false;
  return getSetting(`email_toggle_${type}`) !== '0';
}

async function sendEmailIfEnabled(type, to, subject, bodyHtml, title) {
  if (!isEmailEnabled(type)) {
    console.log(`[mail] Type "${type}" désactivé — email ignoré`);
    return { success: true, skipped: true };
  }
  return sendEmail(to, subject, bodyHtml, title);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDepositAddress() {
  return getSetting('deposit_address') || DEFAULT_DEPOSIT_ADDRESS;
}

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getQuestPeriod() {
  const periodLengthDays = 14;
  const ms = 24 * 60 * 60 * 1000;
  const startAnchor = Date.UTC(2024, 0, 1);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceAnchor = Math.floor((todayUtc - startAnchor) / ms);
  const periodIndex = Math.floor(daysSinceAnchor / periodLengthDays);
  const startUtc = startAnchor + periodIndex * periodLengthDays * ms;
  const endUtc = startUtc + (periodLengthDays - 1) * ms;
  return {
    startDate: new Date(startUtc).toISOString().split('T')[0],
    endDate:   new Date(endUtc).toISOString().split('T')[0],
    lengthDays: periodLengthDays
  };
}

const NEW_USER_PERIOD_DAYS = 14;

function getNewUserStatus(user) {
  if (!user || !user.created_at) return { isNew: false, startDate: null, endDate: null, lengthDays: NEW_USER_PERIOD_DAYS };
  const ms = 24 * 60 * 60 * 1000;
  const createdAt = new Date(user.created_at);
  const createdUtc = Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate());
  const startDate = new Date(createdUtc).toISOString().split('T')[0];
  const endDate   = new Date(createdUtc + (NEW_USER_PERIOD_DAYS - 1) * ms).toISOString().split('T')[0];
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((todayUtc - createdUtc) / ms);
  return { isNew: ageDays < NEW_USER_PERIOD_DAYS, startDate, endDate, lengthDays: NEW_USER_PERIOD_DAYS };
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.match(/\.(js|css)$/)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// ── Session store SQLite (async) ──────────────────────────────────────────────
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    setInterval(async () => {
      try { await db.run('DELETE FROM sessions WHERE expired < ?', [Date.now()]); } catch (_) {}
    }, 15 * 60 * 1000);
  }
  get(sid, cb) {
    if (typeof cb !== 'function') cb = () => {};
    db.get('SELECT sess, expired FROM sessions WHERE sid = ?', [sid])
      .then(row => {
        if (!row) return cb(null, null);
        if (row.expired < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
        cb(null, JSON.parse(row.sess));
      })
      .catch(e => cb(e));
  }
  set(sid, sess, cb) {
    if (typeof cb !== 'function') cb = () => {};
    const expired = sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    db.run('INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expired = EXCLUDED.expired', [sid, JSON.stringify(sess), expired])
      .then(() => cb(null))
      .catch(e => cb(e));
  }
  destroy(sid, cb) {
    if (typeof cb !== 'function') cb = () => {};
    db.run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb(null))
      .catch(e => cb(e));
  }
}

app.use(session({
  store: new SqliteSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax'
  }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// ── Maintenance middleware ────────────────────────────────────────────────────
app.use((req, res, next) => {
  const skip = req.path.startsWith('/api/admin') || req.path === '/admin' ||
               req.path === '/admin.html' || req.path === '/health' ||
               req.path === '/api/maintenance';
  if (skip) return next();
  if (getSetting('maintenance_mode') === '1') {
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'Site en maintenance. Revenez bientôt.', maintenance: true });
    }
  }
  next();
});

// ── initDB ────────────────────────────────────────────────────────────────────
async function initDB() {
  const pg = db.isPostgres;
  const PK  = pg ? 'SERIAL PRIMARY KEY'              : 'INTEGER PRIMARY KEY';
  const TS  = pg ? 'TIMESTAMP DEFAULT NOW()'         : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const TSN = pg ? 'TIMESTAMP'                       : 'DATETIME';

  await db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired BIGINT NOT NULL
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS users (
    id ${PK},
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    balance REAL DEFAULT 0,
    deposit_amount REAL DEFAULT 0,
    deposit_address TEXT,
    referral_code TEXT UNIQUE,
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS deposits (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    amount REAL NOT NULL,
    tx_hash TEXT,
    status TEXT DEFAULT 'pending',
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS admins (
    id ${PK},
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS quests (
    id ${PK},
    title TEXT NOT NULL,
    description TEXT,
    reward_percentage REAL DEFAULT 40
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS user_quests (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    quest_id INTEGER REFERENCES quests(id),
    completed_date DATE,
    reward_earned REAL DEFAULT 0,
    UNIQUE(user_id, quest_id, completed_date)
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS referrals (
    id ${PK},
    referrer_id INTEGER REFERENCES users(id),
    referred_id INTEGER REFERENCES users(id),
    bonus_paid INTEGER DEFAULT 0,
    bonus_amount REAL DEFAULT 0,
    created_at ${TS}
  )`);
  // Migration: add bonus columns to existing referrals table
  try { await db.run('ALTER TABLE referrals ADD COLUMN bonus_paid INTEGER DEFAULT 0'); } catch {}
  try { await db.run('ALTER TABLE referrals ADD COLUMN bonus_amount REAL DEFAULT 0'); } catch {}

  // Anti-fraude : IP par utilisateur
  try { await db.run('ALTER TABLE users ADD COLUMN registration_ip TEXT'); } catch {}
  try { await db.run('ALTER TABLE users ADD COLUMN last_login_ip TEXT'); } catch {}

  await db.exec(`CREATE TABLE IF NOT EXISTS blocked_ips (
    id ${PK},
    ip TEXT UNIQUE NOT NULL,
    reason TEXT,
    blocked_by TEXT DEFAULT 'admin',
    blocked_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    amount REAL NOT NULL,
    address TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS recovery_requests (
    id ${PK},
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    old_password TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    submitted_at ${TS},
    reviewed_at ${TSN}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS email_logs (
    id ${PK},
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    error_message TEXT,
    sent_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS kyc_submissions (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    document_front TEXT,
    document_back TEXT,
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    submitted_at ${TS},
    reviewed_at ${TSN}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS news_posts (
    id ${PK},
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_published INTEGER DEFAULT 1,
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS testimonials (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    content TEXT NOT NULL,
    rating INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    submitted_at ${TS},
    reviewed_at ${TSN}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS ticket_replies (
    id ${PK},
    ticket_id INTEGER REFERENCES support_tickets(id),
    sender TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at ${TS}
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id ${PK},
    user_id INTEGER REFERENCES users(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at ${TS},
    UNIQUE(user_id, endpoint)
  )`);

  // Migrations (try/catch car la colonne peut déjà exister)
  const migrationsList = [
    ['ALTER TABLE users ADD COLUMN can_withdraw INTEGER DEFAULT 0'],
    ['ALTER TABLE quests ADD COLUMN quest_type TEXT DEFAULT \'regular\''],
    ['ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT \'\''],
    ['ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT \'\''],
    ['ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0'],
    ['ALTER TABLE users ADD COLUMN last_login TIMESTAMP'],
    ['ALTER TABLE users ADD COLUMN independence_plan_claimed INTEGER DEFAULT 0'],
    ['ALTER TABLE users ADD COLUMN independence_plan_gain REAL DEFAULT 0'],
    ['ALTER TABLE users ADD COLUMN independence_plan_instant_withdraw INTEGER DEFAULT 0'],
  ];
  for (const [sql] of migrationsList) {
    try { await db.run(sql); } catch (e) {
      if (!e.message?.includes('duplicate column') && !e.message?.includes('already exists')) {
        console.warn('[migration] Ignoré:', e.message?.split('\n')[0]);
      }
    }
  }

  // Adresse de dépôt par défaut
  const settingsCount = await db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'deposit_address'");
  if (!settingsCount || Number(settingsCount.count) === 0) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['deposit_address', DEFAULT_DEPOSIT_ADDRESS]);
  }

  // Quêtes régulières
  const regularQuestCount = await db.get("SELECT COUNT(*) as count FROM quests WHERE quest_type = 'regular' OR quest_type IS NULL");
  if (!regularQuestCount || Number(regularQuestCount.count) === 0) {
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'regular')", ['Partager sur les réseaux', 'Partagez notre plateforme sur vos réseaux sociaux', 40]);
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'regular')", ['Regarder une vidéo', 'Regardez une vidéo promotionnelle de 30 secondes', 40]);
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'regular')", ['Visiter notre partenaire', 'Visitez le site de notre partenaire pour découvrir de nouvelles opportunités', 40]);
  }

  // Quêtes bienvenue
  const newcomerQuestCount = await db.get("SELECT COUNT(*) as count FROM quests WHERE quest_type = 'newcomer'");
  if (!newcomerQuestCount || Number(newcomerQuestCount.count) === 0) {
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'newcomer')", ['Bienvenue : Présentez-vous', 'Complétez votre profil et découvrez la plateforme', 20]);
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'newcomer')", ['Bienvenue : Partage social', 'Partagez QuestInvest avec vos amis sur les réseaux sociaux', 20]);
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'newcomer')", ['Bienvenue : Tutoriel', "Suivez le tutoriel d'utilisation de QuestInvest", 20]);
    await db.run("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'newcomer')", ['Bienvenue : Vidéo de présentation', 'Regardez la vidéo de présentation de la plateforme', 20]);
  }

  await db.run("UPDATE quests SET reward_percentage = 40 WHERE quest_type = 'regular' OR quest_type IS NULL");
  await db.run("UPDATE quests SET reward_percentage = 20 WHERE quest_type = 'newcomer'");

  // Admin par défaut
  const adminCount = await db.get('SELECT COUNT(*) as count FROM admins');
  if (!adminCount || Number(adminCount.count) === 0) {
    const hashedAdminPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await db.run('INSERT INTO admins (email, password) VALUES (?, ?)', [ADMIN_EMAIL, hashedAdminPassword]);
  }

  // Paramètres email par défaut
  const emailDefaults = {
    'email_reminder_hour': '9',
    'email_twofa_expiry': '10',
    'email_toggle_welcome': '1',
    'email_toggle_2fa': '1',
    'email_toggle_deposit_received': '1',
    'email_toggle_deposit_confirmed': '1',
    'email_toggle_deposit_rejected': '1',
    'email_toggle_quest_completed': '1',
    'email_toggle_withdrawal_received': '1',
    'email_toggle_withdrawal_confirmed': '1',
    'email_toggle_withdrawal_rejected': '1',
    'email_toggle_daily_reminder': '1',
    'email_all_disabled': '1',
  };
  for (const [key, val] of Object.entries(emailDefaults)) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, val]);
  }

  // Charger le cache des settings
  await loadSettingsCache();

  console.log('Database initialized successfully');
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const u = await db.get('SELECT is_banned FROM users WHERE id = ?', [req.session.userId]);
    if (!u || u.is_banned) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'Compte suspendu. Contactez le support.' });
    }
    next();
  } catch { next(); }
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Accès non autorisé' });
  next();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { email, password, referralCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const clientIp = getClientIp(req);

  try {
    // Anti-fraude : IP bloquée ?
    const blockedIp = await db.get('SELECT id FROM blocked_ips WHERE ip = ?', [clientIp]);
    if (blockedIp) return res.status(403).json({ error: 'Accès refusé depuis cette adresse IP.' });

    // Anti-fraude : un seul compte par IP
    const existingIpUser = await db.get('SELECT id FROM users WHERE registration_ip = ?', [clientIp]);
    if (existingIpUser) return res.status(400).json({ error: 'Un compte existe déjà depuis votre adresse IP. Un seul compte est autorisé par adresse.' });

    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) return res.status(400).json({ error: 'Cet email existe déjà' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = generateReferralCode();

    const result = await db.run(
      'INSERT INTO users (email, password, referral_code, registration_ip) VALUES (?, ?, ?, ?)',
      [email, hashedPassword, newReferralCode, clientIp]
    );

    if (referralCode) {
      const referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode]);
      if (referrer) {
        await db.run('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', [referrer.id, result.lastInsertRowid]);
      }
    }

    req.session.userId = result.lastInsertRowid;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      }
      const depositAddr = getDepositAddress();
      sendEmailIfEnabled('welcome', email, '🎉 Bienvenue sur QuestInvest !',
        `<p>Bonjour et bienvenue sur <strong>QuestInvest</strong> !</p>
         <p>Votre compte a été créé avec succès. Voici comment démarrer :</p>
         <p><span class="badge">1️⃣ Déposez un minimum de $${MIN_DEPOSIT} USDT</span></p>
         <p>Envoyez vos USDT (TRC20) à l'adresse suivante :</p>
         <div class="code-box" style="letter-spacing:2px;font-size:1rem;word-break:break-all;">${depositAddr}</div>
         <p><span class="badge">2️⃣ Soumettez votre hash de transaction</span></p>
         <p>Une fois le virement effectué, entrez le hash de la transaction dans votre tableau de bord pour validation.</p>
         <p><span class="badge">3️⃣ Complétez vos quêtes</span></p>
         <p>Dès que votre dépôt est confirmé, des quêtes deviennent disponibles et vous rapportent des récompenses tous les 14 jours.</p>
         <hr class="divider">
         <p style="font-size:.8rem;color:#5a5a7a;">Si vous avez des questions, contactez notre support.</p>`,
        '🎉 Bienvenue sur QuestInvest !'
      );
      res.json({ success: true, user: { email } });
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: "Erreur serveur lors de l'inscription" });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (user.is_banned) return res.status(403).json({ error: 'Compte suspendu. Contactez le support.' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const loginIp = getClientIp(req);
    try { await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP, last_login_ip = ? WHERE id = ?', [loginIp, user.id]); } catch (_) {}

    // Anti-fraude : IP bloquée au login aussi
    const blockedAtLogin = await db.get('SELECT id FROM blocked_ips WHERE ip = ?', [loginIp]);
    if (blockedAtLogin) return res.status(403).json({ error: 'Accès refusé depuis cette adresse IP.' });

    const emailConfigured = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN && process.env.MAIL_USER);

    // Lecture directe en DB pour ne pas dépendre du cache
    let emailsGloballyDisabled = getSetting('email_all_disabled') === '1';
    try {
      const row = await db.get("SELECT value FROM settings WHERE key = 'email_all_disabled'");
      if (row) emailsGloballyDisabled = row.value === '1';
    } catch (_) {}

    if (!emailConfigured || emailsGloballyDisabled) {
      req.session.userId = user.id;
      req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        res.json({ success: true, user: { email: user.email } });
      });
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiryMinutes = parseInt(getSetting('email_twofa_expiry') || '10', 10);
    const expires = Date.now() + expiryMinutes * 60 * 1000;

    req.session.pending2fa = { userId: user.id, code, expires };
    const maskedEmail = user.email.replace(/(.{2}).+(@.+)/, '$1***$2');

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Erreur serveur' });
      sendEmailIfEnabled('2fa', user.email, '🔐 Votre code de vérification QuestInvest',
        `<p>Bonjour,</p>
         <p>Voici votre code de connexion à 6 chiffres. Il est valable <strong>${expiryMinutes} minute${expiryMinutes > 1 ? 's' : ''}</strong>.</p>
         <div class="code-box">${code}</div>
         <p>Si vous n'avez pas tenté de vous connecter, ignorez cet email et changez votre mot de passe immédiatement.</p>`,
        '🔐 Code de vérification'
      );
      res.json({ requires2fa: true, maskedEmail });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion' });
  }
});

app.post('/api/verify-2fa', async (req, res) => {
  const { code } = req.body;
  const pending = req.session.pending2fa;

  if (!pending) return res.status(400).json({ error: 'Aucune session 2FA en cours. Veuillez vous reconnecter.' });
  if (Date.now() > pending.expires) {
    req.session.pending2fa = null;
    return res.status(400).json({ error: 'Code expiré. Veuillez vous reconnecter.' });
  }
  if (code !== pending.code) return res.status(401).json({ error: 'Code incorrect. Vérifiez votre email.' });

  const userId = pending.userId;
  req.session.pending2fa = null;
  req.session.userId = userId;

  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── USER ENDPOINTS ────────────────────────────────────────────────────────────

app.get('/api/user', requireAuth, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, balance, deposit_amount, created_at, referral_code FROM users WHERE id = ?',
      [req.session.userId]
    );
    user.deposit_address = getDepositAddress();

    const kycRow = await db.get(
      'SELECT status FROM kyc_submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 1',
      [req.session.userId]
    );
    user.kyc_status = kycRow ? kycRow.status : null;

    const referralsCount = await db.get('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?', [req.session.userId]);
    user.referrals_count = Number(referralsCount.count);

    const withdrawnRow = await db.get(
      "SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE user_id = ? AND status != 'rejected'",
      [req.session.userId]
    );
    user.total_withdrawn = withdrawnRow.total;

    const firstDeposit = await db.get(
      "SELECT created_at FROM deposits WHERE user_id = ? AND status = 'confirmed' ORDER BY created_at ASC LIMIT 1",
      [req.session.userId]
    );
    if (firstDeposit) {
      const depositDate = new Date(firstDeposit.created_at);
      depositDate.setUTCDate(depositDate.getUTCDate() + 1);
      user.withdraw_available_from = depositDate.toISOString().split('T')[0];
    } else {
      user.withdraw_available_from = null;
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/user/email', requireAuth, async (req, res) => {
  const { new_email, current_password } = req.body;
  if (!new_email || !current_password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    const validPassword = await bcrypt.compare(current_password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Mot de passe incorrect' });

    await db.run('UPDATE users SET email = ? WHERE id = ?', [new_email, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505' || (err.message && err.message.includes('unique'))) {
      return res.status(400).json({ error: 'Cet email existe deja' });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/user/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Mots de passe requis' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit avoir au moins 6 caracteres' });

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    const validPassword = await bcrypt.compare(current_password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DEPOSIT ───────────────────────────────────────────────────────────────────

app.post('/api/deposit', requireAuth, async (req, res) => {
  const { amount, tx_hash } = req.body;
  if (!amount || parseFloat(amount) < MIN_DEPOSIT) return res.status(400).json({ error: `Le dépôt minimum est de ${MIN_DEPOSIT}$` });
  if (!tx_hash || tx_hash.trim().length < 10) return res.status(400).json({ error: 'Hash de transaction requis' });

  try {
    await db.run(
      'INSERT INTO deposits (user_id, amount, tx_hash, status) VALUES (?, ?, ?, ?)',
      [req.session.userId, amount, tx_hash.trim(), 'pending']
    );
    const depUser = await db.get('SELECT email FROM users WHERE id = ?', [req.session.userId]);
    sendEmailIfEnabled('deposit_received', depUser.email, '📥 Dépôt reçu — En attente de validation',
      `<p>Bonjour,</p>
       <p>Nous avons bien reçu votre demande de dépôt. Notre équipe va la vérifier sous 24h.</p>
       <div class="amount">$${parseFloat(amount).toFixed(2)}</div>
       <p><span class="badge">⏳ En attente de validation</span></p>
       <hr class="divider">
       <p style="font-size:.8rem;">Hash de transaction : <code style="color:#a78bfa;">${tx_hash.trim()}</code></p>
       <p>Vous recevrez un email de confirmation dès que votre dépôt sera validé.</p>`,
      '📥 Dépôt reçu'
    );
    res.json({ success: true, message: "Transaction soumise, en attente de validation par l'admin" });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── QUESTS ────────────────────────────────────────────────────────────────────

app.get('/api/quests', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT created_at FROM users WHERE id = ?', [req.session.userId]);
    const newUserStatus = getNewUserStatus(user);
    const isNewcomer = newUserStatus.isNew;
    const period = isNewcomer
      ? { startDate: newUserStatus.startDate, endDate: newUserStatus.endDate, lengthDays: newUserStatus.lengthDays }
      : getQuestPeriod();
    const questType = isNewcomer ? 'newcomer' : 'regular';

    const quests = await db.all(`
      SELECT q.*,
        CASE WHEN MAX(uq.id) IS NOT NULL THEN 1 ELSE 0 END as completed
      FROM quests q
      LEFT JOIN user_quests uq ON q.id = uq.quest_id
        AND uq.user_id = ?
        AND uq.completed_date BETWEEN ? AND ?
      WHERE COALESCE(q.quest_type, 'regular') = ?
      GROUP BY q.id
      ORDER BY q.id
    `, [req.session.userId, period.startDate, period.endDate, questType]);

    const completedCount = await db.get(`
      SELECT COUNT(DISTINCT uq.quest_id) as count
      FROM user_quests uq
      JOIN quests q ON q.id = uq.quest_id
      WHERE uq.user_id = ? AND uq.completed_date BETWEEN ? AND ?
        AND COALESCE(q.quest_type, 'regular') = ?
    `, [req.session.userId, period.startDate, period.endDate, questType]);

    const referralsCount = await db.get('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?', [req.session.userId]);

    const questsWithStatus = quests.map(quest => ({ ...quest, completed: !!quest.completed, locked: false, lockReason: '' }));
    const totalRewardPercentage = quests.reduce((sum, q) => sum + parseFloat(q.reward_percentage || 0), 0);

    res.json({
      quests: questsWithStatus,
      completedToday: Number(completedCount.count),
      completedThisPeriod: Number(completedCount.count),
      totalQuests: quests.length,
      totalRewardPercentage,
      resetPeriodStart: period.startDate,
      resetPeriodEnd: period.endDate,
      resetPeriodDays: period.lengthDays,
      referralsCount: Number(referralsCount.count),
      isNewUser: isNewcomer,
      newUserPeriodEnd: newUserStatus.endDate
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/quests/:id/complete', requireAuth, async (req, res) => {
  const questId = parseInt(req.params.id);
  try {
    const user = await db.get('SELECT deposit_amount, created_at FROM users WHERE id = ?', [req.session.userId]);
    if (parseFloat(user.deposit_amount) < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Vous devez avoir un dépôt minimum de ${MIN_DEPOSIT}$ pour compléter les quêtes` });
    }

    const quest = await db.get('SELECT * FROM quests WHERE id = ?', [questId]);
    if (!quest) return res.status(404).json({ error: 'Quête non trouvée' });

    const newUserStatus = getNewUserStatus(user);
    const isNewcomer = newUserStatus.isNew;
    const questType = quest.quest_type || 'regular';

    if (isNewcomer && questType !== 'newcomer') {
      return res.status(400).json({ error: 'Cette quête sera disponible après votre période de bienvenue de 2 semaines.' });
    }
    if (!isNewcomer && questType === 'newcomer') {
      return res.status(400).json({ error: 'La période de bienvenue est terminée. Ces quêtes ne sont plus disponibles.' });
    }

    const period = isNewcomer
      ? { startDate: newUserStatus.startDate, endDate: newUserStatus.endDate }
      : getQuestPeriod();

    const existing = await db.get(
      'SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ? AND completed_date BETWEEN ? AND ?',
      [req.session.userId, questId, period.startDate, period.endDate]
    );
    if (existing) return res.status(400).json({ error: 'Quête déjà complétée pour cette période de 2 semaines' });

    const depositAmount = parseFloat(user.deposit_amount);
    const reward = (depositAmount * parseFloat(quest.reward_percentage)) / 100;

    await db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO user_quests (user_id, quest_id, completed_date, reward_earned) VALUES (?, ?, ?, ?)',
        [req.session.userId, questId, period.startDate, reward]
      );
      await tx.run('UPDATE users SET balance = balance + ? WHERE id = ?', [reward, req.session.userId]);
    });

    const updatedUser = await db.get('SELECT email, balance FROM users WHERE id = ?', [req.session.userId]);
    sendEmailIfEnabled('quest_completed', updatedUser.email, '🎯 Quête complétée — Récompense créditée !',
      `<p>Bravo ! Vous venez de compléter une quête et votre récompense a été créditée instantanément.</p>
       <div class="amount">+$${reward.toFixed(2)}</div>
       <p><span class="badge">✓ ${quest.title}</span></p>
       <hr class="divider">
       <p>Votre nouveau solde disponible : <strong style="color:#a78bfa;">$${parseFloat(updatedUser.balance).toFixed(2)}</strong></p>
       <p>Continuez à compléter vos quêtes pour maximiser vos gains ce cycle !</p>`,
      '🎯 Quête complétée'
    );

    res.json({ success: true, reward, newBalance: parseFloat(updatedUser.balance) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── HISTORY / DEPOSITS ────────────────────────────────────────────────────────

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const deposits = await db.all(
      'SELECT amount, status, tx_hash, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
      [req.session.userId]
    );
    const withdrawals = await db.all(
      'SELECT amount, status, address, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
      [req.session.userId]
    );
    const questRewards = await db.all(`
      SELECT uq.reward_earned, uq.completed_date, q.title
      FROM user_quests uq
      JOIN quests q ON uq.quest_id = q.id
      WHERE uq.user_id = ?
      ORDER BY uq.completed_date DESC LIMIT 10
    `, [req.session.userId]);

    const referralBonuses = await db.all(`
      SELECT r.bonus_amount, r.created_at, u.email as referred_email
      FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ? AND r.bonus_paid = 1
      ORDER BY r.created_at DESC LIMIT 10
    `, [req.session.userId]);

    res.json({ deposits, withdrawals, questRewards, referralBonuses });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/deposits', requireAuth, async (req, res) => {
  try {
    const deposits = await db.all(
      'SELECT amount, status, tx_hash, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.session.userId]
    );
    res.json({ deposits });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── PLAN INDÉPENDANCE ─────────────────────────────────────────────────────────

const INDEPENDENCE_PLAN_DEADLINE = new Date('2026-06-05T23:59:59Z');
const INDEPENDENCE_PLAN_MIN_DEPOSIT = 350;
const INDEPENDENCE_PLAN_MAX_DEPOSIT = 10000;
const INDEPENDENCE_PLAN_GAIN_PCT = 200;

app.get('/api/plan/independence', requireAuth, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT deposit_amount, independence_plan_claimed, independence_plan_gain FROM users WHERE id = ?',
      [req.session.userId]
    );
    const now = new Date();
    const isActive = now <= INDEPENDENCE_PLAN_DEADLINE;
    const depositAmount = parseFloat(user.deposit_amount || 0);
    const alreadyClaimed = !!user.independence_plan_claimed;
    const gainAmount = parseFloat(user.independence_plan_gain || 0);

    let status = 'ineligible';
    let missingAmount = 0;
    let projectedGain = 0;

    if (alreadyClaimed) {
      status = 'claimed';
    } else if (!isActive) {
      status = 'expired';
    } else if (depositAmount >= INDEPENDENCE_PLAN_MIN_DEPOSIT && depositAmount <= INDEPENDENCE_PLAN_MAX_DEPOSIT) {
      status = 'eligible';
      projectedGain = parseFloat((depositAmount * INDEPENDENCE_PLAN_GAIN_PCT / 100).toFixed(2));
    } else if (depositAmount > 0 && depositAmount < INDEPENDENCE_PLAN_MIN_DEPOSIT) {
      status = 'need_more';
      missingAmount = parseFloat((INDEPENDENCE_PLAN_MIN_DEPOSIT - depositAmount).toFixed(2));
      projectedGain = parseFloat((INDEPENDENCE_PLAN_MIN_DEPOSIT * INDEPENDENCE_PLAN_GAIN_PCT / 100).toFixed(2));
    } else if (depositAmount > INDEPENDENCE_PLAN_MAX_DEPOSIT) {
      status = 'ineligible';
    }

    res.json({
      status,
      depositAmount,
      projectedGain,
      gainAmount,
      missingAmount,
      deadline: INDEPENDENCE_PLAN_DEADLINE.toISOString(),
      isActive,
      minDeposit: INDEPENDENCE_PLAN_MIN_DEPOSIT,
      maxDeposit: INDEPENDENCE_PLAN_MAX_DEPOSIT,
      gainPct: INDEPENDENCE_PLAN_GAIN_PCT
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/plan/independence/claim', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    const now = new Date();

    if (now > INDEPENDENCE_PLAN_DEADLINE) {
      return res.status(400).json({ error: 'Le Plan Indépendance a expiré le 5 juin 2026.' });
    }
    if (user.independence_plan_claimed) {
      return res.status(400).json({ error: 'Vous avez déjà activé ce plan.' });
    }

    const depositAmount = parseFloat(user.deposit_amount || 0);
    if (depositAmount < INDEPENDENCE_PLAN_MIN_DEPOSIT || depositAmount > INDEPENDENCE_PLAN_MAX_DEPOSIT) {
      return res.status(400).json({ error: `Votre solde de dépôt ($${depositAmount.toFixed(2)}) ne remplit pas les conditions du plan.` });
    }

    const gain = parseFloat((depositAmount * INDEPENDENCE_PLAN_GAIN_PCT / 100).toFixed(2));

    await db.transaction(async (tx) => {
      await tx.run(
        'UPDATE users SET independence_plan_claimed = 1, independence_plan_gain = ?, independence_plan_instant_withdraw = 1, balance = balance + ? WHERE id = ?',
        [gain, gain, req.session.userId]
      );
    });

    const updatedUser = await db.get('SELECT email, balance FROM users WHERE id = ?', [req.session.userId]);

    sendEmailIfEnabled('deposit_confirmed', updatedUser.email, '🎉 Plan Indépendance activé — +200% crédité !',
      `<p>Félicitations !</p>
       <p>Votre <strong>Plan Indépendance</strong> a été activé avec succès. Un gain de <strong>200%</strong> de votre capital a été crédité immédiatement sur votre solde.</p>
       <div class="amount" style="color:#22d3a8;">+$${gain.toFixed(2)}</div>
       <p><span class="badge" style="color:#22d3a8;border-color:rgba(34,211,168,0.3);background:rgba(34,211,168,0.08);">✅ Plan activé</span></p>
       <hr class="divider">
       <p>Votre solde total disponible : <strong style="color:#a78bfa;">$${parseFloat(updatedUser.balance).toFixed(2)}</strong></p>
       <p>Vous pouvez effectuer un retrait <strong>immédiatement</strong>, sans délai de cycle.</p>`,
      '🎉 Plan Indépendance activé'
    );

    res.json({ success: true, gain, newBalance: parseFloat(updatedUser.balance) });
  } catch (err) {
    console.error('[plan] Claim error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/plan/independence/notify', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    if (now > INDEPENDENCE_PLAN_DEADLINE) {
      return res.status(400).json({ error: 'Le plan a expiré — impossible d\'envoyer des notifications.' });
    }
    const daysLeft = Math.max(0, Math.ceil((INDEPENDENCE_PLAN_DEADLINE - now) / (1000 * 60 * 60 * 24)));

    // Eligible ($350–$10 000) — pas encore activé
    const eligible = await db.all(`
      SELECT id, email, deposit_amount FROM users
      WHERE independence_plan_claimed = 0
        AND is_banned = 0
        AND deposit_amount >= ? AND deposit_amount <= ?
    `, [INDEPENDENCE_PLAN_MIN_DEPOSIT, INDEPENDENCE_PLAN_MAX_DEPOSIT]);

    // Presque éligibles ($250 — besoin de $100 de plus)
    const nearEligible = await db.all(`
      SELECT id, email, deposit_amount FROM users
      WHERE independence_plan_claimed = 0
        AND is_banned = 0
        AND deposit_amount >= 200 AND deposit_amount < ?
    `, [INDEPENDENCE_PLAN_MIN_DEPOSIT]);

    let sent = 0, failed = 0;

    for (const u of eligible) {
      const deposit = parseFloat(u.deposit_amount);
      const projectedGain = parseFloat((deposit * INDEPENDENCE_PLAN_GAIN_PCT / 100).toFixed(2));
      const ok = await sendEmailIfEnabled('deposit_confirmed', u.email,
        '⚡ Plan Indépendance — Votre gain de 200% vous attend !',
        `<p>Bonjour,</p>
         <p>Bonne nouvelle ! Vous êtes <strong style="color:#a78bfa;">éligible au Plan Indépendance</strong>.</p>
         <p>En activant ce plan exclusif avant le <strong>5 juin 2026</strong>, vous recevrez <strong style="color:#22d3a8;">+200%</strong> de votre capital de dépôt en une seule fois, disponible pour retrait <strong>immédiat</strong>.</p>
         <div class="amount" style="color:#22d3a8;">+$${projectedGain.toFixed(2)} à recevoir</div>
         <ul style="color:#9ca3af;font-size:.9rem;line-height:2;">
           <li>💰 Votre capital de dépôt : <strong style="color:#f0f0fa;">$${deposit.toFixed(2)}</strong></li>
           <li>⚡ Gain unique : <strong style="color:#22d3a8;">+$${projectedGain.toFixed(2)}</strong> (200%)</li>
           <li>📅 Expire dans : <strong style="color:#f87171;">${daysLeft} jours</strong></li>
           <li>🔓 Retrait <strong>immédiat</strong> — aucun délai de cycle</li>
         </ul>
         <p>Connectez-vous dès maintenant sur votre tableau de bord et cliquez sur <strong>⚡ Plan Indépendance</strong>.</p>`,
        '⚡ Plan Indépendance'
      );
      ok !== false ? sent++ : failed++;
    }

    for (const u of nearEligible) {
      const deposit = parseFloat(u.deposit_amount);
      const missing = parseFloat((INDEPENDENCE_PLAN_MIN_DEPOSIT - deposit).toFixed(2));
      const ok = await sendEmailIfEnabled('deposit_confirmed', u.email,
        '⚡ Plan Indépendance — Il vous manque seulement $' + missing.toFixed(0) + ' !',
        `<p>Bonjour,</p>
         <p>Vous êtes <strong>presque éligible</strong> au Plan Indépendance !</p>
         <p>Votre dépôt actuel est de <strong style="color:#fbbf24;">$${deposit.toFixed(2)}</strong>. Il vous suffit de déposer <strong style="color:#f0f0fa;">$${missing.toFixed(2)} supplémentaires</strong> pour atteindre le seuil de $${INDEPENDENCE_PLAN_MIN_DEPOSIT} et recevoir un gain de <strong style="color:#22d3a8;">+200%</strong> immédiatement.</p>
         <div class="amount" style="color:#fbbf24;">$${missing.toFixed(2)} manquants</div>
         <ul style="color:#9ca3af;font-size:.9rem;line-height:2;">
           <li>💰 Votre dépôt actuel : <strong style="color:#fbbf24;">$${deposit.toFixed(2)}</strong></li>
           <li>🎯 Seuil requis : <strong style="color:#f0f0fa;">$${INDEPENDENCE_PLAN_MIN_DEPOSIT}</strong></li>
           <li>⚡ Gain après dépôt : <strong style="color:#22d3a8;">+$${(INDEPENDENCE_PLAN_MIN_DEPOSIT * INDEPENDENCE_PLAN_GAIN_PCT / 100).toFixed(2)}</strong> minimum</li>
           <li>📅 Expire dans : <strong style="color:#f87171;">${daysLeft} jours</strong></li>
         </ul>
         <p>Connectez-vous et effectuez votre dépôt complémentaire dès maintenant.</p>`,
        '⚡ Plan Indépendance'
      );
      ok !== false ? sent++ : failed++;
    }

    res.json({
      success: true,
      eligibleCount: eligible.length,
      nearEligibleCount: nearEligible.length,
      sent,
      failed
    });
  } catch (err) {
    console.error('[plan] Notify error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/plans/independence', requireAdmin, async (req, res) => {
  try {
    const claims = await db.all(`
      SELECT u.id, u.email, u.deposit_amount, u.independence_plan_gain,
             u.independence_plan_instant_withdraw, u.balance
      FROM users u
      WHERE u.independence_plan_claimed = 1
      ORDER BY u.id DESC
    `);
    res.json(claims);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── WITHDRAWAL ────────────────────────────────────────────────────────────────

app.post('/api/withdraw', requireAuth, async (req, res) => {
  const { amount, address } = req.body;
  const minWithdraw = 50, maxWithdraw = 300;

  if (!amount || parseFloat(amount) < minWithdraw) return res.status(400).json({ error: `Le retrait minimum est de ${minWithdraw}$` });
  if (parseFloat(amount) > maxWithdraw) return res.status(400).json({ error: `Le retrait maximum est de ${maxWithdraw}$` });
  if (!address || address.trim().length < 10) return res.status(400).json({ error: 'Adresse de retrait invalide' });

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    const hasInstantWithdraw = !!user.independence_plan_instant_withdraw;

    if (!hasInstantWithdraw && !user.can_withdraw) {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      return res.status(400).json({ error: `Votre retrait sera disponible demain le ${tomorrowStr}. Merci de revenir à cette date.` });
    }

    const confirmedDeposit = await db.get(
      "SELECT id FROM deposits WHERE user_id = ? AND status = 'confirmed' LIMIT 1",
      [req.session.userId]
    );
    if (!confirmedDeposit) return res.status(400).json({ error: "Aucun dépôt confirmé. Vous devez d'abord effectuer un dépôt." });

    if (!hasInstantWithdraw) {
      const period = getQuestPeriod();
      const existingWithdrawal = await db.get(
        "SELECT id FROM withdrawals WHERE user_id = ? AND created_at >= ? AND status != 'rejected'",
        [req.session.userId, period.startDate]
      );
      if (existingWithdrawal) {
        return res.status(400).json({ error: `Vous avez déjà effectué un retrait ce cycle (${period.startDate} → ${period.endDate}). Prochain retrait disponible le ${period.endDate}.` });
      }
    }

    if (parseFloat(user.balance) < parseFloat(amount)) return res.status(400).json({ error: 'Solde insuffisant' });

    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO withdrawals (user_id, amount, address, status) VALUES (?, ?, ?, ?)', [req.session.userId, amount, address.trim(), 'pending']);
      await tx.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.session.userId]);
    });

    const wUser = await db.get('SELECT email FROM users WHERE id = ?', [req.session.userId]);
    sendEmailIfEnabled('withdrawal_received', wUser.email, '💸 Demande de retrait reçue — En cours de traitement',
      `<p>Bonjour,</p>
       <p>Nous avons bien reçu votre demande de retrait. Elle sera traitée par notre équipe sous 24h ouvrées.</p>
       <div class="amount">$${parseFloat(amount).toFixed(2)}</div>
       <p><span class="badge">⏳ En cours de traitement</span></p>
       <hr class="divider">
       <p style="font-size:.8rem;">Adresse de retrait : <code style="color:#a78bfa;">${address.trim()}</code></p>
       <p>Vous recevrez une confirmation par email dès que le virement sera effectué.</p>`,
      '💸 Retrait en cours'
    );
    res.json({ success: true, message: 'Demande de retrait soumise' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── RECOVERY ──────────────────────────────────────────────────────────────────

app.post('/api/recovery', async (req, res) => {
  const { first_name, last_name, email, old_password } = req.body;
  if (!first_name || !last_name || !email || !old_password) return res.status(400).json({ error: 'Tous les champs sont obligatoires' });

  try {
    await db.run(
      'INSERT INTO recovery_requests (first_name, last_name, email, old_password) VALUES (?, ?, ?, ?)',
      [first_name.trim(), last_name.trim(), email.trim(), old_password]
    );
    res.json({ success: true, message: 'Demande soumise. Notre équipe va vérifier vos informations sous 24-48h et restaurer votre accès.' });
  } catch (err) {
    console.error('Recovery error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/recovery/status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  try {
    const request = await db.get(
      'SELECT status, reject_reason, submitted_at, reviewed_at FROM recovery_requests WHERE email = ? ORDER BY submitted_at DESC LIMIT 1',
      [email]
    );
    res.json({ request: request || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── KYC ───────────────────────────────────────────────────────────────────────

app.get('/api/kyc', requireAuth, async (req, res) => {
  try {
    const kyc = await db.get(
      'SELECT id, status, reject_reason, submitted_at, reviewed_at FROM kyc_submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 1',
      [req.session.userId]
    );
    res.json({ kyc: kyc || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/kyc', requireAuth, async (req, res) => {
  const { document_front, document_back } = req.body;
  if (!document_front || document_front.length < 100) return res.status(400).json({ error: 'Document recto requis' });
  if (document_front.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image trop volumineuse (max 6 Mo)' });

  try {
    const existing = await db.get('SELECT id, status FROM kyc_submissions WHERE user_id = ?', [req.session.userId]);
    if (existing && existing.status === 'confirmed') return res.status(400).json({ error: 'Votre KYC est déjà validé' });

    if (existing) {
      await db.run(
        'UPDATE kyc_submissions SET document_front = ?, document_back = ?, status = ?, reject_reason = NULL, submitted_at = CURRENT_TIMESTAMP, reviewed_at = NULL WHERE user_id = ?',
        [document_front, document_back || null, 'pending', req.session.userId]
      );
    } else {
      await db.run(
        'INSERT INTO kyc_submissions (user_id, document_front, document_back) VALUES (?, ?, ?)',
        [req.session.userId, document_front, document_back || null]
      );
    }
    res.json({ success: true, message: 'Documents soumis, en attente de vérification' });
  } catch (err) {
    console.error('[kyc/submit] Erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN LOGIN ───────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_ACCESS_CODE) {
    req.session.adminId = 1;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      res.json({ success: true });
    });
  } else {
    res.status(401).json({ error: "Code d'accès incorrect" });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminId = null;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.adminId });
});

// ── ADMIN STATS ───────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsers         = await db.get('SELECT COUNT(*) as count FROM users');
    const pendingDeposits    = await db.get("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'");
    const confirmedDeposits  = await db.get("SELECT COALESCE(SUM(amount),0) as total FROM deposits WHERE status = 'confirmed'");
    const pendingWithdrawals = await db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'");
    const totalWithdrawn     = await db.get("SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status = 'confirmed'");
    const pendingKyc         = await db.get("SELECT COUNT(*) as count FROM kyc_submissions WHERE status = 'pending'");
    const pendingRecovery    = await db.get("SELECT COUNT(*) as count FROM recovery_requests WHERE status = 'pending'");
    const pendingTestimonials= await db.get("SELECT COUNT(*) as count FROM testimonials WHERE status = 'pending'");
    res.json({
      totalUsers:          Number(totalUsers.count),
      pendingDeposits:     Number(pendingDeposits.count),
      confirmedDeposits:   confirmedDeposits.total,
      pendingWithdrawals:  Number(pendingWithdrawals.count),
      totalWithdrawn:      totalWithdrawn.total,
      pendingKyc:          Number(pendingKyc.count),
      pendingRecovery:     Number(pendingRecovery.count),
      pendingTestimonials: Number(pendingTestimonials.count),
      maintenanceMode:     getSetting('maintenance_mode') === '1'
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN DEPOSITS ────────────────────────────────────────────────────────────

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const deposits = await db.all(`
      SELECT d.*, u.email as user_email
      FROM deposits d
      JOIN users u ON d.user_id = u.id
      ORDER BY d.created_at DESC
    `);
    res.json(deposits);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const depositId = req.params.id;
  try {
    const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!deposit) return res.status(404).json({ error: 'Dépôt non trouvé' });
    if (deposit.status !== 'pending') return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });

    const REFERRAL_BONUS_RATE = 0.10; // 10%

    // Vérifier si c'est le 1er dépôt confirmé du filleul
    const previousConfirmed = await db.get(
      "SELECT id FROM deposits WHERE user_id = ? AND status = 'confirmed' LIMIT 1",
      [deposit.user_id]
    );
    const isFirstDeposit = !previousConfirmed;

    // Chercher un parrain non encore bonifié pour ce filleul
    let referralBonus = null;
    if (isFirstDeposit) {
      const referral = await db.get(
        'SELECT * FROM referrals WHERE referred_id = ? AND bonus_paid = 0',
        [deposit.user_id]
      );
      if (referral) {
        referralBonus = { referral, bonusAmount: parseFloat((deposit.amount * REFERRAL_BONUS_RATE).toFixed(2)) };
      }
    }

    await db.transaction(async (tx) => {
      await tx.run('UPDATE deposits SET status = ? WHERE id = ?', ['confirmed', depositId]);
      await tx.run(
        'UPDATE users SET deposit_amount = deposit_amount + ?, balance = balance + ? WHERE id = ?',
        [deposit.amount, deposit.amount, deposit.user_id]
      );
      if (referralBonus) {
        await tx.run(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [referralBonus.bonusAmount, referralBonus.referral.referrer_id]
        );
        await tx.run(
          'UPDATE referrals SET bonus_paid = 1, bonus_amount = ? WHERE id = ?',
          [referralBonus.bonusAmount, referralBonus.referral.id]
        );
      }
    });

    // Email filleul — dépôt confirmé
    const approvedUser = await db.get('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    sendEmailIfEnabled('deposit_confirmed', approvedUser.email, '✅ Dépôt confirmé — Votre capital est actif !',
      `<p>Bonjour,</p>
       <p>Excellente nouvelle ! Votre dépôt a été vérifié et confirmé par notre équipe. Votre capital est désormais actif.</p>
       <div class="amount" style="color:#22d3a8;">$${parseFloat(deposit.amount).toFixed(2)}</div>
       <p><span class="badge" style="color:#22d3a8;border-color:rgba(34,211,168,0.3);background:rgba(34,211,168,0.08);">✅ Confirmé</span></p>
       <hr class="divider">
       <p>Vous pouvez maintenant <strong>compléter vos quêtes</strong> pour commencer à générer des récompenses dès aujourd'hui !</p>`,
      '✅ Dépôt confirmé'
    );

    // Email parrain — bonus de parrainage
    if (referralBonus) {
      const referrer = await db.get('SELECT email FROM users WHERE id = ?', [referralBonus.referral.referrer_id]);
      if (referrer) {
        sendEmailIfEnabled('deposit_confirmed', referrer.email, '🎁 Bonus de parrainage crédité !',
          `<p>Bonjour,</p>
           <p>Bonne nouvelle ! L'un de vos filleuls vient de confirmer son premier dépôt.</p>
           <p>En récompense, un <strong>bonus de parrainage de 10%</strong> a été crédité sur votre solde :</p>
           <div class="amount" style="color:#a78bfa;">+$${referralBonus.bonusAmount.toFixed(2)}</div>
           <hr class="divider">
           <p>Continuez à inviter des amis pour cumuler davantage de bonus !</p>`,
          '🎁 Bonus parrainage'
        );
      }
    }

    res.json({ success: true, message: 'Dépôt approuvé', referralBonus: referralBonus ? referralBonus.bonusAmount : null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const depositId = req.params.id;
  try {
    const deposit = await db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!deposit) return res.status(404).json({ error: 'Dépôt non trouvé' });
    if (deposit.status !== 'pending') return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });

    await db.run('UPDATE deposits SET status = ? WHERE id = ?', ['rejected', depositId]);

    const rejectedUser = await db.get('SELECT email FROM users WHERE id = ?', [deposit.user_id]);
    sendEmailIfEnabled('deposit_rejected', rejectedUser.email, '❌ Dépôt rejeté — Action requise',
      `<p>Bonjour,</p>
       <p>Votre dépôt de <strong>$${parseFloat(deposit.amount).toFixed(2)}</strong> n'a pas pu être confirmé.</p>
       <p><span class="badge" style="color:#f87171;border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.08);">❌ Rejeté</span></p>
       <hr class="divider">
       <p>Cela peut être dû à un hash de transaction invalide ou une transaction non trouvée sur la blockchain. Veuillez vérifier le hash et soumettre à nouveau votre dépôt.</p>
       <p style="font-size:.8rem;color:#5a5a7a;">Hash soumis : <code style="color:#f87171;">${deposit.tx_hash || 'N/A'}</code></p>`,
      '❌ Dépôt rejeté'
    );
    res.json({ success: true, message: 'Dépôt rejeté' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN WITHDRAWALS ─────────────────────────────────────────────────────────

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const withdrawals = await db.all(`
      SELECT w.*, u.email as user_email
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      ORDER BY w.created_at DESC
    `);
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/withdrawals/:id/approve', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', [id]);
    if (!w) return res.status(404).json({ error: 'Retrait non trouvé' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Déjà traité' });

    await db.run('UPDATE withdrawals SET status = ? WHERE id = ?', ['confirmed', id]);
    const wApprUser = await db.get('SELECT email FROM users WHERE id = ?', [w.user_id]);
    sendEmailIfEnabled('withdrawal_confirmed', wApprUser.email, '💰 Retrait confirmé — Virement effectué !',
      `<p>Bonjour,</p>
       <p>Votre retrait a été validé et le virement est en cours vers votre adresse.</p>
       <div class="amount" style="color:#22d3a8;">$${parseFloat(w.amount).toFixed(2)}</div>
       <p><span class="badge" style="color:#22d3a8;border-color:rgba(34,211,168,0.3);background:rgba(34,211,168,0.08);">✅ Confirmé</span></p>
       <hr class="divider">
       <p style="font-size:.8rem;">Adresse : <code style="color:#22d3a8;">${w.address}</code></p>
       <p>Les fonds peuvent prendre 1 à 24h pour apparaître selon le réseau. Merci pour votre confiance !</p>`,
      '💰 Retrait confirmé'
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', [id]);
    if (!w) return res.status(404).json({ error: 'Retrait non trouvé' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Déjà traité' });

    await db.transaction(async (tx) => {
      await tx.run('UPDATE withdrawals SET status = ? WHERE id = ?', ['rejected', id]);
      await tx.run('UPDATE users SET balance = balance + ? WHERE id = ?', [w.amount, w.user_id]);
    });

    const wRejUser = await db.get('SELECT email FROM users WHERE id = ?', [w.user_id]);
    sendEmailIfEnabled('withdrawal_rejected', wRejUser.email, '❌ Retrait rejeté — Solde recrédité',
      `<p>Bonjour,</p>
       <p>Votre demande de retrait de <strong>$${parseFloat(w.amount).toFixed(2)}</strong> n'a pas pu être traitée.</p>
       <p><span class="badge" style="color:#f87171;border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.08);">❌ Rejeté</span></p>
       <hr class="divider">
       <p>Votre solde a été <strong>recrédité intégralement</strong>. Vous pouvez soumettre une nouvelle demande depuis votre tableau de bord.</p>
       <p>En cas de question, contactez notre support.</p>`,
      '❌ Retrait rejeté'
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN MESSAGERIE ──────────────────────────────────────────────────────────

app.post('/api/admin/send-message', requireAdmin, async (req, res) => {
  const { to, subject, message } = req.body;
  if (!subject || !subject.trim()) return res.status(400).json({ error: 'Sujet requis' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis' });

  const msgHtml = message.trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const bodyHtml = `
    <p style="font-size:1rem;color:#e2e8f0;line-height:1.7;">${msgHtml}</p>
    <hr style="border:none;border-top:1px solid #374151;margin:24px 0;">
    <p style="font-size:.8rem;color:#6b7280;">Ce message a été envoyé par l'équipe QuestInvest.</p>`;

  try {
    if (to === 'all') {
      const users = await db.all('SELECT email FROM users');
      let sent = 0, failed = 0;
      for (const u of users) {
        const r = await sendEmail(u.email, subject.trim(), bodyHtml, subject.trim());
        r.success ? sent++ : failed++;
      }
      return res.json({ success: true, sent, failed, total: users.length });
    } else {
      const user = await db.get('SELECT email FROM users WHERE email = ?', [to]);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
      const r = await sendEmail(user.email, subject.trim(), bodyHtml, subject.trim());
      if (!r.success) return res.status(500).json({ error: r.error || 'Envoi échoué' });
      return res.json({ success: true, sent: 1 });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN KYC ─────────────────────────────────────────────────────────────────

app.get('/api/admin/kyc', requireAdmin, async (req, res) => {
  try {
    const submissions = await db.all(`
      SELECT k.id, k.user_id, k.status, k.reject_reason, k.submitted_at, k.reviewed_at, u.email as user_email
      FROM kyc_submissions k
      JOIN users u ON k.user_id = u.id
      ORDER BY k.submitted_at DESC
    `);
    res.json(submissions);
  } catch (err) {
    console.error('[admin/kyc] Erreur requête:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/kyc/:id/document', requireAdmin, async (req, res) => {
  try {
    const kyc = await db.get('SELECT document_front, document_back FROM kyc_submissions WHERE id = ?', [req.params.id]);
    if (!kyc) return res.status(404).json({ error: 'Non trouvé' });
    res.json({ document_front: kyc.document_front, document_back: kyc.document_back });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/kyc/:id/approve', requireAdmin, async (req, res) => {
  try {
    const kyc = await db.get('SELECT * FROM kyc_submissions WHERE id = ?', [req.params.id]);
    if (!kyc) return res.status(404).json({ error: 'Soumission non trouvée' });
    if (kyc.status === 'confirmed') return res.status(400).json({ error: 'Déjà approuvé' });
    await db.run(
      "UPDATE kyc_submissions SET status = 'confirmed', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/kyc/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  try {
    const kyc = await db.get('SELECT * FROM kyc_submissions WHERE id = ?', [req.params.id]);
    if (!kyc) return res.status(404).json({ error: 'Soumission non trouvée' });
    await db.run(
      "UPDATE kyc_submissions SET status = 'rejected', reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [reason || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN RECOVERY ────────────────────────────────────────────────────────────

app.get('/api/admin/recovery', requireAdmin, async (req, res) => {
  try {
    const requests = await db.all(
      'SELECT id, first_name, last_name, email, old_password, status, reject_reason, submitted_at, reviewed_at FROM recovery_requests ORDER BY submitted_at DESC'
    );
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/recovery/:id/approve', requireAdmin, async (req, res) => {
  try {
    const recovery = await db.get('SELECT * FROM recovery_requests WHERE id = ?', [req.params.id]);
    if (!recovery) return res.status(404).json({ error: 'Demande non trouvée' });
    if (recovery.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });

    const hashedPassword = await bcrypt.hash(recovery.old_password, 10);

    await db.transaction(async (tx) => {
      const user = await tx.get('SELECT id FROM users WHERE email = ?', [recovery.email]);
      if (user) {
        await tx.run(
          'UPDATE users SET password = ?, first_name = ?, last_name = ? WHERE id = ?',
          [hashedPassword, recovery.first_name, recovery.last_name, user.id]
        );
      } else {
        const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        await tx.run(
          'INSERT INTO users (email, password, first_name, last_name, referral_code) VALUES (?, ?, ?, ?, ?)',
          [recovery.email, hashedPassword, recovery.first_name, recovery.last_name, referralCode]
        );
      }
      await tx.run(
        "UPDATE recovery_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [req.params.id]
      );
    });

    res.json({ success: true, message: 'Compte créé/restauré avec succès' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/recovery/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  try {
    const recovery = await db.get('SELECT * FROM recovery_requests WHERE id = ?', [req.params.id]);
    if (!recovery) return res.status(404).json({ error: 'Demande non trouvée' });
    if (recovery.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });
    await db.run(
      "UPDATE recovery_requests SET status = 'rejected', reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [reason || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN USERS ───────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.email, u.balance, u.deposit_amount, u.referral_code, u.created_at, u.can_withdraw,
        u.is_banned, u.last_login, u.registration_ip, u.last_login_ip,
        (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id) as referrals_count,
        (SELECT COALESCE(SUM(amount),0) FROM deposits WHERE user_id = u.id AND status = 'confirmed') as total_deposited,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE user_id = u.id AND status = 'confirmed') as total_withdrawn,
        (SELECT COUNT(*) FROM deposits WHERE user_id = u.id AND status = 'pending') as pending_deposits
      FROM users u
      ORDER BY u.created_at DESC
    `);
    res.json(users);
  } catch (err) {
    console.error('[admin/users] Erreur requête:', err.message);
    try {
      const users = await db.all(`SELECT id, email, balance, deposit_amount, referral_code, created_at FROM users ORDER BY created_at DESC`);
      const result = users.map(u => ({ ...u, can_withdraw: 0, is_banned: 0, last_login: null, registration_ip: null, last_login_ip: null, referrals_count: 0, total_deposited: 0, total_withdrawn: 0, pending_deposits: 0 }));
      res.json(result);
    } catch (err2) {
      console.error('[admin/users] Erreur fallback:', err2.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
});

app.post('/api/admin/users/:id/toggle-withdraw', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const user = await db.get('SELECT id, email, can_withdraw FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const newVal = user.can_withdraw ? 0 : 1;
    await db.run('UPDATE users SET can_withdraw = ? WHERE id = ?', [newVal, userId]);
    res.json({ success: true, can_withdraw: newVal, email: user.email });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/users/:id/adjust-balance', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { amount } = req.body;
  if (amount === undefined || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Montant invalide' });
  try {
    const user = await db.get('SELECT id, balance FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [parseFloat(amount), userId]);
    const updated = await db.get('SELECT balance FROM users WHERE id = ?', [userId]);
    res.json({ success: true, newBalance: updated.balance });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── ADMIN EMAIL LOGS ──────────────────────────────────────────────────────────

app.get('/api/admin/email-logs', requireAdmin, async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 500');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse email invalide' });
  const result = await sendEmail(
    to.trim(),
    '✅ Test email — QuestInvest fonctionne !',
    `<p>Bonjour,</p>
     <p>Ceci est un <strong>email de test</strong> envoyé depuis le panel admin de QuestInvest.</p>
     <p>Si vous recevez ce message, le système d'envoi d'emails est <span style="color:#22d3a8;"><strong>opérationnel</strong></span> sur cet environnement.</p>
     <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:16px 0;">
     <p style="font-size:.8rem;color:#5a5a7a;">Envoyé depuis : ${MAIL_USER}<br>Environnement : ${process.env.NODE_ENV || 'development'}</p>`,
    '✅ Test email'
  );
  if (!result.success) return res.status(500).json({ error: result.error || "Échec de l'envoi" });
  res.json({ success: true });
});

// ── ADMIN EMAIL SETTINGS ──────────────────────────────────────────────────────

app.get('/api/admin/email-settings', requireAdmin, (req, res) => {
  try {
    res.json({
      reminder_hour:    parseInt(getSetting('email_reminder_hour') || '9', 10),
      twofa_expiry:     parseInt(getSetting('email_twofa_expiry')  || '10', 10),
      all_disabled:     getSetting('email_all_disabled') === '1',
      toggles: {
        welcome:              getSetting('email_toggle_welcome')              !== '0',
        '2fa':                getSetting('email_toggle_2fa')                 !== '0',
        deposit_received:     getSetting('email_toggle_deposit_received')    !== '0',
        deposit_confirmed:    getSetting('email_toggle_deposit_confirmed')   !== '0',
        deposit_rejected:     getSetting('email_toggle_deposit_rejected')    !== '0',
        quest_completed:      getSetting('email_toggle_quest_completed')     !== '0',
        withdrawal_received:  getSetting('email_toggle_withdrawal_received') !== '0',
        withdrawal_confirmed: getSetting('email_toggle_withdrawal_confirmed')!== '0',
        withdrawal_rejected:  getSetting('email_toggle_withdrawal_rejected') !== '0',
        daily_reminder:       getSetting('email_toggle_daily_reminder')      !== '0',
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/email-settings', requireAdmin, async (req, res) => {
  try {
    const { reminder_hour, twofa_expiry, toggles, all_disabled } = req.body;
    if (reminder_hour !== undefined) {
      const h = parseInt(reminder_hour, 10);
      if (!isNaN(h) && h >= 0 && h <= 23) {
        await setSetting('email_reminder_hour', String(h));
        scheduleDailyReminder();
      }
    }
    if (twofa_expiry !== undefined) {
      const t = parseInt(twofa_expiry, 10);
      if (!isNaN(t) && t >= 1 && t <= 60) await setSetting('email_twofa_expiry', String(t));
    }
    if (all_disabled !== undefined) {
      await setSetting('email_all_disabled', all_disabled ? '1' : '0');
    }
    if (toggles && typeof toggles === 'object') {
      const allowed = ['welcome','2fa','deposit_received','deposit_confirmed','deposit_rejected',
                       'quest_completed','withdrawal_received','withdrawal_confirmed','withdrawal_rejected','daily_reminder'];
      for (const key of allowed) {
        if (key in toggles) await setSetting(`email_toggle_${key}`, toggles[key] ? '1' : '0');
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── MAINTENANCE ───────────────────────────────────────────────────────────────

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse email invalide.' });
  if (getSetting('email_all_disabled') === '1') {
    return res.status(400).json({ error: 'Les emails sont désactivés globalement. Réactivez-les d\'abord.' });
  }
  const result = await sendEmail(
    to,
    '✅ Test email QuestInvest',
    `<p>Bonjour,</p>
     <p>Ceci est un <strong>email de test</strong> envoyé depuis le panel admin de QuestInvest.</p>
     <p>Si vous recevez ce message, la configuration Gmail est correctement fonctionnelle.</p>
     <div class="amount">✅ Config OK</div>`,
    '✅ Test email'
  );
  if (result.success) {
    res.json({ success: true, message: `Email de test envoyé à ${to}` });
  } else {
    res.status(500).json({ error: `Échec de l'envoi : ${result.error}` });
  }
});

app.get('/api/maintenance', (req, res) => {
  res.json({ maintenance: getSetting('maintenance_mode') === '1' });
});

app.post('/api/admin/maintenance', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  await setSetting('maintenance_mode', enabled ? '1' : '0');
  res.json({ success: true, maintenance: !!enabled });
});

// ── BAN / UNBAN UTILISATEUR ────────────────────────────────────────────────────

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    const u = await db.get('SELECT id, email, is_banned FROM users WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const newBan = u.is_banned ? 0 : 1;
    await db.run('UPDATE users SET is_banned = ? WHERE id = ?', [newBan, u.id]);
    res.json({ success: true, is_banned: newBan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANTI-FRAUDE : IP BLOQUÉES ─────────────────────────────────────────────────

app.get('/api/admin/blocked-ips', requireAdmin, async (req, res) => {
  try {
    const ips = await db.all('SELECT * FROM blocked_ips ORDER BY blocked_at DESC');
    res.json(ips);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/block-ip', requireAdmin, async (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requise' });
  try {
    await db.run(
      'INSERT INTO blocked_ips (ip, reason) VALUES (?, ?) ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = CURRENT_TIMESTAMP',
      [ip.trim(), reason || 'Fraude suspectée']
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/blocked-ips/:id/unblock', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM blocked_ips WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bloquer l'IP d'un utilisateur en un clic
app.post('/api/admin/users/:id/block-ip', requireAdmin, async (req, res) => {
  try {
    const u = await db.get('SELECT id, email, registration_ip FROM users WHERE id = ?', [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (!u.registration_ip) return res.status(400).json({ error: 'Pas d\'IP enregistrée pour cet utilisateur' });
    await db.run(
      'INSERT INTO blocked_ips (ip, reason) VALUES (?, ?) ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = CURRENT_TIMESTAMP',
      [u.registration_ip, `Fraude — compte ${u.email}`]
    );
    res.json({ success: true, ip: u.registration_ip });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NEWS ─────────────────────────────────────────────────────────────────────

app.get('/api/news', async (req, res) => {
  try {
    const posts = await db.all("SELECT id, title, content, created_at FROM news_posts WHERE is_published = 1 ORDER BY created_at DESC LIMIT 20");
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/news', requireAdmin, async (req, res) => {
  try {
    const posts = await db.all("SELECT * FROM news_posts ORDER BY created_at DESC");
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/news', requireAdmin, async (req, res) => {
  const { title, content, is_published } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Titre et contenu requis' });
  try {
    const r = await db.run('INSERT INTO news_posts (title, content, is_published) VALUES (?, ?, ?)',
      [title.trim(), content.trim(), is_published !== false ? 1 : 0]);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/news/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const p = await db.get('SELECT is_published FROM news_posts WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Publication introuvable' });
    await db.run('UPDATE news_posts SET is_published = ? WHERE id = ?', [p.is_published ? 0 : 1, req.params.id]);
    res.json({ success: true, is_published: !p.is_published });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/news/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM news_posts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TÉMOIGNAGES ───────────────────────────────────────────────────────────────

app.get('/api/testimonials', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT t.id, t.content, t.rating, t.submitted_at, u.email
      FROM testimonials t JOIN users u ON u.id = t.user_id
      WHERE t.status = 'approved' ORDER BY t.submitted_at DESC LIMIT 20`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/testimonials', requireAuth, async (req, res) => {
  const { content, rating } = req.body;
  if (!content || content.trim().length < 10) return res.status(400).json({ error: 'Avis trop court (minimum 10 caractères)' });
  try {
    const existing = await db.get("SELECT id FROM testimonials WHERE user_id = ? AND status IN ('pending','approved')", [req.session.userId]);
    if (existing) return res.status(400).json({ error: 'Vous avez déjà soumis un avis' });
    await db.run('INSERT INTO testimonials (user_id, content, rating) VALUES (?, ?, ?)',
      [req.session.userId, content.trim(), Math.min(5, Math.max(1, parseInt(rating) || 5))]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/testimonials', requireAdmin, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT t.*, u.email as user_email FROM testimonials t
      JOIN users u ON u.id = t.user_id ORDER BY t.submitted_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/testimonials/:id/approve', requireAdmin, async (req, res) => {
  try {
    await db.run("UPDATE testimonials SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/testimonials/:id/reject', requireAdmin, async (req, res) => {
  try {
    await db.run("UPDATE testimonials SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RELEVÉ PDF ────────────────────────────────────────────────────────────────

app.get('/api/statement.pdf', requireAuth, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    const deposits = await db.all("SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC", [req.session.userId]);
    const withdrawals = await db.all("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC", [req.session.userId]);
    const quests = await db.all(`
      SELECT uq.completed_date, uq.reward_earned, q.title
      FROM user_quests uq JOIN quests q ON q.id = uq.quest_id
      WHERE uq.user_id = ? ORDER BY uq.completed_date DESC`, [req.session.userId]);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="releve-questinvest-${user.email}.pdf"`);
    doc.pipe(res);

    const purple = '#7c3aed';
    doc.rect(0, 0, doc.page.width, 80).fill(purple);
    doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('QuestInvest', 50, 25);
    doc.fontSize(10).font('Helvetica').text('Relevé de compte', 50, 52);
    doc.fillColor('#333').moveDown(3);

    doc.fontSize(12).font('Helvetica-Bold').fillColor(purple).text('Informations du compte', 50, 100);
    doc.moveTo(50, 116).lineTo(545, 116).strokeColor(purple).stroke();
    doc.fillColor('#333').font('Helvetica').fontSize(10);
    doc.text(`Email : ${user.email}`, 50, 125);
    doc.text(`Solde actuel : $${parseFloat(user.balance).toFixed(2)}`, 50, 142);
    doc.text(`Total déposé : $${parseFloat(user.deposit_amount).toFixed(2)}`, 50, 159);
    doc.text(`Relevé généré le : ${new Date().toLocaleDateString('fr-FR')}`, 50, 176);

    const drawTable = (title, headers, rows, yStart) => {
      doc.fontSize(12).font('Helvetica-Bold').fillColor(purple).text(title, 50, yStart);
      doc.moveTo(50, yStart + 16).lineTo(545, yStart + 16).strokeColor(purple).stroke();
      let y = yStart + 22;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#555');
      const colW = Math.floor(495 / headers.length);
      headers.forEach((h, i) => doc.text(h, 50 + i * colW, y, { width: colW }));
      y += 14;
      doc.font('Helvetica').fillColor('#333');
      if (!rows.length) { doc.text('Aucune transaction', 50, y); return y + 20; }
      rows.forEach((r, ri) => {
        if (ri % 2 === 0) doc.rect(50, y - 3, 495, 16).fill('#f5f3ff').fillColor('#333');
        r.forEach((cell, i) => doc.text(String(cell), 52 + i * colW, y, { width: colW - 4 }));
        y += 16;
      });
      return y + 10;
    };

    let y = 205;
    y = drawTable('Dépôts', ['Date', 'Montant', 'Statut', 'Hash TX'],
      deposits.map(d => [
        new Date(d.created_at).toLocaleDateString('fr-FR'),
        `$${parseFloat(d.amount).toFixed(2)}`,
        d.status,
        (d.tx_hash || '—').substring(0, 20) + (d.tx_hash && d.tx_hash.length > 20 ? '…' : '')
      ]), y);

    if (y > 650) { doc.addPage(); y = 50; }
    y = drawTable('Retraits', ['Date', 'Montant', 'Statut'],
      withdrawals.map(w => [
        new Date(w.created_at).toLocaleDateString('fr-FR'),
        `$${parseFloat(w.amount).toFixed(2)}`,
        w.status
      ]), y + 10);

    if (y > 650) { doc.addPage(); y = 50; }
    drawTable('Récompenses (quêtes)', ['Date', 'Quête', 'Récompense'],
      quests.map(q => [
        new Date(q.completed_date).toLocaleDateString('fr-FR'),
        (q.title || '').substring(0, 30),
        `$${parseFloat(q.reward_earned).toFixed(2)}`
      ]), y + 10);

    doc.end();
  } catch (e) {
    console.error('PDF error:', e);
    res.status(500).json({ error: 'Erreur génération PDF' });
  }
});

// ── ADMIN SETTINGS ────────────────────────────────────────────────────────────

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    res.json({ deposit_address: getDepositAddress() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const { deposit_address } = req.body;
  if (!deposit_address || deposit_address.trim().length < 10) return res.status(400).json({ error: 'Adresse invalide (minimum 10 caractères)' });
  try {
    await setSetting('deposit_address', deposit_address.trim());
    res.json({ success: true, deposit_address: deposit_address.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── SUPPORT TICKETS ───────────────────────────────────────────────────────────

app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const tickets = await db.all(
      'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC',
      [req.session.userId]
    );
    for (const t of tickets) {
      t.replies = await db.all(
        'SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC',
        [t.id]
      );
    }
    res.json(tickets);
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/tickets', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis' });
  try {
    const existing = await db.get(
      "SELECT * FROM support_tickets WHERE user_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1",
      [req.session.userId]
    );
    if (existing) {
      await db.run('INSERT INTO ticket_replies (ticket_id, sender, message) VALUES (?, ?, ?)',
        [existing.id, 'user', message.trim()]);
      await db.run("UPDATE support_tickets SET status = 'open' WHERE id = ?", [existing.id]);
      res.json({ success: true, id: existing.id });
    } else {
      const r = await db.run(
        'INSERT INTO support_tickets (user_id, subject, message) VALUES (?, ?, ?)',
        [req.session.userId, 'Support', message.trim()]
      );
      res.json({ success: true, id: r.lastInsertRowid });
    }
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/tickets/:id/reply', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  try {
    const ticket = await db.get(
      'SELECT * FROM support_tickets WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.userId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
    await db.run(
      'INSERT INTO ticket_replies (ticket_id, sender, message) VALUES (?, ?, ?)',
      [req.params.id, 'user', message.trim()]
    );
    await db.run("UPDATE support_tickets SET status = 'open' WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── ADMIN TICKETS ─────────────────────────────────────────────────────────────

app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  try {
    const tickets = await db.all(`
      SELECT t.*, u.email as user_email
      FROM support_tickets t
      JOIN users u ON u.id = t.user_id
      WHERE t.id IN (
        SELECT MAX(id) FROM support_tickets GROUP BY user_id
      )
      ORDER BY t.created_at DESC
    `);
    for (const t of tickets) {
      t.replies = await db.all(
        'SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC',
        [t.id]
      );
    }
    res.json(tickets);
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tickets/:id/reply', requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  try {
    await db.run(
      'INSERT INTO ticket_replies (ticket_id, sender, message) VALUES (?, ?, ?)',
      [req.params.id, 'admin', message.trim()]
    );
    await db.run("UPDATE support_tickets SET status = 'answered' WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tickets/:id/close', requireAdmin, async (req, res) => {
  try {
    await db.run("UPDATE support_tickets SET status = 'closed' WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PARRAINAGE ────────────────────────────────────────────────────────────────

app.get('/api/referrals', requireAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT referral_code FROM users WHERE id = ?', [req.session.userId]);
    const referrals = await db.all(`
      SELECT u.email, u.deposit_amount, u.created_at, r.bonus_paid, r.bonus_amount
      FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `, [req.session.userId]);
    const totalBonus = referrals.reduce((sum, r) => sum + (r.bonus_paid ? parseFloat(r.bonus_amount) : 0), 0);
    res.json({ referral_code: user.referral_code, referrals, total_bonus: parseFloat(totalBonus.toFixed(2)) });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Données invalides' });
  try {
    await db.run(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth',
      [req.session.userId, endpoint, p256dh, auth]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  try {
    await db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.session.userId, endpoint]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── STATIC ROUTES ─────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── QUEST REMINDERS ───────────────────────────────────────────────────────────

async function sendQuestReminders() {
  try {
    const period = getQuestPeriod();
    const users = await db.all(`
      SELECT u.id, u.email, u.deposit_amount,
        (SELECT COUNT(*) FROM quests WHERE quest_type = 'regular') as total_regular,
        (SELECT COUNT(DISTINCT uq.quest_id)
          FROM user_quests uq
          JOIN quests q ON q.id = uq.quest_id
          WHERE uq.user_id = u.id AND uq.completed_date BETWEEN ? AND ? AND q.quest_type = 'regular'
        ) as completed_regular
      FROM users u
      WHERE u.deposit_amount >= ?
    `, [period.startDate, period.endDate, MIN_DEPOSIT]);

    for (const u of users) {
      const remaining = u.total_regular - u.completed_regular;
      if (remaining > 0) {
        const reward = (parseFloat(u.deposit_amount) * 40 / 100) * remaining;
        sendEmailIfEnabled('daily_reminder', u.email, '⚡ Rappel — Vos quêtes vous attendent !',
          `<p>Bonjour,</p>
           <p>Vous avez encore <strong>${remaining} quête${remaining > 1 ? 's' : ''}</strong> disponible${remaining > 1 ? 's' : ''} ce cycle. Ne laissez pas vos récompenses expirer !</p>
           <div class="amount">+$${reward.toFixed(2)} à gagner</div>
           <p><span class="badge">📅 Cycle se termine le ${new Date(period.endDate).toLocaleDateString('fr-FR')}</span></p>
           <hr class="divider">
           <p>Connectez-vous maintenant et complétez vos quêtes — cela ne prend que quelques minutes.</p>`,
          '⚡ Rappel quêtes disponibles'
        );
      }
    }
    console.log(`[reminder] Sent quest reminders (${users.length} users checked)`);
  } catch (err) {
    console.error('[reminder] Error sending reminders:', err.message);
  }
}

// ── RAPPELS RETRAIT & COMPTES INACTIFS ───────────────────────────────────────

async function sendWithdrawalReminders() {
  try {
    const days = parseInt(getSetting('withdrawal_reminder_days') || '7', 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const users = await db.all(`
      SELECT u.id, u.email, u.balance FROM users u
      WHERE u.balance > 0 AND u.is_banned = 0
        AND (
          (SELECT MAX(w.created_at) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('pending','confirmed')) IS NULL
          OR (SELECT MAX(w.created_at) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('pending','confirmed')) < ?
        )
    `, [cutoff]);
    for (const u of users) {
      sendEmailIfEnabled('withdrawal_reminder', u.email, '💰 Votre solde vous attend — Pensez à retirer vos gains !',
        `<p>Bonjour,</p>
         <p>Vous avez un solde disponible de <strong style="color:#22d3a8">$${parseFloat(u.balance).toFixed(2)}</strong> sur votre compte QuestInvest que vous n'avez pas encore retiré.</p>
         <div class="amount">$${parseFloat(u.balance).toFixed(2)} disponibles</div>
         <p>Connectez-vous pour effectuer votre retrait en quelques clics !</p>`,
        '💰 Solde disponible'
      );
    }
    if (users.length) console.log(`[reminder] ${users.length} rappels de retrait envoyés`);
  } catch (e) {
    console.error('[reminder] Withdrawal reminders error:', e.message);
  }
}

async function sendInactiveAccountReminders() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const users = await db.all(`
      SELECT u.id, u.email FROM users u
      WHERE u.is_banned = 0
        AND (u.last_login IS NULL OR u.last_login < ?)
        AND NOT EXISTS (
          SELECT 1 FROM email_logs el
          WHERE el.recipient = u.email AND el.subject LIKE '%inactif%'
          AND el.sent_at > ?
        )
    `, [cutoff, cutoff]);
    for (const u of users) {
      sendEmailIfEnabled('inactive_reminder', u.email, '👋 Vous nous manquez ! Revenez sur QuestInvest',
        `<p>Bonjour,</p>
         <p>Cela fait plus de 30 jours que vous ne vous êtes pas connecté à QuestInvest.</p>
         <p>Vos quêtes vous attendent et de nouvelles opportunités de gains sont disponibles !</p>
         <p style="margin-top:20px;"><a href="${process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '')}" style="background:#7c3aed;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Revenir sur QuestInvest →</a></p>`,
        '👋 On vous attend'
      );
    }
    if (users.length) console.log(`[reminder] ${users.length} rappels d'inactivité envoyés`);
  } catch (e) {
    console.error('[reminder] Inactive reminders error:', e.message);
  }
}

let _reminderTimeout = null;
function scheduleDailyReminder() {
  if (_reminderTimeout) clearTimeout(_reminderTimeout);
  const hour = Math.max(0, Math.min(23, parseInt(getSetting('email_reminder_hour') || '9', 10)));
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(hour, 0, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const delay = nextRun - now;
  _reminderTimeout = setTimeout(() => {
    sendQuestReminders();
    sendWithdrawalReminders();
    sendInactiveAccountReminders();
    scheduleDailyReminder();
  }, delay);
  console.log(`[reminder] Rappels quêtes programmés à ${String(hour).padStart(2, '0')}:00 UTC (dans ${Math.round(delay / 60000)} min)`);
}

// ── AUTO-PING (empêche Render de mettre le serveur en veille) ─────────────────
function startAutoPing() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  if (!selfUrl) {
    console.log('[ping] Pas de RENDER_EXTERNAL_URL ni APP_URL — auto-ping désactivé');
    return;
  }
  const target = selfUrl.replace(/\/$/, '') + '/health';
  const INTERVAL = 9 * 60 * 1000; // toutes les 9 minutes
  setInterval(async () => {
    try {
      const https = require('https');
      const http = require('http');
      const lib = target.startsWith('https') ? https : http;
      await new Promise((resolve, reject) => {
        const req = lib.get(target, { timeout: 10000 }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      console.log(`[ping] ✓ self-ping OK → ${target}`);
    } catch (e) {
      console.warn(`[ping] ✗ self-ping échoué : ${e.message}`);
    }
  }, INTERVAL);
  console.log(`[ping] Auto-ping activé — cible : ${target} (toutes les 9 min)`);
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────

initDB().then(() => {
  (function logEmailConfig() {
    const vars = { MAIL_USER, GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN };
    const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length === 0) {
      console.log('[mail] OAuth2 config OK — toutes les variables sont définies');
    } else {
      console.warn(`[mail] ATTENTION — variables manquantes : ${missing.join(', ')}`);
    }
  })();

  scheduleDailyReminder();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    startAutoPing();
  });
}).catch(err => {
  console.error('FATAL: initDB failed:', err);
  process.exit(1);
});

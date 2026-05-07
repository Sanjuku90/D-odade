const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

function getTransporter() {
  const user = process.env.MAIL_USER || '';
  const clientId = process.env.GMAIL_CLIENT_ID || '';
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || '';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || '';

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,
    auth: {
      type: 'OAuth2',
      user,
      clientId,
      clientSecret,
      refreshToken
    }
  });
}

function emailBase(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{margin:0;padding:0;background:#0a0a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f0f0fa;}
    .wrap{max-width:560px;margin:40px auto;background:#111120;border-radius:16px;overflow:hidden;border:1px solid rgba(167,139,250,0.2);}
    .header{background:linear-gradient(135deg,#7c3aed,#a78bfa);padding:32px 36px;text-align:center;}
    .logo{font-size:1.5rem;font-weight:800;color:#fff;letter-spacing:-0.5px;}
    .body{padding:32px 36px;}
    h2{margin:0 0 8px;font-size:1.2rem;color:#f0f0fa;}
    p{margin:0 0 16px;color:#9898b8;line-height:1.6;font-size:0.92rem;}
    .amount{font-size:1.8rem;font-weight:700;color:#a78bfa;margin:16px 0;}
    .badge{display:inline-block;background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.3);border-radius:8px;padding:6px 14px;font-size:0.85rem;color:#a78bfa;font-weight:600;margin:8px 0;}
    .code-box{background:#0a0a12;border:2px solid rgba(167,139,250,0.4);border-radius:12px;padding:20px;text-align:center;margin:20px 0;letter-spacing:10px;font-size:2.2rem;font-weight:800;color:#a78bfa;font-family:monospace;}
    .btn{display:inline-block;background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;text-decoration:none;border-radius:10px;padding:12px 28px;font-weight:600;font-size:0.92rem;margin:8px 0;}
    .divider{border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;}
    .footer{background:#0d0d1a;padding:20px 36px;text-align:center;font-size:0.75rem;color:#5a5a7a;}
    .green{color:#22d3a8;} .red{color:#f87171;} .yellow{color:#fbbf24;}
  </style></head><body>
  <div class="wrap">
    <div class="header"><div class="logo">⚡ QuestInvest</div></div>
    <div class="body">
      <h2>${title}</h2>
      ${bodyHtml}
    </div>
    <div class="footer">© 2026 QuestInvest · Ne pas répondre à cet email · <a href="#" style="color:#5a5a7a;">Se désabonner</a></div>
  </div>
</body></html>`;
}

async function sendEmail(to, subject, bodyHtml, title) {
  const mailUser = MAIL_USER || process.env.MAIL_USER || '';
  let status = 'sent', errorMsg = null;

  if (!mailUser || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    errorMsg = 'Configuration OAuth2 incomplète — vérifiez MAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN';
    console.error(`[mail] ${errorMsg}`);
    status = 'failed';
    try { db.prepare('INSERT INTO email_logs (recipient, subject, status, error_message) VALUES (?, ?, ?, ?)').run(to, subject, status, errorMsg); } catch (_) {}
    return { success: false, error: errorMsg };
  }

  try {
    await getTransporter().sendMail({
      from: `"QuestInvest" <${mailUser}>`,
      to,
      subject,
      html: emailBase(title || subject, bodyHtml)
    });
    console.log(`[mail] Sent "${subject}" → ${to}`);
  } catch (err) {
    status = 'failed';
    errorMsg = err.message;
    console.error(`[mail] Failed to send "${subject}" → ${to}: [${err.code || err.responseCode || 'ERR'}] ${err.message}`);
  }
  try {
    db.prepare(
      'INSERT INTO email_logs (recipient, subject, status, error_message) VALUES (?, ?, ?, ?)'
    ).run(to, subject, status, errorMsg);
  } catch (_) {}
  return { success: status === 'sent', error: errorMsg };
}

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

const dbPath = process.env.DATABASE_PATH || 'questinvest.db';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);

function getPersistentConfigPath(name) {
  const baseDir = process.env.DATABASE_PATH
    ? path.dirname(path.resolve(process.env.DATABASE_PATH))
    : path.join(__dirname, '.data');

  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, `${name}.txt`);
}

function getOrCreatePersistentSecret(name, generator) {
  if (process.env[name]) {
    return process.env[name];
  }

  if (!isProduction) {
    return generator();
  }

  const secretPath = getPersistentConfigPath(name);

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const value = generator();
  fs.writeFileSync(secretPath, value, { mode: 0o600 });
  console.warn(`${name} was not provided; generated a persistent value at ${secretPath}`);
  return value;
}

const SESSION_SECRET = getOrCreatePersistentSecret('SESSION_SECRET', () => crypto.randomBytes(32).toString('hex'));
const MAIL_USER = process.env.MAIL_USER || '';
const DEFAULT_DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'TYyUwQELkUW957jE7Svt42LSaeQWneWtQG';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@questinvest.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? getOrCreatePersistentSecret('ADMIN_PASSWORD', () => crypto.randomBytes(24).toString('base64url')) : 'admin123');
const ADMIN_ACCESS_CODE = '1289';
const MIN_DEPOSIT = 55;

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function getDepositAddress() {
  return getSetting('deposit_address') || DEFAULT_DEPOSIT_ADDRESS;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Store de sessions SQLite — survit aux redémarrages/redéploiements
class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    setInterval(() => {
      try { this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now()); } catch (_) {}
    }, 15 * 60 * 1000);
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expired < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expired = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 30 * 24 * 60 * 60 * 1000;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
}

app.use(session({
  store: new SqliteSessionStore(db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax'
  }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      balance REAL DEFAULT 0,
      deposit_amount REAL DEFAULT 0,
      deposit_address TEXT,
      referral_code TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      amount REAL NOT NULL,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      reward_percentage REAL DEFAULT 40
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      quest_id INTEGER REFERENCES quests(id),
      completed_date DATE,
      reward_earned REAL DEFAULT 0,
      UNIQUE(user_id, quest_id, completed_date)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER REFERENCES users(id),
      referred_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(referred_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      amount REAL NOT NULL,
      address TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS kyc_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      document_front TEXT NOT NULL,
      document_back TEXT,
      status TEXT DEFAULT 'pending',
      reject_reason TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      UNIQUE(user_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      old_password TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      reject_reason TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try { db.exec(`ALTER TABLE users ADD COLUMN can_withdraw INTEGER DEFAULT 0`); } catch(e) {}
  try { db.exec(`ALTER TABLE quests ADD COLUMN quest_type TEXT DEFAULT 'regular'`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE recovery_requests DROP COLUMN document_front`); } catch(e) {}
  try { db.exec(`ALTER TABLE recovery_requests DROP COLUMN document_back`); } catch(e) {}

  const settingsCount = db.prepare("SELECT COUNT(*) as count FROM settings WHERE key = 'deposit_address'").get();
  if (settingsCount.count === 0) {
    setSetting('deposit_address', DEFAULT_DEPOSIT_ADDRESS);
  }

  const regularQuestCount = db.prepare("SELECT COUNT(*) as count FROM quests WHERE quest_type = 'regular' OR quest_type IS NULL").get();
  if (regularQuestCount.count === 0) {
    const insertQuest = db.prepare("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'regular')");
    insertQuest.run('Partager sur les réseaux', 'Partagez notre plateforme sur vos réseaux sociaux', 40);
    insertQuest.run('Regarder une vidéo', 'Regardez une vidéo promotionnelle de 30 secondes', 40);
    insertQuest.run('Visiter notre partenaire', 'Visitez le site de notre partenaire pour découvrir de nouvelles opportunités', 40);
  }

  const newcomerQuestCount = db.prepare("SELECT COUNT(*) as count FROM quests WHERE quest_type = 'newcomer'").get();
  if (newcomerQuestCount.count === 0) {
    const insertNewcomer = db.prepare("INSERT INTO quests (title, description, reward_percentage, quest_type) VALUES (?, ?, ?, 'newcomer')");
    insertNewcomer.run('Bienvenue : Présentez-vous', 'Complétez votre profil et découvrez la plateforme', 20);
    insertNewcomer.run('Bienvenue : Partage social', 'Partagez QuestInvest avec vos amis sur les réseaux sociaux', 20);
    insertNewcomer.run('Bienvenue : Tutoriel', 'Suivez le tutoriel d\'utilisation de QuestInvest', 20);
    insertNewcomer.run('Bienvenue : Vidéo de présentation', 'Regardez la vidéo de présentation de la plateforme', 20);
  }

  db.prepare("UPDATE quests SET reward_percentage = 40 WHERE quest_type = 'regular' OR quest_type IS NULL").run();
  db.prepare("UPDATE quests SET reward_percentage = 20 WHERE quest_type = 'newcomer'").run();

  const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get();
  if (adminCount.count === 0) {
    const hashedAdminPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO admins (email, password) VALUES (?, ?)').run(ADMIN_EMAIL, hashedAdminPassword);
  }

  console.log('Database initialized successfully');
}

function generateDepositAddress() {
  const chars = '0123456789abcdef';
  let address = '0x';
  for (let i = 0; i < 40; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return address;
}

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getQuestPeriod() {
  const periodLengthDays = 14;
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const startAnchor = Date.UTC(2024, 0, 1);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceAnchor = Math.floor((todayUtc - startAnchor) / millisecondsPerDay);
  const periodIndex = Math.floor(daysSinceAnchor / periodLengthDays);
  const startUtc = startAnchor + periodIndex * periodLengthDays * millisecondsPerDay;
  const endUtc = startUtc + (periodLengthDays - 1) * millisecondsPerDay;

  return {
    startDate: new Date(startUtc).toISOString().split('T')[0],
    endDate: new Date(endUtc).toISOString().split('T')[0],
    lengthDays: periodLengthDays
  };
}

const NEW_USER_PERIOD_DAYS = 14;

function getNewUserStatus(user) {
  if (!user || !user.created_at) {
    return { isNew: false, startDate: null, endDate: null, lengthDays: NEW_USER_PERIOD_DAYS };
  }
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const createdAt = new Date(user.created_at);
  const createdUtc = Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate());
  const startDate = new Date(createdUtc).toISOString().split('T')[0];
  const endDate = new Date(createdUtc + (NEW_USER_PERIOD_DAYS - 1) * millisecondsPerDay).toISOString().split('T')[0];
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((todayUtc - createdUtc) / millisecondsPerDay);
  return {
    isNew: ageDays < NEW_USER_PERIOD_DAYS,
    startDate,
    endDate,
    lengthDays: NEW_USER_PERIOD_DAYS
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Accès non autorisé' });
  }
  next();
}

app.post('/api/register', async (req, res) => {
  const { email, password, referral_code, first_name, last_name } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const depositAddress = generateDepositAddress();
    const userReferralCode = generateReferralCode();
    
    // Check if user already exists
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Cet email existe déjà' });
    }

    const result = db.prepare(
      'INSERT INTO users (email, password, deposit_address, referral_code, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(email, hashedPassword, depositAddress, userReferralCode, first_name || '', last_name || '');

    if (referral_code && referral_code.trim()) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code.trim().toUpperCase());
      
      if (referrer) {
        db.prepare('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)').run(referrer.id, result.lastInsertRowid);
      }
    }

    req.session.userId = result.lastInsertRowid;
    // Explicitly save the session
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      }
      res.json({ success: true, user: { email } });
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 10 * 60 * 1000;

    req.session.pending2fa = { userId: user.id, code, expires };

    const maskedEmail = user.email.replace(/(.{2}).+(@.+)/, '$1***$2');

    req.session.save(async (err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      }

      sendEmail(user.email, '🔐 Votre code de vérification QuestInvest',
        `<p>Bonjour,</p>
         <p>Voici votre code de connexion à 6 chiffres. Il est valable <strong>10 minutes</strong>.</p>
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

app.post('/api/verify-2fa', (req, res) => {
  const { code } = req.body;
  const pending = req.session.pending2fa;

  if (!pending) {
    return res.status(400).json({ error: 'Aucune session 2FA en cours. Veuillez vous reconnecter.' });
  }

  if (Date.now() > pending.expires) {
    req.session.pending2fa = null;
    return res.status(400).json({ error: 'Code expiré. Veuillez vous reconnecter.' });
  }

  if (String(code).trim() !== String(pending.code)) {
    return res.status(401).json({ error: 'Code incorrect. Vérifiez votre email.' });
  }

  req.session.userId = pending.userId;
  req.session.pending2fa = null;

  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Erreur lors de la création de la session' });
    }
    res.json({ success: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/user', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, balance, deposit_amount, created_at, referral_code FROM users WHERE id = ?').get(req.session.userId);
    user.deposit_address = getDepositAddress();

    const kycRow = db.prepare('SELECT status FROM kyc_submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 1').get(req.session.userId);
    user.kyc_status = kycRow ? kycRow.status : null;

    const referralsCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(req.session.userId);
    user.referrals_count = referralsCount.count;

    const withdrawnRow = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE user_id = ? AND status != 'rejected'").get(req.session.userId);
    user.total_withdrawn = withdrawnRow.total;

    const firstDeposit = db.prepare("SELECT created_at FROM deposits WHERE user_id = ? AND status = 'confirmed' ORDER BY created_at ASC LIMIT 1").get(req.session.userId);
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

  if (!new_email || !current_password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const validPassword = await bcrypt.compare(current_password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(new_email, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Cet email existe deja' });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/user/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Mots de passe requis' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit avoir au moins 6 caracteres' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const validPassword = await bcrypt.compare(current_password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/deposit', requireAuth, (req, res) => {
  const { amount, tx_hash } = req.body;

  if (!amount || parseFloat(amount) < MIN_DEPOSIT) {
    return res.status(400).json({ error: `Le dépôt minimum est de ${MIN_DEPOSIT}$` });
  }

  if (!tx_hash || tx_hash.trim().length < 10) {
    return res.status(400).json({ error: 'Hash de transaction requis' });
  }

  try {
    db.prepare('INSERT INTO deposits (user_id, amount, tx_hash, status) VALUES (?, ?, ?, ?)').run(req.session.userId, amount, tx_hash.trim(), 'pending');

    const depUser = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    sendEmail(depUser.email, '📥 Dépôt reçu — En attente de validation',
      `<p>Bonjour,</p>
       <p>Nous avons bien reçu votre demande de dépôt. Notre équipe va la vérifier sous 24h.</p>
       <div class="amount">$${parseFloat(amount).toFixed(2)}</div>
       <p><span class="badge">⏳ En attente de validation</span></p>
       <hr class="divider">
       <p style="font-size:.8rem;">Hash de transaction : <code style="color:#a78bfa;">${tx_hash.trim()}</code></p>
       <p>Vous recevrez un email de confirmation dès que votre dépôt sera validé.</p>`,
      '📥 Dépôt reçu'
    );

    res.json({ success: true, message: 'Transaction soumise, en attente de validation par l\'admin' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/quests', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(req.session.userId);
    const newUserStatus = getNewUserStatus(user);
    const isNewcomer = newUserStatus.isNew;

    const period = isNewcomer
      ? { startDate: newUserStatus.startDate, endDate: newUserStatus.endDate, lengthDays: newUserStatus.lengthDays }
      : getQuestPeriod();

    const questType = isNewcomer ? 'newcomer' : 'regular';

    const quests = db.prepare(`
      SELECT q.*, 
        CASE WHEN uq.id IS NOT NULL THEN 1 ELSE 0 END as completed
      FROM quests q
      LEFT JOIN user_quests uq ON q.id = uq.quest_id
        AND uq.user_id = ? 
        AND uq.completed_date BETWEEN ? AND ?
      WHERE COALESCE(q.quest_type, 'regular') = ?
      GROUP BY q.id
      ORDER BY q.id
    `).all(req.session.userId, period.startDate, period.endDate, questType);

    const completedCount = db.prepare(`
      SELECT COUNT(DISTINCT uq.quest_id) as count
      FROM user_quests uq
      JOIN quests q ON q.id = uq.quest_id
      WHERE uq.user_id = ?
        AND uq.completed_date BETWEEN ? AND ?
        AND COALESCE(q.quest_type, 'regular') = ?
    `).get(req.session.userId, period.startDate, period.endDate, questType);

    const referralsCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(req.session.userId);

    const questsWithStatus = quests.map((quest) => ({
      ...quest,
      completed: !!quest.completed,
      locked: false,
      lockReason: ''
    }));

    const totalQuests = quests.length;
    const totalRewardPercentage = quests.reduce((sum, q) => sum + parseFloat(q.reward_percentage || 0), 0);

    res.json({
      quests: questsWithStatus,
      completedToday: completedCount.count,
      completedThisPeriod: completedCount.count,
      totalQuests,
      totalRewardPercentage,
      resetPeriodStart: period.startDate,
      resetPeriodEnd: period.endDate,
      resetPeriodDays: period.lengthDays,
      referralsCount: referralsCount.count,
      isNewUser: isNewcomer,
      newUserPeriodEnd: newUserStatus.endDate
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/quests/:id/complete', requireAuth, (req, res) => {
  const questId = parseInt(req.params.id);

  try {
    const user = db.prepare('SELECT deposit_amount, created_at FROM users WHERE id = ?').get(req.session.userId);

    if (parseFloat(user.deposit_amount) < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Vous devez avoir un dépôt minimum de ${MIN_DEPOSIT}$ pour compléter les quêtes` });
    }

    const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
    if (!quest) {
      return res.status(404).json({ error: 'Quête non trouvée' });
    }

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

    const existing = db.prepare('SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ? AND completed_date BETWEEN ? AND ?').get(req.session.userId, questId, period.startDate, period.endDate);

    if (existing) {
      return res.status(400).json({ error: 'Quête déjà complétée pour cette période de 2 semaines' });
    }

    const depositAmount = parseFloat(user.deposit_amount);
    const rewardPercentage = parseFloat(quest.reward_percentage);
    const reward = (depositAmount * rewardPercentage) / 100;

    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO user_quests (user_id, quest_id, completed_date, reward_earned) VALUES (?, ?, ?, ?)').run(req.session.userId, questId, period.startDate, reward);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(reward, req.session.userId);
    });

    transaction();

    const updatedUser = db.prepare('SELECT email, balance FROM users WHERE id = ?').get(req.session.userId);

    sendEmail(updatedUser.email, '🎯 Quête complétée — Récompense créditée !',
      `<p>Bravo ! Vous venez de compléter une quête et votre récompense a été créditée instantanément.</p>
       <div class="amount">+$${reward.toFixed(2)}</div>
       <p><span class="badge">✓ ${quest.title}</span></p>
       <hr class="divider">
       <p>Votre nouveau solde disponible : <strong style="color:#a78bfa;">$${updatedUser.balance.toFixed(2)}</strong></p>
       <p>Continuez à compléter vos quêtes pour maximiser vos gains ce cycle !</p>`,
      '🎯 Quête complétée'
    );

    res.json({ 
      success: true, 
      reward: reward,
      newBalance: updatedUser.balance
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/history', requireAuth, (req, res) => {
  try {
    const deposits = db.prepare('SELECT amount, status, tx_hash, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(req.session.userId);
    const withdrawals = db.prepare('SELECT amount, status, address, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(req.session.userId);

    const questRewards = db.prepare(`
      SELECT uq.reward_earned, uq.completed_date, q.title 
      FROM user_quests uq 
      JOIN quests q ON uq.quest_id = q.id 
      WHERE uq.user_id = ? 
      ORDER BY uq.completed_date DESC LIMIT 10
    `).all(req.session.userId);

    res.json({
      deposits,
      withdrawals,
      questRewards
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/deposits', requireAuth, (req, res) => {
  try {
    const deposits = db.prepare('SELECT amount, status, tx_hash, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.session.userId);
    res.json({ deposits });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/withdraw', requireAuth, (req, res) => {
  const { amount, address } = req.body;
  const minWithdraw = 50;
  const maxWithdraw = 300;
  const questPeriod = getQuestPeriod();

  if (!amount || parseFloat(amount) < minWithdraw) {
    return res.status(400).json({ error: `Le retrait minimum est de ${minWithdraw}$` });
  }

  if (parseFloat(amount) > maxWithdraw) {
    return res.status(400).json({ error: `Le retrait maximum est de ${maxWithdraw}$` });
  }

  if (!address || address.trim().length < 10) {
    return res.status(400).json({ error: 'Adresse de retrait invalide' });
  }

  try {
    const withdrawUser = db.prepare('SELECT can_withdraw FROM users WHERE id = ?').get(req.session.userId);
    if (!withdrawUser || !withdrawUser.can_withdraw) {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      return res.status(400).json({ error: `Votre retrait sera disponible demain le ${tomorrowStr}. Merci de revenir à cette date.` });
    }

    const firstDeposit = db.prepare("SELECT created_at FROM deposits WHERE user_id = ? AND status = 'confirmed' ORDER BY created_at ASC LIMIT 1").get(req.session.userId);
    if (!firstDeposit) {
      return res.status(400).json({ error: 'Aucun dépôt confirmé. Vous devez d\'abord effectuer un dépôt.' });
    }

    const existingWithdrawal = db.prepare(`
      SELECT id, created_at
      FROM withdrawals
      WHERE user_id = ?
        AND DATE(created_at) BETWEEN ? AND ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(req.session.userId, questPeriod.startDate, questPeriod.endDate);

    if (existingWithdrawal) {
      return res.status(400).json({
        error: `Vous avez déjà demandé un retrait pour ce cycle de 2 semaines. Prochain retrait disponible après le ${questPeriod.endDate}.`
      });
    }

    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.session.userId);
    if (user.balance < parseFloat(amount)) {
      return res.status(400).json({ error: 'Solde insuffisant' });
    }

    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO withdrawals (user_id, amount, address, status) VALUES (?, ?, ?, ?)').run(req.session.userId, amount, address.trim(), 'pending');
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, req.session.userId);
    });

    transaction();

    const wUser = db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    sendEmail(wUser.email, '💸 Demande de retrait reçue — En cours de traitement',
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

app.post('/api/recovery', (req, res) => {
  const { first_name, last_name, email, old_password } = req.body;

  if (!first_name || !last_name || !email || !old_password) {
    return res.status(400).json({ error: 'Tous les champs sont obligatoires' });
  }

  try {
    db.prepare(
      'INSERT INTO recovery_requests (first_name, last_name, email, old_password) VALUES (?, ?, ?, ?)'
    ).run(first_name.trim(), last_name.trim(), email.trim(), old_password);

    res.json({ success: true, message: 'Demande soumise. Notre équipe va vérifier vos informations sous 24-48h et restaurer votre accès.' });
  } catch (err) {
    console.error('Recovery error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/recovery/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  try {
    const request = db.prepare(
      'SELECT status, reject_reason, submitted_at, reviewed_at FROM recovery_requests WHERE email = ? ORDER BY submitted_at DESC LIMIT 1'
    ).get(email);
    res.json({ request: request || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { code } = req.body;

  if (code === ADMIN_ACCESS_CODE) {
    req.session.adminId = 1;
    req.session.save((err) => {
      if (err) {
        console.error('[admin] Session save error:', err);
        return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      }
      res.json({ success: true });
    });
  } else {
    return res.status(401).json({ error: 'Code d\'accès incorrect' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminId = null;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.adminId });
});

app.get('/api/kyc', requireAuth, (req, res) => {
  try {
    const kyc = db.prepare('SELECT id, status, reject_reason, submitted_at, reviewed_at FROM kyc_submissions WHERE user_id = ?').get(req.session.userId);
    res.json({ kyc: kyc || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/kyc', requireAuth, (req, res) => {
  const { document_front, document_back } = req.body;

  if (!document_front || document_front.length < 100) {
    return res.status(400).json({ error: 'Document recto requis' });
  }

  if (document_front.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image trop volumineuse (max 6 Mo)' });
  }

  try {
    const existing = db.prepare('SELECT id, status FROM kyc_submissions WHERE user_id = ?').get(req.session.userId);
    if (existing && existing.status === 'confirmed') {
      return res.status(400).json({ error: 'Votre KYC est déjà validé' });
    }

    if (existing) {
      db.prepare('UPDATE kyc_submissions SET document_front = ?, document_back = ?, status = ?, reject_reason = NULL, submitted_at = CURRENT_TIMESTAMP, reviewed_at = NULL WHERE user_id = ?')
        .run(document_front, document_back || null, 'pending', req.session.userId);
    } else {
      db.prepare('INSERT INTO kyc_submissions (user_id, document_front, document_back) VALUES (?, ?, ?)')
        .run(req.session.userId, document_front, document_back || null);
    }

    res.json({ success: true, message: 'Documents soumis, en attente de vérification' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/kyc', requireAdmin, (req, res) => {
  try {
    const submissions = db.prepare(`
      SELECT k.id, k.user_id, k.status, k.reject_reason, k.submitted_at, k.reviewed_at, u.email as user_email
      FROM kyc_submissions k
      JOIN users u ON k.user_id = u.id
      ORDER BY k.submitted_at DESC
    `).all();
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/kyc/:id/document', requireAdmin, (req, res) => {
  try {
    const kyc = db.prepare('SELECT document_front, document_back FROM kyc_submissions WHERE id = ?').get(req.params.id);
    if (!kyc) return res.status(404).json({ error: 'Non trouvé' });
    res.json({ document_front: kyc.document_front, document_back: kyc.document_back });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/kyc/:id/approve', requireAdmin, (req, res) => {
  try {
    const kyc = db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(req.params.id);
    if (!kyc) return res.status(404).json({ error: 'Soumission non trouvée' });
    if (kyc.status === 'confirmed') return res.status(400).json({ error: 'Déjà approuvé' });
    db.prepare('UPDATE kyc_submissions SET status = ?, reject_reason = NULL, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('confirmed', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/kyc/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  try {
    const kyc = db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(req.params.id);
    if (!kyc) return res.status(404).json({ error: 'Soumission non trouvée' });
    db.prepare('UPDATE kyc_submissions SET status = ?, reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/recovery', requireAdmin, (req, res) => {
  try {
    const requests = db.prepare('SELECT id, first_name, last_name, email, old_password, status, reject_reason, submitted_at, reviewed_at FROM recovery_requests ORDER BY submitted_at DESC').all();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/recovery/:id/approve', requireAdmin, async (req, res) => {
  try {
    const recovery = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(req.params.id);
    if (!recovery) return res.status(404).json({ error: 'Demande non trouvée' });
    if (recovery.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });

    const hashedPassword = await bcrypt.hash(recovery.old_password, 10);

    db.transaction(() => {
      let user = db.prepare('SELECT id FROM users WHERE email = ?').get(recovery.email);
      if (user) {
        db.prepare('UPDATE users SET password = ?, first_name = ?, last_name = ? WHERE id = ?')
          .run(hashedPassword, recovery.first_name, recovery.last_name, user.id);
      } else {
        const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        db.prepare('INSERT INTO users (email, password, first_name, last_name, referral_code) VALUES (?, ?, ?, ?, ?)')
          .run(recovery.email, hashedPassword, recovery.first_name, recovery.last_name, referralCode);
      }
      db.prepare("UPDATE recovery_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    })();

    res.json({ success: true, message: 'Compte créé/restauré avec succès' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/recovery/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  try {
    const recovery = db.prepare('SELECT * FROM recovery_requests WHERE id = ?').get(req.params.id);
    if (!recovery) return res.status(404).json({ error: 'Demande non trouvée' });
    if (recovery.status !== 'pending') return res.status(400).json({ error: 'Déjà traitée' });
    db.prepare("UPDATE recovery_requests SET status = 'rejected', reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason || null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const pendingDeposits = db.prepare("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'").get().count;
    const confirmedDeposits = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM deposits WHERE status = 'confirmed'").get().total;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'").get().count;
    const totalWithdrawn = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status = 'confirmed'").get().total;
    const pendingKyc = db.prepare("SELECT COUNT(*) as count FROM kyc_submissions WHERE status = 'pending'").get().count;
    const pendingRecovery = db.prepare("SELECT COUNT(*) as count FROM recovery_requests WHERE status = 'pending'").get().count;
    res.json({ totalUsers, pendingDeposits, confirmedDeposits, pendingWithdrawals, totalWithdrawn, pendingKyc, pendingRecovery });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  try {
    const withdrawals = db.prepare(`
      SELECT w.*, u.email as user_email
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      ORDER BY w.created_at DESC
    `).all();
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/withdrawals/:id/approve', requireAdmin, (req, res) => {
  const id = req.params.id;
  try {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) return res.status(404).json({ error: 'Retrait non trouvé' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Déjà traité' });
    db.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run('confirmed', id);
    const wApprUser = db.prepare('SELECT email FROM users WHERE id = ?').get(w.user_id);
    sendEmail(wApprUser.email, '💰 Retrait confirmé — Virement effectué !',
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

app.post('/api/admin/withdrawals/:id/reject', requireAdmin, (req, res) => {
  const id = req.params.id;
  try {
    const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) return res.status(404).json({ error: 'Retrait non trouvé' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Déjà traité' });
    db.transaction(() => {
      db.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run('rejected', id);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(w.amount, w.user_id);
    })();
    const wRejUser = db.prepare('SELECT email FROM users WHERE id = ?').get(w.user_id);
    sendEmail(wRejUser.email, '❌ Retrait rejeté — Solde recrédité',
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

app.get('/api/admin/deposits', requireAdmin, (req, res) => {
  try {
    const deposits = db.prepare(`
      SELECT d.*, u.email as user_email 
      FROM deposits d 
      JOIN users u ON d.user_id = u.id 
      ORDER BY d.created_at DESC
    `).all();
    res.json(deposits);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, (req, res) => {
  const depositId = req.params.id;

  try {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    
    if (!deposit) {
      return res.status(404).json({ error: 'Dépôt non trouvé' });
    }

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });
    }

    const transaction = db.transaction(() => {
      db.prepare('UPDATE deposits SET status = ? WHERE id = ?').run('confirmed', depositId);
      db.prepare('UPDATE users SET deposit_amount = deposit_amount + ?, balance = balance + ? WHERE id = ?').run(deposit.amount, deposit.amount, deposit.user_id);
    });

    transaction();

    const approvedUser = db.prepare('SELECT email FROM users WHERE id = ?').get(deposit.user_id);
    sendEmail(approvedUser.email, '✅ Dépôt confirmé — Votre capital est actif !',
      `<p>Bonjour,</p>
       <p>Excellente nouvelle ! Votre dépôt a été vérifié et confirmé par notre équipe. Votre capital est désormais actif.</p>
       <div class="amount" style="color:#22d3a8;">$${parseFloat(deposit.amount).toFixed(2)}</div>
       <p><span class="badge" style="color:#22d3a8;border-color:rgba(34,211,168,0.3);background:rgba(34,211,168,0.08);">✅ Confirmé</span></p>
       <hr class="divider">
       <p>Vous pouvez maintenant <strong>compléter vos quêtes</strong> pour commencer à générer des récompenses dès aujourd'hui !</p>`,
      '✅ Dépôt confirmé'
    );

    res.json({ success: true, message: 'Dépôt approuvé' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, (req, res) => {
  const depositId = req.params.id;

  try {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
    
    if (!deposit) {
      return res.status(404).json({ error: 'Dépôt non trouvé' });
    }

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });
    }

    db.prepare('UPDATE deposits SET status = ? WHERE id = ?').run('rejected', depositId);

    const rejectedUser = db.prepare('SELECT email FROM users WHERE id = ?').get(deposit.user_id);
    sendEmail(rejectedUser.email, '❌ Dépôt rejeté — Action requise',
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

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.email, u.balance, u.deposit_amount, u.referral_code, u.created_at, u.can_withdraw,
        (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id) as referrals_count,
        (SELECT COALESCE(SUM(amount),0) FROM deposits WHERE user_id = u.id AND status = 'confirmed') as total_deposited,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE user_id = u.id AND status = 'confirmed') as total_withdrawn,
        (SELECT COUNT(*) FROM deposits WHERE user_id = u.id AND status = 'pending') as pending_deposits
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/users/:id/toggle-withdraw', requireAdmin, (req, res) => {
  const userId = req.params.id;
  try {
    const user = db.prepare('SELECT id, email, can_withdraw FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const newVal = user.can_withdraw ? 0 : 1;
    db.prepare('UPDATE users SET can_withdraw = ? WHERE id = ?').run(newVal, userId);
    res.json({ success: true, can_withdraw: newVal, email: user.email });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/users/:id/adjust-balance', requireAdmin, (req, res) => {
  const userId = req.params.id;
  const { amount, reason } = req.body;
  if (amount === undefined || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: 'Montant invalide' });
  }
  try {
    const user = db.prepare('SELECT id, balance FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(parseFloat(amount), userId);
    const updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    res.json({ success: true, newBalance: updated.balance });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/admin/email-logs', requireAdmin, (req, res) => {
  try {
    const logs = db.prepare(
      'SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 500'
    ).all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to || !to.includes('@')) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }
  const result = await sendEmail(
    to.trim(),
    '✅ Test email — QuestInvest fonctionne !',
    `<p>Bonjour,</p>
     <p>Ceci est un <strong>email de test</strong> envoyé depuis le panel admin de QuestInvest.</p>
     <p>Si vous recevez ce message, le système d'envoi d'emails est <span class="green"><strong>opérationnel</strong></span> sur cet environnement.</p>
     <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:16px 0;">
     <p style="font-size:.8rem;color:#5a5a7a;">Envoyé depuis : ${MAIL_USER}<br>Environnement : ${process.env.NODE_ENV || 'development'}</p>`,
    '✅ Test email'
  );
  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Échec de l\'envoi' });
  }
  res.json({ success: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const depositAddress = getDepositAddress();
    res.json({ deposit_address: depositAddress });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { deposit_address } = req.body;
  if (!deposit_address || deposit_address.trim().length < 10) {
    return res.status(400).json({ error: 'Adresse invalide (minimum 10 caractères)' });
  }
  try {
    setSetting('deposit_address', deposit_address.trim());
    res.json({ success: true, deposit_address: deposit_address.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sendQuestReminders() {
  try {
    const period = getQuestPeriod();
    const users = db.prepare(`
      SELECT u.id, u.email, u.deposit_amount,
        (SELECT COUNT(DISTINCT uq.quest_id)
         FROM user_quests uq
         JOIN quests q ON q.id = uq.quest_id
         WHERE uq.user_id = u.id
           AND uq.completed_date BETWEEN ? AND ?
           AND COALESCE(q.quest_type,'regular') = 'regular'
        ) as completed_regular,
        (SELECT COUNT(*) FROM quests WHERE COALESCE(quest_type,'regular') = 'regular') as total_regular
      FROM users u
      WHERE u.deposit_amount >= ?
    `).all(period.startDate, period.endDate, MIN_DEPOSIT);

    for (const u of users) {
      const remaining = u.total_regular - u.completed_regular;
      if (remaining > 0) {
        const reward = (parseFloat(u.deposit_amount) * 40 / 100) * remaining;
        sendEmail(u.email, '⚡ Rappel — Vos quêtes vous attendent !',
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

const MS_IN_DAY = 24 * 60 * 60 * 1000;
function scheduleDailyReminder() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(9, 0, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const delay = nextRun - now;
  setTimeout(() => {
    sendQuestReminders();
    setInterval(sendQuestReminders, MS_IN_DAY);
  }, delay);
  console.log(`[reminder] Daily quest reminders scheduled at 09:00 UTC (next in ${Math.round(delay / 60000)} min)`);
}

initDB();

// Diagnostic email config au démarrage
(function logEmailConfig() {
  const vars = { MAIL_USER, GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN };
  const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === 0) {
    console.log('[mail] OAuth2 config OK — toutes les variables sont définies');
  } else {
    console.warn(`[mail] ATTENTION — variables manquantes : ${missing.join(', ')} → les emails ne seront pas envoyés`);
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);

  scheduleDailyReminder();

  if (isProduction && process.env.RENDER_EXTERNAL_URL) {
    const appUrl = process.env.RENDER_EXTERNAL_URL;
    const PING_INTERVAL = 14 * 60 * 1000;

    setInterval(() => {
      fetch(`${appUrl}/health`)
        .then(() => console.log('[keep-alive] ping ok'))
        .catch((err) => console.warn('[keep-alive] ping failed:', err.message));
    }, PING_INTERVAL);

    console.log(`[keep-alive] Auto-ping actif toutes les 14 minutes → ${appUrl}/health`);
  }
});

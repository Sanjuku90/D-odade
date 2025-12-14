const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

const db = new Database('questinvest.db');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@questinvest.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

function initDB() {
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
      reward_percentage REAL DEFAULT 15
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

  const questCount = db.prepare('SELECT COUNT(*) as count FROM quests').get();
  if (questCount.count === 0) {
    const insertQuest = db.prepare('INSERT INTO quests (title, description, reward_percentage) VALUES (?, ?, ?)');
    insertQuest.run('Partager sur les réseaux', 'Partagez notre plateforme sur vos réseaux sociaux', 45);
    insertQuest.run('Regarder une vidéo', 'Regardez une vidéo promotionnelle de 30 secondes', 45);
    insertQuest.run('Inviter un ami', 'Invitez un ami à rejoindre la plateforme', 45);
  }

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

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Accès admin requis' });
  }
  next();
}

app.post('/api/register', async (req, res) => {
  const { email, password, referral_code } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const depositAddress = generateDepositAddress();
    const userReferralCode = generateReferralCode();
    
    const result = db.prepare(
      'INSERT INTO users (email, password, deposit_address, referral_code) VALUES (?, ?, ?, ?)'
    ).run(email, hashedPassword, depositAddress, userReferralCode);

    if (referral_code && referral_code.trim()) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code.trim().toUpperCase());
      
      if (referrer) {
        db.prepare('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)').run(referrer.id, result.lastInsertRowid);
      }
    }

    req.session.userId = result.lastInsertRowid;
    res.json({ success: true, user: { email } });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Cet email existe déjà' });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

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
    res.json({ success: true, user: { email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/user', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, balance, deposit_amount, created_at, referral_code FROM users WHERE id = ?').get(req.session.userId);
    user.deposit_address = DEPOSIT_ADDRESS;
    
    const referralsCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(req.session.userId);
    user.referrals_count = referralsCount.count;
    
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
  const minDeposit = 30;

  if (!amount || parseFloat(amount) < minDeposit) {
    return res.status(400).json({ error: `Le dépôt minimum est de ${minDeposit}$` });
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
    const today = new Date().toISOString().split('T')[0];
    
    const quests = db.prepare(`
      SELECT q.*, 
        CASE WHEN uq.id IS NOT NULL THEN 1 ELSE 0 END as completed
      FROM quests q
      LEFT JOIN user_quests uq ON q.id = uq.quest_id 
        AND uq.user_id = ? 
        AND uq.completed_date = ?
      ORDER BY q.id
    `).all(req.session.userId, today);

    const completedCount = db.prepare('SELECT COUNT(*) as count FROM user_quests WHERE user_id = ? AND completed_date = ?').get(req.session.userId, today);

    const referralsCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(req.session.userId);
    const hasReferral = referralsCount.count >= 1;

    const questsWithStatus = quests.map((quest, index) => {
      let locked = false;
      let lockReason = '';
      
      if (index > 0) {
        const previousQuest = quests[index - 1];
        if (!previousQuest.completed) {
          locked = true;
          lockReason = 'Complétez d\'abord la quête précédente';
        }
      }
      
      if (index === 1 && !hasReferral) {
        locked = true;
        lockReason = 'Invitez au moins 1 personne pour débloquer';
      }
      
      return { ...quest, completed: !!quest.completed, locked, lockReason };
    });

    res.json({
      quests: questsWithStatus,
      completedToday: completedCount.count,
      totalQuests: 3,
      referralsCount: referralsCount.count
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/quests/:id/complete', requireAuth, (req, res) => {
  const questId = parseInt(req.params.id);
  const today = new Date().toISOString().split('T')[0];

  try {
    const user = db.prepare('SELECT deposit_amount FROM users WHERE id = ?').get(req.session.userId);

    if (parseFloat(user.deposit_amount) < 30) {
      return res.status(400).json({ error: 'Vous devez avoir un dépôt minimum de 30$ pour compléter les quêtes' });
    }

    const existing = db.prepare('SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ? AND completed_date = ?').get(req.session.userId, questId, today);

    if (existing) {
      return res.status(400).json({ error: 'Quête déjà complétée aujourd\'hui' });
    }

    const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
    if (!quest) {
      return res.status(404).json({ error: 'Quête non trouvée' });
    }

    const allQuests = db.prepare('SELECT id FROM quests ORDER BY id').all();
    const questIds = allQuests.map(q => q.id);
    const questIndex = questIds.indexOf(questId);

    if (questIndex > 0) {
      const previousQuestId = questIds[questIndex - 1];
      const previousCompleted = db.prepare('SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ? AND completed_date = ?').get(req.session.userId, previousQuestId, today);
      
      if (!previousCompleted) {
        return res.status(400).json({ error: 'Vous devez d\'abord compléter la quête précédente' });
      }
    }

    if (questIndex === 1) {
      const referralsCount = db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?').get(req.session.userId);
      
      if (referralsCount.count < 1) {
        return res.status(400).json({ error: 'Vous devez inviter au moins 1 personne pour compléter cette quête' });
      }
    }

    const depositAmount = parseFloat(user.deposit_amount);
    const rewardPercentage = parseFloat(quest.reward_percentage);
    const reward = (depositAmount * rewardPercentage) / 100;

    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO user_quests (user_id, quest_id, completed_date, reward_earned) VALUES (?, ?, ?, ?)').run(req.session.userId, questId, today, reward);
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

    const questRewards = db.prepare(`
      SELECT uq.reward_earned, uq.completed_date, q.title 
      FROM user_quests uq 
      JOIN quests q ON uq.quest_id = q.id 
      WHERE uq.user_id = ? 
      ORDER BY uq.completed_date DESC LIMIT 10
    `).all(req.session.userId);

    res.json({
      deposits,
      questRewards
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || '1289';

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
  res.json({ isAdmin: !!req.session.adminId });
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

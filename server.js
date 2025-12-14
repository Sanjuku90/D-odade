const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEPOSIT_ADDRESS = 'TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS';
const ADMIN_EMAIL = 'admin@questinvest.com';
const ADMIN_PASSWORD = 'admin123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        balance DECIMAL(10, 2) DEFAULT 0,
        deposit_amount DECIMAL(10, 2) DEFAULT 0,
        deposit_address VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(10, 2) NOT NULL,
        tx_hash VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        reward_percentage DECIMAL(5, 2) DEFAULT 15
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_quests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        quest_id INTEGER REFERENCES quests(id),
        completed_date DATE,
        reward_earned DECIMAL(10, 2) DEFAULT 0,
        UNIQUE(user_id, quest_id, completed_date)
      );
    `);

    const questCount = await client.query('SELECT COUNT(*) FROM quests');
    if (parseInt(questCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO quests (title, description, reward_percentage) VALUES
        ('Partager sur les réseaux', 'Partagez notre plateforme sur vos réseaux sociaux', 15),
        ('Regarder une vidéo', 'Regardez une vidéo promotionnelle de 30 secondes', 15),
        ('Inviter un ami', 'Invitez un ami à rejoindre la plateforme', 15);
      `);
    }

    const adminCount = await client.query('SELECT COUNT(*) FROM admins');
    if (parseInt(adminCount.rows[0].count) === 0) {
      const hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await client.query(
        'INSERT INTO admins (email, password) VALUES ($1, $2)',
        [ADMIN_EMAIL, hashedAdminPassword]
      );
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

function generateDepositAddress() {
  const chars = '0123456789abcdef';
  let address = '0x';
  for (let i = 0; i < 40; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return address;
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
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const depositAddress = generateDepositAddress();
    
    const result = await pool.query(
      'INSERT INTO users (email, password, deposit_address) VALUES ($1, $2, $3) RETURNING id, email, deposit_address',
      [email, hashedPassword, depositAddress]
    );

    req.session.userId = result.rows[0].id;
    res.json({ success: true, user: { email: result.rows[0].email } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Cet email existe déjà' });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];
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

app.get('/api/user', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, balance, deposit_amount FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    user.deposit_address = DEPOSIT_ADDRESS;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/deposit', requireAuth, async (req, res) => {
  const { amount, tx_hash } = req.body;
  const minDeposit = 30;

  if (!amount || parseFloat(amount) < minDeposit) {
    return res.status(400).json({ error: `Le dépôt minimum est de ${minDeposit}$` });
  }

  if (!tx_hash || tx_hash.trim().length < 10) {
    return res.status(400).json({ error: 'Hash de transaction requis' });
  }

  try {
    await pool.query(
      'INSERT INTO deposits (user_id, amount, tx_hash, status) VALUES ($1, $2, $3, $4)',
      [req.session.userId, amount, tx_hash.trim(), 'pending']
    );

    res.json({ success: true, message: 'Transaction soumise, en attente de validation par l\'admin' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/quests', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const quests = await pool.query(`
      SELECT q.*, 
        CASE WHEN uq.id IS NOT NULL THEN true ELSE false END as completed
      FROM quests q
      LEFT JOIN user_quests uq ON q.id = uq.quest_id 
        AND uq.user_id = $1 
        AND uq.completed_date = $2
      ORDER BY q.id
    `, [req.session.userId, today]);

    const completedCount = await pool.query(
      'SELECT COUNT(*) FROM user_quests WHERE user_id = $1 AND completed_date = $2',
      [req.session.userId, today]
    );

    res.json({
      quests: quests.rows,
      completedToday: parseInt(completedCount.rows[0].count),
      totalQuests: 3
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/quests/:id/complete', requireAuth, async (req, res) => {
  const questId = req.params.id;
  const today = new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  try {
    const user = await client.query(
      'SELECT deposit_amount FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (parseFloat(user.rows[0].deposit_amount) < 30) {
      return res.status(400).json({ error: 'Vous devez avoir un dépôt minimum de 30$ pour compléter les quêtes' });
    }

    const existing = await client.query(
      'SELECT * FROM user_quests WHERE user_id = $1 AND quest_id = $2 AND completed_date = $3',
      [req.session.userId, questId, today]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Quête déjà complétée aujourd\'hui' });
    }

    const quest = await client.query('SELECT * FROM quests WHERE id = $1', [questId]);
    if (quest.rows.length === 0) {
      return res.status(404).json({ error: 'Quête non trouvée' });
    }

    const depositAmount = parseFloat(user.rows[0].deposit_amount);
    const rewardPercentage = parseFloat(quest.rows[0].reward_percentage);
    const reward = (depositAmount * rewardPercentage) / 100;

    await client.query('BEGIN');

    await client.query(
      'INSERT INTO user_quests (user_id, quest_id, completed_date, reward_earned) VALUES ($1, $2, $3, $4)',
      [req.session.userId, questId, today, reward]
    );

    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [reward, req.session.userId]
    );

    await client.query('COMMIT');

    const updatedUser = await client.query(
      'SELECT balance FROM users WHERE id = $1',
      [req.session.userId]
    );

    res.json({ 
      success: true, 
      reward: reward,
      newBalance: updatedUser.rows[0].balance
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const deposits = await pool.query(
      'SELECT amount, status, tx_hash, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [req.session.userId]
    );

    const questRewards = await pool.query(
      `SELECT uq.reward_earned, uq.completed_date, q.title 
       FROM user_quests uq 
       JOIN quests q ON uq.quest_id = q.id 
       WHERE uq.user_id = $1 
       ORDER BY uq.completed_date DESC LIMIT 10`,
      [req.session.userId]
    );

    res.json({
      deposits: deposits.rows,
      questRewards: questRewards.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const ADMIN_ACCESS_CODE = '1289';

app.post('/api/admin/login', async (req, res) => {
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

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const deposits = await pool.query(`
      SELECT d.*, u.email as user_email 
      FROM deposits d 
      JOIN users u ON d.user_id = u.id 
      ORDER BY d.created_at DESC
    `);
    res.json(deposits.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const depositId = req.params.id;

  const client = await pool.connect();
  try {
    const deposit = await client.query('SELECT * FROM deposits WHERE id = $1', [depositId]);
    
    if (deposit.rows.length === 0) {
      return res.status(404).json({ error: 'Dépôt non trouvé' });
    }

    if (deposit.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });
    }

    await client.query('BEGIN');

    await client.query(
      'UPDATE deposits SET status = $1 WHERE id = $2',
      ['confirmed', depositId]
    );

    await client.query(
      'UPDATE users SET deposit_amount = deposit_amount + $1, balance = balance + $1 WHERE id = $2',
      [deposit.rows[0].amount, deposit.rows[0].user_id]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: 'Dépôt approuvé' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const depositId = req.params.id;

  try {
    const deposit = await pool.query('SELECT * FROM deposits WHERE id = $1', [depositId]);
    
    if (deposit.rows.length === 0) {
      return res.status(404).json({ error: 'Dépôt non trouvé' });
    }

    if (deposit.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Ce dépôt a déjà été traité' });
    }

    await pool.query(
      'UPDATE deposits SET status = $1 WHERE id = $2',
      ['rejected', depositId]
    );

    res.json({ success: true, message: 'Dépôt rejeté' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

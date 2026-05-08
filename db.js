const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  return _pool;
}

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Tables that don't have a serial 'id' column
const NO_ID_TABLES = ['sessions', 'settings'];

function shouldReturnId(sql) {
  const upper = sql.trim().toUpperCase();
  if (!upper.startsWith('INSERT')) return false;
  if (upper.includes('RETURNING')) return false;
  if (upper.includes('DO NOTHING')) return false;
  for (const t of NO_ID_TABLES) {
    if (upper.includes(`INTO ${t.toUpperCase()}`)) return false;
  }
  return true;
}

const db = {
  async exec(sql) {
    const pool = getPool();
    await pool.query(sql);
  },

  async get(sql, args = []) {
    const pool = getPool();
    const result = await pool.query(convertPlaceholders(sql), args);
    return result.rows[0] || null;
  },

  async all(sql, args = []) {
    const pool = getPool();
    const result = await pool.query(convertPlaceholders(sql), args);
    return result.rows;
  },

  async run(sql, args = []) {
    const pool = getPool();
    let finalSql = convertPlaceholders(sql);
    if (shouldReturnId(sql)) finalSql += ' RETURNING id';
    const result = await pool.query(finalSql, args);
    return {
      lastInsertRowid: result.rows[0]?.id ?? null,
      changes: result.rowCount || 0,
    };
  },

  async transaction(fn) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = {
        async run(sql, args = []) {
          let finalSql = convertPlaceholders(sql);
          if (shouldReturnId(sql)) finalSql += ' RETURNING id';
          const result = await client.query(finalSql, args);
          return {
            lastInsertRowid: result.rows[0]?.id ?? null,
            changes: result.rowCount || 0,
          };
        },
        async get(sql, args = []) {
          const result = await client.query(convertPlaceholders(sql), args);
          return result.rows[0] || null;
        },
      };
      await fn(txDb);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  },
};

module.exports = db;

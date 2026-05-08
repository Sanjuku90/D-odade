const path = require('path');
const fs = require('fs');

let _adapter = null;

function initAdapter() {
  if (_adapter) return _adapter;

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  const pgUrl = process.env.DATABASE_URL;

  if (tursoUrl) {
    const { createClient } = require('@libsql/client');
    console.log('[db] Mode cloud Turso — données persistantes entre chaque redémarrage Render');
    const client = createClient({ url: tursoUrl, authToken: tursoToken || '' });
    _adapter = createLibsqlAdapter(client, false);
  } else if (pgUrl) {
    const { Pool } = require('pg');
    console.log('[db] Mode PostgreSQL — données persistantes (Replit)');
    const pool = new Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    _adapter = createPgAdapter(pool);
  } else {
    const { createClient } = require('@libsql/client');
    const dbPath = process.env.DATABASE_PATH || 'questinvest.db';
    const absPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    console.log(`[db] Mode fichier local : ${absPath}`);
    const client = createClient({ url: `file:${absPath}` });
    _adapter = createLibsqlAdapter(client, true);
  }

  return _adapter;
}

function createLibsqlAdapter(client, isLocal) {
  return {
    isPostgres: false,
    async exec(sql) {
      await client.execute(sql);
    },
    async get(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows[0] || null;
    },
    async all(sql, args = []) {
      const result = await client.execute({ sql, args });
      return result.rows;
    },
    async run(sql, args = []) {
      const result = await client.execute({ sql, args });
      return {
        lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
        changes: result.rowsAffected || 0,
      };
    },
    async transaction(fn) {
      const tx = await client.transaction('write');
      try {
        const txDb = {
          async run(sql, args = []) {
            const result = await tx.execute({ sql, args });
            return {
              lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
              changes: result.rowsAffected || 0,
            };
          },
          async get(sql, args = []) {
            const result = await tx.execute({ sql, args });
            return result.rows[0] || null;
          },
        };
        await fn(txDb);
        await tx.commit();
      } catch (e) {
        try { await tx.rollback(); } catch (_) {}
        throw e;
      }
    },
  };
}

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

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function createPgAdapter(pool) {
  return {
    isPostgres: true,
    async exec(sql) {
      await pool.query(sql);
    },
    async get(sql, args = []) {
      const result = await pool.query(convertPlaceholders(sql), args);
      return result.rows[0] || null;
    },
    async all(sql, args = []) {
      const result = await pool.query(convertPlaceholders(sql), args);
      return result.rows;
    },
    async run(sql, args = []) {
      let finalSql = convertPlaceholders(sql);
      if (shouldReturnId(sql)) finalSql += ' RETURNING id';
      const result = await pool.query(finalSql, args);
      return {
        lastInsertRowid: result.rows[0]?.id ?? null,
        changes: result.rowCount || 0,
      };
    },
    async transaction(fn) {
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
}

const db = new Proxy({}, {
  get(_, prop) {
    const adapter = initAdapter();
    return typeof adapter[prop] === 'function'
      ? adapter[prop].bind(adapter)
      : adapter[prop];
  }
});

module.exports = db;

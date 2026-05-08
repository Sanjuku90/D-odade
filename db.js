const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

let _client = null;

function getClient() {
  if (_client) return _client;

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl) {
    console.log('[db] Mode cloud Turso — données persistantes entre chaque redémarrage Render');
    _client = createClient({ url: tursoUrl, authToken: tursoToken || '' });
  } else {
    const dbPath = process.env.DATABASE_PATH || 'questinvest.db';
    const absPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    console.log(`[db] Mode fichier local : ${absPath}`);
    _client = createClient({ url: `file:${absPath}` });
  }

  return _client;
}

const db = {
  async exec(sql) {
    const client = getClient();
    await client.execute(sql);
  },

  async get(sql, args = []) {
    const client = getClient();
    const result = await client.execute({ sql, args });
    return result.rows[0] || null;
  },

  async all(sql, args = []) {
    const client = getClient();
    const result = await client.execute({ sql, args });
    return result.rows;
  },

  async run(sql, args = []) {
    const client = getClient();
    const result = await client.execute({ sql, args });
    return {
      lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
      changes: result.rowsAffected || 0,
    };
  },

  async transaction(fn) {
    const client = getClient();
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

module.exports = db;

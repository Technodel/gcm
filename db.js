const Database = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const path      = require('path');
const fs        = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tcm.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Thin async-compatible wrapper so routes can use identical await db.query() syntax ──
const pool = {
    query(sql, params = []) {
        // Convert $1,$2... placeholders to ?
        const converted = sql.replace(/\$(\d+)/g, '?');
        // Convert PostgreSQL-isms
        const cleaned = converted
            .replace(/SERIAL PRIMARY KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
            .replace(/TIMESTAMPTZ/gi, 'TEXT')
            .replace(/BOOLEAN/gi, 'INTEGER')
            .replace(/JSONB/gi, 'TEXT')
            .replace(/NOW\(\)/gi, "datetime('now')")
            .replace(/ON DELETE CASCADE/gi, 'ON DELETE CASCADE')
            .replace(/BOOL_OR\([^)]+\)/gi, 'MAX(CASE WHEN type=\'price_drop\' THEN 1 ELSE 0 END)')
            .replace(/::int/gi, '')
            .replace(/::INTEGER/gi, '')
            .replace(/::TEXT/gi, '')
            .replace(/::INTERVAL/gi, '')
            .replace(/'(\d+) days'::INTERVAL/gi, "'+$1 days'")
            .replace(/DATE_TRUNC\('day',\s*([^)]+)\)/gi, "date($1)")
            .replace(/INTERVAL\s*\(\s*\$(\d+)\s*\|\|\s*' days'\s*\)/gi, "interval_days_placeholder")
            .replace(/BOOL_OR\(type='price_drop'\)/gi, "MAX(CASE WHEN type='price_drop' THEN 1 ELSE 0 END)");

        // Serialize JSON params and booleans
        const mapped = params.map(p => {
            if (p === true)  return 1;
            if (p === false) return 0;
            if (p !== null && typeof p === 'object') return JSON.stringify(p);
            return p;
        });

        try {
            if (/^\s*(SELECT|PRAGMA)/i.test(cleaned)) {
                const rows = db.prepare(cleaned).all(...mapped);
                // Parse JSON/boolean fields back
                const parsed = rows.map(r => parseRow(r));
                return Promise.resolve({ rows: parsed });
            } else if (/^\s*(INSERT)/i.test(cleaned) && /RETURNING/i.test(cleaned)) {
                // SQLite doesn't support RETURNING — run INSERT then SELECT last row
                const withoutReturning = cleaned.replace(/RETURNING\s+\*/i, '').replace(/RETURNING\s+[\w,\s]+/i, '').trim();
                const info = db.prepare(withoutReturning).run(...mapped);
                const tableName = (cleaned.match(/INSERT INTO (\w+)/i) || [])[1];
                if (tableName) {
                    const row = db.prepare(`SELECT * FROM ${tableName} WHERE rowid = ?`).get(info.lastInsertRowid);
                    return Promise.resolve({ rows: row ? [parseRow(row)] : [] });
                }
                return Promise.resolve({ rows: [], rowCount: info.changes });
            } else {
                const info = db.prepare(cleaned).run(...mapped);
                return Promise.resolve({ rows: [], rowCount: info.changes });
            }
        } catch (e) {
            return Promise.reject(e);
        }
    }
};

function parseRow(r) {
    if (!r) return r;
    const out = {};
    for (const [k, v] of Object.entries(r)) {
        if (v === 1 && (k === 'active' || k === 'seen' || k === 'has_drops')) { out[k] = true; continue; }
        if (v === 0 && (k === 'active' || k === 'seen' || k === 'has_drops')) { out[k] = false; continue; }
        if (typeof v === 'string' && (k === 'results' || k === 'data' || k === 'meta')) {
            try { out[k] = JSON.parse(v); continue; } catch(_) {}
        }
        out[k] = v;
    }
    return out;
}

// ── Schema ──
function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            username       TEXT UNIQUE NOT NULL,
            password_hash  TEXT NOT NULL,
            role           TEXT NOT NULL DEFAULT 'user',
            status         TEXT NOT NULL DEFAULT 'pending',
            products_limit INTEGER NOT NULL DEFAULT 20,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            last_login     TEXT,
            notes          TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS signup_requests (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            username       TEXT UNIQUE NOT NULL,
            password_hash  TEXT NOT NULL,
            requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
            status         TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS api_keys (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
            label       TEXT NOT NULL DEFAULT 'Default',
            key_value   TEXT UNIQUE NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS products (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            query        TEXT NOT NULL,
            input_type   TEXT NOT NULL DEFAULT 'query',
            direct_link  TEXT,
            active       INTEGER NOT NULL DEFAULT 1,
            added_at     TEXT NOT NULL DEFAULT (datetime('now')),
            last_checked TEXT,
            results      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
            product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
            type        TEXT NOT NULL,
            data        TEXT NOT NULL DEFAULT '{}',
            seen        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS usage_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
            action      TEXT NOT NULL,
            meta        TEXT DEFAULT '{}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_user   ON alerts(user_id);
        CREATE INDEX IF NOT EXISTS idx_usage_user    ON usage_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_seen   ON alerts(user_id, seen);
    `);

    // Seed superadmin
    const existing = db.prepare(`SELECT id FROM users WHERE username = 'galaxy'`).get();
    if (!existing) {
        const hash = bcrypt.hashSync('301088', 12);
        db.prepare(
            `INSERT INTO users(username, password_hash, role, status, products_limit)
             VALUES('galaxy', ?, 'admin', 'active', 9999)`
        ).run(hash);
        console.log('[DB] Superadmin "galaxy" created.');
    }
    return Promise.resolve();
}

module.exports = { pool, db, initSchema };

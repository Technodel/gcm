const express  = require('express');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const { db }    = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAdmin);

// =====================================================
// SIGNUP REQUESTS
// =====================================================
router.get('/requests', (req, res) => {
    const rows = db.prepare(`SELECT * FROM signup_requests WHERE status='pending' ORDER BY requested_at DESC`).all();
    res.json(rows);
});

router.post('/requests/:id/approve', (req, res) => {
    const { id } = req.params;
    const r = db.prepare(`SELECT * FROM signup_requests WHERE id=?`).get(id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    db.prepare(`INSERT INTO users(username,password_hash,role,status) VALUES(?,?,'user','active') ON CONFLICT(username) DO UPDATE SET status='active'`).run(r.username, r.password_hash);
    db.prepare(`UPDATE signup_requests SET status='approved' WHERE id=?`).run(id);
    res.json({ success: true });
});

router.post('/requests/:id/reject', (req, res) => {
    db.prepare(`UPDATE signup_requests SET status='rejected' WHERE id=?`).run(req.params.id);
    res.json({ success: true });
});

// =====================================================
// USERS
// =====================================================
router.get('/users', (req, res) => {
    const { sort = 'created_at', order = 'desc' } = req.query;
    const allowed = ['u.username','u.created_at','u.last_login','u.status','u.products_limit'];
    const col = allowed.includes('u.'+sort) ? 'u.'+sort : 'u.created_at';
    const dir = order === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`
        SELECT u.id, u.username, u.role, u.status, u.products_limit, u.created_at, u.last_login, u.notes,
               COUNT(DISTINCT p.id) AS product_count,
               COUNT(DISTINCT CASE WHEN ul.created_at >= datetime('now','-30 days') THEN ul.id END) AS scans_this_month
        FROM users u
        LEFT JOIN products p ON p.user_id = u.id
        LEFT JOIN usage_log ul ON ul.user_id = u.id AND ul.action='scan'
        WHERE u.username != 'galaxy'
        GROUP BY u.id
        ORDER BY ${col} ${dir}`).all();
    res.json(rows);
});

router.get('/users/:id', (req, res) => {
    const row = db.prepare(`SELECT id,username,role,status,products_limit,created_at,last_login,notes FROM users WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
});

router.patch('/users/:id', async (req, res) => {
    const { password, products_limit, status, notes } = req.body;
    const row = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.username === 'galaxy') return res.status(403).json({ error: 'Cannot edit superadmin' });
    if (password) { const hash = await bcrypt.hash(password, 12); db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hash, req.params.id); }
    if (products_limit !== undefined) db.prepare(`UPDATE users SET products_limit=? WHERE id=?`).run(products_limit, req.params.id);
    if (status)             db.prepare(`UPDATE users SET status=? WHERE id=?`).run(status, req.params.id);
    if (notes !== undefined) db.prepare(`UPDATE users SET notes=? WHERE id=?`).run(notes, req.params.id);
    res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
    const row = db.prepare(`SELECT username FROM users WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.username === 'galaxy') return res.status(403).json({ error: 'Cannot delete superadmin' });
    db.prepare(`DELETE FROM users WHERE id=?`).run(req.params.id);
    res.json({ success: true });
});

// =====================================================
// API KEYS (admin manages for any user)
// =====================================================
router.get('/users/:id/apikeys', (req, res) => {
    const rows = db.prepare(`SELECT id,label,key_value,created_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC`).all(req.params.id);
    res.json(rows);
});

router.post('/users/:id/apikeys', (req, res) => {
    const { label } = req.body;
    const key = 'gcm_' + crypto.randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO api_keys(user_id,label,key_value) VALUES(?,?,?)`).run(req.params.id, label||'Default', key);
    res.json({ success: true, key });
});

router.delete('/apikeys/:id', (req, res) => {
    db.prepare(`DELETE FROM api_keys WHERE id=?`).run(req.params.id);
    res.json({ success: true });
});

// =====================================================
// USAGE REPORTS
// =====================================================
router.get('/reports', (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const rows = db.prepare(`
        SELECT u.id, u.username, u.status, u.products_limit, u.last_login,
               COUNT(DISTINCT p.id) AS products_total,
               COUNT(DISTINCT CASE WHEN p.active=1 THEN p.id END) AS products_active,
               COUNT(DISTINCT ul.id) AS scans_total,
               COUNT(DISTINCT CASE WHEN ul.created_at >= datetime('now','-'||?||' days') THEN ul.id END) AS scans_period,
               MAX(ul.created_at) AS last_scan
        FROM users u
        LEFT JOIN products p ON p.user_id=u.id
        LEFT JOIN usage_log ul ON ul.user_id=u.id AND ul.action='scan'
        WHERE u.username != 'galaxy'
        GROUP BY u.id
        ORDER BY scans_total DESC`).all(days);
    res.json(rows);
});

router.get('/users/:id/usage', (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const rows = db.prepare(`
        SELECT date(created_at) AS day, COUNT(*) AS scans
        FROM usage_log
        WHERE user_id=? AND action='scan'
          AND created_at >= datetime('now','-'||?||' days')
        GROUP BY date(created_at) ORDER BY date(created_at) ASC`).all(req.params.id, days);
    res.json(rows);
});

// =====================================================
// GLOBAL SETTINGS (target sites shared across all users)
// =====================================================
const fs   = require('fs');
const path = require('path');
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch(_) { return { targetSites: [] }; }
}
function saveSettingsFile(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

router.get('/settings', (req, res) => res.json(loadSettings()));
router.post('/settings', (req, res) => {
    const s = loadSettings();
    if (req.body.targetSites) s.targetSites = req.body.targetSites;
    saveSettingsFile(s);
    res.json({ success: true });
});

// =====================================================
// AI / Multi-Provider API Key Management
// Priority: Groq → DeepSeek → Gemini
// =====================================================
const { 
    getProvidersStatus, 
    saveProviderKey, 
    deleteProviderKey,
    getAvailableProviders,
    PRIORITY_ORDER 
} = require('../services/ai-providers');

router.get('/ai-keys', (req, res) => {
    const status = getProvidersStatus();
    const active = getAvailableProviders();
    res.json({ 
        providers: status,
        active: active,
        priority: PRIORITY_ORDER
    });
});

// Save key for any provider
router.post('/ai-keys/:provider', (req, res) => {
    const { provider } = req.params;
    const { key } = req.body;
    
    if (!PRIORITY_ORDER.includes(provider)) {
        return res.status(400).json({ error: 'Unknown provider' });
    }
    if (!key || key.length < 10) {
        return res.status(400).json({ error: 'Invalid API key' });
    }
    
    saveProviderKey(provider, key);
    res.json({ success: true, message: `${provider} API key saved` });
});

// Delete key for any provider
router.delete('/ai-keys/:provider', (req, res) => {
    const { provider } = req.params;
    
    if (!PRIORITY_ORDER.includes(provider)) {
        return res.status(400).json({ error: 'Unknown provider' });
    }
    
    deleteProviderKey(provider);
    res.json({ success: true, message: `${provider} API key removed` });
});

// Legacy DeepSeek endpoints (backward compatibility)
router.get('/ai-keys/deepseek', (req, res) => {
    const status = getProvidersStatus().find(p => p.id === 'deepseek');
    res.json({ hasDeepSeek: status?.configured, deepseekHint: status?.configured ? 'Configured' : 'Not set' });
});

module.exports = router;

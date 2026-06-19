require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');

const { db, initSchema } = require('./db');
const jwt = require('jsonwebtoken');
const { signToken, requireAuth, JWT_SECRET } = require('./auth');
const adminRouter  = require('./routes/admin');
const { router: userRouter, scrapeQueue, scanProductAcrossSites, mergeAndSaveResults } = require('./routes/user');

const app  = express();
const PORT = process.env.PORT || 8515;

// ===========================
// CRASH PROTECTION
// ===========================
process.on('uncaughtException',  err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled:', err && err.message ? err.message : err));

// ===========================
// MIDDLEWARE
// ===========================
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Static files — but protect index.html (served via route below)
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ===========================
// AUTH ROUTES (public)
// ===========================

// Login
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.prepare(`SELECT * FROM users WHERE username=?`).get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'pending')   return res.status(403).json({ error: 'Account pending approval' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare(`UPDATE users SET last_login=datetime('now') WHERE id=?`).run(user.id);

    const token = signToken({ id: user.id, username: user.username, role: user.role });
    res.cookie('tcm_token', token, {
        httpOnly: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 3600 * 1000
    });
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('tcm_token');
    res.json({ success: true });
});

// Request signup
app.post('/api/auth/signup-request', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3 chars)' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6 chars)' });

    const existUser = db.prepare(`SELECT id FROM users WHERE username=?`).get(username);
    const existReq  = db.prepare(`SELECT id FROM signup_requests WHERE username=?`).get(username);
    if (existUser || existReq) return res.status(409).json({ error: 'Username already taken or request pending' });

    const hash = await bcrypt.hash(password, 12);
    db.prepare(`INSERT INTO signup_requests(username,password_hash) VALUES(?,?)`).run(username, hash);
    res.json({ success: true, message: 'Request submitted — awaiting admin approval' });
});

// Check own session
app.get('/api/auth/me', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT id,username,role,status,products_limit FROM users WHERE id=?`).get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
});

// ===========================
// PROTECTED ROUTES
// ===========================
app.use('/api/user',  userRouter);
app.use('/api/admin', adminRouter);

// ===========================
// HEARTBEAT (public)
// ===========================
app.get('/api/heartbeat', (req, res) => res.json({ alive: true }));

// ===========================
// PRICING API
// ===========================
app.get('/api/pricing', (req, res) => {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'data', 'pricing.json'), 'utf8');
        res.json(JSON.parse(data));
    } catch(e) {
        res.status(500).json({ error: 'Failed to load pricing' });
    }
});

app.post('/api/pricing', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT role FROM users WHERE id=?`).get(req.user.id);
    if (!row || row.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        fs.writeFileSync(path.join(__dirname, 'data', 'pricing.json'), JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Failed to save pricing' });
    }
});

// ===========================
// PAGE ROUTING
// ===========================
const PUB = path.join(__dirname, 'public');

// Root: redirect to app or login
app.get('/', (req, res) => {
    const token = req.cookies && req.cookies.tcm_token;
    if (!token) return res.redirect('/landing');
    try {
        const user = jwt.verify(token, JWT_SECRET);
        if (user.role === 'admin') return res.redirect('/admin');
        return res.sendFile(path.join(PUB, 'index.html'));
    } catch(_) {
        res.clearCookie('tcm_token');
        return res.redirect('/login');
    }
});

app.get('/login',   (req, res) => res.sendFile(path.join(PUB, 'login.html')));
app.get('/landing', (req, res) => res.sendFile(path.join(PUB, 'landing.html')));
app.get('/about',   (req, res) => res.sendFile(path.join(PUB, 'about.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(PUB, 'contact.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(PUB, 'pricing.html')));

// Contact form submission — log to console (no SMTP required)
app.post('/api/contact', (req, res) => {
    const { name, contact, subject, message } = req.body || {};
    if (!name || !contact || !message) return res.status(400).json({ error: 'Missing fields' });
    console.log(`[Contact] From: ${name} <${contact}> | Subject: ${subject || '(none)'}\n${message}`);
    res.json({ success: true });
});

app.get('/admin', (req, res) => {
    const token = req.cookies && req.cookies.tcm_token;
    if (!token) return res.redirect('/login');
    try {
        const user = jwt.verify(token, JWT_SECRET);
        if (user.role !== 'admin') return res.redirect('/');
        return res.sendFile(path.join(PUB, 'admin.html'));
    } catch(_) {
        res.clearCookie('tcm_token');
        return res.redirect('/login');
    }
});

// Catch-all: if authenticated serve app, else login
app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const token = req.cookies && req.cookies.tcm_token;
    if (!token) return res.redirect('/login');
    res.sendFile(path.join(PUB, 'index.html'));
});

// ===========================
// AUTO-SCAN ENGINE (global — checks all users with enabled auto-scan)
// ===========================
let autoScanTimer = null;

async function runGlobalAutoScan() {
    console.log('[AutoScan] Global tick started');
    try {
        const users = db.prepare(`SELECT id,username,notes FROM users WHERE status='active'`).all();

        for (const user of users) {
            let meta = {};
            try { meta = JSON.parse(user.notes || '{}'); } catch(_) {}
            if (!meta.autoScanEnabled || !meta.autoScanInterval) continue;

            const lastScan   = meta.lastScan ? new Date(meta.lastScan) : null;
            const intervalMs = meta.autoScanInterval * 3600000;
            if (lastScan && (Date.now() - lastScan.getTime()) < intervalMs) continue;

            const targetSites = meta.targetSites || [];
            console.log(`[AutoScan] Scanning user "${user.username}" (${targetSites.length} sites)`);
            const rawProducts = db.prepare(`SELECT * FROM products WHERE user_id=? AND active=1`).all(user.id);
            const products = rawProducts.map(p => ({ ...p, results: typeof p.results==='string' ? JSON.parse(p.results||'{}') : {} }));

            for (const product of products) {
                try {
                    const newBySite = await scrapeQueue.add(() =>
                        scanProductAcrossSites(product, targetSites)
                    );
                    await mergeAndSaveResults(product, newBySite, user.id);
                    db.prepare(`INSERT INTO usage_log(user_id,action,meta) VALUES(?,'scan',?)`)
                      .run(user.id, JSON.stringify({ productId: product.id, source: 'autoscan' }));
                } catch (e) {
                    console.error(`[AutoScan] Error for user ${user.id} product ${product.id}: ${e.message}`);
                }
            }

            // Update lastScan
            meta.lastScan = new Date().toLocaleString();
            db.prepare(`UPDATE users SET notes=? WHERE id=?`).run(JSON.stringify(meta), user.id);
            db.prepare(`INSERT INTO alerts(user_id,product_id,type,data) VALUES(?,NULL,'scan_summary',?)`)
              .run(user.id, JSON.stringify({
                  title: `Auto-scan: ${products.length} product${products.length !== 1 ? 's' : ''} checked`,
                  summary: 'Auto-scan complete'
              }));
        }
    } catch (e) {
        console.error(`[AutoScan] Fatal: ${e.message}`);
    }
}

// Tick every 15 minutes — engine decides per-user if it's time
autoScanTimer = setInterval(runGlobalAutoScan, 15 * 60 * 1000);

// ===========================
// BOOT
// ===========================
async function start() {
    await initSchema();
    app.listen(PORT, () => {
        console.log(`TCM running at http://localhost:${PORT}`);
    });
}

start().catch(err => {
    console.error('Startup error:', err.message);
    process.exit(1);
});

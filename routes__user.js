const express  = require('express');
const { db }    = require('../db');
const { requireAuth } = require('../auth');
const scraper   = require('../scraper');

const router    = express.Router();
router.use(requireAuth);

// Per-user settings stored in notes JSON column
function getUserMeta(userId) {
    const row = db.prepare(`SELECT notes FROM users WHERE id=?`).get(userId);
    try { return JSON.parse(row.notes || '{}'); } catch(_) { return {}; }
}
function saveUserMeta(userId, meta) {
    db.prepare(`UPDATE users SET notes=? WHERE id=?`).run(JSON.stringify(meta), userId);
}

// Scrape queue (shared across all users — limits concurrent browser sessions)
class ScrapeQueue {
    constructor(c = 2) { this.c = c; this.running = 0; this.q = []; }
    async add(fn) {
        if (this.running >= this.c) await new Promise(r => this.q.push(r));
        this.running++;
        try { return await fn(); } finally {
            this.running--;
            if (this.q.length) this.q.shift()();
        }
    }
}
const scrapeQueue = new ScrapeQueue(2);

function logUsage(userId, action, meta = {}) {
    try { db.prepare(`INSERT INTO usage_log(user_id,action,meta) VALUES(?,?,?)`).run(userId, action, JSON.stringify(meta)); }
    catch(_) {}
}

// Count products added this month
function monthlyProductCount(userId) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM products WHERE user_id=? AND added_at >= datetime('now','start of month')`).get(userId);
    return row ? row.cnt : 0;
}

// =====================================================
// USER SETTINGS (target sites + autoscan config)
// =====================================================
router.get('/settings', (req, res) => {
    const meta = getUserMeta(req.user.id);
    res.json({
        targetSites: meta.targetSites || [],
        lbpConvert:  meta.lbpConvert !== false,
        lbpRate:     meta.lbpRate    || 90000
    });
});

router.post('/settings', (req, res) => {
    const meta = getUserMeta(req.user.id);
    if (Array.isArray(req.body.targetSites))       meta.targetSites = req.body.targetSites;
    if (req.body.lbpConvert !== undefined)          meta.lbpConvert  = !!req.body.lbpConvert;
    if (req.body.lbpRate    !== undefined)          meta.lbpRate     = parseInt(req.body.lbpRate) || 90000;
    saveUserMeta(req.user.id, meta);
    res.json({ success: true });
});

// =====================================================
// ME / PROFILE
// =====================================================
router.get('/me', (req, res) => {
    const row = db.prepare(`SELECT id,username,role,status,products_limit,created_at,last_login FROM users WHERE id=?`).get(req.user.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
});

// =====================================================
// PRODUCTS
// =====================================================
router.get('/products', (req, res) => {
    const rows = db.prepare(`SELECT * FROM products WHERE user_id=? ORDER BY added_at DESC`).all(req.user.id);
    res.json(rows.map(p => ({ ...p, results: typeof p.results === 'string' ? JSON.parse(p.results||'{}') : (p.results||{}), active: p.active === 1 || p.active === true })));
});

router.post('/products', async (req, res) => {
    const { name, query, inputType, directLink } = req.body || {};
    if (!name && !query && !directLink) return res.status(400).json({ error: 'name or query required' });

    const uRow  = db.prepare(`SELECT products_limit FROM users WHERE id=?`).get(req.user.id);
    const limit = uRow?.products_limit ?? 20;
    const used  = monthlyProductCount(req.user.id);
    if (used >= limit) return res.status(403).json({ error: `Monthly product limit (${limit}) reached` });

    let resolvedQuery = query || name || directLink || '';
    let finalName = name || resolvedQuery;

    // AI Pre-Processing Layer: Expand ambiguous queries before saving
    if (resolvedQuery && !directLink && !resolvedQuery.startsWith('http')) {
        const aiSearch = getAiSearch();
        if (aiSearch && typeof aiSearch.expandSearchQuery === 'function') {
            try {
                const expanded = await aiSearch.expandSearchQuery(resolvedQuery);
                if (expanded) {
                    resolvedQuery = expanded;
                    if (!name) finalName = expanded; // Update name too if they didn't explicitly provide one
                }
            } catch (err) {
                console.error('[AI Expansion] Error:', err.message);
            }
        }
    }

    const info = db.prepare(
        `INSERT INTO products(user_id,name,query,input_type,direct_link) VALUES(?,?,?,?,?)`
    ).run(req.user.id, finalName, resolvedQuery, inputType||(directLink?'link':'query'), directLink||null);
    const product = db.prepare(`SELECT * FROM products WHERE rowid=?`).get(info.lastInsertRowid);
    logUsage(req.user.id, 'add_product', { name: product.name });
    res.json({ success: true, product: { ...product, results: {}, active: true } });
});

router.patch('/products/:id', (req, res) => {
    const { active, name, query } = req.body;
    const existing = db.prepare(`SELECT id FROM products WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (active !== undefined) db.prepare(`UPDATE products SET active=? WHERE id=?`).run(active ? 1 : 0, req.params.id);
    if (name   !== undefined) db.prepare(`UPDATE products SET name=? WHERE id=?`).run(name, req.params.id);
    if (query  !== undefined) db.prepare(`UPDATE products SET query=? WHERE id=?`).run(query, req.params.id);
    const updated = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);
    res.json({ success: true, product: { ...updated, results: typeof updated.results==='string' ? JSON.parse(updated.results||'{}') : {}, active: updated.active===1 } });
});

router.delete('/products/:id', (req, res) => {
    const info = db.prepare(`DELETE FROM products WHERE id=? AND user_id=?`).run(req.params.id, req.user.id);
    res.json({ success: true, removed: info.changes });
});

// =====================================================
// SCAN ONE PRODUCT — SSE streaming progress
// =====================================================
router.get('/products/:id/scan-stream', async (req, res) => {
    const raw = db.prepare(`SELECT * FROM products WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
    if (!raw) { res.status(404).end(); return; }
    const product = { ...raw, results: typeof raw.results==='string' ? JSON.parse(raw.results||'{}') : {} };
    const meta = getUserMeta(req.user.id);
    const targetSites = meta.targetSites || [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (type, data) => {
        try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch(_) {}
    };

    if (!targetSites.length) {
        send('error', { msg: 'No target sites configured. Go to Settings and add websites to monitor.' });
        res.end(); return;
    }

    send('start', { total: targetSites.length, sites: targetSites.map(u => u.replace(/[|+].*$/, '').trim()) });

    try {
        const newBySite = await scrapeQueue.add(() =>
            scanProductAcrossSites(product, targetSites, (site, status, price) => {
                send('progress', { site, status, price });
            })
        );
        await mergeAndSaveResults(product, newBySite, req.user.id);
        logUsage(req.user.id, 'scan', { productId: product.id, name: product.name });
        send('done', { results: newBySite });
    } catch (e) {
        console.error(`[UserScan] Error: ${e.message}`);
        send('error', { msg: e.message });
    }
    res.end();
});

// Keep old POST endpoint as no-op redirect for compatibility
router.post('/products/:id/scan', async (req, res) => {
    res.json({ success: true, message: 'Use GET /scan-stream for progress' });
});

// =====================================================
// SCAN SINGLE SITE FOR A PRODUCT — per-supplier refresh
// =====================================================
router.post('/products/:id/scan-site', async (req, res) => {
    const { site } = req.body;
    if (!site) return res.status(400).json({ error: 'Site name required' });

    const raw = db.prepare(`SELECT * FROM products WHERE id=? AND user_id=?`).get(req.params.id, req.user.id);
    if (!raw) return res.status(404).json({ error: 'Not found' });
    const product = { ...raw, results: typeof raw.results==='string' ? JSON.parse(raw.results||'{}') : {} };

    const meta = getUserMeta(req.user.id);
    const targetSites = meta.targetSites || [];
    const siteUrl = targetSites.find(u => u.includes(site) || site.includes(u.replace(/^https?:\/\//, '').split('/')[0]));
    if (!siteUrl) return res.status(400).json({ error: 'Site not in target list' });

    try {
        const rawResults = await scraper.scrapeMultipleURLs([siteUrl], product.query);
        const siteResults = rawResults.filter(r => (r.source || '').toLowerCase().includes(site.toLowerCase()));

        if (siteResults.length > 0) {
            const best = siteResults.sort((a, b) => (b.title?.length || 0) - (a.title?.length || 0))[0];
            const entry = {
                siteName: site,
                title: best.title || null,
                price: best.price || 'N/A',
                link: best.link || '#',
                status: (best.price && best.price !== 'N/A' && !/^Not found on/i.test(best.title||'')) ? 'found' : 'not_found',
                lastChecked: new Date().toLocaleString(),
                priceHistory: product.results?.[site]?.priceHistory || []
            };

            if (entry.price !== 'N/A' && entry.price !== (product.results?.[site]?.price || 'N/A')) {
                entry.priceHistory.push({ price: entry.price, date: entry.lastChecked });
            }

            const mergedResults = { ...product.results, [site]: entry };
            db.prepare(`UPDATE products SET results=?, last_checked=datetime('now') WHERE id=?`)
              .run(JSON.stringify(mergedResults), product.id);

            return res.json({ success: true, site: entry });
        }
        return res.json({ success: false, message: 'No results found' });
    } catch (e) {
        console.error(`[ScanSite] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =====================================================
// ALERTS
// =====================================================
router.get('/alerts', (req, res) => {
    const rows = db.prepare(`SELECT * FROM alerts WHERE user_id=? ORDER BY created_at DESC LIMIT 200`).all(req.user.id);
    res.json(rows.map(a => {
        const data = typeof a.data==='string' ? JSON.parse(a.data||'{}') : (a.data||{});
        return { ...data, id: a.id, type: a.type, seen: a.seen===1, timestamp: a.created_at };
    }));
});

router.post('/alerts/seen', (req, res) => {
    db.prepare(`UPDATE alerts SET seen=1 WHERE user_id=?`).run(req.user.id);
    res.json({ success: true });
});

router.delete('/alerts', (req, res) => {
    db.prepare(`DELETE FROM alerts WHERE user_id=?`).run(req.user.id);
    res.json({ success: true });
});

router.get('/alerts/unseen-count', (req, res) => {
    const row = db.prepare(`SELECT COUNT(*) AS cnt, MAX(CASE WHEN type='price_drop' THEN 1 ELSE 0 END) AS has_drops FROM alerts WHERE user_id=? AND seen=0 AND type!='scan_summary'`).get(req.user.id);
    res.json({ count: row.cnt, hasDrops: row.has_drops===1 });
});

// =====================================================
// AUTO-SCAN (per-user timer stored in settings column)
// For simplicity the per-user interval is stored in users table as a JSON note.
// The global auto-scan engine in server.js iterates all active users.
// These endpoints just read/write the user's preferred interval.
// =====================================================
router.get('/autoscan/status', (req, res) => {
    const scanMeta = getUserMeta(req.user.id);
    res.json({
        enabled: !!scanMeta.autoScanEnabled,
        intervalHours: scanMeta.autoScanInterval || 0,
        lastRun: scanMeta.lastScan || null,
        running: false
    });
});

router.post('/autoscan/set', (req, res) => {
    const hours = parseFloat(req.body.intervalHours) || 0;
    const meta  = getUserMeta(req.user.id);
    meta.autoScanEnabled  = hours > 0;
    meta.autoScanInterval = hours;
    saveUserMeta(req.user.id, meta);
    res.json({ success: true, intervalHours: hours, enabled: hours > 0 });
});

router.post('/autoscan/run-now', async (req, res) => {
    const rawRows = db.prepare(`SELECT * FROM products WHERE user_id=? AND active=1`).all(req.user.id);
    if (!rawRows.length) return res.json({ success: false, message: 'No active products' });
    const rows = rawRows.map(p => ({ ...p, results: typeof p.results==='string' ? JSON.parse(p.results||'{}') : {} }));
    res.json({ success: true, message: 'Scan started' });

    const uid = req.user.id;
    (async () => {
        const meta = getUserMeta(uid);
        const targetSites = meta.targetSites || [];
        for (const product of rows) {
            try {
                const newBySite = await scrapeQueue.add(() => scanProductAcrossSites(product, targetSites));
                await mergeAndSaveResults(product, newBySite, uid);
                logUsage(uid, 'scan', { productId: product.id });
            } catch (e) { console.error(`[AutoScan:${uid}] ${e.message}`); }
        }
        meta.lastScan = new Date().toLocaleString();
        saveUserMeta(uid, meta);
    })();
});

// =====================================================
// SHARED SCRAPE HELPERS
// =====================================================

// Lazy-load AI search utilities (may not be available if no API keys configured)
let _aiSearch = null;
function getAiSearch() {
    if (_aiSearch === undefined) return null;
    if (!_aiSearch) {
        try { _aiSearch = require('../services/ai-search'); } catch(_) { _aiSearch = undefined; }
    }
    return _aiSearch || null;
}

async function scanProductAcrossSites(product, targetSites, onProgress = () => {}) {
    const urlList = (targetSites || []).map(u => u.trim()).filter(Boolean);
    if (!urlList.length) return {};

    if (product.input_type === 'link' && product.direct_link) {
        const r = await scraper.scrapeProductPage(product.direct_link);
        let siteName;
        try { siteName = new URL(product.direct_link).hostname.replace(/^www\./, ''); }
        catch(_) { siteName = product.direct_link; }
        return {
            [siteName]: {
                siteName,
                title: r.title || product.name,
                price: r.price || 'N/A',
                link: product.direct_link,
                status: r.available === false ? 'unavailable' : (r.price ? 'found' : 'not_found'),
                lastChecked: new Date().toLocaleString()
            }
        };
    }

    const rawResults = await scraper.scrapeMultipleURLs(urlList, product.query);

    // Group all results by site
    const grouped = {};
    for (const item of rawResults) {
        const site = item.source || 'Unknown';
        if (!grouped[site]) grouped[site] = [];
        grouped[site].push(item);
    }

    // For each site, pick the most relevant result
    const kw = (product.query || product.name || '').toLowerCase().trim();
    const kwTokens = kw.split(/\s+/).filter(Boolean);

    function relevanceScore(item) {
        const title = (item.title || '').toLowerCase();
        const isError = /^(No results found|Error scraping)/i.test(title);
        if (isError) return -1;
        if (!item.price || item.price === 'N/A') return 0;
        // Normalized model-number match (e.g., "rtx5070" matches "rtx 5070" in title)
        const normalize = (s) => s.toLowerCase().replace(/[\s\-_.]/g, '');
        const normKw = normalize(kw);
        const normTitle = normalize(title);
        let score = 0;
        // Strong bonus for exact model-number match
        if (normKw.length >= 4 && normTitle.includes(normKw)) score += 20;
        // Token matching
        const matches = kwTokens.filter(t => title.includes(t)).length;
        score += matches * 3;
        return score;
    }

    // Try AI validation for better accuracy (if providers are configured)
    const aiSearch = getAiSearch();
    let aiScores = null;
    if (aiSearch) {
        try {
            const validItems = rawResults.filter(r => !/^(No results found|Error scraping)/i.test(r.title || ''));
            if (validItems.length > 0) {
                const ranked = await aiSearch.aiRankProducts(validItems, product.query || product.name);
                aiScores = new Map();
                for (const r of ranked) {
                    const key = `${r.source}||${r.title}`;
                    aiScores.set(key, r.aiScore || 0);
                }
                console.log(`[AI] Validated ${validItems.length} results for "${product.query}"`);
            }
        } catch (e) {
            console.warn(`[AI] Ranking failed, using rule-based: ${e.message}`);
        }
    }

    const bySite = {};
    for (const [site, items] of Object.entries(grouped)) {
        const sorted = [...items].sort((a, b) => relevanceScore(b) - relevanceScore(a));
        const best = sorted[0];
        const isError = /^(No results found|Not found on|Error scraping)/i.test(best.title || '');
        const score = relevanceScore(best);

        // Check AI score if available — reject if AI says it's not a match
        let aiRejected = false;
        if (aiScores && !isError && score > 0) {
            const aiKey = `${best.source}||${best.title}`;
            const aiScore = aiScores.get(aiKey);
            if (aiScore !== undefined && aiScore < 30) {
                console.log(`[AI] Rejected "${best.title}" (aiScore=${aiScore}) for "${product.query}"`);
                aiRejected = true;
            }
        }

        // CRITICAL FIX: score <= 0 means NO keyword overlap — the product is WRONG, not "found"
        // Previously score < 0 let through score=0 products (e.g., Razer Barracuda for Logitech H570e)
        const isNotRelevant = isError || score <= 0 || aiRejected;
        const entry = {
            siteName: site,
            title:  isNotRelevant ? null : best.title,
            price:  isNotRelevant ? 'N/A' : (best.price || 'N/A'),
            link:   best.link || '#',
            status: isNotRelevant ? 'not_found' : 'found',
            lastChecked: new Date().toLocaleString()
        };
        bySite[site] = entry;
        onProgress(site, entry.status, entry.price, entry.title);
    }
    return bySite;
}

/** Extract the base numeric price from a price string that may include TVA annotations */
function extractBasePrice(priceStr) {
    if (!priceStr || priceStr === 'N/A' || priceStr === 'Price not available') return 0;
    const s = String(priceStr);
    // If TVA annotation present, extract the "Base:" value
    const baseMatch = s.match(/Base:\s*[^\d]*([\d,]+(?:\.\d{1,2})?)/i);
    if (baseMatch) return parseFloat(baseMatch[1].replace(/,/g, '')) || 0;
    // Otherwise extract the first numeric value
    const num = parseFloat(s.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? 0 : num;
}

async function mergeAndSaveResults(product, newBySite, userId) {
    const old = product.results || {};

    for (const [site, fresh] of Object.entries(newBySite)) {
        const prev     = old[site];
        const oldPrice = prev ? prev.price : null;

        if (!prev) {
            old[site] = { ...fresh, priceHistory: [{ price: fresh.price, date: fresh.lastChecked }] };
        } else {
            const oldNum = extractBasePrice(oldPrice);
            const newNum = extractBasePrice(fresh.price);

            if (newNum > 0 && oldNum > 0 && Math.abs(newNum - oldNum) > 0.01) {
                const diff = newNum - oldNum;
                const pct  = ((diff / oldNum) * 100).toFixed(1);
                const type = diff < 0 ? 'price_drop' : 'price_rise';
                db.prepare(`INSERT INTO alerts(user_id,product_id,type,data) VALUES(?,?,?,?)`)
                  .run(userId, product.id, type, JSON.stringify({
                      productId: product.id, productName: product.name, site,
                      oldPrice, newPrice: fresh.price, diff: Math.abs(diff).toFixed(2), pct
                  }));
            }

            prev.title       = fresh.title || prev.title;
            prev.price       = fresh.price;
            prev.link        = fresh.link  || prev.link;
            prev.status      = fresh.status;
            prev.lastChecked = fresh.lastChecked;
            if (!prev.priceHistory) prev.priceHistory = [];
            if (Math.abs(newNum - oldNum) > 0.01) prev.priceHistory.push({ price: fresh.price, date: fresh.lastChecked });
        }
    }

    db.prepare(`UPDATE products SET results=?, last_checked=datetime('now') WHERE id=?`)
      .run(JSON.stringify(old), product.id);
}

module.exports = { router, scrapeQueue, scanProductAcrossSites, mergeAndSaveResults };

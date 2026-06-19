const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const scraper = require('./scraper');

const app = express();
const PORT = 8515;
const DATA_FILE = path.join(process.cwd(), 'data.json');
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
const ALERTS_FILE = path.join(process.cwd(), 'alerts.json');

// ===========================
// AUTO-SCAN STATE
// ===========================
let autoScanTimer = null;
let autoScanRunning = false;
let lastAutoScanTime = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===========================
// HEARTBEAT — keeps UI "alive" indicator green (server runs FOREVER)
// ===========================
app.get('/api/heartbeat', (req, res) => {
    res.json({ alive: true });
});
// NOTE: Auto-shutdown on tab-close has been intentionally removed.
// The server runs permanently. Use pm2 to manage the process.

// CRASH PROTECTION — never die from uncaught errors
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception (kept alive):', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled Rejection (kept alive):', err && err.message ? err.message : err);
});

// ===========================
// SCRAPE QUEUE — prevents overlapping browser sessions
// ===========================
class ScrapeQueue {
    constructor(concurrency = 2) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async add(fn) {
        if (this.running >= this.concurrency) {
            // Wait until a slot is free
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next();
            }
        }
    }
}

const scrapeQueue = new ScrapeQueue(2); // Allow max 2 concurrent scrape jobs

// --- Helpers ---
function loadData() {
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) { return []; }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function loadSettings() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return { watchlist: [], autoScanInterval: 0 };
    }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ===========================
// ALERT LOG HELPERS
// ===========================
function loadAlerts() {
    try {
        const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) { return []; }
}

function saveAlerts(alerts) {
    // Keep only the last 200 alerts to avoid unbounded growth
    const trimmed = alerts.slice(0, 200);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(trimmed, null, 2));
}

function pushAlert(alert) {
    const alerts = loadAlerts();
    alerts.unshift({
        ...alert,
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        timestamp: new Date().toLocaleString(),
        seen: false
    });
    saveAlerts(alerts);
}

// ===========================
// AUTO-SCAN ENGINE
// ===========================
let autoScanProgress = { total: 0, done: 0 };

async function runWatchlistCheck() {
    if (autoScanRunning) {
        console.log('[AutoScan] Already running, skipping this tick');
        return;
    }
    autoScanRunning = true;
    lastAutoScanTime = new Date().toLocaleString();
    console.log(`[AutoScan] Starting scheduled watchlist check at ${lastAutoScanTime}`);

    try {
        const settings = loadSettings();
        const watchlist = settings.watchlist || [];
        if (watchlist.length === 0) {
            console.log('[AutoScan] Watchlist empty, nothing to check');
            return;
        }

        autoScanProgress.total = watchlist.length;
        autoScanProgress.done = 0;

        const changes = [];

        for (const item of watchlist) {
            try {
                const result = await scrapeQueue.add(async () => {
                    return await scraper.scrapeProductPage(item.link);
                });

                item.lastChecked = new Date().toLocaleString();

                if (!result.available) {
                    if (item.status !== 'removed') {
                        item.status = 'removed';
                        const alert = {
                            type: 'removed',
                            itemId: item.id,
                            title: item.title,
                            source: item.source,
                            link: item.link
                        };
                        changes.push(alert);
                        pushAlert(alert);
                        console.log(`[AutoScan] REMOVED: ${item.title}`);
                    }
                } else if (result.price) {
                    const oldNum = parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0;
                    const newNum = parseFloat(String(result.price).replace(/[^0-9.]/g, '')) || 0;

                    if (result.price !== item.price && newNum > 0) {
                        const diff = newNum - oldNum;
                        const pct = oldNum > 0 ? ((diff / oldNum) * 100).toFixed(1) : '0';
                        const type = diff < 0 ? 'price_drop' : 'price_rise';

                        const alert = {
                            type,
                            itemId: item.id,
                            title: item.title,
                            source: item.source,
                            link: item.link,
                            oldPrice: item.price,
                            newPrice: result.price,
                            diff: diff.toFixed(2),
                            pct
                        };
                        changes.push(alert);
                        pushAlert(alert);
                        console.log(`[AutoScan] ${type.toUpperCase()}: ${item.title} — ${item.price} → ${result.price} (${pct}%)`);

                        item.price = result.price;
                        item.priceHistory.push({ price: result.price, date: new Date().toLocaleString() });
                    }
                    item.status = 'active';
                }
            } catch (e) {
                console.error(`[AutoScan] Error checking ${item.link}: ${e.message}`);
            }
            autoScanProgress.done++;
        }

        saveSettings(settings);

        // Push scan summary to alert log
        const drops   = changes.filter(c => c.type === 'price_drop').length;
        const rises   = changes.filter(c => c.type === 'price_rise').length;
        const removed = changes.filter(c => c.type === 'removed').length;

        pushAlert({
            type: 'scan_summary',
            title: `Auto-scan: checked ${watchlist.length} item${watchlist.length !== 1 ? 's' : ''}`,
            summary: drops > 0 || rises > 0 || removed > 0
                ? `${drops} drop${drops !== 1 ? 's' : ''}, ${rises} rise${rises !== 1 ? 's' : ''}, ${removed} removed`
                : 'No price changes found',
            drops,
            rises,
            removed,
            checked: watchlist.length,
            seen: false
        });

        console.log(`[AutoScan] Done. ${changes.length} change(s) detected across ${watchlist.length} item(s).`);
    } catch (e) {
        console.error(`[AutoScan] Fatal error: ${e.message}`);
    } finally {
        autoScanRunning = false;
        autoScanProgress = { total: 0, done: 0 };
    }
}

function startAutoScan(intervalHours) {
    if (autoScanTimer) {
        clearInterval(autoScanTimer);
        autoScanTimer = null;
    }
    if (!intervalHours || intervalHours <= 0) {
        console.log('[AutoScan] Disabled (interval = 0)');
        return;
    }
    const ms = intervalHours * 60 * 60 * 1000;
    console.log(`[AutoScan] Scheduled every ${intervalHours}h (${ms}ms)`);
    // Run once immediately on enable, then on interval
    runWatchlistCheck();
    autoScanTimer = setInterval(runWatchlistCheck, ms);
}

// Boot: restore auto-scan if it was previously set
(function initAutoScan() {
    try {
        const settings = loadSettings();
        if (settings.autoScanInterval && settings.autoScanInterval > 0) {
            console.log(`[AutoScan] Restoring scheduled scan every ${settings.autoScanInterval}h`);
            startAutoScan(settings.autoScanInterval);
        }
    } catch (e) {
        console.error('[AutoScan] Init error:', e.message);
    }
})();

function resultKey(item) {
    const source = item && item.source ? String(item.source) : '';
    const link = item && item.link ? String(item.link) : '';
    const title = item && item.title ? String(item.title) : '';
    return `${source}::${link || title}`;
}

function dedupeByKey(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
        const key = resultKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

// --- API: Get all scraped data ---
app.get('/api/data', (req, res) => {
    res.json(loadData());
});

// --- API: Save data ---
app.post('/api/data', (req, res) => {
    saveData(req.body);
    res.json({ success: true });
});

// --- API: Delete single item ---
app.delete('/api/data/:index', (req, res) => {
    const data = loadData();
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < data.length) {
        data.splice(idx, 1);
        saveData(data);
        res.json({ success: true, remaining: data.length });
    } else {
        res.status(400).json({ error: 'Invalid index' });
    }
});

// --- API: Clear all data ---
app.delete('/api/data', (req, res) => {
    saveData([]);
    res.json({ success: true });
});

// --- API: Run a scrape (with queue) ---
app.post('/api/scrape', async (req, res) => {
    let timerID = Date.now();
    try {
        const { query, source, maxItems, urls } = req.body;
        console.log(`[API] [${timerID}] Request queued: Source=${source}, Query="${query || ''}", URLs=${urls ? urls.length : 0}`);

        // Hard timeout: 90 seconds max — never hang the UI forever
        const SCRAPE_TIMEOUT = 90000;
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Scrape timed out after 90 seconds')), SCRAPE_TIMEOUT)
        );

        const results = await Promise.race([
            scrapeQueue.add(async () => {
                console.log(`[API] [${timerID}] Scrape started (queue slot acquired)`);
                let results;

                if (source === 'All') {
                    console.log(`[API] [${timerID}] Scraping ALL platforms...`);
                    const queries = [];
                    queries.push(scraper.scrapePlatform('OLX', query, 10));
                    queries.push(scraper.scrapePlatform('Facebook', query, 10));
                    
                    // For Custom/Target Links
                    const settings = loadSettings();
                    const savedUrls = settings.customUrls || []; 
                    if (savedUrls.length > 0) {
                        const rawUrls = savedUrls.map(u => {
                            let url = u.trim();
                            if (!url.startsWith('http')) url = 'https://' + url;
                            return url;
                        });
                        queries.push(scraper.scrapeMultipleURLs(rawUrls, query));
                    }
                    
                    const allRes = await Promise.all(queries);
                    results = allRes.flat();
                } else if (source === 'Custom' && urls && urls.length > 0) {
                    const rawUrls = urls.map(u => {
                        let url = u.trim();
                        if (!url.startsWith('http')) url = 'https://' + url;
                        return url;
                    });
                    console.log(`[API] [${timerID}] Scraping ${rawUrls.length} custom URLs...`);
                    results = await scraper.scrapeMultipleURLs(rawUrls, query);
                } else {
                    console.log(`[API] [${timerID}] Scraping platform: ${source}...`);
                    results = await scraper.scrapePlatform(source, query, maxItems || 10);
                }

                return results;
            }),
            timeoutPromise
        ]);

        console.log(`[API] [${timerID}] Scraping finished. Found ${results.length} items.`);
        
        // Smart Filtering — only for OLX/Facebook sources, not Custom
        let filteredResults = results;
        if (source !== 'Custom' && source !== 'All' && query && query.toLowerCase() !== 'custom urls' && results.length > 0) {
            // Use at most the first 3 meaningful tokens to avoid over-filtering
            const qTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 3);
            if (qTokens.length > 0) {
                const before = results.length;
                filteredResults = results.filter(item => {
                    const titleLower = (item.title || '').toLowerCase();
                    // Require at least 1 token match (was: some — but keeping permissive)
                    return qTokens.some(t => titleLower.includes(t)) ||
                           titleLower.includes('no results') ||
                           titleLower.includes('marketplace');
                });
                // Fail open: if filtering eliminated everything, keep originals
                if (filteredResults.length === 0) filteredResults = results;
                console.log(`[API] [${timerID}] Smart Filter: Kept ${filteredResults.length}/${before} relevant results.`);
            }
        }
        
        // Universal LBP to USD Conversion (divide by 90000)
        filteredResults.forEach(item => {
            if (item.price && item.price.toUpperCase() !== 'N/A') {
                const upperPrice = item.price.toUpperCase();
                // Find all digits and dots/commas
                const rawStr = item.price.replace(/[^\d.]/g, '');
                const numVal = parseFloat(rawStr);
                
                // Exclude matches that are already marked as USD or $. If it says LBP, LL, or is just a huge unlabelled number, convert.
                if (!isNaN(numVal) && numVal > 0) {
                    if (upperPrice.includes('LBP') || upperPrice.includes('LL') || (numVal > 50000 && !upperPrice.includes('$') && !upperPrice.includes('USD'))) {
                        const usdAmount = numVal / 90000.0;
                        item.price = `$${usdAmount.toFixed(2)}`;
                    }
                }
            }
        });

        if (!filteredResults || filteredResults.length === 0) {
            return res.json({ success: true, count: 0, results: [] });
        }

        // Load existing, prepend new results (newest first)
        const existing = loadData();
        const updated = dedupeByKey([...filteredResults, ...existing]);
        saveData(updated);

        res.json({ success: true, count: filteredResults.length, results: filteredResults });
    } catch (error) {
        console.error(`[API] [${timerID}] Fatal Error:`, error.message);
        res.status(500).json({ error: error.message, results: [] });
    }
});

// --- API: Run a scrape and STREAM results ---
app.post('/api/scrape/stream', async (req, res) => {
    let timerID = Date.now();
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        const { query, source, maxItems, urls } = req.body;
        console.log(`[STREAM API] [${timerID}] Request queued: Source=${source}, Query="${query || ''}"`);

        // Setup filter tokens
        let qTokens = [];
        if (source !== 'Custom' && source !== 'All' && query && query.toLowerCase() !== 'custom urls') {
            qTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 3);
        }

        const handleProgress = (currentBatch, msg) => {
            if (msg) res.write(JSON.stringify({ type: 'progress', message: msg }) + '\n');
            
            if (currentBatch && currentBatch.length > 0) {
                // Apply LBP->USD conversion for streamed items
                currentBatch.forEach(item => {
                    if (item.price && item.price.toUpperCase() !== 'N/A') {
                        const upperPrice = item.price.toUpperCase();
                        const rawStr = item.price.replace(/[^\d.]/g, '');
                        const numVal = parseFloat(rawStr);
                        if (!isNaN(numVal) && numVal > 0) {
                            if (upperPrice.includes('LBP') || upperPrice.includes('LL') || (numVal > 50000 && !upperPrice.includes('$') && !upperPrice.includes('USD'))) {
                                item.price = `$${(numVal / 90000.0).toFixed(2)}`;
                            }
                        }
                    }
                });

                // Apply Filters for streamed items
                let filtered = currentBatch;
                if (qTokens.length > 0) {
                    filtered = currentBatch.filter(item => {
                        const titleLower = (item.title || '').toLowerCase();
                        return qTokens.some(t => titleLower.includes(t)) || titleLower.includes('no results') || titleLower.includes('marketplace');
                    });
                    if (filtered.length === 0) filtered = currentBatch;
                }

                if (filtered.length > 0) {
                    res.write(JSON.stringify({ type: 'data', results: filtered }) + '\n');
                }
            }
        };

        const SCRAPE_TIMEOUT = 180000; // Expanded to 3 mins for massive lists
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Scrape timed out after 180 seconds')), SCRAPE_TIMEOUT)
        );

        const results = await Promise.race([
            scrapeQueue.add(async () => {
                let finalRes;
                if (source === 'All') {
                    const queries = [];
                    queries.push(scraper.scrapePlatform('OLX', query, 10, handleProgress));
                    queries.push(scraper.scrapePlatform('Facebook', query, 10, handleProgress));
                    
                    const settings = loadSettings();
                    const savedUrls = settings.customUrls || []; 
                    if (savedUrls.length > 0) {
                        const rawUrls = savedUrls.map(u => {
                            let url = u.trim();
                            if (!url.startsWith('http')) url = 'https://' + url;
                            return url;
                        });
                        queries.push(scraper.scrapeMultipleURLs(rawUrls, query, handleProgress));
                    }
                    const allRes = await Promise.all(queries);
                    finalRes = allRes.flat();
                } else if (source === 'Custom' && urls && urls.length > 0) {
                    const rawUrls = urls.map(u => {
                        let url = u.trim();
                        if (!url.startsWith('http')) url = 'https://' + url;
                        return url;
                    });
                    finalRes = await scraper.scrapeMultipleURLs(rawUrls, query, handleProgress);
                } else {
                    finalRes = await scraper.scrapePlatform(source, query, maxItems || 10, handleProgress);
                }
                return finalRes;
            }),
            timeoutPromise
        ]);

        console.log(`[API] [${timerID}] Stream Scraping finished. Found ${results.length} items overall.`);
        
        let filteredResults = results;
        if (qTokens.length > 0) {
            const before = results.length;
            filteredResults = results.filter(item => {
                const titleLower = (item.title || '').toLowerCase();
                return qTokens.some(t => titleLower.includes(t)) || titleLower.includes('no results') || titleLower.includes('marketplace');
            });
            if (filteredResults.length === 0) filteredResults = results;
        }
        
        filteredResults.forEach(item => {
            if (item.price && item.price.toUpperCase() !== 'N/A') {
                const upperPrice = item.price.toUpperCase();
                const rawStr = item.price.replace(/[^\d.]/g, '');
                const numVal = parseFloat(rawStr);
                if (!isNaN(numVal) && numVal > 0) {
                    if (upperPrice.includes('LBP') || upperPrice.includes('LL') || (numVal > 50000 && !upperPrice.includes('$') && !upperPrice.includes('USD'))) {
                        item.price = `$${(numVal / 90000.0).toFixed(2)}`;
                    }
                }
            }
        });

        if (filteredResults && filteredResults.length > 0) {
            const existing = loadData();
            const updated = dedupeByKey([...filteredResults, ...existing]);
            saveData(updated);
            res.write(JSON.stringify({ type: 'done', count: filteredResults.length }) + '\n');
        } else {
            res.write(JSON.stringify({ type: 'done', count: 0 }) + '\n');
        }

    } catch (error) {
        console.error(`[STREAM API] Fatal Error:`, error.message);
        res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n');
    } finally {
        res.end();
    }
});

// --- API: Get stats ---
app.get('/api/stats', (req, res) => {
    const data = loadData();
    const sources = {};
    const priceHistory = {};

    data.forEach(item => {
        sources[item.source] = (sources[item.source] || 0) + 1;

        const key = (item.title || '').substring(0, 50);
        if (!priceHistory[key]) priceHistory[key] = [];
        priceHistory[key].push({
            price: item.price,
            date: item.dateScraped,
            source: item.source
        });
    });

    const priceChanges = [];
    for (const [title, history] of Object.entries(priceHistory)) {
        if (history.length > 1) {
            const prices = history.map(h => parseFloat(String(h.price).replace(/[^0-9.]/g, '')) || 0).filter(p => p > 0);
            if (prices.length > 1) {
                const latest = prices[0];
                const previous = prices[1];
                const change = latest - previous;
                if (change !== 0) {
                    const changePct = previous > 0 ? ((change / previous) * 100).toFixed(1) : 0;
                    priceChanges.push({ title, latest, previous, change, changePct, history });
                }
            }
        }
    }

    res.json({
        totalItems: data.length,
        sources,
        priceChanges,
        recentScans: data.slice(0, 5).map(d => ({ title: d.title, date: d.dateScraped, source: d.source }))
    });
});

// --- PRETTY RENDER HTML ---
function renderExportPage(title, items, type) {
    let contentHtml = '';
    
    if (type === 'csv') {
        const rows = items.map(item => `
            <tr>
                <td style="color:#94a3b8;font-size:0.85rem">${item.dateScraped || ''}</td>
                <td><span style="background:rgba(56,189,248,0.15);color:#38bdf8;padding:4px 8px;border-radius:6px;font-size:0.8rem;font-weight:600">${item.source}</span></td>
                <td style="font-weight:600;max-width:300px">${item.title}</td>
                <td style="color:#34d399;font-weight:700">${item.price}</td>
                <td>${item.seller || '—'}</td>
                <td><a href="${item.link}" target="_blank" style="color:#818cf8;text-decoration:none"><i class="fa-solid fa-link"></i></a></td>
            </tr>
        `).join('');
        contentHtml = `
            <table class="data-table">
                <thead><tr><th>Date</th><th>Source</th><th>Title</th><th>Price</th><th>Seller</th><th>Link</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    } else {
        const rows = items.map(item => `
            <div class="json-card">
                <div style="margin-bottom:8px"><span style="background:rgba(56,189,248,0.15);color:#38bdf8;padding:4px 8px;border-radius:6px;font-size:0.8rem;font-weight:600">${item.source}</span></div>
                <div style="font-weight:600;margin-bottom:8px">${item.title}</div>
                <div style="color:#34d399;font-weight:700;margin-bottom:8px">${item.price}</div>
                <div style="color:#94a3b8;font-size:0.85rem;margin-bottom:8px">Seller: ${item.seller || '—'}</div>
                <div><a href="${item.link}" target="_blank" style="color:#818cf8;text-decoration:none">View Product</a></div>
            </div>
        `).join('');
        contentHtml = `<div class="json-grid">${rows}</div>`;
    }

    const rawData = type === 'csv' 
        ? ['Date,Source,Query,Title,Seller,Price,Link'].concat(items.map(i => `"${i.dateScraped}","${i.source}","${(i.query||'').replace(/"/g,'""')}","${(i.title||'').replace(/"/g,'""')}","${(i.seller||'').replace(/"/g,'""')}","${i.price}","${i.link}"`)).join('\\n')
        : JSON.stringify(items, null, 2);

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>${title} — Competitor Monitor</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
        <style>
            body { background: #0a0e1a; color: #f1f5f9; font-family: 'Inter', sans-serif; margin: 0; padding: 2rem; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; background: rgba(17, 24, 39, 0.7); padding: 1.5rem; border-radius: 16px; border: 1px solid rgba(99,179,237,0.15); backdrop-filter: blur(10px); }
            h1 { margin: 0; font-size: 1.5rem; font-weight: 800; background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .btn-group { display: flex; gap: 10px; }
            .btn { padding: 10px 18px; border-radius: 8px; border: none; font-weight: 600; font-family: 'Inter'; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem; transition: all 0.2s; color: white; }
            .btn-copy { background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); color: #38bdf8; }
            .btn-copy:hover { background: rgba(56,189,248,0.25); }
            .btn-download { background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%); }
            .btn-download:hover { opacity: 0.9; transform: translateY(-1px); }
            .data-table { width: 100%; border-collapse: collapse; background: rgba(17, 24, 39, 0.5); border-radius: 12px; overflow: hidden; border: 1px solid rgba(99,179,237,0.1); }
            .data-table th { background: rgba(15, 23, 42, 0.9); padding: 1rem; text-align: left; font-size: 0.8rem; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; border-bottom: 1px solid rgba(99,179,237,0.1); }
            .data-table td { padding: 1rem; border-bottom: 1px solid rgba(99,179,237,0.05); font-size: 0.9rem; }
            .data-table tr:hover { background: rgba(56,189,248,0.03); }
            .json-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
            .json-card { background: rgba(17, 24, 39, 0.5); padding: 1.5rem; border-radius: 12px; border: 1px solid rgba(99,179,237,0.1); transition: transform 0.2s; }
            .json-card:hover { transform: translateY(-2px); border-color: rgba(99,179,237,0.3); }
            #rawData { display: none; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1><i class="fa-solid fa-file-${type === 'csv' ? 'csv' : 'code'}"></i> ${title}</h1>
            <div class="btn-group">
                <button class="btn btn-copy" onclick="copyData(this)"><i class="fa-solid fa-copy"></i> Copy Raw Data</button>
                <button class="btn btn-download" onclick="downloadFile()"><i class="fa-solid fa-download"></i> Download File</button>
            </div>
        </div>
        
        ${contentHtml}

        <textarea id="rawData">${rawData.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>

        <script>
            function copyData(btn) {
                const text = document.getElementById('rawData').value;
                navigator.clipboard.writeText(text);
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                setTimeout(() => btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Raw Data', 2000);
            }
            function downloadFile() {
                const blob = new Blob([document.getElementById('rawData').value], { type: 'text/${type === 'csv' ? 'csv' : 'plain'};charset=utf-8;' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'competitor_data.${type}';
                link.click();
            }
        </script>
    </body>
    </html>
    `;
}

// --- API: Export as CSV (view in browser) ---
app.get('/api/export/csv', (req, res) => {
    const data = loadData();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderExportPage('Data Report (CSV View)', data, 'csv'));
});

// --- API: Export as JSON (view in browser) ---
app.get('/api/export/json', (req, res) => {
    const data = loadData();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderExportPage('Data Report (JSON View)', data, 'json'));
});

// --- API: Settings ---
app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
    saveSettings(req.body);
    res.json({ success: true });
});

// --- API: Watchlist (individual product items) ---
app.get('/api/watchlist', (req, res) => {
    const settings = loadSettings();
    res.json(settings.watchlist || []);
});

// Add multiple items to watchlist at once (from selected search results)
app.post('/api/watchlist/batch', (req, res) => {
    const settings = loadSettings();
    if (!settings.watchlist) settings.watchlist = [];
    const items = req.body.items || [];
    let added = 0;

    for (const item of items) {
        // Skip duplicates by link
        const exists = settings.watchlist.some(w => w.link === item.link);
        if (exists) continue;
        settings.watchlist.push({
            id: (Date.now() + added).toString(36) + Math.random().toString(36).substr(2, 4),
            title: item.title || 'Unknown',
            price: item.price || 'N/A',
            link: item.link || '#',
            source: item.source || 'Unknown',
            seller: item.seller || '',
            addedAt: new Date().toLocaleString(),
            lastChecked: null,
            priceHistory: [{ price: item.price || 'N/A', date: new Date().toLocaleString() }],
            status: 'active'
        });
        added++;
    }

    saveSettings(settings);
    res.json({ success: true, added, total: settings.watchlist.length });
});

// Add single item
app.post('/api/watchlist', (req, res) => {
    const settings = loadSettings();
    if (!settings.watchlist) settings.watchlist = [];
    const { title, price, link, source, seller } = req.body;

    const exists = settings.watchlist.some(w => w.link === link);
    if (exists) return res.json({ success: false, message: 'Already in watchlist' });

    settings.watchlist.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        title: title || 'Unknown',
        price: price || 'N/A',
        link: link || '#',
        source: source || 'Unknown',
        seller: seller || '',
        addedAt: new Date().toLocaleString(),
        lastChecked: null,
        priceHistory: [{ price: price || 'N/A', date: new Date().toLocaleString() }],
        status: 'active'
    });
    saveSettings(settings);
    res.json({ success: true, watchlist: settings.watchlist });
});

app.delete('/api/watchlist/:id', (req, res) => {
    const settings = loadSettings();
    settings.watchlist = (settings.watchlist || []).filter(w => w.id !== req.params.id);
    saveSettings(settings);
    res.json({ success: true });
});

// Clear entire watchlist
app.delete('/api/watchlist', (req, res) => {
    const settings = loadSettings();
    settings.watchlist = [];
    saveSettings(settings);
    res.json({ success: true });
});

// --- API: Check watchlist items for price changes ---
app.post('/api/watchlist/check', async (req, res) => {
    const settings = loadSettings();
    const watchlist = settings.watchlist || [];
    if (watchlist.length === 0) return res.json({ success: true, changes: [], checked: 0 });

    const changes = [];

    for (const item of watchlist) {
        try {
            const result = await scrapeQueue.add(async () => {
                return await scraper.scrapeProductPage(item.link);
            });

            item.lastChecked = new Date().toLocaleString();

            if (!result.available) {
                if (item.status !== 'removed') {
                    item.status = 'removed';
                    const alert = { type: 'removed', itemId: item.id, title: item.title, source: item.source, link: item.link };
                    changes.push(alert);
                    pushAlert(alert);
                }
            } else if (result.price) {
                const oldNum = parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0;
                const newNum = parseFloat(String(result.price).replace(/[^0-9.]/g, '')) || 0;

                if (result.price !== item.price && newNum > 0) {
                    const diff = newNum - oldNum;
                    
                    if (diff !== 0) {
                        const pct = oldNum > 0 ? ((Math.abs(diff) / oldNum) * 100).toFixed(1) : '0';
                        const type = diff < 0 ? 'price_drop' : 'price_rise';

                        const alert = {
                            type,
                            itemId: item.id,
                            title: item.title,
                            source: item.source,
                            link: item.link,
                            oldPrice: item.price,
                            newPrice: result.price,
                            diff: Math.abs(diff).toFixed(2),
                            pct
                        };
                        changes.push(alert);
                        pushAlert(alert);
                    }

                    item.price = result.price;
                    item.priceHistory.push({ price: result.price, date: new Date().toLocaleString() });
                }
                item.status = 'active';
            }
        } catch (e) {
            console.error(`[WatchlistCheck] Error checking ${item.link}: ${e.message}`);
        }
    }

    saveSettings(settings);

    // Always push a scan summary log entry — so the Alert Log shows every run
    const drops   = changes.filter(c => c.type === 'price_drop').length;
    const rises   = changes.filter(c => c.type === 'price_rise').length;
    const removed = changes.filter(c => c.type === 'removed').length;

    pushAlert({
        type: 'scan_summary',
        title: `Checked ${watchlist.length} item${watchlist.length !== 1 ? 's' : ''}`,
        summary: drops > 0 || rises > 0 || removed > 0
            ? `${drops} drop${drops !== 1 ? 's' : ''}, ${rises} rise${rises !== 1 ? 's' : ''}, ${removed} removed`
            : 'No price changes found',
        drops,
        rises,
        removed,
        checked: watchlist.length,
        seen: false
    });

    res.json({ success: true, changes, checked: watchlist.length });
});

// ===========================
// ALERTS API
// ===========================
app.get('/api/alerts', (req, res) => {
    res.json(loadAlerts());
});

// Mark all alerts as seen
app.post('/api/alerts/seen', (req, res) => {
    const alerts = loadAlerts();
    alerts.forEach(a => a.seen = true);
    saveAlerts(alerts);
    res.json({ success: true });
});

// Clear all alerts
app.delete('/api/alerts', (req, res) => {
    saveAlerts([]);
    res.json({ success: true });
});

// Unseen alert count (for badge polling) — excludes scan_summary entries
app.get('/api/alerts/unseen-count', (req, res) => {
    const alerts = loadAlerts();
    const meaningful = alerts.filter(a => a.type !== 'scan_summary');
    const count    = meaningful.filter(a => !a.seen).length;
    const hasDrops = meaningful.some(a => !a.seen && a.type === 'price_drop');
    res.json({ count, hasDrops });
});

// ===========================
// AUTO-SCAN CONTROL API
// ===========================
app.get('/api/autoscan/status', (req, res) => {
    const settings = loadSettings();
    res.json({
        enabled: !!autoScanTimer,
        intervalHours: settings.autoScanInterval || 0,
        running: autoScanRunning,
        lastRun: lastAutoScanTime,
        progress: autoScanRunning ? autoScanProgress : null
    });
});

app.post('/api/autoscan/set', (req, res) => {
    const { intervalHours } = req.body;
    const hours = parseFloat(intervalHours) || 0;

    const settings = loadSettings();
    settings.autoScanInterval = hours;
    saveSettings(settings);

    startAutoScan(hours);

    res.json({ success: true, intervalHours: hours, enabled: hours > 0 });
});

// Trigger a manual run immediately (without waiting for the interval)
app.post('/api/autoscan/run-now', async (req, res) => {
    if (autoScanRunning) {
        return res.json({ success: false, message: 'Scan already in progress' });
    }
    res.json({ success: true, message: 'Scan started' });
    // Run async — don't make the client wait
    runWatchlistCheck();
});

// ===========================
// PRICE HISTORY API
// ===========================
app.get('/api/watchlist/:id/history', (req, res) => {
    const settings = loadSettings();
    const item = (settings.watchlist || []).find(w => w.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({
        id: item.id,
        title: item.title,
        source: item.source,
        currentPrice: item.price,
        history: item.priceHistory || [],
        addedAt: item.addedAt,
        lastChecked: item.lastChecked,
        status: item.status
    });
});

app.listen(PORT, () => {
    console.log(`Competitor Monitor running at http://localhost:${PORT}`);
    console.log(`💓 Heartbeat active — will auto-exit if tab closed for 10 min`);
    console.log(`🚀 Scrape queue: max 2 concurrent jobs`);
});

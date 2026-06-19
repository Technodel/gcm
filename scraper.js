const axios   = require('axios');
const cheerio = require('cheerio');
const { enhanceWithAI } = require('./services/ai');
const { aiRankProducts, analyzeSearchIntent, aiExtractPrice, expandSearchQuery } = require('./services/ai-search');
// Camoufox (anti-detect browser) is lazy-loaded in getCamoufox() to avoid
// slow module initialization (sql.js + maxmind + browser download check)

// ========================================
// USER AGENT ROTATION POOL
// Rotates between real browser UAs to reduce blocking
// ========================================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Edge/124.0.2478.97',
];
let uaIndex = 0;
function nextUA() {
    const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
    uaIndex++;
    return ua;
}
function makeHeaders(referer) {
    return {
        'User-Agent': nextUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        ...(referer ? { 'Referer': referer } : {}),
    };
}

// ========================================
// COOKIE JAR + PER-SITE REQUEST PACING
// Preserves cookies between requests to same site
// Paces requests to avoid rate limiting
// ========================================

class SiteRequestManager {
    constructor() {
        this._cookies = {};     // hostname → cookie string
        this._lastReq = {};     // hostname → timestamp
        this._minInterval = 1500; // ms between requests to same site
    }

    getCookie(hostname) { return this._cookies[hostname] || ''; }

    setCookie(hostname, setCookieHeader) {
        if (!setCookieHeader) return;
        const existing = this._cookies[hostname] || '';
        const parsed = [];
        for (const raw of (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader])) {
            const parts = raw.split(';')[0].trim();
            const [key, ...val] = parts.split('=');
            if (key && key.toLowerCase() !== 'path' && key.toLowerCase() !== 'domain') {
                parsed.push(parts);
            }
        }
        const merged = [...new Set([...parsed, ...existing.split('; ').filter(Boolean)])].join('; ');
        this._cookies[hostname] = merged;
    }

    /** Wait until enough time has passed since last request to hostname */
    async pace(hostname) {
        const now = Date.now();
        const last = this._lastReq[hostname] || 0;
        const elapsed = now - last;
        if (elapsed < this._minInterval) {
            await delay(this._minInterval - elapsed);
        }
        this._lastReq[hostname] = Date.now();
    }

    /** Build axios config with per-site cookie + rotated UA + pacing applied */
    async buildAxiosConfig(url, extra = {}) {
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch (_) {}
        await this.pace(hostname);
        const headers = makeHeaders(extra.referer || url);
        const cookie = this.getCookie(hostname);
        if (cookie) headers['Cookie'] = cookie;
        return {
            timeout: extra.timeout || 12000,
            headers,
            validateStatus: () => true,
            maxRedirects: extra.maxRedirects ?? 5,
            ...extra.axiosOpts,
        };
    }
}

const siteManager = new SiteRequestManager();

// FAST_HEADERS: shared headers for quick axios requests (no cookie rotation needed)
const FAST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
};

// ========================================
// RETRY WITH EXPONENTIAL BACKOFF
// ========================================

async function retryWithBackoff(fn, { label = '', maxRetries = 2, baseDelay = 1000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delayMs = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.log(`[Retry] ${label} attempt ${attempt + 1}/${maxRetries + 1} after ${Math.round(delayMs)}ms`);
            await delay(delayMs);
        }
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            // Don't retry on 404, 403 (unless it's our detection)
            if (e.response && [400, 404, 410].includes(e.response.status)) break;
        }
    }
    throw lastError;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========================================
// FAST PRE-CHECK ENGINE (ported from ALL-MALL)
// Tries axios + JSON API before launching Camoufox
// ========================================

function isBlockedPage(html, status) {
    if (status === 403 || status === 429 || status === 503) return true;
    const lower = (html || '').slice(0, 6000).toLowerCase();
    return lower.includes('cf-browser-verification') ||
           lower.includes('checking your browser') ||
           lower.includes('enable javascript and cookies') ||
           lower.includes('ddos-guard') ||
           lower.includes('just a moment') ||
           lower.includes('_cf_chl') ||
           lower.includes('cf_clearance');
}

function isUselessPage(html) {
    if (!html || html.length < 4000) return true;
    if (!/og:image|product|price|ld\+json/i.test(html)) return true;
    if (html.includes('_next/static') && !html.includes('"@type":"Product"') && html.length < 30000) return true;
    return false;
}

function stripSiteSuffix(t) {
    if (!t) return t;
    let c = t.replace(/\s+[|]\s+.{3,}$/, '').trim();
    c = c.replace(/\s+[–—:]\s*.{3,}$/, '').trim();
    c = c.replace(/\s+-\s+.{3,}$/, '').trim();
    c = c.replace(/\s+[\w][\w\s]*\.(?:com|me|net|org|shop|store|co|io|lb|ae)\s*$/i, '').trim();
    c = c.replace(/\s*\([^)]{3,40}\)\s*$/, '').trim();
    return c || t;
}

function parseNumericPrice(s) {
    if (!s) return 0;
    const cleaned = String(s).replace(/[^\d.,]/g, ' ').trim();
    // CRITICAL: Try \d+ (all digits) FIRST to avoid splitting 1590 into 159+0
    // Order matters: full number first, then numbers with decimals, then thousands separators
    const nums = cleaned.match(/\d+(?:[.,]\d{1,2})?|\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?/g) || [];
    // Sort by length descending to prefer longer matches (1590 over 159)
    nums.sort((a, b) => b.length - a.length);
    for (let n of nums) {
        if (n.includes(',') && n.includes('.')) {
            n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
        } else if (n.includes(',')) {
            n = /,\d{3}(?!\d)/.test(n) ? n.replace(/,/g, '') : n.replace(',', '.');
        }
        const num = parseFloat(n);
        if (num >= 0.1 && num < 10_000_000) return num;
    }
    return 0;
}

function extractPriceFromHtml(html) {
    if (!html || html.length < 500) return null;

    // Method 1: meta product:price:amount
    const metaM = html.match(/<meta\s+[^>]*property="product:price:amount"\s+content="([^"]+)"/i)
                || html.match(/<meta\s+[^>]*content="([^"]+)"\s+[^>]*property="product:price:amount"/i);
    if (metaM) { const v = parseFloat(metaM[1]); if (v > 1) return v; }

    // Method 2: JSON-LD
    const ldRe = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ldRe.exec(html)) !== null) {
        try {
            const d = JSON.parse(m[1]);
            const items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
            for (const item of items) {
                if (item.offers) {
                    const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                    for (const o of offers) {
                        const v = parseFloat(o.price);
                        if (isFinite(v) && v > 1) return v;
                    }
                }
            }
        } catch (_) {}
    }

    // Method 3: <bdi> WooCommerce
    const bdiM = html.match(/<bdi>\s*\$?([\d,]+\.\d{2})\s*<\/bdi>/);
    if (bdiM) { const v = parseFloat(bdiM[1].replace(/,/g, '')); if (v > 1) return v; }

    // Method 4: itemprop price
    const itM = html.match(/itemprop="price"[^>]*content="([^"]+)"/i)
             || html.match(/content="([^"]+)"[^>]*itemprop="price"/i);
    if (itM) { const v = parseNumericPrice(itM[1]); if (v > 1) return v; }

    return null;
}

function _detectCurrency(html) {
    if (!html) return 'USD';
    // If LBP/L.L. present and no $ near prices, treat as LBP
    if (/(?:LBP|L\.?L\.?)\s*[\d,]/i.test(html) && !/\$\s*[\d,]/.test(html)) return 'LBP';
    if (/€\s*[\d,]/.test(html)) return 'EUR';
    if (/£\s*[\d,]/.test(html)) return 'GBP';
    return 'USD';
}

// ========================================
// CANONICAL PRICE — fetch the selected product's OWN page and extract the
// authoritative current price. Universal across platforms:
//   JSON-LD Product.offers.price → meta og/product:price → <bdi> → itemprop
//   → AI extraction from page text (last resort).
// Also detects dead/404 links so wrong matches are dropped.
// Returns { price:number, currency, raw, source } | { dead:true, status } | null
// ========================================
async function extractCanonicalPrice(productUrl, productTitle) {
    if (!productUrl || !productUrl.startsWith('http')) return null;
    const lower = productUrl.toLowerCase();
    // Skip search/listing pages — only real product pages have a canonical price
    if (lower.includes('/search') || /[?&]s=/.test(lower) || /[?&]q=/.test(lower) || lower.includes('post_type=product')) {
        return null;
    }
    try {
        const resp = await axios.get(productUrl, {
            timeout: 12000,
            headers: FAST_HEADERS,
            validateStatus: () => true,
            maxRedirects: 4,
        });
        if (resp.status >= 400) {
            console.log(`[Canonical] ${productUrl} → HTTP ${resp.status} (dead link)`);
            return { dead: true, status: resp.status };
        }
        const html = typeof resp.data === 'string' ? resp.data : '';
        if (!html || html.length < 300) return null;

        const structured = extractPriceFromHtml(html);
        let currency = _detectCurrency(html);
        // Sanity check: LBP prices are always > 10,000 (e.g. $1 ≈ LBP 90,000)
        // If detected as LBP but price is tiny, it's actually USD
        if (currency === 'LBP' && structured && structured < 10000) currency = 'USD';
        if (structured && structured > 1) {
            return {
                price: structured,
                currency,
                raw: currency === 'LBP' ? `LBP ${new Intl.NumberFormat('en-US').format(Math.round(structured))}` : `$${structured.toFixed(2)}`,
                source: 'structured',
            };
        }

        // Detect explicit not-found pages when no price could be parsed
        const lowHtml = html.toLowerCase();
        const notFoundSignals = ['page not found', '404 not found', 'nothing was found', 'no products were found', 'sorry, this product'];
        if (notFoundSignals.some(s => lowHtml.includes(s))) {
            return { dead: true, status: 404 };
        }

        // AI fallback on visible text (Max accuracy)
        const $ = cheerio.load(html);
        $('script, style, noscript, nav, header, footer, .related, .upsells, [class*="related"], [class*="recommend"]').remove();
        const text = $('body').text();
        const ai = await aiExtractPrice(text, productTitle);
        if (ai && ai.price && ai.price > 1) {
            const cur = ai.currency || currency;
            return {
                price: ai.price,
                currency: cur,
                raw: ai.raw || (cur === 'LBP' ? `LBP ${ai.price}` : `$${ai.price.toFixed(2)}`),
                source: 'ai',
            };
        }
        return null;
    } catch (e) {
        console.log(`[Canonical] ${productUrl}: ${e.message}`);
        return null;
    }
}

async function tryJsonApi(url) {
    try {
        const parsed = new URL(url);
        const origin = parsed.origin;
        const slug = parsed.pathname.split('/').filter(Boolean).pop() || '';
        const candidates = [
            `${origin}/wp-json/wc/v3/products?slug=${slug}`,
            `${origin}/wp-json/wc/v2/products?slug=${slug}`,
            `${origin}/rest/V1/products/${encodeURIComponent(slug)}`,
            `${origin}/products/${slug}.json`,
        ];
        for (const apiUrl of candidates) {
            try {
                const resp = await axios.get(apiUrl, {
                    timeout: 6000,
                    headers: { ...FAST_HEADERS, Accept: 'application/json' },
                    validateStatus: s => s < 400,
                });
                const data = resp.data;
                if (!data || typeof data !== 'object') continue;
                const item = Array.isArray(data) ? data[0] : (data.items?.[0] || data.products?.[0] || data.product || data);
                if (!item || typeof item !== 'object') continue;
                const name = item.name || item.title || '';
                if (!name) continue;
                let price = parseFloat(item.price || item.regular_price || item.sale_price || 0) || 0;
                if (!price && item.custom_attributes) {
                    const pa = item.custom_attributes.find(a => a.attribute_code === 'price' || a.attribute_code === 'special_price');
                    if (pa) price = parseFloat(pa.value) || 0;
                }
                return { name: String(name), price };
            } catch (_) { continue; }
        }
    } catch (_) {}
    return null;
}

// Fast pre-check: try axios first, then JSON API, return result or null (meaning: must use browser)
async function fastFetchProduct(url, keyword) {
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (_) {}

    try {
        return await retryWithBackoff(async () => {
            const config = await siteManager.buildAxiosConfig(url, { timeout: 10000 });
            const resp = await axios.get(url, config);
            const html = typeof resp.data === 'string' ? resp.data : '';
            const status = resp.status;
            // Store cookies
            if (resp.headers['set-cookie']) siteManager.setCookie(hostname, resp.headers['set-cookie']);

            if (isBlockedPage(html, status) || isUselessPage(html)) {
                const apiResult = await tryJsonApi(url);
                if (apiResult && apiResult.name) {
                    return { title: apiResult.name, price: apiResult.price ? String(apiResult.price) : null, fromApi: true };
                }
                return null; // needs browser
            }

            const $ = cheerio.load(html);
            let title = '';
            $('script[type="application/ld+json"]').each((_, el) => {
                if (title) return;
                try {
                    const d = JSON.parse($(el).html() || '{}');
                    const items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
                    for (const item of items) {
                        if (item['@type'] === 'Product' && item.name) { title = String(item.name).trim(); break; }
                    }
                } catch (_) {}
            });
            if (!title) {
                const og = $('meta[property="og:title"]').attr('content') || '';
                title = stripSiteSuffix(og.trim());
            }
            if (!title) title = stripSiteSuffix($('title').text().trim());

            const numPrice = extractPriceFromHtml(html);
            if (!numPrice && !title) return null;
            return {
                title: title || keyword,
                price: numPrice ? String(numPrice) : null,
                fromFast: true,
            };
        }, { label: `fastFetch(${hostname})`, maxRetries: 1, baseDelay: 1500 });
    } catch (_) {
        return null;
    }
}

// ========================================
// SCRAPE WITH CHEERIO — full port of browser scrapeCustomURL logic
// Phases: JSON-LD single product → card selectors → price text scan → fallback
// Returns array of { title, price, link } or empty array
// ========================================
const PRICE_RE = /(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/i;

function _extractPriceText(str) {
    if (!str) return null;
    const m = str.match(PRICE_RE);
    if (!m) return null;
    const num = parseFloat(m[0].replace(/[^0-9.]/g, ''));
    if (isNaN(num) || num <= 0.05) return null;
    return m[0].trim();
}

const JUNK_PATHS = ['/cart', '/login', '/my-account', '/wishlist', '/checkout', '/register', '/sign', '/contact', '/about'];
const JUNK_DOMAINS = ['whatsapp.com', 'wa.me/', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 't.me/'];
const JUNK_TITLES_SET = new Set([
    'menu', 'login', 'logout', 'register', 'sign in', 'sign up', 'wishlist', 'cart',
    'checkout', 'home', 'about', 'contact', 'contact us', 'search', 'filter', 'filters',
    'sort', 'categories', 'all products', 'view all', 'see all', 'load more', 'show more',
    'next', 'previous', 'back', 'close', 'cancel', 'ok', 'submit', 'follow us',
]);

function _isJunkHref(href) {
    if (!href || href.length < 10) return true;
    const lower = href.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return true;
    if (JUNK_PATHS.some(p => lower.includes(p))) return true;
    if (JUNK_DOMAINS.some(d => lower.includes(d))) return true;
    if (lower.includes('add-to-cart') || lower.includes('?add_to')) return true;
    try { const u = new URL(href); if (u.pathname === '/' || u.pathname === '') return true; } catch (_) {}
    return false;
}

function _isJunkTitle(t) {
    if (!t || t.length < 3) return true;
    const lower = t.toLowerCase().trim();
    if (JUNK_TITLES_SET.has(lower)) return true;
    if (lower.startsWith('add to cart') || lower.startsWith('buy now')) return true;
    if (lower.includes('0 results') || lower.includes('no products') || /^\d+\s+results?\s+for/i.test(lower)) return true;
    if (lower.includes('search results') || lower.startsWith('you searched')) return true;
    return false;
}

function _cheerioPrice($, el) {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const dp = $(el).attr('data-price') || $(el).attr('content');
    if (dp) { const n = parseFloat(dp); if (!isNaN(n) && n > 0.05) return `$${n.toFixed(2)}`; }
    return _extractPriceText(text);
}

function _resolveLink(href, baseUrl) {
    if (!href) return null;
    try {
        return new URL(href, baseUrl).href;
    } catch (_) { return null; }
}

// ── Platform detection (from ALL-MALL detect-platform.mjs) ─────────────────
async function detectPlatform(baseUrl, preloadedHtml = null) {
    try {
        let html = preloadedHtml || '';
        if (!html) {
            const resp = await axios.get(baseUrl, { timeout: 8000, headers: FAST_HEADERS, validateStatus: () => true, maxRedirects: 3 });
            html = resp.data || '';
        }
        const $ = cheerio.load(html);
        const bodyClass = $('body').attr('class') || '';
        const head20k = ($('head').html() || '') + bodyClass + html.slice(0, 20000);
        // Search full HTML for Shopify signals (script bundles can be large)
        const fullHtml = html;
        if (head20k.includes('window.Shopify') || head20k.includes('shopify-checkout-api-token') || $('meta[name="shopify-checkout-api-token"]').length
            || fullHtml.includes('gid://shopify/') || fullHtml.includes('__reactRouterContext') || fullHtml.includes('shopify-section')) return 'shopify';
        const allText = head20k;
        if (bodyClass.includes('woocommerce') || $('link[href*="woocommerce"]').length || allText.includes('/wp-content/plugins/woocommerce')) return 'woocommerce';
        if (allText.includes('Mage.Cookies') || bodyClass.includes('catalog-product-view')) return 'magento';
        if (allText.includes('window.BCData') || allText.includes('stencilBootstrap') || allText.includes('bigcommerce.com/s-')) return 'bigcommerce';
        if (allText.includes('__NEXT_DATA__') || allText.includes('_next/static')) return 'nextjs';
        return 'custom';
    } catch (_) { return 'custom'; }
}

// ── WooCommerce REST API (try before Cheerio for WooCommerce sites) ─────────
async function tryWooCommerceApi(baseUrl, keyword) {
    const base = baseUrl.replace(/\/$/, '');
    const kw = encodeURIComponent(keyword);

    // SKU-like queries (e.g. "83K1008CAX") aren't matched by WC text search,
    // so try the dedicated sku filter first, then fall back to text search.
    const looksLikeSku = /^[A-Za-z0-9][A-Za-z0-9\-]{4,}$/.test(keyword.trim()) && /\d/.test(keyword) && /[A-Za-z]/.test(keyword);
    const endpoints = [];
    if (looksLikeSku) {
        endpoints.push(`${base}/wp-json/wc/v3/products?sku=${kw}&per_page=10&_fields=id,name,price,permalink`);
    }
    endpoints.push(`${base}/wp-json/wc/v3/products?search=${kw}&per_page=10&_fields=id,name,price,permalink`);

    for (const url of endpoints) {
        try {
            const resp = await axios.get(url, {
                timeout: 8000,
                headers: { ...FAST_HEADERS, Accept: 'application/json' },
                validateStatus: s => s < 400
            });
            const items = resp.data || [];
            if (items.length) {
                console.log(`[WooCommerce API] ${base}: Found ${items.length} products`);
                return items.map(p => ({
                    title: p.name,
                    price: p.price ? `$${p.price}` : null,
                    link: p.permalink,
                })).filter(p => p.title);
            }
        } catch (e) {
            console.log(`[WooCommerce API] ${base}: ${e.message}`);
        }
    }
    return [];
}

// ── Shopify JSON API search (bypasses HTML entirely) ────────────────────────
async function tryShopifyApi(baseUrl, keyword) {
    const base = baseUrl.replace(/\/$/, '');
    const kw = encodeURIComponent(keyword);

    // Method 1: predictive search API (most targeted)
    try {
        const url = `${base}/search/suggest.json?q=${kw}&resources[type]=product&resources[limit]=15`;
        const resp = await axios.get(url, { timeout: 8000, headers: { ...FAST_HEADERS, Accept: 'application/json' }, validateStatus: s => s < 400 });
        const items = resp.data?.resources?.results?.products || [];
        if (items.length) {
            console.log(`[Shopify API] ${base}: Found ${items.length} products, first price: ${items[0]?.price}`);
            return items.map(p => ({
                title: p.title,
                price: p.price ? `$${p.price}` : null,
                link: p.url?.startsWith('http') ? p.url : `${base}${p.url}`,
            })).filter(p => p.title);
        }
    } catch (e) {
        console.log(`[Shopify API] ${base}: suggest.json failed - ${e.message}`);
    }

    // Method 1b: Shopify search page — extract from JSON-LD on individual product pages
    try {
        const resp = await axios.get(`${base}/search?type=product&q=${kw}`, {
            timeout: 10000, headers: FAST_HEADERS, validateStatus: () => true, maxRedirects: 3,
        });
        const html = typeof resp.data === 'string' ? resp.data : '';
        if (html) {
            // Extract product URLs from the page
            const productUrlRe = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/products/([\\w-]+)`, 'gi');
            const slugs = [...new Set([...html.matchAll(productUrlRe)].map(m => m[1]))];
            if (slugs.length) {
                // Fetch JSON-LD from first 3 matching product pages in parallel
                const results = await Promise.all(slugs.slice(0, 5).map(async (slug) => {
                    try {
                        const pr = await axios.get(`${base}/products/${slug}`, { timeout: 8000, headers: FAST_HEADERS, validateStatus: () => true });
                        const $p = cheerio.load(pr.data || '');
                        let title = '', price = null, link = `${base}/products/${slug}`;
                        $p('script[type="application/ld+json"]').each((_, el) => {
                            if (title) return;
                            try {
                                const d = JSON.parse($p(el).html() || '{}');
                                const items2 = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
                                for (const item of items2) {
                                    if (item['@type'] === 'Product' && item.name) {
                                        title = item.name.trim();
                                        const offers = Array.isArray(item.offers) ? item.offers : (item.offers ? [item.offers] : []);
                                        for (const o of offers) {
                                            const v = parseFloat(String(o.price || o.lowPrice || '').replace(/,/g, ''));
                                            if (isFinite(v) && v > 1) { price = `$${v.toFixed(2)}`; break; }
                                        }
                                        link = item.url || link;
                                        break;
                                    }
                                }
                            } catch (_) {}
                        });
                        // Also try og:price meta
                        if (!price) {
                            const metaPrice = $p('meta[property="og:price:amount"], meta[property="product:price:amount"]').attr('content');
                            if (metaPrice) { const v = parseFloat(metaPrice); if (v > 1) price = `$${v.toFixed(2)}`; }
                        }
                        return title ? { title, price, link } : null;
                    } catch (_) { return null; }
                }));
                const valid = results.filter(Boolean);
                if (valid.length) return valid;
            }
        }
    } catch (_) {}

    // Method 2: /search?type=product&q=keyword — parse JSON from ?view=json
    try {
        const resp = await axios.get(`${base}/search?type=product&q=${kw}`, {
            timeout: 10000, headers: FAST_HEADERS, validateStatus: () => true, maxRedirects: 3,
        });
        if (resp.data && typeof resp.data === 'string') {
            const $ = cheerio.load(resp.data);
            const results = [];
            $('[data-product-id], .product-item, .grid-product, .product-card, [class*="product"]').each((_, el) => {
                const title = $(el).find('h2, h3, [class*="title"], [class*="name"]').first().text().trim();
                const priceEl = $(el).find('[class*="price"]').first().text().trim();
                const link = _resolveLink($(el).find('a').first().attr('href'), base);
                if (title && link && !link.includes('/collections/') && !link.includes('/pages/')) {
                    results.push({ title, price: priceEl || null, link });
                }
            });
            if (results.length) return results;
        }
    } catch (_) {}

    return [];
}

// ── BigCommerce search (parse .productGrid from pre-fetched HTML) ─────────────
async function tryBigCommerceSearch(baseUrl, keyword, prefetchHtml) {
    try {
        const html = prefetchHtml || '';
        if (!html) return [];
        const $ = cheerio.load(html);
        const results = [];
        const base = baseUrl.replace(/\/$/, '');
        $('.productGrid article, .product-item, [class*="product-card"], .listItem').each((_, el) => {
            const $el = $(el);
            const titleEl = $el.find('h4, h3, [class*="title"], [class*="name"]').first();
            const title = titleEl.text().replace(/\s+/g, ' ').trim();
            const href = $el.find('a[href]').first().attr('href');
            const link = href ? (href.startsWith('http') ? href : base + href) : null;
            // Price often JS-rendered, try anyway
            const priceEl = $el.find('[class*="price"], .price').first().text().trim();
            if (title && link) results.push({ title, price: priceEl || null, link });
        });
        return results;
    } catch (_) { return []; }
}

// ── Next.js search (961souq — parse __NEXT_DATA__ or search page JSON) ──────
async function tryNextJsSearch(baseUrl, keyword) {
    const base = baseUrl.replace(/\/$/, '');
    try {
        const resp = await axios.get(`${base}/search?type=product&q=${encodeURIComponent(keyword)}`, {
            timeout: 10000, headers: FAST_HEADERS, validateStatus: () => true, maxRedirects: 3,
        });
        const html = resp.data || '';
        const $ = cheerio.load(html);

        // Try __NEXT_DATA__ first
        const nd = $('script#__NEXT_DATA__').first().html();
        if (nd) {
            try {
                const parsed = JSON.parse(nd);
                const str = JSON.stringify(parsed);
                // Walk the nested structure for product arrays
                const products = [];
                const walk = (obj) => {
                    if (!obj || typeof obj !== 'object') return;
                    if (Array.isArray(obj)) { obj.forEach(walk); return; }
                    if ((obj.name || obj.title) && (obj.slug || obj.handle || obj.url) && (obj.price !== undefined || obj.variants)) {
                        const title = obj.name || obj.title || '';
                        const price = obj.price ? `$${obj.price}` : (obj.variants?.[0]?.price ? `$${obj.variants[0].price}` : null);
                        const link = obj.url || (obj.slug ? `${base}/products/${obj.slug}` : null) || (obj.handle ? `${base}/products/${obj.handle}` : null);
                        if (title && link) products.push({ title, price, link });
                    }
                    Object.values(obj).forEach(walk);
                };
                walk(parsed);
                if (products.length) return products;
            } catch (_) {}
        }

        // Fallback: parse visible product cards from rendered HTML
        const results = [];
        $('[class*="product"], [class*="item"], article').each((_, el) => {
            const $el = $(el);
            const title = $el.find('[class*="title"], [class*="name"], h2, h3').first().text().replace(/\s+/g, ' ').trim();
            const price = $el.find('[class*="price"]').first().text().trim();
            const href = $el.find('a[href]').first().attr('href');
            const link = href ? (href.startsWith('http') ? href : base + href) : null;
            if (title && title.length > 5 && link) results.push({ title, price: price || null, link });
        });
        return results;
    } catch (_) { return []; }
}

// ── WooCommerce REST API search ──────────────────────────────────────────────
async function tryWooApi(baseUrl, keyword) {
    const base = baseUrl.replace(/\/$/, '');
    const endpoints = [
        `${base}/wp-json/wc/v3/products?search=${encodeURIComponent(keyword)}&per_page=10&status=publish`,
        `${base}/wp-json/wc/v2/products?search=${encodeURIComponent(keyword)}&per_page=10`,
    ];
    for (const ep of endpoints) {
        try {
            const resp = await axios.get(ep, { timeout: 8000, headers: { ...FAST_HEADERS, Accept: 'application/json' }, validateStatus: s => s < 400 });
            const products = Array.isArray(resp.data) ? resp.data : [];
            if (!products.length) continue;
            return products.map(p => ({
                title: p.name,
                price: p.price ? `$${parseFloat(p.price).toFixed(2)}` : (p.sale_price ? `$${parseFloat(p.sale_price).toFixed(2)}` : null),
                link: p.permalink || `${base}/?p=${p.id}`,
            })).filter(p => p.title);
        } catch (_) { continue; }
    }
    return [];
}

async function scrapeWithCheerio(searchUrl, keyword, baseUrl, siteName, filterByKeyword = true, preloadedHtml = null) {
    let html = preloadedHtml || '';
    if (!html) {
        try {
            const resp = await axios.get(searchUrl, {
                timeout: 12000,
                headers: { ...FAST_HEADERS, 'Referer': baseUrl },
                validateStatus: () => true,
                maxRedirects: 5,
            });
            if (typeof resp.data !== 'string') return [];
            html = resp.data;
            if (isBlockedPage(html, resp.status)) {
                console.log(`[Cheerio] ${siteName}: blocked (${resp.status})`);
                return [{ _blocked: true }]; // signal to caller to try Puppeteer
            }
        } catch (e) {
            console.log(`[Cheerio] ${siteName}: fetch error — ${e.message}`);
            return [];
        }
    }

    const $ = cheerio.load(html);
    const results = [];
    const seenLinks = new Set();

    // ── Phase 1: JSON-LD single product ───────────────────────────
    let jsonLdPrice = null, jsonLdTitle = null, jsonLdLink = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        if (jsonLdPrice) return;
        try {
            const d = JSON.parse($(el).html() || '{}');
            const items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
            for (const item of items) {
                if (item['@type'] === 'Product' && item.name) {
                    jsonLdTitle = String(item.name).trim();
                    const offers = Array.isArray(item.offers) ? item.offers : (item.offers ? [item.offers] : []);
                    for (const o of offers) {
                        const v = parseFloat(String(o.price || '').replace(/,/g, ''));
                        if (isFinite(v) && v > 0.05) { jsonLdPrice = `$${v.toFixed(2)}`; break; }
                    }
                    jsonLdLink = (item.url && !_isJunkHref(item.url)) ? item.url : searchUrl;
                    break;
                }
            }
        } catch (_) {}
    });

    if (jsonLdPrice && jsonLdTitle && !_isJunkTitle(jsonLdTitle)) {
        return [{ title: jsonLdTitle, price: jsonLdPrice, link: jsonLdLink || searchUrl }];
    }

    // ── Phase 2: Product card selectors ───────────────────────────
    const CARD_SELECTORS = [
        '.search-result-card',
        'ul.products li.product', '.products .product', 'li.product',
        'article.card', '.productGrid article', '.productGrid li',
        'li[class*="product"]', 'article[class*="product"]',
        '[data-product-id]', '[data-entity-id]',
        '.product-item--grid', '.product-card', '.product-item',
        '.product-grid-item', '[class*="product-card"]', '[class*="product-item"]',
        '[class*="product_item"]', '.item-card', '.card.product',
        '.grid__item', '.product-block',
    ];

    const PRICE_SELECTORS = [
        '.price ins .woocommerce-Price-amount', '.price .woocommerce-Price-amount',
        '.woocommerce-Price-amount', '.product-price', '.product_price',
        '.price-current', '.current-price', '[data-price]', '[itemprop="price"]',
        '.price', '.amount', 'span.price', '.price--withoutTax', '.price--main',
        '[data-product-price]',
    ];

    const TITLE_SELECTORS = [
        'h1', 'h2', 'h3', 'h4', '.product-title', '.product-name',
        '.name', '.title', '[itemprop="name"]',
    ];

    let cards = null;
    for (const sel of CARD_SELECTORS) {
        try {
            const found = $(sel);
            if (found.length > 0) { cards = found; break; }
        } catch (_) {}
    }

    if (cards && cards.length > 0) {
        cards.each((_, card) => {
            const $card = $(card);

            // Find product link
            let link = null;
            $card.find('a[href]').each((_, a) => {
                if (link) return;
                const href = _resolveLink($(a).attr('href'), searchUrl);
                if (href && !_isJunkHref(href)) link = href;
            });
            if (!link) {
                // card itself might be the link
                if (card.tagName === 'a') {
                    const href = _resolveLink($(card).attr('href'), searchUrl);
                    if (href && !_isJunkHref(href)) link = href;
                }
            }
            if (!link || seenLinks.has(link)) return;

            // Find price
            let price = null;
            for (const sel of PRICE_SELECTORS) {
                const el = $card.find(sel).first();
                if (el.length) {
                    const raw = el.text().toLowerCase();
                    if (/call|contact|quote|request|out of stock|sold out/.test(raw)) { price = 'Price not available'; break; }
                    price = _cheerioPrice($, el);
                    if (price) break;
                }
            }
            if (!price) {
                const raw = $card.text().replace(/\s+/g, ' ');
                if (/call for price|contact for price|request a quote|out of stock|sold out/i.test(raw)) {
                    price = 'Price not available';
                } else {
                    price = _extractPriceText(raw);
                }
            }
            if (!price) return;

            // Find title
            let title = '';
            for (const sel of TITLE_SELECTORS) {
                const el = $card.find(sel).first();
                if (el.length) { title = el.text().replace(/\s+/g, ' ').trim(); if (title.length > 3) break; }
            }
            if (!title || title.length < 3) {
                // try link text or img alt
                $card.find('a[href]').each((_, a) => {
                    if (title.length > 3) return;
                    title = $(a).text().replace(/\s+/g, ' ').trim();
                });
            }
            if (!title || title.length < 3) {
                title = $card.find('img[alt]').first().attr('alt') || '';
                title = title.replace(/\s+/g, ' ').trim();
            }
            if (_isJunkTitle(title)) return;

            if (filterByKeyword && keyword && scoreRelevance(title, keyword) === 0) return;
            seenLinks.add(link);
            results.push({ title: title.substring(0, 200), price, link });
        });

        if (results.length > 0) {
            console.log(`[Cheerio] ${siteName}: found ${results.length} product card(s)`);
            return results;
        }
    }

    // ── Phase 2.5: Single product page fallback ─────────────────
    // If we didn't find cards, check if it's a single product page
    const isSingleProduct =
        $('body').hasClass('single-product') ||
        $('.entry-summary .price').length > 0 ||
        $('[itemprop="product"]').length > 0 ||
        $('div.summary.entry-summary').length > 0 ||
        $('meta[property="og:type"]').attr('content') === 'product';

    if (isSingleProduct) {
        let price = null;
        const FALLBACK_PRICE_SELECTORS = [
            '.entry-summary .price ins .woocommerce-Price-amount',
            '.entry-summary .price > .woocommerce-Price-amount',
            '.entry-summary .price .woocommerce-Price-amount',
            '.summary .price ins .woocommerce-Price-amount',
            '.summary .price > .woocommerce-Price-amount',
            '.summary .price .woocommerce-Price-amount',
            'p.price ins .woocommerce-Price-amount',
            'p.price > .woocommerce-Price-amount',
            'p.price .woocommerce-Price-amount', '.woocommerce-Price-amount',
            '[itemprop="price"]', '.product-price', '.current-price',
            '.price-current', '#product-price', '.price--main',
            '.price--withoutTax', '[data-product-price]', 'span.price',
            '.summary .price', '.entry-summary .price',
        ];
        for (const sel of FALLBACK_PRICE_SELECTORS) {
            const el = $(sel).first();
            if (el.length) { price = _cheerioPrice($, el); if (price) break; }
        }
        if (!price) {
            const numP = extractPriceFromHtml(html);
            if (numP) price = `$${numP.toFixed(2)}`;
        }
        if (price) {
            // Get page title
            let title = '';
            for (const sel of ['.product_title', 'h1.entry-title', 'h1.product-title', '[itemprop="name"]', 'h1']) {
                const el = $(sel).first();
                if (el.length) { title = el.text().replace(/\s+/g, ' ').trim(); if (title.length > 3) break; }
            }
            if (!title) title = stripSiteSuffix($('title').text().split('|')[0].split('–')[0].trim());
            // Try to get the canonical product URL
            const canonicalLink = $('link[rel="canonical"]').attr('href')
                || $('meta[property="og:url"]').attr('content')
                || searchUrl;
            if (!_isJunkTitle(title)) {
                console.log(`[Cheerio] ${siteName}: single-product fallback — "${title}" @ ${price}`);
                return [{ title, price, link: canonicalLink }];
            }
        }
    }

    // ── Phase 3: Price text scan fallback ─────────────────────────
    // Walk all text nodes, find prices, find nearest link ancestor
    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const priceMatches = [...bodyText.matchAll(new RegExp(PRICE_RE.source, 'gi'))];

    // Phase 3 cont: use price matches to find product cards via link proximity
    // Walk all <a> tags, find ones near a price in the HTML
    $('a[href]').each((_, a) => {
        if (results.length >= 20) return;
        const href = _resolveLink($(a).attr('href'), searchUrl);
        if (!href || _isJunkHref(href) || seenLinks.has(href)) return;

        // Check if this anchor or its parent contains a price
        const $a = $(a);
        const containerText = $a.parent().text().replace(/\s+/g, ' ').trim();
        const price = _extractPriceText(containerText);
        if (!price) return;

        const num = parseFloat(price.replace(/[^0-9.]/g, ''));
        if (num < 10) return; // skip noise

        let title = $a.text().replace(/\s+/g, ' ').trim();
        if (!title || title.length < 4) title = $a.attr('title') || '';
        if (!title || title.length < 4) title = $a.find('img').attr('alt') || '';
        if (_isJunkTitle(title)) return;
        if (filterByKeyword && keyword && scoreRelevance(title, keyword) === 0) return;

        seenLinks.add(href);
        results.push({ title: title.substring(0, 200), price, link: href });
    });

    if (results.length > 0) {
        console.log(`[Cheerio] ${siteName}: found ${results.length} result(s) via price proximity`);
    } else {
        console.log(`[Cheerio] ${siteName}: no results found`);
    }
    
    // AI fallback: try DeepSeek extraction when traditional methods fail
    if (results.length === 0 && html && keyword) {
        const aiResult = await enhanceWithAI(html, searchUrl, keyword);
        if (aiResult) {
            console.log(`[Cheerio] ${siteName}: AI-enhanced extraction found result`);
            return [aiResult];
        }
    }
    
    return results;
}

// ========================================
// PUPPETEER FALLBACK — for Cloudflare/403-blocked sites
// One browser, one page, destroyed immediately after use
// ========================================
let _puppeteer = null;
async function getPuppeteer() {
    if (_puppeteer === null) {
        try {
            console.log('[Puppeteer] Lazy-loading puppeteer-core…');
            _puppeteer = require('puppeteer-core');
        } catch(e) {
            console.log('[Puppeteer] puppeteer-core not available:', e.message);
            _puppeteer = false; // Don't retry
        }
    }
    return _puppeteer || null;
}

const CHROME_PATHS = [
    // Windows paths (common Chrome installations)
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Users\\TD\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\TD\\AppData\\Local\\Chromium\\Application\\chrome.exe',
    // Linux paths
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser-stable',
];

async function scrapeWithPuppeteer(searchUrl, keyword, siteName) {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) {
        console.log(`[Puppeteer] puppeteer-core not available, skipping ${siteName}`);
        return [];
    }
    // Hard 25s timeout around the entire operation
    const result = await Promise.race([
        _scrapeWithPuppeteerInner(searchUrl, keyword, siteName),
        new Promise(resolve => setTimeout(() => {
            console.log(`[Puppeteer] ${siteName}: hard timeout — giving up`);
            resolve([]);
        }, 25000)),
    ]);
    return result;
}

async function _scrapeWithPuppeteerInner(searchUrl, keyword, siteName) {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) return [];

    const fs = require('fs');
    const executablePath = CHROME_PATHS.find(p => { try { return fs.existsSync(p); } catch(_) { return false; } });
    if (!executablePath) {
        console.log(`[Puppeteer] No Chrome found for ${siteName}`);
        return [];
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath,
            headless: 'new',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote',
                '--single-process',
            ],
            timeout: 20000,
        });

        const page = await browser.newPage();
        await page.setUserAgent(nextUA());
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        // Block images/fonts/css to speed up
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (['image','stylesheet','font','media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 1500)); // let JS render

        const html = await page.content();
        await browser.close();
        browser = null;

        // Note: don't run isBlockedPage here — the browser already solved the JS challenge.
        // The rendered HTML may still have CF-related classes but the actual content is present.

        // Parse with cheerio (keyword filtering already built in)
        const results = await scrapeWithCheerio(searchUrl, keyword, searchUrl, siteName, true, html);
        console.log(`[Puppeteer] ${siteName}: got ${results.length} result(s)`);
        return results;

    } catch(e) {
        console.error(`[Puppeteer] ${siteName}: ${e.message}`);
        return [];
    } finally {
        if (browser) { try { await browser.close(); } catch(_) {} }
    }
}

// ========================================
// LAZY CAMOUFOX LOADER
// Loaded on first use to avoid slow module initialization at startup
// ========================================
let _Camoufox = null;
async function getCamoufox() {
    if (!_Camoufox) {
        console.log('[Camoufox] Lazy-loading Camoufox module (may take up to 60s)…');
        const start = Date.now();
        _Camoufox = require('camoufox').Camoufox;
        console.log(`[Camoufox] Module loaded in ${Date.now() - start}ms`);
    }
    return _Camoufox;
}

// ========================================
// BROWSER LAUNCH — Camoufox anti-detect Firefox
// ========================================
async function launchBrowser() {
    const Camoufox = await getCamoufox();
    const launchPromise = Camoufox({
        headless: true,
        os: 'windows',
        locale: 'en-US',
    });
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Camoufox failed to launch within 30 seconds')), 30000)
    );
    return Promise.race([launchPromise, timeoutPromise]);
}

// ========================================
// PAGE SETUP — Camoufox handles anti-detection natively
// Only need to set up resource blocking when requested
// ========================================
async function setupPage(page, blockResources = false) {
    if (blockResources) {
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });
    }
}

// Insert space between letters and digits for better WooCommerce search: rtx5080 → rtx 5080
// But don't split SKU-style strings like 83K1008CAX (already has no spaces and is a model number)
function _kwSpace(kw) {
    if (!kw) return kw;
    // If the keyword has no spaces and looks like a SKU (mixed case alphanumeric), return as-is
    const trimmed = kw.trim();
    if (!trimmed.includes(' ') && /^[A-Z0-9]{4,}$/i.test(trimmed.replace(/[-_.]/g, ''))) {
        return trimmed; // SKU — don't mangle it
    }
    return kw.replace(/([a-z])(\d)/gi, '$1 $2').replace(/(\d)([a-z])/gi, '$1 $2');
}

// For GPU searches, append "graphics card" to find standalone GPUs instead of laptops
function _gpuKeyword(kw) {
    const lower = kw.toLowerCase();
    const gpuPatterns = /\b(rtx|gtx|rx\s*\d{3,4}|radeon|geforce)\b/;
    if (gpuPatterns.test(lower) && !lower.includes('graphics') && !lower.includes('card')) {
        return kw + ' graphics card';
    }
    return kw;
}

// ========================================
// SITE-SPECIFIC SEARCH URL BUILDERS
// These are the Lebanese e-commerce sites we know
// ========================================
const SITE_SEARCH_PATTERNS = {
    'ayoubcomputers.com':  (kw) => `https://ayoubcomputers.com/search.php?search_query=${encodeURIComponent(kw)}`,
    'mojitech.net':        (kw) => `https://mojitech.net/?s=${encodeURIComponent(_kwSpace(kw))}&post_type=product`,
    'ezonelb.com':         (kw) => `https://ezonelb.com/?s=${encodeURIComponent(_kwSpace(kw))}&post_type=product`,
    'multitech-lb.com':    (kw) => `https://multitech-lb.com/?s=${encodeURIComponent(_kwSpace(kw))}&post_type=product`,
    'dslr-zone.com':       (kw) => `https://www.dslr-zone.com/?s=${encodeURIComponent(_kwSpace(kw))}&post_type=product`,
    'pcandparts.com':      (kw) => `https://pcandparts.com/?s=${encodeURIComponent(_kwSpace(kw))}&post_type=product`,
    '961souq.com':         (kw) => `https://961souq.com/search?type=product&q=${encodeURIComponent(_kwSpace(kw))}`,
    'jakcomputer.com':     (kw) => `https://jakcomputer.com/?s=${encodeURIComponent(kw)}&post_type=product`,
};

function buildSearchUrl(rawUrl, keyword) {
    if (!keyword) return null;
    try {
        const hostname = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl).hostname.replace(/^www\./, '');
        // Enhance keyword for GPU searches to find standalone cards
        const enhancedKeyword = _gpuKeyword(keyword);
        for (const [domain, builder] of Object.entries(SITE_SEARCH_PATTERNS)) {
            if (hostname.includes(domain)) return builder(enhancedKeyword);
        }
    } catch (_) {}
    return null;
}

// ========================================
// HELPER: clean website name
// ========================================
function getWebsiteName(url) {
    try {
        const hostname = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
        return hostname.replace(/^www\./, '');
    } catch (_) {
        return 'Custom URL';
    }
}

function normalizeAlnum(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildKeywordVariants(keyword) {
    const raw = String(keyword || '').trim();
    if (!raw) return [];

    const variants = [];
    const seen = new Set();
    const push = (value) => {
        const cleaned = String(value || '').trim();
        if (!cleaned) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        variants.push(cleaned);
    };

    push(raw);

    const normalized = normalizeAlnum(raw);
    const isModelLike = /[a-z]/i.test(raw) && /\d/.test(raw) && normalized.length >= 6;
    if (!isModelLike) return variants;

    push(normalized);

    const groups = raw.match(/[a-z]+|\d+/gi) || [];
    if (groups.length >= 2) {
        push(groups.join(' '));
        push(groups.join('-'));
    }

    [7, 6].forEach((length) => {
        if (normalized.length > length) push(normalized.slice(0, length));
    });

    // Keep variant count very small for speed.
    return variants.slice(0, 3);
}


// ========================================
// UTILITY
// ========================================
// ========================================
// SCRAPE CUSTOM URL — handles listing pages + single product pages
// This is the core engine for all Lebanese competitor sites
// ========================================
async function scrapeCustomURL(page, keyword, rawUrlInput) {
    // rawUrlInput may be undefined when called from scrapePlatform directly
    let url = rawUrlInput || '';
    if (!url.startsWith('http')) url = url ? 'https://' + url : '';

    const siteName = url ? getWebsiteName(url) : 'Custom URL';

    // Build a smart search URL if we have a keyword and know the site
    let searchUrl = null;
    if (keyword && url) {
        searchUrl = buildSearchUrl(url, keyword);
    }

    const targetUrl = searchUrl || url;
    if (!targetUrl) {
        return [{ title: 'No URL provided', price: 'N/A', seller: '', link: '#', source: siteName, query: keyword || '', location: '', postedDate: '', dateScraped: new Date().toLocaleString() }];
    }

    console.log(`[Custom] Scraping: ${targetUrl}`);

    // Navigate
    try {
        // Some shops keep background requests open, so networkidle can hang indefinitely.
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } catch (e) {
        console.warn(`[Custom] Navigation warning for ${targetUrl}: ${e.message}`);
        // Don't abort — partial loads often have what we need
    }

    // Extra wait for JS-rendered content
    await delay(searchUrl ? 350 : 250);

    // If no known search pattern found, try typing into a search box
    if (!searchUrl && keyword) {
        const didSearch = await trySearchBox(page, keyword);
        if (didSearch) await delay(500);
    }

    // Scroll to trigger lazy-loaded items
    await autoScroll(page, 1);

    // ================================================
    // EXTRACT — all logic runs inside the browser
    // ================================================
    let pageData = [];
    let lastEvaluateError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            pageData = await page.evaluate(({ currentUrl, siteNameStr }) => {
        const cleanText = (t) => (t || '').toString().replace(/\s+/g, ' ').trim();

        // ---- PRICE REGEX ----
        // Matches: $699.00, USD 578, 138.00 $, 1,299 USD, LBP 50000, LL 50,000
        const PRICE_RE = /(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/i;

        function extractPrice(str) {
            if (!str) return null;
            const m = str.match(PRICE_RE);
            if (!m) return null;
            const raw = m[0].trim();
            // Must be a real positive number — blocks $0.00 or $0.01 "Call for price" products
            const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
            if (isNaN(num) || num <= 0.05) return null;
            return raw;
        }

        function isRealPrice(str) {
            return !!extractPrice(str);
        }

        function formatMojitechPrice(priceStr, textContext) {
            if (!priceStr || priceStr === 'Price not available' || siteNameStr !== 'mojitech.net') return priceStr;
            const textLower = (textContext || '').toLowerCase();
            if (textLower.includes('tax free') || textLower.includes('tax-free')) return priceStr;
            
            const rawStr = priceStr;
            const cleanStr = rawStr.replace(/[^\d.]/g, '');
            const numVal = parseFloat(cleanStr);
            if (!isNaN(numVal) && numVal > 0) {
                const withTva = numVal * 1.11;
                const currencyMatch = rawStr.match(/[^\d.,\s]+/);
                let currency = (currencyMatch ? currencyMatch[0].trim() : '$') || '$';
                if (currency.toUpperCase() === 'LBP' || currency.toUpperCase() === 'LL' || numVal > 100000) {
                    const withTvaFmt = new Intl.NumberFormat('en-US').format(Math.round(withTva));
                    const origFmt = new Intl.NumberFormat('en-US').format(Math.round(numVal));
                    return `${currency} ${withTvaFmt} (inc. 11% TVA) — Base: ${currency} ${origFmt}`;
                } else {
                    return `${currency}${withTva.toFixed(2)} (inc. TVA) — Base: ${currency}${numVal.toFixed(2)}`;
                }
            }
            return priceStr;
        }

        // ---- JUNK DETECTION ----
        const JUNK_AREA_TAGS = new Set(['nav', 'footer', 'header']);
        const JUNK_AREA_ROLES = new Set(['navigation', 'complementary', 'banner', 'contentinfo']);
        const JUNK_AREA_RE = /\b(filter|sidebar|widget|menu|facet|breadcrumb|toolbar|social|cookie|cart|checkout|account)\b/i;

        function isInsideJunkArea(el) {
            let node = el;
            for (let i = 0; i < 12; i++) {
                if (!node || node === document.body || node === document.documentElement) break;
                const tag = (node.tagName || '').toLowerCase();
                const id = node.id || '';
                const cls = typeof node.className === 'string' ? node.className : '';
                const role = node.getAttribute ? (node.getAttribute('role') || '') : '';
                if (JUNK_AREA_TAGS.has(tag)) return true;
                if (JUNK_AREA_ROLES.has(role.toLowerCase())) return true;
                if (JUNK_AREA_RE.test(id) || JUNK_AREA_RE.test(cls)) return true;
                node = node.parentElement;
            }
            return false;
        }

        function isJunkLink(href) {
            if (!href || href.length < 10) return true;
            const lower = href.toLowerCase();
            if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return true;
            const junkPaths = ['/cart', '/login', '/my-account', '/wishlist', '/checkout', '/register', '/sign', '/contact', '/about'];
            if (junkPaths.some(p => lower.includes(p))) return true;
            const junkDomains = ['whatsapp.com', 'wa.me/', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 't.me/', 'maps.google', 'youtube.com', 'linkedin.com'];
            if (junkDomains.some(d => lower.includes(d))) return true;
            if (lower.includes('add-to-cart') || lower.includes('?add_to') || lower.includes('?add-to-cart')) return true;
            // Root/homepage links
            try { const u = new URL(href); if (u.pathname === '/' || u.pathname === '') return true; } catch (_) {}
            return false;
        }

        const JUNK_TITLES = new Set([
            'menu', 'login', 'logout', 'register', 'sign in', 'sign up', 'wishlist', 'cart',
            'checkout', 'home', 'about', 'contact', 'contact us', 'search', 'filter', 'filters',
            'sort', 'categories', 'all products', 'view all', 'see all', 'load more', 'show more',
            'next', 'previous', 'back', 'close', 'cancel', 'ok', 'submit', 'follow us',
        ]);
        function isJunkTitle(title) {
            if (!title || title.length < 3) return true;
            const lower = title.toLowerCase().trim();
            if (JUNK_TITLES.has(lower)) return true;
            if (lower.startsWith('add to cart') || lower.startsWith('buy now')) return true;
            if (lower.includes('0 results') || lower.includes('no products') || /^\d+\s+results?\s+for/i.test(lower)) return true;
            if (lower.includes('search results') || lower.startsWith('search results:')) return true;
            if (/^\d+[-\s]?port$/i.test(lower)) return true;
            if (lower.length < 4 && !/\d/.test(lower)) return true;
            return false;
        }

        // ---- PRICE FROM ELEMENT (multiple strategies) ----
        function getPriceFromElement(el) {
            if (!el) return null;
            // Try innerText first
            const txt = cleanText(el.innerText || '');
            const p = extractPrice(txt);
            if (p) return p;
            // Try data-price attribute (BigCommerce, custom shops)
            const dp = el.getAttribute ? el.getAttribute('data-price') : null;
            if (dp) {
                const num = parseFloat(dp);
                if (!isNaN(num) && num > 0.05) return `$${num.toFixed(2)}`;
            }
            // Try content attribute (microdata)
            const cp = el.getAttribute ? el.getAttribute('content') : null;
            if (cp) {
                const num = parseFloat(cp);
                if (!isNaN(num) && num > 0.05) return `$${num.toFixed(2)}`;
            }
            return null;
        }

        // ---- JSON-LD PRICE ----
        function getPriceFromJsonLd() {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const s of scripts) {
                try {
                    const d = JSON.parse(s.textContent);
                    const candidates = Array.isArray(d) ? d : [d, ...(d['@graph'] || [])];
                    for (const obj of candidates) {
                        const ofr = obj.offers || obj.Offers;
                        if (!ofr) continue;
                        const offerList = Array.isArray(ofr) ? ofr : [ofr];
                        for (const offer of offerList) {
                            const p = offer.price;
                            const c = offer.priceCurrency || 'USD';
                            if (p !== undefined && p !== null && p !== '') {
                                const num = parseFloat(String(p).replace(/,/g, ''));
                                // Strictly > 0.05 — blocks "Call for price" products that publish price=0 or 0.01
                                if (!isNaN(num) && num > 0.05) return `$${num.toFixed(2)}`;
                            }
                        }
                    }
                } catch (_) {}
            }
            return null;
        }

        // ---- META PRICE ----
        function getPriceFromMeta() {
            const selectors = [
                'meta[property="product:price:amount"]',
                'meta[name="price"]',
                'meta[itemprop="price"]',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const val = el.getAttribute('content');
                    if (val) {
                        const num = parseFloat(val.replace(/,/g, ''));
                        // Strictly > 0.05 — blocks "Call for price" where meta has price=0 or 0.01
                        if (!isNaN(num) && num > 0.05) return `$${num.toFixed(2)}`;
                    }
                }
            }
            return null;
        }

        // ---- TITLE FROM PAGE ----
        function getPageTitle() {
            const selectors = [
                '.product_title', 'h1.entry-title', 'h1.product-title',
                '.product-name h1', '.pdp-title', '[itemprop="name"]', 'h1'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const t = cleanText(el.innerText || el.getAttribute('content') || '');
                    if (t && t.length > 3 && !isJunkTitle(t)) return t;
                }
            }
            return cleanText(document.title.split('|')[0].split('–')[0].split('-')[0]);
        }

        const results = [];
        const seenLinks = new Set();

        // ================================================================
        // PHASE 1: Single Product Page Detection
        // WooCommerce and similar — detect BEFORE generic strategy
        // ================================================================
        const isSingleProduct =
            document.body?.classList.contains('single-product') ||
            !!document.querySelector('.product_title') ||
            !!document.querySelector('.entry-summary .price') ||
            !!document.querySelector('[itemprop="product"]') ||
            !!document.querySelector('div.summary.entry-summary');

        if (isSingleProduct) {
            let price = null;
            // 1a. WooCommerce price selectors
            const wpSelectors = [
                '.entry-summary .price ins .woocommerce-Price-amount',
                '.entry-summary .price .woocommerce-Price-amount',
                '.summary .price .woocommerce-Price-amount',
                'p.price .woocommerce-Price-amount',
                '.price .woocommerce-Price-amount',
            ];
            for (const sel of wpSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    // Check for call-for-price text before extracting
                    const rawText = (el.innerText || '').toLowerCase();
                    if (rawText.includes('call') || rawText.includes('contact') || rawText.includes('quote') || rawText.includes('out of stock') || rawText.includes('sold out')) {
                        price = 'Price not available';
                        break;
                    }
                    price = getPriceFromElement(el);
                    if (price) break;
                }
            }
            if (!price) price = getPriceFromJsonLd();
            if (!price) price = getPriceFromMeta();

            // Also check if the page itself says "call for price" explicitly
            if (!price) {
                const pageBodyText = (document.body?.innerText || '').toLowerCase();
                const isCallForPrice = pageBodyText.includes('call for price') || pageBodyText.includes('call for a price') || pageBodyText.includes('contact for price') || pageBodyText.includes('request a quote') || pageBodyText.includes('out of stock') || pageBodyText.includes('sold out');
                if (isCallForPrice) {
                    price = 'Price not available';
                }
            }

            if (price) {
                const title = getPageTitle();
                const img = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                            document.querySelector('.woocommerce-product-gallery img, .wp-post-image')?.src || '';
                const desc = cleanText(
                    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                    document.querySelector('meta[name="description"]')?.getAttribute('content') || ''
                );
                price = formatMojitechPrice(price, document.body?.innerText || '');
                results.push({ title: title.substring(0, 200), price, description: desc.substring(0, 300), image: img, link: currentUrl });
                return results;
            }
        }

        // ================================================================
        // PHASE 2: Product Listing Page — Structured Cards
        // Try many selectors to find product card containers
        // ================================================================
        const CARD_SELECTORS = [
            '.search-result-card', // 961souq Shopify Hydrogen
            // WooCommerce
            'ul.products li.product',
            '.products .product',
            'li.product',
            // BigCommerce (ayoubcomputers.com uses this)
            'li.product',
            'article.card',
            '.productGrid article',
            '.productGrid li',
            'li[class*="product"]',
            'article[class*="product"]',
            '[data-product-id]',
            '[data-entity-id]',        // BigCommerce entity ID
            '.product-item--grid',
            // Generic
            '.product-card',
            '.product-item',
            '.product-grid-item',
            '[class*="product-card"]',
            '[class*="product-item"]',
            '[class*="product_item"]',
            '.item-card',
            '.card.product',
            // Shopify-style
            '.grid__item',
            '.product-block',
        ];

        let cards = [];
        for (const sel of CARD_SELECTORS) {
            try {
                const found = Array.from(document.querySelectorAll(sel));
                // Filter out cards that are inside junk areas
                const clean = found.filter(c => !isInsideJunkArea(c));
                if (clean.length > 0) {
                    cards = clean;
                    break;
                }
            } catch (_) {}
        }

        if (cards.length > 0) {
            for (const card of cards) {
                // Find product link
                const allLinks = Array.from(card.querySelectorAll('a[href]'));
                let link = null;
                for (const l of allLinks) {
                    if (!isJunkLink(l.href)) { link = l; break; }
                }
                if (!link && card.tagName === 'A' && !isJunkLink(card.href)) link = card;
                if (!link) continue;
                if (seenLinks.has(link.href)) continue;

                // Skip cards where the price element contains "call for price" type text
                // These are valid products but without a scraped price — don't show them as $0
                const PRICE_SELECTORS = [
                    '.price ins .woocommerce-Price-amount',
                    '.price .woocommerce-Price-amount',
                    '.woocommerce-Price-amount',
                    '.product-price',
                    '.product_price',
                    '.price-current',
                    '.current-price',
                    '[data-price]',
                    '[itemprop="price"]',
                    '.price',
                    '.amount',
                    'span.price',
                    // BigCommerce
                    '.price--withoutTax',
                    '.price--main',
                    '[data-product-price]',
                ];
                let price = null;
                for (const sel of PRICE_SELECTORS) {
                    const el = card.querySelector(sel);
                    if (el) {
                        // Check for "call for price" text before trying to extract number
                        const rawText = (el.innerText || '').toLowerCase();
                        if (rawText.includes('call') || rawText.includes('contact') || rawText.includes('quote') || rawText.includes('request') || rawText.includes('out of stock') || rawText.includes('sold out')) {
                            price = 'Price not available';
                            break;
                        }
                        price = getPriceFromElement(el);
                        if (price) break;
                    }
                }
                // Fallback: raw text regex on entire card text
                if (!price) {
                    const raw = card.innerText || '';
                    // Skip cards that announce "call for price"
                    const rawLower = raw.toLowerCase();
                    if (rawLower.includes('call for price') || rawLower.includes('call for a price') || rawLower.includes('contact for price') || rawLower.includes('request a quote') || rawLower.includes('out of stock') || rawLower.includes('sold out')) {
                        price = 'Price not available';
                    } else {
                        price = extractPrice(raw);
                    }
                }
                if (!price) continue;

                // Find title
                let title = '';
                const TITLE_SELECTORS = [
                    'h1', 'h2', 'h3', 'h4',
                    '.product-title', '.product-name', '.name', '.title',
                    '[class*="title"]', '[class*="name"]',
                    '[itemprop="name"]',
                ];
                for (const sel of TITLE_SELECTORS) {
                    const el = card.querySelector(sel);
                    if (el) { title = cleanText(el.innerText); if (title.length > 3) break; }
                }
                if (!title || title.length < 3) title = cleanText(link.innerText);
                if (!title || title.length < 3) {
                    const img = card.querySelector('img[alt]');
                    if (img) title = cleanText(img.getAttribute('alt') || '');
                }
                if (isJunkTitle(title)) continue;

                seenLinks.add(link.href);
                price = formatMojitechPrice(price, card.innerText || '');
                results.push({ title: title.substring(0, 200), price, link: link.href });
            }
        }

        if (results.length > 0) return results;

        // ================================================================
        // PHASE 3: DOM TreeWalker — walk all price text nodes, climb up for context
        // Handles sites with unusual markup that don't match card selectors
        // ================================================================
        if (document.body) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            const priceNodes = [];

            while ((node = walker.nextNode())) {
                const text = node.nodeValue.trim();
                if (!text || text.length > 40) continue;
                const price = extractPrice(text);
                if (!price) continue;
                // Filter noise: cart totals, shipping fees, etc.
                const lower = text.toLowerCase();
                if (['subtotal', 'total', 'shipping', 'fee', 'tax', 'discount', 'min price', 'max price', 'from', 'starting'].some(w => lower.includes(w))) continue;
                if (isInsideJunkArea(node.parentElement)) continue;
                priceNodes.push({ node, price });
            }

            for (const { node, price: extractedPrice } of priceNodes) {
                // Climb up DOM to find a product card boundary
                let container = node.parentElement;
                let cardLink = null;
                let climbed = 0;

                while (container && container !== document.body && climbed < 10) {
                    const textLen = (container.innerText || '').length;
                    if (textLen > 2000) break; // Too big — likely the whole page

                    if (container.tagName === 'A' && container.href && !isJunkLink(container.href)) {
                        cardLink = container;
                        break;
                    }

                    const links = Array.from(container.querySelectorAll('a[href]')).filter(a => !isJunkLink(a.href));
                    if (links.length === 1) { cardLink = links[0]; break; }
                    if (links.length > 1) {
                        // Pick the link with the most descriptive text
                        cardLink = links.find(a => (a.innerText || '').trim().length > 5) || links[0];
                        break;
                    }

                    container = container.parentElement;
                    climbed++;
                }

                if (!cardLink || seenLinks.has(cardLink.href)) continue;

                // Extract title from container
                let title = '';
                if (container) {
                    const headings = container.querySelectorAll('h1,h2,h3,h4,h5,h6');
                    if (headings.length > 0) title = cleanText(headings[0].innerText);
                    if (!title || title.length < 3) {
                        const imgs = container.querySelectorAll('img[alt]');
                        if (imgs.length > 0) title = cleanText(imgs[0].getAttribute('alt') || '');
                    }
                }
                if (!title || title.length < 3) title = cleanText(cardLink.innerText);
                if (isJunkTitle(title)) continue;

                seenLinks.add(cardLink.href);
                const price = formatMojitechPrice(extractedPrice, container ? container.innerText : '');
                results.push({ title: title.substring(0, 200), price, link: cardLink.href });
            }
        }

        if (results.length > 0) return results;

        // ================================================================
        // PHASE 4: Single-product fallback — page loaded but no cards found
        // Happens on sites that redirect search to product page directly,
        // or have very unusual markup (e.g. mojitech sometimes)
        // ================================================================
        {
            let price = null;
            const FALLBACK_PRICE_SELECTORS = [
                '.entry-summary .price .woocommerce-Price-amount',
                '.summary .price .woocommerce-Price-amount',
                'p.price .woocommerce-Price-amount',
                '.woocommerce-Price-amount',
                '[itemprop="price"]',
                '.product-price',
                '.current-price',
                '.price-current',
                '#product-price',
                '.price--main',
                '.price--withoutTax',      // BigCommerce
                '[data-product-price]',    // BigCommerce
                'span.price',
                '.summary .price',
                '.entry-summary .price',
            ];
            for (const sel of FALLBACK_PRICE_SELECTORS) {
                const el = document.querySelector(sel);
                if (el) { price = getPriceFromElement(el); if (price) break; }
            }
            if (!price) price = getPriceFromJsonLd();
            if (!price) price = getPriceFromMeta();

            // Body text scan — last resort, high threshold ($10+) to avoid spec noise
            if (!price) {
                const bodyText = document.body ? document.body.innerText : '';
                const allMatches = (bodyText.match(new RegExp(PRICE_RE.source, 'gi')) || []);
                const validPrices = allMatches.filter(p => {
                    if (!isRealPrice(p)) return false;
                    const num = parseFloat(p.replace(/[^0-9.]/g, ''));
                    return num >= 10;
                });
                if (validPrices.length > 0) price = validPrices[0].trim();
            }

            if (price) {
                const title = getPageTitle();
                if (!isJunkTitle(title)) {
                    const img = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
                    const desc = cleanText(document.querySelector('meta[property="og:description"]')?.getAttribute('content') || document.querySelector('meta[name="description"]')?.getAttribute('content') || '');
                    price = formatMojitechPrice(price, document.body ? document.body.innerText : '');
                    results.push({ title: title.substring(0, 200), price, description: desc.substring(0, 300), image: img, link: currentUrl });
                }
            }
        }

        return results;
    }, { currentUrl: targetUrl, siteNameStr: siteName });
            lastEvaluateError = null;
            break;
        } catch (error) {
            lastEvaluateError = error;
            const transientNav = /Execution context was destroyed|Target page, context or browser has been closed/i.test(error.message || '');
            if (!transientNav || attempt === 1) break;
            if (typeof page.waitForLoadState === 'function') {
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            }
            await delay(1200);
        }
    }

    if (lastEvaluateError) throw lastEvaluateError;

    let relevantData = pageData || [];
    if (keyword && relevantData.length > 0) {
        const q = String(keyword).trim();
        const qNorm = normalizeAlnum(q);
        const qTokens = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const isModelLike = /[a-z]/i.test(q) && /\d/.test(q) && qNorm.length >= 4;

        // Build individual alphanumeric groups from the query for flexible matching
        // e.g. "RTX 4070 Super" → ["rtx", "4070", "super"]
        const qGroups = q.match(/[a-z]+|\d+/gi) || [];
        const qGroupsLower = qGroups.map(g => g.toLowerCase());

        relevantData = relevantData.filter(item => {
            const title = (item.title || '').toLowerCase();
            const link = (item.link || '').toLowerCase();
            const titleNorm = normalizeAlnum(title);
            const linkNorm = normalizeAlnum(link);

            if (isModelLike) {
                // First try exact contiguous match (ideal case)
                if (qNorm && (titleNorm.includes(qNorm) || linkNorm.includes(qNorm))) return true;
                // Fallback: check if all alphanumeric groups appear individually in the title or link
                // e.g. query "RTX4070" → groups ["rtx","4070"] → both must appear somewhere
                if (qGroupsLower.length >= 2) {
                    const allInTitle = qGroupsLower.every(g => titleNorm.includes(g) || linkNorm.includes(g));
                    if (allInTitle) return true;
                }
                // Relaxed fallback: at least half the groups match (for long model names)
                if (qGroupsLower.length >= 3) {
                    const hits = qGroupsLower.filter(g => titleNorm.includes(g) || linkNorm.includes(g)).length;
                    if (hits >= Math.ceil(qGroupsLower.length * 0.6)) return true;
                }
                return false;
            }

            if (qTokens.length === 0) return true;
            const hits = qTokens.filter(t => title.includes(t)).length;
            // Require at least 1 token match (was: min(2, count) which was too strict)
            return hits >= 1;
        });

        // If filtering eliminated everything, that means none of the scraped
        // results actually match the search query — return empty, NOT junk.
        if (relevantData.length === 0 && pageData.length > 0) {
            console.log(`[Custom] Relevance filter eliminated all ${pageData.length} results for "${keyword}" on ${siteName} — none were relevant`);
            // Do NOT fall back to pageData — that's how wrong products (e.g. Razer headset for Logitech search) leak through
        }
    }

    if (relevantData && relevantData.length > 0) {
        console.log(`[Custom] Found ${relevantData.length} relevant item(s) on ${siteName}`);
        return relevantData.map(item => ({
            title: item.title,
            price: item.price || 'N/A',
            description: item.description || '',
            image: item.image || '',
            seller: '',
            link: item.link,
            source: siteName,
            query: keyword || targetUrl,
            location: '',
            postedDate: '',
            dateScraped: new Date().toLocaleString()
        }));
    }

    console.log(`[Custom] No results found on ${siteName} for "${keyword}"`);
    return [{
        title: `No results found on ${siteName}`,
        price: 'N/A',
        seller: '',
        link: targetUrl,
        source: siteName,
        query: keyword || targetUrl,
        location: '',
        postedDate: '',
        dateScraped: new Date().toLocaleString()
    }];
}

// ========================================
// TRY SEARCH BOX — for unknown sites
// ========================================
async function trySearchBox(page, keyword) {
    const selectors = [
        'input[type="search"]',
        'input[name="q"]',
        'input[name="s"]',
        'input[name="search"]',
        'input[name="search_query"]',
        'input[placeholder*="search" i]',
        'input[placeholder*="find" i]',
        'input[id*="search" i]',
        'input[class*="search" i]',
    ];
    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                console.log(`[Custom] Typing "${keyword}" into search box (${sel})`);
                await el.click({ clickCount: 3 });
                await el.type(keyword, { delay: 40 });
                await Promise.race([
                    Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
                        page.keyboard.press('Enter')
                    ]),
                    delay(5000)
                ]);
                return true;
            }
        } catch (_) {}
    }
    return false;
}

// ========================================
// AUTO SCROLL — triggers lazy-loaded content
// ========================================
async function autoScroll(page, times = 3) {
    for (let i = 0; i < times; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight || 800));
        await delay(250);
    }
}

// ========================================
// MULTI-URL SCRAPER — cheerio-based, no browser (safe for low-RAM VPS)
// Full product card parsing with keyword relevance + proper product links
// ========================================

// Score how well a product title matches the keyword.
// Strategy:
//   1. Normalize both sides: lowercase, strip spaces/dashes/dots → "rtx 5080" → "rtx5080"
//   2. If normalized keyword does NOT appear in normalized title → score = 0 (hard filter)
//   3. Otherwise score by how many individual words also match (bonus for exact model hits)
//   4. PENALIZE laptops/desktops heavily (-50 points)
//   5. BOOST standalone graphics cards (+30 points)
function scoreRelevance(title, keyword) {
    if (!title || !keyword) return 0;
    
    const t = title.toLowerCase();
    const tokens = keyword.toLowerCase().split(/[\s\-_.]+/).filter(w => w.length > 1);
    
    if (tokens.length === 0) return 10; // Edge case: keyword had no valid tokens
    
    let matchCount = 0;
    for (const token of tokens) {
        if (t.includes(token)) matchCount++;
    }
    
    // If absolutely zero overlap, reject (so we don't send complete garbage to AI)
    if (matchCount === 0) return 0;
    
    // Return a score based on percentage of matching tokens (1 to 100)
    // The AI (which "understands" the website) will make the final, smart decision.
    return Math.max(1, Math.round((matchCount / tokens.length) * 100));
}

// Soft pre-filter: prefer rule-passing items, but if rules reject everything,
// keep the raw candidates so the AI judge can still evaluate them (e.g. when a
// SKU like "83K1008CAX" is not present in the product title).
function softPrefilter(items, keyword) {
    if (!items || !items.length) return [];
    const scored = items.filter(it => scoreRelevance(it.title, keyword) > 0);
    return (scored.length ? scored : items).slice(0, 15);
}

async function _buildResult(items, keyword, rankKeyword, siteName, searchUrl, hasTva, rawUrl) {
    let best = null;
    if (items.length > 0) {
        // STEP 1: AI PRIMARY JUDGMENT — Let AI validate all products first
        let ranked = items;
        let aiUsed = false;
        try {
            ranked = await aiRankProducts(items, rankKeyword || keyword);
            const aiConfident = ranked.filter(r => r.aiScore >= 70);
            const aiModerate = ranked.filter(r => r.aiScore >= 40);
            if (aiConfident.length > 0) {
                console.log(`[AI] ${siteName}: ${aiConfident.length}/${items.length} confident matches for "${keyword}"`);
                ranked = aiConfident;
                aiUsed = true;
            } else if (aiModerate.length > 0) {
                console.log(`[AI] ${siteName}: ${aiModerate.length}/${items.length} moderate matches for "${keyword}"`);
                ranked = aiModerate;
                aiUsed = true;
            } else if (ranked.length > 0 && ranked[0]?.aiScore > 0) {
                // AI ran but low confidence — use best pick only if it has any positive score
                console.log(`[AI] ${siteName}: low-confidence, using best AI pick (score=${ranked[0]?.aiScore}) for "${keyword}"`);
                ranked = ranked.slice(0, 3);
                aiUsed = true;
            }
            // If AI scored everything 0, aiUsed stays false → rule-based takes over
        } catch (e) {
            console.log(`[AI] ${siteName}: AI failed — ${e.message}`);
        }

        // STEP 2: FALLBACK to rule-based filtering only if AI completely failed/threw
        if (!aiUsed) {
            const ruleScored = items.map(it => ({ ...it, _score: scoreRelevance(it.title, keyword) }));
            const passingRules = ruleScored.filter(it => it._score > 0);
            if (passingRules.length === 0) {
                // Last resort: softPrefilter passes everything to AI next time, but for now return not-found
                console.log(`[Multi] ${siteName}: All ${items.length} items failed rule-based filters`);
                return [{
                    title: `Not found on ${siteName}`,
                    price: 'N/A',
                    seller: '',
                    link: searchUrl,
                    source: siteName,
                    query: keyword || rawUrl,
                    location: '',
                    postedDate: '',
                    dateScraped: new Date().toLocaleString()
                }];
            }
            ranked = passingRules;
        }
        
        // Sort by AI score first, then rule score as tiebreaker
        ranked.sort((a, b) => {
            const scoreA = (a.aiScore || 0) * 10 + (a._score || 0); // Weight AI higher
            const scoreB = (b.aiScore || 0) * 10 + (b._score || 0);
            return scoreB - scoreA;
        });
        
        // Take best match
        const withPrice = ranked.filter(it => it.price && it.price !== 'Price not available' && it.price !== 'N/A');
        best = withPrice.length > 0 ? withPrice[0] : ranked[0];
    }

    // ── Reject search-page links — not real product pages ──
    if (best && best.link) {
        try {
            const urlObj = new URL(best.link.startsWith('http') ? best.link : 'https://' + best.link);
            const path = urlObj.pathname.toLowerCase();
            const query = urlObj.search.toLowerCase();
            
            // A search link is typically the root with a search query, or a /search page
            const isSearchPage = path.includes('/search') || 
                                 path === '/' && (query.includes('?s=') || query.includes('&s=')) ||
                                 query.includes('post_type=product');
            
            if (isSearchPage) {
                console.log(`[Multi] ${siteName}: best link (${best.link}) is a search URL — treating as not found`);
                return [{
                    title: `Not found on ${siteName}`, price: 'N/A', seller: '', link: searchUrl,
                    source: siteName, query: keyword || rawUrl, location: '', postedDate: '',
                    dateScraped: new Date().toLocaleString()
                }];
            }
        } catch (_) {
            // fallback if URL parsing fails
            const bl = best.link.toLowerCase();
            if (bl.includes('/search.php') || bl.includes('post_type=product') || bl === searchUrl.toLowerCase()) {
                console.log(`[Multi] ${siteName}: best link (${best.link}) is a search URL — treating as not found`);
                return [{
                    title: `Not found on ${siteName}`, price: 'N/A', seller: '', link: searchUrl,
                    source: siteName, query: keyword || rawUrl, location: '', postedDate: '',
                    dateScraped: new Date().toLocaleString()
                }];
            }
        }
    }

    // ── MAX ACCURACY: fetch the selected product's OWN page for canonical price ──
    // This fixes wrong prices grabbed from noisy search cards (multiple prices,
    // discounted vs original, per-variant) and detects dead/wrong links.
    if (best && best.link && best.link.startsWith('http')) {
        try {
            const canonical = await extractCanonicalPrice(best.link, best.title);
            if (canonical && canonical.dead) {
                console.log(`[Canonical] ${siteName}: selected link dead (HTTP ${canonical.status}) → marking not found`);
                return [{
                    title: `Not found on ${siteName}`, price: 'N/A', seller: '', link: searchUrl,
                    source: siteName, query: keyword || rawUrl, location: '', postedDate: '',
                    dateScraped: new Date().toLocaleString()
                }];
            }
            if (canonical && canonical.price > 1) {
                console.log(`[Canonical] ${siteName}: "${best.price}" → "${canonical.raw}" (via ${canonical.source})`);
                best = { ...best, price: canonical.raw, _rawPrice: best.price };
            }
        } catch (e) {
            console.log(`[Canonical] ${siteName}: ${e.message}`);
        }
    }

    let priceStr = best?.price || 'N/A';
    console.log(`[TVA Debug] ${siteName}: Input price="${priceStr}", hasTva=${hasTva}`);
    // TVA: only apply if flagged AND the price doesn't already mention TVA
    if (hasTva && priceStr !== 'N/A' && priceStr !== 'Price not available' && !priceStr.toLowerCase().includes('tva')) {
        const num = parseNumericPrice(priceStr);
        console.log(`[TVA Debug] ${siteName}: Parsed num=${num} from "${priceStr}"`);
        const isLbp = num > 100000 || priceStr.toUpperCase().includes('LBP') || priceStr.toUpperCase().includes('LL');
        if (num > 0) {
            const withTva = num * 1.11;
            if (isLbp) {
                priceStr = `LBP ${new Intl.NumberFormat('en-US').format(Math.round(withTva))} (inc. 11% TVA) — Base: LBP ${new Intl.NumberFormat('en-US').format(Math.round(num))}`;
            } else {
                priceStr = `$${withTva.toFixed(2)} (inc. 11% TVA) — Base: $${num.toFixed(2)}`;
            }
        }
    }
    const res = [{
        title:       best?.title || `Not found on ${siteName}`,
        price:       priceStr,
        seller:      '',
        link:        best?.link || searchUrl,
        source:      siteName,
        query:       keyword || rawUrl,
        location:    '',
        postedDate:  '',
        dateScraped: new Date().toLocaleString(),
        allItems:    items.length > 1 ? items : undefined,
        _rawPrice:   best?.price || null, // original raw price for history tracking
    }];
    console.log(`[Multi] ${siteName}: "${res[0].title}" @ ${priceStr} | link: ${res[0].link}`);
    return res;
}

async function scrapeMultipleURLs(urls, keyword, onProgress = () => {}) {
    const allResults = [];
    const BATCH_SIZE = 3;  // reduced from 4 to avoid rate limiting
    const startedAt = Date.now();
    const GLOBAL_TIMEOUT_MS = 120000;  // increased from 90s

    let searchKeyword = keyword;
    let rankKeyword = keyword;
    try {
        console.log(`[AI Pre-flight] Analyzing intent for "${keyword}"...`);
        const exp = await expandSearchQuery(keyword);
        if (exp && exp.toLowerCase() !== keyword.toLowerCase() && exp.length > 3) {
            searchKeyword = exp;
            console.log(`[AI Pre-flight] Keyword expanded: "${keyword}" -> Search: "${searchKeyword}"`);
        }
    } catch(e) {
        console.error('[AI Pre-flight] Error:', e.message);
    }

    const KNOWN_PLATFORMS = {
        '961souq.com': 'shopify',
        'jakcomputer.com': 'shopify',
        'mojitech.net': 'woocommerce',
        'multitech-lb.com': 'woocommerce',
        'pcandparts.com': 'woocommerce',
        'ezonelb.com': 'woocommerce',
        'dslr-zone.com': 'woocommerce',
        'ayoubcomputers.com': 'bigcommerce',
    };

    const SPA_PLATFORMS = new Set(['961souq.com']);

    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
            console.warn('[Multi] Global timeout reached, returning partial results.');
            break;
        }
        const batch = urls.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (rawUrl) => {
            try {
                let urlToScrape = rawUrl.trim();
                let hasTva = false;
                if (/[|\\+]\s*tva$/i.test(urlToScrape)) {
                    hasTva = true;
                    urlToScrape = urlToScrape.replace(/[|\\+]\s*tva$/i, '').trim();
                }
                const baseUrl = urlToScrape.startsWith('http') ? urlToScrape : 'https://' + urlToScrape;
                const siteName = getWebsiteName(urlToScrape);
                const searchUrl = buildSearchUrl(urlToScrape, keyword) || baseUrl;

                // ── Pre-fetch with retry + cookie jar + UA rotation ──
                let prefetchHtml = null;
                let needsBrowser = false;
                try {
                    const config = await siteManager.buildAxiosConfig(searchUrl, { timeout: 12000, referer: baseUrl });
                    const resp = await retryWithBackoff(async () => {
                        const r = await axios.get(searchUrl, config);
                        if (r.headers['set-cookie']) siteManager.setCookie(new URL(searchUrl).hostname, r.headers['set-cookie']);
                        return r;
                    }, { label: `fetch(${siteName})`, maxRetries: 1, baseDelay: 2000 });
                    if (typeof resp.data === 'string') {
                        prefetchHtml = resp.data;
                        if (isBlockedPage(prefetchHtml, resp.status)) needsBrowser = true;
                    }
                } catch (_) {
                    needsBrowser = true;
                }

                if (needsBrowser) {
                    return { _needsBrowser: true, rawUrl, urlToScrape, baseUrl, siteName, searchUrl, hasTva,
                             _fallbackMethod: 'puppeteer' };
                }

                // ── Tier 1: Platform-specific API (fastest) ──────────
                let items = [];
                const knownPlatform = Object.entries(KNOWN_PLATFORMS).find(([d]) => siteName.includes(d))?.[1];
                const platform = knownPlatform || await detectPlatform(baseUrl, prefetchHtml);
                console.log(`[Multi] ${siteName}: platform=${platform}`);

                if (platform === 'shopify') {
                    const raw = await tryShopifyApi(baseUrl, keyword);
                    items = softPrefilter(raw, keyword);
                    if (items.length) console.log(`[Multi] ${siteName}: Shopify API → ${items.length} candidates`);
                } else if (platform === 'bigcommerce') {
                    const raw = await tryBigCommerceSearch(baseUrl, keyword, prefetchHtml);
                    items = softPrefilter(raw, keyword);
                    if (items.length) console.log(`[Multi] ${siteName}: BigCommerce → ${items.length} candidates`);
                } else if (platform === 'nextjs') {
                    let raw = await tryNextJsSearch(baseUrl, keyword);
                    // tryShopifyApi as secondary fallback (961Souq dual-platform)
                    if (!raw.length) raw = await tryShopifyApi(baseUrl, keyword);
                    items = softPrefilter(raw, keyword);
                    if (items.length) console.log(`[Multi] ${siteName}: Next.js → ${items.length} candidates`);
                } else if (platform === 'woocommerce') {
                    // Try WooCommerce REST API first (bypasses HTML scraping)
                    const raw = await tryWooCommerceApi(baseUrl, keyword);
                    items = softPrefilter(raw, keyword);
                    if (items.length) console.log(`[Multi] ${siteName}: WooCommerce API → ${items.length} candidates`);
                }

                // ── Tier 2: Cheerio on search page ──
                if (!items.length) {
                    items = await scrapeWithCheerio(searchUrl, keyword, baseUrl, siteName, true, prefetchHtml);
                    if (items.length === 1 && items[0]._blocked) {
                        return { _needsBrowser: true, rawUrl, urlToScrape, baseUrl, siteName, searchUrl, hasTva,
                                 _fallbackMethod: platform === 'shopify' ? 'camoufox' : 'puppeteer' };
                    }
                    if (items.length === 0 && SPA_PLATFORMS.has(siteName)) {
                        return { _needsBrowser: true, rawUrl, urlToScrape, baseUrl, siteName, searchUrl, hasTva,
                                 _fallbackMethod: 'puppeteer' };
                    }
                }

                // ── Tier 3: Cheerio on home/base URL ──
                if (items.length === 0 && searchUrl !== baseUrl) {
                    const fallback = await scrapeWithCheerio(baseUrl, keyword, baseUrl, siteName);
                    if (fallback.length === 1 && fallback[0]._blocked) {
                        return { _needsBrowser: true, rawUrl, urlToScrape, baseUrl, siteName, searchUrl, hasTva,
                                 _fallbackMethod: 'puppeteer' };
                    }
                    if (fallback.length > 0) items = fallback;
                }

                // ── Tier 4: Last resort — tryWooApi (even though it often needs auth) ──
                if (items.length === 0 && platform === 'woocommerce') {
                    const raw = await tryWooApi(baseUrl, keyword);
                    items = softPrefilter(raw, keyword);
                    if (items.length) console.log(`[Multi] ${siteName}: WooApi fallback → ${items.length} candidates`);
                }

                const res = await _buildResult(items, keyword, rankKeyword, siteName, searchUrl, hasTva, rawUrl);
                onProgress(res, `Completed ${siteName}`);
                return res;
            } catch (e) {
                console.error(`[Multi] Error on ${rawUrl}: ${e.message}`);
                const src = getWebsiteName(rawUrl);
                const failed = [{ title: `Error scraping ${src}: ${e.message}`, price: 'N/A', seller: '', link: rawUrl, source: src, query: keyword || rawUrl, location: '', postedDate: '', dateScraped: new Date().toLocaleString() }];
                onProgress(failed, `Failed ${src}`);
                return failed;
            }
        });

        const batchResults = await Promise.all(batchPromises);

        // Process browser-needed sites sequentially (one at a time)
        for (const r of batchResults) {
            if (r && r._needsBrowser) {
                const { rawUrl, urlToScrape, baseUrl, siteName, searchUrl, hasTva, _fallbackMethod } = r;
                let items = [];

                if (_fallbackMethod === 'camoufox') {
                    // Shopify stores: use Camoufox for JS-heavy pages
                    console.log(`[Multi] ${siteName}: running Camoufox (sequential)…`);
                    try {
                        const browser = await launchBrowser();
                        try {
                            const page = await browser.newPage();
                            await setupPage(page, true);
                            items = await scrapeCustomURL(page, searchKeyword, urlToScrape);
                        } finally {
                            await browser.close().catch(() => {});
                        }
                    } catch (e) {
                        console.error(`[Multi] ${siteName}: Camoufox failed → ${e.message}`);
                    }
                } else {
                    // Default: Puppeteer first, then Camoufox
                    console.log(`[Multi] ${siteName}: running Puppeteer (sequential)…`);
                    const searchUrl = buildSearchUrl(urlToScrape, searchKeyword);
                    items = await scrapeWithPuppeteer(searchUrl, searchKeyword, siteName);
                    if (!items.length) {
                        console.log(`[Multi] ${siteName}: Puppeteer got no results, trying Camoufox…`);
                        try {
                            const browser = await launchBrowser();
                            try {
                                const page = await browser.newPage();
                                await setupPage(page, true);
                                items = await scrapeCustomURL(page, searchKeyword, urlToScrape);
                            } finally {
                                await browser.close().catch(() => {});
                            }
                        } catch (e) {
                            console.error(`[Multi] ${siteName}: Camoufox fallback failed → ${e.message}`);
                        }
                    }
                }

                const res = await _buildResult(items, keyword, rankKeyword, siteName, searchUrl, hasTva, rawUrl);
                onProgress(res, `Completed ${siteName}`);
                allResults.push(...res);
            } else if (r) {
                for (const item of (Array.isArray(r) ? r : [r])) allResults.push(item);
            }
        }
    }

    if (allResults.length === 0) {
        allResults.push({ title: 'No results found across all sites', price: 'N/A', seller: '', link: '#', source: 'Custom URLs', query: keyword || '', location: '', postedDate: '', dateScraped: new Date().toLocaleString() });
    }

    return allResults;
}

// ========================================
// LEGACY BROWSER SCRAPER — kept for reference but NOT called
// ========================================
async function scrapeMultipleURLs_browser(urls, keyword, onProgress = () => {}) {
    const allResults = [];
    let browser;
    const GLOBAL_TIMEOUT_MS = 120000;
    const startedAt = Date.now();

    try {
        browser = await launchBrowser();
        const BATCH_SIZE = 3;
        const PER_URL_TIMEOUT_MS = 45000;

        for (let i = 0; i < urls.length; i += BATCH_SIZE) {
            if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
                console.warn('[Multi] Global timeout reached, returning partial results.');
                break;
            }
            const batch = urls.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (rawUrl) => {
                let page;
                try {
                    // Parse TVA flag
                    let urlToScrape = rawUrl.trim();
                    let hasTva = false;
                    if (/[|\\+]\s*(tva|vat)$/i.test(urlToScrape)) {
                        hasTva = true;
                        urlToScrape = urlToScrape.replace(/[|\\+]\s*(tva|vat)$/i, '').trim();
                    }

                    // ── PHASE 0: Fast axios pre-check (no browser needed) ─────────
                    // Build search URL first, then try fast fetch on it
                    const searchUrl0 = buildSearchUrl(urlToScrape, keyword);
                    const fastTarget = searchUrl0 || (urlToScrape.startsWith('http') ? urlToScrape : 'https://' + urlToScrape);
                    const fastResult = await fastFetchProduct(fastTarget, keyword);
                    if (fastResult && fastResult.price) {
                        const siteName0 = getWebsiteName(urlToScrape);
                        let priceStr = fastResult.price;
                        if (hasTva) {
                            const num = parseNumericPrice(priceStr);
                            if (num > 0) priceStr = `${(num * 1.11).toFixed(2)} (inc. 11% TVA)`;
                        }
                        console.log(`[Fast] ${siteName0}: "${fastResult.title}" @ ${priceStr}`);
                        const fastRes = [{
                            title: fastResult.title || keyword,
                            price: priceStr,
                            seller: '',
                            link: fastTarget,
                            source: siteName0,
                            query: keyword || rawUrl,
                            location: '',
                            postedDate: '',
                            dateScraped: new Date().toLocaleString()
                        }];
                        onProgress(fastRes, `[Fast] ${siteName0}`);
                        return fastRes;
                    }

                    page = await browser.newPage();
                    await setupPage(page, false);

                    const keywordVariants = buildKeywordVariants(keyword || '');
                    let results = [];

                    const searchViaGoogle = async (domain, kw) => {
                        try {
                            const q = `site:${domain} ${kw}`;
                            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
                            console.log(`[Google Fallback] Searching: ${q}`);
                            const gPage = await browser.newPage();
                            await setupPage(gPage, false);
                            await gPage.goto(googleUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                            await delay(1500);
                            
                            const googleResult = await gPage.evaluate((targetDomain) => {
                                // Find the first organic result linking to our target domain
                                const allLinks = document.querySelectorAll('div#search a, div#rso a');
                                for (const a of allLinks) {
                                    if (!a.href || !a.href.includes(targetDomain) || a.href.includes('google.com')) continue;
                                    // Skip "cached" / "similar" links
                                    if (a.textContent.length < 10) continue;
                                    
                                    // Extract title from the heading within the result
                                    const resultBlock = a.closest('div[data-hveid], div.g, div[data-sokoban-container]') || a.parentElement?.parentElement;
                                    let title = '';
                                    const h3 = a.querySelector('h3') || (resultBlock && resultBlock.querySelector('h3'));
                                    if (h3) title = h3.textContent.trim();
                                    if (!title) title = a.textContent.trim().split('\n')[0];
                                    
                                    // Try to extract price from the snippet text
                                    let price = null;
                                    if (resultBlock) {
                                        const snippetText = resultBlock.textContent || '';
                                        const priceMatch = snippetText.match(/(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/i);
                                        if (priceMatch) price = priceMatch[0].trim();
                                    }
                                    
                                    return { link: a.href, title, price };
                                }
                                return null;
                            }, domain);
                            
                            await gPage.close().catch(() => {});
                            if (googleResult) {
                                console.log(`[Google Fallback] Found: "${googleResult.title}" @ ${googleResult.price || 'no price in snippet'} → ${googleResult.link}`);
                                return googleResult;
                            }
                        } catch (e) {
                            console.error(`[Google Fallback] Error: ${e.message}`);
                        }
                        return null;
                    };

                    const urlWork = async () => {
                        for (let idx = 0; idx < Math.max(keywordVariants.length, 1); idx++) {
                            if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
                                throw new Error('Global scrape timeout reached');
                            }
                            const searchKeyword = keywordVariants[idx] || keyword || '';
                            let lastVariantError = null;

                            for (let attempt = 0; attempt < 2; attempt++) {
                                try {
                                    results = await scrapeCustomURL(page, searchKeyword, urlToScrape);
                                    lastVariantError = null;
                                    break;
                                } catch (error) {
                                    lastVariantError = error;
                                    const transientNav = /Execution context was destroyed|Target page, context or browser has been closed/i.test(error.message || '');
                                    if (!transientNav || attempt === 1) break;
                                    if (page) await page.close().catch(() => {});
                                    page = await browser.newPage();
                                    await setupPage(page, false);
                                    await delay(400);
                                }
                            }

                            if (lastVariantError) {
                                if (idx === Math.max(keywordVariants.length, 1) - 1) throw lastVariantError;
                                continue;
                            }

                            const meaningfulResults = results.filter(item => {
                                const title = String(item.title || '');
                                return !/^No results found on /i.test(title) && !/^Error scraping /i.test(title);
                            });

                            if (meaningfulResults.length > 0) break;
                        }

                        // PHASE 3: If native search failed completely, try Google Search Fallback
                        const finalMeaningful = results.filter(item => !/^No results found /i.test(item.title) && !/^Error scraping /i.test(item.title));
                        if (finalMeaningful.length === 0 && keyword) {
                            const domain = getWebsiteName(urlToScrape);
                            const googleResult = await searchViaGoogle(domain, keyword);
                            if (googleResult && googleResult.link) {
                                // If Google snippet already gave us a price, use it directly (fastest path)
                                if (googleResult.price && googleResult.title) {
                                    results = [{
                                        title: googleResult.title,
                                        price: googleResult.price,
                                        description: '',
                                        image: '',
                                        seller: '',
                                        link: googleResult.link,
                                        source: domain,
                                        query: keyword || urlToScrape,
                                        location: '',
                                        postedDate: '',
                                        dateScraped: new Date().toLocaleString()
                                    }];
                                } else {
                                    // No price in snippet — visit the actual product page
                                    try {
                                        const fallbackResults = await scrapeCustomURL(page, '', googleResult.link);
                                        if (fallbackResults && fallbackResults.length > 0) {
                                            const validFb = fallbackResults.filter(item => !/^No results found /i.test(item.title));
                                            if (validFb.length > 0) {
                                                results = validFb;
                                            }
                                        }
                                    } catch (_) {}
                                }
                            }
                        }
                    };

                    await Promise.race([
                        urlWork(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${Math.round(PER_URL_TIMEOUT_MS / 1000)}s`)), PER_URL_TIMEOUT_MS))
                    ]);

                    // Apply TVA markup if flagged
                    if (hasTva && results && results.length > 0) {
                        results.forEach(res => {
                            if (res.price && res.price.toUpperCase() !== 'N/A') {
                                const rawStr = res.price;
                                const cleanStr = rawStr.replace(/[^\d.]/g, '');
                                const numVal = parseFloat(cleanStr);
                                if (!isNaN(numVal) && numVal > 0) {
                                    const withTva = numVal * 1.11;
                                    const currencyMatch = rawStr.match(/[^\d.,\s]+/);
                                    let currency = (currencyMatch ? currencyMatch[0].trim() : '$') || '$';
                                    if (currency.toUpperCase() === 'LBP' || currency.toUpperCase() === 'LL' || numVal > 100000) {
                                        const withTvaFmt = new Intl.NumberFormat('en-US').format(Math.round(withTva));
                                        const origFmt = new Intl.NumberFormat('en-US').format(Math.round(numVal));
                                        res.price = `${currency} ${withTvaFmt} (inc. 11% TVA) — Base: ${currency} ${origFmt}`;
                                    } else {
                                        res.price = `${currency}${withTva.toFixed(2)} (inc. TVA) — Base: ${currency}${numVal.toFixed(2)}`;
                                    }
                                }
                            }
                        });
                    }

                    // Reset query field back to original keyword (not the variant we searched with)
                    results = results.map(item => ({ ...item, query: keyword || rawUrl }));
                    onProgress(results, `Completed ${urlToScrape}`);
                    return results;
                } catch (innerError) {
                    console.error(`[Multi] Error on ${rawUrl}: ${innerError.message}`);
                    const src = getWebsiteName(rawUrl);
                    const failed = [{
                        title: `Error scraping ${src}: ${innerError.message}`,
                        price: 'N/A',
                        seller: '',
                        link: rawUrl,
                        source: src,
                        query: keyword || rawUrl,
                        location: '',
                        postedDate: '',
                        dateScraped: new Date().toLocaleString()
                    }];
                    onProgress(failed, `Failed ${rawUrl}`);
                    return failed;
                } finally {
                    if (page) await page.close().catch(() => {});
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const flatBatch = batchResults.flat();
            for (const r of flatBatch) allResults.push(r);
            onProgress(flatBatch, `Scraped batch of ${batch.length} custom URLs...`);
        }
    } catch (e) {
        console.error(`[Multi] Fatal error: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    if (allResults.length === 0) {
        allResults.push({
            title: 'No results found across all sites',
            price: 'N/A',
            seller: '',
            link: '#',
            source: 'Custom URLs',
            query: keyword || '',
            location: '',
            postedDate: '',
            dateScraped: new Date().toLocaleString()
        });
    }

    return allResults;
}

// ========================================
// SINGLE PRODUCT PAGE CHECK (watchlist)
// ========================================
async function scrapeProductPage(productUrl) {
    let browser;
    try {
        if (!productUrl.startsWith('http')) productUrl = 'https://' + productUrl;

        // Fast pre-check before launching browser
        const fast = await fastFetchProduct(productUrl, '');
        if (fast && fast.price) {
            console.log(`[ProductCheck/Fast] ${productUrl} → ${fast.price}`);
            return { title: fast.title || '', price: fast.price, available: true };
        }

        browser = await launchBrowser();
        const page = await browser.newPage();
        await setupPage(page, true);

        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(2000);

        const data = await page.evaluate((url) => {
            const PRICE_RE = /(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:[.,][0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/gi;
            const bodyText = document.body ? document.body.innerText : '';
            const title = document.title || '';

            function formatMojitechPrice(priceStr, textContext) {
                if (!priceStr || priceStr === 'Price not available' || !url.includes('mojitech.net')) return priceStr;
                const textLower = (textContext || '').toLowerCase();
                if (textLower.includes('tax free') || textLower.includes('tax-free')) return priceStr;
                
                const rawStr = priceStr;
                const cleanStr = rawStr.replace(/[^\d.]/g, '');
                const numVal = parseFloat(cleanStr);
                if (!isNaN(numVal) && numVal > 0) {
                    const withTva = numVal * 1.11;
                    const currencyMatch = rawStr.match(/[^\d.,\s]+/);
                    let currency = (currencyMatch ? currencyMatch[0].trim() : '$') || '$';
                    if (currency.toUpperCase() === 'LBP' || currency.toUpperCase() === 'LL' || numVal > 100000) {
                        const withTvaFmt = new Intl.NumberFormat('en-US').format(Math.round(withTva));
                        const origFmt = new Intl.NumberFormat('en-US').format(Math.round(numVal));
                        return `${currency} ${withTvaFmt} (inc. 11% TVA) — Base: ${currency} ${origFmt}`;
                    } else {
                        return `${currency}${withTva.toFixed(2)} (inc. TVA) — Base: ${currency}${numVal.toFixed(2)}`;
                    }
                }
                return priceStr;
            }


            let foundPrice = null;
            const domSelectors = [
                '.entry-summary .price .woocommerce-Price-amount',
                '.summary .price .woocommerce-Price-amount',
                'p.price .woocommerce-Price-amount',
                '[itemprop="price"]',
                '.product-price',
                '.current-price',
                '.price-current',
                '#product-price',
                'span.price',
            ];
            for (const sel of domSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const txt = (el.innerText || el.getAttribute('content') || '').trim();
                    const m = txt.match(PRICE_RE);
                    if (m && m[0]) { foundPrice = m[0].trim(); break; }
                }
            }

            if (!foundPrice) {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const s of scripts) {
                    try {
                        const d = JSON.parse(s.textContent);
                        const candidates = Array.isArray(d) ? d : [d, ...(d['@graph'] || [])];
                        for (const obj of candidates) {
                            const ofr = obj.offers;
                            if (ofr) {
                                const offerList = Array.isArray(ofr) ? ofr : [ofr];
                                for (const offer of offerList) {
                                    const pv = offer.price;
                                    const cy = offer.priceCurrency || 'USD';
                                    if (pv && parseFloat(pv) > 0) { foundPrice = `${cy} ${parseFloat(pv).toFixed(2)}`; break; }
                                }
                            }
                            if (foundPrice) break;
                        }
                    } catch (_) {}
                    if (foundPrice) break;
                }
            }

            if (!foundPrice) {
                const mp = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content');
                if (mp && parseFloat(mp) > 0) foundPrice = `$${parseFloat(mp).toFixed(2)}`;
            }

            if (!foundPrice) {
                const allMatches = bodyText.match(PRICE_RE) || [];
                const validPrices = allMatches.filter(p => {
                    const num = parseFloat(p.replace(/[^0-9.]/g, ''));
                    return num >= 10;
                });
                if (validPrices.length > 0) foundPrice = validPrices[0].trim();
            }

            const pageText = bodyText.toLowerCase();
            const removed = pageText.includes('no longer available') ||
                            pageText.includes('has been removed') ||
                            pageText.includes('this ad is no longer') ||
                            pageText.includes('page not found') ||
                            (pageText.includes('404') && pageText.length < 2000);

            if (pageText.includes('call for price') || pageText.includes('out of stock') || pageText.includes('sold out')) {
                foundPrice = 'Price not available';
            }
            if (foundPrice) foundPrice = formatMojitechPrice(foundPrice, bodyText);

            return { title: title.substring(0, 200), price: foundPrice, available: !removed };
        }, productUrl);

        return data;
    } catch (e) {
        console.error(`[ProductCheck] Error: ${e.message}`);
        return { title: '', price: null, available: false, error: e.message };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

const { spawn } = require('child_process');

async function callScrapling(action, ...args) {
    return new Promise((resolve, reject) => {
        let pythonProcess;
        try {
            pythonProcess = spawn('python', ['scrapling_service.py', action, ...args], {
                cwd: __dirname
            });
        } catch(e) {
            return reject(e);
        }

        let output = '';
        let errorOutput = '';

        pythonProcess.on('error', (e) => reject(e));

        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python process exited with code ${code}. Stderr: ${errorOutput}`));
                return;
            }
            try {
                const jsonStart = output.indexOf('{');
                const jsonArrayStart = output.indexOf('[');
                const startIdx = jsonStart !== -1 && jsonArrayStart !== -1 ? Math.min(jsonStart, jsonArrayStart) : Math.max(jsonStart, jsonArrayStart);
                if (startIdx === -1) throw new Error("No JSON found in output");
                const result = JSON.parse(output.substring(startIdx));
                if (result.error) reject(new Error(result.error));
                else resolve(result);
            } catch (e) {
                reject(new Error(`Failed to parse python output: ${e.message}`));
            }
        });
    });
}

async function scrapeMultipleURLsWrapper(urls, query, onProgress = () => {}) {
    try {
        console.log(`[Scrapling] Attempting to scrape multiple URLs for "${query}"`);
        const result = await callScrapling('scrapeMultipleURLs', JSON.stringify(urls), query);
        if (result && result.length > 0) {
            onProgress(result, `[Custom] Scraped via Scrapling`);
            return result;
        }
    } catch (e) {
        console.warn(`[Scrapling Fallback] Scrapling failed: ${e.message}. Falling back to old engine.`);
    }
    return scrapeMultipleURLs(urls, query, onProgress);
}

async function scrapeProductPageWrapper(productUrl) {
    try {
        console.log(`[Scrapling] Attempting to scrape product page ${productUrl}`);
        const result = await callScrapling('scrapeProductPage', productUrl);
        if (result && !result.error && result.price) {
            return result;
        }
    } catch (e) {
        console.warn(`[Scrapling Fallback] Scrapling failed: ${e.message}. Falling back to old engine.`);
    }
    return scrapeProductPage(productUrl);
}

module.exports = { 
    scrapeMultipleURLs, 
    scrapeProductPage
};


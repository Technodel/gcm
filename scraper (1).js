const puppeteer = require('puppeteer-core');
const fs = require('fs');

// ========================================
// CHROME DETECTION
// ========================================
function findChrome() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return candidates[0];
}

const CHROME_PATH = findChrome();

// ========================================
// BROWSER LAUNCH — stable args, no --single-process
// ========================================
async function launchBrowser(extraArgs = []) {
    const launchPromise = puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--window-size=1400,900',
            ...extraArgs
        ]
    });
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Chrome failed to launch within 20 seconds')), 20000)
    );
    return Promise.race([launchPromise, timeoutPromise]);
}

// ========================================
// PAGE SETUP — anti-bot, headers, stealth
// ========================================
async function setupPage(page, blockResources = false) {
    await page.setViewport({ width: 1400, height: 900 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    if (blockResources) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });
    }
}

// ========================================
// SITE-SPECIFIC SEARCH URL BUILDERS
// These are the Lebanese e-commerce sites we know
// ========================================
const SITE_SEARCH_PATTERNS = {
    'ayoubcomputers.com':  (kw) => `https://ayoubcomputers.com/search.php?search_query=${encodeURIComponent(kw)}`,
    'mojitech.net':        (kw) => `https://mojitech.net/?s=${encodeURIComponent(kw)}&post_type=product`,
    'ezonelb.com':         (kw) => `https://ezonelb.com/?s=${encodeURIComponent(kw)}&post_type=product`,
    'multitech-lb.com':    (kw) => `https://multitech-lb.com/?s=${encodeURIComponent(kw)}&post_type=product`,
    'dslr-zone.com':       (kw) => `https://www.dslr-zone.com/?s=${encodeURIComponent(kw)}&post_type=product`,
    'pcandparts.com':      (kw) => `https://pcandparts.com/?s=${encodeURIComponent(kw)}&post_type=product`,
    '961souq.com':         (kw) => `https://961souq.com/?s=${encodeURIComponent(kw)}&post_type=product`,
    'jakcomputer.com':     (kw) => `https://jakcomputer.com/?s=${encodeURIComponent(kw)}&post_type=product`,
};

function buildSearchUrl(rawUrl, keyword) {
    if (!keyword) return null;
    try {
        const hostname = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl).hostname.replace(/^www\./, '');
        for (const [domain, builder] of Object.entries(SITE_SEARCH_PATTERNS)) {
            if (hostname.includes(domain)) return builder(keyword);
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

// ========================================
// MAIN DISPATCH
// ========================================
async function scrapePlatform(source, query, maxItems, onProgress = () => {}) {
    if (source === 'Facebook') {
        const res = await scrapeFacebook(query, maxItems);
        onProgress(res, '[Facebook] Scraped Marketplace');
        return res;
    }

    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        await setupPage(page);
        if (source === 'OLX') {
            const res = await scrapeOLX(page, query, maxItems);
            onProgress(res, '[OLX] Scraped OLX');
            return res;
        }
        const res = await scrapeCustomURL(page, query, null);
        onProgress(res, '[Custom] Scraped Custom Target');
        return res;
    } finally {
        await browser.close().catch(() => {});
    }
}

// ========================================
// OLX SCRAPER
// ========================================
async function scrapeOLX(page, query, maxItems) {
    const formattedQuery = query.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '');
    const url = `https://www.olx.com.lb/ads/q-${formattedQuery}/`;
    console.log(`[OLX] Navigating to: ${url}`);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
        console.warn(`[OLX] Load warning: ${e.message}`);
    }

    await page.waitForSelector('li[aria-label="Listing"]', { timeout: 10000 }).catch(() => null);
    await delay(800);

    const results = await page.evaluate((max, searchQuery) => {
        const listings = Array.from(document.querySelectorAll('li[aria-label="Listing"]'));
        if (!listings.length) return [];

        return listings.slice(0, max).map(el => {
            const allSpans = Array.from(el.querySelectorAll('span'));

            const priceEl = allSpans.find(s => {
                const t = s.innerText || '';
                return (t.includes('$') || t.includes('USD') || t.includes('LBP') || t.includes('LL')) && /\d/.test(t);
            });

            const titleEl = el.querySelector('div[title]') || el.querySelector('h2') || el.querySelector('h3');
            let title = titleEl ? (titleEl.getAttribute('title') || titleEl.innerText || '') : '';
            if (!title || title.length < 3) {
                const mainLink = el.querySelector('a[href*="/item/"]') || el.querySelector('a[href]');
                if (mainLink && mainLink.innerText && mainLink.innerText.length > 3) title = mainLink.innerText.trim();
            }

            const linkEl = el.querySelector('a[href*="/item/"]') || el.querySelector('a[href]');
            const link = linkEl ? linkEl.href : '#';

            const locEl = allSpans.find(s => {
                const t = (s.innerText || '').toLowerCase();
                return t.includes('lebanon') || t.includes('beirut') || t.includes('baabda') ||
                       t.includes('tripoli') || t.includes('saida') || t.includes('jounieh') ||
                       t.includes('keserwan') || t.includes('chouf') || t.includes('metn');
            });
            const dateEl = allSpans.find(s => {
                const t = (s.innerText || '').toLowerCase();
                return t.includes('ago') || t.includes('yesterday') || t.includes('today') || t.includes('days');
            });

            let seller = '';
            const sellerEl = el.querySelector('[data-aut-id="seller-name"]') || el.querySelector('[class*="seller"]');
            if (sellerEl) seller = sellerEl.innerText.trim();

            return {
                title: (title || 'Unknown Item').substring(0, 200),
                price: priceEl ? priceEl.innerText.trim() : 'N/A',
                seller,
                link,
                source: 'OLX',
                query: searchQuery,
                location: locEl ? locEl.innerText.trim() : '',
                postedDate: dateEl ? dateEl.innerText.trim() : '',
                dateScraped: new Date().toLocaleString()
            };
        }).filter(r => r.link && r.link !== '#');
    }, maxItems, query);

    console.log(`[OLX] Found ${results.length} results for "${query}"`);
    return results;
}

// ========================================
// FACEBOOK MARKETPLACE (Headless)
// ========================================
async function scrapeFacebook(query, maxItems) {
    console.log(`[Facebook] Connecting headless...`);
    let browser, page;
    try {
        browser = await launchBrowser();
        page = await browser.newPage();
        await setupPage(page);

        const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}&exact=false`;
        console.log(`[Facebook] Navigating to: ${url}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.warn(`[Facebook] Load warning: ${e.message}`);
        }
        await delay(3000);

        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await delay(800);
        }

        const data = await page.evaluate((max, searchQuery) => {
            const items = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
            const results = [];
            for (let i = 0; i < Math.min(items.length, max); i++) {
                const item = items[i];
                const spans = item.querySelectorAll('span');
                let title = '', price = '', location = '';

                const priceEl = Array.from(spans).find(s => {
                    const text = s.innerText.trim();
                    return text.length < 30 && (/\$\s*\d[\d,\.]*/.test(text) || /\d[\d,\.]*\s*\$/.test(text) || text.includes('LBP') || /free/i.test(text)) && /\d/.test(text);
                });
                if (priceEl) price = priceEl.innerText.trim();

                const otherSpans = Array.from(spans).filter(s => s !== priceEl && s.innerText.trim().length > 2);
                if (otherSpans.length > 0) {
                    const locEl = otherSpans.find(s => s.innerText.includes(',') || s.innerText.toLowerCase().includes('lebanon') || s.innerText.toLowerCase().includes('beirut'));
                    if (locEl) location = locEl.innerText.trim();
                    const titleSpans = otherSpans.filter(s => s !== locEl && s.innerText.toLowerCase() !== location.toLowerCase());
                    if (titleSpans.length > 0) {
                        titleSpans.sort((a, b) => b.innerText.length - a.innerText.length);
                        title = titleSpans[0].innerText.trim();
                    }
                }

                results.push({
                    title: (title || 'Facebook Listing').substring(0, 200),
                    price: price || 'N/A',
                    link: item.href,
                    location
                });
            }
            return results;
        }, maxItems, query);

        await page.close();
        await browser.close().catch(() => {});
        console.log(`[Facebook] Scraped ${data.length} items.`);

        if (!data.length) {
            return [{ title: `Facebook Marketplace: "${query}" — No results`, price: 'N/A', seller: '', link: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`, source: 'Facebook Marketplace', query, location: '', postedDate: '', dateScraped: new Date().toLocaleString() }];
        }

        return data.map(item => ({ ...item, seller: '', source: 'Facebook Marketplace', query, postedDate: '', dateScraped: new Date().toLocaleString() }));
    } catch (e) {
        console.error(`[Facebook] Error: ${e.message}`);
        if (page) try { await page.close(); } catch (_) {}
        if (browser) try { await browser.close(); } catch (_) {}
        return [{ title: `Facebook scrape error: ${e.message}`, price: 'N/A', seller: '', link: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`, source: 'Facebook', query, location: '', postedDate: '', dateScraped: new Date().toLocaleString() }];
    }
}

// ========================================
// UTILITY
// ========================================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        // Use networkidle2 only for known search URLs (they have dynamic content), domcontentloaded is faster
        const waitUntil = searchUrl ? 'networkidle2' : 'domcontentloaded';
        await page.goto(targetUrl, { waitUntil, timeout: 45000 });
    } catch (e) {
        console.warn(`[Custom] Navigation warning for ${targetUrl}: ${e.message}`);
        // Don't abort — partial loads often have what we need
    }

    // Extra wait for JS-rendered content
    await delay(searchUrl ? 2500 : 1500);

    // If no known search pattern found, try typing into a search box
    if (!searchUrl && keyword) {
        const didSearch = await trySearchBox(page, keyword);
        if (didSearch) await delay(2000);
    }

    // Scroll to trigger lazy-loaded items
    await autoScroll(page, 3);

    // ================================================
    // EXTRACT — all logic runs inside the browser
    // ================================================
    const pageData = await page.evaluate((currentUrl, siteNameStr) => {
        const cleanText = (t) => (t || '').toString().replace(/\s+/g, ' ').trim();

        // ---- PRICE REGEX ----
        // Matches: $699.00, USD 578, 138.00 $, 1,299 USD, LBP 50000, LL 50,000
        const PRICE_RE = /(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[0-9]{1,3}(?:[,.]?[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]{1,3}(?:[,.]?[0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/i;

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

            for (const { node, price } of priceNodes) {
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
                price = formatMojitechPrice(price, container ? container.innerText : '');
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
    }, targetUrl, siteName);

    if (pageData && pageData.length > 0) {
        console.log(`[Custom] Found ${pageData.length} item(s) on ${siteName}`);
        return pageData.map(item => ({
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
                    page.keyboard.press('Enter').then(() =>
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {})
                    ),
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
        await delay(600);
    }
}

// ========================================
// MULTI-URL SCRAPER — parallel batches, single browser
// ========================================
async function scrapeMultipleURLs(urls, keyword, onProgress = () => {}) {
    const allResults = [];
    let browser;

    try {
        browser = await launchBrowser();
        const BATCH_SIZE = 3;

        for (let i = 0; i < urls.length; i += BATCH_SIZE) {
            const batch = urls.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (rawUrl) => {
                let page;
                try {
                    // Parse TVA flag
                    let urlToScrape = rawUrl.trim();
                    let hasTva = false;
                    if (/[|\\+]\s*tva$/i.test(urlToScrape)) {
                        hasTva = true;
                        urlToScrape = urlToScrape.replace(/[|\\+]\s*tva$/i, '').trim();
                    }

                    page = await browser.newPage();
                    await setupPage(page, false);

                    const results = await scrapeCustomURL(page, keyword || '', urlToScrape);

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

                    return results;
                } catch (innerError) {
                    console.error(`[Multi] Error on ${rawUrl}: ${innerError.message}`);
                    const src = getWebsiteName(rawUrl);
                    return [{
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
        browser = await launchBrowser();
        const page = await browser.newPage();
        await setupPage(page, true);

        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(2000);

        const data = await page.evaluate((url) => {
            const PRICE_RE = /(?:USD|LBP|L\.L\.|LL|€|£|\$)\s*[0-9]{1,3}(?:[,.]?[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]{1,3}(?:[,.]?[0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:USD|LBP|L\.L\.|LL|€|£|\$)/gi;
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

module.exports = { scrapePlatform, scrapeMultipleURLs, scrapeProductPage };

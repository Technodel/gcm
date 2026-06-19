"""
GCM – Galaxy Competitor Monitor
scrapling_service.py  (AI-powered universal rewrite)

Architecture
────────────
1. Fetch the page with StealthyFetcher (anti-bot bypass via Scrapling)
2. Strip the HTML down to a compact text snapshot (keeps minimal structure)
3. Pass the snapshot to Groq (llama-3.1-8b-instant, free tier) for structured extraction
4. Fall back to heuristic CSS selectors if Groq is unavailable or fails
5. All sites are scraped in parallel via ThreadPoolExecutor

Environment variables required
────────────────────────────────
GROQ_API_KEY   – Groq API key  (get free at console.groq.com)

Optional paths (VPS-specific, already configured)
────────────────────────────────────────────────────
PLAYWRIGHT_BROWSERS_PATH / CAMOUFOX_DIR  – set below if running locally
"""

import sys
import os
import json
import re
import traceback
import urllib.parse
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── VPS / local path setup ───────────────────────────────────────────────────
# Adjust these paths if running locally; on VPS they are usually in the system path
_RESOURCES = os.environ.get("SCRAPLING_RESOURCES", r"D:\Resources")
if os.path.isdir(_RESOURCES):
    sys.path.insert(0, _RESOURCES)
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.join(_RESOURCES, "browsers"))
    os.environ.setdefault("CAMOUFOX_DIR",             os.path.join(_RESOURCES, "camoufox"))

# ─── Groq config ──────────────────────────────────────────────────────────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL   = "llama-3.1-8b-instant"   # fast + free tier, ~200 tok/s
GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions"


def call_groq(system_prompt: str, user_prompt: str, temperature: float = 0,
              max_tokens: int = 4096) -> str:
    """
    Send a prompt to Groq (stdlib only, no SDK needed).
    Raises on network error or non-200 status.
    max_tokens bumped to 4096 to avoid silent truncation on product-rich pages.
    """
    import urllib.request
    payload = json.dumps({
        "model":       GROQ_MODEL,
        "messages":    [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens":  max_tokens,
    }).encode()

    req = urllib.request.Request(
        GROQ_URL,
        data=payload,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {GROQ_API_KEY}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


# ─── HTML → compact text snapshot ─────────────────────────────────────────────

def html_to_text_snapshot(html: str, max_chars: int = 14000) -> str:
    """
    Strip noise while keeping just enough structure for the LLM to associate
    product titles, prices, and links correctly.

    Strategy (improved over naive full-strip):
      1. Remove scripts / styles / SVG / iframes wholesale.
      2. Collapse <div>/<section>/<article> boundaries into newlines so product
         card boundaries are still visible.
      3. Convert <a href="...">text</a> to [LINK:url | text] tokens.
      4. Strip all remaining tags.
      5. Collapse whitespace and truncate.
    """
    # 1. Remove noise blocks
    html = re.sub(
        r'<(script|style|svg|noscript|iframe|header|footer|nav)[^>]*>.*?</\1>',
        ' ', html, flags=re.DOTALL | re.IGNORECASE
    )
    html = re.sub(r'<!--.*?-->', ' ', html, flags=re.DOTALL)

    # 2. Block-level boundaries → newlines (keeps card separation)
    html = re.sub(
        r'</?(div|section|article|li|ul|tr|td|th)\b[^>]*>',
        '\n', html, flags=re.IGNORECASE
    )

    # 3. Convert anchor tags to structured tokens BEFORE stripping
    #    Result: [LINK:https://site.com/product | Laptop ASUS 15"]
    def anchor_to_token(m):
        href  = re.search(r'href=["\']([^"\']+)["\']', m.group(0))
        href  = href.group(1) if href else '#'
        # inner text will be captured by the remaining tag strip
        return f' [LINK:{href}] '
    html = re.sub(r'<a\b[^>]*>', anchor_to_token, html, flags=re.IGNORECASE)
    html = re.sub(r'</a>', ' [/LINK] ', html, flags=re.IGNORECASE)

    # 4. Strip all remaining tags
    html = re.sub(r'<[^>]+>', ' ', html)

    # 5. Decode common HTML entities
    html = html.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>') \
               .replace('&nbsp;', ' ').replace('&#8203;', '')

    # 6. Collapse whitespace (keep single newlines for card boundaries)
    html = re.sub(r'[ \t]+', ' ', html)
    html = re.sub(r'\n{3,}', '\n\n', html)

    return html[:max_chars]


# ─── Search URL discovery & cache ─────────────────────────────────────────────

_SEARCH_URL_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       "search_url_cache.json")

def _load_search_url_cache() -> dict:
    if os.path.exists(_SEARCH_URL_CACHE_FILE):
        try:
            with open(_SEARCH_URL_CACHE_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def _save_search_url_cache(cache: dict):
    try:
        with open(_SEARCH_URL_CACHE_FILE, "w") as f:
            json.dump(cache, f, indent=2)
    except Exception:
        pass

# Known patterns – instant, no HTTP request needed
_KNOWN_SEARCH_PATTERNS = {
    "ayoubcomputers.com":  "https://ayoubcomputers.com/?s={query_enc}",
    "mojitech.net":        "https://mojitech.net/?s={query_enc}",
    "ezonelb.com":         "https://ezonelb.com/?s={query_enc}",
    "multitech-lb.com":    "https://multitech-lb.com/?s={query_enc}",
    "dslr-zone.com":       "https://www.dslr-zone.com/?s={query_enc}",
    "pcandparts.com":      "https://pcandparts.com/?s={query_enc}",
    "961souq.com":         "https://961souq.com/?s={query_enc}",
    "jakcomputer.com":     "https://jakcomputer.com/?s={query_enc}",
    "olx.com.lb":          "https://www.olx.com.lb/ads/q-{query_dash}/",
    "facebook.com":        "https://www.facebook.com/marketplace/search/?query={query_enc}&exact=false",
}


def get_search_url(base_url: str, query: str) -> str:
    """Return the correct search-results URL for this site + query."""
    if not base_url.startswith("http"):
        base_url = "https://" + base_url
    parsed   = urlparse(base_url)
    hostname = parsed.netloc.lstrip("www.")

    q_enc  = urllib.parse.quote_plus(query)
    q_dash = re.sub(r'[^a-zA-Z0-9\-]', '-', query)

    # 1. Known patterns
    for domain, pattern in _KNOWN_SEARCH_PATTERNS.items():
        if domain in hostname:
            return pattern.format(query=query, query_enc=q_enc, query_dash=q_dash)

    # 2. Cached discovery
    cache = _load_search_url_cache()
    if hostname in cache:
        return cache[hostname].format(query=query, query_enc=q_enc, query_dash=q_dash)

    # 3. AI discovery (only when Groq key is available)
    if GROQ_API_KEY:
        try:
            discovered = discover_search_url_ai(base_url)
            if discovered and "{query" in discovered:
                cache[hostname] = discovered
                _save_search_url_cache(cache)
                return discovered.format(query=query, query_enc=q_enc, query_dash=q_dash)
        except Exception:
            pass

    # 4. WooCommerce /?s= fallback (covers ~80 % of Lebanese tech shops)
    return f"{base_url.rstrip('/')}/?s={q_enc}"


def discover_search_url_ai(base_url: str) -> str:
    """Fetch homepage, ask Groq for the search URL template."""
    from scrapling.fetchers import StealthyFetcher
    page    = StealthyFetcher.fetch(base_url, headless=True)
    snippet = html_to_text_snapshot(page.html, max_chars=6000)
    system  = "You are a web analyst. Respond with ONLY the URL template, nothing else."
    user    = (
        f"Homepage of {base_url}:\n\n{snippet}\n\n"
        "What is the search URL pattern? Replace the query with {query_enc} for URL-encoded.\n"
        "Example: https://example.com/?s={query_enc}\n"
        "If unknown, reply: UNKNOWN"
    )
    result = call_groq(system, user).strip()
    if result.startswith("http") and "{query" in result:
        return result
    return ""


# ─── AI product extractor ──────────────────────────────────────────────────────

def ai_extract_products(html: str, query: str, base_url: str,
                         max_items: int, source_label: str) -> list:
    """
    Send a structured text snapshot to Groq and parse the JSON product list.
    Returns [] if Groq is unavailable or returns unparseable output.
    """
    if not GROQ_API_KEY:
        return []

    snapshot = html_to_text_snapshot(html, max_chars=14000)

    system = (
        "You are a product data extractor for an e-commerce price comparison tool. "
        "You receive page snapshots and return ONLY a valid JSON array. "
        "Never add any text, markdown fences, or explanation outside the JSON array."
    )
    user = (
        f'Search query: "{query}"\n'
        f"Source site: {source_label} ({base_url})\n"
        f"Extract up to {max_items} products that match the query.\n\n"
        "Rules:\n"
        "- Return ONLY a raw JSON array, no markdown, no commentary.\n"
        '- Each item: {"title": "...", "price": "...", "link": "..."}\n'
        "- title: clean product name, no HTML.\n"
        "- price: include currency symbol (USD, $, LBP, LL). Use \"N/A\" if not found.\n"
        "- link: absolute URL. Prepend base URL if relative.\n"
        "- Skip navigation links, banners, category headers, unrelated items.\n"
        "- The [LINK:url] tokens in the snapshot mark anchor hrefs — use them for the link field.\n"
        "- If no products found, return []\n\n"
        f"PAGE SNAPSHOT:\n{snapshot}"
    )

    raw = call_groq(system, user, max_tokens=4096)

    # Strip any accidental markdown fences
    raw = raw.strip()
    raw = re.sub(r'^```[a-z]*\n?', '', raw)
    raw = re.sub(r'\n?```$', '', raw)

    products = json.loads(raw)   # raises on bad JSON → caller catches

    results = []
    for p in products[:max_items]:
        title = str(p.get("title", "")).strip()[:250]
        price = str(p.get("price", "N/A")).strip()
        link  = str(p.get("link",  "")).strip()

        if not title:
            continue

        if link and not link.startswith("http"):
            link = urljoin(base_url, link)

        results.append({
            "title":  title,
            "price":  price,
            "seller": "",
            "link":   link or "#",
            "source": source_label,
            "query":  query,
        })
    return results


# ─── Heuristic CSS fallback ────────────────────────────────────────────────────

def heuristic_extract_products(page, query: str, base_url: str,
                                max_items: int, source_label: str) -> list:
    """
    CSS-heuristic fallback when Groq is unavailable or returns bad JSON.
    Tries a broad set of common product card selectors.
    """
    PRODUCT_SELECTORS = [
        "li.product", ".product-item", ".product-card", "article.product",
        ".product", "[class*='product-']", "[class*='item-product']",
        ".woocommerce-loop-product__link", ".goods-item", ".catalog-item",
        ".search-result-item", "[data-product-id]",
    ]
    PRICE_SELECTORS = [
        ".price", ".woocommerce-Price-amount", ".amount",
        "[class*='price']", "[itemprop='price']",
    ]

    cards = []
    for sel in PRODUCT_SELECTORS:
        try:
            cards = page.css(sel)
            if cards:
                break
        except Exception:
            continue

    results = []
    for card in cards:
        if len(results) >= max_items:
            break

        # Title
        title = ""
        for t_sel in ["h1", "h2", "h3", "h4", ".product-title", ".name", "a"]:
            els = card.css(t_sel)
            if els and els[0].text.strip():
                title = els[0].text.strip()[:250]
                break

        # Link
        link = "#"
        a_tags = card.css("a")
        if a_tags:
            href = a_tags[0].attrib.get("href", "#")
            link = href if href.startswith("http") else urljoin(base_url, href)

        # Price
        price = "N/A"
        for p_sel in PRICE_SELECTORS:
            els = card.css(p_sel)
            if els:
                price = els[0].text.strip()
                break
        if price == "N/A":
            for span in card.css("span"):
                t = span.text.strip()
                if re.search(r'[\$]|\bUSD\b|\bLBP\b|\bLL\b', t, re.IGNORECASE) and any(c.isdigit() for c in t):
                    price = t
                    break

        if title:
            results.append({
                "title":  title,
                "price":  price,
                "seller": "",
                "link":   link,
                "source": source_label,
                "query":  query,
            })

    return results


# ─── Page fetcher ──────────────────────────────────────────────────────────────

def fetch_page(url: str):
    from scrapling.fetchers import StealthyFetcher
    return StealthyFetcher.fetch(url, headless=True)


# ─── Single-site scraper ───────────────────────────────────────────────────────

def scrape_site(url: str, query: str, max_items: int) -> list:
    """
    Universal scraper: any e-commerce site.
    1. Find the correct search URL.
    2. Fetch with StealthyFetcher.
    3. AI extraction → heuristic fallback.
    """
    if not url.startswith("http"):
        url = "https://" + url

    source_label = urlparse(url).netloc.lstrip("www.")
    search_url   = get_search_url(url, query)

    page = fetch_page(search_url)

    if GROQ_API_KEY:
        try:
            results = ai_extract_products(page.html, query, search_url, max_items, source_label)
            if results:
                return results
        except Exception as e:
            sys.stderr.write(f"[AI extract failed: {source_label}] {e}\n")

    return heuristic_extract_products(page, query, search_url, max_items, source_label)


def scrape_olx(query: str, max_items: int) -> list:
    q_dash = re.sub(r'[^a-zA-Z0-9\-]', '-', query)
    url    = f"https://www.olx.com.lb/ads/q-{q_dash}/"
    page   = fetch_page(url)

    if GROQ_API_KEY:
        try:
            results = ai_extract_products(page.html, query, url, max_items, "OLX")
            if results:
                return results
        except Exception:
            pass

    # OLX-specific heuristic
    results  = []
    listings = page.css('li[aria-label="Listing"]', adaptive=True) or page.css("li")
    for item in listings:
        if len(results) >= max_items:
            break
        title_els = item.css("div[title]")
        title     = title_els[0].attrib.get("title", "") if title_els else ""
        if not title:
            a_tags = item.css("a")
            if a_tags:
                title = a_tags[0].text.strip()
        a_tags = item.css('a[href*="/item/"]') or item.css("a")
        link   = ("https://www.olx.com.lb" + a_tags[0].attrib.get("href", "")) if a_tags else "#"
        price  = "N/A"
        for span in item.css("span"):
            t = span.text.upper()
            if re.search(r'\$|USD|LBP|LL', t) and any(c.isdigit() for c in t):
                price = span.text
                break
        if title and link != "#":
            results.append({"title": title[:200], "price": price, "seller": "",
                             "link": link, "source": "OLX", "query": query})
    return results


def scrape_facebook(query: str, max_items: int) -> list:
    url  = f"https://www.facebook.com/marketplace/search/?query={urllib.parse.quote(query)}&exact=false"
    page = fetch_page(url)

    if GROQ_API_KEY:
        try:
            results = ai_extract_products(page.html, query, url, max_items, "Facebook")
            if results:
                return results
        except Exception:
            pass

    # Facebook heuristic
    results = []
    items   = page.css('a[href*="/marketplace/item/"]')
    for item in items:
        if len(results) >= max_items:
            break
        href  = item.attrib.get("href", "#")
        link  = ("https://www.facebook.com" + href) if href.startswith("/") else href
        spans = item.css("span")
        price, title = "N/A", ""
        for span in spans:
            t = span.text.strip()
            if len(t) < 30 and re.search(r'\$|LBP|free', t, re.IGNORECASE) and any(c.isdigit() for c in t):
                price = t
                break
        for span in spans:
            t = span.text.strip()
            if t and t != price and not re.match(r'beirut|lebanon', t, re.IGNORECASE) and len(t) > len(title):
                title = t
        results.append({"title": title[:200] or "Facebook Listing", "price": price,
                         "seller": "", "link": link, "source": "Facebook", "query": query})
    return results


def scrape_product_page(url: str) -> dict:
    """Scrape a single product detail page → {title, price, available, sku}."""
    if not url.startswith("http"):
        url = "https://" + url
    page = fetch_page(url)

    if GROQ_API_KEY:
        try:
            snapshot = html_to_text_snapshot(page.html, max_chars=8000)
            system   = "You are a product data extractor. Respond with ONLY valid JSON, no markdown."
            user     = (
                f"Product page: {url}\n\n"
                'Return exactly: {"title": "...", "price": "...", "sku": "...", "available": true/false}\n'
                "- price: include currency. \"N/A\" if missing.\n"
                "- sku: model number / product code if visible, else \"\"\n"
                "- available: true if in stock, false if out of stock\n\n"
                f"PAGE SNAPSHOT:\n{snapshot}"
            )
            raw = call_groq(system, user, max_tokens=512).strip()
            raw = re.sub(r'^```[a-z]*\n?', '', raw)
            raw = re.sub(r'\n?```$', '', raw)
            result = json.loads(raw)
            result.setdefault("available", True)
            result.setdefault("sku", "")
            return result
        except Exception as e:
            sys.stderr.write(f"[AI product page failed] {e}\n")

    # Heuristic fallback
    price = "Price not available"
    for sel in [".price", ".woocommerce-Price-amount", ".amount",
                "[itemprop='price']", "[class*='price']"]:
        els = page.css(sel)
        if els:
            price = els[0].text.strip()
            break
    title_els = page.css("h1")
    title     = title_els[0].text.strip() if title_els else ""
    return {"title": title[:250], "price": price, "available": True, "sku": ""}


# ─── Parallel multi-site scraper ───────────────────────────────────────────────

def scrape_multiple_urls_parallel(urls: list, query: str, max_each: int = 10,
                                   max_workers: int = 6) -> list:
    """
    Scrape all URLs in parallel using a thread pool.
    max_workers=6 → up to 6 sites fetched simultaneously.
    Falls back to empty list per site on error, never crashes the whole batch.
    """
    results = []

    def _scrape_one(url):
        try:
            return scrape_site(url, query, max_each)
        except Exception as e:
            sys.stderr.write(f"[parallel scrape error: {url}] {e}\n")
            return []

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_scrape_one, url): url for url in urls}
        for future in as_completed(futures, timeout=120):
            try:
                results.extend(future.result())
            except Exception as e:
                sys.stderr.write(f"[future error: {futures[future]}] {e}\n")

    return results


# ─── CLI dispatcher ────────────────────────────────────────────────────────────

def main():
    try:
        action = sys.argv[1]

        if action == "scrapePlatform":
            source    = sys.argv[2]
            query     = sys.argv[3]
            max_items = int(sys.argv[4])

            if source == "OLX":
                res = scrape_olx(query, max_items)
            elif source == "Facebook":
                res = scrape_facebook(query, max_items)
            else:
                res = scrape_site(source, query, max_items)

            print(json.dumps(res))

        elif action == "scrapeMultipleURLs":
            urls     = json.loads(sys.argv[2])
            query    = sys.argv[3]
            max_each = int(sys.argv[4]) if len(sys.argv) > 4 else 10
            # ★ Parallel scraping – all sites hit simultaneously
            res = scrape_multiple_urls_parallel(urls, query, max_each)
            print(json.dumps(res))

        elif action == "scrapeProductPage":
            url = sys.argv[2]
            res = scrape_product_page(url)
            print(json.dumps(res))

        elif action == "discoverSearchUrl":
            base_url = sys.argv[2]
            result   = discover_search_url_ai(base_url)
            print(json.dumps({"url": result or "UNKNOWN"}))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)


if __name__ == "__main__":
    main()

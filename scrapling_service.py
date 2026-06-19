"""
GCM – Galaxy Competitor Monitor
scrapling_service.py  (AI-powered universal rewrite)

Architecture
────────────
1. Fetch the page with StealthyFetcher (anti-bot bypass via Scrapling)
2. Strip the HTML down to a compact text snapshot (keeps minimal structure)
3. Try LLM providers in order until one succeeds:
      1st  Groq         (llama-3.1-8b-instant  — fastest, free tier)
      2nd  OpenRouter   (deepseek/deepseek-chat — high quality fallback)
      3rd  DeepSeek     (deepseek-chat          — direct API fallback)
4. Fall back to heuristic CSS selectors if all LLMs are unavailable
5. All sites are scraped in parallel via ThreadPoolExecutor

NOTE: Voyage AI was evaluated but is an embeddings-only API (not a text
generation model) so it cannot extract product data and is not included.

Environment variables (set in .env on the VPS)
────────────────────────────────────────────────
GROQ_API_KEY        – Groq key      (console.groq.com, free)
OPENROUTER_API_KEY  – OpenRouter    (openrouter.ai, pay-as-you-go)
DEEPSEEK_API_KEY    – DeepSeek      (platform.deepseek.com)
"""

import sys
import os
import json
import re
import traceback
import urllib.parse
import urllib.request
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── VPS / local path setup ───────────────────────────────────────────────────
_RESOURCES = os.environ.get("SCRAPLING_RESOURCES", r"D:\Resources")
if os.path.isdir(_RESOURCES):
    sys.path.insert(0, _RESOURCES)
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.join(_RESOURCES, "browsers"))
    os.environ.setdefault("CAMOUFOX_DIR",             os.path.join(_RESOURCES, "camoufox"))

# ─── LLM provider config ──────────────────────────────────────────────────────
GROQ_API_KEY       = os.environ.get("GROQ_API_KEY",       "")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
DEEPSEEK_API_KEY   = os.environ.get("DEEPSEEK_API_KEY",   "")

# Providers tried in order — first success wins
LLM_PROVIDERS = []

if GROQ_API_KEY:
    LLM_PROVIDERS.append({
        "name":    "Groq",
        "url":     "https://api.groq.com/openai/v1/chat/completions",
        "key":     GROQ_API_KEY,
        "model":   "llama-3.1-8b-instant",
        "headers": {},
    })

if OPENROUTER_API_KEY:
    LLM_PROVIDERS.append({
        "name":    "OpenRouter",
        "url":     "https://openrouter.ai/api/v1/chat/completions",
        "key":     OPENROUTER_API_KEY,
        "model":   "deepseek/deepseek-chat",   # best quality on free credits
        "headers": {
            "HTTP-Referer": "https://gcm.technodel.tech",
            "X-Title":      "GCM Galaxy Competitor Monitor",
        },
    })

if DEEPSEEK_API_KEY:
    LLM_PROVIDERS.append({
        "name":    "DeepSeek",
        "url":     "https://api.deepseek.com/v1/chat/completions",
        "key":     DEEPSEEK_API_KEY,
        "model":   "deepseek-chat",
        "headers": {},
    })

_llm_available = len(LLM_PROVIDERS) > 0


# ─── LLM call with automatic provider fallback ────────────────────────────────

def _call_provider(provider: dict, system_prompt: str, user_prompt: str,
                   temperature: float, max_tokens: int) -> str:
    """Make a single OpenAI-compatible chat completion request."""
    payload = json.dumps({
        "model":       provider["model"],
        "messages":    [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens":  max_tokens,
    }).encode()

    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {provider['key']}",
        **provider.get("headers", {}),
    }
    req = urllib.request.Request(provider["url"], data=payload, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def call_llm(system_prompt: str, user_prompt: str,
             temperature: float = 0, max_tokens: int = 4096) -> str:
    """
    Try each LLM provider in order (Groq → OpenRouter → DeepSeek).
    Raises RuntimeError only if ALL providers fail.
    """
    last_error = None
    for provider in LLM_PROVIDERS:
        try:
            result = _call_provider(provider, system_prompt, user_prompt,
                                    temperature, max_tokens)
            return result
        except Exception as e:
            sys.stderr.write(f"[LLM] {provider['name']} failed: {e} — trying next\n")
            last_error = e
            continue

    raise RuntimeError(f"All LLM providers failed. Last error: {last_error}")


# ─── HTML → compact text snapshot ─────────────────────────────────────────────

def html_to_text_snapshot(html: str, max_chars: int = 14000) -> str:
    """
    Strip noise while keeping enough structure for the LLM to correctly
    associate product titles, prices, and links.

    1. Remove scripts / styles / SVG / iframes wholesale.
    2. Collapse block-level elements into newlines (preserves card boundaries).
    3. Convert <a href="url">text</a> → [LINK:url] text [/LINK]
    4. Strip all remaining tags.
    5. Decode entities, collapse whitespace, truncate.
    """
    # 1. Remove noise blocks
    html = re.sub(
        r'<(script|style|svg|noscript|iframe|header|footer|nav)[^>]*>.*?</\1>',
        ' ', html, flags=re.DOTALL | re.IGNORECASE
    )
    html = re.sub(r'<!--.*?-->', ' ', html, flags=re.DOTALL)

    # 2. Block boundaries → newlines (keeps product card separation)
    html = re.sub(
        r'</?(div|section|article|li|ul|tr|td|th)\b[^>]*>',
        '\n', html, flags=re.IGNORECASE
    )

    # 3. Anchor tags → structured tokens
    def anchor_to_token(m):
        href = re.search(r'href=["\']([^"\']+)["\']', m.group(0))
        return f' [LINK:{href.group(1)}] ' if href else ' '

    html = re.sub(r'<a\b[^>]*>',  anchor_to_token, html, flags=re.IGNORECASE)
    html = re.sub(r'</a>',         ' [/LINK] ',    html, flags=re.IGNORECASE)

    # 4. Strip all remaining tags
    html = re.sub(r'<[^>]+>', ' ', html)

    # 5. Decode common HTML entities
    for enc, dec in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&nbsp;',' '),('&#8203;','')]:
        html = html.replace(enc, dec)

    # 6. Collapse whitespace (keep single newlines for card boundaries)
    html = re.sub(r'[ \t]+', ' ', html)
    html = re.sub(r'\n{3,}', '\n\n', html)

    return html[:max_chars]


# ─── Search URL discovery & cache ─────────────────────────────────────────────

_SEARCH_URL_CACHE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "search_url_cache.json"
)

def _load_search_url_cache() -> dict:
    if os.path.exists(_SEARCH_URL_CACHE_FILE):
        try:
            with open(_SEARCH_URL_CACHE_FILE) as f:
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

_KNOWN_SEARCH_PATTERNS = {
    "ayoubcomputers.com": "https://ayoubcomputers.com/?s={query_enc}",
    "mojitech.net":       "https://mojitech.net/?s={query_enc}",
    "ezonelb.com":        "https://ezonelb.com/?s={query_enc}",
    "multitech-lb.com":   "https://multitech-lb.com/?s={query_enc}",
    "dslr-zone.com":      "https://www.dslr-zone.com/?s={query_enc}",
    "pcandparts.com":     "https://pcandparts.com/?s={query_enc}",
    "961souq.com":        "https://961souq.com/?s={query_enc}",
    "jakcomputer.com":    "https://jakcomputer.com/?s={query_enc}",
    "olx.com.lb":         "https://www.olx.com.lb/ads/q-{query_dash}/",
    "facebook.com":       "https://www.facebook.com/marketplace/search/?query={query_enc}&exact=false",
}


def get_search_url(base_url: str, query: str) -> str:
    if not base_url.startswith("http"):
        base_url = "https://" + base_url
    hostname = urlparse(base_url).netloc.lstrip("www.")
    q_enc  = urllib.parse.quote_plus(query)
    q_dash = re.sub(r'[^a-zA-Z0-9\-]', '-', query)

    for domain, pattern in _KNOWN_SEARCH_PATTERNS.items():
        if domain in hostname:
            return pattern.format(query=query, query_enc=q_enc, query_dash=q_dash)

    cache = _load_search_url_cache()
    if hostname in cache:
        return cache[hostname].format(query=query, query_enc=q_enc, query_dash=q_dash)

    if _llm_available:
        try:
            discovered = discover_search_url_ai(base_url)
            if discovered and "{query" in discovered:
                cache[hostname] = discovered
                _save_search_url_cache(cache)
                return discovered.format(query=query, query_enc=q_enc, query_dash=q_dash)
        except Exception:
            pass

    return f"{base_url.rstrip('/')}/?s={q_enc}"


def discover_search_url_ai(base_url: str) -> str:
    from scrapling.fetchers import StealthyFetcher
    page    = StealthyFetcher.fetch(base_url, headless=True)
    snippet = html_to_text_snapshot(page.html, max_chars=6000)
    system  = "You are a web analyst. Respond with ONLY the URL template, nothing else."
    user    = (
        f"Homepage of {base_url}:\n\n{snippet}\n\n"
        "What is the search URL pattern? Replace the query with {query_enc} (URL-encoded).\n"
        "Example: https://example.com/?s={query_enc}\n"
        "If unknown, reply: UNKNOWN"
    )
    result = call_llm(system, user, max_tokens=128).strip()
    return result if (result.startswith("http") and "{query" in result) else ""


# ─── AI product extractor ──────────────────────────────────────────────────────

def ai_extract_products(html: str, query: str, base_url: str,
                         max_items: int, source_label: str) -> list:
    """
    Pass a structured text snapshot to the LLM (fallback chain: Groq → OpenRouter → DeepSeek).
    Returns [] on failure so caller can fall through to heuristics.
    """
    if not _llm_available:
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
        "- price: include currency (USD, $, LBP, LL). Use \"N/A\" if not found.\n"
        "- link: absolute URL. Prepend base URL if relative.\n"
        "- The [LINK:url] tokens mark anchor hrefs — use them for the link field.\n"
        "- Skip navigation links, banners, category headers, unrelated items.\n"
        "- If no products found, return []\n\n"
        f"PAGE SNAPSHOT:\n{snapshot}"
    )

    raw = call_llm(system, user, max_tokens=4096)

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
        title = ""
        for t_sel in ["h1", "h2", "h3", "h4", ".product-title", ".name", "a"]:
            els = card.css(t_sel)
            if els and els[0].text.strip():
                title = els[0].text.strip()[:250]
                break
        link = "#"
        a_tags = card.css("a")
        if a_tags:
            href = a_tags[0].attrib.get("href", "#")
            link = href if href.startswith("http") else urljoin(base_url, href)
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
                "title": title, "price": price, "seller": "",
                "link": link, "source": source_label, "query": query,
            })
    return results


# ─── Page fetcher ──────────────────────────────────────────────────────────────

def fetch_page(url: str):
    from scrapling.fetchers import StealthyFetcher
    return StealthyFetcher.fetch(url, headless=True)


# ─── Single-site scraper ───────────────────────────────────────────────────────

def scrape_site(url: str, query: str, max_items: int) -> list:
    if not url.startswith("http"):
        url = "https://" + url
    source_label = urlparse(url).netloc.lstrip("www.")
    search_url   = get_search_url(url, query)
    page         = fetch_page(search_url)

    if _llm_available:
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

    if _llm_available:
        try:
            results = ai_extract_products(page.html, query, url, max_items, "OLX")
            if results:
                return results
        except Exception:
            pass

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

    if _llm_available:
        try:
            results = ai_extract_products(page.html, query, url, max_items, "Facebook")
            if results:
                return results
        except Exception:
            pass

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
    if not url.startswith("http"):
        url = "https://" + url
    page = fetch_page(url)

    if _llm_available:
        try:
            snapshot = html_to_text_snapshot(page.html, max_chars=8000)
            system   = "You are a product data extractor. Respond with ONLY valid JSON, no markdown."
            user     = (
                f"Product page: {url}\n\n"
                'Return exactly: {"title":"...","price":"...","sku":"...","available":true/false}\n'
                "price: include currency. \"N/A\" if missing.\n"
                "sku: model number or product code if visible, else \"\"\n"
                "available: true if in stock, false if out of stock\n\n"
                f"PAGE SNAPSHOT:\n{snapshot}"
            )
            raw = call_llm(system, user, max_tokens=512).strip()
            raw = re.sub(r'^```[a-z]*\n?', '', raw)
            raw = re.sub(r'\n?```$', '', raw)
            result = json.loads(raw)
            result.setdefault("available", True)
            result.setdefault("sku", "")
            return result
        except Exception as e:
            sys.stderr.write(f"[AI product page failed] {e}\n")

    price = "Price not available"
    for sel in [".price", ".woocommerce-Price-amount", ".amount",
                "[itemprop='price']", "[class*='price']"]:
        els = page.css(sel)
        if els:
            price = els[0].text.strip()
            break
    title_els = page.css("h1")
    return {"title": (title_els[0].text.strip() if title_els else "")[:250],
            "price": price, "available": True, "sku": ""}


# ─── Parallel multi-site scraper ───────────────────────────────────────────────

def scrape_multiple_urls_parallel(urls: list, query: str,
                                   max_each: int = 10, max_workers: int = 6) -> list:
    """Scrape all URLs simultaneously — 6 sites at once instead of one-by-one."""
    results = []

    def _scrape_one(url):
        try:
            return scrape_site(url, query, max_each)
        except Exception as e:
            sys.stderr.write(f"[parallel error: {url}] {e}\n")
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
    # Log which providers are active at startup
    provider_names = [p["name"] for p in LLM_PROVIDERS] or ["heuristic-only"]
    sys.stderr.write(f"[GCM scraper] LLM chain: {' → '.join(provider_names)}\n")

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
            res      = scrape_multiple_urls_parallel(urls, query, max_each)
            print(json.dumps(res))

        elif action == "scrapeProductPage":
            res = scrape_product_page(sys.argv[2])
            print(json.dumps(res))

        elif action == "discoverSearchUrl":
            result = discover_search_url_ai(sys.argv[2])
            print(json.dumps({"url": result or "UNKNOWN"}))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)


if __name__ == "__main__":
    main()

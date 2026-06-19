import sys
import os
import json
import traceback

sys.path.insert(0, r"D:\Resources")
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = r"D:\Resources\browsers"
os.environ["CAMOUFOX_DIR"] = r"D:\Resources\camoufox"


def scrape_olx(query, max_items):
    from scrapling.fetchers import StealthyFetcher
    formatted_query = query.replace(' ', '-').replace('/', '')
    url = f"https://www.olx.com.lb/ads/q-{formatted_query}/"
    page = StealthyFetcher.fetch(url, headless=True)
    
    results = []
    # Adaptive search for listing items
    listings = page.css('li[aria-label="Listing"]', adaptive=True)
    if not listings:
        listings = page.css('li') # Fallback if totally changed
        
    for item in listings:
        if len(results) >= max_items:
            break
            
        title_els = item.css('div[title]')
        title = title_els[0].attrib.get('title', '') if title_els else ''
        if not title:
            # try finding links
            a_tags = item.css('a')
            if a_tags:
                title = a_tags[0].text
                
        # Link
        a_tags = item.css('a[href*="/item/"]')
        link = "https://www.olx.com.lb" + a_tags[0].attrib['href'] if a_tags else '#'
        if link == '#' and item.css('a'):
            link = "https://www.olx.com.lb" + item.css('a')[0].attrib.get('href', '')
            
        # Price
        price = 'N/A'
        spans = item.css('span')
        for span in spans:
            t = span.text.upper()
            if ('$' in t or 'USD' in t or 'LBP' in t or 'LL' in t) and any(c.isdigit() for c in t):
                price = span.text
                break
                
        if title and link != '#':
            results.append({
                "title": title[:200],
                "price": price,
                "seller": "",
                "link": link,
                "source": "OLX",
                "query": query
            })
    return results

def scrape_facebook(query, max_items):
    from scrapling.fetchers import StealthyFetcher
    import urllib.parse
    url = f"https://www.facebook.com/marketplace/search/?query={urllib.parse.quote(query)}&exact=false"
    page = StealthyFetcher.fetch(url, headless=True)
    
    results = []
    items = page.css('a[href*="/marketplace/item/"]')
    for item in items:
        if len(results) >= max_items:
            break
            
        link = "https://www.facebook.com" + item.attrib['href'] if item.attrib.get('href', '').startswith('/') else item.attrib.get('href', '#')
        
        spans = item.css('span')
        price = 'N/A'
        title = ''
        
        for span in spans:
            t = span.text.strip()
            if len(t) < 30 and ('$' in t or 'LBP' in t or 'free' in t.lower()) and any(c.isdigit() for c in t):
                price = t
                break
                
        for span in spans:
            t = span.text.strip()
            if t and t != price and not t.lower().startswith('beirut') and not t.lower().startswith('lebanon'):
                if len(t) > len(title):
                    title = t
                    
        results.append({
            "title": title[:200] if title else "Facebook Listing",
            "price": price,
            "seller": "",
            "link": link,
            "source": "Facebook",
            "query": query
        })
    return results

def scrape_custom(url, query, max_items):
    from scrapling.fetchers import StealthyFetcher
    if not url.startswith('http'):
        url = 'https://' + url
    page = StealthyFetcher.fetch(url, headless=True)
    
    results = []
    # Minimal scrapling implementation for custom domains
    # We use adaptive=True to try to find products
    cards = page.css('.product', adaptive=True)
    if not cards:
        cards = page.css('li.product')
        
    for card in cards:
        if len(results) >= max_items:
            break
        a_tags = card.css('a')
        if not a_tags: continue
        link = a_tags[0].attrib.get('href', '#')
        
        price = 'N/A'
        price_els = card.css('.price', adaptive=True)
        if price_els:
            price = price_els[0].text
            
        title = a_tags[0].text
        
        results.append({
            "title": title[:200],
            "price": price,
            "seller": "",
            "link": link,
            "source": "Custom URL",
            "query": query
        })
    return results

def scrape_product_page(url):
    from scrapling.fetchers import StealthyFetcher
    if not url.startswith('http'):
        url = 'https://' + url
    page = StealthyFetcher.fetch(url, headless=True)
    
    price_els = page.css('.price', adaptive=True)
    price = price_els[0].text if price_els else 'Price not available'
    
    title_els = page.css('h1')
    title = title_els[0].text if title_els else ''
    
    return {
        "title": title[:200],
        "price": price,
        "available": True
    }

def main():
    try:
        action = sys.argv[1]
        
        if action == 'scrapePlatform':
            source = sys.argv[2]
            query = sys.argv[3]
            max_items = int(sys.argv[4])
            
            if source == 'OLX':
                res = scrape_olx(query, max_items)
            elif source == 'Facebook':
                res = scrape_facebook(query, max_items)
            else:
                res = scrape_custom(source, query, max_items)
            print(json.dumps(res))
            
        elif action == 'scrapeMultipleURLs':
            urls = json.loads(sys.argv[2])
            query = sys.argv[3]
            res = []
            for url in urls:
                res.extend(scrape_custom(url, query, 10))
            print(json.dumps(res))
            
        elif action == 'scrapeProductPage':
            url = sys.argv[2]
            res = scrape_product_page(url)
            print(json.dumps(res))
            
        else:
            print(json.dumps({"error": "Unknown action"}))
            
    except Exception as e:
        # If scrapling is not installed, it will fall here.
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)

if __name__ == "__main__":
    main()

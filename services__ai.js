const axios = require('axios');
const { db } = require('../db');

// DeepSeek API service for AI-powered product extraction
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

/**
 * Get DeepSeek API key from database (admin setting)
 */
function getDeepSeekKey() {
    const row = db.prepare(`SELECT key_value FROM api_keys WHERE label = 'deepseek' LIMIT 1`).get();
    return row?.key_value || process.env.DEEPSEEK_API_KEY || null;
}

/**
 * Extract structured product data from unstructured text using DeepSeek
 * @param {string} text - Raw text from webpage
 * @param {string} url - Source URL
 * @returns {Promise<{title:string, price:string, description:string, confidence:number}|null>}
 */
async function extractProductWithAI(text, url) {
    const apiKey = getDeepSeekKey();
    if (!apiKey) {
        console.log('[AI] No DeepSeek API key configured');
        return null;
    }

    // Limit text length to avoid token limits
    const truncated = text.slice(0, 8000);

    const prompt = `Extract product information from this webpage content. Return ONLY a JSON object with these fields:
- title: product name (clean, without site name)
- price: price in USD format like "$1,234.56" or null if not found
- description: short product description (max 200 chars)
- availability: "in_stock", "out_of_stock", or "unknown"
- confidence: number 0-1 representing certainty

Webpage URL: ${url}

Content:
${truncated}

Respond with ONLY the JSON object, no markdown, no explanation.`;

    try {
        const resp = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 500
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        const content = resp.data?.choices?.[0]?.message?.content;
        if (!content) return null;

        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        
        // Validate required fields
        if (!parsed.title || parsed.confidence < 0.5) {
            console.log('[AI] Low confidence or missing title:', parsed.confidence);
            return null;
        }

        return {
            title: parsed.title.slice(0, 200),
            price: parsed.price || null,
            description: parsed.description?.slice(0, 200) || '',
            availability: parsed.availability || 'unknown',
            confidence: parsed.confidence
        };

    } catch (err) {
        console.error('[AI] DeepSeek error:', err.message);
        return null;
    }
}

/**
 * Enhance search results with AI when traditional scraping fails
 * @param {string} html - Page HTML
 * @param {string} url - Page URL
 * @param {string} keyword - Search keyword
 */
async function enhanceWithAI(html, url, keyword) {
    // Extract product links from HTML before stripping tags
    const baseOrigin = (() => { try { return new URL(url).origin; } catch(_) { return ''; } })();
    const linkMatches = [...html.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
    const productLinks = linkMatches
        .map(h => h.startsWith('http') ? h : (baseOrigin + (h.startsWith('/') ? h : '/' + h)))
        .filter(h => /\/(product|item|p)s?\/[^?#]{3,}/.test(h) || (/\/(product|shop|store)\//.test(h)));
    const uniqueProductLinks = [...new Set(productLinks)];

    // Remove script/style tags for cleaner text
    const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 10000);

    const result = await extractProductWithAI(text, url);
    
    if (result && result.title.toLowerCase().includes(keyword.toLowerCase().replace(/\s+/g, ''))) {
        // Pick the first product link found, fall back to search URL only if none
        const productLink = uniqueProductLinks[0] || url;
        return {
            title: result.title,
            price: result.price || 'Price not available',
            link: productLink,
            aiEnhanced: true,
            confidence: result.confidence
        };
    }
    
    return null;
}

/**
 * Save DeepSeek API key to database
 */
function saveDeepSeekKey(key) {
    // Delete existing deepseek keys first
    db.prepare(`DELETE FROM api_keys WHERE label = 'deepseek'`).run();
    
    // Insert new key for admin user (id 1)
    const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
    const userId = admin?.id || 1;
    
    db.prepare(`INSERT INTO api_keys(user_id, label, key_value) VALUES(?, 'deepseek', ?)`)
        .run(userId, key);
    
    return true;
}

module.exports = {
    extractProductWithAI,
    enhanceWithAI,
    getDeepSeekKey,
    saveDeepSeekKey
};

const { aiRequestWithFallback, getAvailableProviders } = require('./ai-providers');

/**
 * Use AI to understand search intent and validate product matches
 * This replaces hard-coded rules with intelligent AI analysis
 * Multi-provider: Groq → DeepSeek → Gemini (auto-fallback)
 */

/**
 * Expand a potentially ambiguous search query (e.g., "G502" or "83GW006XGO") into a clear, 
 * full product name optimized for e-commerce search engines.
 * @param {string} keyword - Raw user search input
 * @returns {Promise<string|null>} - The expanded string, or null if AI failed
 */
async function expandSearchQuery(keyword) {
    if (getAvailableProviders().length === 0) return null;

    const prompt = `You are an e-commerce search query optimizer. The user entered a search query that might be too brief, an obscure SKU, or a part number.
Your job is to expand it into a clear, full product name that is highly optimized for searching on retail websites.

Raw Query: "${keyword}"

Rules:
- Generate a BROAD, descriptive search term (Brand + Product Line + Key Spec).
- If it's a short/ambiguous model (e.g., "G502"), add the brand and product type (e.g., "Logitech G502 Mouse").
- IF it's an exact alphanumeric part number/SKU (e.g., "83GW006XGP", "21T90001US"), AND you are NOT absolutely 100% certain of the brand and series, DO NOT GUESS! AI models often hallucinate part numbers (e.g., confusing a Lenovo V15 with a ThinkPad). If you are not certain, just return the exact SKU as provided.
- Do NOT add quotes, markdown, or conversational text. Return ONLY the expanded query string.

Expanded Query:`;

    try {
        const result = await aiRequestWithFallback(prompt, { maxTokens: 50, temperature: 0.1 });
        const content = result.content;
        if (!content) return null;

        const expanded = content.replace(/^["']|["']$/g, '').trim();
        return expanded.length > 0 ? expanded : null;
    } catch (err) {
        console.error('[AI Search] Expand query error:', err.message);
        return null;
    }
}

/**
 * Analyze search query to understand what product type user wants
 * @param {string} keyword - User search query (e.g., "rtx 5080", "i9 14900k", "samsung s24 ultra")
 * @returns {Promise<{productType:string, brand:string, model:string, attributes:string[], rejectTypes:string[]}|null>}
 */
async function analyzeSearchIntent(keyword) {
    if (getAvailableProviders().length === 0) return null;

    const prompt = `Analyze this product search query and extract structured information.

Query: "${keyword}"

Respond with ONLY a JSON object:
{
  "productType": "the general category (e.g., graphics_card, cpu, laptop, phone, monitor)",
  "specificType": "more specific subcategory (e.g., desktop_graphics_card, laptop_gpu, gaming_laptop)",
  "brand": "brand name if mentioned, or null",
  "model": "model number/name (e.g., 'RTX 5080', 'i9-14900K', 'S24 Ultra')",
  "modelVariants": ["alternative ways to write the model"],
  "keyIdentifiers": ["text patterns that identify this product"],
  "rejectIfContains": ["keywords that indicate WRONG product type (e.g., for GPU search: 'laptop', 'notebook', 'desktop', 'gaming pc')"],
  "mustContain": ["keywords that SHOULD be in correct products"],
  "priceRangeHint": "budget/mid-range/high-end if detectable"
}

Examples:
- "rtx 5080" → graphics_card, reject: ['laptop', 'notebook', 'desktop', 'pc', 'omen', 'legion', 'strix']
- "i9 14900k" → desktop_cpu, reject: ['laptop', 'notebook', 'desktop', 'prebuilt', 'LOQ', 'IdeaPad', '14900HX', '14900H']
- "i7 14700kf" → desktop_cpu, reject: ['laptop', 'notebook', 'LOQ', 'IdeaPad', '14700HX', '14700H', 'gaming laptop']
- "s24 ultra" → phone, reject: ['case', 'cover', 'screen protector', 'charger']
- "macbook pro" → laptop, reject: ['case', 'sleeve', 'charger', 'adapter']

IMPORTANT for CPUs: Desktop CPUs end in K/KF/F/KS. Laptop CPUs end in H/HX/HK/U/P. They are DIFFERENT products. If user searches "14700KF", reject anything with "14700HX" or "14700H".

Respond with ONLY valid JSON, no markdown, no explanation.`;

    try {
        const result = await aiRequestWithFallback(prompt, { maxTokens: 800, temperature: 0.1 });
        const content = result.content;
        if (!content) return null;

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('[AI Search] Intent analysis error:', err.message);
        return null;
    }
}

/**
 * Use AI to validate if a product matches the search intent
 * @param {string} productTitle - Product title from website
 * @param {object} intent - Intent object from analyzeSearchIntent
 * @returns {Promise<{isMatch:boolean, confidence:number, reason:string}|null>}
 */
async function validateProductMatch(productTitle, intent) {
    if (getAvailableProviders().length === 0 || !intent) return null;

    const prompt = `You are a product matching validator. Determine if this product matches the user's search intent.

User Search Intent:
- Looking for: ${intent.specificType || intent.productType}
- Brand: ${intent.brand || 'any'}
- Model: ${intent.model || 'any'}
- Must contain: ${intent.mustContain?.join(', ') || 'none'}
- Must NOT contain: ${intent.rejectIfContains?.join(', ') || 'none'}

Product Title: "${productTitle}"

Respond with ONLY a JSON object:
{
  "isMatch": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation of why it matches or doesn't match",
  "extractedModel": "model detected in title if any"
}

Rules:
- For graphics cards: REJECT if title contains laptop/desktop PC names (omen, legion, aurora, zephyrus, strix g, etc.)
- For CPUs: REJECT if title contains prebuilt, desktop, laptop, notebook, LOQ, IdeaPad, ThinkPad, VivoBook, ZenBook, Inspiron, Pavilion, Envy
- For desktop CPUs (K, KF, F suffix e.g. 14700KF): REJECT if title contains HX, HK, H, U suffix variants — these are laptop CPUs and are WRONG products
- CPU model suffix must match exactly: 14700KF ≠ 14700HX, 13900K ≠ 13900HX, 12700H ≠ 12700K
- For phones: REJECT if title contains case, cover, screen protector, charger
- Model numbers must match exactly (RTX 5080 ≠ RTX 5070 Ti, i7-14700KF ≠ i7-14700HX)`;

    try {
        const result = await aiRequestWithFallback(prompt, { maxTokens: 400, temperature: 0.1 });
        const content = result.content;
        if (!content) return null;

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('[AI Search] Validation error:', err.message);
        return null;
    }
}

/**
 * Batch validate multiple products (more efficient)
 * @param {Array<{title:string, price:string, link:string}>} products
 * @param {object} intent - Search intent
 * @returns {Promise<Array<{title:string, price:string, link:string, aiScore:number}>>}
 */
async function batchValidateProducts(products, intent) {
    if (getAvailableProviders().length === 0 || !intent || products.length === 0) {
        return products.map(p => ({ ...p, aiScore: 10 }));
    }

    // Validate up to 20 candidates so SKU/edge matches aren't dropped
    const toValidate = products.slice(0, 20);
    const titles = toValidate.map((p, i) => `[${i}] ${p.title}`).join('\n');

    const prompt = `Validate which products match the search intent. Respond with ONLY a JSON array.

Search Intent: ${intent.specificType || intent.productType}, Model: ${intent.model || 'any'}
Reject if contains: ${intent.rejectIfContains?.join(', ') || 'none'}

Products:
${titles}

Respond with JSON array of objects:
[{"index": 0, "isMatch": true, "confidence": 0.95}, {"index": 1, "isMatch": false, "confidence": 0.2, "reason": "laptop, not standalone GPU"}]

Index must match the [number] prefix. Be strict - wrong product types should be rejected.`;

    try {
        const result = await aiRequestWithFallback(prompt, { maxTokens: 800, temperature: 0.1 });
        const content = result.content;
        if (!content) throw new Error('No response');

        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array');

        const validations = JSON.parse(jsonMatch[0]);
        
        // Merge AI scores with products
        return products.map((p, idx) => {
            const v = validations.find(x => x.index === idx);
            return {
                ...p,
                aiScore: v?.isMatch ? Math.round(v.confidence * 100) : 0,
                aiReason: v?.reason || ''
            };
        });
    } catch (err) {
        console.error('[AI Search] Batch validation error:', err.message);
        // Return original products with default scores
        return products.map(p => ({ ...p, aiScore: 10 }));
    }
}

/**
 * AI-powered search result ranking
 * Uses AI to intelligently score and filter products
 */
async function aiRankProducts(products, keyword) {
    const intent = await analyzeSearchIntent(keyword);
    if (!intent) {
        // No AI available — return score 0 so rule-based filtering takes over in _buildResult
        return products.map(p => ({ ...p, aiScore: 0 }));
    }

    console.log(`[AI Search] Intent: ${intent.specificType || intent.productType}, reject: [${intent.rejectIfContains?.join(', ') || 'none'}]`);

    const validated = await batchValidateProducts(products, intent);
    
    // Sort by AI score, then by price presence
    return validated.sort((a, b) => {
        if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
        if (a.price && !b.price) return -1;
        if (!a.price && b.price) return 1;
        return 0;
    });
}

/**
 * Use AI to extract the CURRENT SELLING price from a product page's text.
 * Last-resort fallback when structured data (JSON-LD/meta) is unavailable.
 * @param {string} pageText - Visible text content of the product page (trimmed)
 * @param {string} productTitle - The product title for context
 * @returns {Promise<{price:number|null, currency:string, raw:string, confidence:number}|null>}
 */
async function aiExtractPrice(pageText, productTitle) {
    if (getAvailableProviders().length === 0 || !pageText) return null;

    // Trim to a reasonable window to control token usage
    const snippet = pageText.replace(/\s+/g, ' ').slice(0, 4000);

    const prompt = `You are a precise price extractor for an e-commerce product page.

Product: "${productTitle || 'unknown'}"

Page text (may contain navigation, related products, reviews — ignore those):
"""
${snippet}
"""

Extract the CURRENT SELLING PRICE of THIS product (the price a buyer pays now).
Rules:
- If there is a discounted/sale price AND an original/struck-through price, return the CURRENT (sale) price.
- Ignore prices of related/recommended products, shipping, or installment amounts.
- If the item is out of stock or no price is shown, set price to null.
- "currency" should be one of: USD, LBP, EUR, GBP (infer from $, L.L./LBP, €, £).

Respond with ONLY a JSON object:
{"price": 599.00, "currency": "USD", "raw": "$599.00", "confidence": 0.0-1.0}`;

    try {
        const result = await aiRequestWithFallback(prompt, { maxTokens: 200, temperature: 0 });
        const content = result.content;
        if (!content) return null;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.price != null) parsed.price = parseFloat(parsed.price);
        return parsed;
    } catch (err) {
        console.error('[AI Search] Price extraction error:', err.message);
        return null;
    }
}

module.exports = {
    expandSearchQuery,
    analyzeSearchIntent,
    validateProductMatch,
    batchValidateProducts,
    aiRankProducts,
    aiExtractPrice
};

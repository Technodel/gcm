const axios = require('axios');
const { db } = require('../db');

// AI Provider configurations with priority order
const PROVIDERS = {
    groq: {
        name: 'Groq',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile',  // Fast and capable
        keyLabel: 'groq'
    },
    openrouter: {
        name: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'meta-llama/llama-3.3-70b-instruct',
        keyLabel: 'openrouter'
    },
    deepseek: {
        name: 'DeepSeek',
        url: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-chat',
        keyLabel: 'deepseek'
    },
    gemini: {
        name: 'Gemini',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
        model: 'gemini-2.0-flash',
        keyLabel: 'gemini',
        isGemini: true  // Special handling for Gemini API format
    }
};

// Priority order for fallbacks
const PRIORITY_ORDER = ['groq', 'openrouter', 'deepseek', 'gemini'];

/**
 * Get API key for a specific provider from database
 */
function getProviderKey(provider) {
    const label = PROVIDERS[provider]?.keyLabel || provider;
    const row = db.prepare(`SELECT key_value FROM api_keys WHERE label = ? LIMIT 1`).get(label);
    return row?.key_value || process.env[`${provider.toUpperCase()}_API_KEY`] || null;
}

/**
 * Check which providers are available
 */
function getAvailableProviders() {
    return PRIORITY_ORDER.filter(p => getProviderKey(p) !== null);
}

/**
 * Get the best available provider (in priority order)
 */
function getBestProvider() {
    return PRIORITY_ORDER.find(p => getProviderKey(p) !== null) || null;
}

/**
 * Make AI request with automatic fallback between providers
 */
async function aiRequestWithFallback(prompt, options = {}) {
    const { maxTokens = 800, temperature = 0.1, timeout = 10000 } = options;
    
    const providers = getAvailableProviders();
    if (providers.length === 0) {
        throw new Error('No AI providers configured');
    }

    let lastError = null;
    
    for (const provider of providers) {
        try {
            const result = await makeProviderRequest(provider, prompt, { maxTokens, temperature, timeout });
            console.log(`[AI] Success with ${provider}`);
            return { ...result, provider };
        } catch (err) {
            console.warn(`[AI] ${provider} failed: ${err.message}`);
            lastError = err;
            continue; // Try next provider
        }
    }
    
    throw new Error(`All AI providers failed. Last error: ${lastError?.message}`);
}

/**
 * Make request to specific provider
 */
async function makeProviderRequest(provider, prompt, options) {
    const config = PROVIDERS[provider];
    const apiKey = getProviderKey(provider);
    
    if (!apiKey) throw new Error(`No API key for ${provider}`);
    
    if (config.isGemini) {
        return await makeGeminiRequest(config, apiKey, prompt, options);
    } else {
        return await makeOpenAICompatibleRequest(config, apiKey, prompt, options);
    }
}

/**
 * OpenAI-compatible API request (Groq, DeepSeek)
 */
async function makeOpenAICompatibleRequest(config, apiKey, prompt, options) {
    const { maxTokens, temperature, timeout } = options;
    
    const resp = await axios.post(config.url, {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout
    });
    
    const content = resp.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response');
    
    return { content, raw: resp.data };
}

/**
 * Gemini API request (different format)
 */
async function makeGeminiRequest(config, apiKey, prompt, options) {
    const { maxTokens, temperature, timeout } = options;
    
    const url = `${config.url}?key=${apiKey}`;
    
    const resp = await axios.post(url, {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
        }
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout
    });
    
    const content = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Empty Gemini response');
    
    return { content, raw: resp.data };
}

/**
 * Save API key for a provider
 */
function saveProviderKey(provider, key) {
    const label = PROVIDERS[provider]?.keyLabel || provider;
    
    // Delete existing
    db.prepare(`DELETE FROM api_keys WHERE label = ?`).run(label);
    
    // Insert new key for admin user (id 1)
    const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
    const userId = admin?.id || 1;
    
    db.prepare(`INSERT INTO api_keys(user_id, label, key_value) VALUES(?, ?, ?)`)
        .run(userId, label, key);
    
    return true;
}

/**
 * Delete API key for a provider
 */
function deleteProviderKey(provider) {
    const label = PROVIDERS[provider]?.keyLabel || provider;
    db.prepare(`DELETE FROM api_keys WHERE label = ?`).run(label);
    return true;
}

/**
 * Get status of all providers
 */
function getProvidersStatus() {
    return PRIORITY_ORDER.map(p => ({
        id: p,
        name: PROVIDERS[p].name,
        configured: getProviderKey(p) !== null,
        priority: PRIORITY_ORDER.indexOf(p) + 1
    }));
}

module.exports = {
    aiRequestWithFallback,
    getProviderKey,
    getAvailableProviders,
    getBestProvider,
    saveProviderKey,
    deleteProviderKey,
    getProvidersStatus,
    PRIORITY_ORDER,
    PROVIDERS
};

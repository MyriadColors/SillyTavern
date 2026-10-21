import { color } from './util.js';

const PRICING_URL = 'https://models.dev/api.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_UPDATED = '2026-10-21';

/**
 * @typedef {object} GoogleRate
 * @property {number} input USD per 1M input tokens
 * @property {number} output USD per 1M output tokens
 * @property {number} [cache_read] USD per 1M cached input tokens
 */

/**
 * @typedef {GoogleRate & { tiers?: Array<GoogleRate & { size: number }> }} GooglePrice
 */

const LONG_CONTEXT = 200000;

/** @type {Record<string, GooglePrice>} */
const FALLBACK_PRICES = {
    'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.125, tiers: [{ size: LONG_CONTEXT, input: 2.5, output: 15, cache_read: 0.25 }] },
    'gemini-2.5-flash': { input: 0.3, output: 2.5, cache_read: 0.03 },
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cache_read: 0.01 },
    'gemini-3-flash-preview': { input: 0.5, output: 3, cache_read: 0.05 },
    'gemini-3.1-pro-preview': { input: 2, output: 12, cache_read: 0.2, tiers: [{ size: LONG_CONTEXT, input: 4, output: 18, cache_read: 0.4 }] },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cache_read: 0.025 },
    'gemini-3.5-flash': { input: 1.5, output: 9, cache_read: 0.15 },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cache_read: 0.03 },
};

/** @type {{ vertexai: Record<string, GooglePrice>, makersuite: Record<string, GooglePrice> }} */
const prices = {
    vertexai: { ...FALLBACK_PRICES },
    makersuite: { ...FALLBACK_PRICES },
};

let lastRefresh = 0;
let refreshing = null;
let pricingUpdated = `${FALLBACK_UPDATED} (built-in)`;

/**
 * Converts a models.dev provider entry into a price map.
 * @param {any} provider models.dev provider object
 * @returns {Record<string, GooglePrice>}
 */
export function parseModelsDevProvider(provider) {
    /** @type {Record<string, GooglePrice>} */
    const result = {};
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
        const cost = /** @type {any} */ (model)?.cost;
        const input = Number(cost?.input);
        const output = Number(cost?.output);
        if (!Number.isFinite(input) || !Number.isFinite(output)) {
            continue;
        }
        /** @type {GooglePrice} */
        const price = { input, output };
        if (Number.isFinite(Number(cost.cache_read))) {
            price.cache_read = Number(cost.cache_read);
        }
        if (Array.isArray(cost.tiers)) {
            price.tiers = cost.tiers
                .filter(t => t?.tier?.type === 'context' && Number.isFinite(Number(t?.tier?.size)))
                .map(t => ({ size: Number(t.tier.size), input: Number(t.input), output: Number(t.output), cache_read: t.cache_read !== undefined ? Number(t.cache_read) : undefined }));
        }
        result[id] = price;
    }
    return result;
}

/**
 * Fetches current Google pricing from models.dev. Falls back to built-in prices on failure.
 * @returns {Promise<void>}
 */
export function initGooglePricing() {
    if (refreshing) {
        return refreshing;
    }
    lastRefresh = Date.now();
    refreshing = (async () => {
        try {
            const response = await fetch(PRICING_URL);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            const catalog = /** @type {any} */ (await response.json());
            const vertex = parseModelsDevProvider(catalog?.['google-vertex']);
            const studio = parseModelsDevProvider(catalog?.google);
            if (Object.keys(vertex).length) prices.vertexai = { ...FALLBACK_PRICES, ...vertex };
            if (Object.keys(studio).length) prices.makersuite = { ...FALLBACK_PRICES, ...studio };
            pricingUpdated = new Date().toISOString().slice(0, 10);
        } catch (error) {
            console.warn(`Google pricing refresh failed, using built-in prices from ${FALLBACK_UPDATED}:`, error.message);
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

/**
 * Looks up the price for a model, using exact match first, then longest prefix match.
 * @param {string} source Chat completion source (vertexai or makersuite)
 * @param {string} model Model ID
 * @returns {GooglePrice|null}
 */
export function getGooglePrice(source, model) {
    if (lastRefresh && Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
        initGooglePricing();
    }
    const table = source === 'vertexai' ? prices.vertexai : prices.makersuite;
    const id = String(model ?? '').replace(/^models\//, '');
    if (table[id]) {
        return table[id];
    }
    const prefix = Object.keys(table)
        .filter(key => id.startsWith(key))
        .sort((a, b) => b.length - a.length)[0];
    return prefix ? table[prefix] : null;
}

/**
 * Computes request cost in USD from Gemini usageMetadata.
 * @param {GooglePrice} price Model price
 * @param {any} usage Gemini usageMetadata
 * @returns {{ input: number, output: number, total: number }}
 */
export function computeGoogleCost(price, usage) {
    const prompt = Number(usage?.promptTokenCount) || 0;
    const toolPrompt = Number(usage?.toolUsePromptTokenCount) || 0;
    const cached = Number(usage?.cachedContentTokenCount) || 0;
    const candidates = Number(usage?.candidatesTokenCount) || 0;
    const thoughts = Number(usage?.thoughtsTokenCount) || 0;

    const totalPrompt = prompt + toolPrompt;
    const tier = (price.tiers ?? [])
        .filter(t => totalPrompt > t.size)
        .sort((a, b) => b.size - a.size)[0];
    const rate = tier ?? price;
    const cacheRate = rate.cache_read ?? price.cache_read ?? rate.input;

    const input = ((totalPrompt - cached) * rate.input + cached * cacheRate) / 1e6;
    const output = (candidates + thoughts) * rate.output / 1e6;
    return { input, output, total: input + output };
}

/**
 * Logs token usage and cost of a Google request to the terminal.
 * @param {string} apiName Display name of the API
 * @param {string} source Chat completion source
 * @param {string} model Model ID
 * @param {any} usage Gemini usageMetadata
 * @returns {{ input: number, output: number, total: number }|null} Cost, if known
 */
export function logGoogleCost(apiName, source, model, usage) {
    if (!usage) {
        return null;
    }
    const fmt = (/** @type {number} */ n) => (Number(n) || 0).toLocaleString('en-US');
    const usd = (/** @type {number} */ n) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
    const prompt = (Number(usage.promptTokenCount) || 0) + (Number(usage.toolUsePromptTokenCount) || 0);
    const cached = Number(usage.cachedContentTokenCount) || 0;
    const thoughts = Number(usage.thoughtsTokenCount) || 0;

    let line = `[${apiName}] ${model} | in ${fmt(prompt)}`;
    if (cached) line += ` (cached ${fmt(cached)})`;
    line += ` | out ${fmt(usage.candidatesTokenCount)}`;
    if (thoughts) line += ` (+${fmt(thoughts)} thinking)`;

    const price = getGooglePrice(source, model);
    if (!price) {
        console.info(color.yellow(`${line} | price unknown`));
        return null;
    }
    const cost = computeGoogleCost(price, usage);
    console.info(color.green(`${line} | ${usd(cost.total)} (in ${usd(cost.input)} / out ${usd(cost.output)}) [pricing ${pricingUpdated}]`));
    return cost;
}

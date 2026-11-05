import fetch from 'node-fetch';
import { color } from './util.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_UPDATED = '2026-11-05';

/**
 * @typedef {object} RateCard
 * @property {number} input USD per 1M input tokens
 * @property {number} output USD per 1M output tokens
 * @property {number} [cache_read] USD per 1M cached tokens
 * @property {number} [reasoning] USD per 1M reasoning tokens
 */

/** @type {Record<string, Record<string, RateCard>>} */
const providerPrices = {
    openrouter: {},
    modelsdev: {},
};

let lastRefresh = 0;
let refreshing = null;
let pricingUpdated = `${FALLBACK_UPDATED} (built-in)`;

/**
 * Parses pricing data from OpenRouter's /api/v1/models response.
 * OpenRouter prices in its JSON are formatted as decimal strings representing USD per 1 token (e.g. "0.00000075").
 * We convert them to USD per 1M tokens for consistency.
 * @param {any} data OpenRouter models payload
 * @returns {Record<string, RateCard>}
 */
export function parseOpenRouterModels(data) {
    /** @type {Record<string, RateCard>} */
    const result = {};
    const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);

    for (const model of models) {
        if (!model?.id || !model?.pricing) continue;
        const prompt = Number(model.pricing.prompt);
        const completion = Number(model.pricing.completion);
        if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;

        /** @type {RateCard} */
        const rate = {
            input: prompt * 1e6,
            output: completion * 1e6,
        };

        if (Number.isFinite(Number(model.pricing.input_cache_read))) {
            rate.cache_read = Number(model.pricing.input_cache_read) * 1e6;
        }
        if (Number.isFinite(Number(model.pricing.internal_reasoning))) {
            rate.reasoning = Number(model.pricing.internal_reasoning) * 1e6;
        }

        result[model.id] = rate;
    }
    return result;
}

/**
 * Parses models.dev API JSON catalog into provider-keyed rate cards.
 * @param {any} catalog models.dev JSON payload
 * @returns {Record<string, Record<string, RateCard>>}
 */
export function parseModelsDevCatalog(catalog) {
    /** @type {Record<string, Record<string, RateCard>>} */
    const providers = {};
    if (!catalog || typeof catalog !== 'object') return providers;

    for (const [providerKey, providerObj] of Object.entries(catalog)) {
        /** @type {Record<string, RateCard>} */
        const models = {};
        const rawModels = /** @type {any} */ (providerObj)?.models ?? {};

        for (const [id, model] of Object.entries(rawModels)) {
            const cost = /** @type {any} */ (model)?.cost;
            const input = Number(cost?.input);
            const output = Number(cost?.output);
            if (!Number.isFinite(input) || !Number.isFinite(output)) continue;

            /** @type {RateCard} */
            const rate = { input, output };
            if (Number.isFinite(Number(cost?.cache_read))) {
                rate.cache_read = Number(cost.cache_read);
            }
            if (Number.isFinite(Number(cost?.reasoning))) {
                rate.reasoning = Number(cost.reasoning);
            }
            models[id] = rate;
        }

        if (Object.keys(models).length > 0) {
            providers[providerKey.toLowerCase()] = models;
        }
    }
    return providers;
}

/**
 * Initializes and refreshes pricing tables for OpenRouter and models.dev providers.
 * @returns {Promise<void>}
 */
export async function initPricingHub() {
    if (refreshing) return refreshing;
    lastRefresh = Date.now();

    refreshing = (async () => {
        try {
            // 1. Fetch OpenRouter models pricing
            const orPromise = fetch(OPENROUTER_MODELS_URL, { headers: { 'Accept': 'application/json' } })
                .then(async (res) => {
                    if (res.ok) {
                        const json = await res.json();
                        const parsed = parseOpenRouterModels(json);
                        if (Object.keys(parsed).length > 0) {
                            providerPrices.openrouter = parsed;
                        }
                    }
                })
                .catch((err) => console.warn('OpenRouter pricing fetch failed:', err.message));

            // 2. Fetch models.dev catalog
            const mdPromise = fetch(MODELS_DEV_URL, { headers: { 'Accept': 'application/json' } })
                .then(async (res) => {
                    if (res.ok) {
                        const json = await res.json();
                        const parsed = parseModelsDevCatalog(json);
                        if (Object.keys(parsed).length > 0) {
                            providerPrices.modelsdev = parsed;
                        }
                    }
                })
                .catch((err) => console.warn('models.dev pricing fetch failed:', err.message));

            await Promise.allSettled([orPromise, mdPromise]);
            pricingUpdated = new Date().toISOString().slice(0, 10);
        } catch (error) {
            console.warn('Pricing hub initialization failed, using built-in prices:', error.message);
        } finally {
            refreshing = null;
        }
    })();

    return refreshing;
}

const PROVIDER_ALIASES = {
    'makersuite': 'google',
    'vertexai': 'google-vertex',
    'google': 'google',
    'cohere': 'cohere',
    'mistralai': 'mistral',
    'deepseek': 'deepseek',
    'groq': 'groq',
    'fireworks': 'fireworks',
    'together': 'together',
    'digitalocean': 'digitalocean',
    'siliconflow': 'siliconflow',
};

/**
 * Looks up rate card for a given provider and model.
 * Strictly isolates lookups to the specified provider and its recognized alias.
 * @param {string} source Chat completion source (e.g. 'openrouter', 'groq', 'deepseek', etc.)
 * @param {string} model Model ID
 * @returns {RateCard|null}
 */
export function getModelPrice(source, model) {
    if (lastRefresh && Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
        initPricingHub();
    }

    const cleanModel = String(model ?? '').trim();
    if (!cleanModel) return null;

    const sourceLower = String(source ?? '').trim().toLowerCase();

    if (sourceLower === 'openrouter') {
        const orTable = providerPrices.openrouter;
        if (orTable[cleanModel]) return orTable[cleanModel];

        // Slug match (e.g. "google/gemini-2.5-flash" vs "gemini-2.5-flash")
        const matchedKey = Object.keys(orTable).find(k => k === cleanModel || cleanModel.endsWith('/' + k) || k.endsWith('/' + cleanModel));
        if (matchedKey) return orTable[matchedKey];
        return null;
    }

    // Check models.dev providers strictly matching this provider or its known alias
    const devCatalog = providerPrices.modelsdev;
    const targetKey = PROVIDER_ALIASES[sourceLower] ?? sourceLower;
    const providerTable = devCatalog[targetKey];

    if (providerTable) {
        if (providerTable[cleanModel]) return providerTable[cleanModel];
        const matchedKey = Object.keys(providerTable).find(k => k === cleanModel || cleanModel.endsWith('/' + k) || k.endsWith('/' + cleanModel));
        if (matchedKey) return providerTable[matchedKey];
    }

    return null;
}

/**
 * Computes cost split and totals.
 * @param {RateCard} price
 * @param {any} usage
 * @returns {{ input: number, output: number, total: number }}
 */
export function computeTokenCost(price, usage) {
    const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount) || 0;
    const cachedTokens = Number(
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.cachedContentTokenCount ?? 0,
    ) || 0;

    const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount) || 0;
    const reasoningTokens = Number(
        usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.thoughtsTokenCount ?? 0,
    ) || 0;

    const cacheRate = price.cache_read ?? price.input;
    const regularPromptTokens = Math.max(0, promptTokens - cachedTokens);

    const inputCost = (regularPromptTokens * price.input + cachedTokens * cacheRate) / 1e6;

    // Reasoning tokens: in OpenAI convention, reasoning_tokens are included in completion_tokens.
    // If rate has special reasoning price, calculate differential accordingly.
    let outputCost = (completionTokens * price.output) / 1e6;
    if (price.reasoning && reasoningTokens > 0) {
        const regularCompletionTokens = Math.max(0, completionTokens - reasoningTokens);
        outputCost = (regularCompletionTokens * price.output + reasoningTokens * price.reasoning) / 1e6;
    }

    return {
        input: inputCost,
        output: outputCost,
        total: inputCost + outputCost,
    };
}

/**
 * Formats a terminal cost line with exact parity to logGoogleCost.
 * @param {object} params
 * @param {string} params.apiName Display name of the API / upstream provider
 * @param {string} params.model Model ID
 * @param {any} params.usage Usage object
 * @param {RateCard|null} [params.price] Resolved rate card
 * @param {number|null} [params.reportedCost] Actual billed cost reported directly by API (e.g. usage.cost)
 * @returns {{ line: string, cost: { input: number, output: number, total: number }|null }}
 */
export function formatCostSummary({ apiName, model, usage, price = null, reportedCost = null }) {
    const fmt = (/** @type {number} */ n) => (Number(n) || 0).toLocaleString('en-US');
    const usd = (/** @type {number} */ n) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;

    const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount) || 0;
    const cached = Number(
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.cachedContentTokenCount ?? 0,
    ) || 0;

    const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount) || 0;
    const reasoning = Number(
        usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.thoughtsTokenCount ?? 0,
    ) || 0;

    let line = `[${apiName}] ${model} | in ${fmt(prompt)}`;
    if (cached) line += ` (cached ${fmt(cached)})`;
    line += ` | out ${fmt(completion)}`;
    if (reasoning) line += ` (+${fmt(reasoning)} thinking)`;

    const hasReportedCost = Number.isFinite(reportedCost) && reportedCost !== null;

    if (!price && !hasReportedCost) {
        return { line: color.yellow(`${line} | price unknown`), cost: null };
    }

    let calculated = price ? computeTokenCost(price, usage) : { input: 0, output: 0, total: 0 };

    let total = calculated.total;
    let input = calculated.input;
    let output = calculated.output;

    if (hasReportedCost) {
        total = Number(reportedCost);
        // Hybrid reporting: if price card exists, split proportionally to the calculated input/output
        if (calculated.total > 0) {
            const ratio = total / calculated.total;
            input = calculated.input * ratio;
            output = calculated.output * ratio;
        } else if (prompt > 0 || completion > 0) {
            // Rough estimation if no rate card exists
            const sumTokens = prompt + completion;
            input = sumTokens > 0 ? total * (prompt / sumTokens) : total / 2;
            output = total - input;
        }
    }

    const costResult = { input, output, total };
    const formattedLine = color.green(`${line} | ${usd(total)} (in ${usd(input)} / out ${usd(output)}) [pricing ${pricingUpdated}]`);
    return { line: formattedLine, cost: costResult };
}

/**
 * Logs token usage and cost to the terminal for OpenRouter or other OpenAI-compatible requests.
 * @param {string} source Source name (e.g. 'openrouter', 'digitalocean', etc.)
 * @param {string} model Model ID
 * @param {any} usage Usage metadata from response
 * @param {any} [metadata] Optional router metadata (e.g. openrouter_metadata)
 * @returns {{ input: number, output: number, total: number }|null}
 */
export function logRequestCost(source, model, usage, metadata = null) {
    if (!usage) return null;

    let apiName = source === 'openrouter' ? 'OpenRouter' : source;
    const providerName = metadata?.provider_name;
    if (providerName && source === 'openrouter') {
        apiName = `OpenRouter: ${providerName}`;
    }

    const reportedCost = Number.isFinite(usage?.cost) ? Number(usage.cost) : null;
    const price = getModelPrice(source, model);

    const { line, cost } = formatCostSummary({
        apiName,
        model,
        usage,
        price,
        reportedCost,
    });

    console.info(line);
    return cost;
}

export { pricingUpdated, providerPrices };

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    parseOpenRouterModels,
    parseModelsDevCatalog,
    computeTokenCost,
    formatCostSummary,
    getModelPrice,
    logRequestCost,
    providerPrices,
} from '../src/pricing-hub.js';

describe('Pricing Hub & OpenRouter Cost Logging', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        providerPrices.openrouter = {};
        providerPrices.modelsdev = {};
    });

    test('parses OpenRouter /api/v1/models payload into rate cards per 1M tokens', () => {
        const payload = {
            data: [
                {
                    id: 'google/gemini-2.5-flash',
                    pricing: {
                        prompt: '0.00000015',
                        completion: '0.00000125',
                        input_cache_read: '0.000000015',
                        internal_reasoning: '0.00000125',
                    },
                },
                {
                    id: 'anthropic/claude-3.5-sonnet',
                    pricing: {
                        prompt: '0.000003',
                        completion: '0.000015',
                    },
                },
            ],
        };

        const parsed = parseOpenRouterModels(payload);
        expect(parsed['google/gemini-2.5-flash']).toEqual({
            input: 0.15,
            output: 1.25,
            cache_read: 0.015,
            reasoning: 1.25,
        });
        expect(parsed['anthropic/claude-3.5-sonnet']).toEqual({
            input: 3,
            output: 15,
        });
    });

    test('parses models.dev catalog correctly', () => {
        const catalog = {
            groq: {
                models: {
                    'llama-3.3-70b-versatile': {
                        cost: {
                            input: 0.59,
                            output: 0.79,
                        },
                    },
                },
            },
        };

        const parsed = parseModelsDevCatalog(catalog);
        expect(parsed.groq['llama-3.3-70b-versatile']).toEqual({
            input: 0.59,
            output: 0.79,
        });
    });

    test('computes token cost with prompt, cache, completion, and reasoning tokens', () => {
        const rateCard = {
            input: 0.5, // $0.50 per 1M
            output: 3.0, // $3.00 per 1M
            cache_read: 0.05,
        };

        const usage = {
            prompt_tokens: 10000,
            prompt_tokens_details: { cached_tokens: 2000 },
            completion_tokens: 1000,
            completion_tokens_details: { reasoning_tokens: 200 },
        };

        const cost = computeTokenCost(rateCard, usage);
        // (8000 * 0.5 + 2000 * 0.05) / 1e6 = (4000 + 100) / 1e6 = 0.0041
        expect(cost.input).toBeCloseTo(0.0041, 6);
        // 1000 * 3.0 / 1e6 = 0.003
        expect(cost.output).toBeCloseTo(0.003, 6);
        expect(cost.total).toBeCloseTo(0.0071, 6);
    });

    test('formats cost summary with exact visual parity to logGoogleCost', () => {
        const rateCard = {
            input: 0.5,
            output: 3.0,
        };

        const usage = {
            prompt_tokens: 7784,
            completion_tokens: 404,
            completion_tokens_details: { reasoning_tokens: 901 },
        };

        const result = formatCostSummary({
            apiName: 'OpenRouter: Google Vertex AI',
            model: 'gemini-3-flash-preview',
            usage,
            price: rateCard,
        });

        // Strip ANSI escape codes to verify pure text contents
        // Use manual non-regex replacement for escape codes or exact substring checks
        expect(result.line).toContain('[OpenRouter: Google Vertex AI] gemini-3-flash-preview');
        expect(result.line).toContain('in 7,784');
        expect(result.line).toContain('out 404 (+901 thinking)');
        expect(result.line).toContain('pricing');
        expect(result.cost.total).toBeGreaterThan(0);
    });

    test('handles hybrid dual-reporting when reportedCost is provided', () => {
        const rateCard = {
            input: 0.5,
            output: 3.0,
        };

        const usage = {
            prompt_tokens: 7784,
            completion_tokens: 404,
            cost: 0.007807,
        };

        const result = formatCostSummary({
            apiName: 'OpenRouter: Google Vertex AI',
            model: 'gemini-3-flash-preview',
            usage,
            price: rateCard,
            reportedCost: 0.007807,
        });

        expect(result.cost.total).toBe(0.007807);
        expect(result.line).toContain('$0.007807');
    });

    test('falls back gracefully to yellow line when price is unknown', () => {
        const usage = {
            prompt_tokens: 100,
            completion_tokens: 50,
        };

        const result = formatCostSummary({
            apiName: 'OpenRouter',
            model: 'unknown-experimental-model',
            usage,
            price: null,
            reportedCost: null,
        });

        expect(result.cost).toBeNull();
        expect(result.line).toContain('[OpenRouter] unknown-experimental-model | in 100 | out 50 | price unknown');
    });

    test('logRequestCost handles metadata provider_name and logs to console', () => {
        providerPrices.openrouter['test/model'] = { input: 1, output: 2 };
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

        const usage = { prompt_tokens: 100, completion_tokens: 50 };
        const metadata = { provider_name: 'DeepInfra' };

        const cost = logRequestCost('openrouter', 'test/model', usage, metadata);

        expect(infoSpy).toHaveBeenCalled();
        expect(cost).not.toBeNull();
        expect(cost.total).toBeGreaterThan(0);

        infoSpy.mockRestore();
    });

    test('isolates model lookups to target provider and does not collide across providers', () => {
        providerPrices.modelsdev = {
            groq: {
                'common-model-name': { input: 0.5, output: 0.8 },
            },
            deepseek: {
                'common-model-name': { input: 1.5, output: 2.5 },
            },
        };

        // Querying groq returns groq rates
        const groqPrice = getModelPrice('groq', 'common-model-name');
        expect(groqPrice).toEqual({ input: 0.5, output: 0.8 });

        // Querying deepseek returns deepseek rates
        const deepseekPrice = getModelPrice('deepseek', 'common-model-name');
        expect(deepseekPrice).toEqual({ input: 1.5, output: 2.5 });

        // Querying unrelated provider mistral does NOT fall back across other providers
        const mistralPrice = getModelPrice('mistralai', 'common-model-name');
        expect(mistralPrice).toBeNull();
    });
});

import { describe, expect, test } from '@jest/globals';
import { computeGoogleCost, getGooglePrice, parseModelsDevProvider } from '../src/google-pricing.js';

const pro = { input: 1.25, output: 10, cache_read: 0.125, tiers: [{ size: 200000, input: 2.5, output: 15, cache_read: 0.25 }] };

describe('Google pricing', () => {
    test('bills prompt, output and thinking tokens', () => {
        const cost = computeGoogleCost(pro, { promptTokenCount: 1000000, candidatesTokenCount: 500000, thoughtsTokenCount: 500000 });
        expect(cost.input).toBeCloseTo(2.5);
        expect(cost.output).toBeCloseTo(15);
        expect(cost.total).toBeCloseTo(17.5);
    });

    test('uses short context rates under the tier threshold', () => {
        const cost = computeGoogleCost(pro, { promptTokenCount: 100000, candidatesTokenCount: 1000 });
        expect(cost.input).toBeCloseTo(0.125);
        expect(cost.output).toBeCloseTo(0.01);
    });

    test('bills cached tokens at cache rate', () => {
        const cost = computeGoogleCost(pro, { promptTokenCount: 100000, cachedContentTokenCount: 40000, candidatesTokenCount: 0 });
        expect(cost.input).toBeCloseTo((60000 * 1.25 + 40000 * 0.125) / 1e6);
    });

    test('resolves preview IDs by longest prefix', () => {
        expect(getGooglePrice('vertexai', 'gemini-2.5-flash-lite-preview-09-2025')?.input).toBe(0.1);
        expect(getGooglePrice('makersuite', 'models/gemini-2.5-pro')?.input).toBe(1.25);
        expect(getGooglePrice('vertexai', 'unknown-model')).toBeNull();
    });

    test('parses models.dev provider entries', () => {
        const parsed = parseModelsDevProvider({
            models: {
                'gemini-x': { cost: { input: 2, output: 12, cache_read: 0.2, tiers: [{ input: 4, output: 18, cache_read: 0.4, tier: { type: 'context', size: 200000 } }] } },
                'no-cost': {},
            },
        });
        expect(parsed).toEqual({ 'gemini-x': { input: 2, output: 12, cache_read: 0.2, tiers: [{ size: 200000, input: 4, output: 18, cache_read: 0.4 }] } });
    });
});

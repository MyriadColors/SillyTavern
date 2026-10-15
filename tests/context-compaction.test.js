import { describe, test, expect } from '@jest/globals';
import {
    TRIGGER_MODES,
    estimateChatTokens,
    resolveThreshold,
    shouldFire,
} from '../public/scripts/extensions/context-compaction/gate.js';
import { applyCachedEvictions, planPrune } from '../public/scripts/extensions/context-compaction/pruner.js';
import { scoreMessage } from '../public/scripts/extensions/context-compaction/scorer.js';
import { clearState, readState, writeState } from '../public/scripts/extensions/context-compaction/cache.js';

describe('compaction gate', () => {
    test('fires on token threshold', () => {
        const decision = shouldFire({
            estTokens: 8500,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 0,
            settings: { triggerMode: TRIGGER_MODES.EITHER, everyN: 10, cooldownN: 0 },
        });
        expect(decision).toEqual({ fire: true, reason: 'threshold' });
    });

    test('respects cooldown', () => {
        const decision = shouldFire({
            estTokens: 9000,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 1,
            settings: { triggerMode: TRIGGER_MODES.EITHER, everyN: 10, cooldownN: 3 },
        });
        expect(decision).toEqual({ fire: false, reason: 'cooldown' });
    });

    test('fires every N turns', () => {
        const decision = shouldFire({
            estTokens: 100,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 10,
            settings: { triggerMode: TRIGGER_MODES.EVERY_N, everyN: 10, cooldownN: 0 },
        });
        expect(decision).toEqual({ fire: true, reason: 'every_n' });
    });

    test('stays idle below threshold and N', () => {
        const decision = shouldFire({
            estTokens: 100,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 2,
            settings: { triggerMode: TRIGGER_MODES.EITHER, everyN: 10, cooldownN: 0 },
        });
        expect(decision.fire).toBe(false);
    });

    test('resolves percent threshold and clamps to max', () => {
        expect(resolveThreshold({ thresholdMode: 'percent', thresholdPercent: 80 }, 10000)).toBe(8000);
        expect(resolveThreshold({ thresholdMode: 'absolute', thresholdTokens: 50000 }, 10000)).toBe(10000);
    });

    test('estimates chat tokens', () => {
        expect(estimateChatTokens([{ role: 'user', content: 'hello' }])).toBeGreaterThan(0);
        expect(estimateChatTokens([])).toBe(0);
    });
});

describe('compaction pruner', () => {
    const chat = [
        { role: 'system', content: 'You are a test character.' },
        { role: 'user', content: 'Old forgotten small talk from long ago with enough length to matter here.' },
        { role: 'assistant', content: 'Old reply with plot setup that could be compacted away safely now.' },
        { role: 'user', content: 'Recent important question?' },
        { role: 'assistant', content: 'Recent answer to keep.' },
    ];

    test('older candidates score lower than recent ones', () => {
        const oldScore = scoreMessage(chat[1], 1, chat.length);
        const recentScore = scoreMessage(chat[3], 3, chat.length);
        expect(recentScore).toBeGreaterThan(oldScore);
    });

    test('plan prunes to target and protects recents', () => {
        const plan = planPrune(chat, {
            tokenCounts: [10, 100, 100, 10, 10],
            targetTokens: 50,
            preserveN: 2,
            flagsByIndex: new Map(),
            aggressiveness: 'balanced',
        });
        expect(plan.evictedIndexes.length).toBeGreaterThan(0);
        expect(plan.evictedIndexes).not.toContain(0);
        expect(plan.evictedIndexes).not.toContain(3);
        expect(plan.evictedIndexes).not.toContain(4);
        expect(plan.stub).toMatch('Context compacted');
    });

    test('cached evictions re-apply with stub', () => {
        const plan = planPrune(chat, {
            tokenCounts: [10, 100, 100, 10, 10],
            targetTokens: 50,
            preserveN: 2,
            flagsByIndex: new Map(),
            aggressiveness: 'balanced',
        });
        const filtered = applyCachedEvictions(chat, plan.evictedHashes, plan.stub);
        expect(filtered.length).toBeLessThan(chat.length);
        expect(filtered.some(message => String(message.content).includes('Context compacted'))).toBe(true);
    });
});

describe('compaction cache', () => {
    test('writes and clears state', () => {
        const metadata = {};
        writeState(metadata, { evictedHashes: ['h1'], stub: 'stub', lastFiredAtTokens: 10, turnsSinceCompaction: 0, tokenSaved: 5, lastChatLength: 3 });
        expect(readState(metadata).evictedHashes).toEqual(['h1']);
        clearState(metadata);
        expect(readState(metadata).evictedHashes).toEqual([]);
    });
});

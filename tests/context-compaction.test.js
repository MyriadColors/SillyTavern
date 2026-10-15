import { describe, test, expect } from '@jest/globals';
import {
    TRIGGER_MODES,
    decideFire,
    estimateChatTokens,
    resolvePruneTarget,
    resolveThreshold,
    shouldFire,
} from '../public/scripts/extensions/context-compaction/gate.js';
import { applyCachedEvictions, planPrune } from '../public/scripts/extensions/context-compaction/pruner.js';
import { hashChatMessages, hashMessage, scoreMessage } from '../public/scripts/extensions/context-compaction/scorer.js';
import { resolveFlags } from '../public/scripts/extensions/context-compaction/flags.js';
import { clearState, consumeForceArmed, readState, setTurnsSince, writeState } from '../public/scripts/extensions/context-compaction/cache.js';

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

describe('token-unit unification', () => {
    test('gate fires but old plain target would miss; unified target prunes', () => {
        // Char estimate (len/3.35 + 4/msg) deliberately overshoots the simulated
        // accurate tokenizer counts, reproducing the gate/prune unit mismatch.
        const chat = [{ role: 'system', content: 'You are a test character.' }];
        for (let i = 0; i < 14; i++) {
            chat.push({ role: 'user', content: `Filler message number ${i} ` + 'x'.repeat(335) });
        }
        chat.push({ role: 'user', content: 'Recent important question?' });
        chat.push({ role: 'assistant', content: 'Recent answer to keep.' });

        const estTokens = estimateChatTokens(chat);
        const thresholdTokens = 1000;
        const decision = shouldFire({
            estTokens,
            thresholdTokens,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 0,
            settings: { triggerMode: TRIGGER_MODES.THRESHOLD, everyN: 0, cooldownN: 0 },
        });
        expect(decision).toEqual({ fire: true, reason: 'threshold' });

        // Simulated accurate tokenizer counts: far below the char estimate.
        const tokenCounts = chat.map(() => 10);
        const accurateTotal = tokenCounts.reduce((sum, count) => sum + count, 0);
        expect(estTokens).toBeGreaterThan(accurateTotal * 2);

        // Old behavior: plain 0.95x threshold target already covers the accurate
        // total, so planning against it prunes nothing despite the gate firing.
        const plainTarget = Math.max(1, Math.round(thresholdTokens * 0.95));
        const missed = planPrune(chat, {
            tokenCounts,
            targetTokens: plainTarget,
            preserveN: 2,
            flagsByIndex: new Map(),
            aggressiveness: 'balanced',
        });
        expect(missed.evictedIndexes).toEqual([]);

        // Unified target converts the estimated overshoot into accurate units.
        const targetTokens = resolvePruneTarget({ estTokens, accurateTotal, thresholdTokens });
        expect(targetTokens).toBeLessThan(accurateTotal);
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens,
            preserveN: 2,
            flagsByIndex: new Map(),
            aggressiveness: 'balanced',
        });
        expect(plan.evictedIndexes.length).toBeGreaterThan(0);
        expect(accurateTotal - plan.savedTokens).toBeLessThanOrEqual(targetTokens);
    });

    test('resolvePruneTarget falls back to plain threshold without usable inputs', () => {
        expect(resolvePruneTarget({ estTokens: 0, accurateTotal: 100, thresholdTokens: 1000 })).toBe(950);
        expect(resolvePruneTarget({ estTokens: 1000, accurateTotal: 0, thresholdTokens: 1000 })).toBe(950);
    });
});

describe('one-shot force and turn counter', () => {
    const baseState = {
        evictedHashes: [],
        stub: '',
        lastFiredAtTokens: 0,
        turnsSinceCompaction: 0,
        tokenSaved: 0,
        lastChatLength: 5,
    };

    test('force fires in threshold mode far below threshold', () => {
        const decision = decideFire({
            forced: true,
            estTokens: 100,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 0,
            settings: { triggerMode: TRIGGER_MODES.THRESHOLD, everyN: 0, cooldownN: 3 },
        });
        expect(decision).toEqual({ fire: true, reason: 'force' });
    });

    test('unforced decision still defers to the gate', () => {
        const decision = decideFire({
            forced: false,
            estTokens: 100,
            thresholdTokens: 8000,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 0,
            settings: { triggerMode: TRIGGER_MODES.THRESHOLD, everyN: 0, cooldownN: 0 },
        });
        expect(decision.fire).toBe(false);
    });

    test('force disarms after one consume (second generation idle)', () => {
        const metadata = {};
        writeState(metadata, { ...baseState, forceArmed: true });
        expect(consumeForceArmed(metadata)).toBe(true);
        expect(readState(metadata).forceArmed).toBe(false);
        expect(consumeForceArmed(metadata)).toBe(false);
    });

    test('consume preserves the rest of the state', () => {
        const metadata = {};
        writeState(metadata, { ...baseState, evictedHashes: ['h1'], tokenSaved: 42, forceArmed: true });
        consumeForceArmed(metadata);
        const state = readState(metadata);
        expect(state.evictedHashes).toEqual(['h1']);
        expect(state.tokenSaved).toBe(42);
    });

    test('legacy state without the flag reads disarmed', () => {
        expect(readState({ context_compaction: { turnsSinceCompaction: 2 } }).forceArmed).toBe(false);
        expect(readState({}).forceArmed).toBe(false);
    });

    test('one simulated exchange advances the counter by exactly 1', () => {
        const metadata = {};
        writeState(metadata, { ...baseState, turnsSinceCompaction: 3 });
        const state = readState(metadata);
        setTurnsSince(metadata, state.turnsSinceCompaction + 1);
        expect(readState(metadata).turnsSinceCompaction).toBe(4);
    });

    test('force flag round-trips through writeState/readState', () => {
        const metadata = {};
        writeState(metadata, { ...baseState, forceArmed: true });
        expect(readState(metadata).forceArmed).toBe(true);
        writeState(metadata, { ...readState(metadata), forceArmed: false });
        expect(readState(metadata).forceArmed).toBe(false);
    });
});

describe('hash robustness', () => {
    test('speaker name disambiguates identical text', () => {
        const alice = hashMessage({ role: 'user', name: 'Alice', content: 'Hello there' });
        const bob = hashMessage({ role: 'user', name: 'Bob', content: 'Hello there' });
        expect(alice).not.toBe(bob);
    });

    test('array content normalizes like the token counters', () => {
        const fromParts = hashMessage({ role: 'user', content: [{ text: 'ab' }, { text: 'cd' }] });
        const fromString = hashMessage({ role: 'user', content: 'abcd' });
        expect(fromParts).toBe(fromString);
    });

    test('duplicate messages hash distinctly and stably under append', () => {
        const filler = { role: 'user', content: 'Same filler repeated.' };
        const chat = [{ role: 'system', content: 'Intro.' }, { ...filler }, { ...filler }, { ...filler }];
        const hashes = hashChatMessages(chat);
        expect(new Set(hashes).size).toBe(hashes.length);
        const extended = hashChatMessages([...chat, { role: 'assistant', content: 'A new reply.' }]);
        expect(extended.slice(0, hashes.length)).toEqual(hashes);
    });

    test('duplicate chat evicts exactly the planned count', () => {
        const chat = [{ role: 'system', content: 'You are a test character.' }];
        for (let i = 0; i < 5; i++) {
            chat.push({ role: 'user', content: 'Identical filler repeated over and over.' });
        }
        chat.push({ role: 'user', content: 'Recent important question?' });
        chat.push({ role: 'assistant', content: 'Recent answer to keep.' });

        const tokenCounts = chat.map(() => 10);
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: 65,
            preserveN: 2,
            flagsByIndex: new Map(),
            aggressiveness: 'balanced',
        });
        expect(plan.evictedIndexes).toHaveLength(2);
        const filtered = applyCachedEvictions(chat, plan.evictedHashes, plan.stub);
        expect(filtered).toHaveLength(chat.length - 2 + 1);
        const remaining = filtered.filter(message => message.content === 'Identical filler repeated over and over.');
        expect(remaining).toHaveLength(3);
    });
});

describe('flag attribution', () => {
    test('pin on a repeated opener lands on the right message', () => {
        const stChat = [0, 1, 2, 3].map(index => ({
            mes: 'Shall we begin?',
            is_user: true,
            ...(index === 2 ? { pinned: true } : {}),
        }));
        const chat = [{ role: 'system', content: 'Intro.' }];
        for (let i = 0; i < 4; i++) {
            chat.push({ role: 'user', content: 'Shall we begin?' });
        }
        const flags = resolveFlags(chat, stChat);
        expect(flags.size).toBe(1);
        expect(flags.get(3)).toEqual({ pinned: true });
    });

    test('speaker-prefixed prompt content matches the bare ST text', () => {
        const stChat = [{ mes: 'hello there', name: 'Alice', is_user: false, extra: { isImportant: true } }];
        const chat = [{ role: 'assistant', name: 'Alice', content: 'Alice: hello there' }];
        expect(resolveFlags(chat, stChat).get(0)).toEqual({ important: true });
    });

    test('non-string prompt content is skipped explicitly', () => {
        const stChat = [{ mes: 'hello', is_user: true, pinned: true }];
        const chat = [{ role: 'user', content: [{ text: 'hello' }] }];
        expect(resolveFlags(chat, stChat).size).toBe(0);
    });

    test('truncation fallback only uses unconsumed messages', () => {
        const full = 'o'.repeat(200);
        const truncated = full.slice(0, 150);
        const stChat = [{ mes: full, is_user: true, pinned: true }];
        const chat = [
            { role: 'user', content: truncated },
            { role: 'user', content: truncated },
        ];
        const flags = resolveFlags(chat, stChat);
        expect(flags.get(0)).toEqual({ pinned: true });
        expect(flags.has(1)).toBe(false);
    });
});

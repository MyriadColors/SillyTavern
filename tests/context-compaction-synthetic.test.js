import { readFileSync } from 'node:fs';
import { describe, test, expect } from '@jest/globals';
import {
    TRIGGER_MODES,
    estimateChatTokens,
    resolveThreshold,
    shouldFire,
} from '../public/scripts/extensions/context-compaction/gate.js';
import { applyCachedEvictions, planPrune } from '../public/scripts/extensions/context-compaction/pruner.js';
import { extractKeywords, scoreMessage } from '../public/scripts/extensions/context-compaction/scorer.js';
import { clearState, readState, writeState } from '../public/scripts/extensions/context-compaction/cache.js';

function loadFixture(name) {
    const url = new URL(`./fixtures/${name}`, import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
}

function toChat(messages) {
    return messages.map(entry => {
        const message = { role: entry.role, content: entry.content };
        if (entry.tool_calls) {
            message.tool_calls = entry.tool_calls;
        }
        return message;
    });
}

function toFlags(messages) {
    const flags = new Map();
    messages.forEach((entry, index) => {
        if (entry.flags) {
            flags.set(index, entry.flags);
        }
    });
    return flags;
}

const SETTINGS = {
    triggerMode: TRIGGER_MODES.EITHER,
    thresholdMode: 'percent',
    thresholdPercent: 70,
    everyN: 10,
    cooldownN: 0,
    preserveN: 10,
    aggressiveness: 'balanced',
};

describe('synthetic compaction: tavern fixture', () => {
    const fixture = loadFixture('compaction-chat.json');
    const chat = toChat(fixture.messages);
    const flagsByIndex = toFlags(fixture.messages);
    const tokenCounts = chat.map(message => estimateChatTokens([message]));
    const totalTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
    // Protected by flags or pruner rules (index 0, tool calls/results): derived, not hardcoded.
    const expectedSafe = new Set([0]);
    fixture.messages.forEach((entry, index) => {
        if (entry.flags || entry.tool_calls || entry.role === 'tool') {
            expectedSafe.add(index);
        }
    });

    test('gate fires on the full chat at 70% threshold', () => {
        const maxContext = totalTokens;
        const thresholdTokens = resolveThreshold(SETTINGS, maxContext);
        const decision = shouldFire({
            estTokens: estimateChatTokens(chat),
            thresholdTokens,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 99,
            settings: SETTINGS,
        });
        expect(decision).toEqual({ fire: true, reason: 'threshold' });
    });

    test('gate stays idle on the opening exchange', () => {
        const opening = chat.slice(0, 5);
        const maxContext = totalTokens;
        const thresholdTokens = resolveThreshold(SETTINGS, maxContext);
        const decision = shouldFire({
            estTokens: estimateChatTokens(opening),
            thresholdTokens,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 0,
            settings: SETTINGS,
        });
        expect(decision.fire).toBe(false);
    });

    test('prune protects facts, flags, tool chain, and recents', () => {
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: Math.floor(totalTokens * 0.5),
            preserveN: SETTINGS.preserveN,
            flagsByIndex,
            aggressiveness: SETTINGS.aggressiveness,
        });
        expect(plan.evictedIndexes.length).toBeGreaterThan(0);

        const evicted = new Set(plan.evictedIndexes);
        // Flagged carriers, tool chain, and index 0 are never evicted.
        for (const index of expectedSafe) {
            expect(evicted.has(index)).toBe(false);
        }
        // The last preserveN non-system messages are protected.
        expect(evicted.has(0)).toBe(false);
        const recentStart = chat.length - SETTINGS.preserveN;
        for (let index = recentStart; index < chat.length; index++) {
            expect(evicted.has(index)).toBe(false);
        }
        // Everything evicted is an unflagged, non-tool candidate from the middle.
        for (const index of plan.evictedIndexes) {
            expect(flagsByIndex.has(index)).toBe(false);
            expect(chat[index]?.tool_calls).toBeUndefined();
            expect(chat[index]?.role).not.toBe('tool');
            expect(index).toBeGreaterThan(0);
            expect(index).toBeLessThan(recentStart);
        }
    });

    test('eviction follows score order (filler first)', () => {
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: Math.floor(totalTokens * 0.5),
            preserveN: SETTINGS.preserveN,
            flagsByIndex,
            aggressiveness: SETTINGS.aggressiveness,
        });
        const evicted = new Set(plan.evictedIndexes);
        const evictedScores = plan.evictedIndexes.map(index =>
            scoreMessage(chat[index], index, chat.length, flagsByIndex.get(index) || {}),
        );
        const survivorScores = [];
        for (let index = 0; index < chat.length; index++) {
            if (!evicted.has(index) && index > 0 && index < chat.length - SETTINGS.preserveN
                && !chat[index]?.tool_calls && chat[index]?.role !== 'tool') {
                survivorScores.push(scoreMessage(chat[index], index, chat.length, flagsByIndex.get(index) || {}));
            }
        }
        expect(survivorScores.length).toBeGreaterThan(0);
        expect(Math.max(...evictedScores)).toBeLessThanOrEqual(Math.min(...survivorScores));
    });

    test('stub preserves the planted facts as keywords', () => {
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: Math.floor(totalTokens * 0.5),
            preserveN: SETTINGS.preserveN,
            flagsByIndex,
            aggressiveness: SETTINGS.aggressiveness,
        });
        expect(plan.stub).toContain('Context compacted');
        const stub = plan.stub.toLowerCase();
        expect(stub).toContain('sunken');
        expect(stub).toContain('millhouse');
        // 'maren' loses the top-6 cutoff to setting words under document-frequency
        // counting, but must still rank (persistence guard against the filler cap).
        const evictedTexts = plan.evictedIndexes.map(index => chat[index].content);
        expect(extractKeywords(evictedTexts, 12).map(word => word.toLowerCase())).toContain('maren');
    });

    test('cached evictions re-apply with the stub inserted', () => {
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: Math.floor(totalTokens * 0.5),
            preserveN: SETTINGS.preserveN,
            flagsByIndex,
            aggressiveness: SETTINGS.aggressiveness,
        });
        const metadata = {};
        writeState(metadata, {
            evictedHashes: plan.evictedHashes,
            stub: plan.stub,
            lastFiredAtTokens: totalTokens,
            turnsSinceCompaction: 0,
            tokenSaved: plan.savedTokens,
            lastChatLength: chat.length,
        });
        const state = readState(metadata);
        const filtered = applyCachedEvictions(chat, state.evictedHashes, state.stub);
        expect(filtered.length).toBe(chat.length - plan.evictedIndexes.length + 1);
        expect(filtered.some(message => String(message.content).includes('Context compacted'))).toBe(true);
        // Pinned fact and tool result survive the re-applied filter.
        expect(filtered.some(message => String(message.content).includes('old millhouse'))).toBe(true);
        expect(filtered.some(message => message.role === 'tool')).toBe(true);
        clearState(metadata);
        expect(readState(metadata).evictedHashes).toEqual([]);
    });

    test('duplicates evict exactly the planned count while protections hold', () => {
        const fillerIndex = chat.findIndex((message, index) =>
            index > 0 && index < chat.length - SETTINGS.preserveN
            && !flagsByIndex.has(index) && !message?.tool_calls && message?.role !== 'tool',
        );
        expect(fillerIndex).toBeGreaterThan(0);
        const duped = [
            ...chat.slice(0, fillerIndex + 1),
            { ...chat[fillerIndex] },
            { ...chat[fillerIndex] },
            ...chat.slice(fillerIndex + 1),
        ];
        const dupedCounts = duped.map(message => estimateChatTokens([message]));
        const dupedTotal = dupedCounts.reduce((sum, count) => sum + count, 0);
        const dupedFlags = new Map();
        for (const [index, entry] of flagsByIndex) {
            dupedFlags.set(index > fillerIndex ? index + 2 : index, entry);
        }
        const plan = planPrune(duped, {
            tokenCounts: dupedCounts,
            targetTokens: Math.floor(dupedTotal * 0.5),
            preserveN: SETTINGS.preserveN,
            flagsByIndex: dupedFlags,
            aggressiveness: SETTINGS.aggressiveness,
        });
        expect(plan.evictedIndexes.length).toBeGreaterThan(0);
        expect(plan.evictedIndexes).not.toContain(0);
        const filtered = applyCachedEvictions(duped, plan.evictedHashes, plan.stub);
        expect(filtered).toHaveLength(duped.length - plan.evictedIndexes.length + 1);
    });
});

describe('synthetic compaction: 205-turn soak', () => {
    const fixture = loadFixture('soak-chat.json');
    const chat = toChat(fixture.messages);

    test('scales: gate fires and prune finishes fast', () => {
        expect(chat.length).toBeGreaterThanOrEqual(200);
        const estTokens = estimateChatTokens(chat);
        const thresholdTokens = resolveThreshold(SETTINGS, estTokens);
        const decision = shouldFire({
            estTokens,
            thresholdTokens,
            lastFiredAtTokens: 0,
            turnsSinceCompaction: 99,
            settings: SETTINGS,
        });
        expect(decision).toEqual({ fire: true, reason: 'threshold' });

        const tokenCounts = chat.map(message => estimateChatTokens([message]));
        const total = tokenCounts.reduce((sum, count) => sum + count, 0);
        const started = Date.now();
        const plan = planPrune(chat, {
            tokenCounts,
            targetTokens: Math.floor(total * 0.6),
            preserveN: SETTINGS.preserveN,
            flagsByIndex: new Map(),
            aggressiveness: SETTINGS.aggressiveness,
        });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(plan.evictedIndexes.length).toBeGreaterThan(0);
        expect(plan.stub).toContain('Context compacted');
        expect(plan.evictedIndexes.includes(0)).toBe(false);
        // Tiling markers repeat in nearly every message: the concentration cap
        // must keep them out of the stub in favor of story words.
        const stubLower = plan.stub.toLowerCase();
        expect(stubLower).not.toContain('winter');
        expect(stubLower).not.toContain('retold');
    });
});

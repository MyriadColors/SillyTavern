import { describe, test, expect } from '@jest/globals';
import { mergeFileBlocksIntoDbPrompt, shouldReusePinnedBlock, sortQueriedMessagesByRelevance, sortQueriedMessagesChronologically } from '../public/scripts/extensions/vectors/cache-utils.js';

function makeMessage(name, mes) {
    return { name, mes };
}

describe('sortQueriedMessagesChronologically', () => {
    test('orders relevance-shuffled messages by chat order', () => {
        const chat = [makeMessage('A', 'first'), makeMessage('B', 'second'), makeMessage('C', 'third')];
        const queried = [chat[2], chat[0], chat[1]];
        const result = sortQueriedMessagesChronologically(queried, chat);
        expect(result).toEqual([chat[0], chat[1], chat[2]]);
    });

    test('returns the same array reference for chaining', () => {
        const chat = [makeMessage('A', 'first'), makeMessage('B', 'second')];
        const queried = [chat[1], chat[0]];
        expect(sortQueriedMessagesChronologically(queried, chat)).toBe(queried);
    });

    test('produces identical order across score-jittered runs (prefix stability)', () => {
        const chat = [makeMessage('A', 'first'), makeMessage('B', 'second'), makeMessage('C', 'third'), makeMessage('D', 'fourth')];
        const runOne = [chat[3], chat[0], chat[2]];
        const runTwo = [chat[0], chat[2], chat[3]];
        sortQueriedMessagesChronologically(runOne, chat);
        sortQueriedMessagesChronologically(runTwo, chat);
        expect(runOne).toEqual(runTwo);
    });

    test('passes through empty and singleton arrays', () => {
        expect(sortQueriedMessagesChronologically([], [])).toEqual([]);
        const chat = [makeMessage('A', 'only')];
        expect(sortQueriedMessagesChronologically([chat[0]], chat)).toEqual([chat[0]]);
    });

    test('does not mutate the base chat array', () => {
        const chat = [makeMessage('A', 'first'), makeMessage('B', 'second'), makeMessage('C', 'third')];
        const snapshot = [...chat];
        sortQueriedMessagesChronologically([chat[2], chat[0]], chat);
        expect(chat).toEqual(snapshot);
    });

    test('sorts messages missing from chat last, preserving their relative order', () => {
        const chat = [makeMessage('A', 'first'), makeMessage('B', 'second')];
        const outsiderOne = makeMessage('X', 'unknown-one');
        const outsiderTwo = makeMessage('Y', 'unknown-two');
        const queried = [outsiderOne, chat[1], outsiderTwo, chat[0]];
        sortQueriedMessagesChronologically(queried, chat);
        expect(queried).toEqual([chat[0], chat[1], outsiderOne, outsiderTwo]);
    });
});

describe('sortQueriedMessagesByRelevance', () => {
    const rankFrom = (map) => (message) => map.get(message);

    test('orders by ascending rank (lower is more relevant)', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b'), makeMessage('C', 'c')];
        const ranks = new Map([[chat[0], 2], [chat[1], 0], [chat[2], 1]]);
        const queried = [chat[0], chat[1], chat[2]];
        sortQueriedMessagesByRelevance(queried, chat, rankFrom(ranks));
        expect(queried).toEqual([chat[1], chat[2], chat[0]]);
    });

    test('breaks rank ties by chat order', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b'), makeMessage('C', 'c')];
        const ranks = new Map([[chat[0], 1], [chat[1], 1], [chat[2], 1]]);
        const queried = [chat[2], chat[0], chat[1]];
        sortQueriedMessagesByRelevance(queried, chat, rankFrom(ranks));
        expect(queried).toEqual([chat[0], chat[1], chat[2]]);
    });

    test('sorts unknown or negative ranks last', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b')];
        const ranks = new Map([[chat[0], 5], [chat[1], -1]]);
        const queried = [chat[1], chat[0]];
        sortQueriedMessagesByRelevance(queried, chat, rankFrom(ranks));
        expect(queried).toEqual([chat[0], chat[1]]);
    });

    test('returns the same array reference for chaining', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b')];
        const queried = [chat[1], chat[0]];
        const ranks = new Map([[chat[0], 0], [chat[1], 1]]);
        expect(sortQueriedMessagesByRelevance(queried, chat, rankFrom(ranks))).toBe(queried);
    });

    test('does not mutate the base chat array', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b'), makeMessage('C', 'c')];
        const snapshot = [...chat];
        const ranks = new Map([[chat[0], 2], [chat[1], 0], [chat[2], 1]]);
        sortQueriedMessagesByRelevance([chat[0], chat[1]], chat, rankFrom(ranks));
        expect(chat).toEqual(snapshot);
    });

    test('reorders when ranks jitter, unlike chronological order', () => {
        const chat = [makeMessage('A', 'a'), makeMessage('B', 'b')];
        const first = new Map([[chat[0], 1], [chat[1], 0]]);
        const second = new Map([[chat[0], 0], [chat[1], 1]]);
        const queried = [chat[0], chat[1]];
        sortQueriedMessagesByRelevance(queried, chat, rankFrom(first));
        expect(queried).toEqual([chat[1], chat[0]]);
        sortQueriedMessagesByRelevance(queried, chat, rankFrom(second));
        expect(queried).toEqual([chat[0], chat[1]]);
    });
});

describe('mergeFileBlocksIntoDbPrompt', () => {
    const formatBlock = (text) => `Related information:\n${text}`;

    test('returns empty string when there are no blocks', () => {
        expect(mergeFileBlocksIntoDbPrompt({ fileBlocks: [], formatBlock })).toBe('');
        expect(mergeFileBlocksIntoDbPrompt({ previousDbPrompt: 'prev', fileBlocks: [], formatBlock })).toBe('');
    });

    test('applies the template when there is no previous prompt', () => {
        expect(mergeFileBlocksIntoDbPrompt({ fileBlocks: ['chunk-a', 'chunk-b'], formatBlock }))
            .toBe('Related information:\nchunk-a\n\nchunk-b');
    });

    test('appends raw blocks when a previous prompt exists (no duplicated header)', () => {
        expect(mergeFileBlocksIntoDbPrompt({ previousDbPrompt: 'Related information:\nold', fileBlocks: ['new-chunk'], formatBlock }))
            .toBe('Related information:\nold\n\nnew-chunk');
    });

    test('dedupes repeated blocks while preserving first-seen order', () => {
        expect(mergeFileBlocksIntoDbPrompt({ fileBlocks: ['a', 'b', 'a', 'c', 'b'], formatBlock }))
            .toBe('Related information:\na\n\nb\n\nc');
    });

    test('ignores falsy blocks', () => {
        expect(mergeFileBlocksIntoDbPrompt({ fileBlocks: ['', null, undefined, 'real'], formatBlock }))
            .toBe('Related information:\nreal');
    });

    test('does not mutate the input fileBlocks array', () => {
        const fileBlocks = ['b', 'a', 'b'];
        mergeFileBlocksIntoDbPrompt({ fileBlocks, formatBlock });
        expect(fileBlocks).toEqual(['b', 'a', 'b']);
    });

    test('does not call formatBlock when a previous prompt exists', () => {
        let calls = 0;
        const countingFormat = (text) => {
            calls++;
            return formatBlock(text);
        };
        mergeFileBlocksIntoDbPrompt({ previousDbPrompt: 'old', fileBlocks: ['new'], formatBlock: countingFormat });
        expect(calls).toBe(0);
    });

    test('falls back to raw blocks with a warning when formatBlock is omitted', () => {
        const warnings = [];
        expect(mergeFileBlocksIntoDbPrompt({ fileBlocks: ['chunk-a', 'chunk-b'], onFallback: (message) => warnings.push(message) }))
            .toBe('chunk-a\n\nchunk-b');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/formatBlock omitted/);
    });
});

describe('shouldReusePinnedBlock', () => {
    test('is disabled by default and for non-positive intervals', () => {
        expect(shouldReusePinnedBlock()).toEqual({ reuse: false, reason: 'disabled', overlap: 0 });
        expect(shouldReusePinnedBlock({ pinnedKeys: [1], freshKeys: [1], interval: 0 }).reason).toBe('disabled');
        expect(shouldReusePinnedBlock({ pinnedKeys: [1], freshKeys: [1], interval: -2 }).reason).toBe('disabled');
    });

    test('reports no-pin when there is nothing pinned (e.g. after a chat switch)', () => {
        expect(shouldReusePinnedBlock({ pinnedKeys: [], freshKeys: [1, 2], interval: 3 }).reason).toBe('no-pin');
    });

    test('reports no-fresh when nothing was retrieved, keeping the pin untouched', () => {
        expect(shouldReusePinnedBlock({ pinnedKeys: [1, 2], freshKeys: [], interval: 3 }).reason).toBe('no-fresh');
    });

    test('refreshes once the interval elapses', () => {
        const base = { pinnedKeys: [1, 2], freshKeys: [1, 2], interval: 3 };
        expect(shouldReusePinnedBlock({ ...base, turnsSinceRefresh: 2 }).reuse).toBe(true);
        expect(shouldReusePinnedBlock({ ...base, turnsSinceRefresh: 3 }).reason).toBe('interval');
    });

    test('measures Jaccard overlap between pinned and fresh keys', () => {
        // Intersection {2,3}, union {1,2,3,4} => 0.5
        const decision = shouldReusePinnedBlock({ pinnedKeys: [1, 2, 3], freshKeys: [2, 3, 4], interval: 5, overlapThreshold: 0.5 });
        expect(decision.overlap).toBeCloseTo(0.5);
        expect(decision).toMatchObject({ reuse: true, reason: 'reuse' });
    });

    test('refreshes when overlap falls below the threshold', () => {
        const decision = shouldReusePinnedBlock({ pinnedKeys: [1, 2, 3], freshKeys: [2, 3, 4], interval: 5, overlapThreshold: 0.51 });
        expect(decision).toMatchObject({ reuse: false, reason: 'overlap' });
        expect(decision.overlap).toBeCloseTo(0.5);
    });

    test('treats duplicate keys as a single set member', () => {
        const decision = shouldReusePinnedBlock({ pinnedKeys: [1, 1, 2], freshKeys: [1, 2, 2], interval: 5 });
        expect(decision).toMatchObject({ reuse: true, reason: 'reuse' });
        expect(decision.overlap).toBeCloseTo(1);
    });

    test('accepts string keys (file-block texts) as well as numeric hashes', () => {
        const decision = shouldReusePinnedBlock({ pinnedKeys: ['chunk-a', 'chunk-b'], freshKeys: ['chunk-b', 'chunk-c'], interval: 5, overlapThreshold: 0.3 });
        expect(decision).toMatchObject({ reuse: true, reason: 'reuse' });
        expect(decision.overlap).toBeCloseTo(1 / 3);
    });
});

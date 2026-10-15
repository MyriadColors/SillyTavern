/**
 * Eviction planner and cached-filter applier. DOM-free so it can be unit tested.
 */
import { extractKeywords, hashChatMessages, scoreMessage } from './scorer.js';

/**
 * Decide which messages to evict to get under the token target.
 * Never evicts: index 0, the last preserveN non-system messages, tool calls / tool results.
 * @param {Array<object>} chat Chat-completion messages
 * @param {object} options Planning options
 * @param {number[]} options.tokenCounts Per-message token counts (falls back to char estimate)
 * @param {number} options.targetTokens Token target to reach
 * @param {number} options.preserveN Number of recent non-system messages to always keep
 * @param {Map<number, object>} [options.flagsByIndex] Importance flags per index
 * @param {string} [options.aggressiveness] conservative|balanced|aggressive
 * @returns {{evictedIndexes: number[], evictedHashes: string[], stub: string, savedTokens: number}} Plan
 */
export function planPrune(chat, { tokenCounts, targetTokens, preserveN, flagsByIndex, aggressiveness }) {
    const messages = Array.isArray(chat) ? chat : [];
    const total = messages.length;
    const preserve = Math.max(0, Number(preserveN ?? 10));
    const counts = Array.isArray(tokenCounts) ? tokenCounts : [];
    const flags = flagsByIndex instanceof Map ? flagsByIndex : new Map();

    const currentTotal = counts.reduce((sum, count) => sum + (Number(count) || 0), 0);
    if (currentTotal <= targetTokens || total === 0) {
        return { evictedIndexes: [], evictedHashes: [], stub: '', savedTokens: 0 };
    }

    const protectedIndexes = new Set();
    protectedIndexes.add(0);
    let kept = 0;
    for (let index = total - 1; index >= 0 && kept < preserve; index--) {
        const message = messages[index];
        if (message?.role === 'system') {
            continue;
        }
        protectedIndexes.add(index);
        kept++;
    }
    for (let index = 0; index < total; index++) {
        const message = messages[index];
        if (message?.tool_calls || message?.role === 'tool') {
            protectedIndexes.add(index);
        }
    }

    const candidates = [];
    for (let index = 0; index < total; index++) {
        if (protectedIndexes.has(index)) {
            continue;
        }
        const message = messages[index];
        if (message?.role === 'system' && index < 3) {
            continue;
        }
        candidates.push({
            index,
            score: scoreMessage(message, index, total, flags.get(index) || {}),
            tokens: Number(counts[index]) || 0,
        });
    }
    candidates.sort((a, b) => a.score - b.score);

    const overshoot = aggressiveness === 'aggressive' ? 1.1 : aggressiveness === 'conservative' ? 1.0 : 1.05;
    const needToSave = Math.ceil((currentTotal - targetTokens) * overshoot);
    const evictedIndexes = [];
    let savedTokens = 0;
    for (const candidate of candidates) {
        if (savedTokens >= needToSave) {
            break;
        }
        evictedIndexes.push(candidate.index);
        savedTokens += candidate.tokens;
    }
    evictedIndexes.sort((a, b) => a - b);

    if (evictedIndexes.length === 0) {
        return { evictedIndexes: [], evictedHashes: [], stub: '', savedTokens: 0 };
    }

    const hashes = hashChatMessages(messages);
    const evictedHashes = evictedIndexes.map(index => hashes[index]);
    const texts = evictedIndexes.map(index => {
        const content = messages[index]?.content;
        return typeof content === 'string' ? content : JSON.stringify(content ?? '');
    });
    const keywords = extractKeywords(texts);
    const stub = `[Context compacted: ${evictedIndexes.length} older message(s), ~${savedTokens} tokens. Key points: ${keywords.join('; ') || 'general conversation'}.]`;

    return { evictedIndexes, evictedHashes, stub, savedTokens };
}

/**
 * Apply a cached eviction list to a chat array, inserting the stub at the first evicted position.
 * Mutates nothing; returns a new array.
 * @param {Array<object>} chat Chat-completion messages
 * @param {string[]} evictedHashes Hashes to remove
 * @param {string} stub Stub text to insert (empty = no stub)
 * @returns {Array<object>} Filtered chat
 */
export function applyCachedEvictions(chat, evictedHashes, stub) {
    const messages = Array.isArray(chat) ? chat : [];
    if (!Array.isArray(evictedHashes) || evictedHashes.length === 0) {
        return [...messages];
    }
    const evicted = new Set(evictedHashes);
    const hashes = hashChatMessages(messages);
    const kept = [];
    let stubInserted = false;
    let firstEvictedIndex = -1;
    const remaining = [];

    for (let index = 0; index < messages.length; index++) {
        if (evicted.has(hashes[index])) {
            if (firstEvictedIndex === -1) {
                firstEvictedIndex = kept.length;
            }
            continue;
        }
        remaining.push({ message: messages[index], keptIndex: kept.length });
        kept.push(messages[index]);
    }

    if (remaining.length === messages.length || !stub) {
        return kept;
    }

    if (!stubInserted) {
        stubInserted = true;
        const insertAt = Math.max(0, firstEvictedIndex === -1 ? 1 : firstEvictedIndex);
        kept.splice(insertAt, 0, { role: 'system', content: String(stub) });
    }

    return kept;
}

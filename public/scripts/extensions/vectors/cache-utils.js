/**
 * Pure, dependency-free helpers for cache-aware vector retrieval.
 * No browser or Node globals are used so this module can be unit tested
 * directly under Node (jest) and imported by browser code.
 *
 * Background: backend prompt caches (llama.cpp cache_prompt, OpenAI automatic
 * prefix caching, Claude prompt caching) key on a stable prompt prefix. The
 * vectors extension therefore keeps retrieved content in a static system-prefix
 * zone and serializes it deterministically, instead of shuffling messages into
 * the chat history body.
 */

/**
 * Sorts retrieved messages into chronological (chat) order, which is stable
 * under small relevance-score jitter between turns. Relevance ranking is
 * intentionally discarded: relevance-desc ordering reshuffles the emitted
 * block every turn and invalidates the shared prefix cache.
 *
 * Limitation: retrieved content itself still changes per turn (best-effort
 * stability, not pinned). Callers must NOT remove the returned messages from
 * the base chat array; duplication between history and the injected block
 * costs a few tokens but preserves cache hits.
 *
 * Note: users who prefer relevance over strict prefix stability can opt into
 * sortQueriedMessagesByRelevance via the `vectors_order` setting.
 * TODO: add an optional "pin / refresh interval" mode that reuses the previous
 * block unless retrieval overlap drops below a threshold, for near-strict
 * prefix stability at the cost of staleness.
 * @param {object[]} queriedMessages Retrieved messages (mutated in place, also returned).
 * @param {object[]} chat Full chat array defining the canonical order.
 * @returns {object[]} The sorted `queriedMessages` array.
 */
export function sortQueriedMessagesChronologically(queriedMessages, chat) {
    const messageOrder = new Map(chat.map((message, index) => [message, index]));
    // Unknown messages (not reference-identical to a chat entry) sort last;
    // without this fallback the comparator yields NaN and order is engine-defined.
    queriedMessages.sort((a, b) => (messageOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (messageOrder.get(b) ?? Number.MAX_SAFE_INTEGER));
    return queriedMessages;
}

/**
 * Sorts retrieved messages by vector relevance rank (ascending: lower rank is
 * more relevant), with chronological (chat) order as the tie-break so the
 * output stays deterministic when ranks collide.
 *
 * Tradeoff: relevance ranking is the pre-cache-aware behavior. Small
 * score jitter between turns reshuffles the emitted block and invalidates
 * the shared prefix cache, so this is opt-in; chronological order (see
 * sortQueriedMessagesChronologically) is the cache-friendly default.
 *
 * @param {object[]} queriedMessages Retrieved messages (mutated in place, also returned).
 * @param {object[]} chat Full chat array defining the canonical order and tie-break.
 * @param {(message: object) => number} rankOf Returns the relevance rank of a message (lower is more relevant). Messages with unknown rank (`undefined`, `null`, or negative) sort last.
 * @returns {object[]} The sorted `queriedMessages` array.
 */
export function sortQueriedMessagesByRelevance(queriedMessages, chat, rankOf) {
    const messageOrder = new Map(chat.map((message, index) => [message, index]));
    const rankOrLast = (message) => {
        const rank = rankOf(message);
        return typeof rank === 'number' && rank >= 0 ? rank : Number.MAX_SAFE_INTEGER;
    };
    const orderOrLast = (message) => messageOrder.get(message) ?? Number.MAX_SAFE_INTEGER;
    queriedMessages.sort((a, b) => (rankOrLast(a) - rankOrLast(b)) || (orderOrLast(a) - orderOrLast(b)));
    return queriedMessages;
}

/**
 * Decides whether a pinned (frozen) retrieval block can be reused this turn.
 *
 * Pinning keeps the injected context byte-identical across turns for prompt-
 * cache stability. A pinned block is reused only while all of these hold:
 * pinning is enabled (`interval > 0`), a pin exists, fresh results exist, the
 * refresh interval has not elapsed, and the Jaccard overlap between pinned
 * and fresh result keys meets `overlapThreshold`. Otherwise the caller should
 * recompute the block and re-pin (except for `no-fresh`, where the caller
 * keeps the existing pin untouched and follows its normal empty path).
 *
 * Keys are opaque identities: chunk hashes for chat memories, chunk texts
 * (or any stable per-chunk id) for file blocks.
 * @param {object} [options] Pin decision inputs.
 * @param {Array<string|number>} [options.pinnedKeys] Keys of the pinned block. Empty means no pin (e.g. after a chat switch).
 * @param {Array<string|number>} [options.freshKeys] Keys retrieved this turn.
 * @param {number} [options.turnsSinceRefresh] Turns elapsed since the pin was stored.
 * @param {number} [options.interval] Refresh every N turns. Values `<= 0` disable pinning.
 * @param {number} [options.overlapThreshold] Minimum Jaccard overlap (0-1) to keep the pin.
 * @returns {{ reuse: boolean, reason: string, overlap: number }} Decision with a machine-readable `reason`: `disabled`, `no-pin`, `no-fresh`, `interval`, `overlap`, or `reuse`.
 */
export function shouldReusePinnedBlock({ pinnedKeys = [], freshKeys = [], turnsSinceRefresh = 0, interval = 0, overlapThreshold = 0.5 } = {}) {
    if (!(Number(interval) > 0)) {
        return { reuse: false, reason: 'disabled', overlap: 0 };
    }
    if (!Array.isArray(pinnedKeys) || pinnedKeys.length === 0) {
        return { reuse: false, reason: 'no-pin', overlap: 0 };
    }
    if (!Array.isArray(freshKeys) || freshKeys.length === 0) {
        return { reuse: false, reason: 'no-fresh', overlap: 0 };
    }
    if (!(Number(turnsSinceRefresh) >= 0)) {
        turnsSinceRefresh = 0;
    }
    if (turnsSinceRefresh >= interval) {
        return { reuse: false, reason: 'interval', overlap: 0 };
    }
    const threshold = Math.min(1, Math.max(0, Number(overlapThreshold) || 0));
    const pinnedSet = new Set(pinnedKeys);
    const freshSet = new Set(freshKeys);
    let intersection = 0;
    for (const key of freshSet) {
        if (pinnedSet.has(key)) {
            intersection++;
        }
    }
    const union = pinnedSet.size + freshSet.size - intersection;
    const overlap = union === 0 ? 0 : intersection / union;
    if (overlap < threshold) {
        return { reuse: false, reason: 'overlap', overlap };
    }
    return { reuse: true, reason: 'reuse', overlap };
}

/**
 * Merges in-chat file blocks into the Data Bank static-zone prompt text.
 * The merged block lives in the system prefix (IN_PROMPT by default), ahead
 * of chat history, so file context no longer mutates `message.mes` in place
 * (which invalidated the shared prefix on every turn).
 *
 * Limitation: per-message attribution is lost; chunks from all messages share
 * one prefix-stable block. The template callback is applied only when there is
 * no previous Data Bank prompt; otherwise raw blocks are appended to avoid a
 * duplicated header.
 *
 * TODO: introduce a dedicated extension prompt tag for in-chat files (instead
 * of merging into the Data Bank slot) with its own template/position/depth/
 * role settings, once migration of existing user data is handled.
 * @param {object} options Merge options.
 * @param {string} [options.previousDbPrompt] Current Data Bank prompt value, if any.
 * @param {string[]} options.fileBlocks Retrieved file text blocks.
 * @param {(text: string) => string} [options.formatBlock] Applies the injection template to the joined blocks. Falls back to identity (raw blocks) with an `onFallback` warning when omitted.
 * @param {(message: string) => void} [options.onFallback] Optional warning sink invoked when the `formatBlock` fallback engages. Injected (rather than calling `console` directly) to keep this module dependency-free and the warning testable under Node.
 * @returns {string} Merged prompt text, or an empty string when there are no blocks.
 */
export function mergeFileBlocksIntoDbPrompt({ previousDbPrompt = '', fileBlocks = [], formatBlock, onFallback } = {}) {
    const uniqueBlocks = [...new Set(fileBlocks.filter(Boolean))];
    if (uniqueBlocks.length === 0) {
        return '';
    }
    const fileBlockText = uniqueBlocks.join('\n\n');
    if (previousDbPrompt) {
        return `${previousDbPrompt}\n\n${fileBlockText}`;
    }
    if (typeof formatBlock !== 'function') {
        onFallback?.('mergeFileBlocksIntoDbPrompt: formatBlock omitted with empty previousDbPrompt; using raw blocks');
        return fileBlockText;
    }
    return formatBlock(fileBlockText);
}

/**
 * Heuristic importance scorer for smart pruning. DOM-free so it can be unit tested.
 * Higher score = more important = evicted later.
 */

/**
 * Score a single chat-completion message.
 * @param {object} message Chat message ({role, content, tool_calls})
 * @param {number} index Index in the chat array
 * @param {number} total Total number of messages
 * @param {object} [flags] Importance flags resolved from the ST chat ({important, pinned, hasAttachment})
 * @returns {number} Importance score
 */
export function scoreMessage(message, index, total, flags = {}) {
    const safeTotal = Math.max(1, Number(total) || 1);
    const position = Number(index) / safeTotal;
    let score = 100 + position * 40;

    const role = message?.role;
    if (role === 'system') {
        score += 30;
    } else if (role === 'tool') {
        score += 25;
    } else if (role === 'user') {
        score += 5;
    }

    if (message?.tool_calls) {
        score += 50;
    }

    const content = typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
            ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
            : '';
    const length = content.length;
    if (length > 0 && length < 20 && role !== 'system') {
        score -= 15;
    }
    if (length > 2000) {
        score -= 10;
    }

    if (flags.important) {
        score += 60;
    }
    if (flags.pinned) {
        score += 60;
    }
    if (flags.hasAttachment) {
        score += 25;
    }

    return score;
}

/**
 * Words appearing in more than this fraction of texts are treated as
 * corpus-wide filler (catchphrases, repeated markers) and dropped.
 */
export const KEYWORD_CONCENTRATION_CAP = 0.5;

/**
 * Extract naive keywords from evicted messages for the compaction stub.
 * Counts each word once per message (document frequency), so a single
 * long or repetitive message cannot dominate the stub. Words spread
 * across most messages are dropped as filler; ties break toward the
 * word introduced earliest, since facts are established early.
 * @param {string[]} texts Evicted message texts
 * @param {number} [limit] Maximum number of keywords
 * @returns {string[]} Keywords
 */
export function extractKeywords(texts, limit = 6) {
    const counts = new Map();
    const firstSeen = new Map();
    const stopWords = new Set(['the', 'and', 'that', 'with', 'this', 'have', 'from', 'were', 'been', 'they', 'them', 'then', 'than', 'when', 'what', 'your', 'about', 'into', 'just', 'like', 'you', 'are', 'was', 'for', 'not', 'but', 'all', 'can', 'had', 'her', 'his', 'she', 'him', 'has', 'will', 'would', 'there', 'their']);
    const total = Array.isArray(texts) ? texts.length : 0;
    (Array.isArray(texts) ? texts : []).forEach((text, index) => {
        const words = new Set(String(text || '').toLowerCase().match(/[a-z]{5,}/g) || []);
        for (const word of words) {
            if (stopWords.has(word)) {
                continue;
            }
            counts.set(word, (counts.get(word) || 0) + 1);
            if (!firstSeen.has(word)) {
                firstSeen.set(word, index);
            }
        }
    });
    const cap = Math.max(1, Math.floor(total * KEYWORD_CONCENTRATION_CAP));
    return [...counts.entries()]
        .filter(([, count]) => count <= cap)
        .sort((a, b) => (b[1] - a[1]) || (firstSeen.get(a[0]) - firstSeen.get(b[0])))
        .slice(0, Math.max(1, limit))
        .map(entry => entry[0]);
}

/**
 * Normalize message content to plain text, identically to the token counters
 * in gate.js / index.js: strings as-is, arrays joined from part.text.
 * @param {object} message Chat message ({role, content, name})
 * @returns {string} Normalized text
 */
export function normalizeMessageText(message) {
    const content = message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return '';
}

/**
 * Build a djb2 content hash used to recognize evicted messages across generations.
 * Includes role, name, and the occurrence index among identical messages so
 * duplicates hash distinctly and cached evictions remove exactly the planned
 * count instead of every identical message. Old hashes (without name and
 * occurrence) never match: a single refire replans and rewrites the cache.
 * @param {object} message Chat message ({role, content, name})
 * @param {number} [occurrence] Zero-based index among identical messages in the chat
 * @returns {string} Hash string
 */
export function hashMessage(message, occurrence = 0) {
    const input = `${message?.role ?? ''}:${message?.name ?? ''}:${normalizeMessageText(message)}:${Number(occurrence) || 0}`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
    }
    return `h${hash.toString(36)}`;
}

/**
 * Hash a whole chat array with per-index duplicate disambiguation.
 * The occurrence counts are append-stable: messages appended at the end never
 * renumber existing ones. Both planPrune and applyCachedEvictions must use
 * this helper so planning and filtering always agree.
 * @param {Array<object>} chat Chat-completion messages
 * @returns {string[]} Disambiguated hash per index
 */
export function hashChatMessages(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const seen = new Map();
    return messages.map(message => {
        const base = `${message?.role ?? ''}:${message?.name ?? ''}:${normalizeMessageText(message)}`;
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        return hashMessage(message, occurrence);
    });
}

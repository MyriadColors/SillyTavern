/**
 * Importance-flag resolution for smart pruning. DOM-free so it can be unit tested.
 *
 * Prompt messages are aligned against ST chat messages with ordered, stable
 * matching: the k-th identical prompt message pairs with the k-th identical
 * ST message (first match wins only per remaining queue, never globally), so
 * flags on repeated openers land on the right message. The 120-char prefix
 * comparison survives only as a truncation fallback over unconsumed messages,
 * and non-string prompt content (e.g. multimodal arrays) is skipped explicitly.
 */

const PREFIX_FALLBACK_LENGTH = 120;

/**
 * Get the plain text of an ST chat message.
 * @param {object} mes ST chat message
 * @returns {string} Message text (empty when absent)
 */
function getStText(mes) {
    return typeof mes?.mes === 'string' ? mes.mes : '';
}

/**
 * Strip a leading "Name: " speaker prefix added by names_behavior DEFAULT/CONTENT.
 * @param {string} content Prompt message content
 * @param {string} name Prompt message name field
 * @returns {string} Content without the speaker prefix
 */
function stripNamePrefix(content, name) {
    if (typeof name === 'string' && name.length > 0 && content.startsWith(`${name}: `)) {
        return content.slice(name.length + 2);
    }
    return content;
}

/**
 * Extract importance flags from a matched ST message.
 * @param {object} stMessage ST chat message
 * @returns {object|null} Flags entry, or null when the message carries none
 */
function extractFlags(stMessage) {
    const entry = {};
    if (stMessage?.extra?.isImportant) {
        entry.important = true;
    }
    if (stMessage?.pinned || stMessage?.is_pinned) {
        entry.pinned = true;
    }
    const extra = stMessage?.extra;
    if (extra?.image || extra?.images || extra?.attachments || extra?.file) {
        entry.hasAttachment = true;
    }
    return Object.keys(entry).length > 0 ? entry : null;
}

/**
 * Claim one ST index from a per-text queue, preferring the same speaker side.
 * @param {number[]} queue Unconsumed ST indexes with identical text, in order
 * @param {Array<object>} stChat ST chat messages
 * @param {boolean|null} preferUser True for user side, false for assistant side, null for no preference
 * @returns {number} Claimed ST index
 */
function claimIndex(queue, stChat, preferUser) {
    if (preferUser === null) {
        return queue.shift();
    }
    const position = queue.findIndex(stIndex => Boolean(stChat[stIndex]?.is_user) === preferUser);
    if (position === -1) {
        return queue.shift();
    }
    return queue.splice(position, 1)[0];
}

/**
 * Resolve importance flags for each prompt message by matching ST chat content.
 * @param {Array<object>} chat Chat-completion messages
 * @param {Array<object>} stChat ST chat messages
 * @returns {Map<number, object>} Flags per prompt index
 */
export function resolveFlags(chat, stChat) {
    const flags = new Map();
    if (!Array.isArray(chat) || !Array.isArray(stChat) || stChat.length === 0) {
        return flags;
    }
    const queues = new Map();
    stChat.forEach((mes, stIndex) => {
        const text = getStText(mes);
        if (!text) {
            return;
        }
        if (!queues.has(text)) {
            queues.set(text, []);
        }
        queues.get(text).push(stIndex);
    });
    const consumed = new Set();

    chat.forEach((message, index) => {
        if (typeof message?.content !== 'string' || message.content.length === 0) {
            return;
        }
        const bare = stripNamePrefix(message.content, message?.name);
        const role = message?.role;
        const preferUser = role === 'user' ? true : role === 'assistant' ? false : null;

        let stIndex = -1;
        const queue = queues.get(bare);
        if (queue && queue.length > 0) {
            stIndex = claimIndex(queue, stChat, preferUser);
            consumed.add(stIndex);
        } else {
            const prefix = bare.slice(0, PREFIX_FALLBACK_LENGTH);
            for (let candidate = 0; candidate < stChat.length; candidate++) {
                if (consumed.has(candidate)) {
                    continue;
                }
                const text = getStText(stChat[candidate]);
                if (!text || text.slice(0, PREFIX_FALLBACK_LENGTH) !== prefix) {
                    continue;
                }
                const candidateQueue = queues.get(text);
                if (candidateQueue) {
                    const position = candidateQueue.indexOf(candidate);
                    if (position !== -1) {
                        candidateQueue.splice(position, 1);
                    }
                }
                consumed.add(candidate);
                stIndex = candidate;
                break;
            }
        }

        if (stIndex === -1) {
            return;
        }
        const entry = extractFlags(stChat[stIndex]);
        if (entry) {
            flags.set(index, entry);
        }
    });
    return flags;
}

/**
 * Cache helpers for compaction state. Kept separate so chatMetadata handling is testable in one place.
 */

export const METADATA_KEY = 'context_compaction';

/**
 * Read compaction state for the current chat.
 * @param {object} chatMetadata chat_metadata object from context
 * @returns {object} Compaction state
 */
export function readState(chatMetadata) {
    const state = chatMetadata?.[METADATA_KEY];
    return {
        evictedHashes: Array.isArray(state?.evictedHashes) ? state.evictedHashes : [],
        stub: typeof state?.stub === 'string' ? state.stub : '',
        lastFiredAtTokens: Number(state?.lastFiredAtTokens) || 0,
        turnsSinceCompaction: Number(state?.turnsSinceCompaction ?? 0),
        tokenSaved: Number(state?.tokenSaved) || 0,
        lastChatLength: Number(state?.lastChatLength) || 0,
        // Absent in states written before force support: default disarmed.
        forceArmed: state?.forceArmed === true,
    };
}

/**
 * Write compaction state for the current chat.
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 * @param {object} state Compaction state to store
 */
export function writeState(chatMetadata, state) {
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        return;
    }
    chatMetadata[METADATA_KEY] = {
        evictedHashes: Array.isArray(state?.evictedHashes) ? state.evictedHashes : [],
        stub: typeof state?.stub === 'string' ? state.stub : '',
        lastFiredAtTokens: Number(state?.lastFiredAtTokens) || 0,
        turnsSinceCompaction: Number(state?.turnsSinceCompaction ?? 0),
        tokenSaved: Number(state?.tokenSaved) || 0,
        lastChatLength: Number(state?.lastChatLength) || 0,
        forceArmed: state?.forceArmed === true,
    };
}

/**
 * Consume the one-shot force flag: disarm it and report whether it was armed.
 * Pruner protections are untouched; only the gate verdict is bypassed once.
 * @param {object} chatMetadata chat_metadata object from context (mutated when armed)
 * @returns {boolean} True if force was armed (now disarmed)
 */
export function consumeForceArmed(chatMetadata) {
    const state = readState(chatMetadata);
    if (!state.forceArmed) {
        return false;
    }
    writeState(chatMetadata, { ...state, forceArmed: false });
    return true;
}

/**
 * Reset the turn counter while keeping the eviction list (used by the turn counter).
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 * @param {number} turnsSinceCompaction Updated counter value
 */
export function setTurnsSince(chatMetadata, turnsSinceCompaction) {
    const state = readState(chatMetadata);
    state.turnsSinceCompaction = Number(turnsSinceCompaction) || 0;
    writeState(chatMetadata, state);
}

/**
 * Revalidate cached evictions against the current chat length.
 * Any edit or delete shifts occurrence numbering, so cached hashes can no
 * longer be trusted: a shorter chat (or an explicit force after an edit)
 * drops the whole cache. Otherwise the length marker is refreshed.
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 * @param {number} chatLength Current ST chat length
 * @param {boolean} [force] True when the chat was edited without shrinking
 * @returns {boolean} True when cached evictions were dropped
 */
export function revalidateState(chatMetadata, chatLength, force = false) {
    const state = readState(chatMetadata);
    if (state.evictedHashes.length === 0) {
        // Never-compacted chats stay metadata-free; only refresh the marker
        // when a state entry already exists.
        if (chatMetadata?.[METADATA_KEY]) {
            touchChatLength(chatMetadata, chatLength);
        }
        return false;
    }
    if (force === true || Number(chatLength) < state.lastChatLength) {
        clearState(chatMetadata);
        return true;
    }
    touchChatLength(chatMetadata, chatLength);
    return false;
}

/**
 * Refresh the chat-length staleness marker without touching evictions.
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 * @param {number} chatLength Current ST chat length
 */
export function touchChatLength(chatMetadata, chatLength) {
    const length = Number(chatLength) || 0;
    const state = readState(chatMetadata);
    if (state.lastChatLength === length) {
        return;
    }
    state.lastChatLength = length;
    writeState(chatMetadata, state);
}

/**
 * Clear compaction state for the current chat (used by /compact clear and chat change).
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 */
export function clearState(chatMetadata) {
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        return;
    }
    delete chatMetadata[METADATA_KEY];
}

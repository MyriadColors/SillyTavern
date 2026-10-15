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
 * Clear compaction state for the current chat (used by /compact clear and chat change).
 * @param {object} chatMetadata chat_metadata object from context (mutated)
 */
export function clearState(chatMetadata) {
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        return;
    }
    delete chatMetadata[METADATA_KEY];
}

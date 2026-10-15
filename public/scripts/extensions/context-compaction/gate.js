/**
 * Pure trigger-gate logic for context compaction. DOM-free so it can be unit tested.
 */

export const TRIGGER_MODES = {
    THRESHOLD: 'threshold',
    EVERY_N: 'every_n',
    EITHER: 'either',
};

export const THRESHOLD_MODES = {
    PERCENT: 'percent',
    ABSOLUTE: 'absolute',
};

export const BYTES_PER_TOKEN_FALLBACK = 3.35;
export const HYSTERESIS_RATIO = 0.1;

/**
 * Fast character-based token estimate used by the gate (no tokenizer call).
 * @param {string} text Text to estimate
 * @returns {number} Estimated token count
 */
export function estimateTokensChars(text) {
    if (!text) {
        return 0;
    }
    return Math.max(1, Math.ceil(String(text).length / BYTES_PER_TOKEN_FALLBACK));
}

/**
 * Estimate tokens for a chat-completion style message array using char fallback.
 * @param {Array<{content?: any}>} chat Messages to estimate
 * @returns {number} Estimated token count
 */
export function estimateChatTokens(chat) {
    if (!Array.isArray(chat)) {
        return 0;
    }
    let total = 0;
    for (const message of chat) {
        const content = typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
                ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
                : '';
        total += estimateTokensChars(content) + 4;
    }
    return total;
}

/**
 * Resolve the absolute token threshold from settings.
 * @param {object} settings Extension settings
 * @param {number} maxContext Current max context size
 * @returns {number} Absolute token threshold, clamped to maxContext
 */
export function resolveThreshold(settings, maxContext) {
    const max = Number(maxContext) || 0;
    if (max <= 0) {
        return 0;
    }
    let threshold = 0;
    if (settings?.thresholdMode === THRESHOLD_MODES.ABSOLUTE) {
        threshold = Number(settings?.thresholdTokens) || 0;
    } else {
        const percent = Number(settings?.thresholdPercent ?? 80);
        threshold = Math.round((max * percent) / 100);
    }
    if (threshold <= 0) {
        return 0;
    }
    return Math.min(threshold, max);
}

/**
 * Resolve the prune target in accurate-tokenizer units from the char-estimate gate.
 *
 * Unit-unification choice: the gate stays on the fast char estimate (hot path,
 * plus a +4/message overhead that countChatTokens lacks), while pruning works
 * from accurate per-message tokenizer counts. To keep the two in agreement, the
 * estimated overshoot above 0.95x threshold is converted into accurate units
 * via the estimate-to-accurate ratio, i.e. target = 0.95 * threshold * ratio.
 * When the estimate undercounts (ratio >= 1) this reduces to the plain
 * 0.95 * threshold real-token goal via the min() clamp.
 * @param {object} args Resolution inputs
 * @param {number} args.estTokens Gate char-estimate total (gate unit)
 * @param {number} args.accurateTotal Sum of accurate per-message counts (prune unit)
 * @param {number} args.thresholdTokens Resolved absolute threshold (real-token unit)
 * @returns {number} Prune target in accurate-tokenizer units
 */
export function resolvePruneTarget({ estTokens, accurateTotal, thresholdTokens }) {
    const threshold = Number(thresholdTokens) || 0;
    const plain = Math.max(1, Math.round(threshold * 0.95));
    const est = Number(estTokens) || 0;
    const accurate = Number(accurateTotal) || 0;
    if (threshold <= 0 || est <= 0 || accurate <= 0) {
        return plain;
    }
    const scaled = Math.max(1, Math.round(threshold * 0.95 * (accurate / est)));
    return Math.min(plain, scaled);
}

/**
 * Check the cooldown (minimum turns between compactions).
 * @param {number} turnsSinceCompaction Turns since last compaction
 * @param {number} cooldownN Minimum turns required
 * @returns {boolean} True if cooldown has elapsed
 */
export function isCooldownOk(turnsSinceCompaction, cooldownN) {
    const cooldown = Number(cooldownN ?? 3);
    if (!(cooldown > 0)) {
        return true;
    }
    return Number(turnsSinceCompaction ?? 0) >= cooldown;
}

/**
 * Decide whether compaction should run now, honoring the one-shot force flag.
 * Force bypasses the gate (any trigger mode, below threshold, in cooldown) for
 * exactly one generation; pruner protections still apply downstream.
 * @param {object} args Gate inputs (see shouldFire) plus force flag
 * @param {boolean} args.forced True when a one-shot force was armed
 * @param {number} args.estTokens Estimated prompt tokens
 * @param {number} args.thresholdTokens Resolved absolute threshold (0 = disabled)
 * @param {number} args.lastFiredAtTokens Token level when compaction last fired (hysteresis)
 * @param {number} args.turnsSinceCompaction Turns since last compaction
 * @param {object} args.settings Extension settings
 * @returns {{fire: boolean, reason: string}} Gate decision
 */
export function decideFire({ forced, estTokens, thresholdTokens, lastFiredAtTokens, turnsSinceCompaction, settings }) {
    if (forced === true) {
        return { fire: true, reason: 'force' };
    }
    return shouldFire({ estTokens, thresholdTokens, lastFiredAtTokens, turnsSinceCompaction, settings });
}

/**
 * Decide whether compaction should run now.
 * @param {object} args Gate inputs
 * @param {number} args.estTokens Estimated prompt tokens
 * @param {number} args.thresholdTokens Resolved absolute threshold (0 = disabled)
 * @param {number} args.lastFiredAtTokens Token level when compaction last fired (hysteresis)
 * @param {number} args.turnsSinceCompaction Turns since last compaction
 * @param {object} args.settings Extension settings
 * @returns {{fire: boolean, reason: string}} Gate decision
 */
export function shouldFire({ estTokens, thresholdTokens, lastFiredAtTokens, turnsSinceCompaction, settings }) {
    const mode = settings?.triggerMode ?? TRIGGER_MODES.EITHER;
    const threshold = Number(thresholdTokens) || 0;
    const est = Number(estTokens) || 0;
    const turns = Number(turnsSinceCompaction ?? 0);
    const everyN = Number(settings?.everyN ?? 10);
    const checkThreshold = mode === TRIGGER_MODES.THRESHOLD || mode === TRIGGER_MODES.EITHER;
    const checkEveryN = mode === TRIGGER_MODES.EVERY_N || mode === TRIGGER_MODES.EITHER;

    if (!isCooldownOk(turns, settings?.cooldownN)) {
        return { fire: false, reason: 'cooldown' };
    }

    if (checkThreshold && threshold > 0 && est >= threshold) {
        const lastFired = Number(lastFiredAtTokens) || 0;
        const floor = Math.round(threshold * (1 - HYSTERESIS_RATIO));
        if (lastFired > 0 && est < lastFired && est < floor) {
            return { fire: false, reason: 'hysteresis' };
        }
        return { fire: true, reason: 'threshold' };
    }

    if (checkEveryN && everyN > 0 && turns >= everyN) {
        return { fire: true, reason: 'every_n' };
    }

    return { fire: false, reason: 'no_trigger' };
}

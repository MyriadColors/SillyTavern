import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../slash-commands/SlashCommandArgument.js';
import {
    TRIGGER_MODES,
    THRESHOLD_MODES,
    decideFire,
    estimateChatTokens,
    resolvePruneTarget,
    resolveThreshold,
    shouldFire,
} from './gate.js';
import { applyCachedEvictions, planPrune } from './pruner.js';
import { clearState, consumeForceArmed, readState, setTurnsSince, writeState } from './cache.js';

export const MODULE_NAME = 'context_compaction';

/** Folder name on disk (used for template/CSS loading). Must match the directory. */
const EXTENSION_FOLDER = 'context-compaction';

const defaultSettings = {
    enabled: true,
    triggerMode: TRIGGER_MODES.EITHER,
    thresholdMode: THRESHOLD_MODES.PERCENT,
    thresholdTokens: 6000,
    thresholdPercent: 80,
    everyN: 10,
    cooldownN: 3,
    preserveN: 10,
    aggressiveness: 'balanced',
    showBadge: true,
};

let statusText = '';

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    const settings = getSettings();
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
}

/**
 * Count tokens per message, falling back to char estimates on failure.
 * @param {Array<object>} chat Chat-completion messages
 * @returns {Promise<number[]>} Per-message token counts
 */
async function countChatTokens(chat) {
    const counts = [];
    for (const message of chat) {
        const content = typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
                ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
                : '';
        try {
            counts.push(await getTokenCountAsync(content));
        } catch {
            counts.push(Math.max(1, Math.ceil(String(content).length / 3.35)));
        }
    }
    return counts;
}

/**
 * Resolve importance flags for each prompt message by matching ST chat content.
 * @param {Array<object>} chat Chat-completion messages
 * @param {Array<object>} stChat ST chat messages
 * @returns {Map<number, object>} Flags per prompt index
 */
function resolveFlags(chat, stChat) {
    const flags = new Map();
    if (!Array.isArray(stChat) || stChat.length === 0) {
        return flags;
    }
    const byText = new Map();
    for (const mes of stChat) {
        if (typeof mes?.mes === 'string' && mes.mes.length > 0) {
            const key = mes.mes.slice(0, 120);
            if (!byText.has(key)) {
                byText.set(key, mes);
            }
        }
    }
    chat.forEach((message, index) => {
        const content = typeof message?.content === 'string' ? message.content : '';
        if (!content) {
            return;
        }
        const stMessage = byText.get(content.slice(0, 120));
        if (!stMessage) {
            return;
        }
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
        if (Object.keys(entry).length > 0) {
            flags.set(index, entry);
        }
    });
    return flags;
}

function renderStatus() {
    const element = $('#compaction_status');
    if (element.length > 0) {
        element.text(statusText);
    }
}

/**
 * Handle the prompt-ready event: gate, prune on trigger, otherwise re-apply cache.
 * @param {object} eventData Event payload ({chat, dryRun})
 */
async function onPromptReady(eventData) {
    try {
        const settings = getSettings();
        if (!settings.enabled) {
            return;
        }
        if (!eventData || !Array.isArray(eventData.chat) || eventData.chat.length === 0) {
            return;
        }
        const context = getContext();
        const maxContext = Number(context?.maxContext) || 0;
        if (maxContext <= 0) {
            return;
        }

        const state = readState(context.chatMetadata);
        const estTokens = estimateChatTokens(eventData.chat);
        const thresholdTokens = resolveThreshold(settings, maxContext);
        // One-shot force: peek for dry runs, consume (disarm) on real generations.
        // Pruner protections below are untouched; only this gate verdict is bypassed.
        const forced = state.forceArmed === true;
        const gateArgs = {
            estTokens,
            thresholdTokens,
            lastFiredAtTokens: state.lastFiredAtTokens,
            turnsSinceCompaction: state.turnsSinceCompaction,
            settings,
        };

        if (eventData.dryRun) {
            const preview = decideFire({ forced, ...gateArgs });
            statusText = preview.fire
                ? `Would compact (${preview.reason}): ~${estTokens} est. / ${thresholdTokens} tokens.`
                : `No compaction needed: ~${estTokens} est. / ${thresholdTokens} tokens.`;
            renderStatus();
            return;
        }

        if (forced) {
            consumeForceArmed(context.chatMetadata);
            if (typeof context.saveMetadataDebounced === 'function') {
                context.saveMetadataDebounced();
            }
        }
        const decision = decideFire({ forced, ...gateArgs });

        if (!decision.fire) {
            if (state.evictedHashes.length > 0) {
                const filtered = applyCachedEvictions(eventData.chat, state.evictedHashes, state.stub);
                eventData.chat.length = 0;
                eventData.chat.push(...filtered);
            }
            statusText = state.evictedHashes.length > 0
                ? `Compacted earlier: ${state.evictedHashes.length} msgs pruned, ~${estTokens} est. tokens.`
                : `No compaction: ~${estTokens} est. / ${thresholdTokens} tokens.`;
            renderStatus();
            return;
        }

        const tokenCounts = await countChatTokens(eventData.chat);
        const accurateTotal = tokenCounts.reduce((sum, count) => sum + (Number(count) || 0), 0);
        const targetTokens = resolvePruneTarget({ estTokens, accurateTotal, thresholdTokens });
        const plan = planPrune(eventData.chat, {
            tokenCounts,
            targetTokens,
            preserveN: settings.preserveN,
            flagsByIndex: resolveFlags(eventData.chat, context.chat),
            aggressiveness: settings.aggressiveness,
        });

        if (plan.evictedIndexes.length === 0) {
            statusText = `Trigger fired (${decision.reason}) but nothing safe to prune.`;
            renderStatus();
            return;
        }

        const filtered = applyCachedEvictions(eventData.chat, plan.evictedHashes, plan.stub);
        eventData.chat.length = 0;
        eventData.chat.push(...filtered);

        writeState(context.chatMetadata, {
            evictedHashes: plan.evictedHashes,
            stub: plan.stub,
            lastFiredAtTokens: estTokens,
            turnsSinceCompaction: 0,
            tokenSaved: plan.savedTokens,
            lastChatLength: Array.isArray(context.chat) ? context.chat.length : 0,
            forceArmed: false,
        });
        if (typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
        }

        statusText = `Compacted ${plan.evictedIndexes.length} msgs (~${plan.savedTokens} tokens) via ${decision.reason}.`;
        renderStatus();
        if (settings.showBadge) {
            console.log(`[context-compaction] ${statusText} hashes: ${plan.evictedHashes.slice(0, 3).join(',')}${plan.evictedHashes.length > 3 ? '…' : ''}`);
        }
    } catch (error) {
        console.warn('[context-compaction] prompt hook failed, leaving chat untouched.', error);
    }
}

function bumpTurnCounter() {
    try {
        const context = getContext();
        if (!context?.chatMetadata) {
            return;
        }
        // One turn = one full player->NPC cycle: bump only on the NPC reply.
        const state = readState(context.chatMetadata);
        setTurnsSince(context.chatMetadata, state.turnsSinceCompaction + 1);
        if (typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
        }
    } catch (error) {
        console.debug('[context-compaction] turn counter bump failed.', error);
    }
}

function onChatChanged() {
    statusText = '';
    renderStatus();
}

/**
 * Arm a one-shot forced compaction for the next generation (any trigger mode).
 * The flag is consumed on the next real generation; pruner protections
 * (index 0, preserveN, tool chain, flags) still apply.
 * @returns {string} Status message
 */
function forceCompact() {
    try {
        const context = getContext();
        if (!context?.chatMetadata) {
            toastr.info('No active chat.', 'Context Compaction');
            return 'No active chat.';
        }
        const state = readState(context.chatMetadata);
        writeState(context.chatMetadata, { ...state, forceArmed: true });
        if (typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
        }
        statusText = 'Compaction forced for the next generation (one-shot, all modes).';
        renderStatus();
        toastr.success(statusText, 'Context Compaction');
        console.debug('[context-compaction] force armed.');
        return statusText;
    } catch (error) {
        console.warn('[context-compaction] force failed.', error);
        toastr.error('Failed to force compaction.', 'Context Compaction');
        return 'Failed to force compaction.';
    }
}

/**
 * Clear cached evictions for the current chat.
 * @returns {string} Status message
 */
function clearCompact() {
    try {
        const context = getContext();
        if (context?.chatMetadata) {
            clearState(context.chatMetadata);
            if (typeof context.saveMetadataDebounced === 'function') {
                context.saveMetadataDebounced();
            }
        }
        statusText = 'Compaction cache cleared.';
        renderStatus();
        toastr.success(statusText, 'Context Compaction');
        console.debug('[context-compaction] cache cleared.');
        return statusText;
    } catch (error) {
        console.warn('[context-compaction] clear failed.', error);
        toastr.error('Failed to clear compaction cache.', 'Context Compaction');
        return 'Failed to clear compaction cache.';
    }
}

/**
 * Count the whole ST chat as a single string via the real tokenizer.
 * One server round-trip (cached per chat); falls back to char estimates.
 * @param {Array<object>} stChat ST chat messages
 * @returns {Promise<{tokens: number, accurate: boolean}>} Total and source
 */
async function countChatAccurate(stChat) {
    const fallback = estimateChatTokens(stChat.map(mes => ({ content: mes?.mes })));
    const fullText = stChat.map(mes => (typeof mes?.mes === 'string' ? mes.mes : '')).join('\n');
    if (!fullText) {
        return { tokens: 0, accurate: true };
    }
    try {
        const tokens = await Promise.race([
            getTokenCountAsync(fullText),
            new Promise((_, reject) => setTimeout(() => reject(new Error('tokenizer timeout')), 10000)),
        ]);
        if (Number(tokens) > 0) {
            return { tokens: Number(tokens), accurate: true };
        }
    } catch (error) {
        console.debug('[context-compaction] accurate count failed, using char estimate.', error);
    }
    return { tokens: fallback, accurate: false };
}

/**
 * Build a detailed multi-line status report: settings, live context estimate,
 * gate verdict, turn counters, cache contents, and last action.
 * @returns {Promise<{text: string, html: string}>} Plain-text and toast HTML versions
 */
async function buildStatusReport() {
    const settings = getSettings();
    const context = getContext();
    const lines = [];
    lines.push(`Enabled: ${settings.enabled ? 'yes' : 'no'} · trigger: ${settings.triggerMode} · keep last: ${settings.preserveN} · ${settings.aggressiveness}`);

    const maxContext = Number(context?.maxContext) || 0;
    const stChat = Array.isArray(context?.chat) ? context.chat : [];
    const state = context?.chatMetadata ? readState(context.chatMetadata) : null;

    if (stChat.length === 0 || maxContext <= 0) {
        lines.push('No active chat or context size unknown — gate verdict unavailable.');
    } else {
        const gateEst = estimateChatTokens(stChat.map(mes => ({ content: typeof mes?.mes === 'string' ? mes.mes : '' })));
        const { tokens: accurateTokens, accurate } = await countChatAccurate(stChat);
        const accurateLabel = accurate ? 'tokenizer' : 'char-estimate fallback';
        const thresholdTokens = resolveThreshold(settings, maxContext);
        const percent = Math.round((gateEst / maxContext) * 100);
        const thresholdLabel = settings.thresholdMode === THRESHOLD_MODES.ABSOLUTE
            ? `${thresholdTokens} tokens`
            : `${settings.thresholdPercent}% (~${thresholdTokens} tokens)`;
        lines.push(`Context: ~${gateEst} tokens char estimate (gate unit, ${percent}% of ${maxContext} max) · tokenizer: ~${accurateTokens} tokens (${accurateLabel}) · threshold: ${thresholdLabel}`);

        const turns = Number(state?.turnsSinceCompaction ?? 0);
        const everyN = Number(settings.everyN) || 0;
        const cooldownN = Number(settings.cooldownN) || 0;
        lines.push(`Turns since compaction: ${turns} (every ${everyN}, cooldown ${cooldownN})`);

        if (!settings.enabled) {
            lines.push('Gate: OFF (extension disabled).');
        } else {
            const decision = shouldFire({
                estTokens: gateEst,
                thresholdTokens,
                lastFiredAtTokens: state?.lastFiredAtTokens,
                turnsSinceCompaction: turns,
                settings,
            });
            if (decision.fire) {
                lines.push(`Gate: READY — would compact via ${decision.reason} on next generation.`);
            } else if (decision.reason === 'cooldown') {
                lines.push(`Gate: cooling down (${turns}/${cooldownN} turns elapsed).`);
            } else if (decision.reason === 'hysteresis') {
                lines.push(`Gate: holding (below re-fire floor after last compaction at ~${state?.lastFiredAtTokens} est. tokens).`);
            } else {
                const gaps = [];
                if (thresholdTokens > 0 && gateEst < thresholdTokens) {
                    gaps.push(`~${thresholdTokens - gateEst} more tokens (char estimate)`);
                }
                if (everyN > 0 && turns < everyN) {
                    gaps.push(`${everyN - turns} more turns`);
                }
                lines.push(`Gate: idle — needs ${gaps.length > 0 ? gaps.join(' or ') : 'a trigger'} (char estimate, ±10%).`);
            }
        }
    }

    if (state?.evictedHashes?.length) {
        lines.push(`Cache: ${state.evictedHashes.length} msgs pruned, ~${state.tokenSaved} tokenizer tokens saved (fired at ~${state.lastFiredAtTokens} est. tokens).`);
    } else {
        lines.push('Cache: empty — nothing pruned yet.');
    }

    if (statusText) {
        lines.push(`Last: ${statusText}`);
    }

    return { text: lines.join('\n'), html: lines.map(escapeHtmlLine).join('<br>') };
}

/**
 * Escape a single status line for toast HTML.
 * @param {string} line Plain-text line
 * @returns {string} Escaped line
 */
function escapeHtmlLine(line) {
    return String(line)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function compactCallback(args) {
    const action = String(args?.action || '').toLowerCase();
    if (action === 'clear') {
        return clearCompact();
    }
    if (action === 'force') {
        return forceCompact();
    }
    if (action === 'status' || action === '') {
        const report = await buildStatusReport();
        toastr.info(report.html, 'Context Compaction');
        const context = getContext();
        console.debug('[context-compaction] status requested.', context?.chatMetadata ? readState(context.chatMetadata) : null);
        return report.text;
    }
    const unknown = `Unknown /ctx-compact action: ${action}. Use force, clear, or status.`;
    toastr.warning(unknown, 'Context Compaction');
    return unknown;
}

function setupListeners() {
    $('#compaction_enabled').off('input').on('input', function () {
        getSettings().enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });
    $('#compaction_trigger_mode').off('change').on('change', function () {
        getSettings().triggerMode = String($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_threshold_mode').off('change').on('change', function () {
        getSettings().thresholdMode = String($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_threshold_tokens').off('input').on('input', function () {
        getSettings().thresholdTokens = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_threshold_percent').off('input').on('input', function () {
        getSettings().thresholdPercent = Number($(this).val());
        $('#compaction_threshold_percent_value').text(`${getSettings().thresholdPercent}%`);
        saveSettingsDebounced();
    });
    $('#compaction_every_n').off('input').on('input', function () {
        getSettings().everyN = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_cooldown_n').off('input').on('input', function () {
        getSettings().cooldownN = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_preserve_n').off('input').on('input', function () {
        getSettings().preserveN = Number($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_aggressiveness').off('change').on('change', function () {
        getSettings().aggressiveness = String($(this).val());
        saveSettingsDebounced();
    });
    $('#compaction_show_badge').off('input').on('input', function () {
        getSettings().showBadge = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });
    $('#compaction_force').off('click').on('click', () => forceCompact());
    $('#compaction_clear').off('click').on('click', () => clearCompact());
}

function syncSettingsUI() {
    const settings = getSettings();
    $('#compaction_enabled').prop('checked', Boolean(settings.enabled));
    $('#compaction_trigger_mode').val(String(settings.triggerMode));
    $('#compaction_threshold_mode').val(String(settings.thresholdMode));
    $('#compaction_threshold_tokens').val(Number(settings.thresholdTokens));
    $('#compaction_threshold_percent').val(Number(settings.thresholdPercent));
    $('#compaction_threshold_percent_value').text(`${settings.thresholdPercent}%`);
    $('#compaction_every_n').val(Number(settings.everyN));
    $('#compaction_cooldown_n').val(Number(settings.cooldownN));
    $('#compaction_preserve_n').val(Number(settings.preserveN));
    $('#compaction_aggressiveness').val(String(settings.aggressiveness));
    $('#compaction_show_badge').prop('checked', Boolean(settings.showBadge));
}

export async function init() {
    loadSettings();
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', { defaultSettings });
    if ($('#compaction_container').length > 0) {
        $('#compaction_container').append(settingsHtml);
    } else {
        $('#extensions_settings2').append(settingsHtml);
    }
    setupListeners();
    syncSettingsUI();
    renderStatus();

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    // One bump per NPC reply = one full player->NPC cycle per turn.
    eventSource.on(event_types.MESSAGE_RECEIVED, bumpTurnCounter);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctx-compact',
        callback: compactCallback,
        unnamedArgumentList: [
            new SlashCommandArgument('action: force, clear, or status', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Manage context compaction. Actions: force (compact on the next generation only, in any trigger mode), clear (drop cached evictions), status (show gate state).',
        returns: 'compaction status text',
    }));
}

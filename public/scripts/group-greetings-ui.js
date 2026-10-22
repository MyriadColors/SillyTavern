import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { buildDefaultGreetingEntries, group_greeting_mode, group_greeting_source } from './group-greetings.js';

/**
 * @typedef {object} GroupGreetingPickerMember
 * @property {string} avatar Avatar ID
 * @property {string} name Character name
 * @property {boolean} [disabled] Whether the member is muted
 * @property {{source: string, index: number, text: string}[]} candidates Available greetings
 */

/**
 * Returns the select value for a picker entry.
 * @param {{source: string, index?: number}} entry Entry
 * @returns {string} Select value
 */
function toSelectValue(entry) {
    if (entry.source === group_greeting_source.RANDOM || entry.source === group_greeting_source.NONE) {
        return entry.source;
    }

    return `${entry.source}:${entry.index ?? 0}`;
}

/**
 * Parses a picker select value into a greeting entry.
 * @param {string} avatar Avatar ID
 * @param {string} value Select value
 * @returns {{avatar: string, source: string, index?: number}} Entry
 */
function fromSelectValue(avatar, value) {
    if (value === group_greeting_source.RANDOM || value === group_greeting_source.NONE) {
        return { avatar, source: value };
    }

    const [source, rawIndex] = value.split(':');
    return { avatar, source, index: Number(rawIndex) || 0 };
}

/**
 * Builds the greeting label for a character greeting.
 * @param {{source: string, index: number}} candidate Greeting candidate
 * @returns {string} Human-readable label
 */
function getCandidateLabel(candidate) {
    if (candidate.source === group_greeting_source.GROUP_ONLY) {
        return t`Group-only greeting ${candidate.index + 1}`;
    }

    if (candidate.source === group_greeting_source.ALTERNATE) {
        return t`Alternate greeting ${candidate.index + 1}`;
    }

    return t`Greeting 1`;
}

/**
 * Shows the group greeting picker for a new chat.
 * @param {object} options Options
 * @param {GroupGreetingPickerMember[]} options.members Group members
 * @param {number} [options.mode] Group greeting mode used for defaults
 * @returns {Promise<{avatar: string, source: string, index?: number}[]>} Picked entries
 */
export async function showGroupGreetingPicker({ members, mode = group_greeting_mode.ALL_ENABLED }) {
    const container = document.createElement('div');
    container.classList.add('group_greeting_picker');

    const heading = document.createElement('h3');
    heading.textContent = t`Choose greetings`;
    container.appendChild(heading);

    const hint = document.createElement('div');
    hint.classList.add('notes');
    hint.textContent = t`Pick who greets when this chat starts. Muted members stay silent.`;
    container.appendChild(hint);

    const quickControls = document.createElement('div');
    quickControls.classList.add('group_greeting_quick_controls', 'flex-container', 'flexGap5');

    const quickButtons = [
        { label: t`All`, mode: group_greeting_mode.ALL_ENABLED },
        { label: t`First`, mode: group_greeting_mode.FIRST_ONLY },
        { label: t`Random subset`, mode: group_greeting_mode.RANDOM_SUBSET },
        { label: t`None`, mode: group_greeting_mode.NONE },
    ];

    for (const quick of quickButtons) {
        const button = document.createElement('div');
        button.classList.add('menu_button', 'menu_button_icon');
        button.textContent = quick.label;
        button.dataset.mode = String(quick.mode);
        quickControls.appendChild(button);
    }

    container.appendChild(quickControls);

    const list = document.createElement('div');
    list.classList.add('group_greeting_list');
    container.appendChild(list);

    /** @type {Map<string, HTMLSelectElement>} */
    const selects = new Map();

    for (const member of members) {
        const row = document.createElement('div');
        row.classList.add('group_greeting_row', 'flex-container', 'alignitemscenter', 'flexGap10');

        if (member.disabled) {
            row.classList.add('group_greeting_row_disabled');
        }

        const name = document.createElement('div');
        name.classList.add('group_greeting_name', 'flex1');
        name.textContent = member.name;
        row.appendChild(name);

        const select = document.createElement('select');
        select.classList.add('text_pole', 'group_greeting_select');
        select.dataset.avatar = member.avatar;

        const randomOption = document.createElement('option');
        randomOption.value = group_greeting_source.RANDOM;
        randomOption.textContent = t`Random`;
        select.appendChild(randomOption);

        const noneOption = document.createElement('option');
        noneOption.value = group_greeting_source.NONE;
        noneOption.textContent = t`No greeting`;
        select.appendChild(noneOption);

        for (const candidate of member.candidates) {
            const option = document.createElement('option');
            option.value = toSelectValue(candidate);
            option.textContent = getCandidateLabel(candidate);
            select.appendChild(option);
        }

        if (member.disabled) {
            select.value = group_greeting_source.NONE;
            select.disabled = true;
            row.title = t`This member is muted and will not greet.`;
        } else {
            select.value = group_greeting_source.RANDOM;
        }

        row.appendChild(select);
        selects.set(member.avatar, select);
        list.appendChild(row);
    }

    /**
     * Applies a mode preset to every enabled member.
     * @param {number} presetMode Greeting mode
     */
    function applyPreset(presetMode) {
        const enabledMembers = members.filter(member => !member.disabled).map(member => member.avatar);
        const defaults = buildDefaultGreetingEntries({
            members: enabledMembers,
            mode: presetMode,
        });
        const defaultAvatars = new Set(defaults.map(entry => entry.avatar));

        for (const member of members) {
            const select = selects.get(member.avatar);

            if (!select || member.disabled) {
                continue;
            }

            select.value = defaultAvatars.has(member.avatar) ? group_greeting_source.RANDOM : group_greeting_source.NONE;
        }
    }

    quickControls.addEventListener('click', event => {
        const button = event.target.closest('.menu_button');

        if (!button) {
            return;
        }

        applyPreset(Number(button.dataset.mode));
    });

    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Start chat`,
        cancelButton: t`Use defaults`,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });

    if (!result) {
        return buildDefaultGreetingEntries({
            members: members.filter(member => !member.disabled).map(member => member.avatar),
            mode,
        });
    }

    const entries = [];

    for (const member of members) {
        const select = selects.get(member.avatar);

        if (!select) {
            continue;
        }

        entries.push(fromSelectValue(member.avatar, select.value));
    }

    return entries;
}

/**
 * Greeting handling modes for group chats.
 */
export const group_greeting_mode = {
    ALL_ENABLED: 0,
    FIRST_ONLY: 1,
    NONE: 2,
    RANDOM_SUBSET: 3,
};

export const group_greeting_source = {
    FIRST: 'first',
    ALTERNATE: 'alternate',
    GROUP_ONLY: 'group',
    RANDOM: 'random',
    NONE: 'none',
};

/**
 * Returns the group-only greetings for a character, if the card defines any.
 * @param {object} character Character object
 * @returns {string[]} Group-only greetings
 */
export function getGroupOnlyGreetings(character) {
    const dataGreetings = character?.data?.group_only_greetings;
    const rootGreetings = character?.group_only_greetings;

    if (Array.isArray(dataGreetings) && dataGreetings.length > 0) {
        return dataGreetings.filter(greeting => greeting);
    }

    if (Array.isArray(rootGreetings) && rootGreetings.length > 0) {
        return rootGreetings.filter(greeting => greeting);
    }

    return [];
}

/**
 * Lists every greeting a character can use in a group chat, in display order.
 * @param {object} character Character object
 * @returns {{source: string, index: number, text: string}[]} Greeting candidates
 */
export function getGreetingCandidates(character) {
    if (!character) {
        return [];
    }

    const candidates = [];
    const groupOnlyGreetings = getGroupOnlyGreetings(character);

    if (groupOnlyGreetings.length > 0) {
        groupOnlyGreetings.forEach((text, index) => {
            candidates.push({ source: group_greeting_source.GROUP_ONLY, index, text });
        });
        return candidates;
    }

    if (character.first_mes) {
        candidates.push({ source: group_greeting_source.FIRST, index: 0, text: character.first_mes });
    }

    const alternateGreetings = character.data?.alternate_greetings;

    if (Array.isArray(alternateGreetings)) {
        alternateGreetings.filter(text => text).forEach((text, index) => {
            candidates.push({ source: group_greeting_source.ALTERNATE, index, text });
        });
    }

    return candidates;
}

/**
 * Resolves a picker entry into a concrete greeting for a character.
 * Falls back to the stored text when the referenced greeting no longer exists.
 * @param {object} character Character object
 * @param {{source?: string, index?: number, text?: string}|null|undefined} entry Picker entry
 * @param {() => number} [random] Random function returning [0, 1)
 * @returns {{source: string, index: number, text: string}|null} Concrete greeting or null
 */
export function resolveGreetingEntry(character, entry, random = Math.random) {
    if (!entry || entry.source === group_greeting_source.NONE) {
        return null;
    }

    const candidates = getGreetingCandidates(character);

    if (entry.source === group_greeting_source.RANDOM && candidates.length > 0) {
        const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
        return candidates[index];
    }

    const normalizedIndex = Number(entry.index ?? 0);
    const match = candidates.find(candidate => candidate.source === entry.source && candidate.index === normalizedIndex);

    if (match) {
        return match;
    }

    if (entry.text) {
        return {
            source: entry.source ?? group_greeting_source.FIRST,
            index: normalizedIndex,
            text: entry.text,
        };
    }

    return null;
}

/**
 * Builds a default picker entry set for a group greeting mode.
 * @param {object} options Options
 * @param {string[]} [options.members] Group member avatar IDs
 * @param {string[]} [options.disabledMembers] Avatar IDs of muted members
 * @param {number} [options.mode] One of {@link group_greeting_mode}
 * @param {() => number} [options.random] Random function returning [0, 1)
 * @returns {{avatar: string, source: string}[]} Default picker entries
 */
export function buildDefaultGreetingEntries({
    members = [],
    disabledMembers = [],
    mode = group_greeting_mode.ALL_ENABLED,
    random = Math.random,
} = {}) {
    return selectGreetingMembers({ members, disabledMembers, mode, random }).map(avatar => ({
        avatar,
        source: group_greeting_source.RANDOM,
    }));
}

/**
 * Picks which group members should greet when a chat starts.
 *
 * Muted members are never selected, regardless of the mode.
 *
 * @param {object} options Options
 * @param {string[]} [options.members] Group member avatar IDs in display order
 * @param {string[]} [options.disabledMembers] Avatar IDs of muted members
 * @param {number} [options.mode] One of {@link group_greeting_mode}
 * @param {() => number} [options.random] Random function returning [0, 1)
 * @returns {string[]} Avatar IDs that should greet, in display order
 */
export function selectGreetingMembers({
    members = [],
    disabledMembers = [],
    mode = group_greeting_mode.ALL_ENABLED,
    random = Math.random,
} = {}) {
    const disabled = new Set(Array.isArray(disabledMembers) ? disabledMembers : []);
    const enabled = (Array.isArray(members) ? members : []).filter(member => !disabled.has(member));
    const normalizedMode = Number(mode);

    switch (normalizedMode) {
        case group_greeting_mode.FIRST_ONLY:
            return enabled.slice(0, 1);
        case group_greeting_mode.NONE:
            return [];
        case group_greeting_mode.RANDOM_SUBSET: {
            if (!enabled.length) {
                return [];
            }

            const picked = enabled.filter(() => random() < 0.5);

            if (picked.length) {
                return picked;
            }

            const index = Math.min(enabled.length - 1, Math.floor(random() * enabled.length));
            return [enabled[index]];
        }
        case group_greeting_mode.ALL_ENABLED:
        default:
            return enabled;
    }
}

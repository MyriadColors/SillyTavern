import { describe, test, expect } from '@jest/globals';
import {
    buildDefaultGreetingEntries,
    getGreetingCandidates,
    group_greeting_mode,
    group_greeting_source,
    resolveGreetingEntry,
    selectGreetingMembers,
} from '../public/scripts/group-greetings.js';

describe('selectGreetingMembers', () => {
    const members = ['alice.png', 'bob.png', 'carol.png'];

    test('all enabled members greet by default', () => {
        expect(selectGreetingMembers({ members })).toEqual(members);
    });

    test('muted members never greet', () => {
        const result = selectGreetingMembers({
            members,
            disabledMembers: ['bob.png'],
        });

        expect(result).toEqual(['alice.png', 'carol.png']);
    });

    test('first member only skips muted members', () => {
        const result = selectGreetingMembers({
            members,
            disabledMembers: ['alice.png'],
            mode: group_greeting_mode.FIRST_ONLY,
        });

        expect(result).toEqual(['bob.png']);
    });

    test('none returns no greeters', () => {
        const result = selectGreetingMembers({
            members,
            mode: group_greeting_mode.NONE,
        });

        expect(result).toEqual([]);
    });

    test('random subset keeps member order', () => {
        const randomValues = [0.1, 0.9, 0.2];
        let index = 0;
        const random = () => randomValues[index++];

        const result = selectGreetingMembers({
            members,
            mode: group_greeting_mode.RANDOM_SUBSET,
            random,
        });

        expect(result).toEqual(['alice.png', 'carol.png']);
    });

    test('random subset always picks at least one enabled member', () => {
        const result = selectGreetingMembers({
            members,
            mode: group_greeting_mode.RANDOM_SUBSET,
            random: () => 1,
        });

        expect(result).toHaveLength(1);
        expect(members).toContain(result[0]);
    });

    test('random subset with no enabled members returns empty', () => {
        const result = selectGreetingMembers({
            members,
            disabledMembers: members,
            mode: group_greeting_mode.RANDOM_SUBSET,
        });

        expect(result).toEqual([]);
    });

    test('handles missing member lists', () => {
        expect(selectGreetingMembers()).toEqual([]);
        expect(selectGreetingMembers({ mode: group_greeting_mode.NONE })).toEqual([]);
    });
});

describe('getGreetingCandidates', () => {
    test('lists the first message and alternate greetings', () => {
        const character = {
            first_mes: 'Hello',
            data: { alternate_greetings: ['Hi', '', 'Hey'] },
        };

        expect(getGreetingCandidates(character)).toEqual([
            { source: group_greeting_source.FIRST, index: 0, text: 'Hello' },
            { source: group_greeting_source.ALTERNATE, index: 0, text: 'Hi' },
            { source: group_greeting_source.ALTERNATE, index: 1, text: 'Hey' },
        ]);
    });

    test('prefers group-only greetings when present', () => {
        const character = {
            first_mes: 'Hello',
            data: { group_only_greetings: ['Group hello'], alternate_greetings: ['Hi'] },
        };

        expect(getGreetingCandidates(character)).toEqual([
            { source: group_greeting_source.GROUP_ONLY, index: 0, text: 'Group hello' },
        ]);
    });

    test('falls back to the root group_only_greetings field', () => {
        const character = {
            first_mes: 'Hello',
            group_only_greetings: ['Root hello'],
            data: {},
        };

        expect(getGreetingCandidates(character)).toEqual([
            { source: group_greeting_source.GROUP_ONLY, index: 0, text: 'Root hello' },
        ]);
    });

    test('handles empty characters', () => {
        expect(getGreetingCandidates()).toEqual([]);
        expect(getGreetingCandidates({})).toEqual([]);
    });
});

describe('resolveGreetingEntry', () => {
    const character = {
        first_mes: 'Hello',
        data: { alternate_greetings: ['Hi'] },
    };

    test('resolves an explicit candidate', () => {
        expect(resolveGreetingEntry(character, {
            source: group_greeting_source.ALTERNATE,
            index: 0,
        })).toEqual({ source: group_greeting_source.ALTERNATE, index: 0, text: 'Hi' });
    });

    test('resolves random to a concrete candidate', () => {
        const result = resolveGreetingEntry(character, { source: group_greeting_source.RANDOM }, () => 0.9);

        expect(result).toEqual({ source: group_greeting_source.ALTERNATE, index: 0, text: 'Hi' });
    });

    test('returns null for no greeting', () => {
        expect(resolveGreetingEntry(character, { source: group_greeting_source.NONE })).toBeNull();
    });

    test('falls back to stored text when the candidate is gone', () => {
        expect(resolveGreetingEntry(character, {
            source: group_greeting_source.ALTERNATE,
            index: 5,
            text: 'Old greeting',
        })).toEqual({ source: group_greeting_source.ALTERNATE, index: 5, text: 'Old greeting' });
    });

    test('returns null when neither candidate nor text exist', () => {
        expect(resolveGreetingEntry(character, { source: group_greeting_source.ALTERNATE, index: 5 })).toBeNull();
    });
});

describe('buildDefaultGreetingEntries', () => {
    const members = ['alice.png', 'bob.png', 'carol.png'];

    test('marks every enabled member as random', () => {
        expect(buildDefaultGreetingEntries({ members })).toEqual([
            { avatar: 'alice.png', source: group_greeting_source.RANDOM },
            { avatar: 'bob.png', source: group_greeting_source.RANDOM },
            { avatar: 'carol.png', source: group_greeting_source.RANDOM },
        ]);
    });

    test('first mode selects one enabled member', () => {
        expect(buildDefaultGreetingEntries({
            members,
            disabledMembers: ['alice.png'],
            mode: group_greeting_mode.FIRST_ONLY,
        })).toEqual([
            { avatar: 'bob.png', source: group_greeting_source.RANDOM },
        ]);
    });

    test('none mode selects nobody', () => {
        expect(buildDefaultGreetingEntries({
            members,
            mode: group_greeting_mode.NONE,
        })).toEqual([]);
    });
});

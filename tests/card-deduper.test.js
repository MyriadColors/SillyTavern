import { describe, test, expect, jest, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    tryParse: (str) => { try { return JSON.parse(str); } catch { return undefined; } },
    color: { red: str => str, yellow: str => str, green: str => str },
    uuidv4: () => '1234-5678-90ab',
    humanizedDateTime: () => '2026-08-15',
    sanitize: str => str,
}));

jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    this_chid: undefined,
    getOneCharacter: jest.fn(),
    eventSource: { emit: jest.fn() },
    event_types: { CHARACTER_EDITED: 'character_edited', CHARACTER_DELETED: 'character_deleted' },
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn((_type, file) => `/thumbnail/${file}`),
    toastr: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() },
    default_avatar: 'default.png',
    printCharacters: jest.fn(),
    saveSettingsDebounced: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(() => Promise.resolve('<div></div>')),
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: { show: { confirm: jest.fn(), alert: jest.fn() } },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
    callGenericPopup: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => typeof strings === 'string' ? strings : strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    tag_map: {},
}));

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: [],
}));

let normalizeCharacterName;
let calculateContentHash;
let calculateSimilarityScore;
let CardDeduperManager;

beforeAll(async () => {
    const charsEndpoint = await import('../src/endpoints/characters.js');
    normalizeCharacterName = charsEndpoint.normalizeCharacterName;
    calculateContentHash = charsEndpoint.calculateContentHash;
    calculateSimilarityScore = charsEndpoint.calculateSimilarityScore;

    const deduperMod = await import('../public/scripts/card-deduper.js');
    CardDeduperManager = deduperMod.CardDeduperManager;
});

describe('normalizeCharacterName', () => {
    test('normalizes numbered suffixes', () => {
        expect(normalizeCharacterName('Alice 1')).toBe('alice');
        expect(normalizeCharacterName('Alice_2')).toBe('alice');
        expect(normalizeCharacterName('Alice (3)')).toBe('alice');
        expect(normalizeCharacterName('Alice-4')).toBe('alice');
        expect(normalizeCharacterName('Alice 1.png')).toBe('alice');
    });

    test('normalizes copy tags and version suffixes', () => {
        expect(normalizeCharacterName('Alice - Copy')).toBe('alice');
        expect(normalizeCharacterName('Alice - Copy 2')).toBe('alice');
        expect(normalizeCharacterName('Alice v2')).toBe('alice');
        expect(normalizeCharacterName('Alice - Version 1.0')).toBe('alice');
    });

    test('preserves distinct base names', () => {
        expect(normalizeCharacterName('Alice')).toBe('alice');
        expect(normalizeCharacterName('Alicia')).toBe('alicia');
        expect(normalizeCharacterName('Bob')).toBe('bob');
    });
});

describe('calculateContentHash', () => {
    test('produces identical hash for cards with identical definitions', () => {
        const cardA = {
            name: 'Alice',
            description: 'A cheerful adventurer.',
            personality: 'Brave, kind',
            scenario: 'In a medieval dungeon',
            first_mes: 'Let us proceed!',
            mes_example: 'Hello',
            system_prompt: 'You are Alice',
        };

        const cardB = {
            name: 'Alice (Updated Copy)',
            description: '  A cheerful adventurer.  ',
            personality: 'Brave, kind',
            scenario: 'In a medieval dungeon',
            first_mes: 'Let us proceed!',
            mes_example: 'Hello',
            system_prompt: 'You are Alice',
        };

        expect(calculateContentHash(cardA)).toBe(calculateContentHash(cardB));
    });

    test('produces different hash for modified definitions', () => {
        const cardA = {
            description: 'A cheerful adventurer.',
            personality: 'Brave, kind',
        };

        const cardB = {
            description: 'A grumpy warrior.',
            personality: 'Strict, harsh',
        };

        expect(calculateContentHash(cardA)).not.toBe(calculateContentHash(cardB));
    });
});

describe('calculateSimilarityScore', () => {
    test('returns 1.0 for exact matches', () => {
        const text = 'The brave knight traversed the enchanted forest in search of ancient relics.';
        expect(calculateSimilarityScore(text, text)).toBe(1.0);
    });

    test('returns high score for minor edits', () => {
        const textA = 'The brave knight traversed the enchanted forest in search of ancient relics.';
        const textB = 'The brave knight traveled across the enchanted forest in search of ancient relics.';
        const score = calculateSimilarityScore(textA, textB);
        expect(score).toBeGreaterThan(0.75);
    });

    test('returns low score for completely different text', () => {
        const textA = 'The brave knight traversed the enchanted forest in search of ancient relics.';
        const textB = 'Quantum computing leverages superposition and entanglement to execute probabilistic calculations.';
        const score = calculateSimilarityScore(textA, textB);
        expect(score).toBeLessThan(0.3);
    });
});

describe('CardDeduperManager settings and whitelist', () => {
    test('retrieves default settings with safe trash mode', () => {
        const settings = CardDeduperManager.getSettings();
        expect(settings.safeMode).toBe('trash');
        expect(settings.createBackup).toBe(true);
        expect(settings.migrateChats).toBe(true);
        expect(settings.matchTypes).toContain('name');
        expect(settings.matchTypes).toContain('hash');
    });

    test('manages ignored pairs without duplicates', () => {
        CardDeduperManager.clearIgnoredPairs();
        expect(CardDeduperManager.getIgnoredPairs()).toEqual([]);

        CardDeduperManager.addIgnoredPair('Alice.png', 'Alicia.png');
        CardDeduperManager.addIgnoredPair('Alicia.png', 'Alice.png'); // Reversed order

        const pairs = CardDeduperManager.getIgnoredPairs();
        expect(pairs.length).toBe(1);

        CardDeduperManager.clearIgnoredPairs();
        expect(CardDeduperManager.getIgnoredPairs()).toEqual([]);
    });
});

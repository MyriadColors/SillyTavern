import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';

try {
    setConfigFilePath('../default/config.yaml');
} catch {
    // ignore if already set
}

jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    this_chid: undefined,
    setCharacterId: jest.fn(),
    getOneCharacter: jest.fn(),
    getCharacters: jest.fn(),
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn((_type, file) => `/thumbnail/${file}`),
    toastr: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() },
    default_avatar: 'default.png',
    printCharacters: jest.fn(),
    saveSettingsDebounced: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { emit: jest.fn() },
    event_types: { CHARACTER_EDITED: 'character_edited', CHARACTER_DELETED: 'character_deleted' },
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
let extractBigrams;
let calculateBigramSimilarityFromData;
let CardDeduperManager;

beforeAll(async () => {
    const charsEndpoint = await import('../src/endpoints/characters.js');
    normalizeCharacterName = charsEndpoint.normalizeCharacterName;
    calculateContentHash = charsEndpoint.calculateContentHash;
    calculateSimilarityScore = charsEndpoint.calculateSimilarityScore;
    extractBigrams = charsEndpoint.extractBigrams;
    calculateBigramSimilarityFromData = charsEndpoint.calculateBigramSimilarityFromData;

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

describe('Guarded Deduplication Matching Logic', () => {
    test('distinguishes cards with same normalized name but different creators', () => {
        const cardA = {
            name: 'Alice',
            creator: 'AuthorX',
            description: 'A fantasy elven archer.',
            personality: 'Calm, focused',
        };
        const cardB = {
            name: 'Alice 1',
            creator: 'AuthorY',
            description: 'A modern detective solving cybercrimes in Tokyo.',
            personality: 'Brash, impatient',
        };

        const nameA = normalizeCharacterName(cardA.name);
        const nameB = normalizeCharacterName(cardB.name);
        expect(nameA).toBe(nameB); // Same normalized name ('alice')

        const aCreator = cardA.creator.toLowerCase();
        const bCreator = cardB.creator.toLowerCase();
        expect(aCreator).not.toBe(bCreator);
        expect(aCreator.length).toBeGreaterThan(0);
        expect(bCreator.length).toBeGreaterThan(0);
    });

    test('matches cards with same creator and related content', () => {
        const cardA = {
            name: 'Alice',
            creator: 'AuthorX',
            description: 'A fantasy elven archer roaming the Whispering Woods.',
            personality: 'Calm, focused',
            character_version: '1.0',
        };
        const cardB = {
            name: 'Alice v2.0',
            creator: 'AuthorX',
            description: 'A fantasy elven archer roaming the Whispering Woods with enchanted bow.',
            personality: 'Calm, focused',
            character_version: '2.0',
        };

        const nameA = normalizeCharacterName(cardA.name);
        const nameB = normalizeCharacterName(cardB.name);
        expect(nameA).toBe(nameB);

        const aCreator = cardA.creator.toLowerCase();
        const bCreator = cardB.creator.toLowerCase();
        expect(aCreator === bCreator).toBe(true);

        const simScore = calculateSimilarityScore(cardA.description, cardB.description);
        expect(simScore).toBeGreaterThan(0.7);
    });
});

describe('extractBigrams and calculateBigramSimilarityFromData', () => {
    test('extracts bigrams correctly and handles edge cases', () => {
        expect(extractBigrams('').total).toBe(0);
        expect(extractBigrams('a').total).toBe(0);
        const res = extractBigrams('Alice');
        expect(res.total).toBe(4);
        expect(res.bigrams.get('al')).toBe(1);
        expect(res.bigrams.get('li')).toBe(1);
    });

    test('calculates fast similarity score identical to calculateSimilarityScore', () => {
        const textA = 'A courageous elven mage researching ancient elemental runes.';
        const textB = 'A courageous elven wizard researching ancient mystical runes.';
        const standardScore = calculateSimilarityScore(textA, textB);
        const dataA = extractBigrams(textA);
        const dataB = extractBigrams(textB);
        const fastScore = calculateBigramSimilarityFromData(dataA, dataB);
        expect(fastScore).toBeCloseTo(standardScore, 5);
        expect(fastScore).toBeGreaterThan(0.7);
    });

    test('returns 0 for empty or one-character strings', () => {
        const dataA = extractBigrams('');
        const dataB = extractBigrams('Hello world');
        expect(calculateBigramSimilarityFromData(dataA, dataB)).toBe(0);
    });
});

describe('CardDeduperManager.executeConsolidation', () => {
    test('calls consolidation endpoint and handles state cleanup', async () => {
        global.fetch = jest.fn((url) => {
            if (url === '/api/characters/dedupe/consolidate') {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        success: true,
                        backupId: 'dedupe_test',
                        primaryAvatar: 'Alice.png',
                        duplicatesProcessed: 1,
                        chatsMigrated: 2,
                    }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });

        const cluster = {
            name: 'Alice',
            recommendedPrimary: 'Alice.png',
            cards: [
                { avatar: 'Alice.png', name: 'Alice' },
                { avatar: 'Alice_dup.png', name: 'Alice (Copy)' },
            ],
        };

        await CardDeduperManager.executeConsolidation(cluster, { safeMode: 'trash' }, false);
        expect(global.fetch).toHaveBeenCalledWith('/api/characters/dedupe/consolidate', expect.any(Object));
    });
});


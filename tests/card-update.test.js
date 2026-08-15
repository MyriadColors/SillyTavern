import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { TavernCardValidator } from '../src/validator/TavernCardValidator';

jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    this_chid: undefined,
    getOneCharacter: jest.fn(),
    eventSource: { emit: jest.fn() },
    event_types: { CHARACTER_EDITED: 'character_edited', MESSAGE_RECEIVED: 'message_received', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered' },
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn((_type, file) => `/thumbnail/${file}`),
    toastr: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
    default_avatar: 'default.png',
    chat: [],
    chat_metadata: {},
    getFirstMessage: jest.fn(() => ({ mes: 'Hello' })),
    clearChat: jest.fn(),
    printMessages: jest.fn(),
    saveChatConditional: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(() => Promise.resolve('<div></div>')),
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: { show: { confirm: jest.fn(), input: jest.fn() } },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002 },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 },
    callGenericPopup: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => typeof strings === 'string' ? strings : strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    importTags: jest.fn(),
}));

let CardUpdateManager;

beforeAll(async () => {
    const mod = await import('../public/scripts/card-update.js');
    CardUpdateManager = mod.CardUpdateManager;
});

function makeBaseCharacter() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Alice',
        description: 'Original description',
        personality: 'Kind, gentle',
        scenario: 'In a fantasy village',
        first_mes: 'Hello there!',
        mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello!',
        creatorcomment: 'Original creator notes',
        creator: 'OriginalCreator',
        character_version: '1.0',
        tags: ['friendly', 'fantasy'],
        fav: true,
        talkativeness: 0.7,
        create_date: '2024-01-01T00:00:00.000Z',
        chat: 'Alice - 2024-01-01 @00h 00m 00s',
        avatar: 'Alice.png',
        data: {
            name: 'Alice',
            description: 'Original description',
            personality: 'Kind, gentle',
            scenario: 'In a fantasy village',
            first_mes: 'Hello there!',
            mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello!',
            creator_notes: 'Original creator notes',
            system_prompt: 'You are Alice.',
            post_history_instructions: 'Keep responses short.',
            alternate_greetings: ['Good morning!', 'Greetings, traveler.'],
            tags: ['friendly', 'fantasy'],
            creator: 'OriginalCreator',
            character_version: '1.0',
            character_book: {
                name: 'Alice Lorebook',
                extensions: {},
                entries: [
                    { id: 1, keys: ['village'], comment: 'Village details', content: 'A peaceful village.', enabled: true },
                    { id: 2, keys: ['magic'], comment: 'Magic system', content: 'Basic elemental magic.', enabled: true },
                ],
            },
            extensions: {
                fav: true,
                talkativeness: 0.7,
                world: 'FantasyRealm',
                depth_prompt: { depth: 4, prompt: 'Think carefully.', role: 'system' },
                regex_scripts: [
                    { id: 'script-1', scriptName: 'Custom Script 1', findRegex: '/foo/', replaceString: 'bar' },
                ],
            },
        },
    };
}

function makeIncomingCard() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: 'Alice (Updated)',
            description: 'Updated description with more lore',
            personality: 'Kind, thoughtful, adventurous',
            scenario: 'In a magical kingdom',
            first_mes: 'Hello there, traveler!',
            mes_example: '<START>\n{{user}}: Hi\n{{char}}: Welcome to our kingdom!',
            creator_notes: 'v2.0 rework with new lore',
            system_prompt: 'You are Alice the adventurer.',
            post_history_instructions: 'Respond in third person.',
            alternate_greetings: ['Good morning!', 'Welcome to the royal court!'],
            tags: ['fantasy', 'magic', 'adventure'],
            creator: 'UpdatedCreator',
            character_version: '2.0',
            character_book: {
                name: 'Alice Lorebook v2',
                extensions: {},
                entries: [
                    { id: 1, keys: ['village'], comment: 'Village details', content: 'A bustling fantasy kingdom village.', enabled: true },
                    { id: 3, keys: ['castle'], comment: 'Royal Castle', content: 'The majestic castle.', enabled: true },
                ],
            },
            extensions: {
                talkativeness: 0.5,
                regex_scripts: [
                    { id: 'script-2', scriptName: 'Card Script 2', findRegex: '/baz/', replaceString: 'qux' },
                ],
            },
        },
    };
}

describe('CardUpdateManager.mergeCardData', () => {
    test('updates core definitions while preserving user settings', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'keep',
            characterBookMode: 'keep',
            regexScriptsMode: 'keep',
            tagsMode: 'keep',
            preserveSettings: true,
        });

        // Core definition updates
        expect(merged.name).toBe('Alice (Updated)');
        expect(merged.data.name).toBe('Alice (Updated)');
        expect(merged.description).toBe('Updated description with more lore');
        expect(merged.data.personality).toBe('Kind, thoughtful, adventurous');
        expect(merged.data.scenario).toBe('In a magical kingdom');
        expect(merged.data.creator_notes).toBe('v2.0 rework with new lore');
        expect(merged.data.character_version).toBe('2.0');
        expect(merged.first_mes).toBe('Hello there, traveler!');
        expect(merged.data.system_prompt).toBe('You are Alice the adventurer.');

        // User settings preserved
        expect(merged.fav).toBe(true);
        expect(merged.data.extensions.fav).toBe(true);
        expect(merged.talkativeness).toBe(0.7);
        expect(merged.data.extensions.talkativeness).toBe(0.7);
        expect(merged.data.extensions.world).toBe('FantasyRealm');
        expect(merged.data.extensions.depth_prompt.prompt).toBe('Think carefully.');
        expect(merged.create_date).toBe('2024-01-01T00:00:00.000Z');
        expect(merged.chat).toBe('Alice - 2024-01-01 @00h 00m 00s');

        // Validates as V1/V2
        const v = new TavernCardValidator(merged);
        expect(v.validate()).toBeTruthy();
        expect(v.validateV2()).toBe(true);
    });

    test('merges alternate greetings by appending non-duplicate entries', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'merge',
            characterBookMode: 'keep',
            regexScriptsMode: 'keep',
            tagsMode: 'keep',
            preserveSettings: true,
        });

        // 'Good morning!' was in both, 'Greetings, traveler.' was in existing, 'Welcome to the royal court!' was in incoming
        expect(merged.data.alternate_greetings).toEqual([
            'Good morning!',
            'Greetings, traveler.',
            'Welcome to the royal court!',
        ]);
    });

    test('replaces alternate greetings when mode is replace', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'replace',
            characterBookMode: 'keep',
            regexScriptsMode: 'keep',
            tagsMode: 'keep',
            preserveSettings: true,
        });

        expect(merged.data.alternate_greetings).toEqual([
            'Good morning!',
            'Welcome to the royal court!',
        ]);
    });

    test('merges embedded character book entries smartly', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'keep',
            characterBookMode: 'merge',
            regexScriptsMode: 'keep',
            tagsMode: 'keep',
            preserveSettings: true,
        });

        const entries = merged.data.character_book.entries;
        expect(entries.length).toBe(3);

        // Entry 1 (village) was updated with new content
        const villageEntry = entries.find(e => e.keys.includes('village'));
        expect(villageEntry.content).toBe('A bustling fantasy kingdom village.');

        // Entry 2 (magic) was preserved from existing
        const magicEntry = entries.find(e => e.keys.includes('magic'));
        expect(magicEntry.content).toBe('Basic elemental magic.');

        // Entry 3 (castle) was added from incoming
        const castleEntry = entries.find(e => e.keys.includes('castle'));
        expect(castleEntry.content).toBe('The majestic castle.');
    });

    test('merges regex scripts preserving user custom scripts', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'keep',
            characterBookMode: 'keep',
            regexScriptsMode: 'merge',
            tagsMode: 'keep',
            preserveSettings: true,
        });

        const scripts = merged.data.extensions.regex_scripts;
        expect(scripts.length).toBe(2);
        expect(scripts.some(s => s.scriptName === 'Custom Script 1')).toBe(true);
        expect(scripts.some(s => s.scriptName === 'Card Script 2')).toBe(true);
    });

    test('merges tags by union without duplicates', () => {
        const existing = makeBaseCharacter();
        const incoming = makeIncomingCard();

        const merged = CardUpdateManager.mergeCardData(existing, incoming, {
            updateDefinitions: true,
            updateFirstMes: true,
            updateMesExample: true,
            updateSystemPrompt: true,
            alternateGreetingsMode: 'keep',
            characterBookMode: 'keep',
            regexScriptsMode: 'keep',
            tagsMode: 'merge',
            preserveSettings: true,
        });

        expect(merged.data.tags).toEqual(['friendly', 'fantasy', 'magic', 'adventure']);
    });
});

import { describe, test, expect } from '@jest/globals';
import { TavernCardValidator } from '../src/validator/TavernCardValidator';

const V1_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

const V2_DATA_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
    'alternate_greetings', 'tags', 'creator', 'character_version', 'extensions',
];

function makeV1Card() {
    return Object.fromEntries(V1_FIELDS.map(f => [f, '']));
}

function makeV2Card() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            ...Object.fromEntries(V2_DATA_FIELDS.map(f => [f, ''])),
            alternate_greetings: [],
            tags: [],
            extensions: {},
        },
    };
}

function makeV3Card() {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {},
    };
}

describe('TavernCardValidator', () => {
    describe('validate', () => {
        test('returns 1 for valid V1 card', () => {
            const v = new TavernCardValidator(makeV1Card());
            expect(v.validate()).toBe(1);
        });

        test('returns 2 for valid V2 card', () => {
            const v = new TavernCardValidator(makeV2Card());
            expect(v.validate()).toBe(2);
        });

        test('returns 3 for valid V3 card', () => {
            const v = new TavernCardValidator(makeV3Card());
            expect(v.validate()).toBe(3);
        });

        test('returns false for empty object', () => {
            const v = new TavernCardValidator({});
            expect(v.validate()).toBe(false);
        });

        test('prefers V2 when card satisfies both V1 and V2', () => {
            const card = { ...makeV1Card(), ...makeV2Card() };
            const v = new TavernCardValidator(card);
            expect(v.validate()).toBe(2);
        });

        test('prefers V3 when card satisfies V1, V2, and V3', () => {
            const card = { ...makeV1Card(), ...makeV2Card(), ...makeV3Card() };
            const v = new TavernCardValidator(card);
            expect(v.validate()).toBe(3);
        });
    });

    describe('validateV1', () => {
        test('accepts card with all required fields', () => {
            const v = new TavernCardValidator(makeV1Card());
            expect(v.validateV1()).toBe(true);
        });

        for (const field of V1_FIELDS) {
            test(`rejects card missing ${field}`, () => {
                const card = makeV1Card();
                delete card[field];
                const v = new TavernCardValidator(card);
                expect(v.validateV1()).toBe(false);
                expect(v.lastValidationError).toBe(field);
            });
        }
    });

    describe('validateV2', () => {
        test('accepts valid V2 card', () => {
            const v = new TavernCardValidator(makeV2Card());
            expect(v.validateV2()).toBe(true);
        });

        test('rejects wrong spec string', () => {
            const card = makeV2Card();
            card.spec = 'chara_card_v1';
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
            expect(v.lastValidationError).toBe('spec');
        });

        test('rejects wrong spec_version', () => {
            const card = makeV2Card();
            card.spec_version = '1.0';
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
            expect(v.lastValidationError).toBe('spec_version');
        });

        test('rejects missing data', () => {
            const card = makeV2Card();
            delete card.data;
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });

        for (const field of V2_DATA_FIELDS) {
            test(`rejects card missing data.${field}`, () => {
                const card = makeV2Card();
                delete card.data[field];
                const v = new TavernCardValidator(card);
                expect(v.validateV2()).toBe(false);
                expect(v.lastValidationError).toBe(`data.${field}`);
            });
        }

        test('rejects non-array alternate_greetings', () => {
            const card = makeV2Card();
            card.data.alternate_greetings = 'not an array';
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });

        test('rejects non-array tags', () => {
            const card = makeV2Card();
            card.data.tags = 'not an array';
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });

        test('rejects non-object extensions', () => {
            const card = makeV2Card();
            card.data.extensions = 'not an object';
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });

        test('accepts card with optional character_book', () => {
            const card = makeV2Card();
            card.data.character_book = {
                extensions: {},
                entries: [],
            };
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(true);
        });

        test('rejects character_book missing entries', () => {
            const card = makeV2Card();
            card.data.character_book = { extensions: {} };
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
            expect(v.lastValidationError).toBe('data.character_book.entries');
        });

        test('rejects character_book missing extensions', () => {
            const card = makeV2Card();
            card.data.character_book = { entries: [] };
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
            expect(v.lastValidationError).toBe('data.character_book.extensions');
        });

        test('rejects character_book with non-array entries', () => {
            const card = makeV2Card();
            card.data.character_book = { extensions: {}, entries: 'not array' };
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });

        test('rejects character_book with non-object extensions', () => {
            const card = makeV2Card();
            card.data.character_book = { extensions: 'not object', entries: [] };
            const v = new TavernCardValidator(card);
            expect(v.validateV2()).toBe(false);
        });
    });

    describe('validateV3', () => {
        test('accepts valid V3 card', () => {
            const v = new TavernCardValidator(makeV3Card());
            expect(v.validateV3()).toBe(true);
        });

        test('rejects wrong spec string', () => {
            const card = makeV3Card();
            card.spec = 'chara_card_v2';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('spec');
        });

        test('rejects spec_version below 3.0', () => {
            const card = makeV3Card();
            card.spec_version = '2.9';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('spec_version');
        });

        test('rejects spec_version at or above 4.0', () => {
            const card = makeV3Card();
            card.spec_version = '4.0';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
        });

        test('accepts spec_version 3.5', () => {
            const card = makeV3Card();
            card.spec_version = '3.5';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(true);
        });

        test('rejects missing data', () => {
            const card = makeV3Card();
            delete card.data;
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
        });

        test('rejects non-object data', () => {
            const card = makeV3Card();
            card.data = 'not an object';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
        });

        test('rejects non-array alternate_greetings in V3', () => {
            const card = makeV3Card();
            card.data.alternate_greetings = 'string';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('data.alternate_greetings');
        });

        test('rejects non-array group_only_greetings in V3', () => {
            const card = makeV3Card();
            card.data.group_only_greetings = 'string';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('data.group_only_greetings');
        });

        test('rejects non-array tags in V3', () => {
            const card = makeV3Card();
            card.data.tags = 'string';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('data.tags');
        });

        test('rejects non-array assets in V3', () => {
            const card = makeV3Card();
            card.data.assets = 'string';
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(false);
            expect(v.lastValidationError).toBe('data.assets');
        });

        test('accepts valid CCv3 card with all fields', () => {
            const card = makeV3Card();
            card.data = {
                name: 'Test Character',
                nickname: 'Tester',
                description: 'A test character',
                personality: 'Friendly',
                scenario: 'In a test room',
                first_mes: 'Hello!',
                mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
                creator_notes: 'Some notes',
                creator_notes_multilingual: { en: 'Some notes' },
                system_prompt: 'You are a test bot',
                post_history_instructions: 'Be nice',
                alternate_greetings: ['Hey there!'],
                group_only_greetings: ['Hello everyone!'],
                tags: ['test', 'bot'],
                creator: 'Pedro',
                character_version: '3.0',
                source: ['https://example.com/card'],
                creation_date: 1700000000,
                modification_date: 1700000100,
                assets: [{ type: 'icon', uri: 'https://example.com/icon.png', name: 'main_icon', ext: 'png' }],
                character_book: {
                    entries: [{ keys: ['room'], content: 'A large room', use_regex: false }],
                    extensions: {},
                },
                extensions: {},
            };
            const v = new TavernCardValidator(card);
            expect(v.validateV3()).toBe(true);
            expect(v.validate()).toBe(3);
        });
    });

    describe('lastValidationError', () => {
        test('is null after successful validation', () => {
            const v = new TavernCardValidator(makeV1Card());
            v.validate();
            expect(v.lastValidationError).toBeNull();
        });

        test('is reset on each validate call', () => {
            const v = new TavernCardValidator({});
            v.validate();
            expect(v.lastValidationError).not.toBeNull();
            v.card = makeV1Card();
            v.validate();
            expect(v.lastValidationError).toBeNull();
        });
    });
});

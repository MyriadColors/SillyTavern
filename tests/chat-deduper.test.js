import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';
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
    getCurrentChatDetails: jest.fn(() => ({ sessionName: 'Alice - 2026-08-19 @05h 00m' })),
    openCharacterChat: jest.fn(),
    displayPastChats: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { emit: jest.fn() },
    event_types: { CHAT_DELETED: 'chat_deleted', CHAT_CHANGED: 'chat_changed', CHARACTER_EDITED: 'character_edited', CHARACTER_DELETED: 'character_deleted' },
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

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    selected_group: null,
    groups: [],
    openGroupChat: jest.fn(),
}));

let calculateChatContentHash;
let clusterAnalyzedChats;
let analyzeChatFilesBatch;
let ChatMetadataCache;
let ChatDeduperManager;

beforeAll(async () => {
    const chatsEndpoint = await import('../src/endpoints/chats.js');
    calculateChatContentHash = chatsEndpoint.calculateChatContentHash;
    clusterAnalyzedChats = chatsEndpoint.clusterAnalyzedChats;
    analyzeChatFilesBatch = chatsEndpoint.analyzeChatFilesBatch;
    ChatMetadataCache = chatsEndpoint.ChatMetadataCache;

    const deduperMod = await import('../public/scripts/chat-deduper.js');
    ChatDeduperManager = deduperMod.ChatDeduperManager;
});

beforeEach(() => {
    ChatMetadataCache?.clear();
});

describe('calculateChatContentHash', () => {
    test('returns empty string for empty message array', () => {
        expect(calculateChatContentHash([])).toBe('');
    });

    test('produces identical hash for identical message contents and roles', () => {
        const msgs1 = [
            { is_user: false, mes: 'Hello traveler!' },
            { is_user: true, mes: 'Greetings.' },
            { is_user: false, mes: 'Welcome to our village.' },
        ];
        const msgs2 = [
            { is_user: false, mes: 'Hello traveler!' },
            { is_user: true, mes: 'Greetings.' },
            { is_user: false, mes: 'Welcome to our village.' },
        ];
        expect(calculateChatContentHash(msgs1)).toBe(calculateChatContentHash(msgs2));
    });

    test('produces different hash when message text or role changes', () => {
        const msgs1 = [
            { is_user: false, mes: 'Hello traveler!' },
            { is_user: true, mes: 'Greetings.' },
        ];
        const msgs2 = [
            { is_user: false, mes: 'Hello traveler!' },
            { is_user: true, mes: 'Goodbye.' },
        ];
        const msgs3 = [
            { is_user: true, mes: 'Hello traveler!' },
            { is_user: false, mes: 'Greetings.' },
        ];
        const hash1 = calculateChatContentHash(msgs1);
        const hash2 = calculateChatContentHash(msgs2);
        const hash3 = calculateChatContentHash(msgs3);

        expect(hash1).not.toBe(hash2);
        expect(hash1).not.toBe(hash3);
    });
});

describe('clusterAnalyzedChats', () => {
    test('identifies unused greeting chats and designates current active chat as keeper', () => {
        const analyzedFiles = [
            {
                isValid: true,
                fileId: 'Alice - 2026-08-19 @05h 30m',
                fileName: 'Alice - 2026-08-19 @05h 30m.jsonl',
                fileSize: '1.0 KB',
                fileSizeBytes: 1024,
                totalMessages: 1,
                userMessagesCount: 0,
                firstMessage: 'Hello! I am Alice.',
                contentHash: 'hash_alice_greeting',
                lastModified: '2026-08-19T08:30:00.000Z',
                lastModifiedMs: 1700000030000,
                previewMessage: 'Hello! I am Alice.',
            },
            {
                isValid: true,
                fileId: 'Alice - 2026-08-19 @05h 00m',
                fileName: 'Alice - 2026-08-19 @05h 00m.jsonl',
                fileSize: '1.0 KB',
                fileSizeBytes: 1024,
                totalMessages: 1,
                userMessagesCount: 0,
                firstMessage: 'Hello! I am Alice.',
                contentHash: 'hash_alice_greeting',
                lastModified: '2026-08-19T08:00:00.000Z',
                lastModifiedMs: 1700000000000,
                previewMessage: 'Hello! I am Alice.',
            },
            {
                isValid: true,
                fileId: 'Alice - 2026-08-19 @04h 00m',
                fileName: 'Alice - 2026-08-19 @04h 00m.jsonl',
                fileSize: '1.0 KB',
                fileSizeBytes: 1024,
                totalMessages: 1,
                userMessagesCount: 0,
                firstMessage: 'Hello! I am Alice.',
                contentHash: 'hash_alice_greeting',
                lastModified: '2026-08-19T07:00:00.000Z',
                lastModifiedMs: 1699999000000,
                previewMessage: 'Hello! I am Alice.',
            },
        ];

        const clusters = clusterAnalyzedChats(analyzedFiles, {
            characterName: 'Alice',
            avatar: 'Alice.png',
            isGroup: false,
            currentChatName: 'Alice - 2026-08-19 @05h 00m',
        });

        expect(clusters.length).toBe(1);
        expect(clusters[0].type).toBe('greeting_duplicate');
        expect(clusters[0].totalDuplicates).toBe(2);
        expect(clusters[0].recommendedPrimary).toBe('Alice - 2026-08-19 @05h 00m');

        const primaryEntry = clusters[0].files.find(f => f.fileId === 'Alice - 2026-08-19 @05h 00m');
        expect(primaryEntry.isPrimary).toBe(true);
        expect(primaryEntry.selectedForDeletion).toBe(false);

        const dupEntries = clusters[0].files.filter(f => f.fileId !== 'Alice - 2026-08-19 @05h 00m');
        expect(dupEntries.length).toBe(2);
        expect(dupEntries.every(f => f.selectedForDeletion)).toBe(true);
    });

    test('identifies exact content duplicate conversations', () => {
        const analyzedFiles = [
            {
                isValid: true,
                fileId: 'Alice - Chat A',
                fileName: 'Alice - Chat A.jsonl',
                fileSize: '5.0 KB',
                fileSizeBytes: 5120,
                totalMessages: 4,
                userMessagesCount: 2,
                firstMessage: 'Hello!',
                contentHash: 'shared_conversation_hash_123',
                lastModified: '2026-08-19T08:30:00.000Z',
                lastModifiedMs: 1700000030000,
                previewMessage: 'See you next time!',
            },
            {
                isValid: true,
                fileId: 'Alice - Chat B',
                fileName: 'Alice - Chat B.jsonl',
                fileSize: '5.0 KB',
                fileSizeBytes: 5120,
                totalMessages: 4,
                userMessagesCount: 2,
                firstMessage: 'Hello!',
                contentHash: 'shared_conversation_hash_123',
                lastModified: '2026-08-19T08:00:00.000Z',
                lastModifiedMs: 1700000000000,
                previewMessage: 'See you next time!',
            },
        ];

        const clusters = clusterAnalyzedChats(analyzedFiles, {
            characterName: 'Alice',
            avatar: 'Alice.png',
            isGroup: false,
            currentChatName: '',
        });

        expect(clusters.length).toBe(1);
        expect(clusters[0].type).toBe('content_duplicate');
        expect(clusters[0].totalDuplicates).toBe(1);
        expect(clusters[0].recommendedPrimary).toBe('Alice - Chat A');
    });

    test('returns empty clusters when all chats are unique and active', () => {
        const analyzedFiles = [
            {
                isValid: true,
                fileId: 'Alice - Unique 1',
                fileName: 'Alice - Unique 1.jsonl',
                fileSize: '3.0 KB',
                fileSizeBytes: 3000,
                totalMessages: 3,
                userMessagesCount: 1,
                firstMessage: 'Hello!',
                contentHash: 'hash_1',
                lastModified: '2026-08-19T08:00:00.000Z',
                lastModifiedMs: 1700000000000,
                previewMessage: 'Text 1',
            },
            {
                isValid: true,
                fileId: 'Alice - Unique 2',
                fileName: 'Alice - Unique 2.jsonl',
                fileSize: '4.0 KB',
                fileSizeBytes: 4000,
                totalMessages: 5,
                userMessagesCount: 2,
                firstMessage: 'Hello!',
                contentHash: 'hash_2',
                lastModified: '2026-08-19T07:00:00.000Z',
                lastModifiedMs: 1699999000000,
                previewMessage: 'Text 2',
            },
        ];

        const clusters = clusterAnalyzedChats(analyzedFiles, {
            characterName: 'Alice',
            avatar: 'Alice.png',
            isGroup: false,
            currentChatName: '',
        });

        expect(clusters.length).toBe(0);
    });
});

describe('ChatMetadataCache', () => {
    test('stores and retrieves cached metadata accurately', () => {
        const filePath = '/test/chats/Alice/chat1.jsonl';
        const stats = { mtimeMs: 1700000000000, size: 2048 };
        const data = { fileId: 'chat1', totalMessages: 5, isValid: true };

        ChatMetadataCache.set(filePath, stats, data);
        const retrieved = ChatMetadataCache.get(filePath, stats);
        expect(retrieved).toEqual(data);
    });

    test('returns null when stats differ (mtimeMs or size changed)', () => {
        const filePath = '/test/chats/Alice/chat1.jsonl';
        const statsOld = { mtimeMs: 1700000000000, size: 2048 };
        const statsNewMtime = { mtimeMs: 1700000050000, size: 2048 };
        const statsNewSize = { mtimeMs: 1700000000000, size: 4096 };
        const data = { fileId: 'chat1', totalMessages: 5 };

        ChatMetadataCache.set(filePath, statsOld, data);
        expect(ChatMetadataCache.get(filePath, statsNewMtime)).toBeNull();
        expect(ChatMetadataCache.get(filePath, statsNewSize)).toBeNull();
    });

    test('invalidates cache entry properly', () => {
        const filePath = '/test/chats/Alice/chat1.jsonl';
        const stats = { mtimeMs: 1700000000000, size: 2048 };
        const data = { fileId: 'chat1' };

        ChatMetadataCache.set(filePath, stats, data);
        ChatMetadataCache.invalidate(filePath);
        expect(ChatMetadataCache.get(filePath, stats)).toBeNull();
    });
});

describe('analyzeChatFilesBatch', () => {
    test('returns empty array when input is empty', async () => {
        const results = await analyzeChatFilesBatch([]);
        expect(results).toEqual([]);
    });
});

describe('ChatDeduperManager Settings', () => {
    test('retrieves default settings safely', () => {
        const settings = ChatDeduperManager.getSettings();
        expect(settings.safeMode).toBe('trash');
        expect(settings.includeGreetingDuplicates).toBe(true);
        expect(settings.includeContentDuplicates).toBe(true);
    });

    test('saves and updates settings', () => {
        ChatDeduperManager.saveSettings({
            safeMode: 'delete',
            includeGreetingDuplicates: true,
            includeContentDuplicates: false,
        });

        const settings = ChatDeduperManager.getSettings();
        expect(settings.safeMode).toBe('delete');
        expect(settings.includeContentDuplicates).toBe(false);
    });
});

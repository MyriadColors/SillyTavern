import { beforeAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// chats.js reads these config values at module load. Environment variables take
// precedence over config.yaml, so the module imports without a config file.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';

/** @type {import('../src/endpoints/chats.js')} */
let chats;

beforeAll(async () => {
    chats = await import('../src/endpoints/chats.js');
});

function makeChatJsonl() {
    return [
        JSON.stringify({ user_name: 'User', character_name: 'Char', chat_metadata: { note: 'meta' } }),
        JSON.stringify({ name: 'Char', is_user: false, mes: 'First message', send_date: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ name: 'User', is_user: true, mes: 'Second message', send_date: '2026-01-02T00:00:00.000Z' }),
    ].join('\n');
}

describe('getChatInfo', () => {
    let tmpDir;
    let chatFile;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-info-'));
        chatFile = path.join(tmpDir, 'chat.jsonl');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reads info from a normal chat file', async () => {
        fs.writeFileSync(chatFile, makeChatJsonl());
        const info = await chats.getChatInfo(chatFile, {}, true);
        expect(info.file_id).toBe('chat');
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(2);
        expect(info.mes).toBe('Second message');
        expect(info.last_mes).toBe('2026-01-02T00:00:00.000Z');
        expect(info.match).toBe(true);
        expect(info.chat_metadata).toEqual({ note: 'meta' });
    });

    test('returns defaults for an empty chat file', async () => {
        fs.writeFileSync(chatFile, '');
        const info = await chats.getChatInfo(chatFile);
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(0);
        expect(info.mes).toBe('[The chat is empty]');
        expect(info.match).toBe(false);
    });

    test('applies the matcher against message content', async () => {
        fs.writeFileSync(chatFile, makeChatJsonl());
        const matching = await chats.getChatInfo(chatFile, {}, false, lines => lines.some(l => l.includes('Second')));
        expect(matching.match).toBe(true);
        const nonMatching = await chats.getChatInfo(chatFile, {}, false, lines => lines.some(l => l.includes('nope')));
        expect(nonMatching.match).toBe(false);
    });

    test('resolves without match when the file was already deleted', async () => {
        const info = await chats.getChatInfo(path.join(tmpDir, 'gone.jsonl'));
        expect(info).toEqual({ match: false });
    });

    test('resolves without match when the file is deleted between stat and read', async () => {
        // Simulate the race: stat succeeds, but the file is gone when the stream opens
        jest.spyOn(fs.promises, 'stat').mockResolvedValue(/** @type {any} */({ size: 100, mtimeMs: 1_000_000 }));
        const info = await chats.getChatInfo(path.join(tmpDir, 'ghost.jsonl'));
        expect(info).toEqual({ match: false });
    });

    test('resolves instead of hanging when the file is truncated between stat and read', async () => {
        // Simulate the race: stat reports content, but the file is empty when read
        fs.writeFileSync(chatFile, '');
        jest.spyOn(fs.promises, 'stat').mockResolvedValue(/** @type {any} */({ size: 100, mtimeMs: 1_000_000 }));
        const info = await chats.getChatInfo(chatFile);
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(0);
        expect(info.mes).toBe('[The chat is empty]');
        expect(info.match).toBe(false);
    });

    test('rejects with the original error for non-ENOENT stat failures', async () => {
        const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        jest.spyOn(fs.promises, 'stat').mockRejectedValue(eacces);
        await expect(chats.getChatInfo(chatFile)).rejects.toThrow('EACCES');
    });

    test('resolves a degraded preview for a fully corrupted chat file', async () => {
        fs.writeFileSync(chatFile, 'not json at all\nstill not json');
        const info = await chats.getChatInfo(chatFile);
        expect(info.file_id).toBe('chat');
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(0);
        expect(info.mes).toBe('[The message is empty]');
        expect(info.match).toBe(true);
    });

    test('resolves a degraded preview when only the last line is unparseable', async () => {
        // e.g. a partially flushed write or an external edit truncated the final line
        fs.writeFileSync(chatFile, makeChatJsonl() + '\n' + '{"name": "User", "is_user": true, "mes": "Trunc');
        const info = await chats.getChatInfo(chatFile);
        expect(info.file_id).toBe('chat');
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(2);
        expect(info.mes).toBe('[The message is empty]');
        expect(info.match).toBe(true);
    });

    test('matcher still applies to intact messages when the last line is unparseable', async () => {
        fs.writeFileSync(chatFile, makeChatJsonl() + '\n' + '{"broken');
        const matching = await chats.getChatInfo(chatFile, {}, false, lines => lines.some(l => l.includes('Second')));
        expect(matching.match).toBe(true);
        expect(matching.file_name).toBe('chat.jsonl');
        const nonMatching = await chats.getChatInfo(chatFile, {}, false, lines => lines.some(l => l.includes('nope')));
        expect(nonMatching.match).toBe(false);
        expect(nonMatching.file_name).toBe('chat.jsonl');
    });

    test('reads full info when messages contain literal U+2028/U+2029 separators', async () => {
        // Model output can contain raw U+2028/U+2029 chars. They are valid inside
        // JSON strings, but node:readline treats them as line breaks and would
        // fragment the record into unparseable pieces.
        const header = JSON.stringify({ user_name: 'User', character_name: 'Char', chat_metadata: {} });
        const body = 'Engine bay\u2028with a line separator\u2029and a paragraph separator';
        const message = JSON.stringify({ name: 'Char', is_user: false, mes: body, send_date: '2026-02-19T13:48:00.559Z' });
        fs.writeFileSync(chatFile, `${header}\n${message}`);

        const info = await chats.getChatInfo(chatFile);
        expect(info.file_name).toBe('chat.jsonl');
        expect(info.chat_items).toBe(1);
        expect(info.mes).toBe(body);
        expect(info.last_mes).toBe('2026-02-19T13:48:00.559Z');
        expect(info.match).toBe(true);
    });

    test('matcher sees message text containing literal U+2028/U+2029 separators', async () => {
        const header = JSON.stringify({ user_name: 'User', character_name: 'Char', chat_metadata: {} });
        const message = JSON.stringify({ name: 'Char', is_user: false, mes: 'sweltering\u2028maze', send_date: '2026-02-19T13:48:00.559Z' });
        fs.writeFileSync(chatFile, `${header}\n${message}`);

        const matching = await chats.getChatInfo(chatFile, {}, false, lines => lines.some(l => l.includes('sweltering')));
        expect(matching.match).toBe(true);
        expect(matching.chat_items).toBe(1);
        expect(matching.mes).toBe('sweltering\u2028maze');
    });
});

describe('normalizeGroupChatTags', () => {
    test('trims, drops empty values and removes duplicates', () => {
        expect(chats.normalizeGroupChatTags([' rp ', '', 'rp', 42, null])).toEqual(['rp', '42']);
    });

    test('returns an empty array for non-array input', () => {
        expect(chats.normalizeGroupChatTags(undefined)).toEqual([]);
        expect(chats.normalizeGroupChatTags('tag')).toEqual([]);
    });
});

describe('mergeChatRecords', () => {
    const header = (name, metadata = {}) => ({ user_name: 'User', character_name: name, chat_metadata: metadata });
    const message = (text, sendDate) => ({ name: 'Char', is_user: false, mes: text, send_date: sendDate });

    test('orders messages chronologically and keeps the first header', () => {
        const merged = chats.mergeChatRecords([
            [header('First', { note: 'first' }), message('later', '2026-01-02T00:00:00.000Z')],
            [header('Second'), message('earlier', '2026-01-01T00:00:00.000Z')],
        ]);

        expect(merged[0].character_name).toBe('First');
        expect(merged[0].chat_metadata).toEqual({ note: 'first' });
        expect(merged.slice(1).map(m => m.mes)).toEqual(['earlier', 'later']);
    });

    test('removes stale integrity metadata from the merged header', () => {
        const merged = chats.mergeChatRecords([
            [header('First', { integrity: 'abc', note: 'keep' }), message('one', '2026-01-01T00:00:00.000Z')],
            [header('Second'), message('two', '2026-01-02T00:00:00.000Z')],
        ]);

        expect(merged[0].chat_metadata).toEqual({ note: 'keep' });
    });

    test('keeps undated messages after dated ones in input order', () => {
        const merged = chats.mergeChatRecords([
            [header('First'), message('undated-a'), message('dated', '2026-01-01T00:00:00.000Z')],
            [header('Second'), message('undated-b')],
        ]);

        expect(merged.slice(1).map(m => m.mes)).toEqual(['dated', 'undated-a', 'undated-b']);
    });

    test('returns an empty array when there is nothing to merge', () => {
        expect(chats.mergeChatRecords([])).toEqual([]);
        expect(chats.mergeChatRecords([[], null])).toEqual([]);
    });
});

describe('serializeChatLine', () => {
    test('escapes U+2028/U+2029 without changing the parsed value', () => {
        const message = { name: 'Char', mes: 'a\u2028b\u2029c' };
        const line = chats.serializeChatLine(message);
        expect(line).not.toMatch(/\u2028/);
        expect(line).not.toMatch(/\u2029/);
        expect(line).toContain('\\u2028');
        expect(line).toContain('\\u2029');
        expect(JSON.parse(line)).toEqual(message);
        // Escaped records stay on exactly one LF-delimited line
        expect(line).not.toContain('\n');
    });
});

describe('trySaveChat', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-save-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('saved chats with U+2028/U+2029 round-trip through getChatInfo', async () => {
        const chatFile = path.join(tmpDir, 'chat.jsonl');
        const body = 'Engine bay\u2028with separators\u2029inside';
        await chats.trySaveChat([
            { user_name: 'User', character_name: 'Char', chat_metadata: {} },
            { name: 'Char', is_user: false, mes: body, send_date: '2026-02-19T13:48:00.559Z' },
        ], chatFile, false, 'handle', 'Char', tmpDir);

        const raw = fs.readFileSync(chatFile, 'utf8');
        expect(raw).not.toMatch(/\u2028/);
        expect(raw).not.toMatch(/\u2029/);

        const info = await chats.getChatInfo(chatFile);
        expect(info.chat_items).toBe(1);
        expect(info.mes).toBe(body);
        expect(info.last_mes).toBe('2026-02-19T13:48:00.559Z');
    });
});

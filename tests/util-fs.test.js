import { afterEach, beforeAll, beforeEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getImages, readFirstLine, safeReadFileSync, safeReadJsonSync, safeReadJson, setConfigFilePath } from '../src/util';
import { MEDIA_REQUEST_TYPE } from '../src/constants';

try {
    setConfigFilePath('../default/config.yaml');
} catch {
    // ignore if already set
}

describe('getImages', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-getimages-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(name, mtimeMs = null) {
        const filePath = path.join(tmpDir, name);
        fs.writeFileSync(filePath, '');
        if (mtimeMs !== null) {
            const secs = mtimeMs / 1000;
            fs.utimesSync(filePath, secs, secs);
        }
    }

    test('sorts by name with natural collation', () => {
        writeFile('b.png');
        writeFile('a.png');
        writeFile('c.png');
        expect(getImages(tmpDir, 'name')).toEqual(['a.png', 'b.png', 'c.png']);
    });

    test('sorts by date oldest-first using file mtime', () => {
        writeFile('newest.png', 3_000_000);
        writeFile('oldest.png', 1_000_000);
        writeFile('middle.png', 2_000_000);
        expect(getImages(tmpDir, 'date')).toEqual(['oldest.png', 'middle.png', 'newest.png']);
    });

    test('reads each file mtime only once when sorting by date', () => {
        for (let i = 0; i < 8; i++) {
            writeFile(`img${i}.png`, (8 - i) * 1_000_000);
        }
        const spy = jest.spyOn(fs, 'statSync');
        try {
            const result = getImages(tmpDir, 'date');
            expect(result).toEqual(['img7.png', 'img6.png', 'img5.png', 'img4.png', 'img3.png', 'img2.png', 'img1.png', 'img0.png']);
            expect(spy).toHaveBeenCalledTimes(8);
        } finally {
            spy.mockRestore();
        }
    });

    test('falls back to mtime 0 if a file disappears between readdir and stat', () => {
        writeFile('survivor.png', 2_000_000);
        writeFile('ghost.png', 1_000_000);
        const realStat = fs.statSync;
        const spy = jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
            if (typeof p === 'string' && p.endsWith('ghost.png')) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            return realStat(p, ...rest);
        });
        try {
            expect(getImages(tmpDir, 'date')).toEqual(['ghost.png', 'survivor.png']);
        } finally {
            spy.mockRestore();
        }
    });

    test('propagates non-ENOENT stat errors (e.g. EACCES) instead of masking them', () => {
        writeFile('readable.png', 1_000_000);
        writeFile('forbidden.png', 2_000_000);
        const realStat = fs.statSync;
        const spy = jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
            if (typeof p === 'string' && p.endsWith('forbidden.png')) {
                const err = new Error('EACCES');
                err.code = 'EACCES';
                throw err;
            }
            return realStat(p, ...rest);
        });
        try {
            expect(() => getImages(tmpDir, 'date')).toThrow(/EACCES/);
        } finally {
            spy.mockRestore();
        }
    });

    test('filters to image types by default', () => {
        writeFile('keep.png');
        writeFile('keep.jpg');
        writeFile('drop.mp4');
        writeFile('drop.mp3');
        writeFile('drop.txt');
        writeFile('no-extension');
        expect(getImages(tmpDir, 'name')).toEqual(['keep.jpg', 'keep.png']);
    });

    test('filters to video types when requested', () => {
        writeFile('drop.png');
        writeFile('keep.mp4');
        writeFile('keep.webm');
        expect(getImages(tmpDir, 'name', MEDIA_REQUEST_TYPE.VIDEO)).toEqual(['keep.mp4', 'keep.webm']);
    });

    test('filters to audio types when requested', () => {
        writeFile('drop.png');
        writeFile('keep.mp3');
        writeFile('keep.wav');
        expect(getImages(tmpDir, 'name', MEDIA_REQUEST_TYPE.AUDIO)).toEqual(['keep.mp3', 'keep.wav']);
    });

    test('accepts combined media-type bitmask', () => {
        writeFile('img.png');
        writeFile('clip.mp4');
        writeFile('song.mp3');
        const result = getImages(tmpDir, 'name', MEDIA_REQUEST_TYPE.IMAGE | MEDIA_REQUEST_TYPE.AUDIO);
        expect(result).toEqual(['img.png', 'song.mp3']);
    });

    test('skips subdirectories', () => {
        writeFile('real.png');
        fs.mkdirSync(path.join(tmpDir, 'sub.png'));
        expect(getImages(tmpDir, 'name')).toEqual(['real.png']);
    });

    test('returns empty array for an empty directory', () => {
        expect(getImages(tmpDir, 'name')).toEqual([]);
        expect(getImages(tmpDir, 'date')).toEqual([]);
    });
});

describe('readFirstLine', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-readfirstline-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reads first line from single-line file', async () => {
        const filePath = path.join(tmpDir, 'single.txt');
        fs.writeFileSync(filePath, 'hello world');
        const line = await readFirstLine(filePath);
        expect(line).toBe('hello world');
    });

    test('reads only the first line from multi-line file', async () => {
        const filePath = path.join(tmpDir, 'multi.txt');
        fs.writeFileSync(filePath, 'line 1\nline 2\nline 3');
        const line = await readFirstLine(filePath);
        expect(line).toBe('line 1');
    });

    test('returns empty string for empty file', async () => {
        const filePath = path.join(tmpDir, 'empty.txt');
        fs.writeFileSync(filePath, '');
        const line = await readFirstLine(filePath);
        expect(line).toBe('');
    });

    test('returns empty string and handles missing file gracefully', async () => {
        const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const filePath = path.join(tmpDir, 'nonexistent.txt');
            const line = await readFirstLine(filePath);
            expect(line).toBe('');
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('getChatInfo', () => {
    let tmpDir;
    let getChatInfo;

    beforeAll(async () => {
        const chatsModule = await import('../src/endpoints/chats.js');
        getChatInfo = chatsModule.getChatInfo;
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-getchatinfo-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns chat info for a valid JSONL chat file', async () => {
        const filePath = path.join(tmpDir, 'chat1.jsonl');
        const header = JSON.stringify({ user_name: 'User', character_name: 'Assistant', create_date: '2026-01-01' });
        const msg1 = JSON.stringify({ name: 'User', is_user: true, mes: 'Hello', send_date: '2026-01-01T00:00:00.000Z' });
        const msg2 = JSON.stringify({ name: 'Assistant', is_user: false, mes: 'Hi there!', send_date: '2026-01-01T00:01:00.000Z' });
        fs.writeFileSync(filePath, `${header}\n${msg1}\n${msg2}\n`);

        const info = await getChatInfo(filePath);
        expect(info.file_id).toBe('chat1');
        expect(info.file_name).toBe('chat1.jsonl');
        expect(info.chat_items).toBe(2);
        expect(info.mes).toBe('Hi there!');
        expect(info.last_mes).toBe('2026-01-01T00:01:00.000Z');
        expect(info.match).toBe(true);
    });

    test('returns empty chat structure for a 0-byte file', async () => {
        const filePath = path.join(tmpDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '');

        const info = await getChatInfo(filePath);
        expect(info.file_id).toBe('empty');
        expect(info.chat_items).toBe(0);
        expect(info.mes).toBe('[The chat is empty]');
    });

    test('handles whitespace-only file without hanging', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const filePath = path.join(tmpDir, 'whitespace.jsonl');
            fs.writeFileSync(filePath, '   \n\n   \n');

            const info = await getChatInfo(filePath);
            expect(info).toEqual({});
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('returns empty object for non-existent file', async () => {
        const filePath = path.join(tmpDir, 'missing.jsonl');
        const info = await getChatInfo(filePath);
        expect(info).toEqual({});
    });

    test('returns empty object and logs warning for corrupted file without valid chat headers', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const filePath = path.join(tmpDir, 'corrupted.jsonl');
            fs.writeFileSync(filePath, 'invalid non-json line\nanother corrupt line\n');

            const info = await getChatInfo(filePath);
            expect(info).toEqual({});
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('extracts metadata when withMetadata is true', async () => {
        const filePath = path.join(tmpDir, 'meta.jsonl');
        const header = JSON.stringify({
            user_name: 'User',
            character_name: 'Bot',
            chat_metadata: { custom_key: 'custom_value' },
        });
        const msg = JSON.stringify({ name: 'Bot', mes: 'Hello', send_date: '2026-01-01' });
        fs.writeFileSync(filePath, `${header}\n${msg}\n`);

        const info = await getChatInfo(filePath, {}, true);
        expect(info.chat_metadata).toEqual({ custom_key: 'custom_value' });
    });

    test('supports matcher filtering', async () => {
        const filePath = path.join(tmpDir, 'search.jsonl');
        const header = JSON.stringify({ user_name: 'User', character_name: 'Bot' });
        const msg1 = JSON.stringify({ name: 'User', mes: 'banana' });
        const msg2 = JSON.stringify({ name: 'Bot', mes: 'apple' });
        fs.writeFileSync(filePath, `${header}\n${msg1}\n${msg2}\n`);

        const matchFn = (msgs) => msgs.some(m => m.includes('banana'));
        const info = await getChatInfo(filePath, {}, false, matchFn);
        expect(info.match).toBe(true);

        const noMatchFn = (msgs) => msgs.some(m => m.includes('orange'));
        const noMatchInfo = await getChatInfo(filePath, {}, false, noMatchFn);
        expect(noMatchInfo.match).toBe(false);
    });
});

describe('safeReadFileSync', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-saferead-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns file content for existing file', () => {
        const filePath = path.join(tmpDir, 'hello.txt');
        fs.writeFileSync(filePath, 'hello world', 'utf8');
        expect(safeReadFileSync(filePath)).toBe('hello world');
    });

    test('returns null for non-existent file', () => {
        const filePath = path.join(tmpDir, 'nonexistent.txt');
        expect(safeReadFileSync(filePath)).toBeNull();
    });

    test('handles read error gracefully and returns null', () => {
        const filePath = path.join(tmpDir, 'error.txt');
        fs.writeFileSync(filePath, 'data', 'utf8');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('EACCES: permission denied');
        });

        try {
            expect(safeReadFileSync(filePath)).toBeNull();
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            readSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });
});

describe('safeReadJsonSync', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-safereadjson-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns parsed JSON for valid json file', () => {
        const filePath = path.join(tmpDir, 'data.json');
        fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: 'two' }), 'utf8');
        expect(safeReadJsonSync(filePath)).toEqual({ a: 1, b: 'two' });
    });

    test('returns fallback for non-existent file', () => {
        const filePath = path.join(tmpDir, 'missing.json');
        expect(safeReadJsonSync(filePath)).toBeNull();
        expect(safeReadJsonSync(filePath, { default: true })).toEqual({ default: true });
    });

    test('returns fallback for invalid json file', () => {
        const filePath = path.join(tmpDir, 'invalid.json');
        fs.writeFileSync(filePath, '{ invalid json content', 'utf8');
        expect(safeReadJsonSync(filePath)).toBeNull();
        expect(safeReadJsonSync(filePath, [])).toEqual([]);
    });

    test('returns fallback for empty file', () => {
        const filePath = path.join(tmpDir, 'empty.json');
        fs.writeFileSync(filePath, '', 'utf8');
        expect(safeReadJsonSync(filePath)).toBeNull();
    });
});

describe('safeReadJson', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-safereadjsonasync-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns parsed JSON asynchronously for valid json file', async () => {
        const filePath = path.join(tmpDir, 'async.json');
        fs.writeFileSync(filePath, JSON.stringify({ valid: true, count: 42 }), 'utf8');
        const data = await safeReadJson(filePath);
        expect(data).toEqual({ valid: true, count: 42 });
    });

    test('returns fallback asynchronously for missing or invalid file', async () => {
        const missingPath = path.join(tmpDir, 'missing.json');
        expect(await safeReadJson(missingPath)).toBeNull();
        expect(await safeReadJson(missingPath, { fallback: true })).toEqual({ fallback: true });

        const invalidPath = path.join(tmpDir, 'bad.json');
        fs.writeFileSync(invalidPath, 'not json', 'utf8');
        expect(await safeReadJson(invalidPath, {})).toEqual({});
    });
});


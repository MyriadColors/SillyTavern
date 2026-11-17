import { beforeAll, beforeEach, afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// chats.js reads these config values at module load, and the overwrite snapshot is
// gated on backups being enabled. Environment variables take precedence over
// config.yaml, so this test can exercise the snapshot without a config file.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'true';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
// removeOldBackups reads this limit through getConfigValue, which requires a
// configured value to avoid opening config.yaml.
process.env.SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS = '50';

const utilPath = fileURLToPath(new URL('../src/util.js', import.meta.url));
// The test package has its own node_modules, so resolve the exact copy of
// write-file-atomic that src/util.js imports (the repository root one).
const writeFileAtomicPath = createRequire(utilPath).resolve('write-file-atomic');
const realWriteFileAtomic = createRequire(utilPath)(writeFileAtomicPath);

const mockWriteFileAtomicSync = jest.fn();
const mockWriteFileAtomic = jest.fn();

jest.unstable_mockModule(writeFileAtomicPath, () => ({
    default: mockWriteFileAtomic,
    sync: mockWriteFileAtomicSync,
}));

/** @type {import('../src/endpoints/chats.js')} */
let chats;

beforeAll(async () => {
    chats = await import('../src/endpoints/chats.js');
});

const SLUG = '1e6905db-bab6-4901-913b-06d18cab5a8f';

/**
 * Builds a chat array like the client sends it.
 * @param {string} message Assistant message text
 * @returns {object[]} Chat array
 */
function makeChat(message) {
    return [
        { user_name: 'User', character_name: 'Char', chat_metadata: { integrity: SLUG } },
        { name: 'Char', is_user: false, mes: message },
    ];
}

/**
 * Serializes a chat array the same way trySaveChat does.
 * @param {object[]} chatData Chat array
 * @returns {string} JSONL string
 */
function toJsonl(chatData) {
    return chatData.map(m => JSON.stringify(m)).join('\n');
}

/**
 * Lists the pre-overwrite snapshots present in a backup directory.
 * @param {string} directory Backup directory
 * @returns {string[]} Snapshot file names
 */
function snapshotFiles(directory) {
    return fs.readdirSync(directory).filter(name => name.startsWith('chat_pre_overwrite_'));
}

describe('trySaveChat pre-overwrite snapshot', () => {
    let tmpDir;
    let chatFile;
    let backupDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-snapshot-'));
        chatFile = path.join(tmpDir, 'chat.jsonl');
        backupDir = path.join(tmpDir, 'backups');
        fs.mkdirSync(backupDir);

        mockWriteFileAtomicSync.mockReset();
        mockWriteFileAtomic.mockReset();
        mockWriteFileAtomicSync.mockImplementation((filePath, data, options) => realWriteFileAtomic.sync(filePath, data, options));
        mockWriteFileAtomic.mockImplementation((filePath, data, options) => realWriteFileAtomic(filePath, data, options));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('force save snapshots the previous bytes before overwriting', async () => {
        const originalBytes = 'this is not json{{{';
        fs.writeFileSync(chatFile, originalBytes);
        const newChat = makeChat('Replaced');

        await chats.trySaveChat(newChat, chatFile, true, 'default-user', 'Char', backupDir);

        const snapshots = snapshotFiles(backupDir);
        expect(snapshots.length).toBe(1);
        expect(fs.readFileSync(path.join(backupDir, snapshots[0]), 'utf8')).toBe(originalBytes);
        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
    });

    test('a failing snapshot rejects the save and keeps the original bytes', async () => {
        const originalBytes = 'this is not json{{{';
        fs.writeFileSync(chatFile, originalBytes);
        const newChat = makeChat('Never written');
        mockWriteFileAtomicSync.mockImplementation(() => {
            throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
        });

        await expect(chats.trySaveChat(newChat, chatFile, true, 'default-user', 'Char', backupDir)).rejects.toThrow(/simulated EPERM/);

        expect(fs.readFileSync(chatFile, 'utf8')).toBe(originalBytes);
        expect(snapshotFiles(backupDir).length).toBe(0);
    });

    test('a non-force save creates no pre-overwrite snapshot', async () => {
        const originalChat = makeChat('Original');
        fs.writeFileSync(chatFile, toJsonl(originalChat));
        const newChat = makeChat('Updated');

        await chats.trySaveChat(newChat, chatFile, false, 'default-user', 'Char', backupDir);

        expect(fs.readFileSync(chatFile, 'utf8')).toBe(toJsonl(newChat));
        expect(snapshotFiles(backupDir).length).toBe(0);
    });
});

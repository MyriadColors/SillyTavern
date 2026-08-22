import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import yauzl from 'yauzl';

import { setConfigFilePath } from '../src/util.js';

try {
    setConfigFilePath('../default/config.yaml');
} catch {
    // Already set
}

let findSevenZipBinary;
let backupUser;
let verifyArchive;
let inspectUserBackup;
let restoreUserBackup;
let runBackup;

/**
 * Reads all entry filenames from a zip file.
 * @param {string} zipFilePath Path to the zip file
 * @returns {Promise<string[]>} List of file names inside the zip
 */
function getZipEntries(zipFilePath) {
    return new Promise((resolve, reject) => {
        const entries = [];
        yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                return reject(err);
            }
            if (!zipfile) {
                return resolve([]);
            }
            zipfile.on('entry', entry => {
                entries.push(entry.fileName);
                zipfile.readEntry();
            });
            zipfile.on('end', () => {
                resolve(entries);
            });
            zipfile.on('error', reject);
            zipfile.readEntry();
        });
    });
}

describe('Backup Module Tests', () => {
    let tempDir;
    let testDataDir;
    const testHandle = 'test-user';

    beforeAll(async () => {
        const backupModule = await import('../src/backup.js');
        findSevenZipBinary = backupModule.findSevenZipBinary;
        backupUser = backupModule.backupUser;
        verifyArchive = backupModule.verifyArchive;
        inspectUserBackup = backupModule.inspectUserBackup;
        restoreUserBackup = backupModule.restoreUserBackup;
        runBackup = backupModule.runBackup;

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-backup-test-'));
        testDataDir = path.join(tempDir, 'data');
        const userDir = path.join(testDataDir, testHandle);

        fs.mkdirSync(userDir, { recursive: true });
        fs.mkdirSync(path.join(userDir, 'characters'), { recursive: true });
        fs.mkdirSync(path.join(userDir, 'backups'), { recursive: true });
        fs.mkdirSync(path.join(userDir, '_cache'), { recursive: true });

        fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
        fs.writeFileSync(path.join(userDir, 'secrets.json'), JSON.stringify({ api_key: '12345' }));
        fs.writeFileSync(path.join(userDir, 'characters', 'test_char.png'), 'dummy character data');
        fs.writeFileSync(path.join(userDir, 'backups', 'old_backup.zip'), 'dummy old backup');
        fs.writeFileSync(path.join(userDir, '_cache', 'cached_data.json'), 'dummy cache data');

        const dummyConfigPath = path.join(tempDir, 'config.yaml');
        fs.writeFileSync(dummyConfigPath, `dataRoot: "${testDataDir.replace(/\\/g, '/')}"\n`);
        try {
            setConfigFilePath(dummyConfigPath);
        } catch {
            // Already set
        }

        globalThis.DATA_ROOT = testDataDir;
    });

    afterAll(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup error
        }
    });

    describe('findSevenZipBinary', () => {
        test('returns custom path when it exists', () => {
            const dummyBin = path.join(tempDir, 'dummy-7z.exe');
            fs.writeFileSync(dummyBin, 'binary content');
            expect(findSevenZipBinary(dummyBin)).toBe(dummyBin);
        });

        test('returns null for non-existent custom path', () => {
            const nonExistent = path.join(tempDir, 'does-not-exist-7z.exe');
            expect(findSevenZipBinary(nonExistent)).toBeNull();
        });

        test('returns string or null for system candidate search', () => {
            const result = findSevenZipBinary();
            expect(result === null || typeof result === 'string').toBe(true);
        });
    });

    describe('backupUser for .zip and metadata', () => {
        test('creates a valid zip backup archive with metadata and verification', async () => {
            const result = await backupUser(testHandle, {
                format: 'zip',
                verify: true,
            });

            expect(result).toBeDefined();
            expect(result.handle).toBe(testHandle);
            expect(result.format).toBe('zip');
            expect(result.size).toBeGreaterThan(0);
            expect(result.verified).toBe(true);
            expect(result.meta).toBeDefined();
            expect(result.meta.handle).toBe(testHandle);
            expect(result.meta.app).toBe('SillyTavern');
            expect(fs.existsSync(result.filePath)).toBe(true);

            const entries = await getZipEntries(result.filePath);
            expect(entries).toContain('settings.json');
            expect(entries).toContain('characters/test_char.png');
            expect(entries).toContain('.st-backup/backup-meta.json');
        });
    });

    describe('exclusion verification', () => {
        test('excludes secrets.json, backups, and _cache by default', async () => {
            const result = await backupUser(testHandle, {
                format: 'zip',
                includeSecrets: false,
            });

            const entries = await getZipEntries(result.filePath);
            expect(entries).toContain('settings.json');
            expect(entries).toContain('characters/test_char.png');
            expect(entries).not.toContain('secrets.json');
            expect(entries.some(e => e.startsWith('backups/'))).toBe(false);
            expect(entries.some(e => e.startsWith('_cache/'))).toBe(false);
        });

        test('includes secrets.json when includeSecrets is true', async () => {
            const result = await backupUser(testHandle, {
                format: 'zip',
                includeSecrets: true,
            });

            const entries = await getZipEntries(result.filePath);
            expect(entries).toContain('settings.json');
            expect(entries).toContain('secrets.json');
            expect(entries.some(e => e.startsWith('backups/'))).toBe(false);
            expect(entries.some(e => e.startsWith('_cache/'))).toBe(false);
        });
    });

    describe('custom output resolution', () => {
        test('resolves custom output directory correctly', async () => {
            const customOutDir = path.join(tempDir, 'custom-backup-dir');
            const result = await backupUser(testHandle, {
                format: 'zip',
                output: customOutDir,
            });

            expect(result.filePath.startsWith(customOutDir)).toBe(true);
            expect(fs.existsSync(result.filePath)).toBe(true);
        });

        test('resolves custom output file path directly', async () => {
            const customFilePath = path.join(tempDir, 'specific-named-backup.zip');
            const result = await backupUser(testHandle, {
                format: 'zip',
                output: customFilePath,
            });

            expect(result.filePath).toBe(customFilePath);
            expect(fs.existsSync(customFilePath)).toBe(true);
        });
    });

    describe('inspectUserBackup (dry-run)', () => {
        test('accurately counts files and categories without creating an archive', async () => {
            const inspection = await inspectUserBackup(testHandle, {
                includeSecrets: false,
            });

            expect(inspection.handle).toBe(testHandle);
            expect(inspection.fileCount).toBeGreaterThanOrEqual(2); // settings.json + characters/test_char.png
            expect(inspection.totalBytes).toBeGreaterThan(0);
            expect(inspection.byCategory['characters']).toBeDefined();
            expect(inspection.byCategory['settings.json']).toBeDefined();
            expect(inspection.byCategory['secrets.json']).toBeUndefined();
        });
    });

    describe('verifyArchive', () => {
        test('returns ok: true for valid archive', async () => {
            const backupRes = await backupUser(testHandle, { format: 'zip' });
            const verifyRes = await verifyArchive(backupRes.filePath, 'zip');
            expect(verifyRes.ok).toBe(true);
        });

        test('returns ok: false for non-existent file', async () => {
            const verifyRes = await verifyArchive(path.join(tempDir, 'does-not-exist.zip'), 'zip');
            expect(verifyRes.ok).toBe(false);
        });

        test('returns ok: false for corrupted zip file', async () => {
            const corruptZipPath = path.join(tempDir, 'corrupted.zip');
            fs.writeFileSync(corruptZipPath, 'not a valid zip content');
            const verifyRes = await verifyArchive(corruptZipPath, 'zip');
            expect(verifyRes.ok).toBe(false);
            expect(verifyRes.error).toBeDefined();
        });
    });

    describe('restoreUserBackup', () => {
        test('restores files from archive into target directory', async () => {
            const backupRes = await backupUser(testHandle, { format: 'zip' });
            const restoreTarget = path.join(tempDir, 'restore-target-user');

            const restoreRes = await restoreUserBackup(backupRes.filePath, restoreTarget, {
                force: true,
            });

            expect(restoreRes).toBeDefined();
            expect(restoreRes.filesRestored).toBeGreaterThan(0);
            expect(fs.existsSync(path.join(restoreTarget, 'settings.json'))).toBe(true);
            expect(fs.existsSync(path.join(restoreTarget, 'characters', 'test_char.png'))).toBe(true);
            // Internal metadata folder should not pollute restored root
            expect(fs.existsSync(path.join(restoreTarget, '.st-backup'))).toBe(false);
        });

        test('protects against overwrite without force flag', async () => {
            const backupRes = await backupUser(testHandle, { format: 'zip' });
            const restoreTarget = path.join(tempDir, 'restore-target-occupied');
            fs.mkdirSync(restoreTarget, { recursive: true });
            fs.writeFileSync(path.join(restoreTarget, 'existing.txt'), 'data');

            await expect(
                restoreUserBackup(backupRes.filePath, restoreTarget, { force: false })
            ).rejects.toThrow('is not empty');
        });

        test('supports dry-run without writing to disk', async () => {
            const backupRes = await backupUser(testHandle, { format: 'zip' });
            const dryRunTarget = path.join(tempDir, 'restore-dry-run-target');

            const restoreRes = await restoreUserBackup(backupRes.filePath, dryRunTarget, {
                dryRun: true,
            });

            expect(restoreRes.filesRestored).toBeGreaterThan(0);
            expect(fs.existsSync(dryRunTarget)).toBe(false);
        });
    });

    describe('7z backup and restore', () => {
        test('creates and verifies 7z archive if 7-Zip is installed', async () => {
            const sevenZip = findSevenZipBinary();
            if (!sevenZip) {
                return; // Skip if 7-Zip is not installed in the environment
            }

            const result = await backupUser(testHandle, {
                format: '7z',
                verify: true,
            });

            expect(result).toBeDefined();
            expect(result.format).toBe('7z');
            expect(result.verified).toBe(true);
            expect(fs.existsSync(result.filePath)).toBe(true);

            const restoreTarget = path.join(tempDir, 'restore-7z-target');
            const restoreRes = await restoreUserBackup(result.filePath, restoreTarget, {
                force: true,
            });

            expect(restoreRes.filesRestored).toBeGreaterThan(0);
            expect(fs.existsSync(path.join(restoreTarget, 'settings.json'))).toBe(true);
        });
    });

    describe('runBackup with onProgress', () => {
        test('calls progress callback during backup execution', async () => {
            const progressEvents = [];
            const results = await runBackup({
                account: testHandle,
                format: 'zip',
                onProgress: (p) => {
                    progressEvents.push(p);
                },
            });

            expect(results.length).toBe(1);
            expect(progressEvents.length).toBe(1);
            expect(progressEvents[0].handle).toBe(testHandle);
            expect(progressEvents[0].current).toBe(1);
            expect(progressEvents[0].total).toBe(1);
        });
    });
});

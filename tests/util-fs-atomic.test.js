import { afterEach, beforeAll, beforeEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const utilPath = fileURLToPath(new URL('../src/util.js', import.meta.url));
// The test package has its own node_modules, so resolve the exact copy of
// write-file-atomic that src/util.js imports (the repository root one).
const writeFileAtomicPath = createRequire(utilPath).resolve('write-file-atomic');

const mockWriteFileAtomicSync = jest.fn();
const mockWriteFileAtomic = jest.fn();

jest.unstable_mockModule(writeFileAtomicPath, () => ({
    default: mockWriteFileAtomic,
    sync: mockWriteFileAtomicSync,
}));

let tryWriteFile;
let tryWriteFileSync;
let tryWriteFileWithFallback;

beforeAll(async () => {
    const util = await import(utilPath);
    tryWriteFile = util.tryWriteFile;
    tryWriteFileSync = util.tryWriteFileSync;
    tryWriteFileWithFallback = util.tryWriteFileWithFallback;
});

/**
 * Creates an error with a specific file system error code.
 * @param {string} code Error code
 * @returns {Error} Error carrying the code
 */
function errorWithCode(code) {
    return Object.assign(new Error(`simulated ${code}`), { code });
}

describe('tryWriteFile', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-atomic-async-'));
        mockWriteFileAtomic.mockReset();
        mockWriteFileAtomicSync.mockReset();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('retries transient EPERM and eventually succeeds', async () => {
        const err = errorWithCode('EPERM');
        mockWriteFileAtomic
            .mockRejectedValueOnce(err)
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(undefined);
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFile(filePath, 'data')).resolves.toBeUndefined();

        expect(mockWriteFileAtomic).toHaveBeenCalledTimes(3);
    });

    test('does not retry non-transient errors', async () => {
        const err = errorWithCode('EINVAL');
        mockWriteFileAtomic.mockRejectedValueOnce(err);
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFile(filePath, 'data')).rejects.toBe(err);

        expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    });

    test('falls back to a direct write when retries are exhausted', async () => {
        mockWriteFileAtomic.mockRejectedValue(errorWithCode('EPERM'));
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFile(filePath, 'fallback data')).resolves.toBeUndefined();

        expect(mockWriteFileAtomic).toHaveBeenCalledTimes(6);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('fallback data');
    });
});

describe('tryWriteFileSync', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-atomic-sync-'));
        mockWriteFileAtomicSync.mockReset();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('retries transient EPERM then succeeds', () => {
        const err = errorWithCode('EPERM');
        mockWriteFileAtomicSync
            .mockImplementationOnce(() => { throw err; })
            .mockImplementationOnce(() => { });
        const filePath = path.join(tmpDir, 'chat.jsonl');

        expect(() => tryWriteFileSync(filePath, 'data')).not.toThrow();

        expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(2);
    });

    test('throws immediately on a non-transient error', () => {
        const err = errorWithCode('EINVAL');
        mockWriteFileAtomicSync.mockImplementationOnce(() => { throw err; });
        const filePath = path.join(tmpDir, 'chat.jsonl');

        expect(() => tryWriteFileSync(filePath, 'data')).toThrow(err);

        expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(1);
    });
});

describe('tryWriteFileWithFallback', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-atomic-fallback-'));
        mockWriteFileAtomic.mockReset();
        mockWriteFileAtomicSync.mockReset();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('writes synchronously and leaves the async writer untouched', async () => {
        mockWriteFileAtomicSync.mockImplementationOnce(() => { });
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFileWithFallback(filePath, 'data')).resolves.toBeUndefined();

        expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(1);
        expect(mockWriteFileAtomic).not.toHaveBeenCalled();
    });

    test('falls back to the async writer on a transient sync failure', async () => {
        mockWriteFileAtomicSync.mockImplementation(() => { throw errorWithCode('EPERM'); });
        mockWriteFileAtomic.mockResolvedValueOnce(undefined);
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFileWithFallback(filePath, 'data')).resolves.toBeUndefined();

        expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(3);
        expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    });

    test('rejects a non-transient sync failure without touching the async writer', async () => {
        const err = errorWithCode('EINVAL');
        mockWriteFileAtomicSync.mockImplementation(() => { throw err; });
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFileWithFallback(filePath, 'data')).rejects.toBe(err);

        expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(1);
        expect(mockWriteFileAtomic).not.toHaveBeenCalled();
    });

    test('rejects when both the sync and the async writer fail', async () => {
        const asyncErr = errorWithCode('EINVAL');
        mockWriteFileAtomicSync.mockImplementation(() => { throw errorWithCode('EBUSY'); });
        mockWriteFileAtomic.mockRejectedValueOnce(asyncErr);
        const filePath = path.join(tmpDir, 'chat.jsonl');

        await expect(tryWriteFileWithFallback(filePath, 'data')).rejects.toBe(asyncErr);

        expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    });
});

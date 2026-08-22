import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import archiver from 'archiver';
import yaml from 'yaml';
import yauzl from 'yauzl';
import { sync as commandExistsSync } from 'command-exists';

import { setConfigFilePath, generateTimestamp, isPathUnderParent } from './util.js';
import { initUserStorage, getUserDirectories, getAllUserHandles } from './users.js';
import { DEFAULT_USER } from './constants.js';

const SECRETS_FILE = 'secrets.json';
const METADATA_FOLDER = '.st-backup';
const METADATA_FILE = 'backup-meta.json';

/**
 * Reads the version field from package.json.
 * @returns {string} SillyTavern version
 */
function getAppVersion() {
    try {
        const pkgPath = path.resolve('package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            return typeof pkg.version === 'string' ? pkg.version : 'unknown';
        }
    } catch {
        // ignore
    }
    return 'unknown';
}

/**
 * Finds the 7-Zip binary in the system or custom path.
 * @param {string} [customPath] Custom path or binary name to check
 * @returns {string|null} The path/name of the 7-Zip binary if found, null otherwise
 */
export function findSevenZipBinary(customPath) {
    if (customPath) {
        if (typeof customPath === 'string' && (fs.existsSync(customPath) || commandExistsSync(customPath))) {
            return customPath;
        }
        return null;
    }

    const candidateBinaries = ['7z', '7za', '7zz'];
    for (const bin of candidateBinaries) {
        if (commandExistsSync(bin)) {
            return bin;
        }
    }

    return null;
}

/**
 * Initializes the backup environment by loading config and initializing user storage.
 * @param {string} [configPath='./config.yaml'] Path to the config file
 * @returns {Promise<{ config: Record<string, unknown>, dataRoot: string }>} Initialized config and data root
 */
export async function initBackupEnvironment(configPath = './config.yaml') {
    const resolvedConfigPath = path.resolve(configPath);

    const config = yaml.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
    const dataRoot = config.dataRoot || './data';
    globalThis.DATA_ROOT = dataRoot;

    await initUserStorage(globalThis.DATA_ROOT);
    return {
        config,
        dataRoot,
    };
}

/**
 * Asynchronously walks a directory to count files and calculate uncompressed sizes.
 * @param {string} rootDir Root directory to walk
 * @param {string[]} ignorePatterns Array of glob-like patterns to ignore
 * @returns {Promise<{ fileCount: number, totalBytes: number, byCategory: Record<string, { count: number, bytes: number }> }>}
 */
export async function walkDirAsync(rootDir, ignorePatterns = []) {
    let fileCount = 0;
    let totalBytes = 0;
    const byCategory = {};

    async function walk(currentDir) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

            const shouldIgnore = ignorePatterns.some(pattern => {
                if (pattern.endsWith('/**')) {
                    const prefix = pattern.slice(0, -3);
                    return relPath === prefix || relPath.startsWith(prefix + '/');
                }
                if (pattern.startsWith('**/')) {
                    const suffix = pattern.slice(3);
                    return relPath === suffix || relPath.endsWith('/' + suffix) || relPath.includes('/' + suffix + '/');
                }
                return relPath === pattern;
            });

            if (shouldIgnore) continue;

            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(fullPath);
                fileCount++;
                totalBytes += stat.size;

                const firstSegment = relPath.split('/')[0] || 'root';
                if (!byCategory[firstSegment]) {
                    byCategory[firstSegment] = { count: 0, bytes: 0 };
                }
                byCategory[firstSegment].count++;
                byCategory[firstSegment].bytes += stat.size;
            }
        }
    }

    if (fs.existsSync(rootDir)) {
        await walk(rootDir);
    }

    return { fileCount, totalBytes, byCategory };
}

/**
 * Inspects a user's data directory for backup without creating an archive.
 * @param {string} handle User handle
 * @param {object} [options={}] Options
 * @returns {Promise<{ handle: string, rootDir: string, fileCount: number, totalBytes: number, byCategory: Record<string, { count: number, bytes: number }> }>}
 */
export async function inspectUserBackup(handle, options = {}) {
    const directories = getUserDirectories(handle);
    if (!fs.existsSync(directories.root)) {
        throw new Error(`User directory for "${handle}" does not exist at "${directories.root}".`);
    }

    const ignore = [
        'backups/**',
        '_cache/**',
        '**/backups/**',
        '**/_cache/**',
        `${METADATA_FOLDER}/**`,
        `**/${METADATA_FOLDER}/**`,
    ];

    if (!options.includeSecrets) {
        ignore.push(
            SECRETS_FILE,
            `**/${SECRETS_FILE}`,
            'backups/secrets_migration_*.json',
            '**/secrets_migration_*.json',
        );
    }

    const walkResult = await walkDirAsync(directories.root, ignore);
    return {
        handle,
        rootDir: directories.root,
        ...walkResult,
    };
}

/**
 * Verifies the integrity of a backup archive.
 * @param {string} filePath Path to archive file
 * @param {'zip'|'7z'} [format='zip'] Archive format
 * @param {string} [sevenZipBin] Optional path to 7-Zip binary
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export function verifyArchive(filePath, format = 'zip', sevenZipBin) {
    return new Promise((resolve) => {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) {
            return resolve({ ok: false, error: `File does not exist: "${resolvedPath}"` });
        }

        if (format === 'zip') {
            yauzl.open(resolvedPath, { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    return resolve({ ok: false, error: err.message });
                }
                if (!zipfile) {
                    return resolve({ ok: false, error: 'Empty zipfile object returned' });
                }

                zipfile.on('entry', (entry) => {
                    if (/\/$/.test(entry.fileName)) {
                        zipfile.readEntry();
                        return;
                    }
                    zipfile.openReadStream(entry, (streamErr, readStream) => {
                        if (streamErr) {
                            return resolve({ ok: false, error: streamErr.message });
                        }
                        readStream.on('data', () => {});
                        readStream.on('end', () => {
                            zipfile.readEntry();
                        });
                        readStream.on('error', (errStream) => {
                            resolve({ ok: false, error: errStream.message });
                        });
                    });
                });

                zipfile.on('end', () => {
                    resolve({ ok: true });
                });
                zipfile.on('error', (errZip) => {
                    resolve({ ok: false, error: errZip.message });
                });
                zipfile.readEntry();
            });
        } else if (format === '7z') {
            const bin = sevenZipBin || findSevenZipBinary();
            if (!bin) {
                return resolve({ ok: false, error: '7-Zip binary not found in PATH or custom path.' });
            }

            const proc = spawn(bin, ['t', resolvedPath], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stderr = '';
            proc.stderr?.on('data', chunk => {
                stderr += chunk.toString();
            });
            proc.on('error', (err) => resolve({ ok: false, error: err.message }));
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ ok: true });
                } else {
                    resolve({ ok: false, error: `7-Zip test failed with exit code ${code}: ${stderr}` });
                }
            });
        } else {
            resolve({ ok: false, error: `Unsupported archive format: ${format}` });
        }
    });
}

/**
 * Creates a backup archive for a specific user handle.
 * @param {string} handle User account handle
 * @param {object} [options={}] Backup options
 * @returns {Promise<object>} Backup result
 */
export async function backupUser(handle, options = {}) {
    const startTime = Date.now();
    const directories = getUserDirectories(handle);

    if (!fs.existsSync(directories.root)) {
        throw new Error(`User directory for "${handle}" does not exist at "${directories.root}".`);
    }

    const format = (options.format || 'zip').toLowerCase();
    if (format !== 'zip' && format !== '7z') {
        throw new Error(`Unsupported backup format: "${format}". Supported formats are "zip" and "7z".`);
    }

    const timestamp = generateTimestamp();
    let outputFile;

    if (options.output) {
        const resolvedOutput = path.resolve(options.output);
        const ext = path.extname(resolvedOutput).toLowerCase();
        if (ext === '.zip' || ext === '.7z') {
            outputFile = resolvedOutput;
            fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        } else {
            fs.mkdirSync(resolvedOutput, { recursive: true });
            outputFile = path.join(resolvedOutput, `${handle}-${timestamp}.${format}`);
        }
    } else {
        const defaultOutputDir = directories.backups || path.join(directories.root, 'backups');
        fs.mkdirSync(defaultOutputDir, { recursive: true });
        outputFile = path.join(defaultOutputDir, `${handle}-${timestamp}.${format}`);
    }

    outputFile = path.resolve(outputFile);
    const compressionLevel = typeof options.level === 'number' ? options.level : 9;
    const partFile = path.resolve(`${outputFile}.part`);

    const meta = {
        app: 'SillyTavern',
        stVersion: getAppVersion(),
        createdAt: new Date().toISOString(),
        timestamp,
        handle,
        format,
        includeSecrets: Boolean(options.includeSecrets),
        compressionLevel,
    };

    let tempMetaDir = null;

    try {
        if (format === 'zip') {
            const archive = archiver('zip', {
                zlib: { level: compressionLevel },
            });

            const ignore = [
                'backups/**',
                '_cache/**',
                '**/backups/**',
                '**/_cache/**',
                `${METADATA_FOLDER}/**`,
                `**/${METADATA_FOLDER}/**`,
            ];

            if (!options.includeSecrets) {
                ignore.push(
                    SECRETS_FILE,
                    `**/${SECRETS_FILE}`,
                    'backups/secrets_migration_*.json',
                    '**/secrets_migration_*.json',
                );
            }

            await new Promise((resolve, reject) => {
                const outputStream = fs.createWriteStream(partFile);
                outputStream.on('close', resolve);
                outputStream.on('error', reject);
                archive.on('error', reject);
                archive.pipe(outputStream);

                // Inject backup metadata file under hidden prefix
                archive.append(JSON.stringify(meta, null, 2), { name: `${METADATA_FOLDER}/${METADATA_FILE}` });

                archive.glob('**/*', {
                    cwd: directories.root,
                    follow: false,
                    stat: true,
                    dot: true,
                    ignore,
                });

                archive.finalize();
            });
        } else if (format === '7z') {
            const custom7z = options.sevenZipPath || options['7z-path'];
            const sevenZipBin = findSevenZipBinary(custom7z);
            if (!sevenZipBin) {
                throw new Error('7-Zip binary not found in PATH or specified custom path.');
            }

            // Write metadata to temporary file
            tempMetaDir = path.resolve(directories.root, METADATA_FOLDER);
            fs.mkdirSync(tempMetaDir, { recursive: true });
            fs.writeFileSync(path.join(tempMetaDir, METADATA_FILE), JSON.stringify(meta, null, 2));

            const args = [
                'a',
                partFile,
                '*',
                `-mx=${compressionLevel}`,
                '-xr!backups',
                '-xr!_cache',
            ];

            if (!options.includeSecrets) {
                args.push(
                    `-xr!${SECRETS_FILE}`,
                    '-xr!secrets_migration_*.json',
                );
            }

            await new Promise((resolve, reject) => {
                const proc = spawn(sevenZipBin, args, {
                    cwd: path.resolve(directories.root),
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stderr = '';
                proc.stderr?.on('data', chunk => {
                    stderr += chunk.toString();
                });

                proc.on('error', reject);
                proc.on('close', code => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`7-Zip process exited with code ${code}: ${stderr}`));
                    }
                });
            });
        }

        // Atomically rename part file to final output path
        if (fs.existsSync(outputFile)) {
            fs.rmSync(outputFile, { force: true });
        }
        fs.renameSync(partFile, outputFile);

        let verified = undefined;
        if (options.verify) {
            const verifyRes = await verifyArchive(outputFile, format, options.sevenZipPath || options['7z-path']);
            if (!verifyRes.ok) {
                throw new Error(`Archive verification failed: ${verifyRes.error}`);
            }
            verified = true;
        }

        const stats = fs.statSync(outputFile);
        const elapsedMs = Date.now() - startTime;

        return {
            handle,
            filePath: outputFile,
            size: stats.size,
            format,
            elapsedMs,
            verified,
            meta,
        };
    } finally {
        if (fs.existsSync(partFile)) {
            try {
                fs.rmSync(partFile, { force: true });
            } catch {
                // ignore
            }
        }
        if (tempMetaDir && fs.existsSync(tempMetaDir)) {
            try {
                fs.rmSync(tempMetaDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    }
}

/**
 * Restores a user data directory from a backup archive.
 * @param {string} archivePath Path to backup archive (.zip or .7z)
 * @param {string} targetDir Destination directory to restore files into
 * @param {object} [options={}] Restore options
 * @returns {Promise<object>} Restore result
 */
export async function restoreUserBackup(archivePath, targetDir, options = {}) {
    const startTime = Date.now();
    const resolvedArchive = path.resolve(archivePath);

    if (!fs.existsSync(resolvedArchive)) {
        throw new Error(`Archive file does not exist at "${resolvedArchive}".`);
    }

    const resolvedTarget = path.resolve(targetDir);
    const format = path.extname(resolvedArchive).toLowerCase() === '.7z' ? '7z' : 'zip';

    if (fs.existsSync(resolvedTarget) && !options.force && !options.dryRun) {
        const entries = fs.readdirSync(resolvedTarget);
        if (entries.length > 0) {
            throw new Error(`Target directory "${resolvedTarget}" is not empty. Use --force to overwrite.`);
        }
    }

    let meta = null;
    let filesRestored = 0;

    if (format === 'zip') {
        await new Promise((resolve, reject) => {
            yauzl.open(resolvedArchive, { lazyEntries: true }, (err, zipfile) => {
                if (err) return reject(err);
                if (!zipfile) return resolve();

                zipfile.on('entry', (entry) => {
                    const fileName = entry.fileName;

                    if (fileName === `${METADATA_FOLDER}/${METADATA_FILE}`) {
                        zipfile.openReadStream(entry, (streamErr, readStream) => {
                            if (streamErr) return reject(streamErr);
                            let data = '';
                            readStream.on('data', chunk => { data += chunk.toString(); });
                            readStream.on('end', () => {
                                try {
                                    meta = JSON.parse(data);
                                } catch {
                                    // ignore JSON parse errors in metadata
                                }
                                zipfile.readEntry();
                            });
                            readStream.on('error', reject);
                        });
                        return;
                    }

                    if (fileName.startsWith(`${METADATA_FOLDER}/`)) {
                        zipfile.readEntry();
                        return;
                    }

                    const destPath = path.join(resolvedTarget, fileName);
                    if (!isPathUnderParent(resolvedTarget, destPath)) {
                        return reject(new Error(`Security violation: zip entry "${fileName}" points outside target directory.`));
                    }

                    if (options.dryRun) {
                        filesRestored++;
                        zipfile.readEntry();
                        return;
                    }

                    if (/\/$/.test(fileName)) {
                        fs.mkdirSync(destPath, { recursive: true });
                        zipfile.readEntry();
                    } else {
                        fs.mkdirSync(path.dirname(destPath), { recursive: true });
                        zipfile.openReadStream(entry, (streamErr, readStream) => {
                            if (streamErr) return reject(streamErr);
                            const writeStream = fs.createWriteStream(destPath);
                            writeStream.on('finish', () => {
                                filesRestored++;
                                zipfile.readEntry();
                            });
                            writeStream.on('error', reject);
                            readStream.on('error', reject);
                            readStream.pipe(writeStream);
                        });
                    }
                });

                zipfile.on('end', resolve);
                zipfile.on('error', reject);
                zipfile.readEntry();
            });
        });
    } else if (format === '7z') {
        const custom7z = options.sevenZipPath || options['7z-path'];
        const sevenZipBin = findSevenZipBinary(custom7z);
        if (!sevenZipBin) {
            throw new Error('7-Zip binary not found in PATH or specified custom path to restore 7z archive.');
        }

        if (options.dryRun) {
            await new Promise((resolve, reject) => {
                const proc = spawn(sevenZipBin, ['l', resolvedArchive], {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stdout = '';
                proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
                proc.on('error', reject);
                proc.on('close', code => {
                    if (code === 0) {
                        filesRestored = 1;
                        resolve();
                    } else {
                        reject(new Error(`7-Zip list failed with code ${code}`));
                    }
                });
            });
        } else {
            fs.mkdirSync(resolvedTarget, { recursive: true });
            await new Promise((resolve, reject) => {
                const proc = spawn(sevenZipBin, ['x', resolvedArchive, `-o${resolvedTarget}`, '-y'], {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
                proc.on('error', reject);
                proc.on('close', code => {
                    if (code === 0) {
                        filesRestored = 1;
                        resolve();
                    } else {
                        reject(new Error(`7-Zip extraction failed with code ${code}: ${stderr}`));
                    }
                });
            });

            const metaPath = path.join(resolvedTarget, METADATA_FOLDER, METADATA_FILE);
            if (fs.existsSync(metaPath)) {
                try {
                    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    fs.rmSync(path.join(resolvedTarget, METADATA_FOLDER), { recursive: true, force: true });
                } catch {
                    // ignore
                }
            }
        }
    }

    const elapsedMs = Date.now() - startTime;
    return {
        handle: meta?.handle || path.basename(resolvedTarget),
        archivePath: resolvedArchive,
        targetDir: resolvedTarget,
        meta,
        filesRestored,
        elapsedMs,
    };
}

/**
 * Entry function that backs up a single user or all users.
 * @param {object} [options={}] Backup options
 * @returns {Promise<object[]>} Array of backup results
 */
export async function runBackup(options = {}) {
    if (!globalThis.DATA_ROOT) {
        await initBackupEnvironment(options.config || './config.yaml');
    }

    let handles = [];
    if (options.all) {
        handles = await getAllUserHandles();
        if (handles.length === 0) {
            handles = [DEFAULT_USER.handle];
        }
    } else if (options.account) {
        handles = [options.account];
    } else {
        const allHandles = await getAllUserHandles();
        if (allHandles.length > 0) {
            handles = [allHandles[0]];
        } else {
            handles = [DEFAULT_USER.handle];
        }
    }

    const results = [];
    for (let i = 0; i < handles.length; i++) {
        const handle = handles[i];
        if (typeof options.onProgress === 'function') {
            options.onProgress({
                current: i + 1,
                total: handles.length,
                handle,
            });
        }
        const result = await backupUser(handle, options);
        results.push(result);
    }

    return results;
}

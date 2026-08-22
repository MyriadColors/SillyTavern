#!/usr/bin/env bun
import process from 'node:process';
import path from 'node:path';
import bytes from 'bytes';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { color, setConfigFilePath } from './src/util.js';
import type {
    ArchiveFormat,
    BackupOptions,
    BackupResult,
    BackupInspection,
    RestoreOptions,
    RestoreResult,
} from './src/backup.js';

export type {
    ArchiveFormat,
    BackupOptions,
    BackupResult,
    BackupInspection,
    RestoreOptions,
    RestoreResult,
};

const parser = yargs(hideBin(process.argv))
    .command(
        ['$0 [account]', 'backup [account]'],
        'Backup SillyTavern user data',
        (y) => {
            return y
                .positional('account', {
                    type: 'string',
                    describe: 'User account handle to backup',
                })
                .option('all', {
                    alias: 'a',
                    type: 'boolean',
                    describe: 'Backup all user accounts',
                    default: false,
                })
                .option('format', {
                    alias: 'f',
                    type: 'string',
                    describe: 'Archive format: zip or 7z',
                    choices: ['zip', '7z'] as const,
                    default: 'zip' as const,
                })
                .option('level', {
                    alias: 'l',
                    type: 'number',
                    describe: 'Compression level (0-9)',
                    default: 9,
                })
                .option('output', {
                    alias: 'o',
                    type: 'string',
                    describe: 'Output directory or file path',
                })
                .option('include-secrets', {
                    alias: 's',
                    type: 'boolean',
                    describe: 'Include secrets.json in the backup',
                    default: false,
                })
                .option('config', {
                    type: 'string',
                    describe: 'Path to config.yaml file',
                    default: './config.yaml',
                })
                .option('7z-path', {
                    type: 'string',
                    describe: 'Custom path to 7-Zip executable',
                })
                .option('verify', {
                    type: 'boolean',
                    describe: 'Verify archive integrity after creation',
                    default: true,
                })
                .option('dry-run', {
                    alias: ['n', 'list'],
                    type: 'boolean',
                    describe: 'List files and estimated sizes without creating archive',
                    default: false,
                })
                .option('quiet', {
                    alias: 'q',
                    type: 'boolean',
                    describe: 'Suppress non-error logs',
                    default: false,
                })
                .option('json', {
                    type: 'boolean',
                    describe: 'Output structured JSON',
                    default: false,
                })
                .option('progress', {
                    alias: 'p',
                    type: 'boolean',
                    describe: 'Show backup progress',
                    default: true,
                });
        },
    )
    .command(
        'restore <archive>',
        'Restore SillyTavern user data from a backup archive',
        (y) => {
            return y
                .positional('archive', {
                    type: 'string',
                    describe: 'Path to backup archive (.zip or .7z)',
                    demandOption: true,
                })
                .option('account', {
                    type: 'string',
                    describe: 'Target account handle (inferred from archive if omitted)',
                })
                .option('target', {
                    type: 'string',
                    describe: 'Target directory to restore files into (defaults to user data directory)',
                })
                .option('force', {
                    type: 'boolean',
                    describe: 'Overwrite existing user directory contents',
                    default: false,
                })
                .option('dry-run', {
                    alias: 'n',
                    type: 'boolean',
                    describe: 'List archive contents without writing to disk',
                    default: false,
                })
                .option('config', {
                    type: 'string',
                    describe: 'Path to config.yaml file',
                    default: './config.yaml',
                })
                .option('7z-path', {
                    type: 'string',
                    describe: 'Custom path to 7-Zip executable',
                })
                .option('quiet', {
                    alias: 'q',
                    type: 'boolean',
                    describe: 'Suppress non-error logs',
                    default: false,
                })
                .option('json', {
                    type: 'boolean',
                    describe: 'Output structured JSON',
                    default: false,
                });
        },
    )
    .strict()
    .help('help')
    .alias('help', 'h')
    .epilogue('Examples:\n  bun backup.ts\n  bun backup.ts admin --format zip\n  bun backup.ts --all --format 7z --output ./my-backups\n  bun backup.ts --dry-run\n  bun backup.ts restore ./admin-backup.zip --force');

async function main(): Promise<void> {
    const argv = await parser.parseAsync();
    const isJson = Boolean(argv.json);
    const isQuiet = Boolean(argv.quiet);
    const configPath = typeof argv.config === 'string' ? argv.config : './config.yaml';

    if (isJson) {
        console.log = console.error;
    }

    const log = (msg: string): void => {
        if (isJson) {
            process.stderr.write(msg + '\n');
        } else if (!isQuiet) {
            console.log(msg);
        }
    };

    try {
        setConfigFilePath(configPath);
        const {
            initBackupEnvironment,
            runBackup,
            inspectUserBackup,
            restoreUserBackup,
        } = await import('./src/backup.js');

        const { getUserDirectories, getAllUserHandles } = await import('./src/users.js');
        const { DEFAULT_USER } = await import('./src/constants.js');

        const command = argv._[0];

        if (command === 'restore') {
            const archivePath = String(argv.archive);
            log(color.cyan('Initializing backup environment for restore...'));
            const env = await initBackupEnvironment(configPath);

            let targetDirectory = typeof argv.target === 'string' ? argv.target : undefined;
            if (!targetDirectory) {
                const account = typeof argv.account === 'string' ? argv.account : undefined;
                if (account) {
                    targetDirectory = getUserDirectories(account).root;
                } else {
                    // Try to infer handle from archive filename
                    const baseName = path.basename(archivePath).replace(/[-_]\d{8}[-_]\d{6}\.(zip|7z)$/i, '');
                    const resolvedBase = baseName.replace(/\.(zip|7z)$/i, '');
                    targetDirectory = path.join(env.dataRoot, resolvedBase || DEFAULT_USER.handle);
                }
            }

            log(color.cyan(`Restoring archive: ${color.yellow(archivePath)} -> ${color.cyan(targetDirectory)}...`));

            const restoreRes = await restoreUserBackup(archivePath, targetDirectory, {
                force: Boolean(argv.force),
                dryRun: Boolean(argv['dry-run']),
                sevenZipPath: typeof argv['7z-path'] === 'string' ? argv['7z-path'] : undefined,
            });

            if (isJson) {
                process.stdout.write(JSON.stringify({ command: 'restore', status: 'success', result: restoreRes }, null, 2) + '\n');
            } else {
                log(color.green(`\nRestore completed successfully in ${restoreRes.elapsedMs}ms!`));
                log(`  ${color.magenta('•')} Account:     ${color.bold(restoreRes.handle)}`);
                log(`  ${color.magenta('•')} Archive:     ${color.cyan(restoreRes.archivePath)}`);
                log(`  ${color.magenta('•')} Destination: ${color.cyan(restoreRes.targetDir)}`);
                log(`  ${color.magenta('•')} Files:       ${color.yellow(String(restoreRes.filesRestored))}`);
                if (restoreRes.meta) {
                    log(`  ${color.magenta('•')} App Version: ${color.gray(restoreRes.meta.stVersion)} (Created: ${restoreRes.meta.createdAt})`);
                }
                log('');
            }
            return;
        }

        // Backup / Dry-run command
        const account = typeof argv.account === 'string' ? argv.account : undefined;
        if (!account && !argv.all) {
            console.error(color.red('Specify an account or use --all'));
            process.exit(1);
        }

        log(color.cyan('Initializing backup environment...'));
        await initBackupEnvironment(configPath);

        let handles: string[] = [];
        if (argv.all) {
            handles = await getAllUserHandles();
            if (handles.length === 0) {
                handles = [DEFAULT_USER.handle];
            }
        } else if (account) {
            handles = [account];
        } else {
            const allHandles = await getAllUserHandles();
            handles = allHandles.length > 0 ? [allHandles[0] as string] : [DEFAULT_USER.handle];
        }

        if (argv['dry-run']) {
            const inspections: BackupInspection[] = [];
            for (const h of handles) {
                const ins = await inspectUserBackup(h, {
                    includeSecrets: Boolean(argv['include-secrets']),
                });
                inspections.push(ins);
            }

            if (isJson) {
                process.stdout.write(JSON.stringify({ command: 'inspect', status: 'success', results: inspections }, null, 2) + '\n');
            } else {
                log(color.cyan('\n[Dry-Run] Target Backup Inspection Summary:'));
                for (const ins of inspections) {
                    const formattedTotal = bytes(ins.totalBytes) ?? `${ins.totalBytes} B`;
                    log(`\n  ${color.magenta('•')} Account:    ${color.bold(ins.handle)} (${color.gray(ins.rootDir)})`);
                    log(`    Files:      ${color.yellow(String(ins.fileCount))}`);
                    log(`    Total Size: ${color.green(formattedTotal)}`);
                    log('    Breakdown:');
                    for (const [cat, data] of Object.entries(ins.byCategory)) {
                        const catFormatted = bytes(data.bytes) ?? `${data.bytes} B`;
                        log(`      - ${color.bold(cat)}: ${color.yellow(String(data.count))} file(s), ${color.green(catFormatted)}`);
                    }
                }
                log('');
            }
            return;
        }

        const level = Math.max(0, Math.min(9, Math.floor(typeof argv.level === 'number' ? argv.level : 9)));
        const format = (argv.format as ArchiveFormat) || 'zip';
        const showProgress = Boolean(argv.progress) && !isQuiet;
        const startTime = Date.now();

        log(color.cyan(`Starting backup (format: ${color.yellow(format)}, level: ${color.yellow(String(level))})...`));

        const backupOptions: BackupOptions = {
            account,
            all: Boolean(argv.all),
            format,
            level,
            output: typeof argv.output === 'string' ? argv.output : undefined,
            includeSecrets: Boolean(argv['include-secrets']),
            sevenZipPath: typeof argv['7z-path'] === 'string' ? argv['7z-path'] : undefined,
            verify: Boolean(argv.verify),
            config: configPath,
            onProgress: showProgress
                ? (p) => {
                    const elapsed = Date.now() - startTime;
                    const eta = p.total > 1 && p.current > 1
                        ? Math.round(((elapsed / (p.current - 1)) * (p.total - p.current + 1)) / 1000)
                        : 0;
                    const etaStr = eta > 0 ? ` (ETA: ~${eta}s)` : '';
                    log(color.gray(`[${p.current}/${p.total}] Backing up account "${color.bold(p.handle)}"...${etaStr}`));
                }
                : undefined,
        };

        const results = await runBackup(backupOptions);

        if (isJson) {
            process.stdout.write(JSON.stringify({ command: 'backup', status: 'success', results }, null, 2) + '\n');
        } else {
            log(color.green(`\nBackup completed successfully! (${results.length} account(s) backed up)\n`));
            for (const res of results) {
                const formattedSize = bytes(res.size) ?? `${res.size} B`;
                log(`  ${color.magenta('•')} Account:     ${color.bold(res.handle)}`);
                log(`    Format:      ${color.yellow(res.format.toUpperCase())}`);
                log(`    Size:        ${color.green(formattedSize)}`);
                log(`    Destination: ${color.cyan(res.filePath)}`);
                log(`    Verified:    ${res.verified ? color.green('YES') : color.gray('SKIPPED')}`);
                log(`    Elapsed:     ${color.gray(`${res.elapsedMs}ms`)}\n`);
            }
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isJson) {
            process.stdout.write(JSON.stringify({ status: 'error', error: errorMessage }, null, 2) + '\n');
        } else {
            console.error(color.red(`Backup failed: ${errorMessage}`));
        }
        process.exit(1);
    }
}

main();

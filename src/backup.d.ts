export type ArchiveFormat = 'zip' | '7z';

export interface BackupMeta {
    app: string;
    stVersion: string;
    createdAt: string;
    timestamp: string;
    handle: string;
    format: ArchiveFormat;
    includeSecrets: boolean;
    compressionLevel: number;
}

export interface BackupInspection {
    handle: string;
    rootDir: string;
    fileCount: number;
    totalBytes: number;
    byCategory: Record<string, { count: number; bytes: number }>;
}

export interface VerifyResult {
    ok: boolean;
    error?: string;
}

export interface RestoreOptions {
    force?: boolean;
    dryRun?: boolean;
    sevenZipPath?: string;
    '7z-path'?: string;
}

export interface RestoreResult {
    handle: string;
    archivePath: string;
    targetDir: string;
    meta: BackupMeta | null;
    filesRestored: number;
    elapsedMs: number;
}

export interface BackupProgress {
    current: number;
    total: number;
    handle: string;
}

export interface BackupOptions {
    account?: string;
    all?: boolean;
    format?: ArchiveFormat;
    level?: number;
    output?: string;
    includeSecrets?: boolean;
    sevenZipPath?: string;
    '7z-path'?: string;
    config?: string;
    verify?: boolean;
    onProgress?: (progress: BackupProgress) => void;
}

export interface BackupResult {
    handle: string;
    filePath: string;
    size: number;
    format: ArchiveFormat;
    elapsedMs: number;
    verified?: boolean;
    meta: BackupMeta;
}

export function findSevenZipBinary(customPath?: string): string | null;
export function initBackupEnvironment(configPath?: string): Promise<{ config: Record<string, unknown>; dataRoot: string }>;
export function walkDirAsync(rootDir: string, ignorePatterns?: string[]): Promise<{ fileCount: number; totalBytes: number; byCategory: Record<string, { count: number; bytes: number }> }>;
export function inspectUserBackup(handle: string, options?: BackupOptions): Promise<BackupInspection>;
export function verifyArchive(filePath: string, format?: ArchiveFormat, sevenZipBin?: string): Promise<VerifyResult>;
export function backupUser(handle: string, options?: BackupOptions): Promise<BackupResult>;
export function restoreUserBackup(archivePath: string, targetDir: string, options?: RestoreOptions): Promise<RestoreResult>;
export function runBackup(options?: BackupOptions): Promise<BackupResult[]>;

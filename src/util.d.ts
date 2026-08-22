import type { ChalkInstance } from 'chalk';

export const color: ChalkInstance;
export function setConfigFilePath(configFilePath: string): void;
export function getConfig(): Record<string, unknown>;
export function keyToEnv(key: string): string;

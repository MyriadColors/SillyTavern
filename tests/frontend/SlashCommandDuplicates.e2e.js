import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('SlashCommandDuplicates', () => {
    test.beforeEach(testSetup.awaitST);

    test('first registration wins, duplicate is rejected and core command kept', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { SlashCommandParser } = await import('./scripts/slash-commands/SlashCommandParser.js');
            const { SlashCommand } = await import('./scripts/slash-commands/SlashCommand.js');
            const { executeSlashCommandsWithOptions } = await import('./scripts/slash-commands.js');

            const name = `dup-guard-${Date.now()}`;
            const first = SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name,
                callback: () => 'first',
                helpString: 'duplicate guard probe',
            }));
            const second = SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name,
                callback: () => 'second',
                helpString: 'duplicate guard probe (rejected)',
            }));
            const output = (await executeSlashCommandsWithOptions(`/${name}`)).pipe;
            const recorded = SlashCommandParser.duplicateSlashCommands.some(x => x.name === name);
            return { first, second, output, recorded };
        });

        expect(result.first).toBe(true);
        expect(result.second).toBe(false);
        expect(result.output).toBe('first');
        expect(result.recorded).toBe(true);
    });

    test('alias colliding with an existing command is rejected', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { SlashCommandParser } = await import('./scripts/slash-commands/SlashCommandParser.js');
            const { SlashCommand } = await import('./scripts/slash-commands/SlashCommand.js');

            const name = `dup-base-${Date.now()}`;
            const base = SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name,
                callback: () => 'base',
                helpString: 'duplicate guard probe',
            }));
            const aliasCollision = SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: `${name}-other`,
                aliases: [name],
                callback: () => 'hijack',
                helpString: 'duplicate guard probe (rejected)',
            }));
            return { base, aliasCollision };
        });

        expect(result.base).toBe(true);
        expect(result.aliasCollision).toBe(false);
    });
});

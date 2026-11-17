import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const html = fs.readFileSync(indexPath, 'utf8');
const lines = html.split('\n');

const SOURCE_ATTRIBUTE = 'data-source="';

/**
 * Extracts the comma-separated data-source values from a markup line.
 * @param {string} line Markup line
 * @returns {string[]} Source identifiers, empty when the line has no data-source attribute.
 */
function readSourceValues(line) {
    const start = line.indexOf(SOURCE_ATTRIBUTE);
    if (start === -1) {
        return [];
    }
    const valueStart = start + SOURCE_ATTRIBUTE.length;
    const valueEnd = line.indexOf('"', valueStart);
    if (valueEnd === -1) {
        return [];
    }
    return line.slice(valueStart, valueEnd).split(',');
}

/**
 * Collects every data-source value list present in the markup.
 * @returns {string[][]} One array of source identifiers per data-source attribute.
 */
function collectSourceLists() {
    const lists = [];
    for (const line of lines) {
        const values = readSourceValues(line);
        if (values.length > 0) {
            lists.push(values);
        }
    }
    return lists;
}

/**
 * Finds the data-source values of the media inlining block.
 * @returns {string[]} Source identifiers gating the media inlining toggle.
 */
function findMediaInliningSources() {
    const labelIndex = lines.findIndex(line => line.includes('id="openai_media_inlining"'));
    expect(labelIndex).toBeGreaterThan(0);
    for (let index = labelIndex; index >= 0; index--) {
        const values = readSourceValues(lines[index]);
        if (values.length > 0) {
            return values;
        }
    }
    return [];
}

describe('provider visibility markup', () => {
    test('media inlining lists both DigitalOcean and DeepSeek', () => {
        const sources = findMediaInliningSources();
        expect(sources.includes('digitalocean')).toBe(true);
        expect(sources.includes('deepseek')).toBe(true);
    });

    test('DigitalOcean-only blocks are still present', () => {
        const singleProviderBlocks = lines.filter(line => line.includes('data-source="digitalocean"'));
        expect(singleProviderBlocks.length).toBe(2);
    });

    test('at least twelve source lists mention DigitalOcean', () => {
        const matching = collectSourceLists().filter(values => values.includes('digitalocean'));
        expect(matching.length).toBeGreaterThanOrEqual(12);
    });
});

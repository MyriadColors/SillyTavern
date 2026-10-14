import { describe, test, expect } from '@jest/globals';
import { parseChunkDelimiter, parseCustomDelimiters, splitSemantic } from '../public/scripts/chunking.js';

describe('parseChunkDelimiter', () => {
    test('parses a literal separator', () => {
        expect(parseChunkDelimiter('---')).toMatchObject({ literal: '---' });
    });

    test('treats regex-looking lines as plain literals', () => {
        expect(parseChunkDelimiter('/^---+$/m')).toMatchObject({ literal: '/^---+$/m' });
    });

    test('supports newline escapes for invisible separators', () => {
        expect(parseChunkDelimiter('\\n##')).toMatchObject({ literal: '\n##', wholeLine: false });
    });

    test('parses the line: prefix for whole-line matching', () => {
        expect(parseChunkDelimiter('line:---')).toMatchObject({ literal: '---', wholeLine: true });
    });

    test('returns null for a bare line: prefix', () => {
        expect(parseChunkDelimiter('line:')).toBeNull();
    });

    test('returns null for blank lines', () => {
        expect(parseChunkDelimiter('')).toBeNull();
        expect(parseChunkDelimiter('   ')).toBeNull();
    });
});

describe('parseCustomDelimiters', () => {
    test('parses one delimiter per line in priority order', () => {
        const parsed = parseCustomDelimiters('---\n\\n##\n');
        expect(parsed.map(x => x.literal)).toEqual(['---', '\n##']);
    });
});

describe('splitSemantic', () => {
    test('respects lore separators instead of slicing mid-event', () => {
        const input = 'Alice met Bob at dawn.\n---\nCarol left the tavern at dusk.';
        const chunks = splitSemantic(input, 30, parseCustomDelimiters('---'));
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain('Alice met Bob');
        expect(chunks[1]).toContain('Carol left');
    });

    test('whole-line mode splits separators but leaves mid-text matches intact', () => {
        const input = 'Alice hesitated---then ran.\n---\nCarol left the tavern.';
        const chunks = splitSemantic(input, 500, parseCustomDelimiters('line:---'), { onlyCustom: true });
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain('Alice hesitated---then ran.');
        expect(chunks[1]).toContain('Carol left the tavern.');
    });

    test('bare literals still split mid-text occurrences', () => {
        const input = 'Alice hesitated---then ran.';
        const chunks = splitSemantic(input, 500, parseCustomDelimiters('---'), { onlyCustom: true });
        expect(chunks).toEqual(['Alice hesitated', 'then ran.']);
    });

    test('splits on literal markdown headers', () => {
        const input = '# Lore\nDragons live here.\n## Elves\nElves live there.';
        const chunks = splitSemantic(input, 30, parseCustomDelimiters('\\n##'));
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(chunks.join('\n')).toContain('Dragons live here.');
    });

    test('sub-splits oversized custom sections even in exclusive mode', () => {
        const big = 'word '.repeat(500);
        const input = `${big}\n---\nshort tail`;
        const chunks = splitSemantic(input, 200, parseCustomDelimiters('---'), { onlyCustom: true });
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(200);
        }
    });

    test('exclusive mode never merges across custom boundaries', () => {
        const input = 'Alpha event.\n---\nBeta event.';
        const chunks = splitSemantic(input, 500, parseCustomDelimiters('---'), { onlyCustom: true });
        expect(chunks).toEqual(['Alpha event.', 'Beta event.']);
    });

    test('never emits empty chunks', () => {        const chunks = splitSemantic('\n---\n\n---\ntext\n---\n', 500, parseCustomDelimiters('---'));
        expect(chunks).toEqual(['text']);
    });

    test('falls back to size-based splitting without custom boundaries', () => {
        const chunks = splitSemantic('aaa bbb ccc', 5, []);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(5);
        }
    });
});

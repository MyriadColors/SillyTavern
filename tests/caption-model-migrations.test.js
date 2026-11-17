import { describe, test, expect } from '@jest/globals';
import { ANTHROPIC_MODEL_MIGRATIONS, GOOGLE_MODEL_MIGRATIONS, resolveModelMigration } from '../public/scripts/extensions/caption/model-migrations.js';

describe('resolveModelMigration', () => {
    test('maps every retired Anthropic id to a surviving model', () => {
        for (const [retired, survivor] of ANTHROPIC_MODEL_MIGRATIONS) {
            expect(resolveModelMigration('anthropic', retired)).toBe(survivor);
        }
    });

    test('maps retired Anthropic ids to currently listed caption options', () => {
        const survivors = new Set(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
        for (const survivor of ANTHROPIC_MODEL_MIGRATIONS.values()) {
            expect(survivors.has(survivor)).toBe(true);
        }
    });

    test('maps every retired Google id', () => {
        for (const [retired, survivor] of GOOGLE_MODEL_MIGRATIONS) {
            expect(resolveModelMigration('google', retired)).toBe(survivor);
        }
    });

    test('treats Vertex AI ids as Google ids', () => {
        expect(resolveModelMigration('vertexai', 'gemini-2.0-flash')).toBe('gemini-3.8-flash');
    });

    test('passes unknown Anthropic ids through unchanged', () => {
        expect(resolveModelMigration('anthropic', 'claude-opus-4-5')).toBe('claude-opus-4-5');
        expect(resolveModelMigration('anthropic', 'claude-fable-5')).toBe('claude-fable-5');
    });

    test('passes ids of unrelated APIs through unchanged', () => {
        expect(resolveModelMigration('openai', 'claude-opus-4-0')).toBe('claude-opus-4-0');
        expect(resolveModelMigration('openai', 'gemini-2.0-flash')).toBe('gemini-2.0-flash');
        expect(resolveModelMigration(undefined, 'gemini-2.0-flash')).toBe('gemini-2.0-flash');
    });

    test('keeps the Google migration table unchanged', () => {
        expect(GOOGLE_MODEL_MIGRATIONS.size).toBe(8);
        expect(GOOGLE_MODEL_MIGRATIONS.get('gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite');
        expect(GOOGLE_MODEL_MIGRATIONS.get('gemini-2.5-flash-image-preview')).toBe('gemini-2.5-flash-image');
        expect(GOOGLE_MODEL_MIGRATIONS.get('gemini-3.5-flash')).toBe('gemini-3.6-flash');
    });

    test('covers thirteen retired Anthropic ids', () => {
        expect(ANTHROPIC_MODEL_MIGRATIONS.size).toBe(13);
    });
});

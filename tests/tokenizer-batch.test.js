import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

process.env.SILLYTAVERN_ALLOWKEYSEXPOSURE = 'false';
process.env.SILLYTAVERN_ENABLEDOWNLOADABLETOKENIZERS = 'true';

const originalCwd = process.cwd();
beforeAll(() => process.chdir(path.resolve(originalCwd, '..')));
afterAll(() => process.chdir(originalCwd));

describe('Tokenizer batch counting endpoint (/openai/count)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;

    beforeAll(async () => {
        globalThis.DATA_ROOT = path.join(path.resolve(originalCwd, '..'), 'data');
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/tokenizers.js');
        const app = express();
        app.use(express.json());
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    test('preserves backward compatibility for standard messages array', async () => {
        const body = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello!' },
        ];
        const res = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.token_count).toBe('number');
        expect(data.token_count).toBeGreaterThan(0);
        expect(data.counts).toBeUndefined();
    });

    test('handles batch object payload with array of strings', async () => {
        const batch = ['Hello world', 'This is a test message for batch counting.'];
        const res = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.token_count).toBe('number');
        expect(Array.isArray(data.counts)).toBe(true);
        expect(data.counts.length).toBe(2);
        expect(data.counts[0]).toBeGreaterThan(0);
        expect(data.counts[1]).toBeGreaterThan(0);
        expect(data.token_count).toBe(data.counts[0] + data.counts[1]);
    });

    test('handles top-level plain array of strings', async () => {
        const strings = ['First entry', 'Second entry', 'Third entry'];
        const res = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(strings),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.counts)).toBe(true);
        expect(data.counts.length).toBe(3);
        expect(data.token_count).toBe(data.counts.reduce((a, b) => a + b, 0));
    });

    test('includes role/message formatting tokens when batch item is an object with role', async () => {
        const textContent = 'Hello world';
        const rawStringPayload = { batch: [textContent] };
        const roleMessagePayload = { batch: [{ role: 'user', content: textContent }] };

        const res1 = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawStringPayload),
        });
        const data1 = await res1.json();

        const res2 = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(roleMessagePayload),
        });
        const data2 = await res2.json();

        expect(data2.counts[0]).toBeGreaterThan(data1.counts[0]);
        // For gpt-4o, tokensPerMessage is 3
        expect(data2.counts[0] - data1.counts[0]).toBe(3);
    });

    test('handles mixed items in batch and handles graceful fallback for invalid items', async () => {
        const mixed = ['Plain string', { role: 'assistant', content: 'Assistant response' }, null];
        const res = await fetch(`${baseUrl}/openai/count?model=gpt-4o`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: mixed }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.counts)).toBe(true);
        expect(data.counts.length).toBe(3);
        expect(data.counts[0]).toBeGreaterThan(0);
        expect(data.counts[1]).toBeGreaterThan(0);
        expect(data.counts[2]).toBe(0); // null counts as 0
    });
});

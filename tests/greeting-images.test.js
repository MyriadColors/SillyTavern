import { describe, test, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
}));

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

jest.unstable_mockModule('image-size', () => ({
    imageSize: jest.fn(() => ({ type: 'png' })),
}));

const mockConfig = {
    'greetingImagePrefetch.enabled': true,
    'greetingImagePrefetch.allowedDomains': ['example.com', '.imgur.com', 'catbox.moe', 'discordapp.com'],
    'greetingImagePrefetch.allowSubdomains': true,
    'greetingImagePrefetch.allowNonStandardPorts': false,
    'greetingImagePrefetch.maxFileSize': '20mb',
    'greetingImagePrefetch.maxFilesPerRequest': 16,
    'greetingImagePrefetch.timeout': 15000,
};

const originalUtil = await import('../src/util.js');
jest.unstable_mockModule('../src/util.js', () => ({
    ...originalUtil,
    getConfigValue: jest.fn((key, def) => {
        if (key in mockConfig) return mockConfig[key];
        return def;
    }),
}));

let router;
let server;
let baseUrl;

beforeAll(async () => {
    ({ apiRouter: router } = await import('../src/endpoints/greeting-images.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    const mockDir = path.join(os.tmpdir(), 'sillytavern-test-greeting-images-' + Date.now());
    fs.mkdirSync(mockDir, { recursive: true });
    app.use((req, res, next) => {
        req.user = { directories: { greetingImages: mockDir } };
        next();
    });
    app.use('/api/greeting-images', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
        ok: true,
        headers: {
            get: (name) => {
                if (name === 'content-type') return 'image/png';
                if (name === 'content-length') return '1024';
                return null;
            }
        },
        body: [Buffer.from('mock image data')],
    });
    jest.clearAllMocks();
});

function prefetch(urls) {
    return fetch(`${baseUrl}/api/greeting-images/prefetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
    });
}

describe('POST /api/greeting-images/prefetch', () => {
    test('rejects missing or invalid urls format', async () => {
        const response = await fetch(`${baseUrl}/api/greeting-images/prefetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(response.status).toBe(400);
    });

    test('rejects disallowed domains', async () => {
        const response = await prefetch(['https://not-allowed.com/image.png']);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.results['https://not-allowed.com/image.png'].status).toBe('rejected');
        expect(data.results['https://not-allowed.com/image.png'].reason).toMatch(/allowlist/i);
    });

    test('accepts exact domains', async () => {
        const url = 'https://example.com/image.png';
        const response = await prefetch([url]);
        const data = await response.json();
        if (data.results[url].status === 'error') console.log(data.results[url].reason);
        expect(data.results[url].status).toBe('downloaded');
        expect(fetchMock).toHaveBeenCalled();
    });

    test('accepts subdomains via suffix match', async () => {
        const url = 'https://i.imgur.com/image.png';
        const response = await prefetch([url]);
        const data = await response.json();
        expect(data.results[url].status).toBe('downloaded');
        expect(fetchMock).toHaveBeenCalled();
    });

    test('rejects bare IPs', async () => {
        const response = await prefetch(['http://10.0.0.1/image.png', 'http://[::1]/image.png']);
        const data = await response.json();
        expect(data.results['http://10.0.0.1/image.png'].status).toBe('rejected');
        expect(data.results['http://[::1]/image.png'].status).toBe('rejected');
    });

    test('rejects non-standard ports', async () => {
        const url = 'https://example.com:8443/image.png';
        const response = await prefetch([url]);
        const data = await response.json();
        expect(data.results[url].status).toBe('rejected');
    });

    test('handles content-type mismatch', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            headers: { get: () => 'text/html' },
            body: [Buffer.from('<html></html>')],
        });
        const url = 'https://example.com/not-image.html';
        const response = await prefetch([url]);
        const data = await response.json();
        expect(data.results[url].status).toBe('rejected');
    });

    test('supports new domains requested by the user: catbox.moe and discordapp.com', async () => {
        const url1 = 'https://files.catbox.moe/image.png';
        const url2 = 'https://cdn.discordapp.com/attachments/123/456/image.png';
        const response = await prefetch([url1, url2]);
        const data = await response.json();
        expect(data.results[url1].status).toBe('downloaded');
        expect(data.results[url2].status).toBe('downloaded');
    });
});

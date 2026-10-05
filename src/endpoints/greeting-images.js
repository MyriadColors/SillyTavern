import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import fetch from 'node-fetch';
import ipRegex from 'ip-regex';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { imageSize } from 'image-size';

import { getConfigValue } from '../util.js';
import { getUntrustedRequestAgent } from '../private-request-filter.js';

export const publicRouter = express.Router();
export const apiRouter = express.Router();

const EXT_MIME_MAP = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'tif': 'image/tiff',
    'tiff': 'image/tiff',
};
const ALLOWED_EXTENSIONS = Object.keys(EXT_MIME_MAP);

function parseSize(sizeStr) {
    if (typeof sizeStr === 'number') return sizeStr;
    const match = String(sizeStr).match(/^(\d+)(kb|mb|gb|b)?$/i);
    if (!match) return 20 * 1024 * 1024;
    const num = parseInt(match[1], 10);
    const unit = match[2]?.toLowerCase();
    switch (unit) {
        case 'kb': return num * 1024;
        case 'mb': return num * 1024 * 1024;
        case 'gb': return num * 1024 * 1024 * 1024;
        default: return num;
    }
}

function getSettings() {
    return {
        enabled: getConfigValue('greetingImagePrefetch.enabled', true, 'boolean'),
        allowedDomains: getConfigValue('greetingImagePrefetch.allowedDomains', [], 'array'),
        allowSubdomains: getConfigValue('greetingImagePrefetch.allowSubdomains', true, 'boolean'),
        allowNonStandardPorts: getConfigValue('greetingImagePrefetch.allowNonStandardPorts', false, 'boolean'),
        maxFileSize: parseSize(getConfigValue('greetingImagePrefetch.maxFileSize', '20mb', 'string')),
        maxFilesPerRequest: getConfigValue('greetingImagePrefetch.maxFilesPerRequest', 16, 'number'),
        timeout: getConfigValue('greetingImagePrefetch.timeout', 15000, 'number'),
    };
}

function isDomainAllowed(hostname, allowedDomains, allowSubdomains) {
    if (allowedDomains.length === 0) return false;
    for (const domain of allowedDomains) {
        if (hostname === domain) return true;
        if (allowSubdomains && (domain.startsWith('.') ? hostname.endsWith(domain) : hostname.endsWith(`.${domain}`))) {
            return true;
        }
    }
    return false;
}

apiRouter.post('/prefetch', async (req, res) => {
    const settings = getSettings();
    if (!settings.enabled) {
        return res.json({ enabled: false, results: {} });
    }

    let { urls } = req.body;
    if (!Array.isArray(urls)) {
        return res.status(400).json({ error: 'urls must be an array' });
    }

    urls = urls.slice(0, settings.maxFilesPerRequest);
    const results = {};
    const destDir = req.user.directories.greetingImages;

    const processUrl = async (urlStr) => {
        try {
            if (urlStr.length > 2048) {
                return { status: 'rejected', reason: 'URL too long' };
            }

            let urlObj;
            try {
                urlObj = new URL(urlStr);
            } catch (e) {
                return { status: 'rejected', reason: 'Invalid URL format' };
            }

            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                return { status: 'rejected', reason: 'Invalid protocol' };
            }

            if (urlObj.port !== '' && !settings.allowNonStandardPorts) {
                return { status: 'rejected', reason: 'Non-standard ports not allowed' };
            }

            const bareHostname = urlObj.hostname.replace(/^\[|\]$/g, '');
            if (ipRegex.v4({ exact: true }).test(bareHostname) || ipRegex.v6({ exact: true }).test(bareHostname)) {
                return { status: 'rejected', reason: 'Bare IP literals not allowed' };
            }

            if (urlObj.hostname === 'localhost' || urlObj.hostname.endsWith('.localhost')) {
                return { status: 'rejected', reason: 'Localhost not allowed' };
            }

            if (!isDomainAllowed(urlObj.hostname, settings.allowedDomains, settings.allowSubdomains)) {
                return { status: 'rejected', reason: 'Domain not in allowlist' };
            }

            const urlHash = crypto.createHash('sha256').update(urlStr).digest('hex').slice(0, 32);

            // Check cache - read dir to see if hash.* exists
            if (fs.existsSync(destDir)) {
                const files = fs.readdirSync(destDir);
                const existing = files.find(f => f.startsWith(`${urlHash}.`));
                if (existing) {
                    return { status: 'cached', path: `/greeting-images/${existing}` };
                }
            } else {
                fs.mkdirSync(destDir, { recursive: true });
            }

            const fetchController = new AbortController();
            const timeoutId = setTimeout(() => fetchController.abort(), settings.timeout);

            let fetchRes;
            try {
                fetchRes = await fetch(urlStr, {
                    agent: getUntrustedRequestAgent(),
                    redirect: 'follow',
                    signal: fetchController.signal,
                    headers: { 'Accept': 'image/*', 'User-Agent': 'SillyTavern' },
                });
            } catch (err) {
                clearTimeout(timeoutId);
                return { status: 'error', reason: err.message };
            }

            if (!fetchRes.ok) {
                clearTimeout(timeoutId);
                return { status: 'error', reason: `HTTP ${fetchRes.status}` };
            }

            const contentType = String(fetchRes.headers.get('content-type')).toLowerCase();
            if (!contentType.startsWith('image/')) {
                clearTimeout(timeoutId);
                return { status: 'rejected', reason: 'Content-Type must be image/*' };
            }

            const declaredLength = parseInt(fetchRes.headers.get('content-length'), 10);
            if (!isNaN(declaredLength) && declaredLength > settings.maxFileSize) {
                clearTimeout(timeoutId);
                return { status: 'rejected', reason: 'Content-Length exceeds max file size limit' };
            }

            const chunks = [];
            let totalBytes = 0;
            let streamError = null;

            try {
                for await (const chunk of fetchRes.body) {
                    totalBytes += chunk.length;
                    if (totalBytes > settings.maxFileSize) {
                        fetchController.abort();
                        streamError = 'Stream exceeded max file size limit';
                        break;
                    }
                    chunks.push(chunk);
                }
            } catch (err) {
                if (err.name === 'AbortError' && streamError) {
                    // Intentionally aborted due to size
                } else {
                    streamError = err.message;
                }
            }
            clearTimeout(timeoutId);

            if (streamError) {
                return { status: 'rejected', reason: streamError };
            }

            const buffer = Buffer.concat(chunks);
            let imgSize;
            try {
                imgSize = imageSize(buffer);
            } catch (err) {
                return { status: 'rejected', reason: 'Invalid image data' };
            }

            const ext = imgSize.type?.toLowerCase();
            if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
                return { status: 'rejected', reason: `Disallowed or unknown image type: ${ext}` };
            }

            const finalExt = ext === 'jpeg' ? 'jpg' : ext === 'tiff' ? 'tif' : ext;
            const filename = `${urlHash}.${finalExt}`;
            const filepath = path.join(destDir, filename);

            writeFileAtomicSync(filepath, buffer);

            return { status: 'downloaded', path: `/greeting-images/${filename}` };
        } catch (error) {
            return { status: 'error', reason: error.message };
        }
    };

    let index = 0;
    const worker = async () => {
        while (index < urls.length) {
            const currentIndex = index++;
            const url = urls[currentIndex];
            results[url] = await processUrl(url);
        }
    };

    const WORKER_COUNT = 3;
    const workers = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    return res.json({ enabled: true, results });
});

publicRouter.get('/:file', (req, res) => {
    const { file } = req.params;
    const match = file.match(/^([a-f0-9]{32})\.([a-z]+)$/);
    if (!match) {
        return res.sendStatus(400);
    }
    const ext = match[2];
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return res.sendStatus(400);
    }

    const mimeType = EXT_MIME_MAP[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    res.sendFile(file, { root: req.user.directories.greetingImages, dotfiles: 'deny' });
});

export const router = express.Router();
router.use(publicRouter);
router.use(apiRouter);

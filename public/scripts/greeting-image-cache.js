import { chat, getRequestHeaders, saveChatConditional, updateMessageBlock } from '../script.js';
import { MessageFormatter } from './message-formatter.js';
import { isExternalMediaAllowed } from './chats.js';
import { power_user } from './power-user.js';

const IN_FLIGHT = new Set();

async function prefetchUrls(messageId, urls) {
    const toFetch = urls.filter(url => !IN_FLIGHT.has(url));
    if (toFetch.length === 0) return;

    for (const url of toFetch) IN_FLIGHT.add(url);

    try {
        const res = await fetch('/api/greeting-images/prefetch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ urls: toFetch }),
        });

        if (!res.ok) return;

        const data = await res.json();
        if (!data.enabled) return;

        const message = chat[messageId];
        if (!message) return;

        let modified = false;
        if (!message.extra) message.extra = {};
        if (!message.extra.greetingImageMap) message.extra.greetingImageMap = {};

        for (const [url, result] of Object.entries(data.results)) {
            if (result.status === 'downloaded' || result.status === 'cached') {
                if (result.path) {
                    message.extra.greetingImageMap[url] = result.path;
                    modified = true;
                }
            }
        }

        if (modified) {
            updateMessageBlock(messageId, message);
            saveChatConditional();
        }
    } catch (err) {
        console.warn('Failed to prefetch greeting images:', err);
    } finally {
        for (const url of toFetch) IN_FLIGHT.delete(url);
    }
}

MessageFormatter.addHook((html, ctx) => {
    // Scope restriction: ONLY process greetings
    if (ctx.messageId !== 0) return html;

    // Only process if prefetching is enabled and allowed
    if (!isExternalMediaAllowed() || power_user.prefetch_greeting_images === false) {
        return html;
    }

    const message = chat[ctx.messageId];
    if (!message) return html;

    const map = message?.extra?.greetingImageMap || {};
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const urlsToFetch = new Set();
    let modifiedDom = false;

    // Find all images
    for (const img of doc.querySelectorAll('img')) {
        let needsPrefetch = false;

        // Handle src
        const src = img.getAttribute('src');
        if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
            if (!src.startsWith(window.location.origin) && !src.includes('/greeting-images/')) {
                if (map[src]) {
                    // Already cached, use local path
                    img.setAttribute('src', map[src]);
                    modifiedDom = true;
                } else {
                    // Needs prefetching. Strip src to prevent browser fetch!
                    urlsToFetch.add(src);
                    img.setAttribute('data-original-src', src);
                    img.removeAttribute('src');
                    img.setAttribute('alt', 'Prefetching image...');
                    modifiedDom = true;
                }
            }
        }

        // Handle srcset manually, NO REGEX!
        const srcset = img.getAttribute('srcset');
        if (srcset) {
            let newSrcset = [];
            const parts = srcset.split(',');
            for (const part of parts) {
                const trimmed = part.trim();
                const url = trimmed.split(' ')[0];
                const rest = trimmed.substring(url.length);

                if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                    if (!url.startsWith(window.location.origin) && !url.includes('/greeting-images/')) {
                        if (map[url]) {
                            newSrcset.push(map[url] + rest);
                        } else {
                            urlsToFetch.add(url);
                            needsPrefetch = true;
                        }
                    } else {
                        newSrcset.push(trimmed);
                    }
                } else {
                    newSrcset.push(trimmed);
                }
            }
            if (needsPrefetch) {
                img.setAttribute('data-original-srcset', srcset);
                img.removeAttribute('srcset');
                modifiedDom = true;
            } else if (newSrcset.length > 0 && newSrcset.length === parts.length) {
                img.setAttribute('srcset', newSrcset.join(', '));
                modifiedDom = true;
            }
        }
    }

    // Handle background-image manually, NO REGEX!
    for (const el of doc.querySelectorAll('[style*="background-image"]')) {
        let bg = el.style.backgroundImage;
        if (bg && bg.startsWith('url(')) {
            let url = bg.slice(4, -1).trim();
            if (url.startsWith('"') || url.startsWith('\'')) {
                url = url.slice(1, -1);
            }
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                if (!url.startsWith(window.location.origin) && !url.includes('/greeting-images/')) {
                    if (map[url]) {
                        el.style.backgroundImage = `url("${map[url]}")`;
                        modifiedDom = true;
                    } else {
                        urlsToFetch.add(url);
                        el.setAttribute('data-original-bg', url);
                        el.style.backgroundImage = 'none';
                        modifiedDom = true;
                    }
                }
            }
        }
    }

    // Trigger async prefetch for any missing URLs
    if (urlsToFetch.size > 0) {
        // Disconnect from the sync execution thread
        setTimeout(() => prefetchUrls(ctx.messageId, Array.from(urlsToFetch)), 0);
    }

    return modifiedDom ? doc.body.innerHTML : html;
}, { stage: MessageFormatter.stage.AFTER_MARKDOWN });

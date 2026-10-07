import { chat, getRequestHeaders, saveChatConditional, updateMessageBlock } from '../script.js';
import { MessageFormatter } from './message-formatter.js';
import { power_user } from './power-user.js';

const IN_FLIGHT = new Set();
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

        if (!res.ok) {
            // Mark as failed so UI doesn't hang in loading state
            const message = chat[messageId];
            if (message) {
                if (!message.extra) message.extra = {};
                if (!message.extra.greetingImageMap) message.extra.greetingImageMap = {};
                for (const url of toFetch) {
                    message.extra.greetingImageMap[url] = null;
                }
                updateMessageBlock(messageId, message);
            }
            return;
        }

        const data = await res.json();
        const message = chat[messageId];
        if (!message) return;

        let modified = false;
        if (!message.extra) message.extra = {};
        if (!message.extra.greetingImageMap) message.extra.greetingImageMap = {};

        if (!data.enabled) {
            for (const url of toFetch) {
                message.extra.greetingImageMap[url] = null;
            }
            updateMessageBlock(messageId, message);
            return;
        }

        for (const [url, result] of Object.entries(data.results)) {
            if (result.status === 'downloaded' || result.status === 'cached') {
                if (result.path) {
                    message.extra.greetingImageMap[url] = result.path;
                    modified = true;
                }
            } else {
                // Rejected or error - record as null to trigger fallback
                message.extra.greetingImageMap[url] = null;
                modified = true;
            }
        }

        if (modified) {
            updateMessageBlock(messageId, message);
            saveChatConditional();
        }
    } catch (err) {
        console.warn('Failed to prefetch greeting images:', err);
        const message = chat[messageId];
        if (message) {
            if (!message.extra) message.extra = {};
            if (!message.extra.greetingImageMap) message.extra.greetingImageMap = {};
            for (const url of toFetch) {
                message.extra.greetingImageMap[url] = null;
            }
            updateMessageBlock(messageId, message);
        }
    } finally {
        for (const url of toFetch) IN_FLIGHT.delete(url);
    }
}

MessageFormatter.addHook((html, ctx) => {
    // Scope restriction: ONLY process greetings
    if (ctx.messageId !== 0) return html;

    // Only process if prefetching is enabled
    if (power_user.prefetch_greeting_images === false) {
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
                } else if (map[src] === null) {
                    // Prefetch failed or rejected, keep original src for fallback
                } else {
                    // Needs prefetching. Use transparent pixel placeholder to avoid broken image display
                    urlsToFetch.add(src);
                    img.setAttribute('data-original-src', src);
                    img.setAttribute('src', TRANSPARENT_PIXEL);
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
                        } else if (map[url] === null) {
                            newSrcset.push(trimmed);
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
                img.setAttribute('srcset', TRANSPARENT_PIXEL);
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
                    } else if (map[url] === null) {
                        // Prefetch failed or rejected, keep original
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

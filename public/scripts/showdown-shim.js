import { Marked } from 'marked';
import { markedUnderlineExt, markedImgDimensionsExt } from './marked-extensions.js';
import { markdownUnderscoreExt } from './marked-underscore.js';

let warnedDeprecation = false;

function logDeprecationWarning() {
    if (!warnedDeprecation) {
        warnedDeprecation = true;
        console.warn(
            '[Deprecation] showdown is deprecated in SillyTavern and has been replaced with marked. ' +
            'Please migrate third-party extensions to use marked directly.',
        );
    }
}

/**
 * Creates and configures a Marked instance matching SillyTavern defaults.
 * @returns {Marked}
 */
export function createDefaultMarkedInstance() {
    const instance = new Marked({
        breaks: true,
        gfm: true,
    });
    instance.use({
        extensions: [
            markedUnderlineExt(),
            markedImgDimensionsExt(),
            markdownUnderscoreExt(),
        ],
    });
    return instance;
}

/**
 * Compatibility Converter class mimicking showdown.Converter
 */
export class Converter {
    /**
     * @param {object} [options]
     */
    constructor(options = {}) {
        logDeprecationWarning();
        this.options = { ...options };
        this.marked = createDefaultMarkedInstance();

        if (Array.isArray(options.extensions)) {
            for (const ext of options.extensions) {
                this.addExtension(ext);
            }
        }
    }

    /**
     * @param {string} markdown
     * @returns {string}
     */
    makeHtml(markdown) {
        if (!markdown || typeof markdown !== 'string') {
            return '';
        }
        const html = this.marked.parse(markdown);
        if (typeof window !== 'undefined' && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
            return window.DOMPurify.sanitize(html);
        }
        return html;
    }

    /**
     * Best-effort adapter for showdown extensions (type: 'lang' or 'output')
     * @param {any} ext
     * @param {string} [name]
     */
    addExtension(ext, name) {
        if (!ext) {
            return;
        }

        const extensions = Array.isArray(ext) ? ext : [ext];

        for (const item of extensions) {
            if (typeof item === 'function') {
                try {
                    const result = item();
                    if (result) {
                        this.addExtension(result, name);
                    }
                } catch (e) {
                    console.warn('[Showdown Shim] Error executing extension factory:', e);
                }
                continue;
            }

            // Marked extension object (already adapted or marked native)
            if (item.extensions || item.hooks || item.renderer || item.tokenizer || item.name) {
                this.marked.use(item);
                continue;
            }

            // Showdown 'lang' type extension (preprocessor regex/filter)
            if (item.type === 'lang') {
                if (typeof item.filter === 'function') {
                    this.marked.use({
                        hooks: {
                            preprocess: (text) => item.filter(text, this, this.options),
                        },
                    });
                } else if (item.regex && (item.replace !== undefined)) {
                    this.marked.use({
                        hooks: {
                            preprocess: (text) => text.replace(item.regex, item.replace),
                        },
                    });
                } else {
                    console.warn('[Showdown Shim] Unhandled lang extension shape:', item);
                }
                continue;
            }

            // Showdown 'output' type extension (postprocessor regex/filter)
            if (item.type === 'output') {
                if (typeof item.filter === 'function') {
                    this.marked.use({
                        hooks: {
                            postprocess: (html) => item.filter(html, this, this.options),
                        },
                    });
                } else if (item.regex && (item.replace !== undefined)) {
                    this.marked.use({
                        hooks: {
                            postprocess: (html) => html.replace(item.regex, item.replace),
                        },
                    });
                } else {
                    console.warn('[Showdown Shim] Unhandled output extension shape:', item);
                }
                continue;
            }

            console.warn('[Showdown Shim] Unknown extension type ignored:', item);
        }
    }

    /**
     * @param {string} key
     * @param {any} value
     */
    setOption(key, value) {
        this.options[key] = value;
    }

    /**
     * @param {string} key
     * @returns {any}
     */
    getOption(key) {
        return this.options[key];
    }

    /**
     * @returns {object}
     */
    getOptions() {
        return { ...this.options };
    }
}

/**
 * Global helper methods from showdown
 */
export const showdownShim = {
    Converter,
    setOption(key, value) {
        logDeprecationWarning();
    },
    getOption(key) {
        logDeprecationWarning();
        return undefined;
    },
    getOptions() {
        logDeprecationWarning();
        return {};
    },
    getDefaultOptions() {
        return {};
    },
    extension(name, ext) {
        logDeprecationWarning();
    },
    subParser(name, func) {
        // No-op for compatibility
        logDeprecationWarning();
    },
    helper: {
        replaceRecursiveRegExp(str, replacement, left, right, flags) {
            return str;
        },
    },
};

export default showdownShim;

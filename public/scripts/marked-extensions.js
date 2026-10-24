/**
 * Marked inline extension for parsing underline (__text__ -> <u>text</u>)
 * preserving Showdown's underline: true behavior.
 */
export const markedUnderlineExt = () => {
    return {
        name: 'underline',
        level: 'inline',
        start(src) {
            const index = src.indexOf('__');
            return index !== -1 ? index : undefined;
        },
        tokenizer(src, tokens) {
            const rule = /^__([^\n_]+?)__/;
            const match = rule.exec(src);
            if (match) {
                return {
                    type: 'underline',
                    raw: match[0],
                    text: match[1],
                    tokens: this.lexer.inlineTokens(match[1]),
                };
            }
        },
        renderer(token) {
            return `<u>${this.parser.parseInline(token.tokens)}</u>`;
        },
    };
};

/**
 * Marked preprocess extension restoring Showdown's tolerance of horizontal
 * whitespace between a bracketed label and its parenthesis. Showdown accepted
 * `![alt] (url)` and `[text] (url)`, but CommonMark (marked) does not, so the
 * text was rendered literally after the Showdown-to-marked migration.
 *
 * Rewrites `] <spaces/tabs> (` to `](` outside inline code spans and fenced
 * code blocks. Implemented with a character scanner, no regular expressions.
 *
 * Known limitations: inline code spans that cross a newline are not tracked,
 * and fenced code blocks indented by more than three spaces are not treated as
 * fences (matching CommonMark block rules).
 * @returns {object} Marked extension object with hooks
 */
export const markdownSpaceParityExt = () => {
    return {
        hooks: {
            preprocess(text) {
                if (typeof text !== 'string' || text.length === 0) {
                    return text;
                }

                const isSpaceOrTab = (ch) => ch === ' ' || ch === '\t';

                /** @type {string[]} */
                const out = [];
                let lineStart = true;
                let fenceChar = '';
                let fenceLength = 0;
                let bracketDepth = 0;
                let backtickRun = 0;
                let i = 0;

                while (i < text.length) {
                    const ch = text[i];

                    // Fence markers only open/close a block at the start of a line.
                    if (lineStart) {
                        let indent = 0;
                        while (i + indent < text.length && text[i + indent] === ' ') {
                            indent += 1;
                        }

                        const markerPos = i + indent;
                        const markerChar = text[markerPos];
                        if (indent <= 3 && (markerChar === '`' || markerChar === '~')) {
                            let run = 0;
                            while (text[markerPos + run] === markerChar) {
                                run += 1;
                            }

                            if (fenceChar === '') {
                                if (run >= 3) {
                                    fenceChar = markerChar;
                                    fenceLength = run;
                                }
                            } else if (markerChar === fenceChar && run >= fenceLength) {
                                fenceChar = '';
                                fenceLength = 0;
                            }
                        }

                        lineStart = false;
                    }

                    if (ch === '\n') {
                        out.push(ch);
                        bracketDepth = 0;
                        backtickRun = 0;
                        lineStart = true;
                        i += 1;
                        continue;
                    }

                    // Fenced code block contents are copied verbatim.
                    if (fenceChar !== '') {
                        out.push(ch);
                        i += 1;
                        continue;
                    }

                    // Track inline code spans (equal-length backtick runs).
                    if (ch === '`') {
                        let run = 0;
                        while (text[i + run] === '`') {
                            run += 1;
                        }

                        if (backtickRun === 0) {
                            backtickRun = run;
                        } else if (run === backtickRun) {
                            backtickRun = 0;
                        }

                        out.push(text.slice(i, i + run));
                        i += run;
                        continue;
                    }

                    if (backtickRun > 0) {
                        out.push(ch);
                        i += 1;
                        continue;
                    }

                    // Copy a backslash escape as-is (except a trailing escaped newline).
                    if (ch === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
                        out.push(text.slice(i, i + 2));
                        i += 2;
                        continue;
                    }

                    if (ch === '[') {
                        bracketDepth += 1;
                        out.push(ch);
                        i += 1;
                        continue;
                    }

                    if (ch === ']') {
                        if (bracketDepth > 0) {
                            bracketDepth -= 1;

                            let j = i + 1;
                            while (j < text.length && isSpaceOrTab(text[j])) {
                                j += 1;
                            }

                            if (j > i + 1 && text[j] === '(') {
                                out.push(ch);
                                i = j;
                                continue;
                            }
                        }

                        out.push(ch);
                        i += 1;
                        continue;
                    }

                    out.push(ch);
                    i += 1;
                }

                return out.join('');
            },
        },
    };
};

/**
 * Marked inline extension for parsing image dimensions: ![alt](url =WxH)
 */
export const markedImgDimensionsExt = () => {
    return {
        name: 'imgDimensions',
        level: 'inline',
        start(src) {
            const index = src.indexOf('![');
            return index !== -1 ? index : undefined;
        },
        tokenizer(src, tokens) {
            // Match ![alt](url =WxH) or =Wx* or =*xH
            const rule = /^!\[(.*?)\]\((.+?)\s+=(\*|\d+)x(\*|\d+)\)/;
            const match = rule.exec(src);
            if (match) {
                const alt = match[1];
                const href = match[2];
                const width = match[3] === '*' ? 'auto' : match[3];
                const height = match[4] === '*' ? 'auto' : match[4];
                return {
                    type: 'imgDimensions',
                    raw: match[0],
                    alt,
                    href,
                    width,
                    height,
                };
            }
        },
        renderer(token) {
            return `<img src="${token.href}" alt="${token.alt}" width="${token.width}" height="${token.height}" />`;
        },
    };
};

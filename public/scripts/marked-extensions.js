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

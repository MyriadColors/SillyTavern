// Marked extension that replaces words surrounded by singular underscores with <em> tags
export const markdownUnderscoreExt = () => {
    try {
        if (!canUseNegativeLookbehind()) {
            console.log('Marked-underscore extension: Negative lookbehind not supported. Skipping.');
            return {};
        }

        return {
            name: 'underscore',
            level: 'inline',
            start(src) {
                const index = src.indexOf('_');
                return index !== -1 ? index : undefined;
            },
            tokenizer(src, tokens) {
                // Match \b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\b
                // In marked tokenizer, src begins at current position
                const rule = /^_(?!_)([^\n_]+?)(?<!_)_(?!_)\b/;
                const match = rule.exec(src);
                if (match) {
                    return {
                        type: 'underscore',
                        raw: match[0],
                        text: match[1],
                        tokens: this.lexer.inlineTokens(match[1]),
                    };
                }
            },
            renderer(token) {
                return `<em>${this.parser.parseInline(token.tokens)}</em>`;
            },
        };
    } catch (e) {
        console.error('Error in Marked-underscore extension:', e);
        return {};
    }
};

function canUseNegativeLookbehind() {
    try {
        new RegExp('(?<!_)');
        return true;
    } catch (e) {
        return false;
    }
}

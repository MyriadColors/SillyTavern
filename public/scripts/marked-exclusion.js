import { power_user } from './power-user.js';
import { substituteParams } from '../script.js';

/**
 * Marked extension (preprocess hook) to make chat separators (dinkuses) ignore markdown formatting
 * @returns {object} Marked extension object with hooks
 */
export const markdownExclusionExt = () => {
    return {
        hooks: {
            preprocess(text) {
                if (!power_user || !power_user.markdown_escape_strings) {
                    return text;
                }

                const escapedExclusions = substituteParams(power_user.markdown_escape_strings)
                    .split(',')
                    .filter((element) => element.length > 0)
                    .map((element) => `(${element.split('').map((char) => `\\${char}`).join('')})`);

                if (escapedExclusions.length === 0) {
                    return text;
                }

                const replaceRegex = new RegExp(`^(${escapedExclusions.join('|')})\n`, 'gm');
                return text.replace(replaceRegex, ((match) => match.replace(replaceRegex, `\u0000${match} \n`)));
            },
        },
    };
};

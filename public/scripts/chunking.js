/**
 * Pure, dependency-free text chunking helpers for vector ingestion.
 * No browser or Node globals are used so this module can be unit tested
 * directly under Node (jest) and imported by browser code.
 */

/**
 * @typedef {object} ParsedChunkDelimiter
 * @property {string} raw The original user-entered line.
 * @property {string} literal Literal separator to split on.
 * @property {boolean} wholeLine When true, only split when the literal spans a whole line.
 */

/**
 * Parses a single user-entered delimiter line as a plain literal separator.
 * Lines that look like `/pattern/flags` are treated as literal text, not regex.
 * A leading `line:` prefix restricts the split to whole lines (e.g. `line:---`
 * splits on a standalone --- line but leaves `wait---what` intact).
 * Supports `\n` and `\t` escapes so invisible separators can be typed.
 * @param {string} line Raw delimiter line.
 * @returns {ParsedChunkDelimiter|null} Parsed delimiter or null when blank.
 */
export function parseChunkDelimiter(line) {
    if (typeof line !== 'string') {
        return null;
    }

    const trimmed = line.replace(/\r/g, '').trim();
    if (trimmed.length === 0) {
        return null;
    }

    let wholeLine = false;
    let boundary = trimmed;
    if (boundary.startsWith('line:')) {
        wholeLine = true;
        boundary = boundary.slice('line:'.length).trim();
        if (boundary.length === 0) {
            return null;
        }
    }

    // Support escaped sequences users commonly type: \n, \t.
    const unescaped = boundary.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (unescaped.length === 0) {
        return null;
    }

    return { raw: trimmed, literal: unescaped, wholeLine: wholeLine };
}

/**
 * Parses textarea input (one delimiter per line) into usable delimiters.
 * @param {string|string[]} input Newline-separated string or array of lines.
 * @returns {ParsedChunkDelimiter[]} Parsed delimiters in priority order.
 */
export function parseCustomDelimiters(input) {
    const lines = Array.isArray(input) ? input : String(input ?? '').split('\n');
    const result = [];
    for (const line of lines) {
        const parsed = parseChunkDelimiter(line);
        if (parsed) {
            result.push(parsed);
        }
    }
    return result;
}

/**
 * Splits text on one parsed delimiter. The delimiter itself is discarded.
 * Whole-line delimiters only split on lines that equal the literal after
 * trimming; all other lines (including mid-text occurrences) are kept.
 * @param {string} text Text to split.
 * @param {ParsedChunkDelimiter} delimiter Parsed delimiter.
 * @returns {string[]} Split parts.
 */
export function splitOnDelimiter(text, delimiter) {
    if (!delimiter.wholeLine) {
        return text.split(delimiter.literal);
    }

    const parts = [];
    let current = [];
    for (const line of text.split('\n')) {
        if (line.trim() === delimiter.literal) {
            parts.push(current.join('\n'));
            current = [];
        } else {
            current.push(line);
        }
    }
    parts.push(current.join('\n'));
    return parts;
}

/**
 * Recursively splits text to at most `length` chars using fallback delimiters.
 * Mirrors the behavior of splitRecursive in public/scripts/utils.js.
 * @param {string} input Text to split.
 * @param {number} length Max chunk length.
 * @param {string[]} delimiters Fallback delimiters in priority order.
 * @returns {string[]} Chunks.
 */
export function splitRecursivePure(input, length, delimiters = ['\n\n', '\n', ' ', '']) {
    if (length <= 0) {
        return [input];
    }

    const delim = delimiters[0] ?? '';
    const parts = input.split(delim);

    const flatParts = parts.flatMap((part) => {
        if (part.length < length) {
            return [part];
        }
        return splitRecursivePure(part, length, delimiters.slice(1));
    });

    const result = [];
    let i = 0;
    while (i < flatParts.length) {
        let current = flatParts[i];
        let j = i + 1;
        while (j < flatParts.length) {
            const next = flatParts[j];
            if (current.length + next.length + delim.length <= length) {
                current += delim + next;
            } else {
                break;
            }
            j++;
        }
        i = j;
        result.push(current);
    }
    return result;
}

/**
 * Normalizes line endings and drops empty chunks.
 * @param {string[]} chunks Raw chunks.
 * @returns {string[]} Cleaned chunks.
 */
function cleanChunks(chunks) {
    return chunks
        .map(chunk => (typeof chunk === 'string' ? chunk.trim() : ''))
        .filter(chunk => chunk.length > 0);
}

/**
 * Semantically splits text: hard-split on custom boundaries first (never merged
 * across when `onlyCustom` is true), then sub-split oversized units with the
 * default recursive splitter. Short adjacent units are greedily re-packed up
 * to `length` with paragraph separation so tiny lore entries don't each burn
 * an embedding.
 * @param {string} input Text to split.
 * @param {number} length Max chunk length in chars.
 * @param {ParsedChunkDelimiter[]} customDelimiters Custom boundaries in priority order.
 * @param {object} [options] Options.
 * @param {string[]} [options.fallbackDelimiters] Fallback delimiters for oversized units.
 * @param {boolean} [options.onlyCustom] When true, never merge across custom boundaries.
 * @returns {string[]} Chunks.
 */
export function splitSemantic(input, length, customDelimiters = [], options = {}) {
    const fallbackDelimiters = options.fallbackDelimiters ?? ['\n\n', '\n', ' ', ''];
    const onlyCustom = options.onlyCustom ?? false;

    if (typeof input !== 'string' || input.length === 0) {
        return [];
    }

    const normalized = input.replace(/\r\n?/g, '\n');

    if (length <= 0) {
        const trimmed = normalized.trim();
        return trimmed ? [trimmed] : [];
    }

    let units = [normalized];
    for (const delimiter of customDelimiters) {
        if (!delimiter) {
            continue;
        }
        units = units.flatMap(unit => splitOnDelimiter(unit, delimiter));
    }

    units = cleanChunks(units);
    if (units.length === 0) {
        return [];
    }

    // No custom boundaries matched: plain recursive split preserves old behavior.
    if (units.length === 1 && units[0] === normalized.trim()) {
        return cleanChunks(splitRecursivePure(normalized, length, fallbackDelimiters));
    }

    const subSplit = units.flatMap(unit => {
        if (unit.length <= length) {
            return [unit];
        }
        return splitRecursivePure(unit, length, fallbackDelimiters);
    });

    const cleaned = cleanChunks(subSplit);
    if (onlyCustom || cleaned.length <= 1) {
        return cleaned;
    }

    // Soft mode: re-pack tiny adjacent units so a dozen one-line lore
    // entries don't become a dozen embeddings, but never exceed length.
    const packed = [];
    let current = cleaned[0];
    for (let i = 1; i < cleaned.length; i++) {
        const next = cleaned[i];
        if (current.length + next.length + 2 <= length) {
            current += '\n\n' + next;
        } else {
            packed.push(current);
            current = next;
        }
    }
    packed.push(current);
    return packed;
}

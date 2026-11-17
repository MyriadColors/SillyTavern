/**
 * Retired Google model identifiers and their surviving replacements.
 * @type {Map<string, string>}
 */
export const GOOGLE_MODEL_MIGRATIONS = new Map([
    ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
    ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image'],
    ['gemini-3-pro-image-preview', 'gemini-3-pro-image'],
    ['gemini-2.0-flash', 'gemini-3.8-flash'],
    ['gemini-2.0-flash-lite', 'gemini-3.8-flash'],
    ['gemini-2.5-flash-image-preview', 'gemini-2.5-flash-image'],
    ['gemini-3.7-flash', 'gemini-3.8-flash'],
    ['gemini-3.5-flash', 'gemini-3.6-flash'],
]);

/**
 * Retired Anthropic model identifiers and their nearest surviving replacements.
 * Every target is a static option in caption settings.
 * @type {Map<string, string>}
 */
export const ANTHROPIC_MODEL_MIGRATIONS = new Map([
    ['claude-opus-4-0', 'claude-opus-4-5'],
    ['claude-opus-4-20250514', 'claude-opus-4-5'],
    ['claude-sonnet-4-0', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4-5'],
    ['claude-3-7-sonnet-latest', 'claude-sonnet-4-5'],
    ['claude-3-7-sonnet-20250219', 'claude-sonnet-4-5'],
    ['claude-3-5-sonnet-latest', 'claude-sonnet-4-5'],
    ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-5'],
    ['claude-3-5-sonnet-20240620', 'claude-sonnet-4-5'],
    ['claude-3-5-haiku-latest', 'claude-haiku-4-5'],
    ['claude-3-5-haiku-20241022', 'claude-haiku-4-5'],
    ['claude-3-haiku-20240307', 'claude-haiku-4-5'],
    ['claude-3-opus-20240229', 'claude-opus-4-5'],
]);

/**
 * Resolves a retired multimodal caption model to its nearest surviving replacement.
 * @param {string} api Multimodal API identifier.
 * @param {string} model Multimodal model identifier.
 * @returns {string} Migrated model identifier, or the input unchanged when no migration applies.
 */
export function resolveModelMigration(api, model) {
    if (['google', 'vertexai'].includes(api)) {
        return GOOGLE_MODEL_MIGRATIONS.get(model) ?? model;
    }

    if (api === 'anthropic') {
        return ANTHROPIC_MODEL_MIGRATIONS.get(model) ?? model;
    }

    return model;
}

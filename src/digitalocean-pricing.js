// DigitalOcean serverless inference pricing (USD per 1M tokens).
// Static source of truth - DigitalOcean has no pricing API (GET /v1/models returns only ids).
// Seeded from https://docs.digitalocean.com/products/inference/details/pricing/ (verified Oct 2026).
// Refresh on demand via `npm run update-digitalocean-pricing` (pulls structured data from models.dev).
export const DIGITALOCEAN_PRICING_UPDATED = '2026-10-16';
export const DIGITALOCEAN_PRICING_SOURCE = 'https://docs.digitalocean.com/products/inference/details/pricing/';

/**
 * @type {Record<string, {input: number, output: number}>}
 * Prices are USD per 1M tokens, matching the ElectronHub/Chutes `pricing.input/output` convention.
 */
export const DIGITALOCEAN_PRICES = {
    // OpenAI open-weight
    'openai-gpt-oss-120b': { input: 0.10, output: 0.70 },
    'openai-gpt-oss-20b': { input: 0.05, output: 0.45 },
    // OpenAI flagship
    'openai-gpt-4.1': { input: 2.00, output: 8.00 },
    'openai-gpt-4o': { input: 2.50, output: 10.00 },
    'openai-gpt-4o-mini': { input: 0.15, output: 0.60 },
    'openai-gpt-5': { input: 1.25, output: 10.00 },
    'openai-gpt-5-mini': { input: 0.25, output: 2.00 },
    'openai-gpt-5-nano': { input: 0.05, output: 0.40 },
    'openai-gpt-5.1-codex-max': { input: 1.25, output: 10.00 },
    'openai-gpt-5.2': { input: 1.75, output: 14.00 },
    'openai-gpt-5.2-pro': { input: 21.00, output: 168.00 },
    'openai-gpt-5.3-codex': { input: 1.75, output: 14.00 },
    'openai-gpt-5.4': { input: 2.50, output: 15.00 },
    'openai-gpt-5.4-mini': { input: 0.75, output: 4.50 },
    'openai-gpt-5.4-nano': { input: 0.20, output: 1.25 },
    'openai-gpt-5.4-pro': { input: 30.00, output: 180.00 },
    'openai-gpt-5.5': { input: 5.00, output: 30.00 },
    'openai-gpt-5.6-luna': { input: 0.20, output: 1.20 },
    'openai-gpt-5.6-sol': { input: 4.00, output: 20.00 },
    'openai-gpt-5.6-terra': { input: 2.00, output: 12.00 },
    'openai-gpt-6-astra': { input: 10.00, output: 50.00 },
    'openai-gpt-6-luna': { input: 0.10, output: 0.50 },
    'openai-gpt-6-sol': { input: 2.00, output: 10.00 },
    'openai-gpt-6-1-sol': { input: 2.00, output: 10.00 },
    'openai-o1': { input: 15.00, output: 60.00 },
    'openai-o3': { input: 2.00, output: 8.00 },
    'openai-o3-mini': { input: 1.10, output: 4.40 },
    // Anthropic
    'anthropic-claude-3-opus': { input: 15.00, output: 75.00 },
    'anthropic-claude-3.5-haiku': { input: 0.80, output: 4.00 },
    'anthropic-claude-3.5-sonnet': { input: 3.00, output: 15.00 },
    'anthropic-claude-3.7-sonnet': { input: 3.00, output: 15.00 },
    'anthropic-claude-4.1-opus': { input: 15.00, output: 75.00 },
    'anthropic-claude-4.5-sonnet': { input: 3.00, output: 15.00 },
    'anthropic-claude-4.6-sonnet': { input: 3.00, output: 15.00 },
    'anthropic-claude-5-sonnet': { input: 2.00, output: 10.00 },
    'anthropic-claude-5.5-sonnet': { input: 2.00, output: 10.00 },
    'anthropic-claude-5.5-haiku': { input: 0.10, output: 0.50 },
    'anthropic-claude-fable-5': { input: 10.00, output: 50.00 },
    'anthropic-claude-fable-5.1': { input: 10.00, output: 50.00 },
    'anthropic-claude-haiku-4.5': { input: 1.00, output: 5.00 },
    'anthropic-claude-opus-4': { input: 15.00, output: 75.00 },
    'anthropic-claude-opus-4.5': { input: 5.00, output: 25.00 },
    'anthropic-claude-opus-4.6': { input: 5.00, output: 25.00 },
    'anthropic-claude-opus-4.7': { input: 5.00, output: 25.00 },
    'anthropic-claude-opus-4.8': { input: 5.00, output: 25.00 },
    'anthropic-claude-opus-5': { input: 5.00, output: 25.00 },
    'anthropic-claude-opus-5-5': { input: 4.00, output: 20.00 },
    'anthropic-claude-sonnet-4': { input: 3.00, output: 15.00 },
    // DeepSeek
    'deepseek-3.2': { input: 0.50, output: 1.60 },
    'deepseek-r1-distill-llama-70b': { input: 0.99, output: 0.99 },
    'deepseek-4-flash': { input: 0.14, output: 0.28 },
    'deepseek-v4-flash-0731': { input: 0.14, output: 0.28 },
    'deepseek-v4-pro': { input: 1.74, output: 3.48 },
    'deepseek-v4-pro-0813': { input: 1.32, output: 3.96 },
    'deepseek-v4.1-flash': { input: 0.30, output: 1.20 },
    // Meta
    'llama3-8b-instruct': { input: 0.20, output: 0.20 },
    'llama3.3-70b-instruct': { input: 0.65, output: 0.65 },
    'llama-4-maverick': { input: 0.25, output: 0.87 },
    // Google / Mistral / Meta misc
    'gemma-4-31B-it': { input: 0.18, output: 0.50 },
    'mistral-3-14B': { input: 0.20, output: 0.20 },
    'mistral-nemo-instruct-2407': { input: 0.30, output: 0.30 },
    // Moonshot / MiniMax / Xiaomi / Alibaba / Z.AI / NVIDIA
    'kimi-k2.5': { input: 0.50, output: 2.70 },
    'kimi-k2.6': { input: 0.95, output: 4.00 },
    'kimi-k3': { input: 3.00, output: 15.00 },
    'minimax-m2.5': { input: 0.30, output: 1.20 },
    'mimo-v2.5-pro': { input: 0.80, output: 3.00 },
    'qwen3.5-397b-a17b': { input: 0.55, output: 3.50 },
    'qwen3.8-max': { input: 2.00, output: 6.00 },
    'alibaba-qwen3-32b': { input: 0.25, output: 0.55 },
    'qwen3-coder-flash': { input: 0.45, output: 1.70 },
    'glm-5': { input: 1.00, output: 3.20 },
    'glm-5.1': { input: 1.30, output: 4.30 },
    'glm-5.2': { input: 1.40, output: 4.40 },
    'glm-5.3': { input: 1.40, output: 4.40 },
    'glm-5.3-flash': { input: 0.15, output: 0.50 },
    'nemotron-3.5-super-vl': { input: 0.30, output: 0.65 },
    'nvidia-nemotron-3-super-120b': { input: 0.30, output: 0.65 },
    'nemotron-3-ultra-550b': { input: 0.90, output: 1.70 },
    'nemotron-3-nano-omni': { input: 0.50, output: 0.90 },
    'nemotron-nano-12b-v2-vl': { input: 0.20, output: 0.60 },
    'arcee-trinity-large-thinking': { input: 0.25, output: 0.90 },
};

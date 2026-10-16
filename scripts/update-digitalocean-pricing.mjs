// Refresh DigitalOcean static pricing from models.dev (structured, third-party).
// Usage: npm run update-digitalocean-pricing
// DigitalOcean has no official pricing API, so this is strictly on-demand.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, '..', 'src', 'digitalocean-pricing.js');

const CANDIDATES = [
    'https://models.dev/catalog.json?type=all',
    'https://models.dev/api.json?type=all',
];

function extractPrices(catalog) {
    // Handle several catalog shapes: { providers: { digitalocean: ... } } or { digitalocean: ... }
    const root = catalog?.providers ?? catalog;
    const provider = root?.digitalocean ?? root?.['digitalocean'];
    if (!provider) {
        throw new Error('DigitalOcean provider not found in models.dev catalog');
    }

    const models = provider.models ?? provider;
    const prices = {};

    const entries = Array.isArray(models)
        ? models.map(m => [m.id ?? m.modelId ?? m.name, m])
        : Object.entries(models);

    for (const [id, model] of entries) {
        if (!id || !model || typeof model !== 'object') {
            continue;
        }
        // models.dev cost is USD per 1M tokens: { input, output, cache_read?, ... }
        const cost = model.cost ?? model.pricing ?? model.price;
        const input = Number(cost?.input);
        const output = Number(cost?.output);
        if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
            // Skip non-chat billable units (images, video, audio carry 0/0 or missing costs)
            prices[String(id)] = { input, output };
        }
    }

    if (Object.keys(prices).length === 0) {
        throw new Error('No usable DigitalOcean prices found in models.dev catalog');
    }

    return prices;
}

function render(prices) {
    const today = new Date().toISOString().slice(0, 10);
    const body = Object.keys(prices).sort().map(id => `    '${id}': { input: ${prices[id].input}, output: ${prices[id].output} },`).join('\n');
    return `// DigitalOcean serverless inference pricing (USD per 1M tokens).
// Static source of truth - DigitalOcean has no pricing API (GET /v1/models returns only ids).
// Seeded from https://docs.digitalocean.com/products/inference/details/pricing/.
// Refresh on demand via \`npm run update-digitalocean-pricing\` (pulls structured data from models.dev).
export const DIGITALOCEAN_PRICING_UPDATED = '${today}';
export const DIGITALOCEAN_PRICING_SOURCE = 'https://models.dev/';

export const DIGITALOCEAN_PRICES = {
${body}
};
`;
}

let lastError;
for (const url of CANDIDATES) {
    try {
        console.info(`Fetching ${url} ...`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const catalog = await response.json();
        const prices = extractPrices(catalog);
        await writeFile(OUTPUT, render(prices));
        console.info(`Wrote ${Object.keys(prices).length} prices to ${OUTPUT}`);
        process.exit(0);
    } catch (error) {
        lastError = error;
        console.warn(`Failed ${url}:`, error.message);
    }
}

console.error('All pricing sources failed:', lastError?.message);
process.exit(1);

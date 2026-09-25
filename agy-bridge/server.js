import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 9000;
const AGY_BIN = process.env.AGY_BIN || 'agy';
const AGY_PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || '600s';
const BASE_PATH = '/v1';

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

function buildPrompt(messages) {
    const blocks = [];
    for (const m of messages || []) {
        let content = m.content;
        if (Array.isArray(content)) {
            content = content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        }
        if (typeof content !== 'string') {
            content = String(content ?? '');
        }
        const role = m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User';
        blocks.push(`${role}: ${content}`);
    }
    return blocks.join('\n\n');
}

function extractText(parsed, raw) {
    if (parsed && typeof parsed === 'object' && typeof parsed.response === 'string') {
        return parsed.response.replace(/\n$/, '');
    }
    return raw.trim();
}

function runAgy(prompt, model) {
    return new Promise((resolve, reject) => {
        const args = ['--output-format', 'json', '--print-timeout', AGY_PRINT_TIMEOUT];
        if (model && model !== 'agy') {
            args.push('--model', model);
        }
        args.push('-p', prompt);

        const bins = [AGY_BIN, 'agy.cmd', 'agy.exe'];
        let idx = 0;

        const next = (err) => {
            idx += 1;
            if (idx < bins.length) {
                trySpawn();
            } else {
                reject(err || new Error('agy binary not found on PATH'));
            }
        };

        const trySpawn = () => {
            const bin = bins[idx];
            let child;
            try {
                child = spawn(bin, args, { env: process.env });
            } catch (e) {
                return next(e);
            }
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    next(err);
                } else {
                    reject(err);
                }
            });
            child.on('close', (code) => {
                if (code === 0) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(stdout);
                    } catch {
                        // keep raw
                    }
                    resolve({ text: extractText(parsed, stdout), raw: stdout, stderr });
                } else {
                    reject(new Error(`agy exited with code ${code}\n${stderr || stdout}`));
                }
            });
        };

        trySpawn();
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === `${BASE_PATH}/models`) {
        return sendJson(res, 200, {
            object: 'list',
            data: [{ id: 'agy', object: 'model', owned_by: 'agy' }],
        });
    }

    if (req.method === 'POST' && path === `${BASE_PATH}/chat/completions`) {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', async () => {
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
            }
            const messages = parsed.messages || [];
            const model = parsed.model || 'agy';
            const stream = Boolean(parsed.stream);
            const prompt = buildPrompt(messages);

            try {
                const { text } = await runAgy(prompt, model);
                if (stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive',
                    });
                    const created = Math.floor(Date.now() / 1000);
                    res.write(`data: ${JSON.stringify({
                        id: 'chatcmpl-agy',
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
                    })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        id: 'chatcmpl-agy',
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    sendJson(res, 200, {
                        id: 'chatcmpl-agy',
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    });
                }
            } catch (e) {
                if (stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
                    res.end();
                } else {
                    sendJson(res, 500, { error: { message: e.message } });
                }
            }
        });
        return;
    }

    sendJson(res, 404, { error: { message: 'Not found' } });
});

server.listen(PORT, () => {
    console.log(`agy-bridge listening on http://localhost:${PORT}${BASE_PATH}`);
    console.log('  Forwarding chat completions to: agy -p <flattened messages>');
});

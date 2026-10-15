/**
 * OpenAI Compat Endpoint Integration Tests
 *
 * Requires a live server on :8080 (same as other integration suites).
 * Covers POST /v1/chat/completions:
 *   1. Non-streaming chat completion (valid OpenAI JSON envelope)
 *   2. Streaming chunk sequence (role -> content -> finish_reason -> [DONE])
 *   3. Tool call round-trip (tools + tool_choice)
 *   4. Error format (invalid model -> OpenAI error envelope, 400)
 *   5. Named key auth + quota 429 in OpenAI error format (uses WebUI /api/keys;
 *      skipped when a WebUI password is configured)
 */
const http = require('http');
const { getTestModels } = require('./helpers/test-models.cjs');

const BASE_URL = 'localhost';
const PORT = 8080;

/**
 * Resolve the API key for Bearer auth:
 * 1. TEST_API_KEY env var (explicit override)
 * 2. apiKey from the runtime config (~/.config/antigravity-proxy/config.json)
 * 3. fallback 'test' (works only when no key is configured)
 */
function resolveApiKey() {
    if (process.env.TEST_API_KEY) return process.env.TEST_API_KEY;
    try {
        const os = require('os');
        const path = require('path');
        const cfg = JSON.parse(
            require('fs').readFileSync(path.join(os.homedir(), '.config/antigravity-proxy/config.json'), 'utf-8')
        );
        if (cfg.apiKey) return cfg.apiKey;
    } catch (e) { }
    return 'test';
}

const API_KEY = resolveApiKey();

/**
 * Raw OpenAI-format request helper (Bearer auth, like OpenAI SDKs).
 * @param {string} path
 * @param {Object|null} body
 * @param {Object} [opts] {apiKey, expectStream}
 * @returns {Promise<{statusCode: number, headers: Object, raw: string, json: Object|null, chunks: Array, done: boolean}>}
 */
function openaiRequest(path, body, opts = {}) {
    const expectStream = !!opts.expectStream;
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey || API_KEY}`
        };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        const req = http.request({
            host: BASE_URL,
            port: PORT,
            path,
            method: body ? 'POST' : 'GET',
            headers
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c.toString(); });
            res.on('end', () => {
                const out = { statusCode: res.statusCode, headers: res.headers, raw, json: null, chunks: [], done: false };
                if (expectStream) {
                    for (const line of raw.split('\n')) {
                        const l = line.trim();
                        if (!l.startsWith('data:')) continue;
                        const payload = l.slice(5).trim();
                        if (payload === '[DONE]') { out.done = true; continue; }
                        try { out.chunks.push(JSON.parse(payload)); } catch (e) { }
                    }
                } else {
                    try { out.json = JSON.parse(raw); } catch (e) { }
                }
                resolve(out);
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/**
 * WebUI fetch with optional login (returns null when password is set and
 * credentials are unknown — callers should skip the scenario).
 */
function webuiRequest(path, body, sessionCookie, method) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (sessionCookie) headers.Cookie = sessionCookie;
        const req = http.request({
            host: BASE_URL, port: PORT, path,
            method: method || (body ? 'POST' : 'GET'), headers
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c.toString(); });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) { }
                resolve({ statusCode: res.statusCode, json, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function main() {
    console.log('='.repeat(60));
    console.log('OPENAI COMPAT ENDPOINT TEST');
    console.log('POST /v1/chat/completions (non-stream, stream, tools, errors, named keys)');
    console.log('='.repeat(60));
    console.log('');

    const models = await getTestModels();
    const { model } = models[0];

    let allPassed = true;
    const results = [];
    const record = (name, passed, note) => {
        results.push({ name, passed });
        console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}${note ? ` (${note})` : ''}`);
        if (!passed) allPassed = false;
    };

    // ===== TEST 1: Non-streaming chat completion =====
    console.log('TEST 1: Non-streaming chat completion');
    console.log('-'.repeat(40));
    try {
        const r = await openaiRequest('/v1/chat/completions', {
            model,
            messages: [{ role: 'user', content: 'What is the capital of France? Reply in one word.' }],
            max_tokens: 50
        });
        const ok = r.statusCode === 200
            && r.json?.object === 'chat.completion'
            && r.json?.model === model
            && Array.isArray(r.json?.choices)
            && r.json.choices.length === 1
            && typeof r.json.choices[0].message?.content === 'string'
            && r.json.choices[0].message.content.length > 0
            && r.json.choices[0].finish_reason === 'stop'
            && typeof r.json.usage?.prompt_tokens === 'number'
            && typeof r.json.usage?.completion_tokens === 'number'
            && r.json.usage.total_tokens === r.json.usage.prompt_tokens + r.json.usage.completion_tokens;
        console.log(`  statusCode: ${r.statusCode}, finish_reason: ${r.json?.choices?.[0]?.finish_reason}, usage: ${JSON.stringify(r.json?.usage)}`);
        console.log(`  content preview: "${(r.json?.choices?.[0]?.message?.content || '').substring(0, 50)}"`);
        record('Non-streaming chat completion', ok);
    } catch (err) {
        record('Non-streaming chat completion', false, err.message);
    }

    // ===== TEST 2: Streaming chunk sequence =====
    console.log('\nTEST 2: Streaming chunk sequence');
    console.log('-'.repeat(40));
    try {
        const r = await openaiRequest('/v1/chat/completions', {
            model,
            stream: true,
            messages: [{ role: 'user', content: 'Count from 1 to 5, digits only.' }],
            max_tokens: 100
        }, { expectStream: true });
        const contentChunks = r.chunks.filter(c => typeof c.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content.length > 0);
        const finishChunk = r.chunks.find(c => c.choices?.[0]?.finish_reason);
        const firstChunk = r.chunks[0];
        const ok = r.statusCode === 200
            && r.done === true
            && firstChunk?.object === 'chat.completion.chunk'
            && firstChunk?.choices?.[0]?.delta?.role === 'assistant'
            && contentChunks.length > 0
            && !!finishChunk
            && finishChunk.choices[0].finish_reason === 'stop'
            && r.chunks.indexOf(finishChunk) === r.chunks.length - 1 // finish is last JSON chunk
            && r.chunks.every(c => c.object === 'chat.completion.chunk');
        console.log(`  chunks: ${r.chunks.length}, content deltas: ${contentChunks.length}, finish_reason: ${finishChunk?.choices?.[0]?.finish_reason}, [DONE]: ${r.done}`);
        record('Streaming chunk sequence', ok);
    } catch (err) {
        record('Streaming chunk sequence', false, err.message);
    }

    // ===== TEST 3: Tool call round-trip =====
    console.log('\nTEST 3: Tool call round-trip');
    console.log('-'.repeat(40));
    try {
        const r = await openaiRequest('/v1/chat/completions', {
            model,
            messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
            max_tokens: 300,
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get the current weather for a location',
                    parameters: {
                        type: 'object',
                        properties: { location: { type: 'string', description: 'City name' } },
                        required: ['location']
                    }
                }
            }],
            tool_choice: 'auto'
        });
        const msg = r.json?.choices?.[0]?.message;
        const toolCalls = msg?.tool_calls;
        const ok = r.statusCode === 200
            && Array.isArray(toolCalls)
            && toolCalls.length > 0
            && toolCalls[0].type === 'function'
            && toolCalls[0].function?.name === 'get_weather'
            && r.json.choices[0].finish_reason === 'tool_calls';
        let argsValid = false;
        if (ok) {
            try {
                const args = JSON.parse(toolCalls[0].function.arguments);
                argsValid = typeof args.location === 'string';
            } catch (e) { }
        }
        console.log(`  finish_reason: ${r.json?.choices?.[0]?.finish_reason}, tool_calls: ${JSON.stringify(toolCalls?.map(t => t.function?.name))}`);
        record('Tool call round-trip', ok && argsValid);
    } catch (err) {
        record('Tool call round-trip', false, err.message);
    }

    // ===== TEST 4: Error format (invalid model) =====
    console.log('\nTEST 4: Error format (invalid model -> 400 OpenAI error)');
    console.log('-'.repeat(40));
    try {
        const r = await openaiRequest('/v1/chat/completions', {
            model: 'not-a-real-model-xyz',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 10
        });
        const ok = r.statusCode === 400
            && r.json?.error
            && typeof r.json.error.message === 'string'
            && typeof r.json.error.type === 'string'
            && r.json.error.code === null
            && !r.json.error.type.startsWith('authentication_');
        console.log(`  statusCode: ${r.statusCode}, error: ${JSON.stringify(r.json?.error)}`);
        record('Error format (invalid model)', ok);
    } catch (err) {
        record('Error format (invalid model)', false, err.message);
    }

    // ===== TEST 5: Named key auth + quota 429 (OpenAI envelope) =====
    console.log('\nTEST 5: Named key auth + quota 429');
    console.log('-'.repeat(40));
    let testKey = null;
    let skipped = false;
    try {
        // Probe WebUI: when a password is set, unauthenticated /api/keys returns 401.
        const probe = await webuiRequest('/api/keys', null, null);
        if (probe.statusCode === 401) {
            skipped = true;
            console.log('  SKIPPED: WebUI password configured; cannot create test key without credentials.');
            console.log('  (Manual verification: create a key in WebUI, set spendingLimit {metric:"tokens", limit:1}, call endpoint.)');
        } else {
            // Create a key with a 1-token budget -> any successful request trips quota 429.
            const created = await webuiRequest('/api/keys', {
                name: 'openai-endpoint-test-tmp',
                spendingLimit: { metric: 'tokens', limit: 1 }
            });
            if (created.statusCode !== 200 || !created.json?.plaintext) {
                throw new Error(`key creation failed: ${created.statusCode} ${JSON.stringify(created.json)}`);
            }
            testKey = created.json;
            const plaintext = created.json.plaintext;

            // Auth works in OpenAI Bearer style and maps to keyId usage.
            const chat = await openaiRequest('/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 10
            }, { apiKey: plaintext });
            if (chat.statusCode !== 200) {
                throw new Error(`named-key chat failed: ${chat.statusCode} ${JSON.stringify(chat.json)}`);
            }

            // Quota is now exhausted (>=1 token used) -> 429 in OpenAI envelope.
            const quota = await openaiRequest('/v1/chat/completions', {
                model,
                messages: [{ role: 'user', content: 'hi again' }],
                max_tokens: 10
            }, { apiKey: plaintext });
            const usageCheck = await webuiRequest(`/api/keys/${testKey.key.id}/usage`, null, null);
            const ok = quota.statusCode === 429
                && quota.json?.error
                && quota.json.error.type === 'rate_limit_exceeded'
                && quota.json.error.code === null
                && usageCheck.statusCode === 200
                && (usageCheck.json?.summary?.usage?.requests || 0) >= 1;
            console.log(`  quota statusCode: ${quota.statusCode}, error.type: ${quota.json?.error?.type}, key usage requests: ${usageCheck.json?.summary?.usage?.requests}`);
            record('Named key quota 429 (OpenAI envelope + usage keyId)', ok);
        }
    } catch (err) {
        record('Named key quota 429', false, err.message);
    } finally {
        if (testKey) {
            const del = await webuiRequest(`/api/keys/${testKey.key.id}`, null, null, 'DELETE');
            // DELETE with no body -> method must be DELETE; webuiRequest uses POST when body present.
            if (del.statusCode !== 200) {
                console.log(`  WARN: cleanup delete returned ${del.statusCode} — remove key '${testKey.key.name}' manually in WebUI.`);
            }
        }
    }

    // ===== TEST 6: Invalid key -> 401 in OpenAI envelope =====
    console.log('\nTEST 6: Invalid key 401 (OpenAI envelope)');
    console.log('-'.repeat(40));
    try {
        const bad = await openaiRequest('/v1/chat/completions', {
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5
        }, { apiKey: 'sk-agy-definitely-not-a-real-key-000000000000000000000000' });
        const ok = bad.statusCode === 401
            && !!bad.json?.error
            && bad.json.error.type === 'invalid_api_key'
            && bad.json.error.code === 'invalid_api_key'
            && typeof bad.json.error.message === 'string';
        console.log(`  statusCode: ${bad.statusCode}, error.type: ${bad.json?.error?.type}, error.code: ${bad.json?.error?.code}`);
        record('Invalid key 401 (OpenAI envelope)', ok);
    } catch (err) {
        record('Invalid key 401 (OpenAI envelope)', false, err.message);
    }

    // ===== Summary =====
    console.log(`\n${'='.repeat(60)}`);
    console.log('RESULTS:');
    for (const r of results) {
        console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
    }
    const failedCount = results.filter(r => !r.passed).length;
    console.log(`${'='.repeat(60)}`);
    console.log(`  Total: ${results.length}, Passed: ${results.length - failedCount}, Failed: ${failedCount}${skipped ? ' (1 skipped)' : ''}`);
    console.log(`${'='.repeat(60)}`);

    if (failedCount > 0) {
        console.log('\n❌ SOME TESTS FAILED');
        process.exit(1);
    } else {
        console.log('\n✅ ALL TESTS PASSED');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

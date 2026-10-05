const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..');
const configUrl = pathToFileURL(path.join(repoRoot, 'src/config.js')).href;
const configRouteUrl = pathToFileURL(path.join(repoRoot, 'src/webui/routes/config.js')).href;
const messagesRoutePath = path.join(repoRoot, 'src/server/routes-messages.js');
const streamingHandlerPath = path.join(repoRoot, 'src/cloudcode/streaming-handler.js');
const requestConverterPath = path.join(repoRoot, 'src/format/request-converter.js');
const thinkingTextStreamerUrl = pathToFileURL(path.join(repoRoot, 'src/cloudcode/thinking-text-streamer.js')).href;
const serverConfigPath = path.join(repoRoot, 'public/js/components/server-config.js');
const settingsViewPath = path.join(repoRoot, 'public/views/settings.html');
const translationPaths = ['en', 'zh', 'pt', 'id', 'tr'].map((locale) => path.join(repoRoot, `public/js/translations/${locale}.js`));
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-thinking-as-text-'));

const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import vm from 'node:vm';
    import { config, getPublicConfig } from ${JSON.stringify(configUrl)};
    import { registerConfigRoutes } from ${JSON.stringify(configRouteUrl)};
    import {
        MAX_THINKING_TEXT_BLOCK_BYTES,
        MAX_THINKING_TEXT_RESPONSE_BYTES,
        stripThinkingTextHistory,
        transformThinkingAsTextEvents
    } from ${JSON.stringify(thinkingTextStreamerUrl)};
    import { logger } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/utils/logger.js')).href)};

    const collectEvents = async (events, options) => {
        const output = [];
        for await (const event of transformThinkingAsTextEvents(events, options)) output.push(event);
        return output;
    };
    const asAsyncEvents = async function* (events) {
        yield* events;
    };
    const validSignature = 's'.repeat(50);
    const thinkingEvents = [
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'line one\\r\\n\\r\\nline two' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: validSignature } },
        { type: 'content_block_stop', index: 1 }
    ];
    const transformedThinking = await collectEvents(asAsyncEvents(thinkingEvents), { thinkingAsText: true, isClaudeCode: true });
    assert.deepEqual(transformedThinking, [
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
            type: 'content_block_delta',
            index: 1,
            delta: {
                type: 'text_delta',
                text: String.fromCharCode(27) + '[2m> 💭 Thinking⁣agy-thinking-text-v1⁣\\n> line one\\n> \\n> line two' + String.fromCharCode(27) + '[0m'
            }
        },
        { type: 'content_block_stop', index: 1 }
    ]);
    assert.equal(transformedThinking.some((event) => event.delta?.type === 'thinking_delta' || event.delta?.type === 'signature_delta'), false);

    const surroundingEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before' } },
        { type: 'content_block_stop', index: 0 },
        ...thinkingEvents,
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_test', name: 'tool', input: {} } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } } },
        { type: 'content_block_stop', index: 3 }
    ];
    const transformedSurrounding = await collectEvents(asAsyncEvents(surroundingEvents), { thinkingAsText: true, isClaudeCode: true });
    assert.deepEqual(transformedSurrounding.filter((event) => event.index !== 1), surroundingEvents.filter((event) => event.index !== 1));

    const unsignedEvents = thinkingEvents.filter((event) => event.delta?.type !== 'signature_delta');
    assert.deepEqual(await collectEvents(asAsyncEvents(unsignedEvents), { thinkingAsText: true, isClaudeCode: true }), transformedThinking);
    assert.deepEqual(await collectEvents(asAsyncEvents(thinkingEvents), { thinkingAsText: false, isClaudeCode: true }), thinkingEvents);
    assert.deepEqual(await collectEvents(asAsyncEvents(thinkingEvents), { thinkingAsText: true, isClaudeCode: false }), thinkingEvents);

    const logStart = logger.getHistory().length;
    const oversizedBlock = [
        { type: 'content_block_start', index: 4, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 4, delta: { type: 'thinking_delta', thinking: 'block-secret'.repeat(Math.ceil((MAX_THINKING_TEXT_BLOCK_BYTES + 1) / 12)) } },
        { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: validSignature } },
        { type: 'content_block_stop', index: 4 },
        { type: 'content_block_start', index: 5, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: 'after block limit' } },
        { type: 'content_block_stop', index: 5 }
    ];
    const oversizedBlockOutput = await collectEvents(asAsyncEvents(oversizedBlock), { thinkingAsText: true, isClaudeCode: true });
    assert.equal(oversizedBlockOutput.some((event) => event.index === 4), false);
    assert.equal(oversizedBlockOutput.find((event) => event.delta?.text === 'after block limit')?.index, 5);
    assert.equal(logger.getHistory().slice(logStart).some((entry) => entry.message.includes('block-secret')), false);

    const oversizedUtf8Block = [
        { type: 'content_block_start', index: 6, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 6, delta: { type: 'thinking_delta', thinking: '💭'.repeat(Math.floor(MAX_THINKING_TEXT_BLOCK_BYTES / 4) + 1) } },
        { type: 'content_block_delta', index: 6, delta: { type: 'signature_delta', signature: validSignature } },
        { type: 'content_block_stop', index: 6 }
    ];
    assert.deepEqual(await collectEvents(asAsyncEvents(oversizedUtf8Block), { thinkingAsText: true, isClaudeCode: true }), []);

    const responseLimitEvents = [];
    for (let index = 0; index < 5; index++) {
        responseLimitEvents.push(
            { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'r'.repeat(index === 4 ? 1 : MAX_THINKING_TEXT_BLOCK_BYTES) } },
            { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: validSignature } },
            { type: 'content_block_stop', index }
        );
    }
    responseLimitEvents.push(
        { type: 'content_block_start', index: 5, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: 'after response limit' } },
        { type: 'content_block_stop', index: 5 }
    );
    const responseLimitOutput = await collectEvents(asAsyncEvents(responseLimitEvents), { thinkingAsText: true, isClaudeCode: true });
    assert.equal(responseLimitOutput.filter((event) => event.delta?.type === 'text_delta' && event.index < 5).length, 4);
    assert.equal(responseLimitOutput.some((event) => event.index === 4), false);
    assert.equal(responseLimitOutput.find((event) => event.delta?.text === 'after response limit')?.index, 5);
    assert.equal(MAX_THINKING_TEXT_RESPONSE_BYTES, 1024 * 1024);

    const failingEvents = async function* () {
        yield thinkingEvents[0];
        yield thinkingEvents[1];
        throw new Error('stream interrupted');
    };
    await assert.rejects(() => collectEvents(failingEvents(), { thinkingAsText: true, isClaudeCode: true }), /stream interrupted/);
    assert.deepEqual(await collectEvents(asAsyncEvents(thinkingEvents), { thinkingAsText: true, isClaudeCode: true }), transformedThinking);

    const renderedThinking = transformedThinking[1].delta.text;
    const history = [
        { role: 'assistant', content: [{ type: 'text', text: renderedThinking }, { type: 'text', text: renderedThinking + 'final answer' }, { type: 'thinking', thinking: 'native', signature: validSignature }] },
        { role: 'user', content: [{ type: 'text', text: renderedThinking }] },
        { role: 'assistant', content: [{ type: 'text', text: '> ordinary quote' }] }
    ];
    const cleanedHistory = stripThinkingTextHistory(history);
    assert.deepEqual(cleanedHistory[0].content, [
        { type: 'text', text: 'final answer' },
        { type: 'thinking', thinking: 'native', signature: validSignature }
    ]);
    assert.deepEqual(cleanedHistory[1], history[1]);
    assert.deepEqual(cleanedHistory[2], history[2]);
    assert.deepEqual(history[0].content[0], { type: 'text', text: renderedThinking });
    const requestConverterSource = fs.readFileSync(${JSON.stringify(requestConverterPath)}, 'utf8');
    assert.ok(requestConverterSource.includes('stripThinkingTextHistory(cleanCacheControl(anthropicRequest.messages || []))'));

    const messagesRouteSource = fs.readFileSync(${JSON.stringify(messagesRoutePath)}, 'utf8');
    assert.ok(messagesRouteSource.includes("return /^(?:claude-cli|claude-code)(?:\\\\/|\\\\s|$)/i.test(userAgent || '');"));
    const claudeCodeUserAgent = /^(?:claude-cli|claude-code)(?:\\/|\\s|$)/i;
    assert.equal(claudeCodeUserAgent.test(undefined || ''), false);
    assert.equal(claudeCodeUserAgent.test('anthropic-sdk-node/0.39.0'), false);
    assert.equal(claudeCodeUserAgent.test('my-claude-code/2.1.0'), false);
    assert.equal(claudeCodeUserAgent.test('claude-cli/2.1.0'), true);
    assert.equal(claudeCodeUserAgent.test('claude-code 2.1.0'), true);
    assert.ok(messagesRouteSource.includes('thinkingAsText: config.thinkingAsText === true'));
    assert.ok(messagesRouteSource.includes("isClaudeCode: isClaudeCodeUserAgent(req.get('user-agent'))"));
    const streamingHandlerSource = fs.readFileSync(${JSON.stringify(streamingHandlerPath)}, 'utf8');
    assert.ok(streamingHandlerSource.includes('emitUnsignedThinking: renderThinkingAsText'));

    const routes = new Map();
    registerConfigRoutes({
        get: () => {},
        post: (route, handler) => routes.set(route, handler)
    }, { packageVersion: 'test', accountManager: null });

    const updateConfig = async (body) => {
        let statusCode = 200;
        let payload;
        await routes.get('/api/config')(
            { body },
            {
                status: (status) => {
                    statusCode = status;
                    return { json: (value) => { payload = value; } };
                },
                json: (value) => { payload = value; }
            }
        );
        return { statusCode, payload };
    };

    assert.equal(getPublicConfig().thinkingAsText, false);
    for (const invalidValue of [null, 'true', 1, {}, []]) {
        const result = await updateConfig({ thinkingAsText: invalidValue });
        assert.equal(result.statusCode, 400);
        assert.equal(result.payload.error.type, 'invalid_request_error');
        assert.equal(config.thinkingAsText, false);
    }

    const enabled = await updateConfig({ thinkingAsText: true });
    assert.equal(enabled.statusCode, 200);
    assert.equal(config.thinkingAsText, true);
    const configPath = path.join(process.env.HOME, '.config', 'antigravity-proxy', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).thinkingAsText, true);

    const disabled = await updateConfig({ thinkingAsText: false });
    assert.equal(disabled.statusCode, 200);
    assert.equal(config.thinkingAsText, false);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).thinkingAsText, false);

    const toasts = [];
    let fetches = 0;
    let requests = [];
    const store = {
        t: (key, values = {}) => key + ':' + (values.status || ''),
        showToast: (...args) => toasts.push(args)
    };
    const sandbox = {
        Alpine: { store: () => store },
        console,
        setTimeout,
        clearTimeout,
        window: {
            Components: {},
            AppConstants: { INTERVALS: { CONFIG_DEBOUNCE: 0 } },
            utils: {
                request: async (_path, options) => {
                    requests.push(options);
                    return { response: { json: async () => ({ status: 'ok' }) } };
                }
            }
        }
    };
    vm.runInNewContext(fs.readFileSync(${JSON.stringify(serverConfigPath)}, 'utf8'), sandbox);
    const component = sandbox.window.Components.serverConfig();
    component.serverConfig = { thinkingAsText: false };
    component.fetchServerConfig = async () => { fetches++; };
    await component.toggleThinkingAsText(true);
    assert.equal(component.serverConfig.thinkingAsText, true);
    assert.equal(fetches, 1);
    assert.deepEqual(JSON.parse(requests[0].body), { thinkingAsText: true });

    sandbox.window.utils.request = async () => ({ response: { json: async () => ({ status: 'error', error: 'nope' }) } });
    await component.toggleThinkingAsText(false);
    assert.equal(component.serverConfig.thinkingAsText, true);
    assert.equal(toasts.at(-1)[1], 'error');

    const settingsView = fs.readFileSync(${JSON.stringify(settingsViewPath)}, 'utf8');
    assert.match(settingsView, /toggleThinkingAsText/);
    for (const translationPath of ${JSON.stringify(translationPaths)}) {
        const translation = fs.readFileSync(translationPath, 'utf8');
        for (const key of ['thinkingAsText', 'thinkingAsTextDesc', 'thinkingAsTextToggled', 'failedToUpdateThinkingAsText']) {
            assert.match(translation, new RegExp('\\\\b' + key + '\\\\s*:'));
        }
    }
`;

try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, API_KEY: 'test-api-key' },
        stdio: 'inherit'
    });
    execFileSync(process.execPath, ['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { getPublicConfig } from ${JSON.stringify(configUrl)};
        assert.equal(getPublicConfig().thinkingAsText, false);
    `], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, API_KEY: 'test-api-key' },
        stdio: 'inherit'
    });
    console.log('✓ thinkingAsText 配置校验与持久化');
} finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
}

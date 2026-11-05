#!/usr/bin/env node
/**
 * Auto Model Routing Test Suite
 *
 * Runs standalone — NOT registered in tests/run-all.cjs (that runner assumes :8080).
 *
 * Usage:
 *   npm run test:auto -- --unit-only   # pure functions + source assertions, no server
 *   npm run test:auto                  # + self-started server on a free ephemeral port
 *                                      #   (AUTO_TEST_PORT overrides)
 *   AUTO_TEST_LIVE=1 npm run test:auto # + live upstream cases (copies accounts.json into a temp HOME)
 *
 * The live section exists because cross-vendor switching (Claude -> Gemini) depends on real
 * upstream quota exhaustion, which cannot be simulated locally. When the switch does not
 * happen, the case is reported as SKIP — never as a pass.
 */

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const UNIT_ONLY = process.argv.includes('--unit-only');
const LIVE = process.env.AUTO_TEST_LIVE === '1';
// Explicit override wins; otherwise a free ephemeral port is picked at runtime
// (a fixed port is never assumed available — other local services may hold it).
const RAW_PORT = process.env.AUTO_TEST_PORT;
const EXPLICIT_PORT = RAW_PORT === undefined ? null : Number(RAW_PORT);
if (EXPLICIT_PORT !== null && (!Number.isInteger(EXPLICIT_PORT) || EXPLICIT_PORT < 1 || EXPLICIT_PORT > 65535)) {
    console.error(`AUTO_TEST_PORT must be an integer between 1 and 65535, got "${RAW_PORT}"`);
    process.exit(2);
}
let TEST_PORT = EXPLICIT_PORT;
const TEST_API_KEY = 'test-auto-key';
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let skipped = 0;

class SkipError extends Error {}

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        if (err instanceof SkipError) {
            skipped++;
            console.warn(`  ⏭  ${name} — SKIP: ${err.message}`);
            return;
        }
        failed++;
        console.error(`  ❌ ${name}\n     ${err.message}`);
    }
}

function skip(name, reason) {
    skipped++;
    console.warn(`  ⏭  ${name} — SKIP: ${reason}`);
}

/** Abort a test case as SKIP instead of counting it as a pass. */
function skipTest(reason) {
    throw new SkipError(reason);
}

function assertEq(actual, expected, label = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`);
}

/** Remove block and line comments so assertions target executable code only. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/** Extract balanced-paren argument lists for every `needle(` occurrence. */
function extractCalls(src, needle) {
    const calls = [];
    let i = src.indexOf(needle);
    while (i !== -1) {
        const open = i + needle.length - 1; // points at '('
        let depth = 0;
        let j = open;
        for (; j < src.length; j++) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') {
                depth--;
                if (depth === 0) { j++; break; }
            }
        }
        calls.push(src.slice(open + 1, j - 1));
        i = src.indexOf(needle, j);
    }
    return calls;
}

/** Count top-level comma-separated arguments. */
function countArgs(argsText) {
    let depth = 0;
    let count = argsText.trim() ? 1 : 0;
    for (const c of argsText) {
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) count++;
    }
    return count;
}

/**
 * Patch logger.warn on the SAME instance the modules import, so warn-count
 * assertions observe the real calls (a CJS require() would be a second instance).
 */
function captureWarn(logger, fn) {
    const original = logger.warn;
    const messages = [];
    logger.warn = (...args) => messages.push(args.join(' '));
    try {
        fn();
    } finally {
        logger.warn = original;
    }
    return messages;
}

// ============================================================================
// Phase 1 — pure functions
// ============================================================================
async function runUnitPhase() {
    console.log('\n── Phase 1: pure functions ──');

    const {
        isAutoModel,
        resolveChainModel,
        normalizeAutoChain,
        validateAutoModelConfig,
        shouldSignalQuotaExhaustion,
        countActiveQuotaExhausted
    } = await import('../src/cloudcode/auto-model.js');
    const { QuotaExhaustedError, isQuotaExhaustedError } = await import('../src/errors.js');
    const { parseError } = await import('../src/server/parse-error.js');
    const { MODEL_MAP } = await import('../src/constants.js');
    const { logger } = await import('../src/utils/logger.js');

    await test('isAutoModel is case/whitespace insensitive', () => {
        for (const v of ['auto', ' AUTO ', 'Auto']) assert.strictEqual(isAutoModel(v), true, v);
        for (const v of ['automodel', 'claude-auto', '', null, undefined, 0]) {
            assert.strictEqual(isAutoModel(v), false, String(v));
        }
    });

    await test('resolveChainModel applies MODEL_MAP then modelMapping', () => {
        const alias = Object.keys(MODEL_MAP)[0];
        assertEq(resolveChainModel(alias, {}), MODEL_MAP[alias], 'MODEL_MAP');
        assertEq(resolveChainModel('x', { x: { mapping: 'y' } }), 'y', 'modelMapping');
        assertEq(resolveChainModel(alias, { [MODEL_MAP[alias]]: { mapping: 'z' } }), 'z', 'both');
    });

    await test('resolveChainModel rejects prototype keys and non-string mappings', () => {
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            assertEq(resolveChainModel(key, {}), '', key);
        }
        assertEq(resolveChainModel({}, {}), '', 'non-string name');
        assertEq(resolveChainModel('x', { x: { mapping: 123 } }), 'x', 'non-string mapping ignored');
        assertEq(resolveChainModel('x', JSON.parse('{"__proto__": {"mapping": "y"}}')), 'x', 'unsafe key ignored');
        assertEq(normalizeAutoChain({ enabled: true, models: [{ model: '__proto__', priority: 1 }] }, {}), [],
            'normalize drops unresolvable');
        assertEq(validateAutoModelConfig({ enabled: true, models: [{ model: 'constructor', priority: 1 }] }, {}).ok,
            false, 'validate rejects');
    });

    await test('countActiveQuotaExhausted counts only fresh QUOTA_EXHAUSTED limits', () => {
        const now = 1_000_000;
        const mk = (email, reason, delta, isRateLimited = true) => ({
            email,
            modelRateLimits: { m: { isRateLimited, resetTime: now + delta, reason } }
        });
        const accounts = [
            mk('a', 'QUOTA_EXHAUSTED', 1000),
            mk('b', 'QUOTA_EXHAUSTED', -1),            // expired
            mk('c', 'QUOTA_EXHAUSTED', 1000, false),   // not rate-limited
            mk('d', 'RATE_LIMIT_EXCEEDED', 1000),
            mk('e', null, 1000),
            { email: 'f' }
        ];
        assertEq(countActiveQuotaExhausted(accounts, 'm', now), 1, 'count');
        assertEq(countActiveQuotaExhausted(accounts, 'other', now), 0, 'different model');
    });

    await test('normalizeAutoChain: [3,1,2] sorts ascending, ties keep array order', () => {
        const chain = normalizeAutoChain({
            enabled: true,
            models: [{ model: 'c', priority: 3 }, { model: 'a', priority: 1 }, { model: 'b', priority: 2 }]
        }, {});
        assertEq(chain, ['a', 'b', 'c'], 'order');

        const tie = normalizeAutoChain({
            enabled: true,
            models: [{ model: 'x', priority: 1 }, { model: 'y', priority: 1 }]
        }, {});
        assertEq(tie, ['x', 'y'], 'stable tie');
    });

    await test('normalizeAutoChain: dedupe keeps highest priority, drops aliases/auto/invalid', () => {
        const chain = normalizeAutoChain({
            enabled: true,
            models: [
                { model: 'a', priority: 2 },
                { model: 'a', priority: 1 },
                { model: 'b', priority: 3 },
                { model: 'auto', priority: 4 },
                { model: '', priority: 5 },
                { model: 'c', priority: Number.NaN }
            ]
        }, {});
        assertEq(chain, ['a', 'b'], 'dedupe/filter');

        const viaMapping = normalizeAutoChain({
            enabled: true,
            models: [{ model: 'x', priority: 1 }]
        }, { x: { mapping: 'auto' } });
        assertEq(viaMapping, [], 'mapping to auto');
    });

    await test('normalizeAutoChain: truncates above AUTO_MODEL_MAX_CHAIN with one warn', () => {
        const models = Array.from({ length: 12 }, (_, i) => ({ model: `m${i}`, priority: i + 1 }));
        let chain;
        const warns = captureWarn(logger, () => { chain = normalizeAutoChain({ enabled: true, models }, {}); });
        assertEq(chain.length, 10, 'length');
        assertEq(chain[0], 'm0', 'first');
        assertEq(warns.filter(m => m.includes('truncating')).length, 1, 'exactly one truncation warn');
    });

    await test('normalizeAutoChain: disabled is silent, enabled+empty warns once', () => {
        const disabled = captureWarn(logger, () =>
            normalizeAutoChain({ enabled: false, models: [{ model: 'a', priority: 1 }] }, {}));
        assertEq(disabled, [], 'no warn when disabled');

        let emptyResult;
        const emptyWarns = captureWarn(logger, () => {
            emptyResult = normalizeAutoChain({ enabled: true, models: [] }, {});
        });
        assertEq(emptyResult, [], 'empty chain');
        assertEq(emptyWarns.filter(m => m.includes('resolves to empty')).length, 1, 'one warn');
    });

    await test('validateAutoModelConfig rejects every documented invalid shape', () => {
        const bad = [
            [{ enabled: 'yes', models: [] }, 'enabled'],
            [{ enabled: true, models: [] }, 'empty when enabled'],
            [{ enabled: true, models: [{ model: '  ', priority: 1 }] }, 'non-empty string'],
            [{ enabled: true, models: [{ model: 'a', priority: 0 }] }, 'positive integer'],
            [{ enabled: true, models: [{ model: 'a', priority: 1.5 }] }, 'positive integer'],
            [{ enabled: true, models: [{ model: 'auto', priority: 1 }] }, 'must not be'],
            [{ enabled: true, models: [{ model: 'a', priority: 1 }, { model: 'a', priority: 2 }] }, 'duplicates'],
            [{ enabled: true, models: Array.from({ length: 11 }, (_, i) => ({ model: `m${i}`, priority: i + 1 })) }, 'at most 10']
        ];
        for (const [input, needle] of bad) {
            const r = validateAutoModelConfig(input, {});
            assert.strictEqual(r.ok, false, `should reject ${needle}`);
            assert.ok(r.error.toLowerCase().includes(needle.toLowerCase()), `message for ${needle}: ${r.error}`);
        }
    });

    await test('validateAutoModelConfig accepts disabled+empty, disabled+non-empty, enabled+valid', () => {
        assertEq(validateAutoModelConfig({ enabled: false, models: [] }, {}).ok, true, 'disabled empty');
        assertEq(validateAutoModelConfig({ enabled: false, models: [{ model: 'a', priority: 3 }] }, {}).ok, true, 'disabled non-empty');
        assertEq(validateAutoModelConfig({ enabled: true, models: [{ model: 'a', priority: 1 }] }, {}).ok, true, 'enabled valid');
    });

    await test('isQuotaExhaustedError is type-only, never text-based', () => {
        assertEq(isQuotaExhaustedError(new QuotaExhaustedError('x')), true, 'instance');
        assertEq(isQuotaExhaustedError(Object.assign(new Error('x'), { name: 'QuotaExhaustedError' })), true, 'name');
        for (const msg of [
            'RESOURCE_EXHAUSTED: Rate limited on m. Quota will reset after 1m0s.',
            'QUOTA_EXHAUSTED: quota exceeded',
            'Max retries exceeded',
            'CAPACITY_EXHAUSTED: model overloaded'
        ]) {
            assertEq(isQuotaExhaustedError(new Error(msg)), false, msg);
        }
    });

    await test('parseError extracts clean model name and non-default Retry-After', () => {
        const cases = [
            ['RESOURCE_EXHAUSTED: Rate limited on claude-opus-4-6. Quota will reset after 5m0s.', 'claude-opus-4-6', 300000],
            ['RESOURCE_EXHAUSTED: Rate limited on gemini-pro-agent. Quota will reset after 2m30s.', 'gemini-pro-agent', 150000]
        ];
        for (const [message, model, retry] of cases) {
            const r = parseError(new Error(message));
            assertEq(r.errorType, 'rate_limit_error', 'errorType');
            assertEq(r.statusCode, 429, 'status');
            assert.ok(r.errorMessage.includes(`capacity on ${model}.`), `clean model in: ${r.errorMessage}`);
            assert.ok(!r.errorMessage.includes('Rate limited on'), 'no internal prefix leaked');
            assertEq(r.retryAfterMs, retry, 'retryAfterMs');
            assert.ok(r.retryAfterMs !== 60000, 'not the fixed default');
        }
    });

    await test('shouldSignalQuotaExhaustion truth table', () => {
        const fn = shouldSignalQuotaExhaustion;
        assertEq(fn({ quotaSignal: false, quotaExhaustedCount: 5, availableCount: 0 }), false, 'flag off');
        assertEq(fn({ quotaSignal: true, quotaExhaustedCount: 0, availableCount: 0 }), false, 'no exhaustion');
        assertEq(fn({ quotaSignal: true, quotaExhaustedCount: 2, availableCount: 1 }), false, 'still available');
        assertEq(fn({ quotaSignal: true, quotaExhaustedCount: 2, availableCount: 0 }), true, 'all exhausted');
    });
}

// ============================================================================
// Phase 2 — source assertions on handler changes
// ============================================================================
async function runSourcePhase() {
    console.log('\n── Phase 2: handler source assertions ──');

    const streaming = fs.readFileSync(path.join(REPO_ROOT, 'src/cloudcode/streaming-handler.js'), 'utf8');
    const message = fs.readFileSync(path.join(REPO_ROOT, 'src/cloudcode/message-handler.js'), 'utf8');
    const wrapper = fs.readFileSync(path.join(REPO_ROOT, 'src/cloudcode/auto-model-handler.js'), 'utf8');
    const autoSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/cloudcode/auto-model.js'), 'utf8');

    await test('quota signal reads live account state, no per-request set remains', () => {
        for (const [label, src, expected] of [['streaming', streaming, 2], ['message', message, 2]]) {
            const code = stripComments(src);
            assertEq(code.split('countActiveQuotaExhausted(').length - 1, expected, `${label} live count calls`);
            assertEq(code.split('quotaExhaustedEmails').length - 1, 0, `${label} no per-request set`);
        }
        assert.ok(autoSrc.includes("limit.reason === 'QUOTA_EXHAUSTED'"), 'reason predicate');
        assert.ok(autoSrc.includes('limit.resetTime > now'), 'freshness predicate');
    });

    await test('quota-only classification is still capacity-gated at every record site', () => {
        const re = /===\s*'QUOTA_EXHAUSTED'\s*&&\s*!isModelCapacityExhausted\(/g;
        for (const [label, src, expected] of [['streaming', stripComments(streaming), 2],
                                              ['message', stripComments(message), 1]]) {
            assertEq((src.match(re) || []).length, expected, `${label} quota-only predicate`);
        }
    });

    await test('capacity backoff branches never record quota exhaustion', () => {
        const capacityCall = 'BACKOFF_BY_ERROR_TYPE.MODEL_CAPACITY_EXHAUSTED, model)';
        for (const [label, src] of [['streaming', streaming], ['message', message]]) {
            const code = stripComments(src);
            let idx = code.indexOf(capacityCall);
            assert.ok(idx > 0, `${label} capacity call present`);
            while (idx !== -1) {
                const window = code.slice(Math.max(0, idx - 400), idx + capacityCall.length);
                assert.ok(!window.includes('countActiveQuotaExhausted('), `${label} capacity branch clean`);
                idx = code.indexOf(capacityCall, idx + capacityCall.length);
            }
        }
    });

    await test('all-limited quota throw precedes MAX_WAIT check and skips sleep', () => {
        for (const [label, src] of [['streaming', streaming], ['message', message]]) {
            const quotaIdx = src.indexOf('if (shouldSignalQuotaExhaustion({');
            const maxWaitIdx = src.indexOf('if (minWaitMs > MAX_WAIT_BEFORE_ERROR_MS)');
            assert.ok(quotaIdx > 0 && maxWaitIdx > 0, `${label} both present`);
            assert.ok(quotaIdx < maxWaitIdx, `${label} ordering`);
            const block = src.slice(quotaIdx, src.indexOf('throw new QuotaExhaustedError(', quotaIdx));
            assert.ok(!block.includes('await sleep('), `${label} no sleep`);
        }
    });

    await test('both handlers count from the model-agnostic pool', () => {
        for (const [label, src] of [['streaming', streaming], ['message', message]]) {
            assert.ok(stripComments(src).includes('getAvailableAccounts(null, allowedEmails)'),
                `${label} model-agnostic lookup`);
        }
    });

    await test('markRateLimited passes reason only at quota classification sites', () => {
        for (const [label, src, expected] of [['streaming', streaming, 2], ['message', message, 1]]) {
            const calls = extractCalls(src, 'accountManager.markRateLimited(');
            const withReason = calls.filter(args =>
                args.includes('? rateLimitReason : null') || args.includes('? retryReason : null'));
            assertEq(withReason.length, expected, `${label} reason-carrying calls`);
            for (const args of calls) {
                if (withReason.includes(args)) continue;
                assert.ok(countArgs(args) <= 3, `${label} non-quota call has extra arg: ${args.trim()}`);
            }
        }
    });

    await test('wrapper never calls resetAllRateLimits and signals quota on both paths', () => {
        const code = stripComments(wrapper);
        assert.ok(!code.includes('resetAllRateLimits'), 'no global reset in executable code');
        assertEq(code.split('quotaSignal: true').length - 1, 2, 'quotaSignal on streaming + non-streaming');
    });
}

// ============================================================================
// Phase 3 — wrapper behaviour with injected deps
// ============================================================================
async function runWrapperPhase() {
    console.log('\n── Phase 3: wrapper (injected deps) ──');

    const { sendMessageAuto, sendMessageStreamAuto } = await import('../src/cloudcode/auto-model-handler.js');
    const { QuotaExhaustedError, isQuotaExhaustedError } = await import('../src/errors.js');
    const { config } = await import('../src/config.js');

    const original = JSON.parse(JSON.stringify({ autoModel: config.autoModel, modelMapping: config.modelMapping }));
    const setChain = (models, enabled = true) => {
        config.autoModel = { enabled, models: models.map((m, i) => ({ model: m, priority: i + 1 })) };
        config.modelMapping = {};
    };

    try {
        await test('non-streaming: quota-exhausted head switches to next model', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            const calls = [];
            const deps = {
                sendMessage: async (req, am, fallback, filter, options) => {
                    calls.push({ model: req.model, fallback, options });
                    if (req.model === 'chain-alpha') throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota');
                    return { id: 'ok', model: req.model };
                }
            };
            let resolved = null;
            const res = await sendMessageAuto({ model: 'auto', messages: [] }, {}, null, {},
                { onModelResolved: (m) => { resolved = m; }, deps });

            assertEq(res.model, 'chain-beta', 'served by second');
            assertEq(resolved, 'chain-beta', 'onModelResolved');
            assertEq(calls.length, 2, 'two attempts');
            assertEq(calls[0].fallback, false, 'fallback disabled');
            assertEq(calls[0].options.quotaSignal, true, 'quotaSignal on');
        });

        await test('non-streaming: non-quota errors abort the chain', async () => {
            for (const msg of ['503 service unavailable', 'invalid_request_error: 400 bad model']) {
                setChain(['chain-alpha', 'chain-beta']);
                let attempts = 0;
                const deps = { sendMessage: async () => { attempts++; throw new Error(msg); } };
                await assert.rejects(
                    () => sendMessageAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps }),
                    (err) => { assertEq(isQuotaExhaustedError(err), false, 'not quota'); return true; }
                );
                assertEq(attempts, 1, `no switch for ${msg}`);
            }
        });

        await test('wrapper never records a failed model as resolved', async () => {
            setChain(['chain-alpha']);
            let resolved = null;
            const deps = { sendMessage: async () => { throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota'); } };
            await assert.rejects(() => sendMessageAuto({ model: 'auto', messages: [] }, {}, null, {},
                { onModelResolved: (m) => { resolved = m; }, deps }));
            assertEq(resolved, null, 'no callback on failure');
        });

        await test('chain exhausted throws QuotaExhaustedError naming the last model', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            const deps = { sendMessage: async () => { throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota'); } };
            await assert.rejects(
                () => sendMessageAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps }),
                (err) => {
                    assertEq(isQuotaExhaustedError(err), true, 'typed');
                    assert.ok(err.message.includes('chain-beta'), `message: ${err.message}`);
                    return true;
                }
            );
        });

        await test('disabled or empty chain throws invalid_request_error pointing at WebUI', async () => {
            const cases = [
                { models: [], enabled: true },
                { models: ['chain-alpha'], enabled: false }
            ];
            for (const { models, enabled } of cases) {
                setChain(models, enabled);
                const deps = { sendMessage: async () => { throw new Error('must not be called'); } };
                await assert.rejects(
                    () => sendMessageAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps }),
                    (err) => {
                        assert.ok(err.message.includes('invalid_request_error'), 'type prefix');
                        assert.ok(err.message.includes('WebUI'), 'guidance');
                        return true;
                    }
                );
            }
        });

        await test('streaming: empty generator advances instead of emitting an empty 200', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            const deps = {
                sendMessageStream: function* (req) {
                    if (req.model === 'chain-alpha') return; // yields nothing
                    yield { type: 'message_start' };
                    yield { type: 'message_stop' };
                }
            };
            let resolved = null;
            const events = [];
            for await (const e of sendMessageStreamAuto({ model: 'auto', messages: [] }, {}, null, {},
                { onModelResolved: (m) => { resolved = m; }, deps })) {
                events.push(e.type);
            }
            assertEq(events, ['message_start', 'message_stop'], 'events');
            assertEq(resolved, 'chain-beta', 'resolved');
        });

        await test('streaming: quota error before first event switches models', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            const deps = {
                sendMessageStream: async function* (req) {
                    if (req.model === 'chain-alpha') throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota');
                    yield { type: 'message_start' };
                }
            };
            const events = [];
            for await (const e of sendMessageStreamAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps })) {
                events.push(e.type);
            }
            assertEq(events, ['message_start'], 'second model streamed');
        });

        await test('streaming: mid-stream quota error propagates without switching models', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            let attempts = 0;
            const emitted = [];
            const deps = {
                sendMessageStream: async function* () {
                    attempts++;
                    yield { type: 'message_start' };
                    throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota after first event');
                }
            };
            await assert.rejects(async () => {
                for await (const e of sendMessageStreamAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps })) {
                    emitted.push(e.type);
                }
            }, (err) => { assertEq(isQuotaExhaustedError(err), true, 'typed error surfaces'); return true; });
            assertEq(attempts, 1, 'no switch once an event was emitted');
            assertEq(emitted, ['message_start'], 'first event already delivered');
        });

        await test('streaming: every model yielding nothing throws EmptyResponseError', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            const deps = { sendMessageStream: function* () { /* yields nothing */ } };
            await assert.rejects(async () => {
                for await (const _ of sendMessageStreamAuto({ model: 'auto', messages: [] }, {}, null, {}, { deps })) {
                    /* drain */
                }
            }, (err) => {
                assertEq(err.name, 'EmptyResponseError', 'typed');
                return true;
            });
        });

        await test('streaming: cancellation stops the chain before the next model', async () => {
            setChain(['chain-alpha', 'chain-beta']);
            let attempts = 0;
            let checks = 0;
            const deps = {
                sendMessageStream: async function* () {
                    attempts++;
                    throw new QuotaExhaustedError('RESOURCE_EXHAUSTED: quota');
                }
            };
            const events = [];
            for await (const e of sendMessageStreamAuto({ model: 'auto', messages: [] }, {}, null,
                { isCancelled: () => ++checks > 1 }, { deps })) {
                events.push(e);
            }
            assertEq(attempts, 1, 'no second attempt');
            assertEq(events, [], 'no events');
        });

    } finally {
        config.autoModel = original.autoModel;
        config.modelMapping = original.modelMapping;
    }
}

// ============================================================================
// Phase 4 — listModels conditionality with a mocked upstream
// ============================================================================
async function runListModelsPhase() {
    console.log('\n── Phase 4: /v1/models conditionality (mocked upstream) ──');

    let undici;
    try {
        undici = require('undici');
    } catch {
        skip('/v1/models conditionality', 'undici unavailable');
        return;
    }

    const { config } = await import('../src/config.js');
    const { listModels } = await import('../src/cloudcode/model-api.js');
    const originalDispatcher = undici.getGlobalDispatcher();
    const originalAuto = config.autoModel;

    /** Run `fn` against a mock upstream that answers fetchAvailableModels with `body`. */
    async function withMockUpstream(body, fn) {
        const mock = new undici.MockAgent();
        mock.disableNetConnect();
        mock.get('https://daily-cloudcode-pa.googleapis.com')
            .intercept({ path: '/v1internal:fetchAvailableModels', method: 'POST' })
            .reply(200, body);
        undici.setGlobalDispatcher(mock);
        try {
            return await fn();
        } finally {
            undici.setGlobalDispatcher(originalDispatcher);
            await mock.close();
        }
    }

    try {
        await test('auto entry is prepended when enabled and chain resolves', async () => {
            config.autoModel = { enabled: true, models: [{ model: 'claude-sonnet-4-6', priority: 1 }] };
            await withMockUpstream({ models: { 'claude-sonnet-4-6': { displayName: 'Sonnet' } } }, async () => {
                const res = await listModels('token');
                assertEq(res.data[0].id, 'auto', 'first entry');
                assertEq(res.data[0].owned_by, 'antigravity-proxy', 'owner');
                assertEq(res.data.length, 2, 'plus upstream model');
            });
        });

        await test('auto still listed when the upstream model map is empty', async () => {
            config.autoModel = { enabled: true, models: [{ model: 'claude-sonnet-4-6', priority: 1 }] };
            await withMockUpstream({}, async () => {
                const res = await listModels('token');
                assertEq(res.data.length, 1, 'only auto');
                assertEq(res.data[0].id, 'auto', 'auto survives early return');
            });
        });

        await test('auto omitted when disabled', async () => {
            config.autoModel = { enabled: false, models: [{ model: 'claude-sonnet-4-6', priority: 1 }] };
            await withMockUpstream({ models: { 'claude-sonnet-4-6': { displayName: 'Sonnet' } } }, async () => {
                const res = await listModels('token');
                assertEq(res.data.map(m => m.id), ['claude-sonnet-4-6'], 'no auto');
            });
        });
    } finally {
        config.autoModel = originalAuto;
    }
}

// ============================================================================
// Phase 5 — integration against a self-started server (isolated HOME)
// ============================================================================
function httpJson(method, apiPath, body, headers = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port: TEST_PORT,
            path: apiPath,
            method,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`timed out after ${timeoutMs}ms: ${method} ${apiPath}`));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

/** Ask the OS for an unused TCP port on the loopback interface. */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function waitForServer(child) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
        try {
            const res = await httpJson('GET', '/health', undefined, {}, 2000);
            if (res.status === 200) return;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server did not become ready within 30s');
}

async function runIntegrationPhase() {
    if (TEST_PORT === null) TEST_PORT = await findFreePort();
    console.log(`\n── Phase 5: integration (port ${TEST_PORT}, isolated HOME) ──`);
    assert.ok(TEST_PORT !== 8080, 'AUTO_TEST_PORT must not collide with :8080');

    let tempHome = null;
    let child = null;
    let configPath = '';
    let serverLog = '';
    const apiHeaders = { 'x-api-key': TEST_API_KEY, 'anthropic-version': '2023-06-01' };

    try {
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auto-test-'));
        fs.chmodSync(tempHome, 0o700);
        const configDir = path.join(tempHome, '.config', 'antigravity-proxy');
        configPath = path.join(configDir, 'config.json');

        // Pre-seed an empty presets file. readServerPresets() returns the shared
        // DEFAULT_SERVER_PRESETS array when the file is absent, and saveServerPreset()
        // pushes into it — which pollutes the built-in name list for the rest of the
        // process (pre-existing behaviour, unrelated to autoModel). A non-empty file
        // takes the copy branch and keeps that constant pristine.
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'server-presets.json'), '[]', 'utf8');

        child = spawn(process.execPath, ['src/index.js'], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: tempHome, PORT: String(TEST_PORT), HOST: '127.0.0.1', API_KEY: TEST_API_KEY },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', c => { serverLog += c; });
        child.stderr.on('data', c => { serverLog += c; });

        await waitForServer(child);

        await test('GET /api/models/auto reports disabled by default', async () => {
            const res = await httpJson('GET', '/api/models/auto');
            assertEq(res.status, 200, 'status');
            assertEq(res.body.autoModel.enabled, false, 'enabled');
            assertEq(res.body.autoModel.models, [], 'models');
            assertEq(res.body.chain, [], 'resolved chain');
        });

        await test('POST /api/models/auto persists and takes effect immediately', async () => {
            const payload = {
                enabled: true,
                models: [
                    { model: 'gemini-pro-agent', priority: 2 },
                    { model: 'claude-opus-4-6-thinking', priority: 1 }
                ]
            };
            const post = await httpJson('POST', '/api/models/auto', payload);
            assertEq(post.status, 200, 'status');
            assertEq(post.body.autoModel.models.map(m => m.model),
                ['gemini-pro-agent', 'claude-opus-4-6-thinking'], 'order preserved as submitted');

            const get = await httpJson('GET', '/api/models/auto');
            assertEq(get.body.autoModel.enabled, true, 'enabled persisted');
            assertEq(get.body.chain, ['claude-opus-4-6-thinking', 'gemini-pro-agent'], 'chain ordered by priority');

            const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assertEq(onDisk.autoModel.enabled, true, 'written to config.json');
            assertEq(onDisk.autoModel.models.length, 2, 'two entries on disk');
        });

        await test('POST /api/models/auto rejects invalid input and leaves config untouched', async () => {
            const before = fs.readFileSync(configPath, 'utf8');
            const res = await httpJson('POST', '/api/models/auto', { enabled: true, models: [] });
            assertEq(res.status, 400, 'status');
            assert.ok(String(res.body.error).includes('must not be empty'), 'reason');
            assertEq(fs.readFileSync(configPath, 'utf8'), before, 'config unchanged');
        });

        await test('POST /api/config rejects invalid autoModel without partial write', async () => {
            const before = JSON.parse(fs.readFileSync(configPath, 'utf8')).autoModel;
            const res = await httpJson('POST', '/api/config', {
                autoModel: { enabled: true, models: [{ model: 'x', priority: 0 }] },
                maxRetries: 7
            });
            assertEq(res.status, 400, 'status');
            assertEq(res.body.error.type, 'invalid_request_error', 'error type');
            assert.ok(String(res.body.error.message).includes('positive integer'), 'reason');

            const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assertEq(after.autoModel, before, 'autoModel unchanged');
            assert.ok(after.maxRetries !== 7, 'sibling field not partially written');
        });

        await test('server presets never capture or apply autoModel', async () => {
            const before = JSON.parse(fs.readFileSync(configPath, 'utf8')).autoModel;
            const created = await httpJson('POST', '/api/server/presets', {
                name: 'auto-test-preset',
                config: { maxRetries: 9, autoModel: { enabled: false, models: [] } }
            });
            assertEq(created.status, 200, 'create status');

            const preset = created.body.presets.find(p => p.name === 'auto-test-preset');
            assert.ok(preset, 'preset listed');
            assert.ok(!Object.hasOwn(preset.config, 'autoModel'), 'autoModel excluded');

            const patched = await httpJson('PATCH', '/api/server/presets/auto-test-preset', {
                config: { maxRetries: 8, autoModel: { enabled: true, models: [{ model: 'x', priority: 1 }] } }
            });
            assertEq(patched.status, 200, 'patch status');
            const patchedPreset = patched.body.presets.find(p => p.name === 'auto-test-preset');
            assert.ok(!Object.hasOwn(patchedPreset.config, 'autoModel'), 'PATCH also excludes autoModel');

            const after = JSON.parse(fs.readFileSync(configPath, 'utf8')).autoModel;
            assertEq(after, before, 'current config autoModel unchanged');
        });

        await test('auto requests fail with 400 config guidance when chain is disabled', async () => {
            const disabled = await httpJson('POST', '/api/models/auto', { enabled: false, models: [] });
            assertEq(disabled.status, 200, 'disable ok');

            const publicConfig = await httpJson('GET', '/api/config');
            assertEq(publicConfig.body.config.autoModel.enabled, false, 'exposed via /api/config');

            const messages = await httpJson('POST', '/v1/messages', {
                model: 'auto',
                max_tokens: 16,
                messages: [{ role: 'user', content: 'ping' }]
            }, apiHeaders);
            assertEq(messages.status, 400, 'anthropic status');
            assertEq(messages.body.error.type, 'invalid_request_error', 'anthropic type');
            assert.ok(messages.body.error.message.includes('WebUI'), 'guidance');

            const chat = await httpJson('POST', '/v1/chat/completions', {
                model: 'auto',
                messages: [{ role: 'user', content: 'ping' }]
            }, apiHeaders);
            assertEq(chat.status, 400, 'openai status');
            assertEq(chat.body.error.type, 'invalid_request_error', 'openai envelope');
            assert.ok(chat.body.error.message.includes('WebUI'), 'openai guidance');
        });

        if (!LIVE) {
            skip('/v1/messages auto served end-to-end', 'live upstream not enabled (set AUTO_TEST_LIVE=1)');
            skip('/v1/chat/completions auto echoes "auto"', 'live upstream not enabled (set AUTO_TEST_LIVE=1)');
            skip('Claude -> Gemini cross-vendor switch with thinking', 'live upstream not enabled (set AUTO_TEST_LIVE=1)');
        } else {
            const realAccounts = path.join(os.homedir(), '.config', 'antigravity-proxy', 'accounts.json');
            let usableCount = 0;
            let accountCount = 0;
            try {
                const parsed = JSON.parse(fs.readFileSync(realAccounts, 'utf8'));
                const accounts = parsed.accounts || [];
                accountCount = accounts.length;
                // The isolated HOME has no Antigravity SQLite DB, so `source: 'database'`
                // accounts cannot refresh there. Only self-contained credentials are usable.
                usableCount = accounts.filter(a => a.refreshToken || a.apiKey).length;
            } catch { /* none */ }

            if (usableCount === 0) {
                const reason = accountCount === 0
                    ? 'no accounts.json in the real HOME'
                    : 'accounts.json has no self-contained credentials (database-source accounts need the Antigravity DB)';
                skip('/v1/messages auto served end-to-end', reason);
                skip('/v1/chat/completions auto echoes "auto"', reason);
                skip('Claude -> Gemini cross-vendor switch with thinking', reason);
            } else {
                // Opt-in: copy credentials into the isolated HOME so the server can reach upstream.
                const target = path.join(tempHome, '.config', 'antigravity-proxy', 'accounts.json');
                fs.copyFileSync(realAccounts, target);
                fs.chmodSync(target, 0o600);
                await httpJson('POST', '/api/accounts/reload', {});

                await httpJson('POST', '/api/models/auto', {
                    enabled: true,
                    models: [
                        { model: 'claude-opus-4-6-thinking', priority: 1 },
                        { model: 'gemini-pro-agent', priority: 2 }
                    ]
                });

                await test('/v1/messages auto served end-to-end, usage-log records the executed model', async () => {
                    const res = await httpJson('POST', '/v1/messages', {
                        model: 'auto',
                        max_tokens: 32,
                        messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
                    }, apiHeaders, 120000);
                    if (res.status === 429) skipTest('upstream quota exhausted');
                    assertEq(res.status, 200, 'status');
                    const usage = await httpJson('GET', '/api/usage-log');
                    const latest = usage.body.records?.[0];
                    assert.ok(latest, 'usage-log record present');
                    assert.ok(['claude-opus-4-6-thinking', 'gemini-pro-agent'].includes(latest.model),
                        `resolved model recorded, got ${latest.model}`);
                });

                await test('/v1/chat/completions auto echoes "auto" while serving a real model', async () => {
                    const res = await httpJson('POST', '/v1/chat/completions', {
                        model: 'auto',
                        messages: [{ role: 'user', content: 'Reply with exactly: ok' }]
                    }, apiHeaders, 120000);
                    if (res.status === 429) skipTest('upstream quota exhausted');
                    assertEq(res.status, 200, 'status');
                    assertEq(res.body.model, 'auto', 'echoed model');
                    assert.ok(res.body.choices?.[0]?.message, 'completion body');
                });

                await test('Claude -> Gemini cross-vendor switch with thinking (two turns)', async () => {
                    const turn1 = await httpJson('POST', '/v1/messages', {
                        model: 'auto',
                        max_tokens: 128,
                        thinking: { type: 'enabled', budget_tokens: 1024 },
                        messages: [{ role: 'user', content: 'Think briefly, then say: first' }]
                    }, apiHeaders, 120000);
                    if (turn1.status === 429) skipTest('upstream quota exhausted');
                    assertEq(turn1.status, 200, 'turn 1');

                    const turn2 = await httpJson('POST', '/v1/messages', {
                        model: 'auto',
                        max_tokens: 128,
                        thinking: { type: 'enabled', budget_tokens: 1024 },
                        messages: [
                            { role: 'user', content: 'Think briefly, then say: first' },
                            { role: 'assistant', content: turn1.body.content },
                            { role: 'user', content: 'Now say: second' }
                        ]
                    }, apiHeaders, 120000);
                    if (turn2.status === 429) skipTest('upstream quota exhausted');
                    assertEq(turn2.status, 200, 'turn 2');

                    // A switch only happens when the head model's quota is actually exhausted.
                    // Without that, the case cannot be exercised — report SKIP, never PASS.
                    skipTest('no switch observed (upstream quota was not exhausted for the head model)');
                });
            }
        }
    } finally {
        if (child) {
            child.kill('SIGTERM');
            await new Promise(resolve => {
                if (child.exitCode !== null || child.signalCode !== null) return resolve();
                const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        if (tempHome) {
            try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        if (failed > 0) {
            console.error('\n── server log (last 4000 chars) ──\n' + (serverLog.slice(-4000) || '(no output)'));
        }
    }
}

// ============================================================================
// Runner
// ============================================================================
(async () => {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           AUTO MODEL ROUTING TEST SUITE                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    await runUnitPhase();
    await runSourcePhase();
    await runWrapperPhase();
    await runListModelsPhase();

    if (UNIT_ONLY) {
        console.log('\n(--unit-only: integration phase skipped)');
    } else {
        await runIntegrationPhase();
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failed > 0) {
        console.error('\n❌ FAILED');
        process.exit(1);
    }
    console.log('\n✅ ALL PASSED');
    process.exit(0);
})().catch(err => {
    console.error('\n💥 Unhandled suite error:', err);
    process.exit(1);
});
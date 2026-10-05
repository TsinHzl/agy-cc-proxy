/**
 * Count Tokens Endpoint Regression Tests
 *
 * Verifies the local estimate used by Claude Code to decide when to compact
 * conversation context, without requiring a running proxy or Cloud Code account.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          COUNT TOKENS ENDPOINT REGRESSION TESTS              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { registerMiscRoutes } = await import('../src/server/routes-misc.js');
    let countTokensHandler;
    const app = {
        post(path, ...handlers) {
            if (path === '/v1/messages/count_tokens') {
                countTokensHandler = handlers.at(-1);
            }
        },
        get() {}
    };

    registerMiscRoutes(app, {});

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${error.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    function invoke(body) {
        let statusCode = 200;
        let payload;
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(value) {
                payload = value;
                return this;
            }
        };

        countTokensHandler({ body }, res);
        return { statusCode, payload };
    }

    console.log('── Count Tokens Contract ────────────────────────────────────────');

    test('counts a text message instead of returning not implemented', () => {
        const result = invoke({
            model: 'gemini-3.8-flash-high',
            messages: [{ role: 'user', content: 'abcd' }]
        });

        assertEqual(result.statusCode, 200);
        assertEqual(result.payload.input_tokens, 5);
    });

    test('rejects missing or malformed messages with an Anthropic-style error', () => {
        for (const messages of [undefined, null, {}]) {
            const result = invoke({ messages });

            assertEqual(result.statusCode, 400);
            assertEqual(result.payload.type, 'error');
            assertEqual(result.payload.error.type, 'invalid_request_error');
            assertEqual(result.payload.error.message, 'messages is required and must be an array');
        }
    });

    test('counts system, tool schema, and structured message content safely', () => {
        const result = invoke({
            system: [{ type: 'text', text: '系统指令' }],
            tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }],
            messages: [{
                role: 'user',
                content: [
                    { type: 'thinking', thinking: 'reasoning' },
                    { type: 'tool_use', input: { id: 1 } },
                    { type: 'tool_result', content: [{ type: 'text', text: 'result' }] }
                ]
            }]
        });

        assertEqual(result.statusCode, 200);
        assertTrue(Number.isInteger(result.payload.input_tokens));
        assertTrue(result.payload.input_tokens > 4);
    });

    test('counts inline image and document blocks conservatively', () => {
        const result = invoke({
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', data: 'a'.repeat(40) } },
                    { type: 'document', source: { type: 'base64', data: 'b'.repeat(60) } },
                    {
                        type: 'tool_result',
                        content: [{ type: 'image', source: { type: 'base64', data: 'c'.repeat(20) } }]
                    }
                ]
            }]
        });

        assertEqual(result.statusCode, 200);
        assertEqual(result.payload.input_tokens, 34);
    });

    test('allows an empty conversation and ignores malformed optional fields', () => {
        const result = invoke({
            system: { unsupported: true },
            tools: 'invalid',
            messages: []
        });

        assertEqual(result.statusCode, 200);
        assertEqual(result.payload.input_tokens, 0);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
    console.error(error);
    process.exit(1);
});

/**
 * Request Builder Contract Tests
 *
 * Verifies Cloud Code request serialization invariants before requests reach
 * Google: envelopes preserve native session, client identity, request-ID, and
 * system-role contracts.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         REQUEST BUILDER CONTRACT TEST SUITE                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { buildCloudCodeRequest, buildHeaders } = await import('../src/cloudcode/request-builder.js');
    const { getPlatformUserAgent } = await import('../src/constants.js');
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');

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

    function assertFalse(value, message = '') {
        if (value) {
            throw new Error(message || 'Expected false but got true');
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    const baseRequest = {
        messages: [{ role: 'user', content: 'test request' }],
        max_tokens: 128
    };

    console.log('\n── Session Identifier Contract ─────────────────────────────────');

    test('Gemini payload keeps its body session identifier without a machine-session header', () => {
        const model = 'gemini-2.5-pro';
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'test-project', 'test@example.com');
        const headers = buildHeaders('test-token', model, 'application/json', payload.request.sessionId);

        assertTrue(
            typeof payload.request.sessionId === 'string' && payload.request.sessionId.length > 0,
            'Gemini payload must contain a non-empty sessionId'
        );
        assertFalse('X-Machine-Session-Id' in headers, 'Gemini headers must not contain X-Machine-Session-Id');
    });

    test('payload requestId uses the native agent format', () => {
        const payload = buildCloudCodeRequest(
            { ...baseRequest, model: 'gemini-2.5-pro' },
            'test-project',
            'test@example.com'
        );

        assertTrue(
            /^agent\/[0-9a-f-]{36}$/i.test(payload.requestId),
            'requestId must match agent/<uuid>'
        );
    });

    test('generation headers retain only the native client identity', () => {
        const headers = buildHeaders('test-token', 'gemini-2.5-pro');

        assertFalse('X-Client-Name' in headers);
        assertFalse('X-Client-Version' in headers);
        assertFalse('x-goog-api-client' in headers);
        assertEqual(headers['User-Agent'], getPlatformUserAgent());
        assertTrue(
            /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=(darwin|linux|win32); arch=(arm64|amd64); cl=\d+; auth_method=consumer\)$/.test(headers['User-Agent']),
            'User-Agent must use the native CLI format'
        );
    });

    test('Claude payload and headers use the same session identifier', () => {
        const model = 'claude-sonnet-4-5';
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'test-project', 'test@example.com');
        const headers = buildHeaders('test-token', model, 'application/json', payload.request.sessionId);

        assertFalse(!payload.request.sessionId, 'Claude payload must contain sessionId');
        assertEqual(headers['X-Machine-Session-Id'], payload.request.sessionId, 'Claude body/header session IDs must match');
    });

    console.log('\n── System Instruction Contract ─────────────────────────────────');

    test('does not synthesize a system instruction when the client omitted one', () => {
        const payload = buildCloudCodeRequest(
            { ...baseRequest, model: 'gemini-2.5-pro' },
            'test-project',
            'test@example.com'
        );

        assertFalse(
            'systemInstruction' in payload.request,
            'Proxy must not inject an Antigravity system instruction'
        );
    });

    test('moves caller system prompt out of systemInstruction into the first user turn', () => {
        const payload = buildCloudCodeRequest(
            {
                ...baseRequest,
                model: 'gemini-2.5-pro',
                system: 'Retain this instruction.'
            },
            'test-project',
            'test@example.com'
        );

        assertFalse('systemInstruction' in payload.request, 'caller system prompt must not stay in systemInstruction');
        assertEqual(payload.request.contents[0].role, 'user');
        assertEqual(payload.request.contents[0].parts.length, 2);
        assertEqual(
            payload.request.contents[0].parts[0].text,
            '<system-instructions>\nRetain this instruction.\n</system-instructions>'
        );
        assertEqual(payload.request.contents[0].parts[1].text, 'test request');
    });

    test('scrubs third-party client identities while preserving headers, filenames, and bare Claude', () => {
        const payload = buildCloudCodeRequest(
            {
                ...baseRequest,
                model: 'gemini-2.5-pro',
                system: [
                    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
                    { type: 'text', text: 'Ask Hermes from Nous Research. See CLAUDE.md, x-anthropic-beta, AnthropicRequest.' }
                ]
            },
            'test-project',
            'test@example.com'
        );

        const text = payload.request.contents[0].parts[0].text;
        assertFalse(text.includes('Claude Code'), 'Claude Code should be scrubbed');
        assertFalse(text.includes('Anthropic\'s'), 'Anthropic should be scrubbed');
        assertFalse(/\bHermes\b/.test(text), 'Hermes should be scrubbed');
        assertFalse(text.includes('Nous Research'), 'Nous Research should be scrubbed');
        assertTrue(text.includes('Claude.'), 'bare Claude must be preserved');
        assertTrue(text.includes('CLAUDE.md'), 'CLAUDE.md must be preserved');
        assertTrue(text.includes('x-anthropic-beta'), 'lowercase header must be preserved');
        assertTrue(text.includes('AnthropicRequest'), 'camelCase identifier must be preserved');
    });

    test('system prompt consisting only of billing header adds no <system-instructions> part', () => {
        const payload = buildCloudCodeRequest(
            {
                ...baseRequest,
                model: 'gemini-2.5-pro',
                system: 'x-anthropic-billing-header: cc_version=2.1.325; cc_entrypoint=sdk-cli;'
            },
            'test-project',
            'test@example.com'
        );

        assertFalse('systemInstruction' in payload.request);
        assertEqual(payload.request.contents[0].parts.length, 1);
        assertEqual(payload.request.contents[0].parts[0].text, 'test request');
    });

    test('leading model turn gets a prepended user turn for system prompt', () => {
        const payload = buildCloudCodeRequest(
            {
                model: 'gemini-2.5-pro',
                system: 'Be brief.',
                messages: [
                    { role: 'assistant', content: 'Hello.' },
                    { role: 'user', content: 'hi' }
                ]
            },
            'test-project',
            'test@example.com'
        );

        assertEqual(payload.request.contents[0].role, 'user');
        assertTrue(payload.request.contents[0].parts[0].text.startsWith('<system-instructions>'));
        assertEqual(payload.request.contents[1].role, 'model');
    });

    test('functionResponse-first user turn is not mixed with system part', () => {
        const payload = buildCloudCodeRequest(
            {
                model: 'gemini-2.5-pro',
                system: 'Be brief.',
                messages: [{
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
                }]
            },
            'test-project',
            'test@example.com'
        );

        assertEqual(payload.request.contents[0].parts.length, 1);
        assertTrue(payload.request.contents[0].parts[0].text.startsWith('<system-instructions>'));
        assertTrue(Boolean(payload.request.contents[1].parts[0].functionResponse));
    });

    console.log('\n── Billing Header Sanitization Contract ────────────────────────');

    test('array system blocks remove the billing header and empty block', () => {
        const request = convertAnthropicToGoogle({
            ...baseRequest,
            model: 'claude-sonnet-4-5',
            system: [
                { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.231' },
                { type: 'text', text: 'Retain this instruction.' }
            ]
        });

        assertEqual(request.systemInstruction.parts.length, 1, 'Empty billing-header block must be removed');
        assertEqual(request.systemInstruction.parts[0].text, 'Retain this instruction.', 'Normal system content must remain');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

runTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

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

    test('forwards only the client system instruction', () => {
        const payload = buildCloudCodeRequest(
            {
                ...baseRequest,
                model: 'gemini-2.5-pro',
                system: 'Retain this instruction.'
            },
            'test-project',
            'test@example.com'
        );

        assertEqual(payload.request.systemInstruction.role, 'user');
        assertEqual(payload.request.systemInstruction.parts.length, 1);
        assertEqual(payload.request.systemInstruction.parts[0].text, 'Retain this instruction.');
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

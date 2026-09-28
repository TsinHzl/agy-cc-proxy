/**
 * Request Builder Contract Tests
 *
 * Verifies Cloud Code request sanitization invariants that must hold before
 * requests reach Google: Gemini must not carry session identifiers, while
 * Claude requests keep matching body and header session IDs.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         REQUEST BUILDER CONTRACT TEST SUITE                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { buildCloudCodeRequest, buildHeaders } = await import('../src/cloudcode/request-builder.js');
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

    const baseRequest = {
        messages: [{ role: 'user', content: 'test request' }],
        max_tokens: 128
    };

    console.log('\n── Session Identifier Contract ─────────────────────────────────');

    test('Gemini payload and headers omit session identifiers', () => {
        const model = 'gemini-2.5-pro';
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'test-project', 'test@example.com');
        const headers = buildHeaders('test-token', model, 'application/json', payload.request.sessionId);

        assertFalse('sessionId' in payload.request, 'Gemini payload must not contain sessionId');
        assertFalse('X-Machine-Session-Id' in headers, 'Gemini headers must not contain X-Machine-Session-Id');
    });

    test('Claude payload and headers use the same session identifier', () => {
        const model = 'claude-sonnet-4-5';
        const payload = buildCloudCodeRequest({ ...baseRequest, model }, 'test-project', 'test@example.com');
        const headers = buildHeaders('test-token', model, 'application/json', payload.request.sessionId);

        assertFalse(!payload.request.sessionId, 'Claude payload must contain sessionId');
        assertEqual(headers['X-Machine-Session-Id'], payload.request.sessionId, 'Claude body/header session IDs must match');
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

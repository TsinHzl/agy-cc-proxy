/**
 * Test Effort → Thinking Budget Mapping - Unit Tests
 *
 * Covers the `output_config.effort` support added for the Claude 4.6 family:
 * - EFFORT_BUDGET_MAP tier values
 * - resolveEffortBudget: case handling, invalid tiers, prototype-key safety
 * - supportsEffort: model gating
 * - convertAnthropicToGoogle: end-to-end budget resolution + priority order
 */

// Since we're in CommonJS and the module is ESM, we need to use dynamic import
async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          EFFORT → THINKING BUDGET TEST SUITE                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const { EFFORT_BUDGET_MAP, supportsEffort, resolveEffortBudget } =
        await import('../src/constants.js');
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    // Minimal Anthropic request; only the fields the converter reads.
    function convert(model, extra = {}) {
        return convertAnthropicToGoogle({
            model,
            max_tokens: 8000,
            messages: [{ role: 'user', content: 'hello' }],
            ...extra
        });
    }

    const budgetOf = (req) => req.generationConfig?.thinkingConfig?.thinking_budget;

    console.log('── Tier mapping ──');
    test('low → 4000', () => assertEqual(EFFORT_BUDGET_MAP.low, 4000));
    test('medium → 16000', () => assertEqual(EFFORT_BUDGET_MAP.medium, 16000));
    test('high → 32000 (matches legacy default)', () => assertEqual(EFFORT_BUDGET_MAP.high, 32000));
    test('max → 48000', () => assertEqual(EFFORT_BUDGET_MAP.max, 48000));

    console.log('\n── resolveEffortBudget ──');
    test('resolves each tier', () => {
        assertEqual(resolveEffortBudget('low'), 4000);
        assertEqual(resolveEffortBudget('medium'), 16000);
        assertEqual(resolveEffortBudget('high'), 32000);
        assertEqual(resolveEffortBudget('max'), 48000);
    });
    test('case-insensitive and trimmed', () => {
        assertEqual(resolveEffortBudget('HIGH'), 32000);
        assertEqual(resolveEffortBudget('  Low  '), 4000);
    });
    test('unknown tier → null (no silent default injection)', () => {
        assertEqual(resolveEffortBudget('xhigh'), null);
        assertEqual(resolveEffortBudget('bogus'), null);
        assertEqual(resolveEffortBudget(''), null);
    });
    test('non-string → null', () => {
        assertEqual(resolveEffortBudget(123), null);
        assertEqual(resolveEffortBudget(null), null);
        assertEqual(resolveEffortBudget(undefined), null);
        assertEqual(resolveEffortBudget({}), null);
    });
    test('prototype keys → null, not a function', () => {
        assertEqual(resolveEffortBudget('constructor'), null);
        assertEqual(resolveEffortBudget('toString'), null);
        assertEqual(resolveEffortBudget('__proto__'), null);
    });

    console.log('\n── supportsEffort ──');
    test('Claude 4.6 family supported (incl. -thinking suffix)', () => {
        assertEqual(supportsEffort('claude-sonnet-4-6'), true);
        assertEqual(supportsEffort('claude-opus-4-6'), true);
        assertEqual(supportsEffort('claude-opus-4-6-thinking'), true);
    });
    test('other families rejected', () => {
        assertEqual(supportsEffort('claude-opus-4-5-thinking'), false);
        assertEqual(supportsEffort('claude-sonnet-4-5'), false);
        assertEqual(supportsEffort('gemini-3-flash'), false);
        assertEqual(supportsEffort(''), false);
        assertEqual(supportsEffort(undefined), false);
    });

    console.log('\n── Converter integration ──');
    test('no effort → 32000 (backward compatible)', () => {
        assertEqual(budgetOf(convert('claude-sonnet-4-6')), 32000);
    });
    test('effort high → 32000 (identical to legacy default)', () => {
        assertEqual(budgetOf(convert('claude-sonnet-4-6', { output_config: { effort: 'high' } })), 32000);
    });
    test('effort low → 4000', () => {
        assertEqual(budgetOf(convert('claude-opus-4-6', { output_config: { effort: 'low' } })), 4000);
    });
    test('effort max → 48000', () => {
        assertEqual(budgetOf(convert('claude-opus-4-6-thinking', { output_config: { effort: 'max' } })), 48000);
    });
    test('budget_tokens wins over effort', () => {
        assertEqual(budgetOf(convert('claude-sonnet-4-6', {
            thinking: { type: 'enabled', budget_tokens: 20000 },
            output_config: { effort: 'low' }
        })), 20000);
    });
    test('invalid effort → falls back to 32000', () => {
        assertEqual(budgetOf(convert('claude-sonnet-4-6', { output_config: { effort: 'xhigh' } })), 32000);
    });
    test('effort ignored on non-4.6 Claude', () => {
        assertEqual(budgetOf(convert('claude-opus-4-5-thinking', { output_config: { effort: 'low' } })), 32000);
    });
    test('effort ignored on Gemini', () => {
        const req = convert('gemini-3-flash', { output_config: { effort: 'low' } });
        assertEqual(req.generationConfig.thinkingConfig.thinkingBudget, 16000);
    });
    test('max budget survives the 64K clamp', () => {
        const req = convert('claude-opus-4-6', { output_config: { effort: 'max' }, max_tokens: 100000 });
        assertEqual(req.generationConfig.maxOutputTokens, 64000);
        assertEqual(budgetOf(req), 48000);
    });

    console.log(`\n${'═'.repeat(64)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
    console.log('✓ All effort tests passed');
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});

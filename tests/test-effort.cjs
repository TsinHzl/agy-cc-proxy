/**
 * Test Effort → Thinking Budget Mapping - Unit Tests
 *
 * Covers the `output_config.effort` support added for the Claude 4.6 family:
 * - EFFORT_BUDGET_MAP tier values
 * - resolveEffortBudget: case handling, invalid tiers, prototype-key safety
 * - supportsEffort: model gating
 * - convertAnthropicToGoogle: end-to-end budget resolution + priority order
 * - /v1/messages route layer passthrough (regression guard)
 */

const fs = require('fs');
const path = require('path');

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

    // Read lazily so a missing/moved route file surfaces as failed assertions
    // instead of aborting the whole suite.
    const readRouteSource = () => fs.readFileSync(
        path.join(__dirname, '..', 'src', 'server', 'routes-messages.js'), 'utf8');

    // Slice from the /v1/messages registration so these assertions cannot
    // silently drift onto another route's req.body block should one ever be
    // added earlier in the file.
    const messagesRouteSource = () => {
        const src = readRouteSource();
        const anchor = /app\.post\(\s*'\/v1\/messages'/.exec(src);
        if (!anchor) {
            throw new Error("could not locate app.post('/v1/messages') in routes-messages.js");
        }
        return src.slice(anchor.index);
    };

    // A mention inside a line comment must not satisfy a field assertion.
    const stripLineComments = (src) => src.replace(/\/\/[^\n]*/g, '');

    // Capture the body of a `const { ... } = <rhs>` block. When the flat
    // capture overflows on a nested object literal the declaration still
    // exists, so report that cause rather than claiming it is missing.
    const captureDestructuring = (src, rhsPattern, label) => {
        const block = new RegExp(`const \\{([^}]*)\\}\\s*=\\s*${rhsPattern};`).exec(src);
        if (block) return block[1];
        if (!/const \{/.test(src)) throw new Error(`${label}: destructuring block not found`);
        throw new Error(`${label}: block could not be captured flat — it likely contains a `
            + 'nested `}`; switch to a brace-balanced scan');
    };

    // Capture the body of a `const <name> = { ... };` literal, with the same
    // missing-vs-overflow distinction.
    const captureObjectLiteral = (src, name, label) => {
        const block = new RegExp(`const ${name} = \\{([^}]*)\\};`).exec(src);
        if (block) return block[1];
        if (!new RegExp(`const ${name} = \\{`).test(src)) {
            throw new Error(`${label}: object literal not found`);
        }
        throw new Error(`${label}: literal could not be captured flat — it likely contains a `
            + 'nested `}`; switch to a brace-balanced scan');
    };

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

    console.log('\n── Route layer passthrough ──');
    // These source assertions are the actual guard that the route keeps
    // forwarding output_config. The converter tests above call
    // convertAnthropicToGoogle directly and so cannot catch a route that drops
    // the field before it gets there.
    test('route destructures output_config from req.body', () => {
        const body = captureDestructuring(
            messagesRouteSource(), 'req\\.body', 'req.body destructuring');
        assertEqual(/\boutput_config\b/.test(stripLineComments(body)), true);
    });
    test('route forwards output_config into the request object', () => {
        const body = captureObjectLiteral(messagesRouteSource(), 'request', 'request object');
        assertEqual(/\boutput_config\b/.test(stripLineComments(body)), true);
    });
    test('converter tolerates a route-shaped object with explicit undefined keys', () => {
        // The route builds its request with every optional field spelled out,
        // so most arrive as own properties holding undefined. The convert()
        // helper above spreads ...extra and never produces that shape, so this
        // case is not covered elsewhere. Note this is a local copy: it does NOT
        // follow the route's structure, so it cannot detect the route dropping
        // a field — the source assertions above are what guard that.
        const routeShaped = {
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 8000,
            stream: true,
            system: undefined, tools: undefined, tool_choice: undefined,
            thinking: undefined,
            output_config: { effort: 'max' },
            top_p: undefined, top_k: undefined, temperature: undefined
        };
        assertEqual(budgetOf(convertAnthropicToGoogle(routeShaped)), 48000);
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

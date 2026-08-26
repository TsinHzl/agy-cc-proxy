/**
 * Unit test for /compact request shape (issue: "summarization produced empty response")
 *
 * Regression test for the August 2026 bug:
 *   - Root cause #1: Disabling thinking (`thinkingCfg=none`) caused Cloud Code API
 *     to return 429 RESOURCE_EXHAUSTED for Gemini 3 /compact requests.
 *   - Root cause #2: maxOutputTokens too small to hold BOTH the thinking block
 *     AND the summary text → summary comes back empty.
 *
 * Verifies that convertAnthropicToGoogle():
 *   1. Keeps `thinkingConfig` populated for /compact requests (no thinkingCfg=none).
 *   2. Enlarges maxOutputTokens to `thinkingBudget + 16384` so the summary
 *      always retains a 16K reserve after the thinking block.
 *   3. The Gemini maxOutputTokens cap scales with thinkingBudget (not a fixed
 *      32K, which would silently truncate summary budget for large budgets).
 *   4. Non-compact requests are unchanged.
 *
 * Pure unit test — no live server required.
 */

const path = require('path');

// ESM-only module — load dynamically
async function loadConverter() {
    const url = `file://${path.resolve(__dirname, '../src/format/request-converter.js')}`;
    return import(url);
}

const CC_COMPACT_ANCHOR = 'You are a Claude agent, built on Anthropic';

function compactRequest(model, budgetTokens, maxTokens = 8192) {
    return {
        model,
        max_tokens: maxTokens,
        thinking: { type: 'enabled', budget_tokens: budgetTokens },
        messages: [{ role: 'user', content: '/compact' }],
        system: [{ type: 'text', text: CC_COMPACT_ANCHOR }]
    };
}

function normalRequest(model, budgetTokens, maxTokens = 8192) {
    return {
        model,
        max_tokens: maxTokens,
        thinking: { type: 'enabled', budget_tokens: budgetTokens },
        messages: [{ role: 'user', content: 'hello' }],
        system: 'You are helpful.'
    };
}

// CC v2.1+ reactive-compact prompt signature (autocompact + manual /compact).
// This is the actual user message CC sends when triggering compaction.
const CC_REACTIVE_COMPACT_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.`;

function reactiveCompactRequest(model, budgetTokens, maxTokens = 20000) {
    return {
        model,
        max_tokens: maxTokens,
        thinking: { type: 'enabled', budget_tokens: budgetTokens },
        stream: true,
        system: [{ type: 'text', text: 'You are helpful.' }],  // NO compact anchor
        messages: [{ role: 'user', content: CC_REACTIVE_COMPACT_PROMPT }]
    };
}

async function main() {
    const { convertAnthropicToGoogle, isCompactRequest } = await loadConverter();

    const tests = [];
    function test(name, fn) {
        tests.push({ name, fn });
    }

    // --- isCompactRequest sanity ---
    test('isCompactRequest detects system anchor', () => {
        const r = isCompactRequest(
            [{ type: 'text', text: CC_COMPACT_ANCHOR }],
            [{ role: 'user', content: 'hi' }]
        );
        if (r !== true) throw new Error(`expected true, got ${r}`);
    });
    test('isCompactRequest detects user /compact', () => {
        const r = isCompactRequest(
            'normal sys',
            [{ role: 'user', content: '/compact summarize' }]
        );
        if (r !== true) throw new Error(`expected true, got ${r}`);
    });
    test('isCompactRequest detects CC v2.1+ reactive-compact prompt', () => {
        // The actual user message CC sends when triggering compaction —
        // starts with "CRITICAL: Respond with TEXT ONLY" and contains
        // "create a detailed summary of this conversation". This is what
        // the production proxy was failing to detect.
        const r = isCompactRequest(
            'You are helpful.',  // system WITHOUT compact anchor
            [{ role: 'user', content: CC_REACTIVE_COMPACT_PROMPT }]
        );
        if (r !== true) throw new Error(`expected true, got ${r}`);
    });
    test('isCompactRequest detects split reactive-compact content blocks', () => {
        // CC can interleave bookkeeping blocks with its generated prompt.
        // The detector must not require both anchors in the same text block,
        // but per-block Tier-2 pairing (anchor + CC marker) is required to
        // avoid false positives. Block A here matches the Tier-2 pair
        // "CRITICAL: Respond with TEXT ONLY" + "do NOT call any tools",
        // which is enough to flip the flag.
        const r = isCompactRequest(
            'You are helpful.',
            [{
                role: 'user',
                content: [
                    { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.' },
                    { type: 'text', text: 'Your task is to create a detailed summary of this conversation.' }
                ]
            }]
        );
        if (r !== true) throw new Error(`expected true (Tier-2 pair in block A), got ${r}`);
    });
    test('isCompactRequest detects single reactive-compact anchor', () => {
        // Tier-1 anchor pair in one block — canonical /compact prompt.
        const r = isCompactRequest(
            'You are helpful.',
            [{ role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Your task is to create a detailed summary of this conversation before continuing.' }]
        );
        if (r !== true) throw new Error(`expected true (Tier-1 anchor pair), got ${r}`);
    });
    test('isCompactRequest false for normal query', () => {
        const r = isCompactRequest(
            'normal sys',
            [{ role: 'user', content: 'help me' }]
        );
        if (r !== false) throw new Error(`expected false, got ${r}`);
    });
    // CR Round 1 H1 — guards against false positives when a user asks for
    // a summary without invoking /compact. Single keywords like
    // "create a detailed summary" alone MUST NOT trigger.
    test('isCompactRequest false for user asking to summarise, not /compact', () => {
        const r = isCompactRequest(
            'You are helpful.',
            [{ role: 'user', content: 'Please create a detailed summary of this conversation and translate it to Chinese.' }]
        );
        if (r !== false) throw new Error(`expected false (no compact signal), got ${r}`);
    });
    test('isCompactRequest false for user mentioning "do NOT call any tools" alone', () => {
        const r = isCompactRequest(
            'You are helpful.',
            [{ role: 'user', content: 'In this exercise, do NOT call any tools. Just answer in plain text.' }]
        );
        if (r !== false) throw new Error(`expected false (no compact signal), got ${r}`);
    });

    // --- Critical regression scenarios ---

    test('Gemini 3.7 /compact budget=16K → maxOutputTokens=32K', () => {
        const r = convertAnthropicToGoogle(compactRequest('gemini-3.7-flash-tiered', 16000));
        if (r.generationConfig.thinkingConfig?.includeThoughts !== true) {
            throw new Error('thinking must stay enabled (Cloud Code rejects thinkingCfg=none for Gemini 3)');
        }
        if (r.generationConfig.thinkingConfig?.thinkingBudget !== 16000) {
            throw new Error(`thinkingBudget wrong: ${r.generationConfig.thinkingConfig?.thinkingBudget}`);
        }
        if (r.generationConfig.maxOutputTokens !== 32384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 32384)`);
        }
        if (r.generationConfig.maxOutputTokens - 16000 < 16384) {
            throw new Error('summary reserve <16K — thinking eats the summary');
        }
    });

    test('CRITICAL: Gemini budget=24K → maxOutputTokens=40K (not 32K cap)', () => {
        // Round 1 CR bug: cap was fixed at 32K, so thinkingBudget=24K + reserve
        // collapsed to max=32K, summary budget was 8K instead of 16K.
        const r = convertAnthropicToGoogle(compactRequest('gemini-3.7-flash-tiered', 24000));
        if (r.generationConfig.maxOutputTokens !== 40384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 40384 = 24K + 16K reserve)`);
        }
        if (r.generationConfig.maxOutputTokens - 24000 !== 16384) {
            throw new Error('summary reserve must be exactly 16K regardless of thinking budget');
        }
    });

    test('CRITICAL: Gemini budget=8K (small) → maxOutputTokens=24K', () => {
        // Verify the formula scales DOWN as well — no fixed lower bound beyond 16K reserve.
        const r = convertAnthropicToGoogle(compactRequest('gemini-3-flash', 8000));
        if (r.generationConfig.maxOutputTokens !== 24384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 24384)`);
        }
    });

    test('Claude opus-4-6-thinking /compact budget=16K → maxOutputTokens=32K', () => {
        const r = convertAnthropicToGoogle(compactRequest('claude-opus-4-6-thinking', 16000));
        if (r.generationConfig.thinkingConfig?.include_thoughts !== true) {
            throw new Error('thinking must stay enabled');
        }
        if (r.generationConfig.thinkingConfig?.thinking_budget !== 16000) {
            throw new Error(`thinking_budget wrong: ${r.generationConfig.thinkingConfig?.thinking_budget}`);
        }
        if (r.generationConfig.maxOutputTokens !== 32384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 32384)`);
        }
    });

    // --- CC v2.1+ reactive-compact integration scenarios ---

    test('CRITICAL: Reactive-compact prompt (CC v2.1+) detected on Gemini', () => {
        // This is the actual shape CC sends when triggering autocompact:
        // - No copyright anchor in system
        // - User message is the auto-generated "CRITICAL: Respond with TEXT ONLY..."
        //   prompt that asks the model to summarise the conversation
        // - max_tokens=20000 (CC reactive-compact hard cap)
        const r = convertAnthropicToGoogle(reactiveCompactRequest('gemini-3.7-flash-tiered', 16000));
        if (r.generationConfig.thinkingConfig?.includeThoughts !== true) {
            throw new Error('thinking must stay enabled for /compact');
        }
        if (r.generationConfig.maxOutputTokens !== 32384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 32384 = 16K thinking + 16K reserve)`);
        }
    });

    test('CRITICAL: Reactive-compact prompt (CC v2.1+) detected on Claude', () => {
        const r = convertAnthropicToGoogle(reactiveCompactRequest('claude-opus-4-6-thinking', 16000));
        if (r.generationConfig.thinkingConfig?.include_thoughts !== true) {
            throw new Error('thinking must stay enabled for /compact');
        }
        if (r.generationConfig.maxOutputTokens !== 32384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 32384)`);
        }
    });

    test('Reactive-compact detects a prompt followed by user bookkeeping', () => {
        const req = reactiveCompactRequest('gemini-3.7-flash-tiered', 16000);
        req.tools = [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }];
        req.messages.push({ role: 'user', content: '<total_tokens>200000</total_tokens>' });

        const r = convertAnthropicToGoogle(req);
        if (r.tools !== undefined) {
            throw new Error(`expected compact request to strip tools, got: ${JSON.stringify(r.tools)}`);
        }
        if (r.generationConfig.maxOutputTokens !== 32384) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 32384)`);
        }
    });

    // --- Non-compact path must be untouched ---

    test('/compact request strips tools and toolConfig', () => {
        const req = compactRequest('gemini-3.7-flash-tiered', 16000);
        req.tools = [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }];
        const r = convertAnthropicToGoogle(req);
        if (r.tools !== undefined) {
            throw new Error(`expected tools to be undefined, got: ${JSON.stringify(r.tools)}`);
        }
        if (r.toolConfig !== undefined) {
            throw new Error(`expected toolConfig to be undefined, got: ${JSON.stringify(r.toolConfig)}`);
        }
    });

    test('Non-compact request preserves tools', () => {
        const req = normalRequest('gemini-3.7-flash-tiered', 16000);
        req.tools = [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }];
        const r = convertAnthropicToGoogle(req);
        if (!r.tools || r.tools.length === 0) {
            throw new Error('expected tools to be preserved for normal request');
        }
    });

    test('Reactive compact history does not strip tools from the next normal request', () => {
        const req = normalRequest('gemini-3.7-flash-tiered', 16000);
        req.tools = [{ name: 'Read', description: 'Read file', input_schema: { type: 'object' } }];
        req.messages = [
            { role: 'user', content: 'Inspect the project configuration.' },
            { role: 'assistant', content: 'I will inspect it.' },
            { role: 'user', content: CC_REACTIVE_COMPACT_PROMPT },
            { role: 'assistant', content: '<analysis>Conversation compacted.</analysis><summary>Prior context.</summary>' },
            { role: 'user', content: 'Now read package.json and report the scripts.' }
        ];

        const r = convertAnthropicToGoogle(req);
        if (r.tools?.[0]?.functionDeclarations?.[0]?.name !== 'Read') {
            throw new Error(`expected next normal request to preserve Read tool, got: ${JSON.stringify(r.tools)}`);
        }
    });

    test('Non-compact Gemini request: maxOutputTokens = user-provided value', () => {
        const r = convertAnthropicToGoogle(normalRequest('gemini-3.7-flash-tiered', 16000, 8192));
        if (r.generationConfig.maxOutputTokens !== 8192) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 8192)`);
        }
    });

    test('Non-compact Claude request: max_tokens auto-bumped above thinking_budget', () => {
        // Claude API requires max_tokens > thinking_budget (otherwise thinking
        // block can't fit). With thinking_budget=16K and user max_tokens=8K,
        // the converter auto-bumps to thinkingBudget + 8192 = 24192.
        // Pre-existing behaviour, not introduced by the /compact fix.
        const r = convertAnthropicToGoogle(normalRequest('claude-opus-4-6-thinking', 16000, 8192));
        if (r.generationConfig.maxOutputTokens !== 24192) {
            throw new Error(`maxOutputTokens wrong: ${r.generationConfig.maxOutputTokens} (want 24192)`);
        }
    });

    // --- Scope safety: COMPACT_SUMMARY_RESERVE must be reachable by the cap block ---
    // CR Round 2 flagged a hypothetical scope bug — verify both Claude and Gemini
    // /compact paths succeed without ReferenceError.

    test('Gemini /compact path does not ReferenceError on COMPACT_SUMMARY_RESERVE', () => {
        // If the const were scoped only inside the Claude branch, this would throw.
        const r = convertAnthropicToGoogle(compactRequest('gemini-3.7-flash-tiered', 16000));
        if (!r.generationConfig.maxOutputTokens) throw new Error('cap path did not run');
    });

    // --- Run ---

    let passed = 0;
    let failed = 0;
    for (const t of tests) {
        try {
            t.fn();
            console.log(`  PASS  ${t.name}`);
            passed++;
        } catch (e) {
            console.log(`  FAIL  ${t.name}`);
            console.log(`        ${e.message}`);
            failed++;
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(e => {
    console.error('Test runner crashed:', e);
    process.exit(1);
});
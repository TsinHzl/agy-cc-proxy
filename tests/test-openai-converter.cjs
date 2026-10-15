/**
 * Unit tests for src/openai/converter.js (no server required).
 * Mirrors tests/test-strategies.cjs style: CJS runner with dynamic ESM import.
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           OPENAI CONVERTER UNIT TEST SUITE                   ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        validateOpenAIRequest,
        extractSystem,
        convertMessages,
        convertUserContent,
        convertTools,
        convertOpenAIRequest,
        mapFinishReason,
        convertResponse,
        createChunkStream
    } = await import('../src/openai/converter.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            passed++;
            console.log(`  ✅ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ❌ ${name}\n     ${err.message}`);
        }
    }

    function assertEq(actual, expected, label = '') {
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a !== e) {
            throw new Error(`${label} expected ${e}, got ${a}`);
        }
    }

    // ------------------------------------------------------------------
    // validateOpenAIRequest
    // ------------------------------------------------------------------
    test('validate: rejects n > 1', () => {
        let threw = false;
        try { validateOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }], n: 2 }); }
        catch (e) { threw = e.statusCode === 400; }
        if (!threw) throw new Error('expected 400 for n>1');
    });

    test('validate: rejects logprobs', () => {
        let threw = false;
        try { validateOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }], logprobs: true }); }
        catch (e) { threw = e.statusCode === 400; }
        if (!threw) throw new Error('expected 400 for logprobs');
    });

    test('validate: accepts n = 1 / missing', () => {
        validateOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }], n: 1 });
        validateOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }] });
    });

    test('validate: rejects empty messages', () => {
        let threw = false;
        try { validateOpenAIRequest({ messages: [] }); }
        catch (e) { threw = e.statusCode === 400; }
        if (!threw) throw new Error('expected 400 for empty messages');
    });

    // ------------------------------------------------------------------
    // extractSystem
    // ------------------------------------------------------------------
    test('extractSystem: joins system messages', () => {
        const sys = extractSystem([
            { role: 'system', content: 'be nice' },
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'be brief' }
        ]);
        assertEq(sys, 'be nice\n\nbe brief');
    });

    test('extractSystem: undefined when absent', () => {
        assertEq(extractSystem([{ role: 'user', content: 'hi' }]), undefined);
    });

    test('extractSystem: supports developer role and part arrays', () => {
        const sys = extractSystem([{ role: 'developer', content: [{ type: 'text', text: 'rules' }] }]);
        assertEq(sys, 'rules');
    });

    // ------------------------------------------------------------------
    // convertMessages
    // ------------------------------------------------------------------
    test('convertMessages: user string passthrough', () => {
        const out = convertMessages([{ role: 'user', content: 'hello' }]);
        assertEq(out, [{ role: 'user', content: 'hello' }]);
    });

    test('convertMessages: system dropped, tool -> tool_result', () => {
        const out = convertMessages([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'q' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"result":42}' }
        ]);
        assertEq(out.length, 3);
        assertEq(out[1].content[0].type, 'tool_use');
        assertEq(out[1].content[0].input, { a: 1 });
        assertEq(out[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"result":42}' }] });
    });

    test('convertMessages: invalid tool arguments wrapped in _raw', () => {
        const out = convertMessages([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{broken' } }] }
        ]);
        assertEq(out[0].content[0].input, { _raw: '{broken' });
    });

    // ------------------------------------------------------------------
    // convertUserContent
    // ------------------------------------------------------------------
    test('convertUserContent: data URL image -> base64 image block', () => {
        const blocks = convertUserContent([
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]);
        assertEq(blocks, [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]);
    });

    test('convertUserContent: http URL passed through as url source', () => {
        const blocks = convertUserContent([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
        assertEq(blocks, [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
    });

    // ------------------------------------------------------------------
    // convertTools
    // ------------------------------------------------------------------
    test('convertTools: function tools -> input_schema, choice auto', () => {
        const { tools, toolChoice } = convertTools({
            tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
            tool_choice: 'auto'
        });
        assertEq(tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
        assertEq(toolChoice, { type: 'auto' });
    });

    test('convertTools: choice none drops tools requirement, required -> any, named -> tool', () => {
        assertEq(convertTools({ tool_choice: 'none' }).toolChoice, undefined);
        assertEq(convertTools({ tool_choice: 'required' }).toolChoice, { type: 'any' });
        assertEq(
            convertTools({ tool_choice: { type: 'function', function: { name: 'f' } } }).toolChoice,
            { type: 'tool', name: 'f' }
        );
    });

    // ------------------------------------------------------------------
    // convertOpenAIRequest (end-to-end request shape)
    // ------------------------------------------------------------------
    test('convertOpenAIRequest: full shape', () => {
        const req = convertOpenAIRequest({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'hi' }
            ],
            max_tokens: 100,
            temperature: 0.5,
            top_p: 0.9,
            stop: 'END'
        }, 'gemini-3-pro');
        assertEq(req.model, 'gemini-3-pro');
        assertEq(req.max_tokens, 100);
        assertEq(req.system, 'sys');
        assertEq(req.stop_sequences, ['END']);
        assertEq(req.stream, false);
    });

    // ------------------------------------------------------------------
    // mapFinishReason / convertResponse
    // ------------------------------------------------------------------
    test('mapFinishReason: full mapping', () => {
        assertEq(mapFinishReason('end_turn'), 'stop');
        assertEq(mapFinishReason('tool_use'), 'tool_calls');
        assertEq(mapFinishReason('max_tokens'), 'length');
        assertEq(mapFinishReason(undefined), 'stop');
        assertEq(mapFinishReason('weird'), 'stop');
    });

    test('convertResponse: text only, cache_read into prompt_tokens', () => {
        const out = convertResponse({
            id: 'msg_1',
            content: [{ type: 'text', text: 'hi there' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 }
        }, 'gpt-4o');
        assertEq(out.object, 'chat.completion');
        assertEq(out.model, 'gpt-4o');
        assertEq(out.choices[0].message.content, 'hi there');
        assertEq(out.choices[0].finish_reason, 'stop');
        assertEq(out.usage, { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 });
    });

    test('convertResponse: thinking dropped, tool_use -> tool_calls', () => {
        const out = convertResponse({
            id: 'msg_2',
            content: [
                { type: 'thinking', thinking: 'secret', signature: 'sig' },
                { type: 'tool_use', id: 'toolu_1', name: 'f', input: { x: 1 } }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 3, output_tokens: 4 }
        }, 'm');
        assertEq(out.choices[0].message.content, null);
        assertEq(out.choices[0].message.tool_calls, [
            { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }
        ]);
        assertEq(out.choices[0].finish_reason, 'tool_calls');
    });

    // ------------------------------------------------------------------
    // createChunkStream
    // ------------------------------------------------------------------
    test('chunk stream: text sequence role -> content -> finish -> [DONE]', () => {
        const cs = createChunkStream('gpt-4o', 'chatcmpl_x');
        let out = [];
        out.push(...cs.feed({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 3 } } }));
        out.push(...cs.feed({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' } }));
        out.push(...cs.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }));
        out.push(...cs.feed({ type: 'message_stop' }));
        out.push(...cs.finalize());

        assertEq(out[0].choices[0].delta, { role: 'assistant', content: '' });
        assertEq(out[1].choices[0].delta, { content: 'he' });
        assertEq(out[2].choices[0].delta, { content: 'y' });
        const finishChunk = out[out.length - 2];
        assertEq(finishChunk.choices[0].finish_reason, 'stop');
        assertEq(finishChunk.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        assertEq(out[out.length - 1], '[DONE]');
        for (const c of out.slice(0, -1)) {
            assertEq(c.object, 'chat.completion.chunk');
            assertEq(c.id, 'chatcmpl_x');
        }
    });

    test('chunk stream: parallel tool_calls aggregated by index', () => {
        const cs = createChunkStream('m', 'chatcmpl_t');
        let out = [];
        out.push(...cs.feed({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
        out.push(...cs.feed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'fa' } }));
        out.push(...cs.feed({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'fb' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"b":1}' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '2}' } }));
        out.push(...cs.feed({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }));
        out.push(...cs.feed({ type: 'message_stop' }));
        out.push(...cs.finalize());

        const starts = out.filter(c => c.choices?.[0].delta?.tool_calls?.[0]?.id);
        assertEq(starts.length, 2);
        assertEq(starts[0].choices[0].delta.tool_calls[0].index, 0);
        assertEq(starts[0].choices[0].delta.tool_calls[0].id, 'toolu_a');
        assertEq(starts[1].choices[0].delta.tool_calls[0].index, 1);
        assertEq(starts[1].choices[0].delta.tool_calls[0].id, 'toolu_b');

        // argument deltas must land on the right tool index despite interleaving
        const argDeltas = out.filter(c => c.choices?.[0].delta?.tool_calls?.[0]?.function?.arguments && !c.choices[0].delta.tool_calls[0].id);
        assertEq(argDeltas.filter(c => c.choices[0].delta.tool_calls[0].index === 1).map(c => c.choices[0].delta.tool_calls[0].function.arguments), ['{"b":1}']);
        assertEq(argDeltas.filter(c => c.choices[0].delta.tool_calls[0].index === 0).map(c => c.choices[0].delta.tool_calls[0].function.arguments), ['{"a":', '2}']);

        const finishChunk = out[out.length - 2];
        assertEq(finishChunk.choices[0].finish_reason, 'tool_calls');
    });

    test('chunk stream: thinking deltas dropped (no empty content chunks)', () => {
        const cs = createChunkStream('m', 'chatcmpl_k');
        const out = [];
        out.push(...cs.feed({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
        out.push(...cs.feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
        out.push(...cs.feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }));
        out.push(...cs.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }));
        out.push(...cs.finalize());

        const contents = out.filter(c => c.choices?.[0].delta?.content !== undefined);
        assertEq(contents.length, 2); // role chunk + 'answer' chunk only
        assertEq(contents[1].choices[0].delta.content, 'answer');
    });

    test('chunk stream: error event yields error chunk then [DONE]', () => {
        const cs = createChunkStream('m', 'chatcmpl_e');
        let out = [];
        out.push(...cs.feed({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
        out.push(...cs.feed({ type: 'error', error: { type: 'rate_limit_exceeded', message: 'slow down' } }));
        out.push(...cs.finalize());

        assertEq(out[1].error, { type: 'rate_limit_exceeded', message: 'slow down' });
        assertEq(out[out.length - 1], '[DONE]');
        // no finish_reason emitted after error
        assertEq(out.filter(c => typeof c === 'object' && c.choices?.[0]?.finish_reason).length, 0);
    });

    // ------------------------------------------------------------------
    console.log(`\n${'═'.repeat(62)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('═'.repeat(62));
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

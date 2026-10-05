const { TextEncoder } = require('util');

class MockResponse {
    constructor(chunks) {
        this.body = {
            getReader: () => {
                let index = 0;
                return {
                    read: async () => index < chunks.length
                        ? { done: false, value: typeof chunks[index] === 'string' ? new TextEncoder().encode(chunks[index++]) : chunks[index++] }
                        : { done: true, value: undefined }
                };
            }
        };
    }
}

async function runTests() {
    const { streamSSEResponse } = await import('../src/cloudcode/sse-streamer.js');
    const { parseThinkingSSEResponse } = await import('../src/cloudcode/sse-parser.js');
    const { convertGoogleToAnthropic } = await import('../src/format/response-converter.js');
    let passed = 0;
    let failed = 0;
    const assertEqual = (actual, expected, message = '') => {
        if (actual !== expected) throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
    };
    const test = async (name, fn) => {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`✗ ${name}: ${error.message}`);
            failed++;
        }
    };
    const collect = async (chunks, options) => {
        const events = [];
        for await (const event of streamSSEResponse(new MockResponse(chunks), 'claude-sonnet-4-6', false, options)) events.push(event);
        return events;
    };

    await test('聚合多条 data 行并忽略 SSE 元数据', async () => {
        const chunks = [': heartbeat\nevent: candidate\nid: 1\ndata: {"candidates":[{"content":{"parts":[\ndata: {"text":"joined"}]}}]}\n\n'];
        const events = await collect(chunks);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'joined');
        const parsed = await parseThinkingSSEResponse(new MockResponse(chunks), 'claude-sonnet-4-6');
        assertEqual(parsed.content[0].text, 'joined');
    });

    await test('保留跨 UTF-8 chunk 的字符并 flush 无换行尾事件', async () => {
        const payload = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '分片💭' }] }, finishReason: 'STOP' }] })}`;
        const bytes = new TextEncoder().encode(payload);
        const marker = new TextEncoder().encode('💭');
        const offset = bytes.findIndex((byte, index) => marker.every((value, markerIndex) => bytes[index + markerIndex] === value));
        const chunks = [bytes.slice(0, offset + 2), bytes.slice(offset + 2)];
        const events = await collect(chunks);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, '分片💭');
        const parsed = await parseThinkingSSEResponse(new MockResponse(chunks), 'claude-sonnet-4-6');
        assertEqual(parsed.content[0].text, '分片💭');
    });

    await test('隔离畸形事件并继续处理后续事件', async () => {
        const good = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'after malformed' }] } }] });
        const events = await collect([`data: {bad}\n\ndata: ${good}`]);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'after malformed');
    });

    await test('只在同一连续 thought 块获得有效签名后物化流式 thinking', async () => {
        const signature = 's'.repeat(50);
        const chunks = [
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'reasoning' }] } }] })}\n\n`,
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, thoughtSignature: signature }] } }] })}\n\n`,
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] })}\n\n`
        ];
        const events = await collect(chunks);
        assertEqual(events.filter((event) => event.delta?.type === 'thinking_delta').length, 1);
        assertEqual(events.find((event) => event.delta?.type === 'thinking_delta')?.delta.thinking, 'reasoning');
        assertEqual(events.find((event) => event.delta?.type === 'signature_delta')?.delta.signature, signature);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'answer');
    });

    await test('连续 thought 块使用最后一个有效签名', async () => {
        const firstSignature = 'a'.repeat(50);
        const lastSignature = 'b'.repeat(50);
        const chunks = [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'reasoning', thoughtSignature: firstSignature }, { thought: true, thoughtSignature: lastSignature }, { text: 'answer' }] }, finishReason: 'STOP' }] })}\n\n`];
        const events = await collect(chunks);
        assertEqual(events.find((event) => event.delta?.type === 'signature_delta')?.delta.signature, lastSignature);
    });

    await test('默认路径丢弃没有有效签名的流式 thought 块', async () => {
        const chunks = [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'unsigned' }, { text: 'answer' }] }, finishReason: 'STOP' }] })}\n\n`];
        const events = await collect(chunks);
        assertEqual(events.filter((event) => event.delta?.type === 'thinking_delta').length, 0);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'answer');
    });

    await test('文本化路径保留真实无签名 thought 且不输出 signature delta', async () => {
        const chunks = [`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'unsigned' }, { text: 'answer' }] }, finishReason: 'STOP' }] })}\n\n`];
        const events = await collect(chunks, { emitUnsignedThinking: true });
        assertEqual(events.filter((event) => event.delta?.type === 'thinking_delta').length, 1);
        assertEqual(events.find((event) => event.delta?.type === 'thinking_delta')?.delta.thinking, 'unsigned');
        assertEqual(events.filter((event) => event.delta?.type === 'signature_delta').length, 0);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'answer');
    });

    await test('丢弃乱序签名、短签名和跨非 thought 边界的签名', async () => {
        const shortSignature = 'short';
        const validSignature = 's'.repeat(50);
        const chunks = [
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, thoughtSignature: validSignature }, { thought: true, text: 'out of order' }, { text: 'middle' }, { thought: true, text: 'short signed', thoughtSignature: shortSignature }, { text: 'after short' }] }, finishReason: 'STOP' }] })}\n\n`
        ];
        const events = await collect(chunks);
        assertEqual(events.filter((event) => event.delta?.type === 'thinking_delta').length, 0);
        assertEqual(events.find((event) => event.delta?.type === 'text_delta')?.delta.text, 'middle');
    });

    await test('通用响应转换器仅保留带有效签名的连续 thought 块', async () => {
        const signature = 's'.repeat(50);
        const response = convertGoogleToAnthropic({
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'kept' },
                        { thought: true, thoughtSignature: signature },
                        { text: 'answer' },
                        { thought: true, text: 'dropped' }
                    ]
                }
            }]
        }, 'claude-sonnet-4-6');
        assertEqual(response.content.filter((part) => part.type === 'thinking').length, 1);
        assertEqual(response.content.find((part) => part.type === 'thinking')?.thinking, 'kept');
        assertEqual(response.content.find((part) => part.text === 'answer')?.text, 'answer');
    });

    await test('非流式解析器仅保留带有效签名的连续 thought 块', async () => {
        const signature = 's'.repeat(50);
        const payload = JSON.stringify({
            candidates: [{
                content: {
                    parts: [
                        { thought: true, text: 'kept' },
                        { thought: true, thoughtSignature: signature },
                        { text: 'answer' },
                        { thought: true, text: 'dropped' }
                    ]
                }
            }]
        });
        const parsed = await parseThinkingSSEResponse(new MockResponse([`data: ${payload}\n\n`]), 'claude-sonnet-4-6');
        assertEqual(parsed.content.filter((part) => part.type === 'thinking').length, 1);
        assertEqual(parsed.content.find((part) => part.type === 'thinking')?.thinking, 'kept');
        assertEqual(parsed.content.find((part) => part.text === 'answer')?.text, 'answer');
    });

    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

runTests().catch((error) => {
    console.error(error);
    process.exit(1);
});

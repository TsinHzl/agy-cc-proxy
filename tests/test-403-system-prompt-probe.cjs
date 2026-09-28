const assert = require('assert');
const {
    buildVariants,
    classifyResponse,
    parseArgs,
    splitSystemText,
    summarizeResponse
} = require('./diagnose-403-system-prompt.cjs');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`✗ ${name}: ${error.message}`);
        failed += 1;
    }
}

const request = {
    model: 'gemini-3.8-flash-tiered',
    system: '甲😀乙丙',
    messages: [{ role: 'user', content: '敏感请求正文不得进入诊断输出' }],
    tools: [{ name: 'tool', input_schema: { type: 'object' } }]
};

async function runTests() {
    await test('生成四个 system 变体且不改变原始请求', () => {
        const variants = buildVariants(request);
        assert.deepStrictEqual(variants.map(item => item.name), ['原始 system', '无 system', 'system 前半', 'system 后半']);
        assert.strictEqual(variants[1].request.system, undefined);
        assert.strictEqual(variants[2].request.tools[0].name, 'tool');
        assert.strictEqual(request.system, '甲😀乙丙');
    });

    await test('按 Unicode code point 切分 system', () => {
        const [first, second] = splitSystemText('甲😀乙丙');
        assert.strictEqual(first + second, '甲😀乙丙');
    });

    await test('拒绝缺少 system 的请求', () => {
        assert.throws(() => buildVariants({ model: 'gemini-3.8-flash-tiered', messages: request.messages }), /非空 system/);
    });

    await test('分类不输出上游原始错误正文', () => {
        assert.strictEqual(classifyResponse(403, 'VALIDATION_REQUIRED https://accounts.google.com/secret'), 'validation_required');
        assert.strictEqual(classifyResponse(200, ''), 'ok');
    });

    await test('解析显式诊断参数', () => {
        const options = parseArgs(['--request-file', '/tmp/request.json', '--account', 'user@example.com', '--endpoint', 'prod', '--timeout-ms', '1000']);
        assert.deepStrictEqual(options, { requestFile: '/tmp/request.json', account: 'user@example.com', endpoint: 'prod', timeoutMs: 1000 });
    });

    await test('403 响应读取正文后不再取消已消费流', async () => {
        let cancelCalled = false;
        const result = await summarizeResponse({
            ok: false,
            status: 403,
            text: async () => 'VALIDATION_REQUIRED',
            body: {
                cancel: async () => {
                    cancelCalled = true;
                    throw new Error('body already consumed');
                }
            }
        });

        assert.strictEqual(result.category, 'validation_required');
        assert.strictEqual(cancelCalled, false);
    });

    console.log(`结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
}

runTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

const fs = require('fs');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function systemText(system) {
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';

    return system.map(block => {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') {
            throw new Error('system 数组仅支持 text 内容块');
        }
        return block.text;
    }).join('\n\n');
}

function splitSystemText(text) {
    const characters = [...text];
    const midpoint = Math.floor(characters.length / 2);
    return [characters.slice(0, midpoint).join(''), characters.slice(midpoint).join('')];
}

function buildVariants(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('请求文件根节点必须是对象');
    }
    if (typeof request.model !== 'string' || !request.model) {
        throw new Error('请求必须包含 model');
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
        throw new Error('请求必须包含非空 messages');
    }

    const text = systemText(request.system);
    if (!text) throw new Error('请求必须包含非空 system');

    const [firstHalf, secondHalf] = splitSystemText(text);
    const withoutSystem = clone(request);
    delete withoutSystem.system;

    return [
        { name: '原始 system', request: clone(request) },
        { name: '无 system', request: withoutSystem },
        { name: 'system 前半', request: { ...clone(request), system: firstHalf } },
        { name: 'system 后半', request: { ...clone(request), system: secondHalf } }
    ];
}

function classifyResponse(status, body) {
    if (status >= 200 && status < 300) return 'ok';
    if (/VALIDATION_REQUIRED/i.test(body || '')) return 'validation_required';
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_denied';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'other_http_error';
}

async function summarizeResponse(response) {
    const body = response.ok ? '' : await response.text();
    if (response.ok) {
        await response.body?.cancel();
    }
    return {
        status: response.status,
        category: classifyResponse(response.status, body)
    };
}

function parseArgs(args) {
    const options = { endpoint: 'daily', timeoutMs: 30000 };
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!value || !['--request-file', '--account', '--endpoint', '--timeout-ms'].includes(key)) {
            throw new Error('用法：npm run diagnose:403-prompt -- --request-file <路径> --account <邮箱> [--endpoint daily|prod] [--timeout-ms 30000]');
        }
        if (key === '--request-file') options.requestFile = value;
        if (key === '--account') options.account = value;
        if (key === '--endpoint') options.endpoint = value;
        if (key === '--timeout-ms') options.timeoutMs = Number(value);
    }
    if (!options.requestFile || !options.account || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error('缺少或非法的诊断参数');
    }
    if (!['daily', 'prod'].includes(options.endpoint)) {
        throw new Error('--endpoint 仅支持 daily 或 prod');
    }
    return options;
}

async function createSender(accountEmail, endpointName, timeoutMs) {
    const [
        { loadAccounts },
        { getTokenForAccount, getProjectForAccount },
        { buildCloudCodeRequest, buildHeaders },
        { ANTIGRAVITY_ENDPOINT_FALLBACKS, ACCOUNT_CONFIG_PATH }
    ] = await Promise.all([
        import('../src/account-manager/storage.js'),
        import('../src/account-manager/credentials.js'),
        import('../src/cloudcode/request-builder.js'),
        import('../src/constants.js')
    ]);

    const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const matches = accounts.filter(account => account.email === accountEmail);
    if (matches.length !== 1 || matches[0].enabled === false) {
        throw new Error('指定账号不存在、重复或已禁用');
    }

    const account = clone(matches[0]);
    const token = await getTokenForAccount(account, new Map(), () => {}, async () => {});
    const projectId = await getProjectForAccount(account, token, new Map(), async () => {});
    const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[endpointName === 'daily' ? 0 : 1];

    return async request => {
        const payload = buildCloudCodeRequest(request, projectId, account.email);
        const startedAt = Date.now();
        try {
            const response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
                method: 'POST',
                headers: buildHeaders(token, request.model, 'text/event-stream', payload.request.sessionId),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs)
            });
            return {
                ...(await summarizeResponse(response)),
                elapsedMs: Date.now() - startedAt
            };
        } catch (error) {
            return {
                status: 0,
                category: error.name === 'TimeoutError' ? 'timeout' : 'network_error',
                elapsedMs: Date.now() - startedAt
            };
        }
    };
}

function printResult(name, result) {
    console.log(`${name.padEnd(14)} HTTP=${String(result.status).padEnd(3)} 类别=${result.category.padEnd(20)} 耗时=${result.elapsedMs}ms`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const request = JSON.parse(fs.readFileSync(options.requestFile, 'utf8'));
    const variants = buildVariants(request);
    const send = await createSender(options.account, options.endpoint, options.timeoutMs);

    console.log('403 system prompt 诊断');
    console.log(`模型：${request.model}`);
    console.log(`端点：${options.endpoint}`);
    console.log('账号：已选择');

    for (const variant of variants) {
        printResult(variant.name, await send(variant.request));
    }
}

module.exports = { buildVariants, classifyResponse, parseArgs, splitSystemText, summarizeResponse };

if (require.main === module) {
    main().catch(error => {
        console.error(`诊断失败：${error.message}`);
        process.exitCode = 1;
    });
}

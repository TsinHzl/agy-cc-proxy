/**
 * OpenAI compat routes: POST /v1/chat/completions
 *
 * Converts the OpenAI request to the internal Anthropic representation,
 * runs it through the existing Cloud Code pipeline (sendMessage /
 * sendMessageStream), and re-encodes the response in OpenAI format.
 *
 * Mounted AFTER the shared apiKeyAuth middleware, so req._apiKeyId is
 * already set and named-key quota checks have been applied upstream.
 */

import { sendMessage, sendMessageStream, isValidModel, resolveModel } from '../cloudcode/index.js';
import { config } from '../config.js';
import { MODEL_MAP } from '../constants.js';
import { recordUsage, getAllowedAccounts } from '../api-keys/manager.js';
import { logger } from '../utils/logger.js';
import usageLog from '../modules/usage-log.js';
import { parseError } from './parse-error.js';
import { isClaudeCodeUserAgent } from './routes-messages.js';
import {
    convertOpenAIRequest,
    convertResponse,
    createChunkStream
} from '../openai/converter.js';

// Anthropic error type -> OpenAI error type
const OPENAI_ERROR_TYPE = {
    authentication_error: 'invalid_api_key',
    permission_error: 'invalid_api_key',
    rate_limit_error: 'rate_limit_exceeded',
    invalid_request_error: 'invalid_request_error',
    not_found_error: 'not_found_error',
    api_error: 'server_error',
    overloaded_error: 'server_error'
};

/**
 * Send an error in the OpenAI error envelope.
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} anthropicErrorType parseError errorType
 * @param {string} message
 * @param {{retryAfterMs?: number|null}} [opts]
 */
export function sendOpenAIError(res, statusCode, anthropicErrorType, message, opts = {}) {
    if (opts.retryAfterMs) {
        res.setHeader('Retry-After', Math.ceil(opts.retryAfterMs / 1000));
    }
    return res.status(statusCode).json({
        error: {
            message,
            type: OPENAI_ERROR_TYPE[anthropicErrorType] || 'server_error',
            code: anthropicErrorType === 'authentication_error' ? 'invalid_api_key' : null
        }
    });
}

export function registerOpenAIRoutes(app, ctx) {
    const { accountManager, ensureInitialized, fallbackEnabled } = ctx;

    app.post('/v1/chat/completions', async (req, res) => {
        try {
            await ensureInitialized();

            const body = req.body || {};

            // Parameter validation + request conversion (converter throws 400-shaped errors)
            let openAIModel = body.model;
            if (!openAIModel || typeof openAIModel !== 'string') {
                return sendOpenAIError(res, 400, 'invalid_request_error', 'model is required');
            }

            const anthropicRequest = convertOpenAIRequest(body, openAIModel);

            // Model resolution — same alias/mapping/auto-map chain as /v1/messages
            let requestedModel = openAIModel;
            if (MODEL_MAP[requestedModel]) {
                logger.info(`[OpenAI] Alias mapping ${requestedModel} -> ${MODEL_MAP[requestedModel]}`);
                requestedModel = MODEL_MAP[requestedModel];
            }
            const modelMapping = config.modelMapping || {};
            if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
                const targetModel = modelMapping[requestedModel].mapping;
                logger.info(`[OpenAI] Mapping model ${requestedModel} -> ${targetModel}`);
                requestedModel = targetModel;
            }
            const modelId = requestedModel;
            anthropicRequest.model = modelId;

            const { account: validationAccount } = accountManager.selectAccount();
            if (validationAccount) {
                const token = await accountManager.getTokenForAccount(validationAccount);
                const projectId = validationAccount.subscription?.projectId || null;
                const { resolved, autoMapped } = await resolveModel(modelId, token, projectId);
                if (autoMapped) {
                    logger.info(`[OpenAI] Auto-mapped model ${modelId} → ${resolved}`);
                    requestedModel = resolved;
                    anthropicRequest.model = resolved;
                } else {
                    const valid = await isValidModel(modelId, token, projectId);
                    if (!valid) {
                        return sendOpenAIError(res, 400, 'invalid_request_error',
                            `Invalid model: ${modelId}. Use /v1/models to see available models.`);
                    }
                }
            }

            if (accountManager.isAllRateLimited(modelId)) {
                logger.warn(`[OpenAI] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
                accountManager.resetAllRateLimits();
            }

            const accountFilter = { allowedEmails: getAllowedAccounts(req._apiKeyId) };
            const pipelineOptions = {
                thinkingAsText: config.thinkingAsText === true,
                isClaudeCode: isClaudeCodeUserAgent(req.get('user-agent'))
            };

            logger.info(`[OpenAI] Request for model: ${anthropicRequest.model}, stream: ${!!anthropicRequest.stream}`);

            if (anthropicRequest.stream) {
                // STREAMING — buffer the first event before flushing headers so
                // upstream 4xx/5xx becomes a proper JSON error (parity with /v1/messages).
                const streamStartTime = Date.now();
                let usageInputTokens = 0;
                let usageOutputTokens = 0;
                let usageCacheReadTokens = 0;

                try {
                    const generator = sendMessageStream(anthropicRequest, accountManager, fallbackEnabled, accountFilter, pipelineOptions);
                    const firstResult = await generator.next();

                    const cs = createChunkStream(openAIModel);

                    res.status(200);
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.setHeader('X-Accel-Buffering', 'no');
                    res.flushHeaders();

                    const emitChunks = (chunks) => {
                        for (const c of chunks) {
                            if (c === '[DONE]') {
                                res.write('data: [DONE]\n\n');
                            } else {
                                res.write(`data: ${JSON.stringify(c)}\n\n`);
                            }
                        }
                        if (res.flush) res.flush();
                    };

                    const captureUsage = (event) => {
                        if (event.type === 'message_start' && event.message?.usage) {
                            usageInputTokens = event.message.usage.input_tokens || 0;
                            usageCacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            usageOutputTokens = event.usage.output_tokens || 0;
                        }
                    };

                    if (!firstResult.done) {
                        captureUsage(firstResult.value);
                        emitChunks(cs.feed(firstResult.value));
                    }
                    for await (const event of generator) {
                        captureUsage(event);
                        emitChunks(cs.feed(event));
                    }
                    emitChunks(cs.finalize());
                    res.end();

                // Usage recording happens after the response is already sent —
                // never let a persistence error propagate into the outer catch
                // (it would attempt a write on an ended response).
                try {
                    usageLog.record({
                        timestamp: new Date(streamStartTime).toISOString(),
                        model: modelId,
                        // validationAccount is only the model-validation pick;
                        // the actual request account is chosen inside the handler.
                        apiKey: validationAccount?.email || '-',
                        clientIp: req._clientIp || req.ip || '-',
                        keyId: req._apiKeyId || null,
                        inputTokens: usageInputTokens,
                        outputTokens: usageOutputTokens,
                        cacheReadTokens: usageCacheReadTokens,
                        totalDuration: (Date.now() - streamStartTime) / 1000,
                        timeToFirstToken: null,
                        streaming: true,
                    });
                    recordUsage(req._apiKeyId, {
                        inputTokens: usageInputTokens,
                        outputTokens: usageOutputTokens,
                    }, req._clientIp || req.ip || '-');
                } catch (usageErr) {
                    logger.error('[OpenAI] Usage recording failed:', usageErr);
                }

                } catch (error) {
                    if (!res.headersSent) {
                        logger.error('[OpenAI] Initial stream error:', error);
                        const { errorType, statusCode, errorMessage, retryAfterMs } = parseError(error);
                        return sendOpenAIError(res, statusCode, errorType, errorMessage, { retryAfterMs });
                    }
                    // Mid-stream error: emit an error chunk then terminate
                    logger.error('[OpenAI] Mid-stream error:', error);
                    const { errorType, errorMessage } = parseError(error);
                    res.write(`data: ${JSON.stringify({
                        id: 'chatcmpl-error',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: openAIModel,
                        choices: [{ index: 0, delta: {}, finish_reason: null }],
                        error: {
                            type: OPENAI_ERROR_TYPE[errorType] || 'server_error',
                            message: errorMessage
                        }
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }

            } else {
                // NON-STREAMING
                const nonStreamStartTime = Date.now();
                const response = await sendMessage(anthropicRequest, accountManager, fallbackEnabled, accountFilter, {
                    emitUnsignedThinking: false
                });
                const openAIResponse = convertResponse(response, openAIModel);
                res.json(openAIResponse);

                const u = response?.usage || {};
                // Same post-response guard as the streaming branch above.
                try {
                    usageLog.record({
                        timestamp: new Date(nonStreamStartTime).toISOString(),
                        model: modelId,
                        // validationAccount is only the model-validation pick;
                        // the actual request account is chosen inside the handler.
                        apiKey: validationAccount?.email || '-',
                        clientIp: req._clientIp || req.ip || '-',
                        keyId: req._apiKeyId || null,
                        inputTokens: u.input_tokens || 0,
                        outputTokens: u.output_tokens || 0,
                        cacheReadTokens: u.cache_read_input_tokens || 0,
                        totalDuration: (Date.now() - nonStreamStartTime) / 1000,
                        timeToFirstToken: null,
                        streaming: false,
                    });
                    recordUsage(req._apiKeyId, {
                        inputTokens: u.input_tokens || 0,
                        outputTokens: u.output_tokens || 0,
                    }, req._clientIp || req.ip || '-');
                } catch (usageErr) {
                    logger.error('[OpenAI] Usage recording failed:', usageErr);
                }
            }

        } catch (error) {
            logger.error('[OpenAI] Error:', error);

            // Invariant: never write to an already-terminated response
            if (res.writableEnded) {
                return;
            }

            // Converter-thrown validation errors carry statusCode/errorType
            if (error.statusCode) {
                return sendOpenAIError(res, error.statusCode, error.errorType || 'invalid_request_error', error.message);
            }

            let { errorType, statusCode, errorMessage, retryAfterMs } = parseError(error);
            logger.warn(`[OpenAI] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

            if (res.headersSent) {
                res.write(`data: ${JSON.stringify({
                    error: {
                        type: OPENAI_ERROR_TYPE[errorType] || 'server_error',
                        message: errorMessage
                    }
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                sendOpenAIError(res, statusCode, errorType, errorMessage, { retryAfterMs });
            }
        }
    });
}

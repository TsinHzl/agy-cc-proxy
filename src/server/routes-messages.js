/**
 * Main messages endpoint (moved verbatim from src/server.js):
 * POST /v1/messages with model mapping/resolution, optimistic retry,
 * streaming (first-event buffering) and non-streaming branches.
 */

import { sendMessage, sendMessageStream, isValidModel, resolveModel } from '../cloudcode/index.js';
import { config } from '../config.js';
import { MODEL_MAP } from '../constants.js';
import { recordUsage, getAllowedAccounts } from '../api-keys/manager.js';
import { forceRefresh } from '../auth/token-extractor.js';
import { logger } from '../utils/logger.js';
import usageLog from '../modules/usage-log.js';
import { parseError } from './parse-error.js';

export function registerMessagesRoutes(app, ctx) {
    const { accountManager, ensureInitialized, fallbackEnabled } = ctx;

    app.post('/v1/messages', async (req, res) => {
        try {
            // Ensure account manager is initialized
            await ensureInitialized();

            const {
                model,
                messages,
                stream,
                system,
                max_tokens,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            } = req.body;

            // Resolve model mapping if configured
            let requestedModel = model || 'claude-3-5-sonnet-20241022';
            // Apply hardcoded aliases/mapping first
            if (MODEL_MAP[requestedModel]) {
                logger.info(`[Server] Alias mapping ${requestedModel} -> ${MODEL_MAP[requestedModel]}`);
                requestedModel = MODEL_MAP[requestedModel];
            }

            const modelMapping = config.modelMapping || {};
            if (modelMapping[requestedModel] && modelMapping[requestedModel].mapping) {
                const targetModel = modelMapping[requestedModel].mapping;
                logger.info(`[Server] Mapping model ${requestedModel} -> ${targetModel}`);
                requestedModel = targetModel;
            }

            const modelId = requestedModel;

            // Validate and resolve model ID before processing.
            // resolveModel auto-maps unknown Claude/Gemini model names (e.g. standard Anthropic
            // client defaults like claude-opus-4-5) to the closest available Google Cloud Code model,
            // preventing INVALID_ARGUMENT errors for remote clients that haven't configured model env vars.
            const { account: validationAccount } = accountManager.selectAccount();
            if (validationAccount) {
                const token = await accountManager.getTokenForAccount(validationAccount);
                const projectId = validationAccount.subscription?.projectId || null;
                const { resolved, autoMapped } = await resolveModel(modelId, token, projectId);
                if (autoMapped) {
                    logger.info(`[Server] Auto-mapped model ${modelId} → ${resolved}`);
                    requestedModel = resolved;
                } else {
                    const valid = await isValidModel(modelId, token, projectId);
                    if (!valid) {
                        throw new Error(`invalid_request_error: Invalid model: ${modelId}. Use /v1/models to see available models.`);
                    }
                }
            }

            // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them to force a fresh check.
            // If we have some available accounts, we try them first.
            if (accountManager.isAllRateLimited(modelId)) {
                logger.warn(`[Server] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
                accountManager.resetAllRateLimits();
            }

            // Validate required fields
            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'messages is required and must be an array'
                    }
                });
            }

            // Filter out "count" requests (often automated background checks)
            if (messages.length === 1 && messages[0].content === 'count') {
                return res.json({});
            }

            // Build the request object
            const request = {
                model: modelId,
                messages,
                max_tokens: max_tokens || 4096,
                stream,
                system,
                tools,
                tool_choice,
                thinking,
                top_p,
                top_k,
                temperature
            };

            logger.info(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

            // Debug: Log message structure to diagnose tool_use/tool_result ordering
            if (logger.isDebugEnabled) {
                logger.debug('[API] Message structure:');
                messages.forEach((msg, i) => {
                    const contentTypes = Array.isArray(msg.content)
                        ? msg.content.map(c => c.type || 'text').join(', ')
                        : (typeof msg.content === 'string' ? 'text' : 'unknown');
                    logger.debug(`  [${i}] ${msg.role}: ${contentTypes}`);
                });
            }

            if (stream) {
                // Handle streaming response
                // Do NOT flush headers immediately. We need to wait for the first chunk
                // to ensure we don't send a 200 OK if the upstream fails immediately (e.g. 429/503).

                // Usage tracking
                const streamStartTime = Date.now();
                let usageInputTokens = 0;
                let usageOutputTokens = 0;
                let usageCacheReadTokens = 0;
                let usageTimeToFirstToken = null;

                try {
                    // Initialize the generator
                    const generator = sendMessageStream(request, accountManager, fallbackEnabled, { allowedEmails: getAllowedAccounts(req._apiKeyId) });

                    // BUFFERING STRATEGY:
                    // Pull the first event *before* sending headers.
                    // If this throws, we can safely send a 4xx/5xx error JSON.
                    const firstResult = await generator.next();

                    // If we get here, the stream started successfully.
                    res.status(200);
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.setHeader('X-Accel-Buffering', 'no');
                    res.flushHeaders();

                    // Helper to extract usage from events
                    const captureUsage = (event) => {
                        if (event.type === 'message_start' && event.message?.usage) {
                            usageInputTokens = event.message.usage.input_tokens || 0;
                            usageCacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
                        }
                        if (event.type === 'content_block_delta' && usageTimeToFirstToken === null) {
                            usageTimeToFirstToken = (Date.now() - streamStartTime) / 1000;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            usageOutputTokens = event.usage.output_tokens || 0;
                        }
                    };

                    // Capture usage from first event
                    captureUsage(firstResult.value);

                    // If the generator isn't done, send the first chunk
                    if (!firstResult.done) {
                        res.write(`event: ${firstResult.value.type}\ndata: ${JSON.stringify(firstResult.value)}\n\n`);
                        if (res.flush) res.flush();
                    }

                    // Continue with the rest of the stream
                    for await (const event of generator) {
                        captureUsage(event);
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                        if (res.flush) res.flush();
                    }

                    res.end();

                    // Record usage log entry on successful stream completion
                    const totalDuration = (Date.now() - streamStartTime) / 1000;
                    usageLog.record({
                        timestamp: new Date(streamStartTime).toISOString(),
                        model: modelId,
                        apiKey: validationAccount?.email || '-',
                        clientIp: req._clientIp || req.ip || '-',
                        keyId: req._apiKeyId || null,
                        inputTokens: usageInputTokens,
                        outputTokens: usageOutputTokens,
                        cacheReadTokens: usageCacheReadTokens,
                        totalDuration,
                        timeToFirstToken: usageTimeToFirstToken,
                        streaming: true,
                    });
                    recordUsage(req._apiKeyId, {
                        inputTokens: usageInputTokens,
                        outputTokens: usageOutputTokens,
                    }, req._clientIp || req.ip || '-');

                } catch (error) {
                    // If we haven't sent headers yet, we can send a proper error status
                    if (!res.headersSent) {
                        logger.error('[API] Initial stream error:', error);
                        const { errorType, statusCode, errorMessage, retryAfterMs } = parseError(error);

                        if (retryAfterMs) {
                            res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
                        }
                        return res.status(statusCode).json({
                            type: 'error',
                            error: {
                                type: errorType,
                                message: errorMessage
                            }
                        });
                    }

                    // If headers were already sent (should only happen if error occurs mid-stream),
                    // we have to fallback to SSE error event
                    logger.error('[API] Mid-stream error:', error);
                    const { errorType, errorMessage } = parseError(error);

                    res.write(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: errorType, message: errorMessage }
                    })}\n\n`);
                    res.end();
                }

            } else {
                // Handle non-streaming response
                const nonStreamStartTime = Date.now();
                const response = await sendMessage(request, accountManager, fallbackEnabled, { allowedEmails: getAllowedAccounts(req._apiKeyId) });
                res.json(response);

                // Record usage for non-streaming request
                const u = response?.usage || {};
                usageLog.record({
                    timestamp: new Date(nonStreamStartTime).toISOString(),
                    model: modelId,
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
            }

        } catch (error) {
            logger.error('[API] Error:', error);

            let { errorType, statusCode, errorMessage, retryAfterMs } = parseError(error);

            // For auth errors, try to refresh token
            if (errorType === 'authentication_error') {
                logger.warn('[API] Token might be expired, attempting refresh...');
                try {
                    accountManager.clearProjectCache();
                    accountManager.clearTokenCache();
                    await forceRefresh();
                    errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
                } catch (refreshError) {
                    errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
                }
            }

            logger.warn(`[API] Returning error response: ${statusCode} ${errorType} - ${errorMessage}`);

            // Check if headers have already been sent (for streaming that failed mid-way)
            if (res.headersSent) {
                logger.warn('[API] Headers already sent, writing error as SSE event');
                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            } else {
                if (retryAfterMs) {
                    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
                }
                res.status(statusCode).json({
                    type: 'error',
                    error: {
                        type: errorType,
                        message: errorMessage
                    }
                });
            }
        }
    });
}

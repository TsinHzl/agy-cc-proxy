/**
 * Misc API routes (moved verbatim from src/server.js):
 * silent root POST, signature-cache clearing, token refresh,
 * model listing, and the count_tokens stub.
 */

import { listModels } from '../cloudcode/index.js';
import { forceRefresh } from '../auth/token-extractor.js';
import { clearThinkingSignatureCache } from '../format/signature-cache.js';
import { logger } from '../utils/logger.js';
import { apiKeyAuth } from './middleware.js';

const REMOTE_MEDIA_TOKEN_ESTIMATE = 8_192;

function estimateMediaTokens(block) {
    if (typeof block?.source?.data === 'string') {
        return Math.ceil(block.source.data.length / 4);
    }

    return REMOTE_MEDIA_TOKEN_ESTIMATE;
}

/**
 * Estimate token count for an Anthropic content field. The count only drives
 * Claude Code's context-budget and auto-compact decision, so a local heuristic
 * is sufficient and avoids making the endpoint depend on accounts or upstream APIs.
 */
function estimateContentTokens(content) {
    let text = '';
    let mediaTokens = 0;
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
                text += `${block.text}\n`;
            } else if (block?.type === 'image' || block?.type === 'document') {
                mediaTokens += estimateMediaTokens(block);
            } else if (block?.type === 'tool_use') {
                text += JSON.stringify(block.input ?? {});
            } else if (block?.type === 'tool_result') {
                if (typeof block.content === 'string') {
                    text += block.content;
                } else if (Array.isArray(block.content)) {
                    for (const resultBlock of block.content) {
                        if (resultBlock?.type === 'text' && typeof resultBlock.text === 'string') {
                            text += resultBlock.text;
                        } else if (resultBlock?.type === 'image' || resultBlock?.type === 'document') {
                            mediaTokens += estimateMediaTokens(resultBlock);
                        }
                    }
                }
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                text += block.thinking;
            }
        }
    }

    if (!text) return mediaTokens;

    const cjkChars = (text.match(/[　-鿿豈-﫿＀-￯]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return mediaTokens + Math.max(1, Math.ceil(cjkChars * 1.1 + otherChars / 4));
}

export function registerMiscRoutes(app, ctx) {
    const { accountManager, ensureInitialized } = ctx;

    /**
     * Silent handler for Claude Code CLI root POST requests
     * Claude Code sends heartbeat/event requests to POST / which we don't need
     */
    app.post('/', (req, res) => {
        res.status(200).json({ status: 'ok' });
    });

    /**
     * Test endpoint - Clear thinking signature cache
     * Used for testing cold cache scenarios in cross-model tests
     */
    app.post('/test/clear-signature-cache', (req, res) => {
        clearThinkingSignatureCache();
        logger.debug('[Test] Cleared thinking signature cache');
        res.json({ success: true, message: 'Thinking signature cache cleared' });
    });

    /**
     * Force token refresh endpoint (API key protected)
     */
    app.post('/refresh-token', apiKeyAuth, async (req, res) => {
        try {
            await ensureInitialized();
            // Clear all caches
            accountManager.clearTokenCache();
            accountManager.clearProjectCache();
            // Force refresh default token
            await forceRefresh();
            res.json({
                status: 'ok',
                message: 'Token caches cleared and refreshed'
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    /**
     * List models endpoint (OpenAI-compatible format)
     */
    app.get('/v1/models', async (req, res) => {
        try {
            await ensureInitialized();
            const { account } = accountManager.selectAccount();
            if (!account) {
                return res.status(503).json({
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: 'No accounts available'
                    }
                });
            }
            const token = await accountManager.getTokenForAccount(account);
            const models = await listModels(token);
            res.json(models);
        } catch (error) {
            logger.error('[API] Error listing models:', error);
            res.status(500).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: error.message
                }
            });
        }
    });

    /**
     * Count tokens endpoint - Anthropic Messages API compatible.
     * A local estimate keeps Claude Code's auto-compact budget available even
     * when no upstream account is initialized.
     */
    app.post('/v1/messages/count_tokens', (req, res) => {
        const { model, messages, system, tools } = req.body || {};

        if (!Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        let total = 0;
        if (typeof system === 'string') {
            total += estimateContentTokens(system);
        } else if (Array.isArray(system)) {
            total += estimateContentTokens(system.filter((block) => block?.type === 'text'));
        }

        if (Array.isArray(tools)) {
            for (const tool of tools) {
                total += Math.ceil(JSON.stringify(tool ?? {}).length / 3);
            }
        }

        for (const message of messages) {
            total += 4;
            total += estimateContentTokens(message?.content);
        }

        logger.debug(`[CountTokens] model=${model || '-'} estimated=${total} messages=${messages.length}`);
        return res.json({ input_tokens: total });
    });
}

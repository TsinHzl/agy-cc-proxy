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
     * Count tokens endpoint - Anthropic Messages API compatible
     * Uses local tokenization with official tokenizers (@anthropic-ai/tokenizer for Claude, @lenml/tokenizer-gemini for Gemini)
     */
    app.post('/v1/messages/count_tokens', (req, res) => {
        res.status(501).json({
            type: 'error',
            error: {
                type: 'not_implemented',
                message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
            }
        });
    });
}

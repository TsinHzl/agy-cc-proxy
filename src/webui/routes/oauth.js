/**
 * WebUI OAuth routes (moved verbatim from webui/index.js).
 * `pendingOAuthFlows` stays in the assembly file (webui/index.js) and is
 * injected here via ctx, preserving the original shared-state semantics.
 */

import { logger } from '../../utils/logger.js';
import { getAuthorizationUrl, completeOAuthFlow, startCallbackServer } from '../../auth/oauth.js';
import { addAccount } from '../account-ops.js';

export function registerOAuthRoutes(app, ctx) {
    const { pendingOAuthFlows, accountManager } = ctx;

    /**
     * GET /api/auth/url - Get OAuth URL to start the flow
     * Uses CLI's OAuth flow (localhost:51121) instead of WebUI's port
     * to match Google OAuth Console's authorized redirect URIs
     */
    app.get('/api/auth/url', async (req, res) => {
        try {
            // Clean up old flows (> 10 mins)
            const now = Date.now();
            for (const [key, val] of pendingOAuthFlows.entries()) {
                if (now - val.timestamp > 10 * 60 * 1000) {
                    pendingOAuthFlows.delete(key);
                }
            }

            // Generate OAuth URL using default redirect URI (localhost:51121)
            // Pass login_hint if re-authenticating a known account (enables Chrome password auto-fill)
            const loginHint = req.query.email || undefined;
            const { url, verifier, state } = getAuthorizationUrl({ loginHint });

            // Start callback server on port 51121 (same as CLI)
            const { promise: serverPromise, abort: abortServer } = startCallbackServer(state, 120000); // 2 min timeout

            // Store the flow data
            pendingOAuthFlows.set(state, {
                serverPromise,
                abortServer,
                verifier,
                state,
                timestamp: Date.now()
            });

            // Start async handler for the OAuth callback
            serverPromise
                .then(async (code) => {
                    try {
                        logger.info('[WebUI] Received OAuth callback, completing flow...');
                        const accountData = await completeOAuthFlow(code, verifier);

                        // Add or update the account
                        // Note: Don't set projectId here - it will be discovered and stored
                        // in the refresh token via getProjectForAccount() on first use
                        await addAccount({
                            email: accountData.email,
                            refreshToken: accountData.refreshToken,
                            source: 'oauth'
                        });

                        // Reload AccountManager to pick up the new account
                        await accountManager.reload();

                        logger.success(`[WebUI] Account ${accountData.email} added successfully`);
                    } catch (err) {
                        logger.error('[WebUI] OAuth flow completion error:', err);
                    } finally {
                        pendingOAuthFlows.delete(state);
                    }
                })
                .catch((err) => {
                    // Only log if not aborted (manual completion causes this)
                    if (!err.message?.includes('aborted')) {
                        logger.error('[WebUI] OAuth callback server error:', err);
                    }
                    pendingOAuthFlows.delete(state);
                });

            res.json({ status: 'ok', url, state });
        } catch (error) {
            logger.error('[WebUI] Error generating auth URL:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/complete - Complete OAuth with manually submitted callback URL/code
     * Used when auto-callback cannot reach the local server
     */
    app.post('/api/auth/complete', async (req, res) => {
        try {
            const { callbackInput, state } = req.body;

            if (!callbackInput || !state) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing callbackInput or state'
                });
            }

            // Find the pending flow
            const flowData = pendingOAuthFlows.get(state);
            if (!flowData) {
                return res.status(400).json({
                    status: 'error',
                    error: 'OAuth flow not found. The account may have been already added via auto-callback. Please refresh the account list.'
                });
            }

            const { verifier, abortServer } = flowData;

            // Extract code from input (URL or raw code)
            const { extractCodeFromInput, completeOAuthFlow } = await import('../../auth/oauth.js');
            const { code } = extractCodeFromInput(callbackInput);

            // Complete the OAuth flow
            const accountData = await completeOAuthFlow(code, verifier);

            // Add or update the account
            await addAccount({
                email: accountData.email,
                refreshToken: accountData.refreshToken,
                projectId: accountData.projectId,
                source: 'oauth'
            });

            // Reload AccountManager to pick up the new account
            await accountManager.reload();

            // Abort the callback server since manual completion succeeded
            if (abortServer) {
                abortServer();
            }

            // Clean up
            pendingOAuthFlows.delete(state);

            logger.success(`[WebUI] Account ${accountData.email} added via manual callback`);

            res.json({
                status: 'ok',
                email: accountData.email,
                message: `Account ${accountData.email} added successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Manual OAuth completion error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * Note: /oauth/callback route removed
     * OAuth callbacks are now handled by the temporary server on port 51121
     * (same as CLI) to match Google OAuth Console's authorized redirect URIs
     */
}

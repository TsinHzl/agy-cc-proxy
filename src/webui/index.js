/**
 * WebUI assembly entry (refactored from monolithic webui/index.js).
 * Route handlers moved verbatim to ./routes/*.js, helpers to ./session.js,
 * ./auth.js, ./account-ops.js, ./validate-config.js. This file only wires
 * them up in the original mounting order — no behavior change.
 */

import express from 'express';
import path from 'path';
import { getPackageVersion } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { createAuthMiddleware } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerClaudeRoutes } from './routes/claude.js';
import { registerServerPresetRoutes } from './routes/server-presets.js';
import { registerModelRoutes } from './routes/models.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerStrategyRoutes } from './routes/strategy.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';

// Pending OAuth flows: keyed by state, holding { serverPromise, abortServer, verifier, timestamp }
const pendingOAuthFlows = new Map();

const packageVersion = getPackageVersion();

/**
 * Mount WebUI routes and middleware on Express app
 * @param {Express} app - Express application instance
 * @param {string} dirname - __dirname of the calling module (for static file path)
 * @param {AccountManager} accountManager - Account manager instance
 */
export function mountWebUI(app, dirname, accountManager) {
    const ctx = { accountManager, packageVersion, pendingOAuthFlows };

    // Apply auth middleware
    app.use(createAuthMiddleware());

    // Serve static files from public directory
    app.use(express.static(path.join(dirname, '../public')));

    // Register routes (original mounting order preserved)
    registerAuthRoutes(app, ctx);
    registerAccountRoutes(app, ctx);
    registerConfigRoutes(app, ctx);
    registerClaudeRoutes(app, ctx);
    registerServerPresetRoutes(app, ctx);
    registerModelRoutes(app, ctx);
    registerLogRoutes(app, ctx);
    registerStrategyRoutes(app, ctx);
    registerOAuthRoutes(app, ctx);
    registerApiKeyRoutes(app, ctx);

    logger.info('[WebUI] Mounted at /');
}

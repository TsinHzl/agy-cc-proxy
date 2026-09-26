/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 * Supports multi-account load balancing
 *
 * Bootstrap + assembly module: argv parsing, initialization, middleware/route
 * registration (implementation moved verbatim to src/server/*).
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mountWebUI } from './webui/index.js';
import { AccountManager } from './account-manager/index.js';
import { logger } from './utils/logger.js';
import usageStats from './modules/usage-stats.js';
import usageLog from './modules/usage-log.js';
import { registerCoreMiddleware } from './server/middleware.js';
import { registerMiscRoutes } from './server/routes-misc.js';
import { registerHealthRoutes } from './server/routes-health.js';
import { registerMessagesRoutes } from './server/routes-messages.js';

const __filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(__filename);

// Parse fallback flag directly from command line args to avoid circular dependency
const args = process.argv.slice(2);
const FALLBACK_ENABLED = args.includes('--fallback') || process.env.FALLBACK === 'true';

// Parse --strategy flag (format: --strategy=sticky or --strategy sticky)
let STRATEGY_OVERRIDE = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

const app = express();

// Disable x-powered-by header for security
app.disable('x-powered-by');

// Initialize account manager (will be fully initialized on first request or startup)
export const accountManager = new AccountManager();

// Track initialization status
let isInitialized = false;
let initError = null;
let initPromise = null;

/**
 * Ensure account manager is initialized (with race condition protection)
 */
async function ensureInitialized() {
    if (isInitialized) return;

    // If initialization is already in progress, wait for it
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize(STRATEGY_OVERRIDE);
            isInitialized = true;
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            initError = error;
            initPromise = null; // Allow retry on failure
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Core middleware (cors, body parser, access logging, API key auth, usage init)
registerCoreMiddleware(app);

// Web UI (static assets + dashboard API routes)
mountWebUI(app, dirname, accountManager);

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logMsg = `[${req.method}] ${req.originalUrl} ${status} (${duration}ms)`;

        // Skip standard logging for event logging batch unless in debug mode
        if (req.originalUrl === '/api/event_logging/batch' || req.originalUrl.startsWith('/v1/messages/count_tokens') || req.originalUrl.startsWith('/.well-known/')) {
            if (logger.isDebugEnabled) {
                logger.debug(logMsg);
            }
        } else {
            // Colorize status code
            if (status >= 500) {
                logger.error(logMsg);
            } else if (status >= 400) {
                logger.warn(logMsg);
            } else {
                logger.info(logMsg);
            }
        }
    });

    next();
});

// API routes
const ctx = { accountManager, ensureInitialized, fallbackEnabled: FALLBACK_ENABLED };
registerMiscRoutes(app, ctx);
registerHealthRoutes(app, ctx);
registerMessagesRoutes(app, ctx);

/**
 * Catch-all for unsupported endpoints
 */
usageStats.setupRoutes(app);

usageLog.setupRoutes(app);

app.use('*', (req, res) => {
    // Log 404s (use originalUrl since wildcard strips req.path)
    if (logger.isDebugEnabled) {
        logger.debug(`[API] 404 Not Found: ${req.method} ${req.originalUrl}`);
    }
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;

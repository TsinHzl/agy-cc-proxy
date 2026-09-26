/**
 * Core middleware registration (moved verbatim from src/server.js).
 * Registers middleware in the original order: cors, body parser, optional
 * request-body dump diagnostics, trust proxy, /v1 access logging, /v1 API key
 * auth, usage stats middleware, usage log init, and the silent handler for
 * Claude Code CLI heartbeat requests.
 */

import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { config, verifyApiKey } from '../config.js';
import { REQUEST_BODY_LIMIT } from '../constants.js';
import { logger } from '../utils/logger.js';
import { findKeyBySecret, checkAndActivate, isExpired, checkQuota } from '../api-keys/manager.js';
import usageStats from '../modules/usage-stats.js';
import usageLog from '../modules/usage-log.js';

export function registerCoreMiddleware(app) {
    // Middleware
    app.use(cors());
    app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

    // Request body dump switch (diagnostics, default OFF — zero overhead when unset).
    // Enable with ANTIGRAVITY_DUMP_REQUEST_BODY=1 to write each /v1/messages body
    // to /tmp/agy-dump/<timestamp>-<seq>-<model>.json for upstream 429 debugging.
    const DUMP_REQUEST_BODY = process.env.ANTIGRAVITY_DUMP_REQUEST_BODY === '1';
    if (DUMP_REQUEST_BODY) {
        let dumpSeq = 0;
        const dumpDir = '/tmp/agy-dump';
        fs.mkdirSync(dumpDir, { recursive: true });
        app.use('/v1/messages', (req, res, next) => {
            if (req.method !== 'POST') return next();
            try {
                const seq = String(++dumpSeq).padStart(4, '0');
                const model = String(req.body?.model || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
                const file = `${dumpDir}/${Date.now()}-${seq}-${model}.json`;
                fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
            } catch (err) {
                logger.warn(`[Dump] Failed to dump request body: ${err.message}`);
            }
            next();
        });
    }

    // Trust proxy headers (for X-Forwarded-For behind reverse proxies)
    app.set('trust proxy', true);

    // Access logging middleware - record client IP for all API requests
    app.use('/v1', (req, res, next) => {
        const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
        req._clientIp = clientIp;
        if (req.method === 'POST') {
            logger.info(`[Access] ${req.method} ${req.path} from ${clientIp} model=${req.body?.model || '-'}`);
        }
        next();
    });

    // API Key authentication middleware for /v1/* endpoints
    // Primary key (config.apiKey) is checked first (id: null, zero regression),
    // then managed keys from the api-keys store.
    app.use('/v1', (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const xApiKey = req.headers['x-api-key'];

        let providedKey = '';
        if (authHeader && authHeader.startsWith('Bearer ')) {
            providedKey = authHeader.substring(7).trim();
        } else if (xApiKey && typeof xApiKey === 'string') {
            providedKey = xApiKey.trim();
        }

        if (!providedKey) {
            logger.warn(`[API] Unauthorized request from ${req.ip || req.socket?.remoteAddress}, invalid or missing API key`);
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Invalid or missing API key'
                }
            });
        }

        // Primary key match - behaves exactly as before this feature existed
        if (verifyApiKey(providedKey, config.apiKey)) {
            req._apiKeyId = null;
            return next();
        }

        // Managed key match + state checks (order: enabled -> lazy activation -> expiry -> quota)
        const keyRecord = findKeyBySecret(providedKey);
        if (!keyRecord) {
            logger.warn(`[API] Unauthorized request from ${req.ip || req.socket?.remoteAddress}, invalid or missing API key`);
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Invalid or missing API key'
                }
            });
        }

        if (!keyRecord.enabled) {
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'API key has been disabled'
                }
            });
        }

        // Lazy activation: first use starts the validity window; this request passes
        checkAndActivate(keyRecord);

        if (isExpired(keyRecord)) {
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'API key has expired'
                }
            });
        }

        if (checkQuota(keyRecord)) {
            return res.status(429).json({
                type: 'error',
                error: {
                    type: 'rate_limit_error',
                    message: 'API key spending limit exceeded'
                }
            });
        }

        req._apiKeyId = keyRecord.id;
        next();
    });

    // Setup usage statistics middleware
    usageStats.setupMiddleware(app);

    // Initialize usage log module
    usageLog.init();

    /**
     * Silent handler for Claude Code CLI root POST requests
     * Claude Code sends heartbeat/event requests to POST / which we don't need
     * Using app.use instead of app.post for earlier middleware interception
     */
    app.use((req, res, next) => {
        // Handle Claude Code event logging requests silently
        if (req.method === 'POST' && req.path === '/api/event_logging/batch') {
            return res.status(200).json({ status: 'ok' });
        }
        // Handle Claude Code root POST requests silently
        if (req.method === 'POST' && req.path === '/') {
            return res.status(200).json({ status: 'ok' });
        }
        next();
    });
}

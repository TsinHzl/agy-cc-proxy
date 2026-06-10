import fs from 'fs';
import path from 'path';

import { USAGE_LOG_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

// ─── Persistence ────────────────────────────────────────────────────────────
const DATA_DIR = path.dirname(USAGE_LOG_PATH);
const MAX_RECORDS = 5000;

// ─── Pricing Table ──────────────────────────────────────────────────────────
// Credits = (tokens / 1_000_000) × price_per_million
// Matching: first prefix match wins (from specific to generic)
const PRICING = [
    { prefix: 'deepseek-v4-pro',   input: 0.20, output: 0.80, cache: 0.02 },
    { prefix: 'deepseek-r1',       input: 0.55, output: 2.19, cache: 0.14 },
    { prefix: 'deepseek-v3',       input: 0.27, output: 1.10, cache: 0.07 },
    { prefix: 'deepseek-chat',     input: 0.27, output: 1.10, cache: 0.07 },
    { prefix: 'claude-opus-4',     input: 15.00, output: 75.00, cache: 1.50 },
    { prefix: 'claude-sonnet-4',   input: 3.00, output: 15.00, cache: 0.30 },
    { prefix: 'claude-haiku-4',    input: 0.80, output: 4.00, cache: 0.08 },
    { prefix: 'claude-opus-3',     input: 15.00, output: 75.00, cache: 1.50 },
    { prefix: 'claude-sonnet-3',   input: 3.00, output: 15.00, cache: 0.30 },
    { prefix: 'claude-haiku-3',    input: 0.25, output: 1.25, cache: 0.03 },
    { prefix: 'gemini-2.5-pro',    input: 1.25, output: 10.00, cache: 0.25 },
    { prefix: 'gemini-2.5-flash',  input: 0.15, output: 0.60, cache: 0.02 },
    { prefix: 'gemini-3',          input: 0.50, output: 2.00, cache: 0.05 },
    { prefix: 'gemini',            input: 0.075, output: 0.30, cache: 0.01 },
];

// Fallback pricing for unrecognized models
const FALLBACK_PRICING = { input: 0.50, output: 2.00, cache: 0.05 };

// ─── In-memory Storage ──────────────────────────────────────────────────────
let records = [];
let isDirty = false;

/**
 * Match model to pricing tier (first prefix match wins).
 * @param {string} modelId
 * @returns {{ input: number, output: number, cache: number }}
 */
function getPricing(modelId) {
    const lower = (modelId || '').toLowerCase();
    for (const tier of PRICING) {
        if (lower.startsWith(tier.prefix)) {
            return tier;
        }
    }
    return FALLBACK_PRICING;
}

/**
 * Calculate credits from token counts and model pricing.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} cacheReadTokens
 * @param {string} modelId
 * @returns {number} Credits with 4 decimal precision
 */
function calculateCredits(inputTokens, outputTokens, cacheReadTokens, modelId) {
    const pricing = getPricing(modelId);
    const credits =
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output +
        (cacheReadTokens / 1_000_000) * pricing.cache;
    return Math.round(credits * 10000) / 10000; // 4 decimal places
}

/**
 * Mask an email address for display.
 * e.g. "user@domain.com" → "us***@domain.com"
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
    if (!email || !email.includes('@')) return email || '-';
    const [local, domain] = email.split('@');
    if (local.length <= 2) return `${local[0]}***@${domain}`;
    return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Record a usage entry.
 * @param {Object} entry
 * @param {string} entry.timestamp - ISO 8601 timestamp
 * @param {string} entry.model - Model ID
 * @param {string} entry.apiKey - Account email (will be masked)
 * @param {number} entry.inputTokens
 * @param {number} entry.outputTokens
 * @param {number} entry.cacheReadTokens
 * @param {number} entry.totalDuration - Total request duration in ms
 * @param {number|null} entry.timeToFirstToken - Time to first token in ms (null for non-streaming)
 * @param {boolean} entry.streaming
 */
function record(entry) {
    const {
        timestamp = new Date().toISOString(),
        model = 'unknown',
        apiKey = '-',
        inputTokens = 0,
        outputTokens = 0,
        cacheReadTokens = 0,
        totalDuration = 0,
        timeToFirstToken = null,
        streaming = true,
    } = entry;

    const totalTokens = inputTokens + outputTokens + cacheReadTokens;
    const credits = calculateCredits(inputTokens, outputTokens, cacheReadTokens, model);

    const record = {
        timestamp,
        model,
        apiKey: maskEmail(apiKey),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        totalTokens,
        totalDuration: Math.round(totalDuration * 100) / 100,   // seconds, 2dp
        timeToFirstToken: timeToFirstToken != null
            ? Math.round(timeToFirstToken * 100) / 100
            : null,
        streaming,
        credits,
    };

    // Prepend to keep newest first
    records.unshift(record);

    // Trim oldest if over limit
    if (records.length > MAX_RECORDS) {
        records = records.slice(0, MAX_RECORDS);
    }

    isDirty = true;

    if (logger.isDebugEnabled) {
        logger.debug(`[UsageLog] Recorded: ${model} | ${inputTokens}+${outputTokens}+${cacheReadTokens}=${totalTokens} tokens | ${credits} credits`);
    }
}

/**
 * Get all usage records (newest first).
 * @returns {Object[]}
 */
function getRecords() {
    return records;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function load() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(USAGE_LOG_PATH)) {
            const data = fs.readFileSync(USAGE_LOG_PATH, 'utf8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                records = parsed.slice(0, MAX_RECORDS);
                logger.info(`[UsageLog] Loaded ${records.length} records`);
            }
        }
    } catch (err) {
        logger.error('[UsageLog] Failed to load history:', err);
        records = [];
    }
}

function save() {
    if (!isDirty) return;
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(USAGE_LOG_PATH, JSON.stringify(records, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[UsageLog] Failed to save history:', err);
    }
}

// ─── API Routes ─────────────────────────────────────────────────────────────

/**
 * Register API routes on the Express app.
 * @param {import('express').Application} app
 */
function setupRoutes(app) {
    app.get('/api/usage-log', (_req, res) => {
        res.json({
            status: 'ok',
            records,
        });
    });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Initialize the module: load from disk, start periodic save, register shutdown handlers.
 */
function init() {
    load();

    // Periodic save every 60 seconds
    setInterval(() => {
        save();
    }, 60_000);

    // Emergency save on graceful shutdown
    const shutdown = () => {
        save();
        process.exit();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    logger.info('[UsageLog] Initialized');
}

export default {
    init,
    setupRoutes,
    record,
    getRecords,
    getPricing,
    calculateCredits,
};

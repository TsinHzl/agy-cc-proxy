import fs from 'fs';
import path from 'path';
import os from 'os';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { logger } from './utils/logger.js';

const scryptAsync = promisify(scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;

/** Hash a plaintext password. Returns "scrypt:<saltBase64>:<hashBase64>". */
export async function hashPassword(plain) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

/** Verify a plaintext password against a stored hash string. */
export async function verifyPassword(plain, stored) {
    if (!stored) return false;
    if (!stored.startsWith('scrypt:')) {
        // Timing-safe legacy comparison: hash both sides with a fixed salt to get equal-length buffers
        const fixedSalt = Buffer.alloc(16);
        const [inputHash, storedHash] = await Promise.all([
            scryptAsync(plain, fixedSalt, SCRYPT_KEYLEN, SCRYPT_PARAMS),
            scryptAsync(stored, fixedSalt, SCRYPT_KEYLEN, SCRYPT_PARAMS),
        ]);
        return timingSafeEqual(inputHash, storedHash);
    }
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = await scryptAsync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return timingSafeEqual(actual, expected);
}

/** Return true if the stored password value is a legacy plaintext (not hashed). */
export function isLegacyPassword(stored) {
    return !!stored && !stored.startsWith('scrypt:');
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

const DENIED_KEYS = ['__proto__', 'constructor', 'prototype'];

function deepMerge(target, source) {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (DENIED_KEYS.includes(key)) return;
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

// Default config
const DEFAULT_CONFIG = {
    apiKey: '',
    webuiPassword: '',
    debug: false,
    devMode: false,
    logLevel: 'info',
    maxRetries: 5,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    persistTokenCache: false,
    defaultCooldownMs: 10000,  // 10 seconds
    maxWaitBeforeErrorMs: 120000, // 2 minutes
    maxAccounts: 10, // Maximum number of accounts allowed
    globalQuotaThreshold: 0, // 0 = disabled, 0.01-0.99 = minimum quota fraction before switching accounts
    requestThrottlingEnabled: false, // Opt-in: enable delay before Google API requests
    requestDelayMs: 200, // Delay in ms when throttling enabled (100-5000ms)
    // Rate limit handling (matches opencode-antigravity-auth)
    rateLimitDedupWindowMs: 2000,  // 2 seconds - prevents concurrent retry storms
    maxConsecutiveFailures: 3,     // Before applying extended cooldown
    extendedCooldownMs: 60000,     // 1 minute extended cooldown
    maxCapacityRetries: 5,         // Max retries for capacity exhaustion
    switchAccountDelayMs: 5000,    // Delay before switching accounts on rate limit
    capacityBackoffTiersMs: [5000, 10000, 20000, 30000, 60000], // Progressive backoff tiers for capacity exhaustion
    modelMapping: {},
    // Account selection strategy configuration
    accountSelection: {
        strategy: 'hybrid',           // 'sticky' | 'round-robin' | 'hybrid'
        // Hybrid strategy tuning (optional - sensible defaults)
        healthScore: {
            initial: 70,              // Starting score for new accounts
            successReward: 1,         // Points on successful request
            rateLimitPenalty: -10,    // Points on rate limit
            failurePenalty: -20,      // Points on other failures
            recoveryPerHour: 10,      // Passive recovery rate (matches health-tracker.js)
            minUsable: 50,            // Minimum score to be selected
            maxScore: 100             // Maximum score cap
        },
        tokenBucket: {
            maxTokens: 50,            // Maximum token capacity
            tokensPerMinute: 6,       // Regeneration rate
            initialTokens: 50         // Starting tokens
        },
        quota: {
            lowThreshold: 0.10,       // 10% - reduce score
            criticalThreshold: 0.05,  // 5% - exclude from candidates
            staleMs: 300000           // 5 min - max age of quota data to trust
        },
        weights: {
            health: 2,                // Weight for health score component
            tokens: 5,                // Weight for token bucket component
            quota: 3,                 // Weight for quota awareness component
            lru: 0.1                  // Weight for LRU freshness component
        }
    }
};

// Config locations
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config', 'antigravity-proxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (err) {
        // Ignore
    }
}

// Load config
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
    try {
        // Env vars take precedence for initial defaults, but file overrides them if present?
        // Usually Env > File > Default.

        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const userConfig = JSON.parse(fileContent);
            config = deepMerge(DEFAULT_CONFIG, userConfig);
        } else {
             // Try looking in current dir for config.json as fallback
             const localConfigPath = path.resolve('config.json');
             if (fs.existsSync(localConfigPath)) {
                 const fileContent = fs.readFileSync(localConfigPath, 'utf8');
                 const userConfig = JSON.parse(fileContent);
                 config = deepMerge(DEFAULT_CONFIG, userConfig);
             }
        }

        // Environment overrides
        if (process.env.API_KEY) config.apiKey = process.env.API_KEY;
        if (process.env.WEBUI_PASSWORD) config.webuiPassword = process.env.WEBUI_PASSWORD;
        if (process.env.DEBUG === 'true') config.debug = true;
        if (process.env.DEV_MODE === 'true') config.devMode = true;

        // Backward compat: debug implies devMode
        if (config.debug && !config.devMode) config.devMode = true;

        // Warn if WebUI password is still stored as plaintext (legacy)
        if (config.webuiPassword && !config.webuiPassword.startsWith('scrypt:')) {
            logger.warn('[Config] WebUI password is stored as plaintext. Please update it via the WebUI Settings to enable secure hashed storage.');
        }

    } catch (error) {
        logger.error('[Config] Error loading config:', error);
    }
}

// Initial load
loadConfig();

export function getPublicConfig() {
    // Create a deep copy and redact sensitive fields
    const publicConfig = JSON.parse(JSON.stringify(config));

    // Redact sensitive values
    if (publicConfig.webuiPassword) publicConfig.webuiPassword = '********';
    if (publicConfig.apiKey) publicConfig.apiKey = '********';

    return publicConfig;
}

export function saveConfig(updates) {
    try {
        // Apply updates (deep merge to preserve nested configs)
        config = deepMerge(config, updates);

        // Save to disk
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('[Config] Failed to save config:', error);
        return false;
    }
}

export { config };
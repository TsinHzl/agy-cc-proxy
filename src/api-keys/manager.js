/**
 * API Keys Manager
 *
 * Lifecycle, validation, quota logic and usage accounting for managed API keys.
 * The `usage` counters kept here are the authoritative data source for quota
 * enforcement and statistics; usage-log detail records (keyId) serve only as a
 * recent-activity display window.
 */

import { randomBytes } from 'crypto';
import { generateApiKey, verifyApiKey } from '../config.js';
import { saveApiKeys, loadApiKeys } from './storage.js';
import { logger } from '../utils/logger.js';

const USAGE_FLUSH_INTERVAL_MS = 60 * 1000; // Periodic persistence for usage counters

/** @type {{version: number, keys: Array}} */
let state = { version: 1, keys: [] };
let isDirty = false;
let flushTimer = null;
let lastSaveError = null;

/** Generate a short key id: `k_` + 8 hex chars. */
function generateKeyId() {
    return `k_${randomBytes(4).toString('hex')}`;
}

/** Create an empty usage counter object. */
function emptyUsage() {
    return { requests: 0, inputTokens: 0, outputTokens: 0 };
}

function markDirty() {
    isDirty = true;
}

/** Persist state if dirty (fire-and-forget, write-lock serialized in storage).
 *  Never rejects — returns true on success, false on failure (failure re-raises
 *  isDirty so the next periodic flush retries, and records the error so
 *  flushApiKeys can rethrow the original error with its fs error code). */
function scheduleSave() {
    if (!isDirty) return Promise.resolve(true);
    isDirty = false;
    return saveApiKeys(state).then(
        () => {
            lastSaveError = null;
            return true;
        },
        error => {
            isDirty = true;
            lastSaveError = error;
            logger.error('[ApiKeys] Scheduled save failed, will retry:', error.message);
            return false;
        }
    );
}

/**
 * Initialize manager: load keys from disk and start periodic flush.
 */
export async function initApiKeysManager() {
    state = await loadApiKeys();
    isDirty = false;
    if (!flushTimer) {
        flushTimer = setInterval(() => {
            scheduleSave();
        }, USAGE_FLUSH_INTERVAL_MS);
        flushTimer.unref();
    }
    return state;
}

/**
 * List all keys (caller is responsible for masking before sending to client).
 */
export function listKeys() {
    return state.keys;
}

/**
 * Validate and normalize a spendingLimit payload.
 *
 * @param {Object|null} spendingLimit - {metric: 'tokens'|'requests', limit: number}
 * @returns {Object|null} Normalized limit or null
 * @throws {Error} On invalid metric or limit
 */
function normalizeSpendingLimit(spendingLimit) {
    if (spendingLimit == null) return null;
    const { metric, limit } = spendingLimit;
    if (metric !== 'tokens' && metric !== 'requests') {
        throw new Error("spendingLimit.metric must be 'tokens' or 'requests'");
    }
    if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error('spendingLimit.limit must be a positive number');
    }
    return { metric, limit };
}

/**
 * Validate durationDays: null or a positive finite number.
 *
 * @param {*} durationDays
 * @throws {Error} On invalid value
 */
function validateDurationDays(durationDays) {
    if (durationDays == null) return;
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
        throw new Error('durationDays must be null or a positive number');
    }
}

/**
 * Create a new managed API key.
 *
 * @param {Object} opts - {name, durationDays?, spendingLimit?}
 * @returns {Object} The created key record (contains plaintext key)
 */
export function createKey({ name, durationDays = null, spendingLimit = null }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw new Error('name is required');
    }
    validateDurationDays(durationDays);
    const normalizedLimit = normalizeSpendingLimit(spendingLimit);

    const key = {
        id: generateKeyId(),
        name: name.trim(),
        key: generateApiKey(),
        enabled: true,
        durationDays: durationDays ?? null,
        activatedAt: null,
        expiresAt: null,
        spendingLimit: normalizedLimit,
        usage: emptyUsage(),
        createdAt: Date.now(),
        lastUsedAt: null,
        lastUsedIp: null
    };
    state.keys.push(key);
    markDirty();
    scheduleSave();
    return key;
}

/**
 * Update a managed API key.
 *
 * Supports `resetUsage: true` in the patch to zero the usage counters.
 * durationDays semantics: for an already-activated key, expiresAt is
 * recomputed from the ORIGINAL activatedAt; setting null clears expiresAt.
 * Keys not yet activated keep activatedAt/expiresAt null until first use.
 *
 * @param {string} id - Key id
 * @param {Object} patch - {name?, enabled?, durationDays?, spendingLimit?, resetUsage?}
 * @returns {Object|null} Updated key record, or null when not found
 * @throws {Error} On invalid patch values
 */
export function updateKey(id, patch) {
    const key = state.keys.find(k => k.id === id);
    if (!key) return null;

    // Validate the full patch up-front so a rejected update leaves no
    // partially-applied side effects (e.g. resetUsage applied then name throws).
    if (patch.name !== undefined && (!patch.name || typeof patch.name !== 'string' || !patch.name.trim())) {
        throw new Error('name is required');
    }
    if (patch.durationDays !== undefined) {
        validateDurationDays(patch.durationDays);
    }
    if (patch.spendingLimit !== undefined) {
        normalizeSpendingLimit(patch.spendingLimit);
    }

    if (patch.resetUsage === true) {
        key.usage = emptyUsage();
    }
    if (patch.name !== undefined) {
        key.name = patch.name.trim();
    }
    if (patch.enabled !== undefined) {
        key.enabled = patch.enabled === true;
    }
    if (patch.durationDays !== undefined) {
        key.durationDays = patch.durationDays ?? null;
        if (key.activatedAt != null) {
            // Already activated: recompute expiry from the original activation time
            key.expiresAt = key.durationDays != null
                ? key.activatedAt + key.durationDays * 24 * 60 * 60 * 1000
                : null;
        }
    }
    if (patch.spendingLimit !== undefined) {
        key.spendingLimit = normalizeSpendingLimit(patch.spendingLimit);
    }

    markDirty();
    scheduleSave();
    return key;
}

/**
 * Delete a managed API key.
 *
 * @param {string} id - Key id
 * @returns {boolean} true when deleted, false when not found
 */
export function deleteKey(id) {
    const index = state.keys.findIndex(k => k.id === id);
    if (index === -1) return false;
    state.keys.splice(index, 1);
    markDirty();
    scheduleSave();
    return true;
}

/**
 * Find a key record by exact plaintext match (timing-safe per candidate).
 *
 * @param {string} providedKey
 * @returns {Object|null} Matched key record or null
 */
export function findKeyBySecret(providedKey) {
    if (!providedKey) return null;
    for (const key of state.keys) {
        if (verifyApiKey(providedKey, key.key)) {
            return key;
        }
    }
    return null;
}

/**
 * Lazily activate a key on first use: set activatedAt/expiresAt.
 * Returns true when activation happened (caller should let this request pass
 * even if over quota, and persist asynchronously).
 *
 * @param {Object} key - Key record
 * @returns {boolean}
 */
export function checkAndActivate(key) {
    if (key.activatedAt != null || key.durationDays == null) return false;
    key.activatedAt = Date.now();
    key.expiresAt = key.activatedAt + key.durationDays * 24 * 60 * 60 * 1000;
    markDirty();
    scheduleSave();
    return true;
}

/**
 * Check whether a key is expired.
 *
 * @param {Object} key - Key record
 * @returns {boolean}
 */
export function isExpired(key) {
    return key.expiresAt != null && Date.now() > key.expiresAt;
}

/**
 * Check whether a key has exceeded its spending limit.
 *
 * @param {Object} key - Key record
 * @returns {boolean}
 */
export function checkQuota(key) {
    if (!key.spendingLimit) return false;
    const { metric, limit } = key.spendingLimit;
    // tokens = input + output 合计（usage 无独立 tokens 字段）
    const used = metric === 'tokens'
        ? (key.usage.inputTokens || 0) + (key.usage.outputTokens || 0)
        : (key.usage[metric] || 0);
    return used >= limit;
}

/**
 * Record a successful request against a key.
 *
 * @param {string|null} keyId - Managed key id (null = primary key, not tracked)
 * @param {Object} tokens - {inputTokens, outputTokens}
 * @param {string} clientIp
 */
export function recordUsage(keyId, { inputTokens = 0, outputTokens = 0 } = {}, clientIp = null) {
    if (keyId == null) return;
    const key = state.keys.find(k => k.id === keyId);
    if (!key) return;
    key.usage.requests += 1;
    key.usage.inputTokens += inputTokens || 0;
    key.usage.outputTokens += outputTokens || 0;
    key.lastUsedAt = Date.now();
    key.lastUsedIp = clientIp;
    markDirty();
}

/**
 * Persist state immediately (used on shutdown or before reads that need durability).
 */
export async function flushApiKeys() {
    isDirty = true;
    const ok = await scheduleSave();
    if (!ok) {
        // Rethrow the original error so fs error codes (EACCES/ENOSPC/EIO)
        // survive for upstream classification (webui PATCH catch).
        throw lastSaveError ?? new Error('[ApiKeys] Failed to persist API keys state');
    }
}

/**
 * Get a key record by id.
 *
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getKeyById(id) {
    return state.keys.find(k => k.id === id);
}

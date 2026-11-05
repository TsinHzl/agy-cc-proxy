/**
 * Auto Model Routing — pure helpers
 *
 * The `auto` alias resolves to an ordered priority chain configured by the user
 * under `config.autoModel`. These helpers never import config.js and perform no
 * filesystem or network I/O, so they can be unit-tested without a running server
 * or a real user config file on disk. The only side effect is debug/warn logging
 * emitted by the normalizer.
 *
 * Chain resolution mirrors the routing layer: `MODEL_MAP` first, then the user's
 * `config.modelMapping`. `normalizeAutoChain` silently drops entries that resolve
 * back to `auto`, while `validateAutoModelConfig` rejects them so the write path
 * never stores a self-reference.
 */

import { MODEL_MAP, AUTO_MODEL_NAME, AUTO_MODEL_MAX_CHAIN } from '../constants.js';
import { logger } from '../utils/logger.js';

/** Keys that would mutate a plain object's prototype if used as a model id. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check whether a model name is the auto alias (case/whitespace insensitive).
 * @param {string} name - Model name from the request
 * @returns {boolean} True if this is the auto alias
 */
export function isAutoModel(name) {
    return String(name ?? '').trim().toLowerCase() === AUTO_MODEL_NAME;
}

/**
 * Resolve a model name through MODEL_MAP, then the user's modelMapping.
 * Same order as the routing layer, so chain entries behave like request models.
 *
 * @param {string} name - Model name to resolve
 * @param {Object} userMapping - config.modelMapping
 * @returns {string} Resolved model name
 */
export function resolveChainModel(name, userMapping = {}) {
    let resolved = typeof name === 'string' ? name.trim() : '';
    if (!resolved || UNSAFE_KEYS.has(resolved)) return '';

    if (Object.hasOwn(MODEL_MAP, resolved)) {
        const mapped = MODEL_MAP[resolved];
        if (typeof mapped === 'string' && mapped.trim()) {
            resolved = mapped.trim();
            if (UNSAFE_KEYS.has(resolved)) return '';
        }
    }

    if (userMapping && typeof userMapping === 'object' && Object.hasOwn(userMapping, resolved)) {
        const mapping = userMapping[resolved]?.mapping;
        if (typeof mapping === 'string' && mapping.trim()) {
            const next = mapping.trim();
            if (!UNSAFE_KEYS.has(next)) resolved = next;
        }
    }
    return resolved;
}

/**
 * Build the executable priority chain from config.autoModel.
 *
 * Runtime-tolerant: invalid entries are filtered (logged at debug), duplicates are
 * dropped keeping the highest priority, and the result is truncated to
 * AUTO_MODEL_MAX_CHAIN. `enabled !== true` yields an empty chain silently; a warn is
 * emitted only when enabled but the chain ends up empty.
 *
 * @param {Object} autoModelConfig - config.autoModel ({ enabled, models })
 * @param {Object} [userMapping] - config.modelMapping
 * @returns {string[]} Ordered model names, highest priority first
 */
export function normalizeAutoChain(autoModelConfig, userMapping = {}) {
    if (!autoModelConfig || autoModelConfig.enabled !== true) return [];

    const rawModels = Array.isArray(autoModelConfig.models) ? autoModelConfig.models : [];

    const candidates = [];
    for (const entry of rawModels) {
        const rawName = typeof entry?.model === 'string' ? entry.model.trim() : '';
        if (!rawName) {
            logger.debug('[AutoModel] Skipping entry with empty model name');
            continue;
        }
        const priority = Number(entry?.priority);
        if (!Number.isFinite(priority)) {
            logger.debug(`[AutoModel] Skipping entry with invalid priority: ${rawName}`);
            continue;
        }

        const resolved = resolveChainModel(rawName, userMapping);
        if (!resolved) {
            logger.debug(`[AutoModel] Skipping entry with unresolvable model: ${rawName}`);
            continue;
        }
        if (isAutoModel(resolved)) {
            logger.debug(`[AutoModel] Skipping self-referencing entry: ${rawName}`);
            continue;
        }

        candidates.push({ model: resolved, priority: Math.floor(priority) });
    }

    // Stable sort by ascending priority (ties keep configuration order).
    candidates.sort((a, b) => a.priority - b.priority);

    // Deduplicate on the resolved name, keeping the highest priority occurrence.
    const seen = new Set();
    const chain = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.model)) continue;
        seen.add(candidate.model);
        chain.push(candidate.model);
    }

    const truncated = chain.slice(0, AUTO_MODEL_MAX_CHAIN);
    if (chain.length > AUTO_MODEL_MAX_CHAIN) {
        logger.warn(
            `[AutoModel] Chain has ${chain.length} entries, truncating to ${AUTO_MODEL_MAX_CHAIN}`
        );
    }

    if (truncated.length === 0) {
        logger.warn('[AutoModel] Auto model routing is enabled but the chain resolves to empty');
    }

    return truncated;
}

/**
 * Strict validation for write paths (WebUI save, POST /api/config).
 *
 * Unlike normalizeAutoChain, this rejects instead of silently filtering, so the
 * user learns that their input was not accepted. `enabled: false` may carry an
 * empty chain or a populated one (configure now, enable later).
 *
 * @param {*} input - Candidate config.autoModel value
 * @param {Object} [userMapping] - config.modelMapping used to resolve duplicates
 * @returns {{ok: true, value: {enabled: boolean, models: Array<{model: string, priority: number}>}}
 *          | {ok: false, error: string}}
 */
export function validateAutoModelConfig(input, userMapping = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'autoModel must be an object' };
    }
    if (typeof input.enabled !== 'boolean') {
        return { ok: false, error: 'autoModel.enabled must be a boolean' };
    }

    const models = input.models;
    if (!Array.isArray(models)) {
        return { ok: false, error: 'autoModel.models must be an array' };
    }
    if (models.length > AUTO_MODEL_MAX_CHAIN) {
        return {
            ok: false,
            error: `autoModel.models must contain at most ${AUTO_MODEL_MAX_CHAIN} entries`
        };
    }
    if (input.enabled === true && models.length === 0) {
        return { ok: false, error: 'autoModel.models must not be empty when enabled' };
    }

    const seen = new Set();
    const normalized = [];
    for (let i = 0; i < models.length; i++) {
        const entry = models[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, error: `autoModel.models[${i}] must be an object` };
        }

        const rawName = typeof entry.model === 'string' ? entry.model.trim() : '';
        if (!rawName) {
            return { ok: false, error: `autoModel.models[${i}].model must be a non-empty string` };
        }
        if (isAutoModel(rawName)) {
            return {
                ok: false,
                error: `autoModel.models[${i}].model must not be "${AUTO_MODEL_NAME}"`
            };
        }

        const priority = Number(entry.priority);
        if (!Number.isInteger(priority) || priority < 1) {
            return {
                ok: false,
                error: `autoModel.models[${i}].priority must be a positive integer`
            };
        }

        const resolved = resolveChainModel(rawName, userMapping);
        if (!resolved) {
            return {
                ok: false,
                error: `autoModel.models[${i}].model is not an acceptable model name`
            };
        }
        if (isAutoModel(resolved)) {
            return {
                ok: false,
                error: `autoModel.models[${i}] resolves to "${AUTO_MODEL_NAME}" via model mapping`
            };
        }
        if (seen.has(resolved)) {
            return { ok: false, error: `autoModel.models[${i}] duplicates "${resolved}"` };
        }
        seen.add(resolved);

        normalized.push({ model: rawName, priority });
    }

    return { ok: true, value: { enabled: input.enabled, models: normalized } };
}

/**
 * Count accounts whose recorded quota-exhaustion limit is still active for a model.
 *
 * Reads live account state instead of a per-request set, so a limit cleared by
 * `clearExpiredLimits()` or `resetAllRateLimits()` can never keep signalling.
 *
 * @param {Array} accounts - Accounts to inspect (model-agnostic pool)
 * @param {string} modelId - Model to check limits for
 * @param {number} [now] - Injectable clock for tests
 * @returns {number} Number of accounts currently quota-exhausted for this model
 */
export function countActiveQuotaExhausted(accounts, modelId, now = Date.now()) {
    return accounts.filter(account => {
        const limit = account?.modelRateLimits?.[modelId];
        return limit?.isRateLimited === true
            && limit.reason === 'QUOTA_EXHAUSTED'
            && limit.resetTime > now;
    }).length;
}

/**
 * Decide whether a handler should surface an explicit quota-exhausted signal.
 *
 * Extracted as a pure function so the decision table is unit-testable without
 * network access or timers.
 *
 * @param {Object} params
 * @param {boolean} params.quotaSignal - Whether the caller opted into quota signalling
 * @param {number} params.quotaExhaustedCount - Accounts classified as quota-exhausted
 * @param {number} params.availableCount - Accounts still available for this model
 * @returns {boolean} True when the caller should throw QuotaExhaustedError
 */
export function shouldSignalQuotaExhaustion({ quotaSignal, quotaExhaustedCount, availableCount }) {
    return quotaSignal === true && quotaExhaustedCount > 0 && availableCount === 0;
}
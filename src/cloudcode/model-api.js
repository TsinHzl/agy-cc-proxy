/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    CLIENT_METADATA,
    getModelFamily,
    MODEL_VALIDATION_CACHE_TTL_MS
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { throttledFetch } from '../utils/helpers.js';

// Model validation cache
const modelCache = {
    validModels: new Set(),
    lastFetched: 0,
    fetchPromise: null  // Prevents concurrent fetches
};

/**
 * Check if a model is supported (Claude or Gemini)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    return family === 'claude' || family === 'gemini';
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    const modelList = Object.entries(data.models)
        .filter(([modelId]) => isSupportedModel(modelId))
        .map(([modelId, modelData]) => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: modelData.displayName || modelId
        }));

    // Warm the model validation cache
    modelCache.validModels = new Set(modelList.map(m => m.id));
    modelCache.lastFetched = Date.now();

    return {
        object: 'list',
        data: modelList
    };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token, projectId = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Include project ID in body for accurate quota info (per Quotio implementation)
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            return await response.json();
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                // When remainingFraction is missing but resetTime is present, quota is exhausted (0%)
                remainingFraction: modelData.quotaInfo.remainingFraction ?? (modelData.quotaInfo.resetTime ? 0 : null),
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }

    return quotas;
}

/**
 * Parse tier ID string to determine subscription level
 * @param {string} tierId - The tier ID from the API
 * @returns {'free' | 'pro' | 'ultra' | 'unknown'} The subscription tier
 */
export function parseTierId(tierId) {
    if (!tierId) return 'unknown';
    const lower = tierId.toLowerCase();

    if (lower.includes('ultra')) {
        return 'ultra';
    }
    if (lower === 'standard-tier') {
        // standard-tier = "Gemini Code Assist" (paid, project-based)
        return 'pro';
    }
    if (lower.includes('pro') || lower.includes('premium')) {
        return 'pro';
    }
    if (lower === 'free-tier' || lower.includes('free')) {
        return 'free';
    }
    return 'unknown';
}

/**
 * Get subscription tier for an account
 * Calls loadCodeAssist API to discover project ID and subscription tier
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>} Subscription tier (free/pro/ultra) and project ID
 */
export async function getSubscriptionTier(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            const data = await response.json();

            // Debug: Log all tier-related fields from the response
            logger.debug(`[CloudCode] loadCodeAssist tier data: paidTier=${JSON.stringify(data.paidTier)}, currentTier=${JSON.stringify(data.currentTier)}, allowedTiers=${JSON.stringify(data.allowedTiers?.map(t => ({ id: t?.id, isDefault: t?.isDefault })))}`);

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier
            // Priority: paidTier > currentTier > allowedTiers
            // - paidTier.id: "g1-pro-tier", "g1-ultra-tier" (Google One subscription)
            // - currentTier.id: "standard-tier" (pro), "free-tier" (free)
            // - allowedTiers: fallback when currentTier is missing
            // Note: paidTier is sometimes missing from the response even for Pro accounts
            let tier = 'unknown';
            let tierId = null;
            let tierSource = null;

            // 1. Check paidTier first (Google One AI subscription - most reliable)
            if (data.paidTier?.id) {
                tierId = data.paidTier.id;
                tier = parseTierId(tierId);
                tierSource = 'paidTier';
            }

            // 2. Fall back to currentTier if paidTier didn't give us a tier
            if (tier === 'unknown' && data.currentTier?.id) {
                tierId = data.currentTier.id;
                tier = parseTierId(tierId);
                tierSource = 'currentTier';
            }

            // 3. Fall back to allowedTiers (find the default or first non-free tier)
            if (tier === 'unknown' && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
                // First look for the default tier
                let defaultTier = data.allowedTiers.find(t => t?.isDefault);
                if (!defaultTier) {
                    defaultTier = data.allowedTiers[0];
                }
                if (defaultTier?.id) {
                    tierId = defaultTier.id;
                    tier = parseTierId(tierId);
                    tierSource = 'allowedTiers';
                }
            }

            logger.debug(`[CloudCode] Subscription detected: ${tier} (tierId: ${tierId}, source: ${tierSource}), Project: ${projectId}`);

            return { tier, projectId };
        } catch (error) {
            logger.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, error.message);
        }
    }

    // Fallback: return default values if all endpoints fail
    logger.warn('[CloudCode] Failed to detect subscription tier from all endpoints. Defaulting to free.');
    return { tier: 'free', projectId: null };
}

/**
 * Populate the model validation cache
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<void>}
 */
async function populateModelCache(token, projectId = null) {
    const now = Date.now();

    // Check if cache is fresh
    if (modelCache.validModels.size > 0 && (now - modelCache.lastFetched) < MODEL_VALIDATION_CACHE_TTL_MS) {
        return;
    }

    // If already fetching, wait for it
    if (modelCache.fetchPromise) {
        await modelCache.fetchPromise;
        return;
    }

    // Start fetch
    modelCache.fetchPromise = (async () => {
        try {
            const data = await fetchAvailableModels(token, projectId);
            if (data && data.models) {
                const validIds = Object.keys(data.models).filter(modelId => isSupportedModel(modelId));
                modelCache.validModels = new Set(validIds);
                modelCache.lastFetched = Date.now();
                logger.debug(`[CloudCode] Model cache populated with ${validIds.length} models`);
            }
        } catch (error) {
            logger.warn(`[CloudCode] Failed to populate model cache: ${error.message}`);
            // Don't throw - validation should degrade gracefully
        } finally {
            modelCache.fetchPromise = null;
        }
    })();

    await modelCache.fetchPromise;
}

/**
 * Check if a model ID is valid (exists in the available models list)
 * Uses a cached model list with TTL-based refresh
 * @param {string} modelId - Model ID to validate
 * @param {string} token - OAuth access token for cache population
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<boolean>} True if model is valid
 */
export async function isValidModel(modelId, token, projectId = null) {
    try {
        // Populate cache if needed
        await populateModelCache(token, projectId);

        // If cache is populated, validate against it
        if (modelCache.validModels.size > 0) {
            return modelCache.validModels.has(modelId);
        }

        // Cache empty (fetch failed) - fail open, let API validate
        return true;
    } catch (error) {
        logger.debug(`[CloudCode] Model validation error: ${error.message}`);
        // Fail open - let the API validate
        return true;
    }
}

/**
 * Find the best available model matching the requested model's tier.
 * Used to auto-map standard Anthropic model names (e.g. claude-opus-4-5,
 * claude-3-5-sonnet-20241022) to the closest available Google Cloud Code model.
 *
 * @param {string} modelId - Requested model ID
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<string|null>} Best available model ID, or null if none found
 */
async function findBestAvailableModel(modelId, token, projectId = null) {
    try {
        await populateModelCache(token, projectId);
        if (modelCache.validModels.size === 0) return null;

        const lower = modelId.toLowerCase();
        const family = getModelFamily(modelId);

        if (family === 'claude') {
            const claudeModels = Array.from(modelCache.validModels).filter(m => m.includes('claude'));
            if (claudeModels.length === 0) return null;

            if (lower.includes('opus')) {
                return claudeModels.find(m => m.includes('opus')) || claudeModels[0];
            }
            if (lower.includes('haiku')) {
                return claudeModels.find(m => m.includes('haiku'))
                    || claudeModels.find(m => m.includes('sonnet'))
                    || claudeModels[0];
            }
            // Default to sonnet tier
            return claudeModels.find(m => m.includes('sonnet')) || claudeModels[0];
        }

        if (family === 'gemini') {
            const geminiModels = Array.from(modelCache.validModels).filter(m => m.includes('gemini'));
            if (geminiModels.length === 0) return null;
            return geminiModels[0];
        }

        return null;
    } catch (error) {
        logger.debug(`[CloudCode] findBestAvailableModel error: ${error.message}`);
        return null;
    }
}

/**
 * Resolve a model ID to a valid available model.
 * If the requested model exists in the available list, returns it unchanged.
 * Otherwise, auto-maps standard Anthropic model names to the closest available
 * Google Cloud Code model (by family: opus/sonnet/haiku).
 *
 * This fixes the "INVALID_ARGUMENT" error that occurs when remote Claude Code
 * clients (e.g. Mac) use built-in default model names that don't exist in the
 * Google Cloud Code API, while Gemini models (explicitly configured) work fine.
 *
 * @param {string} modelId - Requested model ID
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<{resolved: string, autoMapped: boolean}>}
 */
export async function resolveModel(modelId, token, projectId = null) {
    try {
        await populateModelCache(token, projectId);

        // Model is directly valid — no remapping needed
        if (modelCache.validModels.size > 0 && modelCache.validModels.has(modelId)) {
            return { resolved: modelId, autoMapped: false };
        }

        // Cache empty — fail-open, skip remap so the API itself validates
        if (modelCache.validModels.size === 0) {
            return { resolved: modelId, autoMapped: false };
        }

        // Model not in cache — try to find the closest available alternative
        const best = await findBestAvailableModel(modelId, token, projectId);
        if (best) {
            return { resolved: best, autoMapped: true };
        }

        return { resolved: modelId, autoMapped: false };
    } catch (error) {
        logger.debug(`[CloudCode] resolveModel error: ${error.message}`);
        return { resolved: modelId, autoMapped: false };
    }
}

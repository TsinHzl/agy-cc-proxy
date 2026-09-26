/**
 * WebUI config validation (moved verbatim from webui/index.js).
 */

/**
 * Validate server config fields from user input.
 * Shared by POST /api/config and PATCH /api/server/presets/:name.
 * @param {Object} input - Raw config fields to validate
 * @returns {Object} Validated updates object (only valid fields included)
 */
export function validateConfigFields(input) {
    const updates = {};
    const { maxRetries, retryBaseMs, retryMaxMs, defaultCooldownMs, maxWaitBeforeErrorMs, maxAccounts, globalQuotaThreshold, accountSelection, rateLimitDedupWindowMs, maxConsecutiveFailures, extendedCooldownMs, maxCapacityRetries, switchAccountDelayMs, capacityBackoffTiersMs } = input;

    if (typeof maxRetries === 'number' && maxRetries >= 1 && maxRetries <= 20) {
        updates.maxRetries = maxRetries;
    }
    if (typeof retryBaseMs === 'number' && retryBaseMs >= 100 && retryBaseMs <= 10000) {
        updates.retryBaseMs = retryBaseMs;
    }
    if (typeof retryMaxMs === 'number' && retryMaxMs >= 1000 && retryMaxMs <= 120000) {
        updates.retryMaxMs = retryMaxMs;
    }
    if (typeof defaultCooldownMs === 'number' && defaultCooldownMs >= 1000 && defaultCooldownMs <= 300000) {
        updates.defaultCooldownMs = defaultCooldownMs;
    }
    if (typeof maxWaitBeforeErrorMs === 'number' && maxWaitBeforeErrorMs >= 0 && maxWaitBeforeErrorMs <= 600000) {
        updates.maxWaitBeforeErrorMs = maxWaitBeforeErrorMs;
    }
    if (typeof maxAccounts === 'number' && maxAccounts >= 1 && maxAccounts <= 100) {
        updates.maxAccounts = maxAccounts;
    }
    if (typeof globalQuotaThreshold === 'number' && globalQuotaThreshold >= 0 && globalQuotaThreshold < 1) {
        updates.globalQuotaThreshold = globalQuotaThreshold;
    }
    if (typeof rateLimitDedupWindowMs === 'number' && rateLimitDedupWindowMs >= 1000 && rateLimitDedupWindowMs <= 30000) {
        updates.rateLimitDedupWindowMs = rateLimitDedupWindowMs;
    }
    if (typeof maxConsecutiveFailures === 'number' && maxConsecutiveFailures >= 1 && maxConsecutiveFailures <= 10) {
        updates.maxConsecutiveFailures = maxConsecutiveFailures;
    }
    if (typeof extendedCooldownMs === 'number' && extendedCooldownMs >= 10000 && extendedCooldownMs <= 300000) {
        updates.extendedCooldownMs = extendedCooldownMs;
    }
    if (typeof maxCapacityRetries === 'number' && maxCapacityRetries >= 1 && maxCapacityRetries <= 10) {
        updates.maxCapacityRetries = maxCapacityRetries;
    }
    if (typeof switchAccountDelayMs === 'number' && switchAccountDelayMs >= 1000 && switchAccountDelayMs <= 60000) {
        updates.switchAccountDelayMs = switchAccountDelayMs;
    }
    if (Array.isArray(capacityBackoffTiersMs) && capacityBackoffTiersMs.length >= 1 && capacityBackoffTiersMs.length <= 10) {
        const allValid = capacityBackoffTiersMs.every(v => typeof v === 'number' && v >= 1000 && v <= 300000);
        if (allValid) {
            updates.capacityBackoffTiersMs = [...capacityBackoffTiersMs];
        }
    }
    // Account selection strategy and tuning validation
    if (accountSelection && typeof accountSelection === 'object') {
        const validStrategies = ['sticky', 'round-robin', 'hybrid'];
        const acctUpdate = {};

        if (accountSelection.strategy && validStrategies.includes(accountSelection.strategy)) {
            acctUpdate.strategy = accountSelection.strategy;
        }

        // Health score tuning
        if (accountSelection.healthScore && typeof accountSelection.healthScore === 'object') {
            const hs = accountSelection.healthScore;
            const hsUpdate = {};
            if (typeof hs.initial === 'number' && hs.initial >= 0 && hs.initial <= 100) hsUpdate.initial = hs.initial;
            if (typeof hs.successReward === 'number' && hs.successReward >= 0 && hs.successReward <= 20) hsUpdate.successReward = hs.successReward;
            if (typeof hs.rateLimitPenalty === 'number' && hs.rateLimitPenalty >= -50 && hs.rateLimitPenalty <= 0) hsUpdate.rateLimitPenalty = hs.rateLimitPenalty;
            if (typeof hs.failurePenalty === 'number' && hs.failurePenalty >= -50 && hs.failurePenalty <= 0) hsUpdate.failurePenalty = hs.failurePenalty;
            if (typeof hs.recoveryPerHour === 'number' && hs.recoveryPerHour >= 0 && hs.recoveryPerHour <= 20) hsUpdate.recoveryPerHour = hs.recoveryPerHour;
            if (typeof hs.minUsable === 'number' && hs.minUsable >= 0 && hs.minUsable <= 100) hsUpdate.minUsable = hs.minUsable;
            if (typeof hs.maxScore === 'number' && hs.maxScore >= 1 && hs.maxScore <= 200) hsUpdate.maxScore = hs.maxScore;
            if (Object.keys(hsUpdate).length > 0) acctUpdate.healthScore = hsUpdate;
        }

        // Token bucket tuning
        if (accountSelection.tokenBucket && typeof accountSelection.tokenBucket === 'object') {
            const tb = accountSelection.tokenBucket;
            const tbUpdate = {};
            if (typeof tb.maxTokens === 'number' && tb.maxTokens >= 5 && tb.maxTokens <= 200) tbUpdate.maxTokens = tb.maxTokens;
            if (typeof tb.tokensPerMinute === 'number' && tb.tokensPerMinute >= 1 && tb.tokensPerMinute <= 60) tbUpdate.tokensPerMinute = tb.tokensPerMinute;
            if (typeof tb.initialTokens === 'number' && tb.initialTokens >= 1 && tb.initialTokens <= 200) tbUpdate.initialTokens = tb.initialTokens;
            if (Object.keys(tbUpdate).length > 0) acctUpdate.tokenBucket = tbUpdate;
        }

        // Quota tuning
        if (accountSelection.quota && typeof accountSelection.quota === 'object') {
            const q = accountSelection.quota;
            const qUpdate = {};
            if (typeof q.lowThreshold === 'number' && q.lowThreshold >= 0 && q.lowThreshold < 1) qUpdate.lowThreshold = q.lowThreshold;
            if (typeof q.criticalThreshold === 'number' && q.criticalThreshold >= 0 && q.criticalThreshold < 1) qUpdate.criticalThreshold = q.criticalThreshold;
            if (typeof q.staleMs === 'number' && q.staleMs >= 30000 && q.staleMs <= 3600000) qUpdate.staleMs = q.staleMs;
            if (Object.keys(qUpdate).length > 0) acctUpdate.quota = qUpdate;
        }

        // Weights tuning
        if (accountSelection.weights && typeof accountSelection.weights === 'object') {
            const w = accountSelection.weights;
            const wUpdate = {};
            if (typeof w.health === 'number' && w.health >= 0 && w.health <= 20) wUpdate.health = w.health;
            if (typeof w.tokens === 'number' && w.tokens >= 0 && w.tokens <= 20) wUpdate.tokens = w.tokens;
            if (typeof w.quota === 'number' && w.quota >= 0 && w.quota <= 20) wUpdate.quota = w.quota;
            if (typeof w.lru === 'number' && w.lru >= 0 && w.lru <= 5) wUpdate.lru = w.lru;
            if (Object.keys(wUpdate).length > 0) acctUpdate.weights = wUpdate;
        }

        if (Object.keys(acctUpdate).length > 0) {
            updates.accountSelection = acctUpdate;
        }
    }

    return updates;
}

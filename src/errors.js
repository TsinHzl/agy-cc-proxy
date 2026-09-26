/**
 * Custom Error Classes
 *
 * Provides structured error types for better error handling and classification.
 * Replaces string-based error detection with proper error class checking.
 */

/**
 * Base error class for Antigravity proxy errors
 */
export class AntigravityError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} code - Error code for programmatic handling
     * @param {boolean} retryable - Whether the error is retryable
     * @param {Object} metadata - Additional error metadata
     */
    constructor(message, code, retryable = false, metadata = {}) {
        super(message);
        this.name = 'AntigravityError';
        this.code = code;
        this.retryable = retryable;
        this.metadata = metadata;
    }

    /**
     * Convert to JSON for API responses
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...this.metadata
        };
    }
}

/**
 * Rate limit error (429 / RESOURCE_EXHAUSTED)
 */
export class RateLimitError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {number|null} resetMs - Time in ms until rate limit resets
     * @param {string} accountEmail - Email of the rate-limited account
     */
    constructor(message, resetMs = null, accountEmail = null) {
        super(message, 'RATE_LIMITED', true, { resetMs, accountEmail });
        this.name = 'RateLimitError';
        this.resetMs = resetMs;
        this.accountEmail = accountEmail;
    }
}

/**
 * Authentication error (invalid credentials, token expired, etc.)
 */
export class AuthError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {string} accountEmail - Email of the account with auth issues
     * @param {string} reason - Specific reason for auth failure
     */
    constructor(message, accountEmail = null, reason = null) {
        super(message, 'AUTH_INVALID', false, { accountEmail, reason });
        this.name = 'AuthError';
        this.accountEmail = accountEmail;
        this.reason = reason;
    }
}

/**
 * Native module error (version mismatch, rebuild required)
 */
export class NativeModuleError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {boolean} rebuildSucceeded - Whether auto-rebuild succeeded
     * @param {boolean} restartRequired - Whether server restart is needed
     */
    constructor(message, rebuildSucceeded = false, restartRequired = false) {
        super(message, 'NATIVE_MODULE_ERROR', false, { rebuildSucceeded, restartRequired });
        this.name = 'NativeModuleError';
        this.rebuildSucceeded = rebuildSucceeded;
        this.restartRequired = restartRequired;
    }
}

/**
 * Empty response error - thrown when API returns no content
 * Used to trigger retry logic in streaming handler
 */
export class EmptyResponseError extends AntigravityError {
    /**
     * @param {string} message - Error message
     */
    constructor(message = 'No content received from API') {
        super(message, 'EMPTY_RESPONSE', true, {});
        this.name = 'EmptyResponseError';
    }
}

/**
 * Account forbidden error (403 VALIDATION_REQUIRED / PERMISSION_DENIED)
 * These are account-level errors where the account needs validation or has been
 * disabled. Trying different endpoints won't help - need to rotate to another account.
 */
export class AccountForbiddenError extends AntigravityError {
    /**
     * @param {string} message - Error message
     * @param {string} accountEmail - Email of the forbidden account
     */
    constructor(message, accountEmail = null) {
        super(message, 'ACCOUNT_FORBIDDEN', false, { accountEmail });
        this.name = 'AccountForbiddenError';
        this.accountEmail = accountEmail;
    }
}

/**
 * Check if an error is an account forbidden error (403 VALIDATION_REQUIRED / PERMISSION_DENIED)
 * These errors indicate the account itself is blocked and need account rotation, not endpoint rotation.
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isAccountForbiddenError(error) {
    if (error instanceof AccountForbiddenError) return true;
    // Fallback string check only for errors that couldn't use the typed class
    // (e.g., errors crossing module boundaries). Only match our own prefixed format.
    const msg = (error.message || '');
    return msg.startsWith('ACCOUNT_FORBIDDEN:');
}

/**
 * Check if an error is a rate limit error
 * Works with both custom error classes and legacy string-based errors
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isRateLimitError(error) {
    if (error instanceof RateLimitError) return true;
    const msg = (error.message || '').toLowerCase();
    return msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota_exhausted') ||
        msg.includes('rate limit');
}

/**
 * Check if an error is an authentication error
 * Works with both custom error classes and legacy string-based errors
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isAuthError(error) {
    if (error instanceof AuthError) return true;
    const msg = (error.message || '').toUpperCase();
    return msg.includes('AUTH_INVALID') ||
        msg.includes('INVALID_GRANT') ||
        msg.includes('TOKEN REFRESH FAILED');
}

/**
 * Check if an error is an empty response error
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
export function isEmptyResponseError(error) {
    return error instanceof EmptyResponseError ||
        error?.name === 'EmptyResponseError';
}

export default {
    AntigravityError,
    RateLimitError,
    AuthError,
    AccountForbiddenError,
    NativeModuleError,
    EmptyResponseError,
    isRateLimitError,
    isAuthError,
    isAccountForbiddenError,
    isEmptyResponseError
};

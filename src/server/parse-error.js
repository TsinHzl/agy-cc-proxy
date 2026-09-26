/**
 * Error parsing helpers (moved verbatim from src/server.js).
 * Maps upstream error messages to Anthropic-style error types, status codes,
 * user-friendly messages, and a Retry-After hint.
 */

import { MAX_RESET_CAP_MS } from '../cloudcode/rate-limit-parser.js';

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
export function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;
    let retryAfterMs = null;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('QUOTA_EXHAUSTED')) {
        // Preserve upstream 429 status so the client (Claude Code) backs off
        // and retries on its own instead of throwing "Prompt is too long".
        errorType = 'rate_limit_error';
        statusCode = 429;

        // Try to extract the quota reset time from the error
        const resetMatch = error.message.match(/quota will reset after ([\dh\dm\ds]+)/i);
        // Try to extract model from our error format "Rate limited on <model>" or JSON format.
        // Note: email / account / project identifiers are intentionally NOT included —
        // those leak internal pool state to the client.
        const modelMatch = error.message.match(/Rate limited on ([^.]+)\./) || error.message.match(/"model":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `RESOURCE_EXHAUSTED: You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
        // Surface a Retry-After header so clients back off intelligently
        // instead of tight-looping. Prefer the upstream reset hint, fall back
        // to a conservative 60s default. Cap at 5 minutes (matches
        // MAX_RESET_CAP_MS in rate-limit-parser.js) so downstream clients
        // (e.g. AIChatApp with a short retry budget) never receive a
        // multi-hour backoff hint.
        const parsedRetryAfterMs = parseResetDuration(resetMatch?.[1]);
        retryAfterMs = parsedRetryAfterMs !== null
            ? Math.min(parsedRetryAfterMs, MAX_RESET_CAP_MS)
            : 60000;
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = errorMessage;
    }

    return { errorType, statusCode, errorMessage, retryAfterMs };
}

/**
 * Parse a human duration string like "1h59m58s" / "4m59s" / "29m54s" into milliseconds.
 * Returns null if the string cannot be parsed.
 *
 * @param {string|undefined} raw
 * @returns {number|null}
 */
export function parseResetDuration(raw) {
    if (!raw) return null;
    let totalMs = 0;
    const re = /(\d+)\s*([hms])/gi;
    let matched = false;
    let m;
    while ((m = re.exec(raw)) !== null) {
        matched = true;
        const n = parseInt(m[1], 10);
        if (m[2].toLowerCase() === 'h') totalMs += n * 3600_000;
        else if (m[2].toLowerCase() === 'm') totalMs += n * 60_000;
        else totalMs += n * 1000;
    }
    if (!matched || !Number.isFinite(totalMs)) return null;
    // Defensive clamp: very large reset windows (or parseInt overflow past 2^53)
    // would make Retry-After header invalid (NaN) and cause Express to throw
    // ERR_INVALID_ARG_VALUE, turning a 429 into a 500. Cap at 24h.
    const MAX_MS = 24 * 3600_000;
    if (totalMs > MAX_MS) totalMs = MAX_MS;
    if (totalMs < 1000) totalMs = 1000;
    return totalMs;
}

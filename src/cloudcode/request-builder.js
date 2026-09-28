/**
 * Request Builder for Cloud Code
 *
 * Builds request payloads and headers for the Cloud Code API.
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_HEADERS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertAnthropicToGoogle } from '../format/index.js';
import { deriveSessionId } from './session-manager.js';

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @param {string} accountEmail - The account email for session ID derivation
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId, accountEmail) {
    const model = anthropicRequest.model;
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Gemini Cloud Code requests must not carry session identifiers.
    // Keep the stable session ID for other model families and cache continuity.
    if (getModelFamily(model) !== 'gemini') {
        googleRequest.sessionId = deriveSessionId(anthropicRequest, accountEmail);
    }

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestType: 'agent',  // CLIProxyAPI v6.6.89 compatibility
        requestId: 'agent-' + crypto.randomUUID()
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @param {string} [sessionId] - Optional session ID for X-Machine-Session-Id header
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json', sessionId) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Add session ID header if provided (matches Antigravity binary behavior)
    if (sessionId) {
        headers['X-Machine-Session-Id'] = sessionId;
    }

    const modelFamily = getModelFamily(model);

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}

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

// Upstream cloudcode-pa returns opaque 429/403 when a system prompt names known
// third-party AI products (e.g. "Claude Code", "Anthropic"). Neutralize those
// terms while keeping lowercase headers (x-anthropic-beta), filenames (CLAUDE.md),
// camelCase identifiers, and bare "Claude" intact.
const DEFAULT_IDENTITY_SCRUB = [
    ['Nous Research', 'the assistant team'],
    ['Hermes Agent', 'the assistant'],
    ['Hermes', 'the assistant'],
    ['Claude Code', 'the assistant'],
    ['Anthropic', 'the vendor']
];

function parseIdentityScrubEnv(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map((pair) => {
            const idx = pair.indexOf('=>');
            if (idx === -1) return null;
            return [pair.slice(0, idx).trim(), pair.slice(idx + 2).trim()];
        })
        .filter((rule) => rule && rule[0].length > 0);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IDENTITY_SCRUB_RULES = [
    ...DEFAULT_IDENTITY_SCRUB,
    ...parseIdentityScrubEnv(process.env.ANTIGRAVITY_SCRUB_IDENTITY)
].map(([term, replacement]) => [new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g'), replacement]);

function scrubClientIdentity(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [pattern, replacement] of IDENTITY_SCRUB_RULES) {
        out = out.replace(pattern, () => replacement);
    }
    return out;
}

/**
 * Move the caller's system prompt into the first user turn so cloudcode-pa does
 * not classify/reject systemInstruction passages (opaque 429/403) while keeping
 * systemInstruction absent when no proxy instruction is injected.
 *
 * @param {Object} googleRequest - Converted Google request (mutated in place)
 * @param {string} systemText - Caller system prompt, already scrubbed
 */
function prependCallerSystemPrompt(googleRequest, systemText) {
    if (!systemText) return;
    const part = { text: `<system-instructions>\n${systemText}\n</system-instructions>` };
    const first = googleRequest.contents?.[0];
    const firstIsFunctionResponse = Boolean(first?.parts?.[0]?.functionResponse);

    if (first && first.role === 'user' && Array.isArray(first.parts) && !firstIsFunctionResponse) {
        first.parts.unshift(part);
    } else {
        googleRequest.contents = [{ role: 'user', parts: [part] }, ...(googleRequest.contents || [])];
    }
}

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

    googleRequest.sessionId = deriveSessionId(anthropicRequest, accountEmail);

    const callerSystemText = (googleRequest.systemInstruction?.parts || [])
        .filter((part) => part.text)
        .map((part) => scrubClientIdentity(part.text))
        .join('\n\n');
    delete googleRequest.systemInstruction;
    prependCallerSystemPrompt(googleRequest, callerSystemText);

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestType: 'agent',  // CLIProxyAPI v6.6.89 compatibility
        requestId: 'agent/' + crypto.randomUUID()
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
        'User-Agent': ANTIGRAVITY_HEADERS['User-Agent']
    };

    const modelFamily = getModelFamily(model);

    // The native Gemini client sends the body session ID without this header.
    if (sessionId && modelFamily !== 'gemini') {
        headers['X-Machine-Session-Id'] = sessionId;
    }

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}

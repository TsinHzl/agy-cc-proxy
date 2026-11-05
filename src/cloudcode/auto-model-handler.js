/**
 * Auto Model Handler — priority-chain wrapper
 *
 * Walks the user-configured `autoModel.models` chain in priority order. Each model
 * is requested with `quotaSignal: true`, so the underlying handler reports genuine
 * quota exhaustion (classified from the upstream body) as a QuotaExhaustedError
 * instead of sleeping or collapsing into a generic failure. Any other error aborts
 * the chain immediately — only quota exhaustion causes a model switch.
 *
 * Streaming restriction: a switch is only possible before the first SSE event has
 * been yielded. Once the first event exists the routing layer has already flushed
 * headers, so a mid-stream failure is surfaced as an SSE error event instead of
 * concatenating two models' output.
 *
 * This module never calls `resetAllRateLimits()`: the handlers already clear expired
 * limits every iteration, and a global reset would defeat the single-flight probe
 * registry in rate-limit-state.js.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { EmptyResponseError, QuotaExhaustedError, isQuotaExhaustedError } from '../errors.js';
import { normalizeAutoChain } from './auto-model.js';
import { sendMessage as defaultSendMessage } from './message-handler.js';
import { sendMessageStream as defaultSendMessageStream } from './streaming-handler.js';

/**
 * Build the chain for the current config snapshot.
 * @returns {string[]} Ordered model names
 */
function currentChain() {
    return normalizeAutoChain(config.autoModel, config.modelMapping);
}

/**
 * Error used when auto is requested but not configured (or the chain resolves empty).
 * Shaped like an invalid_request_error so parseError maps it to HTTP 400.
 * @returns {Error}
 */
function notConfiguredError() {
    return new Error(
        'invalid_request_error: Auto model routing is not configured. ' +
        'Enable it and add at least one model in WebUI → Models.'
    );
}

/**
 * Send a non-streaming request through the auto chain.
 *
 * @param {Object} anthropicRequest - Anthropic-format request (model is replaced per chain entry)
 * @param {import('../account-manager/index.js').default} accountManager - Account manager
 * @param {Object|null} accountFilter - API key account binding ({ allowedEmails })
 * @param {Object} [options] - Extra handler options (e.g. emitUnsignedThinking)
 * @param {{ onModelResolved?: (model: string) => void, deps?: Object }} [hooks]
 * @returns {Promise<Object>} Anthropic-format response from the first model that succeeds
 * @throws {QuotaExhaustedError} When every model in the chain is quota-exhausted
 * @throws {Error} For any non-quota error (aborts the chain immediately)
 */
export async function sendMessageAuto(anthropicRequest, accountManager, accountFilter = null, options = {}, hooks = {}) {
    const chain = currentChain();
    if (chain.length === 0) throw notConfiguredError();

    const sendMessage = hooks.deps?.sendMessage || defaultSendMessage;
    const onModelResolved = hooks.onModelResolved;

    for (const model of chain) {
        try {
            const response = await sendMessage(
                { ...anthropicRequest, model },
                accountManager,
                false,               // auto owns ordering; never delegate to MODEL_FALLBACK_MAP
                accountFilter,
                { ...options, quotaSignal: true }
            );
            // Only report success — a failed model must not be recorded as the executed one.
            if (typeof onModelResolved === 'function') onModelResolved(model);
            return response;
        } catch (error) {
            if (!isQuotaExhaustedError(error)) throw error;
            logger.warn(`[Auto] ${model} quota exhausted → trying next model in chain`);
        }
    }

    // Every entry either returned or threw; reaching here means all of them were
    // quota-exhausted.
    throw new QuotaExhaustedError(
        `RESOURCE_EXHAUSTED: Rate limited on ${chain[chain.length - 1]}. ` +
        `Auto chain exhausted (${chain.length} model${chain.length === 1 ? '' : 's'}).`
    );
}

/**
 * Stream a request through the auto chain.
 *
 * The first event is pulled before yielding anything: if that call rejects with a
 * quota error the chain advances, and if the generator ends without producing an
 * event the model is treated as failed so the client never receives an empty 200.
 *
 * @param {Object} anthropicRequest - Anthropic-format request
 * @param {import('../account-manager/index.js').default} accountManager - Account manager
 * @param {Object|null} accountFilter - API key account binding
 * @param {Object} [streamOptions] - Extra stream options (thinkingAsText, isClaudeCode, isCancelled)
 * @param {{ onModelResolved?: (model: string) => void, deps?: Object }} [hooks]
 * @yields {Object} Anthropic-format SSE events
 * @throws {QuotaExhaustedError} When every model in the chain is quota-exhausted
 */
export async function* sendMessageStreamAuto(anthropicRequest, accountManager, accountFilter = null, streamOptions = {}, hooks = {}) {
    const chain = currentChain();
    if (chain.length === 0) throw notConfiguredError();

    const sendMessageStream = hooks.deps?.sendMessageStream || defaultSendMessageStream;
    const onModelResolved = hooks.onModelResolved;
    const isCancelled = streamOptions?.isCancelled;
    let lastQuotaError = null;

    for (const model of chain) {
        // Stop the chain when the client has already gone away.
        if (typeof isCancelled === 'function' && isCancelled()) {
            logger.info(`[Auto] Client disconnected before ${model}, aborting chain`);
            return;
        }

        const generator = sendMessageStream(
            { ...anthropicRequest, model },
            accountManager,
            false,                   // auto owns ordering; never delegate to MODEL_FALLBACK_MAP
            accountFilter,
            { ...streamOptions, quotaSignal: true }
        );

        let first;
        try {
            first = await generator.next();
        } catch (error) {
            if (!isQuotaExhaustedError(error)) throw error;
            lastQuotaError = error;
            logger.warn(`[Auto] ${model} quota exhausted before first event → trying next model in chain`);
            continue;
        }

        // A generator that ends without yielding anything is a failure, not a success:
        // yielding nothing here would leave the routing layer with an empty 200.
        if (first.done) {
            logger.warn(`[Auto] ${model} produced no events → trying next model in chain`);
            continue;
        }

        if (typeof onModelResolved === 'function') onModelResolved(model);
        try {
            yield first.value;
            // From here on the first event is already written; mid-stream errors
            // are surfaced through the normal SSE error path by the caller.
            yield* generator;
        } finally {
            // Finalize the inner generator when the consumer aborts early (client
            // disconnect / for-await break). `yield*` forwards return() itself, but
            // a throw at the first yield would otherwise leave it suspended.
            if (typeof generator.return === 'function') {
                try { await generator.return(); } catch { /* already finalized */ }
            }
        }
        return;
    }

    if (lastQuotaError) {
        throw new QuotaExhaustedError(
            `RESOURCE_EXHAUSTED: Rate limited on ${chain[chain.length - 1]}. ` +
            `Auto chain exhausted (${chain.length} model${chain.length === 1 ? '' : 's'}).`
        );
    }
    // No model yielded a single event: an empty 200 would look like a valid answer.
    throw new EmptyResponseError(
        `Auto chain produced no response (${chain.length} model${chain.length === 1 ? '' : 's'})`
    );
}
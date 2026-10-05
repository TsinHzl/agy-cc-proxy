import { MIN_SIGNATURE_LENGTH } from '../constants.js';
import { logger } from '../utils/logger.js';

export const MAX_THINKING_TEXT_BLOCK_BYTES = 256 * 1024;
export const MAX_THINKING_TEXT_RESPONSE_BYTES = 1024 * 1024;

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const THINKING_TEXT_MARKER = '⁣agy-thinking-text-v1⁣';
const THINKING_TEXT_PREFIX = `${ANSI_DIM}> 💭 Thinking${THINKING_TEXT_MARKER}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(THINKING_TEXT_PREFIX)}\\n?(?:> [^\\r\\n]*(?:\\r?\\n|(?=${escapeRegExp(ANSI_RESET)})))*${escapeRegExp(ANSI_RESET)}`,
    'g'
);

export function shouldRenderThinkingAsText(options) {
    return options?.thinkingAsText === true && options?.isClaudeCode === true;
}

export function formatThinkingAsText(thinking) {
    if (!thinking) return null;

    const quotedThinking = thinking
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    return `${THINKING_TEXT_PREFIX}\n${quotedThinking}${ANSI_RESET}`;
}

export function stripThinkingTextHistory(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map((message) => {
        if (message?.role !== 'assistant') return message;

        if (typeof message.content === 'string') {
            return { ...message, content: message.content.replace(THINKING_TEXT_BLOCK_RE, '') };
        }

        if (!Array.isArray(message.content)) return message;

        const content = message.content.flatMap((block) => {
            if (block?.type !== 'text' || typeof block.text !== 'string') return [block];
            const text = block.text.replace(THINKING_TEXT_BLOCK_RE, '');
            return text ? [{ ...block, text }] : [];
        });
        return { ...message, content };
    });
}

function isThinkingStart(event) {
    return event.type === 'content_block_start' && event.content_block?.type === 'thinking';
}

function isMatchingThinkingDelta(event, index) {
    return event.type === 'content_block_delta' &&
        event.index === index &&
        event.delta?.type === 'thinking_delta';
}

function isMatchingSignatureDelta(event, index) {
    return event.type === 'content_block_delta' &&
        event.index === index &&
        event.delta?.type === 'signature_delta';
}

function isMatchingStop(event, index) {
    return event.type === 'content_block_stop' && event.index === index;
}

/**
 * Converts valid Anthropic thinking event blocks to Claude Code text blocks.
 * The upstream streamer is responsible for pairing thought text and signatures
 * before this transformer sees the events.
 *
 * @param {AsyncIterable<Object>} events - Anthropic-format SSE events
 * @param {{thinkingAsText?: boolean, isClaudeCode?: boolean}|null} options
 * @yields {Object} Anthropic-format SSE events
 */
export async function* transformThinkingAsTextEvents(events, options) {
    if (!shouldRenderThinkingAsText(options)) {
        yield* events;
        return;
    }

    let pendingBlock = null;
    let responseThinkingBytes = 0;
    let responseLimitExceeded = false;

    const textDeltaEvent = (index, text) => ({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
    });

    // Emit buffered complete lines as they arrive so the thinking text streams
    // out incrementally instead of appearing all at once at content_block_stop.
    // The content_block_start is emitted lazily with the first line so deltas
    // never precede their block start.
    const flushCompleteLines = function* (block) {
        let newlineIndex;
        while ((newlineIndex = block.pending.indexOf('\n')) !== -1) {
            const line = block.pending.slice(0, newlineIndex).replace(/\r$/, '');
            block.pending = block.pending.slice(newlineIndex + 1);
            if (!block.started) {
                block.started = true;
                yield {
                    type: 'content_block_start',
                    index: block.index,
                    content_block: { type: 'text', text: '' }
                };
            }
            const prefix = block.firstChunk ? THINKING_TEXT_PREFIX : '';
            block.firstChunk = false;
            yield textDeltaEvent(block.index, `${prefix}> ${line}\n`);
        }
    };

    const discardPendingBlock = (reason) => {
        if (!pendingBlock || pendingBlock.discarded) return;
        logger.warn(`[CloudCode] Dropping thinking text block index=${pendingBlock.index} reason=${reason} blockBytes=${pendingBlock.bytes} responseBytes=${responseThinkingBytes}`);
        pendingBlock.thinking = '';
        pendingBlock.pending = '';
        pendingBlock.discarded = true;
    };

    try {
        for await (const event of events) {
            if (pendingBlock) {
                if (isMatchingThinkingDelta(event, pendingBlock.index)) {
                    const thinkingDelta = event.delta.thinking || '';
                    const deltaBytes = Buffer.byteLength(thinkingDelta, 'utf8');
                    responseThinkingBytes += deltaBytes;

                    if (responseThinkingBytes > MAX_THINKING_TEXT_RESPONSE_BYTES) {
                        responseLimitExceeded = true;
                        discardPendingBlock('response_limit');
                    } else if (pendingBlock.bytes + deltaBytes > MAX_THINKING_TEXT_BLOCK_BYTES) {
                        discardPendingBlock('block_limit');
                    } else if (!pendingBlock.discarded) {
                        pendingBlock.thinking += thinkingDelta;
                        pendingBlock.bytes += deltaBytes;
                        pendingBlock.pending += thinkingDelta;
                        yield* flushCompleteLines(pendingBlock);
                        if (responseThinkingBytes === MAX_THINKING_TEXT_RESPONSE_BYTES) {
                            responseLimitExceeded = true;
                        }
                    }
                    continue;
                }

                if (isMatchingSignatureDelta(event, pendingBlock.index)) {
                    if (typeof event.delta.signature === 'string' && event.delta.signature.length >= MIN_SIGNATURE_LENGTH) {
                        pendingBlock.signature = event.delta.signature;
                    }
                    continue;
                }

                if (isMatchingStop(event, pendingBlock.index)) {
                    if (!pendingBlock.discarded && pendingBlock.thinking) {
                        // Emit the trailing (still incomplete) line, then the ANSI reset.
                        // A single-line thinking (no newline seen) still carries the prefix
                        // here so THINKING_TEXT_BLOCK_RE can strip it from history.
                        const tail = pendingBlock.pending
                            ? `${pendingBlock.firstChunk ? THINKING_TEXT_PREFIX : ''}> ${pendingBlock.pending.replace(/\r$/, '')}\n`
                            : '';
                        if (!pendingBlock.started) {
                            yield {
                                type: 'content_block_start',
                                index: pendingBlock.index,
                                content_block: { type: 'text', text: '' }
                            };
                            pendingBlock.started = true;
                        }
                        yield textDeltaEvent(pendingBlock.index, `${tail}${ANSI_RESET}`);
                        yield event;
                    } else if (pendingBlock.started) {
                        // Partially streamed block got discarded (block/response limit) —
                        // it must still be closed with a reset and its stop event.
                        yield textDeltaEvent(pendingBlock.index, ANSI_RESET);
                        yield event;
                    }
                    pendingBlock = null;
                    continue;
                }

                pendingBlock = null;
            }

            if (isThinkingStart(event)) {
                pendingBlock = {
                    index: event.index,
                    thinking: '',
                    pending: '',
                    firstChunk: true,
                    started: false,
                    signature: '',
                    bytes: 0,
                    discarded: responseLimitExceeded
                };
                if (responseLimitExceeded) {
                    discardPendingBlock('response_limit');
                }
                continue;
            }

            yield event;
        }
    } finally {
        pendingBlock = null;
        responseThinkingBytes = 0;
        responseLimitExceeded = false;
    }
}

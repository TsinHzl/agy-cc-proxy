import { MIN_SIGNATURE_LENGTH } from '../constants.js';
import { logger } from '../utils/logger.js';

export const MAX_THINKING_TEXT_BLOCK_BYTES = 256 * 1024;
export const MAX_THINKING_TEXT_RESPONSE_BYTES = 1024 * 1024;

const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
// Style matches kiro2cc-proxy thinking_text.rs except without blockquote
// markers: dim wraps each line individually and resets before every newline
// so styling never spans lines. No `> ` prefix — Claude Code would render a
// left quote bar for it.
const THINKING_TEXT_HEADER_LINE = `${ANSI_DIM}💭 Thinking${ANSI_RESET}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each rendered line is `\n...RESET` — matching up to RESET (rather than to
// end-of-line) keeps trailing text on the same line (e.g. the final answer)
// from being swallowed when the block no longer ends with a newline.
const THINKING_TEXT_LINE_RE = `\\n[^\\n]*?${escapeRegExp(ANSI_RESET)}`;
const THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(THINKING_TEXT_HEADER_LINE)}(?:${THINKING_TEXT_LINE_RE})*`,
    'g'
);
// Legacy marker-prefixed format (whole-block dim + invisible marker) kept so
// history rendered by older versions is still stripped from conversations.
const LEGACY_THINKING_TEXT_PREFIX = `${ANSI_DIM}> 💭 Thinking⁣agy-thinking-text-v1⁣`;
const LEGACY_THINKING_TEXT_BLOCK_RE = new RegExp(
    `${escapeRegExp(LEGACY_THINKING_TEXT_PREFIX)}\\n?(?:> [^\\r\\n]*(?:\\r?\\n|(?=${escapeRegExp(ANSI_RESET)})))*${escapeRegExp(ANSI_RESET)}`,
    'g'
);

export function shouldRenderThinkingAsText(options) {
    return options?.thinkingAsText === true && options?.isClaudeCode === true;
}

export function formatThinkingAsText(thinking) {
    if (!thinking) return null;

    const quotedThinking = thinking
        .replace(/\r\n?/g, '\n')
        // Trailing newlines would render an empty blockquote line (the stray
        // extra segment of the left quote bar), so drop them.
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line)
        .map((line) => `${ANSI_DIM}${line}${ANSI_RESET}`)
        .join('\n');
    // No trailing newline: a block-ending '\n' makes Claude Code render one
    // blockquote line more than the text (matches kiro2cc-proxy thinking_text.rs).
    if (!quotedThinking) return THINKING_TEXT_HEADER_LINE;
    return `${THINKING_TEXT_HEADER_LINE}\n${quotedThinking}`;
}

export function stripThinkingTextHistory(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map((message) => {
        if (message?.role !== 'assistant') return message;

        if (typeof message.content === 'string') {
            return {
                ...message,
                content: message.content
                    .replace(THINKING_TEXT_BLOCK_RE, '')
                    .replace(LEGACY_THINKING_TEXT_BLOCK_RE, '')
            };
        }

        if (!Array.isArray(message.content)) return message;

        const content = message.content.flatMap((block) => {
            if (block?.type !== 'text' || typeof block.text !== 'string') return [block];
            const text = block.text
                .replace(THINKING_TEXT_BLOCK_RE, '')
                .replace(LEGACY_THINKING_TEXT_BLOCK_RE, '');
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
            const line = block.pending.slice(0, newlineIndex).replace(/\r$/, '').trim();
            block.pending = block.pending.slice(newlineIndex + 1);
            // Skip blank lines: an empty quote line renders as a stray extra
            // segment of the left blockquote bar in Claude Code.
            if (!line) continue;
            if (!block.started) {
                block.started = true;
                yield {
                    type: 'content_block_start',
                    index: block.index,
                    content_block: { type: 'text', text: '' }
                };
            }
            if (block.firstChunk) {
                block.firstChunk = false;
                yield textDeltaEvent(block.index, THINKING_TEXT_HEADER_LINE);
            }
            // Newline leads the next line instead of trailing the previous one,
            // so the block never ends with '\n' (an extra empty blockquote line
            // rendering as a stray segment of the left quote bar) — kiro style.
            yield textDeltaEvent(block.index, `\n${ANSI_DIM}${line}${ANSI_RESET}`);
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
                        // Newline leads, never trails; blank lines are skipped so
                        // the block ends right after ANSI_RESET with no extra
                        // empty quote line.
                        const lastLine = pendingBlock.pending.replace(/\r$/, '').trim();
                        const tail = lastLine
                            ? `${pendingBlock.firstChunk ? THINKING_TEXT_HEADER_LINE : ''}\n${ANSI_DIM}${lastLine}${ANSI_RESET}`
                            : '';
                        // Whitespace-only block with nothing emitted: skip the
                        // stop event too, so the client never sees an orphan
                        // content_block_stop without its content_block_start.
                        // Whitespace-only block with nothing emitted: skip the
                        // stop event too, so the client never sees an orphan
                        // content_block_stop without its content_block_start.
                        if (pendingBlock.started || tail) {
                            pendingBlock.firstChunk = false;
                            if (!pendingBlock.started) {
                                yield {
                                    type: 'content_block_start',
                                    index: pendingBlock.index,
                                    content_block: { type: 'text', text: '' }
                                };
                                pendingBlock.started = true;
                            }
                            if (tail) yield textDeltaEvent(pendingBlock.index, tail);
                            yield event;
                        }
                    } else if (pendingBlock.started) {
                        // Partially streamed block got discarded (block/response limit) —
                        // lines already end with resets; just close with its stop event.
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

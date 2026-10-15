/**
 * OpenAI Chat Completions compat layer — pure conversion functions.
 *
 * Request side:  OpenAI chat.completion request -> internal Anthropic Messages
 * representation (feeds the existing Cloud Code pipeline unchanged).
 * Response side: internal Anthropic response / SSE event stream -> OpenAI
 * chat.completion JSON / chat.completion.chunk sequence.
 *
 * Pure functions only (no Express, no I/O) so they can be unit-tested
 * without a server (tests/test-openai-converter.cjs).
 */

import crypto from 'crypto';

const SUPPORTED_IMAGE_DATA_PREFIX = 'data:';

/**
 * Validate OpenAI request parameters we do not support.
 * Throws Error with `statusCode` attached; the route layer maps it to an
 * OpenAI error envelope.
 * @param {Object} body
 */
export function validateOpenAIRequest(body) {
    if (!body || typeof body !== 'object') {
        throw badRequest('Request body must be a JSON object');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw badRequest('messages must be a non-empty array');
    }
    if (!body.messages.every(m => m && typeof m === 'object' && typeof m.role === 'string')) {
        throw badRequest('each message must be an object with a string role');
    }
    if (body.n !== undefined && body.n !== null && body.n !== 1) {
        throw badRequest('n > 1 is not supported');
    }
    // logit_bias is a token-id -> bias object per the OpenAI spec (never an array)
    if (body.logprobs || (body.logit_bias && typeof body.logit_bias === 'object' && Object.keys(body.logit_bias).length)) {
        throw badRequest('logprobs/logit_bias are not supported');
    }
    // JSON mode clients parse the response as JSON — fail fast instead of
    // silently returning plain text that breaks their parser. Some legacy
    // SDKs/gateways send response_format as a bare string, handle both.
    const responseType = typeof body.response_format === 'string'
        ? body.response_format
        : body.response_format?.type;
    if (responseType === 'json_object' || responseType === 'json_schema') {
        throw badRequest('response_format JSON mode is not supported');
    }
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    if (maxTokens !== undefined && maxTokens !== null
        && (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0)) {
        throw badRequest('max_tokens must be a positive number');
    }
}

function badRequest(message) {
    const err = new Error(`invalid_request_error: ${message}`);
    err.statusCode = 400;
    err.errorType = 'invalid_request_error';
    return err;
}

/**
 * Extract system prompt from OpenAI system/developer role messages into
 * the Anthropic `system` string.
 * @param {Array} messages OpenAI messages
 * @returns {string|undefined}
 */
export function extractSystem(messages) {
    const parts = [];
    for (const msg of messages) {
        if (msg.role === 'system' || msg.role === 'developer') {
            parts.push(contentToText(msg.content));
        }
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Convert OpenAI chat messages to Anthropic messages.
 * - system/developer messages are dropped here (handled by extractSystem)
 * - assistant messages with tool_calls become tool_use content blocks
 * - role:"tool" messages become user messages with a tool_result block
 * @param {Array} messages OpenAI messages
 * @returns {Array} Anthropic-format messages
 */
export function convertMessages(messages) {
    const out = [];
    for (const msg of messages) {
        if (msg.role === 'system' || msg.role === 'developer') continue;

        if (msg.role === 'tool') {
            // OpenAI tool result -> user message with tool_result block
            out.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: msg.tool_call_id,
                    content: contentToText(msg.content)
                }]
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const blocks = [];
            const text = contentToText(msg.content);
            if (text) blocks.push({ type: 'text', text });
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    let args = {};
                    try {
                        args = tc.function?.arguments
                            ? JSON.parse(tc.function.arguments)
                            : {};
                    } catch {
                        args = { _raw: tc.function?.arguments || '' };
                    }
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id || `toolu_${crypto.randomUUID()}`,
                        name: tc.function?.name || '',
                        input: args
                    });
                }
            }
            if (blocks.length) {
                out.push({ role: 'assistant', content: blocks });
            }
            continue;
        }

        // user message
        out.push({
            role: 'user',
            content: convertUserContent(msg.content)
        });
    }
    return out;
}

/**
 * Convert OpenAI user content (string | parts array) to Anthropic content.
 * Text parts -> text blocks; image_url data URLs -> image blocks.
 * http(s) image URLs are passed through as url source blocks — downstream
 * content-converter applies the same handling/rejection as /v1/messages.
 */
export function convertUserContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content ?? '');

    const blocks = [];
    for (const part of content) {
        if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            if (url.startsWith(SUPPORTED_IMAGE_DATA_PREFIX)) {
                const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
                if (!match) continue;
                const mediaType = match[1] || 'image/png';
                const isBase64 = !!match[2];
                const data = isBase64 ? match[3] : Buffer.from(match[3], 'binary').toString('base64');
                blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
            } else if (/^https?:\/\//.test(url)) {
                blocks.push({ type: 'image', source: { type: 'url', url } });
            }
            // other protocols silently dropped (parity with unsupported parts)
        }
    }
    return blocks.length ? blocks : '';
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === 'text')
            .map(p => p.text || '')
            .join('\n');
    }
    return String(content ?? '');
}

/**
 * Convert OpenAI tools + tool_choice to Anthropic format.
 * tools: [{type:'function', function:{name, description, parameters}}]
 *   -> [{name, description, input_schema}]
 * tool_choice: "auto"|"none"|"required"|{type:'function',function:{name}}
 *   -> {type:'auto'} | undefined | {type:'any'} | {type:'tool', name}
 */
export function convertTools(body) {
    const tools = Array.isArray(body.tools)
        ? body.tools
              .filter(t => t?.type === 'function' && t.function?.name)
              .map(t => ({
                  name: t.function.name,
                  description: t.function.description || '',
                  input_schema: t.function.parameters || { type: 'object', properties: {} }
              }))
        : undefined;

    let toolChoice;
    switch (body.tool_choice) {
        case undefined:
        case null:
        case 'auto':
            toolChoice = tools ? { type: 'auto' } : undefined;
            break;
        case 'none':
            toolChoice = undefined;
            break;
        case 'required':
            toolChoice = { type: 'any' };
            break;
        default:
            if (body.tool_choice?.type === 'function' && body.tool_choice.function?.name) {
                toolChoice = { type: 'tool', name: body.tool_choice.function.name };
            } else {
                toolChoice = { type: 'auto' };
            }
    }

    return { tools, toolChoice };
}

/**
 * Full request conversion: OpenAI chat.completion body -> Anthropic request.
 * @param {Object} body
 * @param {string} resolvedModel post-auto-map model name
 * @returns {Object} Anthropic request for sendMessage/sendMessageStream
 */
export function convertOpenAIRequest(body, resolvedModel) {
    validateOpenAIRequest(body);
    const messages = convertMessages(body.messages || []);
    const { tools, toolChoice } = convertTools(body);

    const request = {
        model: resolvedModel,
        messages,
        max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
        stream: body.stream === true,
        temperature: body.temperature ?? undefined,
        top_p: body.top_p ?? undefined
    };
    if (body.stop) {
        request.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }
    const system = extractSystem(body.messages || []);
    if (system) request.system = system;
    if (tools) request.tools = tools;
    if (toolChoice) request.tool_choice = toolChoice;
    return request;
}

// ---------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    max_tokens: 'length'
};

/**
 * Map an Anthropic stop_reason to an OpenAI finish_reason.
 * @param {string|undefined} stopReason
 * @returns {string}
 */
export function mapFinishReason(stopReason) {
    if (!stopReason) return 'stop';
    return FINISH_REASON_MAP[stopReason] || 'stop';
}

/**
 * Convert internal Anthropic response to OpenAI chat.completion object.
 * Thinking blocks are dropped; tool_use blocks become tool_calls;
 * cache_read tokens are counted into prompt_tokens (usage-stats parity).
 * @param {Object} anthropicResponse
 * @param {string} requestedModel the model name the client asked for
 * @returns {Object} chat.completion
 */
export function convertResponse(anthropicResponse, requestedModel) {
    const content = Array.isArray(anthropicResponse?.content) ? anthropicResponse.content : [];
    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
        if (block.type === 'text') {
            textParts.push(block.text || '');
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {})
                }
            });
        }
        // thinking blocks intentionally dropped (no reasoning passthrough)
    }

    const message = { role: 'assistant', content: textParts.join('') || null };
    if (toolCalls.length) {
        message.tool_calls = toolCalls;
    }

    const u = anthropicResponse?.usage || {};
    const usage = {
        prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0),
        completion_tokens: u.output_tokens || 0,
        total_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0)
    };

    return {
        id: anthropicResponse?.id || `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor((anthropicResponse?._createdAt || Date.now()) / 1000),
        model: requestedModel,
        choices: [{
            index: 0,
            message,
            finish_reason: mapFinishReason(anthropicResponse?.stop_reason)
        }],
        usage
    };
}

// ---------------------------------------------------------------------------
// Streaming conversion (state machine over Anthropic SSE events)
// ---------------------------------------------------------------------------

/**
 * Create a chunk-stream state machine.
 * Feed it Anthropic SSE events (message_start, content_block_start,
 * content_block_delta, message_delta, message_stop); it returns an array of
 * OpenAI chat.completion.chunk objects per event (empty array when nothing to
 * emit, e.g. thinking deltas). `finalize()` returns the closing chunks.
 *
 * @param {string} requestedModel model name the client asked for
 * @param {string} id completion id shared by all chunks
 */
export function createChunkStream(requestedModel, id = `chatcmpl-${crypto.randomUUID()}`) {
    const created = Math.floor(Date.now() / 1000);
    let roleSent = false;
    let blockIndex = -1;          // index of current Anthropic content block
    let toolSlotCounter = 0;      // OpenAI tool_calls array index
    const toolSlotsByBlock = new Map(); // anthropic block index -> openai tool index
    let finishReason = null;
    let usage = null;
    let stopped = false;

    const chunk = (delta, extra = {}) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [{ index: 0, delta, finish_reason: null, ...extra }]
    });

    return {
        /**
         * Feed one Anthropic SSE event; returns array of OpenAI chunks to emit.
         * @param {Object} event
         * @returns {Array<Object>}
         */
        feed(event) {
            if (stopped) return [];
            const out = [];

            switch (event.type) {
                case 'message_start': {
                    if (!roleSent) {
                        roleSent = true;
                        out.push(chunk({ role: 'assistant', content: '' }));
                    }
                    if (event.message?.usage) {
                        usage = {
                            prompt_tokens: (event.message.usage.input_tokens || 0)
                                + (event.message.usage.cache_read_input_tokens || 0),
                            completion_tokens: 0
                        };
                    }
                    break;
                }

                case 'content_block_start': {
                    blockIndex = event.index ?? blockIndex;
                    const cb = event.content_block || {};
                    if (cb.type === 'tool_use') {
                        const toolIndex = toolSlotCounter++;
                        toolSlotsByBlock.set(blockIndex, toolIndex);
                        out.push(chunk({
                            tool_calls: [{
                                index: toolIndex,
                                id: cb.id,
                                type: 'function',
                                function: { name: cb.name, arguments: '' }
                            }]
                        }));
                    }
                    // text blocks need no start chunk (deltas carry content)
                    break;
                }

                case 'content_block_delta': {
                    const delta = event.delta || {};
                    if (delta.type === 'text_delta' && delta.text) {
                        if (!roleSent) {
                            roleSent = true;
                            out.push(chunk({ role: 'assistant', content: '' }));
                        }
                        out.push(chunk({ content: delta.text }));
                    } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                        const toolIndex = toolSlotsByBlock.get(event.index ?? blockIndex);
                        if (toolIndex !== undefined) {
                            out.push(chunk({
                                tool_calls: [{
                                    index: toolIndex,
                                    function: { arguments: delta.partial_json }
                                }]
                            }));
                        }
                    }
                    // thinking_delta / signature_delta silently dropped
                    break;
                }

                case 'message_delta': {
                    if (event.delta?.stop_reason) {
                        finishReason = mapFinishReason(event.delta.stop_reason);
                    }
                    if (event.usage) {
                        usage = usage || { prompt_tokens: 0, completion_tokens: 0 };
                        usage.completion_tokens = event.usage.output_tokens || 0;
                    }
                    break;
                }

                case 'message_stop':
                    // nothing — finalize() emits the closing chunks
                    break;

                case 'error':
                    out.push({
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: requestedModel,
                        choices: [{ index: 0, delta: {}, finish_reason: null }],
                        error: {
                            type: event.error?.type || 'server_error',
                            message: event.error?.message || 'Upstream error'
                        }
                    });
                    stopped = true;
                    break;
            }
            return out;
        },

        /**
         * Closing chunks: final usage + finish_reason chunk, then [DONE] marker.
         * @returns {Array<Object|string>} chunks plus the literal '[DONE]' sentinel
         */
        finalize() {
            if (stopped) return ['[DONE]'];
            stopped = true;
            const out = [];
            if (usage) {
                const usageChunk = chunk({}, {
                    finish_reason: finishReason || 'stop'
                });
                usageChunk.usage = {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.prompt_tokens + usage.completion_tokens
                };
                out.push(usageChunk);
            } else {
                out.push(chunk({}, { finish_reason: finishReason || 'stop' }));
            }
            out.push('[DONE]');
            return out;
        }
    };
}

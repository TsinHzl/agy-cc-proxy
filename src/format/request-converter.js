/**
 * Detect whether the current request originates from Claude Code's `/compact`
 * command. Two independent signals are checked and ANY positive match flips
 * the flag, so we tolerate future CC releases that change either signature:
 *   1. System prompt anchor strings that CC injects when compact fires.
 *   2. User message text starting with `/compact` (manual invocation).
 *
 * False positives are harmless (worst case: thinking is disabled for that
 * turn); false negatives reproduce the original bug
 * (`summarization produced empty response`).
 *
 * @param {Array<string|Object>|string|undefined} system
 * @param {Array<Object>} [messages] - conversation messages for second signal
 * @returns {boolean}
 */
export function isCompactRequest(system, messages) {
    const matchesAnchor = (text) =>
        typeof text === 'string' && (
            text.includes('Respond as helpfully as possible, but be very careful to ensure you do not reproduce any copyrighted material') ||
            text.includes('You are a Claude agent, built on Anthropic')
        );

    if (system) {
        const blocks = Array.isArray(system) ? system : [system];
        for (const block of blocks) {
            const text = typeof block === 'string' ? block : block?.text;
            if (matchesAnchor(text)) return true;
        }
    }

    if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 3); i--) {
            const msg = messages[i];
            if (msg?.role !== 'user') continue;
            const content = msg.content;
            if (typeof content === 'string') {
                if (content.trim().startsWith('/compact')) return true;
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().startsWith('/compact')) return true;
                }
            }
        }
    }

    return false;
}

/**
 * Request Converter
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
    CLAUDE_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import { sanitizeSchema, cleanSchema } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    hasGeminiHistory,
    hasUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking,
    cleanCacheControl,
    clampGeminiThinkingBudget
} from './thinking-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 *
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 *
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    // [CRITICAL FIX] Pre-clean all cache_control fields from messages (Issue #189)
    // Claude Code CLI sends cache_control on various content blocks, but Cloud Code API
    // rejects them with "Extra inputs are not permitted". Clean them proactively here
    // before any other processing, following the pattern from Antigravity-Manager.
    const messages = cleanCacheControl(anthropicRequest.messages || []);

    const { system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);
    // Detect Claude Code's `/compact` summarisation requests. For these we
    // keep thinking enabled (Cloud Code rejects `thinkingCfg=none` for Gemini 3
    // with HTTP 429 — production logs, Aug 2026) and enlarge max_tokens so the
    // summary fits after the thinking block. Without the enlarge, thinking
    // consumes the entire output budget and the summarisation text comes back
    // empty, causing
    // "Prompt is too long · automatic compaction failed:
    //  summarization produced empty response".
    const isCompact = isCompactRequest(system, messages);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && isThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    // Gemini needs recovery for tool loops/interrupted tools (stripped thinking)
    let processedMessages = messages;

    if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(messages, 'gemini');
    }

    // For Claude: apply recovery for cross-model (Gemini→Claude) or unsigned thinking blocks
    // Unsigned thinking blocks occur when Claude Code strips signatures it doesn't understand
    const needsClaudeRecovery = hasGeminiHistory(messages) || hasUnsignedThinkingBlocks(messages);
    if (isClaudeModel && isThinking && needsClaudeRecovery && needsThinkingRecovery(messages)) {
        logger.debug('[RequestConverter] Applying thinking recovery for Claude');
        processedMessages = closeToolLoopForThinking(messages, 'claude');
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (const msg of processedMessages) {
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        // SAFETY: Google API requires at least one part per content message
        // This happens when all thinking blocks are filtered out (unsigned)
        if (parts.length === 0) {
            // Use '.' instead of '' because claude models reject empty text parts.
            // A single period is invisible in practice but satisfies the API requirement.
            logger.warn('[RequestConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '.' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Reserve 16K tokens for the summary text on top of the thinking budget.
    // The summary must fit inside maxOutputTokens AFTER the thinking block is
    // accounted for; otherwise thinking eats the whole output and the
    // summarisation returns empty — CC then reports "summarization produced
    // empty response" and auto-compact fails.
    const COMPACT_SUMMARY_RESERVE = 16384;
    // Resolve the thinking budget up-front so the Gemini cap below can see it.
    let resolvedThinkingBudget = null;
    if (isThinking) {
        if (isClaudeModel) {
            resolvedThinkingBudget = thinking?.budget_tokens || 32000;
        } else if (isGeminiModel) {
            resolvedThinkingBudget = clampGeminiThinkingBudget(modelName, thinking?.budget_tokens);
        }
    }

    // Enable thinking for thinking models (Claude and Gemini 3+).
    //
    // Why we DO NOT strip thinking for `/compact` requests: production logs
    // (Aug 2026) show Cloud Code API rejects `thinkingCfg=none` for Gemini 3
    // with HTTP 429 RESOURCE_EXHAUSTED across all accounts. The fix is to keep
    // thinking enabled and instead enlarge max_tokens so the summary fits
    // after the thinking block.
    if (isThinking) {
        const thinkingBudget = resolvedThinkingBudget;

        // Compute the desired max_tokens for this request, including the
        // compact-summary reserve when applicable.
        let desiredMaxTokens = googleRequest.generationConfig.maxOutputTokens
            || (isCompact ? 16384 : 0);
        if (isCompact && thinkingBudget) {
            const compactMaxTokens = thinkingBudget + COMPACT_SUMMARY_RESERVE;
            if (desiredMaxTokens < compactMaxTokens) {
                logger.debug(`[RequestConverter] Boosting max_tokens for /compact: ${desiredMaxTokens} → ${compactMaxTokens} (thinkingBudget=${thinkingBudget} + ${COMPACT_SUMMARY_RESERVE} summary)`);
                desiredMaxTokens = compactMaxTokens;
            }
        }
        googleRequest.generationConfig.maxOutputTokens = desiredMaxTokens;

        // Build the thinking config and apply.
        if (isClaudeModel) {
            const thinkingConfig = {
                include_thoughts: true,
                thinking_budget: thinkingBudget
            };
            logger.debug(`[RequestConverter] Claude thinking enabled with budget: ${thinkingBudget}${!thinking?.budget_tokens ? ' (default)' : ''}`);

            // Validate max_tokens > thinking_budget as required by the API
            const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens;
            if (currentMaxTokens && currentMaxTokens <= thinkingBudget) {
                const adjustedMaxTokens = thinkingBudget + 8192;
                if (thinking?.budget_tokens) {
                    logger.warn(`[RequestConverter] max_tokens (${currentMaxTokens}) <= thinking_budget (${thinkingBudget}). Adjusting to ${adjustedMaxTokens} to satisfy API requirements`);
                } else {
                    logger.debug(`[RequestConverter] Adjusting max_tokens to ${adjustedMaxTokens} for default thinking budget`);
                }
                googleRequest.generationConfig.maxOutputTokens = adjustedMaxTokens;
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget
            };
            logger.debug(`[RequestConverter] Gemini thinking enabled with budget: ${thinkingBudget}`);

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            // Sanitize schema for general compatibility
            let parameters = sanitizeSchema(schema);

            // Apply Google-format cleaning for ALL models since they all go through
            // Cloud Code API which validates schemas using Google's protobuf format.
            // This fixes issue #82: /compact command fails with schema transformation error
            // "Proto field is not repeating, cannot start list" for Claude models.
            parameters = cleanSchema(parameters);

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        logger.debug(`[RequestConverter] Tools: ${JSON.stringify(googleRequest.tools).substring(0, 300)}`);

        // For Claude models, set functionCallingConfig.mode = "VALIDATED"
        // This ensures strict parameter validation (matches opencode-antigravity-auth)
        if (isClaudeModel) {
            googleRequest.toolConfig = {
                functionCallingConfig: {
                    mode: 'VALIDATED'
                }
            };
        }
    }

    // Cap max tokens for Gemini models
    // For `/compact` requests, the cap must scale with the thinking budget so
    // the summary always retains its 16K reserve. If we used a fixed 32K cap
    // a `thinkingBudget` ≥ 16K would silently eat the summary budget back to
    // a few thousand tokens — exactly the bug we are fixing.
    const geminiCap = (isCompact && typeof resolvedThinkingBudget === 'number')
        ? Math.max(GEMINI_MAX_OUTPUT_TOKENS, resolvedThinkingBudget + COMPACT_SUMMARY_RESERVE)
        : GEMINI_MAX_OUTPUT_TOKENS;
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > geminiCap) {
        logger.debug(`[RequestConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${geminiCap}${isCompact ? ' (compact)' : ''}`);
        googleRequest.generationConfig.maxOutputTokens = geminiCap;
    }

    // Cap max tokens for Claude models — Cloud Code API rejects requests > 64K for Claude
    if (isClaudeModel && googleRequest.generationConfig.maxOutputTokens > CLAUDE_MAX_OUTPUT_TOKENS) {
        logger.debug(`[RequestConverter] Capping Claude max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${CLAUDE_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = CLAUDE_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}

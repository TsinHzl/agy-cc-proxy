/**
 * Detect whether the current request originates from Claude Code's `/compact`
 * command or the autocompact flow. Multiple independent signals are checked
 * and ANY positive match flips the flag:
 *   1. System prompt anchor strings that CC injects (older CLI versions).
 *   2. User message text starting with `/compact` (manual invocation).
 *   3. User message containing CC's compact-summarization prompt
 *      (`CRITICAL: Respond with TEXT ONLY...create a detailed summary
 *       of this conversation`). This is the reactive-compact prompt used
 *      by CC v2.1+ for both manual and auto compaction.
 *   4. `x-stainless-helper: compaction` header (set by CC's compact client).
 *
 * False positives are harmless (worst case: thinking is disabled for that
 * turn); false negatives reproduce the original bug
 * (`summarization produced empty response`).
 *
 * @param {Array<string|Object>|string|undefined} system
 * @param {Array<Object>} [messages] - conversation messages for second signal
 * @param {Object} [req] - the full Anthropic-format request (for headers, optional)
 * @returns {boolean}
 */
export function isCompactRequest(system, messages, req) {
    const matchesAnchor = (text) =>
        typeof text === 'string' && (
            text.includes('Respond as helpfully as possible, but be very careful to ensure you do not reproduce any copyrighted material') ||
            text.includes('You are a Claude agent, built on Anthropic')
        );

    // Reactive-compact signature — CC v2.1+ autocompact / manual /compact sends
    // a synthesised summarisation prompt as a user message. Production logs
    // (Aug 2026) showed the exact two strings we matched on are reliably
    // present, but the prompt may be split across content blocks or interleaved
    // with bookkeeping tokens.
    //
    // This function is called from checkText() per text/string block, so it
    // does NOT need to recurse into tool_use / image blocks (those never
    // contain the prompt). Two match tiers:
    //   Tier 1 (canonical) — both anchors present in the SAME text block.
    //   Tier 2 (split) — single canonical anchor + a paired CC-specific
    //     marker, to avoid false positives on user prompts that happen to
    //     say "create a detailed summary" without being a /compact request.
    const matchesReactivePrompt = (text) => {
        if (typeof text !== 'string') return false;
        // Normalise to lowercase once — CC's reactive-compact prompt uses
        // inconsistent casing across versions ("Do NOT" vs "do NOT", "TEXT
        // ONLY" vs "Text Only"). We must not require exact casing.
        const lower = text.toLowerCase();
        const hasCritical = lower.includes('critical: respond with text only');
        const hasDetailed = lower.includes('create a detailed summary of this conversation');
        if (hasCritical && hasDetailed) return true;          // Tier 1: canonical pair
        if (hasCritical && lower.includes('do not call any tools')) return true;  // Tier 2: split
        if (hasDetailed && lower.includes('<analysis>') && lower.includes('<summary>')) return true; // Tier 2: split
        return false;
    };

    if (system) {
        const blocks = Array.isArray(system) ? system : [system];
        for (const block of blocks) {
            const text = typeof block === 'string' ? block : block?.text;
            if (matchesAnchor(text)) return true;
        }
    }

    if (Array.isArray(messages)) {
        // Search the full message history, not just the last 3 — CC may inject
        // a trailing token-count label (`<total_tokens>...`) after the compact
        // prompt, pushing the actual prompt out of the last-3 window.
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.role !== 'user') continue;
            const content = msg.content;
            const checkText = (text) => {
                if (typeof text !== 'string') return false;
                const t = text.trim();
                if (t.startsWith('/compact')) return true;
                return matchesReactivePrompt(text);
            };
            if (typeof content === 'string') {
                if (checkText(content)) return true;
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block?.type === 'text' && checkText(block.text)) return true;
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
    // Debug log so production incidents can verify the detector matched.
    // Also logs the negative case so we can rule out a missed detection.
    // Capture up to 6 trailing user-message snippets so we can locate the
    // compact prompt when CC interleaves its own bookkeeping messages
    // (e.g. `<total_tokens>...`) after the prompt.
    const systemStr = typeof system === 'string' ? system : JSON.stringify(system);
    const userTextSnippets = (Array.isArray(messages) && messages.length > 0)
        ? (() => {
            const out = [];
            // Walk ALL messages (any role) so we can locate the compact
            // prompt even if CC put it in an assistant block or interleaved
            // its bookkeeping messages. Cap at 12 snippets × 250 chars.
            for (let i = messages.length - 1; i >= 0 && out.length < 12; i--) {
                const m = messages[i];
                const c = m?.content;
                let txt;
                if (typeof c === 'string') txt = c;
                else if (Array.isArray(c)) {
                    txt = (c.find(b => b?.type === 'text')?.text) || '';
                }
                out.push(`${m?.role || '?'}[${i}]="${(txt || '').slice(0, 250)}"`);
            }
            return out.length ? out.join(' | ') : '(no msgs)';
        })()
        : '(no messages)';
    const roleHistogram = (Array.isArray(messages) && messages.length > 0)
        ? (() => {
            const h = {};
            for (const m of messages) {
                const r = m?.role || '?';
                h[r] = (h[r] || 0) + 1;
            }
            return Object.entries(h).map(([k, v]) => `${k}=${v}`).join(',');
        })()
        : '(empty)';
    const hasCopyrightAnchor = systemStr.includes('do not reproduce any copyrighted material');
    const hasClaudeAgentAnchor = systemStr.includes('You are a Claude agent, built on Anthropic');
    // Reactive-compact signature lives in the LAST user message, not the system
    // prompt. Scan system + all-message text together so the diagnostic
    // reflects whether EITHER location contains the signature (production
    // logs previously only scanned systemStr, masking real matches in messages).
    // IMPORTANT: the extraction must mirror isCompactRequest()'s scan path —
    // it walks every text block inside `content` arrays (not just the first
    // one), because CC splits reactive-compact prompts across multiple
    // text blocks. Mismatch would reproduce the v2.7.19 false-negative bug.
    const collectMessageText = (m) => {
        const c = m?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.filter(b => b?.type === 'text').map(b => b.text || '').join(' ');
        return '';
    };
    const allMessagesText = (Array.isArray(messages) ? messages : []).map(collectMessageText).join(' ');
    const diagScanText = `${systemStr} ${allMessagesText}`;
    // Same split-pair logic as isCompactRequest's matchesReactivePrompt — see
    // tier-1/tier-2 doc comment above. Keeping the diagnostic aligned with
    // the function prevents "log says false, function says true" gaps.
    const diagLower = diagScanText.toLowerCase();
    const hasCritical = diagLower.includes('critical: respond with text only');
    const hasDetailed = diagLower.includes('create a detailed summary of this conversation');
    const hasReactivePromptAnchor = (hasCritical && hasDetailed) ||
                                    (hasCritical && diagLower.includes('do not call any tools')) ||
                                    (hasDetailed && diagLower.includes('<analysis>') && diagLower.includes('<summary>'));
    // hasCompactedKeyword stays scoped to systemStr only — scanning all
    // message text would spam DIAG-DUMP for any conversation that ever
    // mentioned the word "compacted".
    const hasCompactedKeyword = systemStr.includes('compacted') || systemStr.includes('Compacted') || systemStr.includes('compaction');
    // Narrow DIAG-DUMP trigger: only when the request LOOKS like a compact
    // attempt (system contains "compacted"/"compaction", or there is a
    // `<system-reminder>` / `<token_count>` tag) but our detector didn't
    // match. This avoids spamming normal requests.
    const looksLikeCompact = hasCompactedKeyword || systemStr.includes('<system-reminder>') || systemStr.includes('<token_count>');
    logger.debug(`[RequestConverter] /compact detection: isCompact=${isCompact} model=${modelName} thinkingBudget(anthropic)=${thinking?.budget_tokens ?? 'unset'} systemLen=${systemStr.length} msgCount=${Array.isArray(messages) ? messages.length : 0} roles=${roleHistogram} hasCopyright=${hasCopyrightAnchor} hasClaudeAgent=${hasClaudeAgentAnchor} hasReactivePrompt=${hasReactivePromptAnchor} hasCompactedKeyword=${hasCompactedKeyword} userSnippets=${userTextSnippets}`);
    if (!isCompact && looksLikeCompact) {
        // Targeted DIAG-DUMP — find where the compact prompt lives.
        const sysHead = systemStr.slice(0, 1500);
        const sysTail = systemStr.length > 2000 ? systemStr.slice(-800) : '';
        const msgDump = (Array.isArray(messages) ? messages : []).map((m, idx) => {
            const c = m?.content;
            let txt;
            if (typeof c === 'string') txt = c;
            else if (Array.isArray(c)) txt = (c.find(b => b?.type === 'text')?.text) || '';
            else txt = JSON.stringify(c || '');
            return `m[${idx}|${m?.role}]="${txt.slice(0, 120)}"`;
        }).join(' || ');
        logger.debug(`[RequestConverter] DIAG-DUMP sysHead="${sysHead}" sysTail="${sysTail}" allMsgs=${msgDump}`);
    }

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

    // For Claude: apply recovery for cross-model (Gemini→Claude) or unsigned thinking blocks
    // Unsigned thinking blocks occur when Claude Code strips signatures it doesn't understand.
    // Note: Gemini models do NOT need closeToolLoopForThinking in tool loops because content-converter
    // automatically restores thoughtSignatures from cache or falls back to GEMINI_SKIP_SIGNATURE.
    let processedMessages = messages;
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

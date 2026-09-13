/**
 * Response Converter
 * Converts Google Generative AI responses to Anthropic Messages API format
 */

import crypto from 'crypto';
import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { cacheSignature, cacheThinkingSignature } from './signature-cache.js';
import { isWebSearchResult, buildWebSearchBlocks, extractSearchQuery, extractGroundingContexts } from './search-blocks.js';

/**
 * Convert Google Generative AI response to Anthropic Messages API format
 *
 * @param {Object} googleResponse - Google format response (the inner response object)
 * @param {string} model - The model name used
 * @returns {Object} Anthropic format response
 */
export function convertGoogleToAnthropic(googleResponse, model) {
    // Handle the response wrapper
    const response = googleResponse.response || googleResponse;

    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];
    // Read grounding metadata from both legal positions: the content level and
    // the candidate level. Verified live (WS-DIAG): Antigravity v1internal
    // emits it on candidates[0] on the final chunk, with the content level
    // always empty — but the API spec keeps content-level valid, so prefer it
    // if non-empty. An empty-object content-level value must not short-circuit
    // the candidate level.
    const contentGm = content.groundingMetadata;
    const candGm = firstCandidate.groundingMetadata;
    const groundingMeta =
        (contentGm && Object.keys(contentGm).length > 0) ? contentGm :
        (candGm && Object.keys(candGm).length > 0) ? candGm : {};

    // Anthropic content blocks
    const anthropicContent = [];
    let hasToolCalls = false;
    let hasServerTool = false;
    // CC renders "Did N searches" from usage.server_tool_use.web_search_requests
    // (verified in CC's cli.js: webSearchRequests += usage.server_tool_use?.
    // web_search_requests ?? 0). Each completed web_search use/result pair we
    // emit is one search — count them so CC doesn't show "Did 0 searches" and
    // the model second-guesses its own real grounding results.
    let webSearchCount = 0;

    for (const part of parts) {
        if (part.thought === true && part.text !== undefined) {
            // Handle thinking blocks
            const signature = part.thoughtSignature || '';

            // Cache thinking signature with model family for cross-model compatibility
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                const modelFamily = getModelFamily(model);
                cacheThinkingSignature(signature, modelFamily);
            }

            // Include thinking blocks in the response for Claude Code
            anthropicContent.push({
                type: 'thinking',
                thinking: part.text,
                signature: signature
            });
        } else if (part.text !== undefined) {
            anthropicContent.push({
                type: 'text',
                text: part.text
            });
        } else if (isWebSearchResult(part)) {
            // A googleSearch functionCall (or a search-shaped agent/dynamicRetrieval
            // call) is the backend's way of reporting a completed web search using the
            // Gemini google_search tool. Lift the sibling intent_entry + grounding
            // metadata into CC's web_search server result so the search is counted.
            const entrance = part?.groundingMetadata?.searchEntryPoint?.renderedContent?.searchIntent?.entrance ?? null;
            const contexts = extractGroundingContexts(part, entrance);
            const toolId = part?.functionCall?.id || null;
            // Prefer the query argument when the model supplied one; otherwise use
            // the first grounded chunk's title as the recorded query for reliability.
            const recordedQuery = extractSearchQuery(part, null) || contexts[0]?.title || '';
            anthropicContent.push(...buildWebSearchBlocks(toolId, recordedQuery, contexts, entrance));
            hasServerTool = true;
            webSearchCount++;
        } else if (part?.type === 'server_tool_use' || part?.type === 'web_search_tool_result') {
            // Pre-built web_search server-tool blocks (pushed as a use/result pair
            // by sse-parser's thinking-model accumulation path) are already in
            // Anthropic shape — pass them through untouched; re-normalizing here
            // would strip the pairing. Count them so stop_reason resolves to
            // tool_use instead of end_turn.
            anthropicContent.push(part);
            hasServerTool = true;
            if (part.type === 'server_tool_use') webSearchCount++;
        } else if (part.functionCall) {
            // Convert functionCall to tool_use
            // Use the id from the response if available, otherwise generate one
            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: part.functionCall.args || {}
            };

            // For Gemini 3+, include thoughtSignature from the part level
            if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = part.thoughtSignature;
                // Cache for future requests (Claude Code may strip this field)
                cacheSignature(toolId, part.thoughtSignature);
            }

            anthropicContent.push(toolUseBlock);
            hasToolCalls = true;
        } else if (part.inlineData) {
            // Handle image content from Google format
            anthropicContent.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: part.inlineData.mimeType,
                    data: part.inlineData.data
                }
            });
        }
    }

    // A grounding intent announced at the content level (some backends surface
    // groundingMetadata on content while the model emits only a text part) is
    // still a successful web search — count it even with no functionCall.
    if (!hasServerTool && groundingMeta?.searchEntryPoint) {
        const entrance = groundingMeta.searchEntryPoint?.renderedContent?.searchIntent?.entrance ?? null;
        const contexts = extractGroundingContexts({ groundingMetadata: groundingMeta }, entrance);
        const recordedQuery = contexts[0]?.title || entrance || '';
        anthropicContent.push(...buildWebSearchBlocks(null, recordedQuery, contexts, entrance));
        hasServerTool = true;
        webSearchCount++;
    }

    // Determine stop reason. Tool presence wins over a plain STOP finish:
    // the streaming path (sse-streamer) forces stopReason='tool_use' as soon
    // as it emits a functionCall or web_search pair, so the non-streaming
    // path must agree — a STOP-only early return would mark a turn that ends
    // in tool calls as end_turn.
    const finishReason = firstCandidate.finishReason;
    let stopReason = 'end_turn';
    if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'TOOL_USE' || hasToolCalls || hasServerTool) {
        stopReason = 'tool_use';
    }

    // Extract usage metadata
    // Note: Antigravity's promptTokenCount is the TOTAL (includes cached),
    // but Anthropic's input_tokens excludes cached. We subtract to match.
    const usageMetadata = response.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: promptTokens - cachedTokens,
            output_tokens: usageMetadata.candidatesTokenCount || 0,
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0,
            ...(webSearchCount > 0 ? { server_tool_use: { web_search_requests: webSearchCount } } : {})
        }
    };
}

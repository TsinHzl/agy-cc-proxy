/**
 * SSE Parser for Cloud Code
 *
 * Parses SSE responses for non-streaming thinking models.
 * Accumulates all parts and returns a single response.
 */

import { convertGoogleToAnthropic } from '../format/index.js';
import {
    isWebSearchResult,
    buildWebSearchBlocks,
    extractSearchQuery,
    extractGroundingContexts
} from '../format/search-blocks.js';
import { logger } from '../utils/logger.js';

/**
 * Parse SSE response for thinking models and accumulate all parts
 *
 * @param {Response} response - The HTTP response with SSE body
 * @param {string} originalModel - The original model name
 * @returns {Promise<Object>} Anthropic-format response object
 */
export async function parseThinkingSSEResponse(response, originalModel) {
    let accumulatedThinkingText = '';
    let accumulatedThinkingSignature = '';
    let accumulatedText = '';
    const finalParts = [];
    let usageMetadata = {};
    let finishReason = 'STOP';

    const flushThinking = () => {
        if (accumulatedThinkingText) {
            finalParts.push({
                thought: true,
                text: accumulatedThinkingText,
                thoughtSignature: accumulatedThinkingSignature
            });
            accumulatedThinkingText = '';
            accumulatedThinkingSignature = '';
        }
    };

    const flushText = () => {
        if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
            accumulatedText = '';
        }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                if (innerResponse.usageMetadata) {
                    usageMetadata = innerResponse.usageMetadata;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                if (firstCandidate.finishReason) {
                    finishReason = firstCandidate.finishReason;
                }

                const parts = firstCandidate.content?.parts || [];
                const groundingMeta = firstCandidate.content?.groundingMetadata || {};
                for (const part of parts) {
                    if (part.thought === true) {
                        flushText();
                        accumulatedThinkingText += (part.text || '');
                        if (part.thoughtSignature) {
                            accumulatedThinkingSignature = part.thoughtSignature;
                        }
                    } else if (isWebSearchResult(part)) {
                        // Backend completed a web search (googleSearch functionCall
                        // and/or grounding metadata). Encode it as CC's web_search
                        // server result so the search is counted.
                        flushThinking();
                        flushText();
                        const entrance = part?.groundingMetadata?.searchEntryPoint?.renderedContent?.searchIntent?.entrance ?? null;
                        const query = extractSearchQuery(part, entrance);
                        const contexts = extractGroundingContexts(part, entrance);
                        const toolId = part?.functionCall?.id || null;
                        // Prefer the query argument when the model supplied one; otherwise
                        // use the first grounded chunk's title as the recorded query.
                        const recordedQuery = query || contexts[0]?.title || '';
                        finalParts.push(...buildWebSearchBlocks(toolId, recordedQuery, contexts, entrance));
                    } else if (part.functionCall) {
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    } else if (part.text !== undefined) {
                        if (!part.text) continue;
                        flushThinking();
                        accumulatedText += part.text;
                    } else if (part.inlineData) {
                        // Handle image content
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    }
                }

                // A grounding intent announced at the content level (no per-part
                // functionCall) is still a successful web search. Note: the
                // search blocks are pushed as a use/result PAIR — the guard must
                // check for the paired `server_tool_use` block, not a bare
                // `server_tool` envelope.
                if (groundingMeta?.searchEntryPoint && !finalParts.some(p => p?.type === 'server_tool_use')) {
                    const entrance = groundingMeta.searchEntryPoint?.renderedContent?.searchIntent?.entrance ?? null;
                    const contexts = extractGroundingContexts({ groundingMetadata: groundingMeta }, entrance);
                    const recordedQuery = contexts[0]?.title || entrance || '';
                    finalParts.push(...buildWebSearchBlocks(null, recordedQuery, contexts, entrance));
                }
            } catch (e) {
                logger.debug('[CloudCode] SSE parse warning:', e.message, 'Raw:', jsonText.slice(0, 100));
            }
        }
    }

    flushThinking();
    flushText();

    const accumulatedResponse = {
        candidates: [{ content: { parts: finalParts }, finishReason }],
        usageMetadata
    };

    const partTypes = finalParts.map(p => p.thought ? 'thought' : (p.functionCall ? 'functionCall' : (p.inlineData ? 'inlineData' : 'text')));
    logger.debug('[CloudCode] Response received (SSE), part types:', partTypes);
    if (finalParts.some(p => p.thought)) {
        const thinkingPart = finalParts.find(p => p.thought);
        logger.debug('[CloudCode] Thinking signature length:', thinkingPart?.thoughtSignature?.length || 0);
    }

    return convertGoogleToAnthropic(accumulatedResponse, originalModel);
}

/**
 * Shared web_search / Google-Search grounding conversion helpers.
 *
 * Both response paths (non-streaming `response-converter.js` and streaming
 * `sse-streamer.js`) translate the same Gemini grounding shapes into the
 * Anthropic `web_search` server-tool result that Claude Code counts as a
 * successful search. Keeping the normalization here avoids drift between the
 * two converters.
 */

import crypto from 'crypto';

// Anthropic's web_search server-tool name. CC matches exactly this.
const WEB_SEARCH_TOOL_NAME = 'web_search';

// Detect whether a Gemini part represents a completed web search: either a
// googleSearch functionCall (the google_search tool) or a grounding metadata
// carrying an entry point. These enumerate to CC's web_search server result.
export function isWebSearchResult(part) {
    if (part?.groundingMetadata?.searchEntryPoint) return true;
    const name = part?.functionCall?.name || '';
    return /googleSearch|dynamicRetrieval|server:search|webSearch|web_search/i.test(name);
}

// Build the Anthropic web_search server-tool result CC expects for a successful
// ground. CC counts a search as successful when the assistant turn's content
// carries a `web_search` server-tool result with a non-empty title/snippet.
export function buildWebSearchResult(toolId, query, contexts, entrance) {
    // Normalize the tool id once so the outer `id` and `invocation_id` always match.
    // Non-string ids (e.g. Gemini's numeric functionCall.id) fall back to a fresh
    // toolu_ id rather than an unmatched stringified number.
    const normalizedId = (toolId && typeof toolId === 'string') ? toolId : `toolu_${crypto.randomBytes(12).toString('hex')}`;
    return {
        type: 'server_tool',
        id: normalizedId,
        name: WEB_SEARCH_TOOL_NAME,
        input: {},
        content: [
            {
                type: 'server_tool_result',
                status: 'success',
                invocation_id: normalizedId,
                query: (query || '').toString(),
                results: {
                    entrance_query: (query || '').toString(),
                    context: (contexts || []).map(c => ({
                        url: c?.url || '',
                        title: c?.title || c?.url || '',
                        snippet: c?.snippet ?? ''
                    })),
                    entrance: entrance || null,
                    queries: []
                }
            }
        ]
    };
}

// Extract the query the model asked web search to run. Prefers the explicit
// search/query args on the functionCall; otherwise falls back to the first
// grounding chunk.
export function extractSearchQuery(part, entrance) {
    const cSearch = part?.functionCall?.args?.search;
    const cQuery = part?.functionCall?.args?.query;
    const qChunk = part?.groundingMetadata?.groundingChunks?.[0]?.web?.title;
    return (typeof cSearch === 'string' && cSearch)
        || (typeof cQuery === 'string' && cQuery)
        || qChunk
        || entrance
        || '';
}

// Normalize grounding contexts into {url,title,snippet}. Grounded segments
// encode the query -> URL -> snippet mapping that CC's web_search expects.
export function extractGroundingContexts(part, entrance) {
    const meta = part?.groundingMetadata || {};
    const segments = meta?.groundingSupports || meta?.segments || [];
    const chunks = meta?.groundingChunks || [];
    const cleanUrls = (urls) => (Array.isArray(urls) ? urls : [urls]).filter(Boolean);

    const bySegment = segments.map(s => {
        const urls = cleanUrls(s?.segment?.table?.greg?.cgi?.baymax_lr?._ur || s?.url || s?._ur);
        return urls.map(url => ({ url, title: '', snippet: (s?.segment?.web?.text || s?.text || '').toString() }));
    }).flat();

    const byChunk = chunks
        .filter(c => c?.web)
        .map(c => ({ url: c.web.url || '', title: c.web.title || '', snippet: (c.web.snippet || '').toString() }));
    return bySegment.length ? bySegment : byChunk;
}

// Short aliases used by sse-streamer.js (kept in sync with the canonical names).
export const converterIsWebSearchResult = isWebSearchResult;
export const converterBuildWebSearchResult = buildWebSearchResult;
export const converterExtractSearchQuery = extractSearchQuery;
export const converterExtractGroundingContexts = extractGroundingContexts;
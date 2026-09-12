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
import { logger } from '../utils/logger.js';

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

// Build the Anthropic web_search server-tool blocks CC expects for a
// successful ground. Per the official protocol a completed search is a
// `server_tool_use` block paired — via `tool_use_id` — with a
// `web_search_tool_result` block whose `content` is a list of
// `web_search_result` entries. CC counts a search as successful only when
// that paired result block is present.
export function buildWebSearchBlocks(toolId, query, contexts, entrance) {
    // Normalize the tool id once so `server_tool_use.id` and the paired
    // `web_search_tool_result.tool_use_id` always match. Non-string ids
    // (e.g. Gemini's numeric functionCall.id) fall back to a fresh toolu_ id
    // rather than an unmatched stringified number.
    const normalizedId = (toolId && typeof toolId === 'string') ? toolId : `toolu_${crypto.randomBytes(12).toString('hex')}`;
    // The query MUST be a non-empty string. An empty query produced
    // `input: { query: '' }` — CC v2.1.x parses that as a malformed tool
    // call and kills the turn with "The model's tool call could not be
    // parsed (retry also failed)". Fall back through every extraction
    // signal we have, then to a placeholder so `input.query` is always
    // present and non-empty.
    let normalizedQuery = (query || '').toString().trim();
    if (!normalizedQuery) {
        // Only trust string entrances — `searchIntent.entrance` can be an
        // object or an HTML fragment upstream, and String() of that would
        // leak "[object Object]" into the query.
        normalizedQuery = (typeof entrance === 'string' ? entrance : '').trim();
    }
    if (!normalizedQuery) {
        logger.debug('[SearchBlocks] web_search query empty after extraction — falling back to placeholder');
        normalizedQuery = '(unknown query)';
    }
    const normalizedContexts = (contexts || []).filter(c => c && (c.url || c.title));
    const useBlock = {
        type: 'server_tool_use',
        id: normalizedId,
        name: WEB_SEARCH_TOOL_NAME,
        input: { query: normalizedQuery }
    };
    const resultEntries = normalizedContexts.map((c, i) => ({
        type: 'web_search_result',
        url: c.url || '',
        title: c.title || c.url || '',
        // Anthropic result entries carry an opaque index token; we emit a
        // positional placeholder since grounding chunks carry no token.
        encrypted_index: String(i)
    }));
    let resultBlock;
    if (resultEntries.length > 0) {
        resultBlock = {
            type: 'web_search_tool_result',
            tool_use_id: normalizedId,
            content: resultEntries
        };
    } else {
        // Official Anthropic error variant for a server tool that ran but
        // returned nothing. CC renders this as a failed search instead of
        // choking on an empty content list (a bare `content: []` is parsed as
        // a malformed tool call and kills the turn with "The model's tool
        // call could not be parsed (retry also failed)").
        resultBlock = {
            type: 'web_search_tool_result',
            tool_use_id: normalizedId,
            content: { type: 'web_search_tool_result_error', error_code: 'unavailable' }
        };
    }
    return [useBlock, resultBlock];
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
export const converterBuildWebSearchBlocks = buildWebSearchBlocks;
export const converterExtractSearchQuery = extractSearchQuery;
export const converterExtractGroundingContexts = extractGroundingContexts;
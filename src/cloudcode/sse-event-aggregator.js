import { logger } from '../utils/logger.js';

function parseEvent(dataLines) {
    if (dataLines.length === 0) return null;

    try {
        return JSON.parse(dataLines.join('\n'));
    } catch (error) {
        logger.debug(`[CloudCode] Ignoring malformed SSE event: ${error.message}`);
        return null;
    }
}

/**
 * Yield parsed JSON payloads from a complete SSE event stream.
 *
 * SSE permits an event to contain multiple data lines and a transport may split
 * UTF-8 code points or the final event across chunks, so parsing occurs only
 * after an event boundary or end-of-stream flush.
 */
export async function* iterateSSEJsonEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];

    const commit = () => {
        const parsed = parseEvent(dataLines);
        dataLines = [];
        return parsed;
    };

    const consumeLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') return commit();
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        return null;
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const parsed = consumeLine(line);
            if (parsed) yield parsed;
        }
    }

    buffer += decoder.decode();
    if (buffer) {
        const parsed = consumeLine(buffer);
        if (parsed) yield parsed;
    }
    const parsed = commit();
    if (parsed) yield parsed;
}

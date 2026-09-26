/**
 * WebUI session storage and helpers (moved verbatim from webui/index.js).
 */

import { randomBytes } from 'crypto';

// Session storage: token -> { expiresAt: number }
// Tokens are 32-byte random hex strings, cleared on server restart.
export const sessions = new Map();
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prune expired sessions every 30 minutes to avoid unbounded memory growth.
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of sessions) {
        if (data.expiresAt <= now) sessions.delete(token);
    }
}, 30 * 60 * 1000).unref();

/** Parse the Cookie header into a plain object. No external dependency needed. */
export function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    return Object.fromEntries(
        header.split(';').map(pair => {
            const idx = pair.indexOf('=');
            if (idx === -1) return [pair.trim(), ''];
            const value = pair.slice(idx + 1).trim();
            // Tolerate malformed percent-encoding from client-controlled Cookie headers
            let decoded = value;
            try {
                decoded = decodeURIComponent(value);
            } catch {
                // keep raw value
            }
            return [pair.slice(0, idx).trim(), decoded];
        })
    );
}

/** Validate a session token from the request cookie. Returns true if valid. */
export function isSessionValid(req) {
    const token = parseCookies(req).webui_session;
    if (!token) return false;
    const entry = sessions.get(token);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

/** Create a new session token and return it. Each call generates a fresh token (session fixation prevention). */
export function createSession() {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

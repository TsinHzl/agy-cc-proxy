/**
 * WebUI auth middleware (moved verbatim from webui/index.js).
 */

import { config } from '../config.js';
import { isSessionValid } from './session.js';

// Paths that never require a session, even when a password is set.
export const EXEMPT_PATHS = new Set(['/login.html', '/api/auth/login', '/api/auth/logout', '/api/auth/url', '/api/auth/complete']);
export const EXEMPT_PREFIXES = ['/js/', '/css/', '/favicon', '/v1/'];

export function cookieSecureAttr(req) {
    return (req.secure || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
}

export function isExempt(req) {
    if (EXEMPT_PATHS.has(req.path)) return true;
    if (EXEMPT_PREFIXES.some(p => req.path.startsWith(p))) return true;
    if (req.path === '/api/config' && req.method === 'GET') return true;
    if (req.path === '/health') return true;
    return false;
}

/**
 * Auth Middleware — session-cookie protection for WebUI.
 * No-ops when webuiPassword is not configured.
 * Must be mounted BEFORE express.static so page requests can be intercepted.
 */
export function createAuthMiddleware() {
    return (req, res, next) => {
        if (!config.webuiPassword) return next();
        if (isExempt(req)) return next();

        if (!isSessionValid(req)) {
            if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path === '/account-limits' || req.path === '/health') {
                return res.status(401).json({ status: 'error', error: 'Unauthorized' });
            }
            return res.redirect(302, '/login.html');
        }
        next();
    };
}

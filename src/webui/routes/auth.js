/**
 * WebUI auth routes (moved verbatim from webui/index.js).
 */

import { config, verifyPassword } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { sessions, SESSION_TTL_MS, parseCookies, createSession } from '../session.js';
import { cookieSecureAttr } from '../auth.js';

export function registerAuthRoutes(app, ctx) {
    /**
     * POST /api/auth/login — Verify password and issue session cookie.
     */
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { password } = req.body || {};
            if (!config.webuiPassword) {
                return res.status(400).json({ status: 'error', error: 'No password configured' });
            }
            const ok = await verifyPassword(password || '', config.webuiPassword);
            if (!ok) {
                return res.status(401).json({ status: 'error', error: 'Invalid password' });
            }
            const token = createSession();
            res.setHeader('Set-Cookie', `webui_session=${token}; HttpOnly; SameSite=Strict; Path=/${cookieSecureAttr(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
            res.json({ status: 'ok' });
        } catch (error) {
            logger.error('[WebUI] Login error:', error);
            res.status(500).json({ status: 'error', error: 'Internal error' });
        }
    });

    /**
     * POST /api/auth/logout — Invalidate current session cookie.
     */
    app.post('/api/auth/logout', (req, res) => {
        const token = parseCookies(req).webui_session;
        if (token) sessions.delete(token);
        res.setHeader('Set-Cookie', `webui_session=; HttpOnly; SameSite=Strict; Path=/${cookieSecureAttr(req)}; Max-Age=0`);
        res.json({ status: 'ok' });
    });
}

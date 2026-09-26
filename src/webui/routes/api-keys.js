/**
 * WebUI API key management routes (moved verbatim from webui/index.js).
 * `maskKeySecret` / `serializeKey` helpers move along with the api-keys routes.
 */

import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { listKeys, createKey, updateKey, deleteKey, getKeyById, flushApiKeys } from '../../api-keys/manager.js';
import usageLog from '../../modules/usage-log.js';

/** Mask a key secret for client display. */
function maskKeySecret(secret) {
    if (!secret || secret.length < 12) return '****';
    return `${secret.slice(0, 7)}****${secret.slice(-4)}`;
}

/** Serialize a key record for client responses (never include plaintext). */
function serializeKey(key) {
    return {
        id: key.id,
        name: key.name,
        maskedKey: maskKeySecret(key.key),
        enabled: key.enabled,
        durationDays: key.durationDays,
        activatedAt: key.activatedAt,
        expiresAt: key.expiresAt,
        spendingLimit: key.spendingLimit,
        allowedAccounts: key.allowedAccounts ?? null,
        usage: key.usage,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        lastUsedIp: key.lastUsedIp
    };
}

export function registerApiKeyRoutes(app, ctx) {
    /**
     * GET /api/keys - List managed API keys (masked).
     */
    app.get('/api/keys', (_req, res) => {
        try {
            res.json({
                status: 'ok',
                keys: listKeys().map(serializeKey)
            });
        } catch (error) {
            logger.error('[WebUI] Error listing API keys:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/keys - Create a managed API key.
     * The only response that contains the plaintext key.
     */
    app.post('/api/keys', (req, res) => {
        try {
            const { name, durationDays, spendingLimit, allowedAccounts } = req.body || {};
            if (!name || !String(name).trim()) {
                return res.status(400).json({ status: 'error', error: 'name is required' });
            }
            const key = createKey({ name, durationDays, spendingLimit, allowedAccounts });
            logger.info(`[WebUI] API key created: ${key.id} (${key.name})`);
            res.json({
                status: 'ok',
                key: serializeKey(key),
                plaintext: key.key
            });
        } catch (error) {
            res.status(400).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/keys/:id - Update name/enabled/durationDays/spendingLimit/resetUsage.
     */
    app.patch('/api/keys/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const patch = req.body || {};
            const allowed = ['name', 'enabled', 'durationDays', 'spendingLimit', 'allowedAccounts', 'resetUsage'];
            const hasKnown = allowed.some(field => patch[field] !== undefined);
            if (!hasKnown) {
                return res.status(400).json({ status: 'error', error: 'No updatable fields provided' });
            }
            const key = updateKey(id, patch);
            if (!key) {
                return res.status(404).json({ status: 'error', error: `API key ${id} not found` });
            }
            logger.info(`[WebUI] API key updated: ${id}`);
            res.json({ status: 'ok', key: serializeKey(key) });
        } catch (error) {
            if (error?.code === 'EACCES' || error?.code === 'ENOSPC' || error?.code === 'EIO') {
                logger.error('[WebUI] Failed to persist API key update:', error.message);
                return res.status(500).json({ status: 'error', error: 'Failed to persist API key state' });
            }
            res.status(400).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/keys/:id - Delete a managed API key.
     */
    app.delete('/api/keys/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const deleted = deleteKey(id);
            if (!deleted) {
                return res.status(404).json({ status: 'error', error: `API key ${id} not found` });
            }
            await flushApiKeys();
            logger.info(`[WebUI] API key deleted: ${id}`);
            res.json({ status: 'ok', message: `API key ${id} deleted` });
        } catch (error) {
            logger.error('[WebUI] Error deleting API key:', error);
            res.status(500).json({ status: 'error', error: 'Internal server error' });
        }
    });

    /**
     * GET /api/keys/:id/reveal - Reveal the plaintext key (explicit user action).
     * Blocked when no WebUI password is configured: without it anyone with
     * network access to the dashboard could extract every key's plaintext.
     */
    app.get('/api/keys/:id/reveal', (req, res) => {
        if (!config.webuiPassword) {
            return res.status(403).json({
                status: 'error',
                error: 'WebUI password must be configured before revealing keys'
            });
        }
        try {
            const key = getKeyById(req.params.id);
            if (!key) {
                return res.status(404).json({ status: 'error', error: `API key ${req.params.id} not found` });
            }
            logger.info(`[WebUI] API key revealed: ${key.id}`);
            res.json({ status: 'ok', id: key.id, plaintext: key.key });
        } catch (error) {
            logger.error('[WebUI] Error revealing API key:', error);
            res.status(500).json({ status: 'error', error: 'Internal server error' });
        }
    });

    /**
     * GET /api/keys/:id/usage - Usage summary + recent usage-log detail records for this key.
     */
    app.get('/api/keys/:id/usage', (req, res) => {
        try {
            const key = getKeyById(req.params.id);
            if (!key) {
                return res.status(404).json({ status: 'error', error: `API key ${req.params.id} not found` });
            }
            const recent = usageLog.getRecords()
                .filter(r => r.keyId === key.id)
                .slice(0, 50);
            res.json({
                status: 'ok',
                summary: {
                    usage: key.usage,
                    spendingLimit: key.spendingLimit,
                    lastUsedAt: key.lastUsedAt,
                    lastUsedIp: key.lastUsedIp
                },
                recent
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching API key usage:', error);
            res.status(500).json({ status: 'error', error: 'Internal server error' });
        }
    });
}

/**
 * WebUI configuration routes (moved verbatim from webui/index.js).
 * Includes GET /api/config, POST /api/config, POST /api/config/password,
 * and GET /api/settings.
 */

import { getPublicConfig, saveConfig, config, hashPassword, verifyPassword } from '../../config.js';
import { DEFAULT_PORT } from '../../constants.js';
import { logger } from '../../utils/logger.js';
import { sessions } from '../session.js';
import { validateConfigFields } from '../validate-config.js';

export function registerConfigRoutes(app, ctx) {
    const { packageVersion, accountManager } = ctx;

    /**
     * GET /api/config - Get server configuration
     */
    app.get('/api/config', (req, res) => {
        try {
            const publicConfig = getPublicConfig();
            res.json({
                status: 'ok',
                config: publicConfig,
                version: packageVersion,
                note: 'Edit ~/.config/antigravity-proxy/config.json or use env vars to change these values'
            });
        } catch (error) {
            logger.error('[WebUI] Error getting config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config - Update server configuration
     */
    app.post('/api/config', async (req, res) => {
        try {
            const { debug, devMode, logLevel, persistTokenCache, requestThrottlingEnabled, requestDelayMs } = req.body;

            // Validate tunable config fields via shared helper
            const updates = validateConfigFields(req.body);

            // Handle fields not covered by the shared helper
            if (typeof devMode === 'boolean') {
                updates.devMode = devMode;
                updates.debug = devMode;
                logger.setDebug(devMode);
            } else if (typeof debug === 'boolean') {
                updates.debug = debug;
                updates.devMode = debug;
                logger.setDebug(debug);
            }
            if (logLevel && ['info', 'warn', 'error', 'debug'].includes(logLevel)) {
                updates.logLevel = logLevel;
            }
            if (typeof persistTokenCache === 'boolean') {
                updates.persistTokenCache = persistTokenCache;
            }
            if (typeof requestThrottlingEnabled === 'boolean') {
                updates.requestThrottlingEnabled = requestThrottlingEnabled;
            }
            if (typeof requestDelayMs === 'number' && requestDelayMs >= 100 && requestDelayMs <= 5000) {
                updates.requestDelayMs = requestDelayMs;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No valid configuration updates provided'
                });
            }

            const success = saveConfig(updates);

            if (success) {
                // Hot-reload strategy if it was changed (no server restart needed)
                if (updates.accountSelection?.strategy && accountManager) {
                    await accountManager.reload();
                    logger.info(`[WebUI] Strategy hot-reloaded to: ${updates.accountSelection.strategy}`);
                }

                res.json({
                    status: 'ok',
                    message: 'Configuration saved. Restart server to apply some changes.',
                    updates: updates,
                    config: getPublicConfig()
                });
            } else {
                res.status(500).json({
                    status: 'error',
                    error: 'Failed to save configuration file'
                });
            }
        } catch (error) {
            logger.error('[WebUI] Error updating config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config/password - Change WebUI password
     */
    app.post('/api/config/password', async (req, res) => {
        try {
            const { oldPassword, newPassword } = req.body;

            if (!newPassword || typeof newPassword !== 'string') {
                return res.status(400).json({ status: 'error', error: 'New password is required' });
            }

            // Verify current password if one is set
            if (config.webuiPassword) {
                const ok = await verifyPassword(oldPassword || '', config.webuiPassword);
                if (!ok) {
                    return res.status(403).json({ status: 'error', error: 'Invalid current password' });
                }
            }

            const hashed = await hashPassword(newPassword);
            const success = saveConfig({ webuiPassword: hashed });

            if (!success) throw new Error('Failed to save password to config file');

            config.webuiPassword = hashed;
            // Invalidate all existing sessions so users must re-login with the new password.
            sessions.clear();

            res.json({ status: 'ok', message: 'Password changed successfully' });
        } catch (error) {
            logger.error('[WebUI] Error changing password:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/settings - Get runtime settings
     */
    app.get('/api/settings', async (req, res) => {
        try {
            const settings = accountManager.getSettings ? accountManager.getSettings() : {};
            res.json({
                status: 'ok',
                settings: {
                    ...settings,
                    port: process.env.PORT || DEFAULT_PORT
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

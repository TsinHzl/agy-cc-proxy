/**
 * WebUI strategy health route (moved verbatim from webui/index.js).
 */

import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

export function registerStrategyRoutes(app, ctx) {
    const { accountManager } = ctx;

    /**
     * GET /api/strategy/health - Get strategy health data for the inspector panel
     * Only available when devMode is enabled
     */
    app.get('/api/strategy/health', (req, res) => {
        try {
            if (!config.devMode) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Developer mode is not enabled'
                });
            }

            const healthData = accountManager.getStrategyHealthData();
            res.json({
                status: 'ok',
                ...healthData
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching strategy health:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

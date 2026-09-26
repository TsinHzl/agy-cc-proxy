/**
 * WebUI model config route (moved verbatim from webui/index.js).
 */

import { config, saveConfig } from '../../config.js';

export function registerModelRoutes(app, ctx) {
    /**
     * POST /api/models/config - Update model configuration (hidden/pinned/alias)
     */
    app.post('/api/models/config', (req, res) => {
        try {
            const { modelId, config: newModelConfig } = req.body;

            if (!modelId || typeof newModelConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid parameters' });
            }

            // Load current config
            const currentMapping = config.modelMapping || {};

            // Update specific model config
            currentMapping[modelId] = {
                ...currentMapping[modelId],
                ...newModelConfig
            };

            // Save back to main config
            const success = saveConfig({ modelMapping: currentMapping });

            if (success) {
                // Update in-memory config reference
                config.modelMapping = currentMapping;
                res.json({ status: 'ok', modelConfig: currentMapping[modelId] });
            } else {
                throw new Error('Failed to save configuration');
            }
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

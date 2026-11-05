/**
 * WebUI model config route (moved verbatim from webui/index.js).
 */

import { config, saveConfig } from '../../config.js';
import { validateAutoModelConfig, normalizeAutoChain } from '../../cloudcode/auto-model.js';

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

    /**
     * GET /api/models/auto - Read the auto routing chain
     */
    app.get('/api/models/auto', (req, res) => {
        try {
            const autoModel = config.autoModel || { enabled: false, models: [] };
            res.json({
                status: 'ok',
                autoModel,
                // Resolved chain: aliases + modelMapping applied, invalid entries filtered.
                chain: normalizeAutoChain(autoModel, config.modelMapping)
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/models/auto - Replace the auto routing chain
     *
     * Strict validation: a rejected chain must never be partially written.
     */
    app.post('/api/models/auto', (req, res) => {
        try {
            const result = validateAutoModelConfig(req.body, config.modelMapping);
            if (!result.ok) {
                return res.status(400).json({ status: 'error', error: result.error });
            }

            if (!saveConfig({ autoModel: result.value })) {
                throw new Error('Failed to save configuration');
            }
            config.autoModel = result.value;

            res.json({
                status: 'ok',
                autoModel: result.value,
                chain: normalizeAutoChain(result.value, config.modelMapping)
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

/**
 * WebUI server configuration preset routes (moved verbatim from webui/index.js).
 */

import { readServerPresets, saveServerPreset, updateServerPreset, deleteServerPreset } from '../../utils/server-presets.js';
import { logger } from '../../utils/logger.js';
import { validateConfigFields } from '../validate-config.js';

export function registerServerPresetRoutes(app, ctx) {
    /**
     * GET /api/server/presets - List all server config presets
     */
    app.get('/api/server/presets', async (req, res) => {
        try {
            const presets = await readServerPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            logger.error('[WebUI] Error reading server presets:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/server/presets - Save a custom server config preset
     */
    app.post('/api/server/presets', async (req, res) => {
        try {
            const { name, config: presetConfig, description } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (name.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            if (!presetConfig || typeof presetConfig !== 'object' || Array.isArray(presetConfig)) {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const validatedConfig = validateConfigFields(presetConfig);
            if (Object.keys(validatedConfig).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No valid config fields provided' });
            }

            const presets = await saveServerPreset(name.trim(), validatedConfig, description);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" saved` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/server/presets/:name - Update custom preset metadata and/or config
     */
    app.patch('/api/server/presets/:name', async (req, res) => {
        try {
            const { name: currentName } = req.params;
            if (!currentName) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const { name: newName, description, config: configInput } = req.body;
            if (typeof newName === 'string' && !newName.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (typeof newName === 'string' && newName.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            const updates = {};
            if (newName !== undefined) updates.name = newName.trim();
            if (description !== undefined) updates.description = description;

            // Validate and include config updates if provided
            if (configInput && typeof configInput === 'object') {
                const validatedConfig = validateConfigFields(configInput);
                if (Object.keys(validatedConfig).length > 0) {
                    updates.config = validatedConfig;
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No updates provided' });
            }

            const presets = await updateServerPreset(currentName, updates);
            res.json({ status: 'ok', presets, message: `Server preset "${currentName}" updated` });
        } catch (error) {
            const status = error.message.includes('built-in') || error.message.includes('not found') || error.message.includes('already exists') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/server/presets/:name - Delete a custom server config preset
     */
    app.delete('/api/server/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deleteServerPreset(name);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" deleted` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });
}

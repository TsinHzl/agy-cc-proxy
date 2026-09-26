/**
 * WebUI Claude CLI configuration routes (moved verbatim from webui/index.js).
 * Includes config CRUD, restore, mode toggle, and presets.
 */

import { readClaudeConfig, updateClaudeConfig, replaceClaudeConfig, getClaudeConfigPath, readPresets, savePreset, deletePreset } from '../../utils/claude-config.js';
import { DEFAULT_PRESETS } from '../../constants.js';
import { logger } from '../../utils/logger.js';

export function registerClaudeRoutes(app, ctx) {
    /**
     * GET /api/claude/config - Get Claude CLI configuration
     */
    app.get('/api/claude/config', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            res.json({
                status: 'ok',
                config: claudeConfig,
                path: getClaudeConfigPath()
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config - Update Claude CLI configuration
     */
    app.post('/api/claude/config', async (req, res) => {
        try {
            const updates = req.body;
            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid config updates' });
            }

            const newConfig = await updateClaudeConfig(updates);
            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude configuration updated'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config/restore - Restore Claude CLI to default (remove proxy settings)
     */
    app.post('/api/claude/config/restore', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();

            // Proxy-related environment variables to remove when restoring defaults
            const PROXY_ENV_VARS = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];

            // Remove proxy-related environment variables to restore defaults
            if (claudeConfig.env) {
                for (const key of PROXY_ENV_VARS) {
                    delete claudeConfig.env[key];
                }
                // Remove env entirely if empty to truly restore defaults
                if (Object.keys(claudeConfig.env).length === 0) {
                    delete claudeConfig.env;
                }
            }

            // Use replaceClaudeConfig to completely overwrite the config (not merge)
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Restored Claude CLI config to defaults at ${getClaudeConfigPath()}`);

            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude CLI configuration restored to defaults'
            });
        } catch (error) {
            logger.error('[WebUI] Error restoring Claude config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/claude/mode - Get current mode (proxy or paid)
     * Returns 'proxy' if ANTHROPIC_BASE_URL is set to localhost, 'paid' otherwise
     */
    app.get('/api/claude/mode', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            const baseUrl = claudeConfig.env?.ANTHROPIC_BASE_URL || '';

            // Determine mode based on ANTHROPIC_BASE_URL
            const isProxy = baseUrl && (
                baseUrl.includes('localhost') ||
                baseUrl.includes('127.0.0.1') ||
                baseUrl.includes('::1') ||
                baseUrl.includes('0.0.0.0')
            );

            res.json({
                status: 'ok',
                mode: isProxy ? 'proxy' : 'paid'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/mode - Switch between proxy and paid mode
     * Body: { mode: 'proxy' | 'paid' }
     *
     * When switching to 'paid' mode:
     * - Removes the entire 'env' object from settings.json
     * - Claude CLI uses its built-in defaults (official Anthropic API)
     *
     * When switching to 'proxy' mode:
     * - Sets 'env' to the first default preset config (from constants.js)
     */
    app.post('/api/claude/mode', async (req, res) => {
        try {
            const { mode } = req.body;

            if (!mode || !['proxy', 'paid'].includes(mode)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'mode must be "proxy" or "paid"'
                });
            }

            const claudeConfig = await readClaudeConfig();

            if (mode === 'proxy') {
                // Switch to proxy mode - use first default preset config (e.g., "Claude Thinking")
                claudeConfig.env = { ...DEFAULT_PRESETS[0].config };
            } else {
                // Switch to paid mode - remove env entirely
                delete claudeConfig.env;
            }

            // Save the updated config
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Switched Claude CLI to ${mode} mode`);

            res.json({
                status: 'ok',
                mode,
                config: newConfig,
                message: `Switched to ${mode === 'proxy' ? 'Proxy' : 'Paid (Anthropic API)'} mode. Restart Claude CLI to apply.`
            });
        } catch (error) {
            logger.error('[WebUI] Error switching mode:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/claude/presets - Get all saved presets
     */
    app.get('/api/claude/presets', async (req, res) => {
        try {
            const presets = await readPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/presets - Save a new preset
     */
    app.post('/api/claude/presets', async (req, res) => {
        try {
            const { name, config: presetConfig } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (!presetConfig || typeof presetConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const presets = await savePreset(name.trim(), presetConfig);
            res.json({ status: 'ok', presets, message: `Preset "${name}" saved` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/claude/presets/:name - Delete a preset
     */
    app.delete('/api/claude/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deletePreset(name);
            res.json({ status: 'ok', presets, message: `Preset "${name}" deleted` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

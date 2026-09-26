/**
 * WebUI account management routes (moved verbatim from webui/index.js).
 */

import { ACCOUNT_CONFIG_PATH } from '../../constants.js';
import { loadAccounts, saveAccounts } from '../../account-manager/storage.js';
import { logger } from '../../utils/logger.js';
import { setAccountEnabled, removeAccount, addAccount } from '../account-ops.js';

export function registerAccountRoutes(app, ctx) {
    const { accountManager } = ctx;

    /**
     * GET /api/accounts - List all accounts with status
     */
    app.get('/api/accounts', async (req, res) => {
        try {
            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                accounts: status.accounts,
                summary: {
                    total: status.total,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/refresh - Refresh specific account token
     */
    app.post('/api/accounts/:email/refresh', async (req, res) => {
        try {
            const { email } = req.params;
            accountManager.clearTokenCache(email);
            accountManager.clearProjectCache(email);

            // For verification errors (403 VALIDATION_REQUIRED), clear isInvalid on refresh.
            // The user has completed verification on Google's site and clicks Refresh to re-enable.
            // Auth errors (no verifyUrl) still require OAuth re-auth via FIX button.
            const account = accountManager.getAllAccounts().find(a => a.email === email);
            if (account && account.isInvalid && account.verifyUrl) {
                accountManager.clearInvalid(email);
            }

            res.json({
                status: 'ok',
                message: `Token cache cleared for ${email}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/toggle - Enable/disable account
     */
    app.post('/api/accounts/:email/toggle', async (req, res) => {
        try {
            const { email } = req.params;
            const { enabled } = req.body;

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ status: 'error', error: 'enabled must be a boolean' });
            }

            await setAccountEnabled(email, enabled);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} ${enabled ? 'enabled' : 'disabled'}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/accounts/:email - Remove account
     */
    app.delete('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            await removeAccount(email);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} removed`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/accounts/:email - Update account settings (thresholds)
     */
    app.patch('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const { quotaThreshold, modelQuotaThresholds } = req.body;

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const account = accounts.find(a => a.email === email);

            if (!account) {
                return res.status(404).json({ status: 'error', error: `Account ${email} not found` });
            }

            // Validate and update quotaThreshold (0-0.99 or null/undefined to clear)
            if (quotaThreshold !== undefined) {
                if (quotaThreshold === null) {
                    delete account.quotaThreshold;
                } else if (typeof quotaThreshold === 'number' && quotaThreshold >= 0 && quotaThreshold < 1) {
                    account.quotaThreshold = quotaThreshold;
                } else {
                    return res.status(400).json({ status: 'error', error: 'quotaThreshold must be 0-0.99 or null' });
                }
            }

            // Validate and update modelQuotaThresholds (full replacement, not merge)
            if (modelQuotaThresholds !== undefined) {
                if (modelQuotaThresholds === null || (typeof modelQuotaThresholds === 'object' && Object.keys(modelQuotaThresholds).length === 0)) {
                    // Clear all model thresholds
                    delete account.modelQuotaThresholds;
                } else if (typeof modelQuotaThresholds === 'object') {
                    // Validate all thresholds first
                    for (const [modelId, threshold] of Object.entries(modelQuotaThresholds)) {
                        if (typeof threshold !== 'number' || threshold < 0 || threshold >= 1) {
                            return res.status(400).json({
                                status: 'error',
                                error: `Invalid threshold for model ${modelId}: must be 0-0.99`
                            });
                        }
                    }
                    // Replace entire object (not merge)
                    account.modelQuotaThresholds = { ...modelQuotaThresholds };
                } else {
                    return res.status(400).json({ status: 'error', error: 'modelQuotaThresholds must be an object or null' });
                }
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            logger.info(`[WebUI] Account ${email} thresholds updated`);

            res.json({
                status: 'ok',
                message: `Account ${email} thresholds updated`,
                account: {
                    email: account.email,
                    quotaThreshold: account.quotaThreshold,
                    modelQuotaThresholds: account.modelQuotaThresholds || {}
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error updating account thresholds:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/reload - Reload accounts from disk
     */
    app.post('/api/accounts/reload', async (req, res) => {
        try {
            // Reload AccountManager from disk
            await accountManager.reload();

            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                message: 'Accounts reloaded from disk',
                summary: status.summary
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/accounts/export - Export accounts
     */
    app.get('/api/accounts/export', async (req, res) => {
        try {
            const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            // Export only essential fields for portability
            const exportData = accounts
                .filter(acc => acc.source !== 'database')
                .map(acc => {
                    const essential = { email: acc.email };
                    // Use snake_case for compatibility
                    if (acc.refreshToken) {
                        essential.refresh_token = acc.refreshToken;
                    }
                    if (acc.apiKey) {
                        essential.api_key = acc.apiKey;
                    }
                    return essential;
                });

            // Return plain array for simpler format
            res.json(exportData);
        } catch (error) {
            logger.error('[WebUI] Export accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/import - Batch import accounts
     */
    app.post('/api/accounts/import', async (req, res) => {
        try {
            // Support both wrapped format { accounts: [...] } and plain array [...]
            let importAccounts = req.body;
            if (req.body.accounts && Array.isArray(req.body.accounts)) {
                importAccounts = req.body.accounts;
            }

            if (!Array.isArray(importAccounts) || importAccounts.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'accounts must be a non-empty array'
                });
            }

            const results = { added: [], updated: [], failed: [] };

            // Load existing accounts once before the loop
            const { accounts: existingAccounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const existingEmails = new Set(existingAccounts.map(a => a.email));

            for (const acc of importAccounts) {
                try {
                    // Validate required fields
                    if (!acc.email) {
                        results.failed.push({ email: acc.email || 'unknown', reason: 'Missing email' });
                        continue;
                    }

                    // Support both snake_case and camelCase
                    const refreshToken = acc.refresh_token || acc.refreshToken;
                    const apiKey = acc.api_key || acc.apiKey;

                    // Must have at least one credential
                    if (!refreshToken && !apiKey) {
                        results.failed.push({ email: acc.email, reason: 'Missing refresh_token or api_key' });
                        continue;
                    }

                    // Check if account already exists
                    const exists = existingEmails.has(acc.email);

                    // Add account
                    await addAccount({
                        email: acc.email,
                        source: apiKey ? 'manual' : 'oauth',
                        refreshToken: refreshToken,
                        apiKey: apiKey
                    });

                    if (exists) {
                        results.updated.push(acc.email);
                    } else {
                        results.added.push(acc.email);
                    }
                } catch (err) {
                    results.failed.push({ email: acc.email, reason: err.message });
                }
            }

            // Reload AccountManager
            await accountManager.reload();

            logger.info(`[WebUI] Import complete: ${results.added.length} added, ${results.updated.length} updated, ${results.failed.length} failed`);

            res.json({
                status: 'ok',
                results,
                message: `Imported ${results.added.length + results.updated.length} accounts`
            });
        } catch (error) {
            logger.error('[WebUI] Import accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });
}

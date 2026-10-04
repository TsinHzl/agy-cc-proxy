/**
 * Account Manager Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.accountManager = () => ({
    searchQuery: '',
    deleteTarget: '',
    refreshing: false,
    toggling: false,
    deleting: false,
    reloading: false,
    selectedAccountEmail: '',
    selectedAccountLimits: {},
    selectedAccountTier: 'free',
    selectedAccountStatus: 'ok',
    selectedAccountError: '',
    selectedAccountPriority: 50,
    selectedAccountQuotaGroups: [],
    activeQuotaTab: 'detailed',
    savingPriority: false,
    viewMode: localStorage.getItem('ag_accounts_view_mode') || 'grid',

    setViewMode(mode) {
        this.viewMode = mode;
        try {
            localStorage.setItem('ag_accounts_view_mode', mode);
        } catch (e) { /* ignore */ }
    },

    // Health Inspector (Developer Mode)
    healthData: {},
    healthLoading: false,

    init() {
        if (Alpine.store('data').devMode && Alpine.store('settings').healthInspectorOpen) {
            this.fetchHealthData();
        }
    },

    get filteredAccounts() {
        const accounts = Alpine.store('data').accounts || [];
        if (!this.searchQuery || this.searchQuery.trim() === '') {
            return accounts;
        }

        const query = this.searchQuery.toLowerCase().trim();
        return accounts.filter(acc => {
            return acc.email.toLowerCase().includes(query) ||
                   (acc.projectId && acc.projectId.toLowerCase().includes(query)) ||
                   (acc.source && acc.source.toLowerCase().includes(query));
        });
    },

    formatEmail(email) {
        if (!email || email.length <= 40) return email;

        const [user, domain] = email.split('@');
        if (!domain) return email;

        // Preserve domain integrity, truncate username if needed
        if (user.length > 20) {
            return `${user.substring(0, 10)}...${user.slice(-5)}@${domain}`;
        }
        return email;
    },

    async refreshAccount(email) {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');
            store.showToast(store.t('refreshingAccount', { email: Redact.email(email) }), 'info');

            const { response } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}/refresh`,
                { method: 'POST' }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('refreshedAccount', { email: Redact.email(email) }), 'success');
                await Alpine.store('data').fetchData();
                return data;
            } else {
                throw new Error(data.error || store.t('refreshFailed'));
            }
        }, this, 'refreshing', { errorMessage: 'Failed to refresh account' });
    },

    async toggleAccount(email, enabled) {
        const store = Alpine.store('global');

        // Optimistic update: immediately update UI
        const dataStore = Alpine.store('data');
        const account = dataStore.accounts.find(a => a.email === email);
        if (account) {
            account.enabled = enabled;
        }

        try {
            const { response } = await window.utils.request(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('accountToggled', { email: Redact.email(email), status }), 'success');
                // Refresh to confirm server state
                await dataStore.fetchData();
            } else {
                store.showToast(data.error || store.t('toggleFailed'), 'error');
                // Rollback optimistic update on error
                if (account) {
                    account.enabled = !enabled;
                }
                await dataStore.fetchData();
            }
        } catch (e) {
            store.showToast(store.t('toggleFailed') + ': ' + e.message, 'error');
            // Rollback optimistic update on error
            if (account) {
                account.enabled = !enabled;
            }
            await dataStore.fetchData();
        }
    },

    async fixAccount(email) {
        const store = Alpine.store('global');
        const dataStore = Alpine.store('data');
        // If the account has a verification URL (403 VALIDATION_REQUIRED), open it directly
        const account = (dataStore.accounts || []).find(a => a.email === email);
        if (account?.verifyUrl) {
            window.open(account.verifyUrl, '_blank');
            store.showToast(store.t('verifyThenRefresh') || 'After completing verification, click the ↻ Refresh button to re-enable this account', 'info', 10000);
            return;
        }
        // Otherwise fall back to OAuth re-auth
        store.showToast(store.t('reauthenticating', { email: Redact.email(email) }), 'info');
        try {
            const urlPath = `/api/auth/url?email=${encodeURIComponent(email)}`;
            const { response } = await window.utils.request(urlPath, {});

            const data = await response.json();
            if (data.status === 'ok') {
                window.open(data.url, 'google_oauth', 'width=600,height=700,scrollbars=yes');
            } else {
                store.showToast(data.error || store.t('authUrlFailed'), 'error');
            }
        } catch (e) {
            store.showToast(store.t('authUrlFailed') + ': ' + e.message, 'error');
        }
    },

    confirmDeleteAccount(email) {
        this.deleteTarget = email;
        document.getElementById('delete_account_modal').showModal();
    },

    async executeDelete() {
        const email = this.deleteTarget;
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');

            const { response } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                { method: 'DELETE' }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('deletedAccount', { email: Redact.email(email) }), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('delete_account_modal').close();
                this.deleteTarget = '';
            } else {
                throw new Error(data.error || store.t('deleteFailed'));
            }
        }, this, 'deleting', { errorMessage: 'Failed to delete account' });
    },

    async reloadAccounts() {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');

            const { response } = await window.utils.request(
                '/api/accounts/reload',
                { method: 'POST' }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountsReloaded'), 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || store.t('reloadFailed'));
            }
        }, this, 'reloading', { errorMessage: 'Failed to reload accounts' });
    },

    openQuotaModal(account) {
        this.selectedAccountEmail = account.email;
        this.selectedAccountTier = account.subscription?.tier || 'free';
        this.selectedAccountStatus = account.status || 'ok';
        this.selectedAccountError = account.error || account.invalidReason || '';
        this.selectedAccountPriority = account.priority ?? 50;
        const quotaGroups = Array.isArray(account.quota_groups)
            ? account.quota_groups
            : (Array.isArray(account.quota?.quota_groups) ? account.quota.quota_groups : []);
        this.selectedAccountQuotaGroups = quotaGroups;
        this.selectedAccountLimits = account.limits || {};
        this.activeQuotaTab = quotaGroups.length > 0 ? 'detailed' : 'model';
        document.getElementById('quota_modal').showModal();
    },

    getDetailedQuotaGroups() {
        const groups = Array.isArray(this.selectedAccountQuotaGroups)
            ? this.selectedAccountQuotaGroups
            : [];
        const sections = [
            { id: 'gemini', name: 'Gemini Models', matches: name => name.includes('gemini') },
            {
                id: 'claude-gpt',
                name: 'Claude and GPT models',
                matches: name => name.includes('claude') || name.includes('gpt')
            }
        ];
        const windows = [
            { id: 'weekly', apiWindow: '7d', label: 'WEEKLY' },
            { id: 'five-hour', apiWindow: '5h', label: '5H' }
        ];

        return sections.map(section => {
            const group = groups.find(item =>
                section.matches(String(item?.display_name || '').toLowerCase()));
            const buckets = Array.isArray(group?.buckets) ? group.buckets : [];

            return {
                id: section.id,
                name: section.name,
                description: group?.description || '',
                buckets: windows.map(window => {
                    const bucket = buckets.find(item =>
                        String(item?.window || '').toLowerCase() === window.apiWindow);
                    const fraction = bucket?.remaining_fraction;

                    return {
                        ...window,
                        percent: typeof fraction === 'number'
                            ? Math.round(Math.min(1, Math.max(0, fraction)) * 100)
                            : null,
                        resetTime: bucket?.reset_time || null
                    };
                })
            };
        });
    },

    async saveAccountPriority() {
        const store = Alpine.store('global');
        const email = this.selectedAccountEmail;
        const priority = Number(this.selectedAccountPriority);

        if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
            store.showToast('Priority must be an integer between 1 and 100', 'error');
            return;
        }

        this.savingPriority = true;
        try {
            const { response } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ priority })
                }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast('Account priority updated', 'success');
                this.selectedAccountPriority = priority;
                const dataStore = Alpine.store('data');
                dataStore.accounts = (dataStore.accounts || []).map(a =>
                    a.email === email ? { ...a, priority } : a
                );
            } else {
                throw new Error(data.error || 'Failed to update priority');
            }
        } catch (e) {
            store.showToast('Failed to save priority: ' + e.message, 'error');
        } finally {
            this.savingPriority = false;
        }
    },

    // Threshold settings
    thresholdDialog: {
        email: '',
        quotaThreshold: null,  // null means use global
        modelQuotaThresholds: {},
        saving: false,
        addingModel: false,
        newModelId: '',
        newModelThreshold: 10
    },

    openThresholdModal(account) {
        this.thresholdDialog = {
            email: account.email,
            // Convert from fraction (0-1) to percentage (0-99) for display
            quotaThreshold: account.quotaThreshold !== undefined ? Math.round(account.quotaThreshold * 100) : null,
            modelQuotaThresholds: Object.fromEntries(
                Object.entries(account.modelQuotaThresholds || {}).map(([k, v]) => [k, Math.round(v * 100)])
            ),
            saving: false,
            addingModel: false,
            newModelId: '',
            newModelThreshold: 10
        };
        document.getElementById('threshold_modal').showModal();
    },

    async saveAccountThreshold() {
        const store = Alpine.store('global');
        this.thresholdDialog.saving = true;

        try {
            // Convert percentage back to fraction
            const quotaThreshold = this.thresholdDialog.quotaThreshold !== null && this.thresholdDialog.quotaThreshold !== ''
                ? parseFloat(this.thresholdDialog.quotaThreshold) / 100
                : null;

            // Convert model thresholds from percentage to fraction
            const modelQuotaThresholds = {};
            for (const [modelId, pct] of Object.entries(this.thresholdDialog.modelQuotaThresholds)) {
                modelQuotaThresholds[modelId] = parseFloat(pct) / 100;
            }

            const { response } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(this.thresholdDialog.email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotaThreshold, modelQuotaThresholds })
                }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast('Settings saved', 'success');
                Alpine.store('data').fetchData();
                document.getElementById('threshold_modal').close();
            } else {
                throw new Error(data.error || 'Failed to save settings');
            }
        } catch (e) {
            store.showToast('Failed to save settings: ' + e.message, 'error');
        } finally {
            this.thresholdDialog.saving = false;
        }
    },

    clearAccountThreshold() {
        this.thresholdDialog.quotaThreshold = null;
    },

    // Per-model threshold methods
    addModelThreshold() {
        this.thresholdDialog.addingModel = true;
        this.thresholdDialog.newModelId = '';
        this.thresholdDialog.newModelThreshold = 10;
    },

    updateModelThreshold(modelId, value) {
        const numValue = parseInt(value);
        if (!isNaN(numValue) && numValue >= 0 && numValue <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = numValue;
        }
    },

    removeModelThreshold(modelId) {
        delete this.thresholdDialog.modelQuotaThresholds[modelId];
    },

    confirmAddModelThreshold() {
        const modelId = this.thresholdDialog.newModelId;
        const threshold = parseInt(this.thresholdDialog.newModelThreshold) || 10;

        if (modelId && threshold >= 0 && threshold <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = threshold;
            this.thresholdDialog.addingModel = false;
            this.thresholdDialog.newModelId = '';
            this.thresholdDialog.newModelThreshold = 10;
        }
    },

    getAvailableModelsForThreshold() {
        // Get models from data store, exclude already configured ones
        const allModels = Alpine.store('data').models || [];
        const configured = Object.keys(this.thresholdDialog.modelQuotaThresholds);
        return allModels.filter(m => !configured.includes(m));
    },

    getEffectiveThreshold(account) {
        // Return display string for effective threshold
        if (account.quotaThreshold !== undefined) {
            return Math.round(account.quotaThreshold * 100) + '%';
        }
        // If no per-account threshold, show global value
        const globalThreshold = Alpine.store('data').globalQuotaThreshold;
        if (globalThreshold > 0) {
            return Math.round(globalThreshold * 100) + '% (global)';
        }
        return 'Global';
    },

    /**
     * Get main model quota for display
     * Prioritizes flagship models (Opus > Sonnet > Flash)
     * @param {Object} account - Account object with limits
     * @returns {Object} { percent: number|null, model: string }
     */
    getMainModelQuota(account) {
        const limits = account.limits || {};
        
        const getQuotaVal = (id) => {
             const l = limits[id];
             if (!l) return -1;
             if (l.remainingFraction !== null) return l.remainingFraction;
             if (l.resetTime) return 0; // Rate limited
             return -1; // Unknown
        };

        const validIds = Object.keys(limits).filter(id => getQuotaVal(id) >= 0);
        
        if (validIds.length === 0) return { percent: null, model: '-' };

        const DEAD_THRESHOLD = 0.01;
        
        const MODEL_TIERS = [
            { pattern: /\bopus\b/, aliveScore: 100, deadScore: 60 },
            { pattern: /\bsonnet\b/, aliveScore: 90, deadScore: 55 },
            // Gemini 3 Pro / Ultra
            { pattern: /\bgemini-3\b/, extraCheck: (l) => /\bpro\b/.test(l) || /\bultra\b/.test(l), aliveScore: 80, deadScore: 50 },
            { pattern: /\bpro\b/, aliveScore: 75, deadScore: 45 },
            // Mid/Low Tier
            { pattern: /\bhaiku\b/, aliveScore: 30, deadScore: 15 },
            { pattern: /\bflash\b/, aliveScore: 20, deadScore: 10 }
        ];

        const getPriority = (id) => {
            const lower = id.toLowerCase();
            const val = getQuotaVal(id);
            const isAlive = val > DEAD_THRESHOLD;
            
            for (const tier of MODEL_TIERS) {
                if (tier.pattern.test(lower)) {
                    if (tier.extraCheck && !tier.extraCheck(lower)) continue;
                    return isAlive ? tier.aliveScore : tier.deadScore;
                }
            }
            
            return isAlive ? 5 : 0;
        };

        // Sort by priority desc
        validIds.sort((a, b) => getPriority(b) - getPriority(a));

        const bestModel = validIds[0];
        const val = getQuotaVal(bestModel);
        
        return {
            percent: Math.round(val * 100),
            model: bestModel
        };
    },

    /**
     * Get quota items for Card view: all Claude models + 1 latest Gemini model
     * @param {Object} account
     * @returns {Array<Object>}
     */
    getCardQuotaModels(account) {
        if (!account) return [];
        const limits = account.limits || {};

        const availableModelIds = new Set(Object.keys(limits));
        const allKnownModels = Alpine.store('data')?.models || [];
        allKnownModels.forEach(m => availableModelIds.add(m));

        const getQuotaInfo = (modelId) => {
            const l = limits[modelId];
            let percent = null;
            let resetTime = null;
            if (l) {
                if (l.remainingFraction !== null && l.remainingFraction !== undefined) {
                    percent = Math.round(l.remainingFraction * 100);
                } else if (l.resetTime) {
                    percent = 0;
                }
                resetTime = l.resetTime || null;
            }
            return { percent, resetTime };
        };

        const formatModelName = (modelId) => {
            const lower = modelId.toLowerCase();
            if (lower.includes('sonnet')) {
                if (lower.includes('4-6') || lower.includes('4.6')) return 'Claude Sonnet 4.6 (Think)';
                if (lower.includes('3-7') || lower.includes('3.7')) return 'Claude Sonnet 3.7 (Think)';
                if (lower.includes('3-5') || lower.includes('3.5')) return 'Claude Sonnet 3.5';
                return 'Claude Sonnet';
            }
            if (lower.includes('opus')) {
                if (lower.includes('4-6') || lower.includes('4.6')) return 'Claude Opus 4.6 (Think)';
                if (lower.includes('4-5') || lower.includes('4.5')) return 'Claude Opus 4.5';
                if (lower.includes('3')) return 'Claude Opus 3';
                return 'Claude Opus (Think)';
            }
            if (lower.includes('haiku')) {
                if (lower.includes('4-5') || lower.includes('4.5')) return 'Claude Haiku 4.5';
                if (lower.includes('3-5') || lower.includes('3.5')) return 'Claude Haiku 3.5';
                return 'Claude Haiku';
            }
            if (lower.includes('gemini')) {
                const isFlash = lower.includes('flash');
                const isAgent = lower.includes('agent');
                const versionMatch = lower.match(/gemini[-_](\d+)(?:[._-](\d+))?/);
                const ver = versionMatch
                    ? `${versionMatch[1]}${versionMatch[2] ? `.${versionMatch[2]}` : ''}`
                    : '';

                let tier = '';
                if (lower.includes('high')) tier = ' (High)';
                else if (lower.includes('preview')) tier = ' (Preview)';
                else if (lower.includes('low')) tier = ' (Low)';
                else if (lower.includes('tiered')) tier = ' (Tiered)';

                if (isAgent) return 'Gemini Pro Agent';
                if (isFlash) return `Gemini ${ver ? ver + ' ' : ''}Flash${tier}`;
                if (ver) return `Gemini ${ver} Pro${tier}`;
                return 'Gemini Pro';
            }
            return modelId.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
        };

        const getFamilyColor = (modelId, percent) => {
            const lower = modelId.toLowerCase();
            if (percent === 0) {
                return {
                    trackClass: 'bg-surface-3 text-ink-3 border-hairline',
                    barClass: 'bg-transparent',
                    isZero: true
                };
            }
            if (lower.includes('opus')) {
                return {
                    trackClass: percent === 100
                        ? 'bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300'
                        : 'bg-surface-2 border-hairline text-ink',
                    barClass: 'bg-gradient-to-r from-purple-500 to-indigo-600',
                    isOpus: true
                };
            }
            if (lower.includes('sonnet')) {
                return {
                    trackClass: percent === 100
                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300'
                        : 'bg-surface-2 border-hairline text-ink',
                    barClass: 'bg-gradient-to-r from-amber-500 to-orange-500',
                    isSonnet: true
                };
            }
            if (lower.includes('haiku')) {
                return {
                    trackClass: percent === 100
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                        : 'bg-surface-2 border-hairline text-ink',
                    barClass: 'bg-gradient-to-r from-emerald-500 to-teal-500',
                    isHaiku: true
                };
            }
            // Gemini
            return {
                trackClass: percent === 100
                    ? 'bg-blue-500/15 border-blue-500/30 text-blue-700 dark:text-blue-300'
                    : 'bg-surface-2 border-hairline text-ink',
                barClass: 'bg-gradient-to-r from-blue-500 to-cyan-500',
                isGemini: true
            };
        };

        // All Claude models
        const claudeModels = Array.from(availableModelIds)
            .filter(id => id.toLowerCase().includes('claude'))
            .sort((a, b) => {
                const score = (id) => {
                    const l = id.toLowerCase();
                    if (l.includes('opus')) return 300;
                    if (l.includes('sonnet')) return 200;
                    if (l.includes('haiku')) return 100;
                    return 0;
                };
                return score(b) - score(a);
            });

        // 1 Latest Gemini model
        const getGeminiVersion = (modelId) => {
            const versionMatch = modelId.toLowerCase().match(/gemini[-_](\d+)(?:[._-](\d+))?/);
            return {
                major: Number(versionMatch?.[1] || 0),
                minor: Number(versionMatch?.[2] || 0)
            };
        };
        const geminiModels = Array.from(availableModelIds)
            .filter(id => id.toLowerCase().includes('gemini'))
            .sort((a, b) => {
                const score = (id) => {
                    const l = id.toLowerCase();
                    if (l.includes('high')) return 50;
                    if (l.includes('preview')) return 40;
                    if (l.includes('pro')) return 30;
                    return 0;
                };
                const aVersion = getGeminiVersion(a);
                const bVersion = getGeminiVersion(b);
                if (aVersion.major !== bVersion.major) return bVersion.major - aVersion.major;
                if (aVersion.minor !== bVersion.minor) return bVersion.minor - aVersion.minor;
                return score(b) - score(a);
            });

        const selectedGemini = geminiModels.length > 0 ? [geminiModels[0]] : [];
        const finalModelIds = [...claudeModels, ...selectedGemini];

        return finalModelIds.map(modelId => {
            const { percent, resetTime } = getQuotaInfo(modelId);
            const displayName = formatModelName(modelId);
            let countdown = null;
            if (resetTime) {
                try {
                    countdown = window.utils.formatTimeUntil(resetTime);
                } catch (e) { /* ignore */ }
            }

            const effectivePercent = percent !== null ? percent : 100;
            const colors = getFamilyColor(modelId, effectivePercent);

            return {
                id: modelId,
                name: displayName,
                percent: effectivePercent,
                hasPercent: percent !== null,
                resetTime,
                countdown,
                colors
            };
        });
    },

    /**
     * Fetch strategy health data for the inspector panel
     */
    async fetchHealthData() {
        this.healthLoading = true;
        try {
            const store = Alpine.store('global');
            const { response } = await window.utils.request(
                '/api/strategy/health',
                {}
            );

            const data = await response.json();
            if (data.status === 'ok') {
                this.healthData = data;
            } else {
                this.healthData = {};
                if (response.status === 403) {
                    store.showToast(data.error || 'Developer mode is not enabled', 'warning');
                }
            }
        } catch (e) {
            console.error('Failed to fetch health data:', e);
        } finally {
            this.healthLoading = false;
        }
    },

    /**
     * Export accounts to JSON file
     */
    async exportAccounts() {
        const store = Alpine.store('global');
        try {
            const { response } = await window.utils.request(
                '/api/accounts/export',
                {}
            );

            const data = await response.json();
            // API returns plain array directly
            if (Array.isArray(data)) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `antigravity-accounts-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                store.showToast(store.t('exportSuccess', { count: data.length }), 'success');
            } else if (data.error) {
                throw new Error(data.error);
            }
        } catch (e) {
            store.showToast(store.t('exportFailed') + ': ' + e.message, 'error');
        }
    },

    /**
     * Import accounts from JSON file
     * @param {Event} event - file input change event
     */
    async importAccounts(event) {
        const store = Alpine.store('global');
        const file = event.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importData = JSON.parse(text);

            // Support both plain array and wrapped format
            const accounts = Array.isArray(importData) ? importData : (importData.accounts || []);
            if (!Array.isArray(accounts) || accounts.length === 0) {
                throw new Error('Invalid file format: expected accounts array');
            }

            const { response } = await window.utils.request(
                '/api/accounts/import',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(accounts)
                }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                const { added, updated, failed } = data.results;
                let msg = store.t('importSuccess') + ` ${added.length} added, ${updated.length} updated`;
                if (failed.length > 0) {
                    msg += `, ${failed.length} failed`;
                }
                store.showToast(msg, failed.length > 0 ? 'info' : 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || 'Import failed');
            }
        } catch (e) {
            store.showToast(store.t('importFailed') + ': ' + e.message, 'error');
        } finally {
            // Reset file input
            event.target.value = '';
        }
    }
});

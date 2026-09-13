// API Keys management view component (Alpine.js).
// Mirrors usage-log-viewer.js patterns: window.Components registration,
// $watch lifecycle, UpdatedAgo heartbeat, textarea copy fallback.

window.Components = window.Components || {};
window.Components.apiKeysManager = () => ({
    keys: [],
    loading: true,
    search: '',
    lastUpdated: 0,
    agoTick: 0,
    agoTimer: null,

    // Create / edit modal
    editingId: null,
    form: { name: '', durationDays: '', limitEnabled: false, limitMetric: 'tokens', limitValue: '' },
    saving: false,

    // One-time plaintext modal
    plaintextValue: '',
    copiedPlaintext: false,

    // Delete modal
    deleteTarget: null,
    deleting: false,

    // Usage modal
    usageTarget: null,
    usageSummary: null,
    usageLoading: false,
    recentRecords: [],

    // Key currently being mutated (toggle/reveal) — disables its action buttons
    busyKeyId: null,

    async init() {
        await this.refreshData();

        this.$watch('$store.global.activeTab', (tab) => {
            // Re-fetch when the tab becomes visible and data may be stale
            // (time-based: works even if all keys were deleted elsewhere).
            if (tab === 'apiKeys' && Date.now() - this.lastUpdated > 30000) {
                this.refreshData();
            }
        });

        this.agoTimer = setInterval(() => {
            this.agoTick++;
        }, 30000);
    },

    destroy() {
        if (this.agoTimer) clearInterval(this.agoTimer);
    },

    get filteredKeys() {
        const q = this.search.trim().toLowerCase();
        if (!q) return this.keys;
        return this.keys.filter(k =>
            (k.name || '').toLowerCase().includes(q) ||
            (k.maskedKey || '').toLowerCase().includes(q)
        );
    },

    /** Parse an error response body safely (may be non-JSON, e.g. a gateway 502 HTML page). */
    async parseErrorResponse(res) {
        let message = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body && body.error) message = body.error;
        } catch (_) { /* non-JSON body — keep HTTP status message */ }
        return message;
    },

    async refreshData() {
        this.loading = true;
        try {
            const res = await fetch('/api/keys', { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.keys = data.keys || [];
            this.lastUpdated = Date.now();
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('loadFailed') + ': ' + e.message, 'error');
        } finally {
            this.loading = false;
        }
    },

    // ─── Create / Edit ───────────────────────────────────────────────────────

    openCreateModal() {
        this.editingId = null;
        this.form = { name: '', durationDays: '', limitEnabled: false, limitMetric: 'tokens', limitValue: '' };
        document.getElementById('api_key_form_modal').showModal();
    },

    openEditModal(key) {
        this.editingId = key.id;
        this.form = {
            name: key.name,
            durationDays: key.durationDays != null ? String(key.durationDays) : '',
            limitEnabled: !!key.spendingLimit,
            limitMetric: key.spendingLimit ? key.spendingLimit.metric : 'tokens',
            limitValue: key.spendingLimit ? String(key.spendingLimit.limit) : ''
        };
        document.getElementById('api_key_form_modal').showModal();
    },

    buildFormPayload() {
        const name = String(this.form.name || '').trim();
        if (!name) {
            throw new Error(Alpine.store('global').t('keyNameRequired'));
        }
        const payload = { name };
        const days = String(this.form.durationDays).trim();
        if (days === '') {
            payload.durationDays = null;
        } else {
            const n = Number(days);
            // JS-level validation: reject non-numeric / non-integer / < 0
            // (HTML min/type alone lets 'abc' slip through as NaN → null)
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
                throw new Error(Alpine.store('global').t('invalidDurationDays'));
            }
            payload.durationDays = n === 0 ? null : n;
        }

        if (this.form.limitEnabled) {
            const limit = Number(String(this.form.limitValue).trim());
            if (!Number.isFinite(limit) || limit <= 0) {
                throw new Error(Alpine.store('global').t('invalidLimitValue'));
            }
            payload.spendingLimit = { metric: this.form.limitMetric, limit };
        } else {
            payload.spendingLimit = null;
        }
        return payload;
    },

    async submitForm() {
        if (this.saving) return;
        this.saving = true;
        try {
            const payload = this.buildFormPayload();
            let plaintext = null;
            if (this.editingId) {
                const res = await fetch(`/api/keys/${this.editingId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15000)
                });
                if (!res.ok) throw new Error(await this.parseErrorResponse(res));
            } else {
                const res = await fetch('/api/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15000)
                });
                if (!res.ok) throw new Error(await this.parseErrorResponse(res));
                plaintext = (await res.json()).plaintext;
            }
            document.getElementById('api_key_form_modal').close();
            await this.refreshData();

            const store = Alpine.store('global');
            if (plaintext) {
                this.plaintextValue = plaintext;
                this.copiedPlaintext = false;
                document.getElementById('api_key_plaintext_modal').showModal();
            } else {
                store.showToast(store.t('keyUpdated'), 'success');
            }
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('saveFailed') + ': ' + e.message, 'error');
        } finally {
            this.saving = false;
        }
    },

    // ─── Toggle ──────────────────────────────────────────────────────────────

    async toggleEnabled(key) {
        const target = key.id;
        const nextEnabled = !key.enabled;
        this.busyKeyId = target;

        // Optimistic update
        key.enabled = nextEnabled;
        try {
            const res = await fetch(`/api/keys/${target}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: nextEnabled }),
                signal: AbortSignal.timeout(15000)
            });
            if (!res.ok) throw new Error(await this.parseErrorResponse(res));
        } catch (e) {
            key.enabled = !nextEnabled; // revert
            const store = Alpine.store('global');
            store.showToast(store.t('toggleFailed') + ': ' + e.message, 'error');
        } finally {
            this.busyKeyId = null;
        }
    },

    // ─── Reveal / Copy ───────────────────────────────────────────────────────

    async revealKey(key, copyOnly = false) {
        this.busyKeyId = key.id;
        try {
            const res = await fetch(`/api/keys/${key.id}/reveal`, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(await this.parseErrorResponse(res));
            const data = await res.json();
            if (copyOnly) {
                if (await this.copyText(data.plaintext)) {
                    const store = Alpine.store('global');
                    store.showToast(store.t('copied'), 'success');
                }
            } else {
                this.plaintextValue = data.plaintext;
                this.copiedPlaintext = false;
                document.getElementById('api_key_plaintext_modal').showModal();
            }
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('revealFailed') + ': ' + e.message, 'error');
        } finally {
            this.busyKeyId = null;
        }
    },

    async copyPlaintext() {
        if (await this.copyText(this.plaintextValue)) {
            this.copiedPlaintext = true;
            setTimeout(() => { this.copiedPlaintext = false; }, 2000);
        }
    },

    /** Copy text to clipboard. Returns true on success, false on failure
     *  (failure already shows a copyFailed toast — callers must not report
     *  success when this returns false). */
    async copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) { /* fall through to textarea fallback */ }
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            // execCommand returns false on failure — surface it so we never
            // report a successful copy that didn't happen.
            const ok = document.execCommand('copy');
            if (!ok) {
                const store = Alpine.store('global');
                store.showToast(store.t('copyFailed'), 'error');
                return false;
            }
            return true;
        } catch (_) {
            const store = Alpine.store('global');
            store.showToast(store.t('copyFailed'), 'error');
            return false;
        } finally {
            document.body.removeChild(ta);
        }
    },

    // ─── Delete ──────────────────────────────────────────────────────────────

    openDeleteModal(key) {
        this.deleteTarget = key;
        document.getElementById('delete_key_modal').showModal();
    },

    async executeDelete() {
        if (!this.deleteTarget || this.deleting) return;
        this.deleting = true;
        try {
            const res = await fetch(`/api/keys/${this.deleteTarget.id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(await this.parseErrorResponse(res));
            document.getElementById('delete_key_modal').close();
            const store = Alpine.store('global');
            store.showToast(store.t('keyDeleted'), 'success');
            await this.refreshData();
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('deleteFailed') + ': ' + e.message, 'error');
        } finally {
            this.deleting = false;
        }
    },

    // ─── Usage Detail ────────────────────────────────────────────────────────

    async openUsageModal(key) {
        this.usageTarget = key;
        this.usageSummary = null;
        this.recentRecords = [];
        this.usageLoading = true;
        document.getElementById('api_key_usage_modal').showModal();
        await this.fetchUsage(key.id);
    },

    async fetchUsage(id) {
        this.usageLoading = true;
        try {
            const res = await fetch(`/api/keys/${id}/usage`, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.usageSummary = data.summary;
            this.recentRecords = data.recent || [];
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('loadFailed') + ': ' + e.message, 'error');
        } finally {
            this.usageLoading = false;
        }
    },

    async resetUsage() {
        if (!this.usageTarget) return;
        try {
            const res = await fetch(`/api/keys/${this.usageTarget.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resetUsage: true }),
                signal: AbortSignal.timeout(15000)
            });
            if (!res.ok) throw new Error(await this.parseErrorResponse(res));
            const store = Alpine.store('global');
            store.showToast(store.t('usageReset'), 'success');
            await this.refreshData();
            await this.fetchUsage(this.usageTarget.id);
        } catch (e) {
            const store = Alpine.store('global');
            store.showToast(store.t('saveFailed') + ': ' + e.message, 'error');
        }
    },

    // ─── Formatting Helpers ──────────────────────────────────────────────────

    formatTime(ts) {
        void this.agoTick;
        if (!ts) return '-';
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '-';
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
    },

    formatAgo(ts) {
        void this.agoTick;
        if (!ts) return '-';
        const diff = Date.now() - ts;
        if (diff < 60000) return '<1m';
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h`;
        return `${Math.floor(hours / 24)}d`;
    },

    validityText(key) {
        void this.agoTick;
        if (key.durationDays == null) return Alpine.store('global').t('neverExpires');
        return Alpine.store('global').t('daysValid', { count: key.durationDays });
    },

    expiresText(key) {
        void this.agoTick;
        if (!key.expiresAt) return '';
        const remaining = key.expiresAt - Date.now();
        if (remaining <= 0) return Alpine.store('global').t('expired');
        if (remaining < 86400000) {
            const hours = Math.max(1, Math.floor(remaining / 3600000));
            return Alpine.store('global').t('expiresIn', { time: `${hours}h` });
        }
        const days = Math.floor(remaining / 86400000);
        return Alpine.store('global').t('expiresIn', { time: `${days}d` });
    },

    statusText(key) {
        void this.agoTick;
        if (!key.enabled) return Alpine.store('global').t('keyDisabled');
        if (key.expiresAt && key.expiresAt <= Date.now()) return Alpine.store('global').t('keyExpired');
        return Alpine.store('global').t('keyActive');
    },

    statusBadgeClass(key) {
        void this.agoTick;
        if (!key.enabled) return 'bg-surface-3 text-ink-3';
        if (key.expiresAt && key.expiresAt <= Date.now()) return 'bg-danger-soft text-danger';
        return 'bg-ok-soft text-ok';
    },

    quotaUsedText(key) {
        const limit = key.spendingLimit ? key.spendingLimit.limit : 0;
        return `${this.quotaUsed(key).toLocaleString()} / ${limit.toLocaleString()}`;
    },

    // tokens metric = input + output 合计，与后端 checkQuota 保持一致
    quotaUsed(key) {
        if (!key.usage || !key.spendingLimit) return 0;
        if (key.spendingLimit.metric === 'tokens') {
            return (key.usage.inputTokens || 0) + (key.usage.outputTokens || 0);
        }
        return key.usage[key.spendingLimit.metric] || 0;
    },

    quotaPercent(key) {
        if (!key.spendingLimit || !key.spendingLimit.limit) return 0;
        const used = this.quotaUsed(key);
        return Math.min(100, Math.round((used / key.spendingLimit.limit) * 100));
    },

    quotaBarClass(key) {
        const pct = this.quotaPercent(key);
        if (pct >= 100) return 'bg-danger';
        if (pct >= 80) return 'bg-warning';
        return 'bg-brand';
    }
});

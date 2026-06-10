/**
 * Usage Log Viewer Component
 * Displays per-request API usage details (tokens, latency, credits).
 * Registers to window.Components for Alpine.js to consume.
 */
window.Components = window.Components || {};

window.Components.usageLogViewer = () => ({
    records: [],
    loading: false,
    refreshTimer: null,

    init() {
        this.refreshData();

        // Refresh data whenever this tab becomes active
        this.$watch('$store.global.activeTab', (val) => {
            if (val === 'usageLog') this.refreshData();
        });

        // Follow global polling interval
        this.$watch('$store.settings.refreshInterval', () => this.startAutoRefresh());
        this.startAutoRefresh();
    },

    startAutoRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        const interval = parseInt(Alpine.store('settings')?.refreshInterval || 60);
        if (interval > 0) {
            this.refreshTimer = setInterval(() => this.refreshData(), interval * 1000);
        }
    },

    async copyAll() {
        const records = this.records;
        if (!records.length) return;

        // Build TSV: header + one row per record
        const t = Alpine.store('global');
        const header = [
            t.t('time'), t.t('model'), t.t('apiKey'),
            t.t('inputTokens'), t.t('outputTokens'), t.t('cacheRead'), t.t('totalTokens'),
            t.t('requestLatency'), t.t('firstToken'),
            t.t('cost'),
        ].join('\t');

        const rows = records.map(r => [
            this.formatTime(r.timestamp),
            r.model + (r.streaming ? ` (${t.t('streaming')})` : ''),
            r.apiKey,
            r.inputTokens,
            r.outputTokens,
            r.cacheReadTokens,
            r.totalTokens,
            this.formatDuration(r.totalDuration),
            r.timeToFirstToken != null ? this.formatFirstToken(r.timeToFirstToken) : '-',
            this.formatCredits(r.credits),
        ].join('\t'));

        const tsv = [header, ...rows].join('\n');

        try {
            await navigator.clipboard.writeText(tsv);
            if (window.UILogger) window.UILogger.info('Usage log copied to clipboard');
        } catch (e) {
            if (window.UILogger) window.UILogger.error('Copy failed:', e.message);
        }
    },

    async refreshData() {
        this.loading = true;
        try {
            const password = Alpine.store('global').webuiPassword;
            const url = password
                ? `/api/usage-log?password=${encodeURIComponent(password)}`
                : '/api/usage-log';
            const resp = await fetch(url);
            if (resp.ok) {
                const data = await resp.json();
                if (data.status === 'ok') {
                    this.records = data.records || [];
                }
            }
        } catch (e) {
            if (window.UILogger) window.UILogger.debug('Usage log fetch error:', e.message);
        } finally {
            this.loading = false;
        }
    },

    // ── Formatting Helpers ──────────────────────────────────────────────

    /**
     * Format ISO timestamp to local display string.
     */
    formatTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },

    /**
     * Format token count with locale number separators + label.
     */
    formatTokens(type, count) {
        const n = Number(count || 0);
        const formatted = n.toLocaleString('en-US');
        const t = Alpine.store('global');
        switch (type) {
            case 'input':  return `${t.t('inputTokens')}：${formatted}`;
            case 'output': return `${t.t('outputTokens')}：${formatted}`;
            case 'cache':  return `${t.t('cacheRead')}：${formatted}`;
            case 'total':  return `${t.t('totalTokens')}：${formatted}`;
            default:       return formatted;
        }
    },

    /**
     * Format duration in seconds to human-readable string.
     */
    formatDuration(seconds) {
        const s = Number(seconds || 0);
        if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
        return `${s.toFixed(2)} s`;
    },

    /**
     * Format time to first token.
     */
    formatFirstToken(seconds) {
        const t = Alpine.store('global');
        const s = Number(seconds || 0);
        let val;
        if (s < 1) val = `${(s * 1000).toFixed(0)} ms`;
        else val = `${s.toFixed(2)} s`;
        return `${t.t('firstToken')}：${val}`;
    },

    /**
     * Format credits value.
     */
    formatCredits(credits) {
        const c = Number(credits || 0);
        return `${c.toFixed(4)} Credits`;
    },
});

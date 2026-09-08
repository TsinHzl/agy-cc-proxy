/**
 * Usage Log Viewer Component
 * Displays per-request API usage details (tokens, latency, credits).
 * Registers to window.Components for Alpine.js to consume.
 */
window.Components = window.Components || {};

window.Components.usageLogViewer = () => ({
    records: [],
    search: '',
    lastUpdated: 0,
    agoTick: 0,
    get filteredRecords() {
        const q = this.search.trim().toLowerCase();
        if (!q) return this.records;
        return this.records.filter(r =>
            (r.model || '').toLowerCase().includes(q) ||
            (r.apiKey || '').toLowerCase().includes(q)
        );
    },
    get filteredCredits() {
        return this.filteredRecords.reduce((sum, r) => sum + Number(r.credits || 0), 0);
    },
    loading: false,
    copied: false,
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

        // UpdatedAgo 心跳：每 30s 重渲染一次相对时间文案（kiro2cc UpdatedAgo 同机制）
        this.agoTimer = setInterval(() => { this.agoTick++; }, 30000);
    },

    destroy() {
        if (this.agoTimer) clearInterval(this.agoTimer);
        if (this.refreshTimer) clearInterval(this.refreshTimer);
    },

    /**
     * Format last refresh timestamp to relative "ago" string (kiro2cc UpdatedAgo 规格).
     * 消费 this.agoTick：调用方 effect 依赖收集到心跳值，30s 触发文案重渲染。
     */
    formatAgo(ts) {
        void this.agoTick;
        const t = Alpine.store('global');
        const diff = Date.now() - ts;
        if (diff < 0) return t.t('justNow');
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return t.t('secondsAgo', { count: seconds });
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return t.t('minutesAgo', { count: minutes });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t.t('hoursAgo', { count: hours });
        return t.t('daysAgo', { count: Math.floor(hours / 24) });
    },

    startAutoRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        const interval = parseInt(Alpine.store('settings')?.refreshInterval || 60);
        if (interval > 0) {
            this.refreshTimer = setInterval(() => this.refreshData(), interval * 1000);
        } else {
            this.refreshTimer = null;
        }
    },

    copyAll() {
        const records = this.filteredRecords;
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

        // Use textarea fallback — navigator.clipboard requires secure context (HTTPS/localhost)
        const ta = document.createElement('textarea');
        ta.value = tsv;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            document.execCommand('copy');
            this.copied = true;
            Alpine.store('global').showToast(
                t.t('copied') + ' (' + records.length + ')',
                'success'
            );
            setTimeout(() => { this.copied = false; }, 2000);
        } catch (e) {
            if (window.UILogger) window.UILogger.error('Copy failed:', e.message);
        } finally {
            document.body.removeChild(ta);
        }
    },

    async refreshData() {
        this.loading = true;
        try {
            const resp = await fetch('/api/usage-log', { credentials: 'same-origin' });
            if (resp.ok) {
                const data = await resp.json();
                if (data.status === 'ok') {
                    this.records = data.records || [];
                    this.lastUpdated = Date.now();
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

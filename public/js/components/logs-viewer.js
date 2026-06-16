/**
 * Logs Viewer Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

// Module-level pointer to the current active instance.
// A single document listener updates this pointer on every init() so listeners never accumulate.
let _activeLogsViewer = null;
document.addEventListener('visibilitychange', () => {
    if (!_activeLogsViewer) return;
    if (document.hidden) {
        if (_activeLogsViewer.eventSource) {
            _activeLogsViewer.eventSource.close();
            _activeLogsViewer.eventSource = null;
        }
        if (_activeLogsViewer._reconnectTimer) {
            clearTimeout(_activeLogsViewer._reconnectTimer);
            _activeLogsViewer._reconnectTimer = null;
        }
    } else {
        _activeLogsViewer.startLogStream();
    }
});

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    eventSource: null,
    _reconnectTimer: null,
    searchQuery: '',
    filters: {
        INFO: true,
        WARN: true,
        ERROR: true,
        SUCCESS: true,
        DEBUG: false
    },

    get filteredLogs() {
        const query = this.searchQuery.trim();
        if (!query) {
            return this.logs.filter(log => this.filters[log.level]);
        }

        // Try regex first, fallback to plain text search
        let matcher;
        try {
            const regex = new RegExp(query, 'i');
            matcher = (msg) => regex.test(msg);
        } catch (e) {
            // Invalid regex, fallback to case-insensitive string search
            const lowerQuery = query.toLowerCase();
            matcher = (msg) => msg.toLowerCase().includes(lowerQuery);
        }

        return this.logs.filter(log => {
            // Level Filter
            if (!this.filters[log.level]) return false;

            // Search Filter
            return matcher(log.message);
        });
    },

    init() {
        _activeLogsViewer = this;
        this.startLogStream();

        // Sync DEBUG filter with debugLogging sub-toggle
        const settings = Alpine.store('settings');
        if (settings) {
            this.filters.DEBUG = !!settings.debugLogging;
            this.$watch('$store.settings.debugLogging', (val) => {
                this.filters.DEBUG = !!val;
            });
        }

        this.$watch('isAutoScroll', (val) => {
            if (val) this.scrollToBottom();
        });

        // Watch filters to maintain auto-scroll if enabled
        this.$watch('searchQuery', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
        this.$watch('filters', () => { if(this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()) });
    },

    startLogStream() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.eventSource) this.eventSource.close();

        this.eventSource = new EventSource('/api/logs/stream?history=true');
        this.eventSource.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                this.logs.push(log);

                // Limit log buffer
                const limit = Alpine.store('settings')?.logLimit || window.AppConstants.LIMITS.DEFAULT_LOG_LIMIT;
                if (this.logs.length > limit) {
                    this.logs = this.logs.slice(-limit);
                }

                if (this.isAutoScroll) {
                    this.$nextTick(() => this.scrollToBottom());
                }
            } catch (e) {
                if (window.UILogger) window.UILogger.debug('Log parse error:', e.message);
            }
        };

        this.eventSource.onerror = () => {
            if (this._reconnectTimer) return;
            if (window.UILogger) window.UILogger.debug('Log stream disconnected, reconnecting...');
            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this.startLogStream();
            }, 3000);
        };
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        this.logs = [];
    },

    exportLogs() {
        if (this.logs.length === 0) return;

        const shouldRedact = Alpine.store('settings')?.redactMode && window.Redact;
        const lines = this.logs.map(log => {
            const ts = new Date(log.timestamp).toISOString();
            const message = shouldRedact ? window.Redact.logMessage(log.message) : log.message;
            return `[${ts}] [${log.level}] ${message}`;
        });

        const text = lines.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `proxy-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});

/**
 * Logs Viewer Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

// Module-level: single visibilitychange listener via active-instance pointer (no accumulation).
let _activeLogsViewer = null;
document.addEventListener('visibilitychange', () => {
    if (!_activeLogsViewer) return;
    if (document.hidden) {
        _activeLogsViewer._closeStream();
    } else if (_activeLogsViewer._isTabActive) {
        _activeLogsViewer.startLogStream();
    }
});

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    eventSource: null,
    _reconnectTimer: null,
    _isTabActive: false,
    _pendingLogs: [],
    _rafId: null,
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

        let matcher;
        try {
            const regex = new RegExp(query, 'i');
            matcher = (msg) => regex.test(msg);
        } catch (e) {
            const lowerQuery = query.toLowerCase();
            matcher = (msg) => msg.toLowerCase().includes(lowerQuery);
        }

        return this.logs.filter(log => {
            if (!this.filters[log.level]) return false;
            return matcher(log.message);
        });
    },

    init() {
        _activeLogsViewer = this;

        // Watch tab activation: only stream when logs tab is visible
        this.$watch('$store.global.activeTab', (val) => {
            if (val === 'logs') {
                this._isTabActive = true;
                this.startLogStream();
            } else {
                this._isTabActive = false;
                this._closeStream();
            }
        });

        // Start stream if we're already on the logs tab
        if (Alpine.store('global')?.activeTab === 'logs') {
            this._isTabActive = true;
            this.startLogStream();
        }

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

        this.$watch('searchQuery', () => { if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()); });
        this.$watch('filters', () => { if (this.isAutoScroll) this.$nextTick(() => this.scrollToBottom()); });
    },

    _closeStream() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this.eventSource) { this.eventSource.close(); this.eventSource = null; }
        this._flushPending();
    },

    _flushPending() {
        if (this._pendingLogs.length === 0) return;
        const batch = this._pendingLogs;
        this._pendingLogs = [];

        const limit = Alpine.store('settings')?.logLimit || window.AppConstants.LIMITS.DEFAULT_LOG_LIMIT;
        const combined = this.logs.concat(batch);
        this.logs = combined.length > limit ? combined.slice(-limit) : combined;

        if (this.isAutoScroll && !document.hidden && this._isTabActive) {
            this.$nextTick(() => this.scrollToBottom());
        }
    },

    startLogStream() {
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.eventSource) this.eventSource.close();

        this.eventSource = new EventSource('/api/logs/stream?history=true');
        this.eventSource.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                this._pendingLogs.push(log);

                // Guard against rAF throttling in minimized windows: cap pending buffer
                if (this._pendingLogs.length > 500) {
                    this._pendingLogs = this._pendingLogs.slice(-200);
                }

                // Batch DOM updates: flush once per animation frame
                if (!this._rafId) {
                    this._rafId = requestAnimationFrame(() => {
                        this._rafId = null;
                        this._flushPending();
                    });
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
                if (this._isTabActive && !document.hidden) {
                    this.startLogStream();
                }
            }, 3000);
        };
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this.logs = [];
        this._pendingLogs = [];
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

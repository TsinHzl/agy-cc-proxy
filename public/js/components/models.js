/**
 * Models Component
 * Displays model quota/status list
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.models = () => ({
    refreshing: false,

    /**
     * Refresh model quotas and account data (identical to re-entering the models tab)
     */
    async refresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
            await Alpine.store('data').fetchData();
        } finally {
            this.refreshing = false;
        }
    },

    getQuotaBarStyle(percent) {
        const value = Number(percent);
        const width = Number.isFinite(value)
            ? Math.max(0, Math.min(100, value))
            : 0;
        const gradient = width > 60
            ? '--quota-safe-grad'
            : (width > 30
                ? '--quota-mod-grad'
                : (width > 15 ? '--quota-warn-grad' : '--quota-danger-grad'));

        return `width: ${width}%; background-image: var(${gradient})`;
    },

    // Color palette for per-account threshold markers (new semantic tokens)
    thresholdColors: [
        { bg: '#9A6300', shadow: 'rgba(154,99,0,0.5)' },      // warn
        { bg: '#0284c7', shadow: 'rgba(2,132,199,0.5)' },     // mod (chart-14)
        { bg: '#0D7A6F', shadow: 'rgba(13,122,111,0.5)' },    // brand
        { bg: '#137A4C', shadow: 'rgba(19,122,76,0.5)' },     // ok
        { bg: '#BB3538', shadow: 'rgba(187,53,56,0.5)' },     // danger
        { bg: '#d97706', shadow: 'rgba(217,119,6,0.5)' },     // amber (chart-12)
        { bg: '#6366f1', shadow: 'rgba(99,102,241,0.5)' },    // indigo (chart-13)
        { bg: '#818cf8', shadow: 'rgba(129,140,248,0.5)' },   // soft indigo (chart-13 dark)
    ],

    getThresholdColor(index) {
        return this.thresholdColors[index % this.thresholdColors.length];
    },

    // Drag state for threshold markers
    dragging: {
        active: false,
        email: null,
        modelId: null,
        barRect: null,
        currentPct: 0,
        originalPct: 0
    },

    // Tracks which model rows have their per-account breakdown expanded beyond the cap
    expandedModels: new Set(),

    isExpanded(modelId) {
        return this.expandedModels.has(modelId);
    },

    toggleExpanded(modelId) {
        if (this.expandedModels.has(modelId)) {
            this.expandedModels.delete(modelId);
        } else {
            this.expandedModels.add(modelId);
        }
        // Force Alpine reactivity
        this.expandedModels = new Set(this.expandedModels);
    },

    /**
     * Get visible account rows for a model's breakdown, respecting the cap
     */
    getVisibleAccounts(row) {
        const all = row.quotaInfo || [];
        if (Alpine.store('settings').showAllAccounts || this.isExpanded(row.modelId)) {
            return all;
        }
        const limit = window.AppConstants.LIMITS.ACCOUNT_BREAKDOWN_LIMIT;
        return all.slice(0, limit);
    },

    /**
     * Get the number of hidden accounts for a model row
     */
    getHiddenCount(row) {
        const all = row.quotaInfo || [];
        const limit = window.AppConstants.LIMITS.ACCOUNT_BREAKDOWN_LIMIT;
        if (Alpine.store('settings').showAllAccounts || this.isExpanded(row.modelId)) {
            return 0;
        }
        return Math.max(0, all.length - limit);
    },

    // Model editing state (from main)
    editingModelId: null,
    newMapping: '',

    isEditing(modelId) {
        return this.editingModelId === modelId;
    },

    startEditing(modelId) {
        this.editingModelId = modelId;
    },

    stopEditing() {
        this.editingModelId = null;
    },

    /**
     * Start dragging a threshold marker
     */
    startDrag(event, q, row) {
        // Find the progress bar element (closest .relative container)
        const markerEl = event.currentTarget;
        const barContainer = markerEl.parentElement;
        const barRect = barContainer.getBoundingClientRect();

        this.dragging = {
            active: true,
            email: q.fullEmail,
            modelId: row.modelId,
            barRect,
            currentPct: q.thresholdPct,
            originalPct: q.thresholdPct
        };

        // Prevent text selection while dragging
        document.body.classList.add('select-none');

        // Bind document-level listeners for smooth dragging outside the marker
        this._onDrag = (e) => this.onDrag(e);
        this._endDrag = () => this.endDrag();
        document.addEventListener('mousemove', this._onDrag);
        document.addEventListener('mouseup', this._endDrag);
        document.addEventListener('touchmove', this._onDrag, { passive: false });
        document.addEventListener('touchend', this._endDrag);
    },

    /**
     * Handle drag movement — compute percentage from mouse position
     */
    onDrag(event) {
        if (!this.dragging.active) return;
        event.preventDefault();

        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const { left, width } = this.dragging.barRect;
        let pct = Math.round((clientX - left) / width * 100);
        pct = Math.max(0, Math.min(99, pct));

        this.dragging.currentPct = pct;
    },

    /**
     * End drag — save the new threshold value
     */
    endDrag() {
        if (!this.dragging.active) return;

        // Clean up listeners
        document.removeEventListener('mousemove', this._onDrag);
        document.removeEventListener('mouseup', this._endDrag);
        document.removeEventListener('touchmove', this._onDrag);
        document.removeEventListener('touchend', this._endDrag);
        document.body.classList.remove('select-none');

        const { email, modelId, currentPct, originalPct } = this.dragging;

        // Only save if value actually changed
        if (currentPct !== originalPct) {
            // Optimistic in-place update: mutate existing quotaInfo entries directly
            // to avoid full DOM rebuild from computeQuotaRows()
            const dataStore = Alpine.store('data');
            const account = dataStore.accounts.find(a => a.email === email);
            if (account) {
                if (!account.modelQuotaThresholds) account.modelQuotaThresholds = {};
                if (currentPct === 0) {
                    delete account.modelQuotaThresholds[modelId];
                } else {
                    account.modelQuotaThresholds[modelId] = currentPct / 100;
                }
            }
            // Patch quotaRows in-place so Alpine updates without tearing down DOM
            const rows = dataStore.quotaRows || [];
            for (const row of rows) {
                if (row.modelId !== modelId) continue;
                for (const q of row.quotaInfo) {
                    if (q.fullEmail !== email) continue;
                    q.thresholdPct = currentPct;
                }
                // Recompute row-level threshold stats
                const activePcts = row.quotaInfo.map(q => q.thresholdPct).filter(t => t > 0);
                row.effectiveThresholdPct = activePcts.length > 0 ? Math.max(...activePcts) : 0;
                row.hasVariedThresholds = new Set(activePcts).size > 1;
            }
            this.dragging.active = false;
            this.saveModelThreshold(email, modelId, currentPct);
        } else {
            this.dragging.active = false;
        }
    },

    /**
     * Save a per-model threshold for an account via PATCH
     */
    async saveModelThreshold(email, modelId, pct) {
        const store = Alpine.store('global');
        const dataStore = Alpine.store('data');

        const account = dataStore.accounts.find(a => a.email === email);
        if (!account) return;

        // Snapshot for rollback on failure
        const previousModelThresholds = account.modelQuotaThresholds ? { ...account.modelQuotaThresholds } : {};

        // Build full modelQuotaThresholds for API (full replacement, not merge)
        const existingModelThresholds = { ...(account.modelQuotaThresholds || {}) };

        // Preserve the account-level quotaThreshold
        const quotaThreshold = account.quotaThreshold !== undefined ? account.quotaThreshold : null;

        try {
            const { response } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotaThreshold, modelQuotaThresholds: existingModelThresholds })
                }
            );

            const data = await response.json();
            if (data.status === 'ok') {
                const label = pct === 0 ? 'removed' : pct + '%';
                store.showToast(`${email.split('@')[0]} ${modelId} threshold: ${label}`, 'success');
                // Skip fetchData() — optimistic update is already applied,
                // next polling cycle will sync server state
            } else {
                throw new Error(data.error || 'Failed to save threshold');
            }
        } catch (e) {
            // Revert optimistic update on failure
            account.modelQuotaThresholds = previousModelThresholds;
            dataStore.computeQuotaRows();
            store.showToast('Failed to save threshold: ' + e.message, 'error');
        }
    },

    /**
     * Check if a specific marker is currently being dragged
     */
    isDragging(q, row) {
        return this.dragging.active && this.dragging.email === q.fullEmail && this.dragging.modelId === row.modelId;
    },

    /**
     * Get the display percentage for a marker (live during drag, stored otherwise)
     */
    getMarkerPct(q, row) {
        if (this.isDragging(q, row)) return this.dragging.currentPct;
        return q.thresholdPct;
    },

    /**
     * Compute pixel offset for overlapping markers so stacked ones fan out.
     * Markers within 2% of each other are considered overlapping.
     * Returns a CSS pixel offset string (e.g., '6px' or '-6px').
     */
    getMarkerOffset(q, row, qIdx) {
        const pct = this.getMarkerPct(q, row);
        const visible = row.quotaInfo.filter(item => item.thresholdPct > 0 || this.isDragging(item, row));
        // Find all markers within 2% of this one
        const cluster = [];
        visible.forEach((item, idx) => {
            const itemPct = this.getMarkerPct(item, row);
            if (Math.abs(itemPct - pct) <= 2) {
                cluster.push({ item, idx });
            }
        });
        if (cluster.length <= 1) return '0px';
        // Find position of this marker within its cluster
        const posInCluster = cluster.findIndex(c => c.item.fullEmail === q.fullEmail);
        // Spread markers 10px apart, centered on the base position
        const spread = 10;
        const totalWidth = (cluster.length - 1) * spread;
        return (posInCluster * spread - totalWidth / 2) + 'px';
    },

    // Auto model routing state
    autoModel: { enabled: false, models: [] },
    autoChain: [],
    autoExpanded: false,
    autoLoading: false,
    autoSaving: false,
    autoLoaded: false,
    autoDirty: false,
    autoRequestSeq: 0,
    autoError: '',

    /**
     * Load the auto chain from the server. Automatic calls (tab re-entry) never
     * clobber unsaved edits; the explicit Reset button passes `force`.
     */
    async fetchAutoModel({ force = false } = {}) {
        // A forced reload must still win over an in-flight request; only
        // automatic calls are dropped while another load is running.
        if (this.autoLoading && !force) return;
        if (!force && this.autoDirty) return;
        const seq = ++this.autoRequestSeq;
        this.autoLoading = true;
        this.autoError = '';
        try {
            const { response } = await window.utils.request('/api/models/auto');
            if (seq !== this.autoRequestSeq) return;   // a newer request already won
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (seq !== this.autoRequestSeq) return;
            // Edits made while this request was in flight must not be clobbered.
            if (!force && this.autoDirty) return;
            this.applyAutoModel(data.autoModel);
            this.autoChain = data.chain || [];
            this.autoLoaded = true;
        } catch (e) {
            if (seq === this.autoRequestSeq) this.autoError = e.message;
        } finally {
            // Always release the flag: a newer request may own it, but the flag is
            // per-operation state and must never stay latched.
            this.autoLoading = false;
        }
    },

    /**
     * Copy config into local state, ordered by priority so list order always
     * mirrors execution order.
     */
    applyAutoModel(autoModel) {
        const models = Array.isArray(autoModel?.models) ? autoModel.models : [];
        this.autoModel = {
            enabled: autoModel?.enabled === true,
            models: models
                .map(e => ({ model: String(e?.model ?? ''), priority: Number(e?.priority) || 0 }))
                .sort((a, b) => a.priority - b.priority)
        };
        this.autoDirty = false;
    },

    /**
     * Mark local state as edited. Also invalidates any in-flight GET so a
     * response that started before this edit cannot overwrite it.
     */
    markAutoDirty() {
        this.autoDirty = true;
        this.autoRequestSeq++;
    },

    addAutoModelRow() {
        if (this.autoModel.models.length >= 10) return;
        this.autoModel.models.push({ model: '', priority: this.autoModel.models.length + 1 });
        this.markAutoDirty();
    },

    removeAutoModelRow(index) {
        this.autoModel.models.splice(index, 1);
        this.markAutoDirty();
    },

    moveAutoModelRow(index, direction) {
        const target = index + direction;
        const rows = this.autoModel.models;
        if (target < 0 || target >= rows.length) return;
        const [row] = rows.splice(index, 1);
        rows.splice(target, 0, row);
        this.markAutoDirty();
    },

    /**
     * UI order IS priority order: index + 1 is sent for each entry.
     * Server-side validation rejects empty names / duplicates with an
     * index-scoped message, surfaced in autoError without touching config.json.
     */
    async saveAutoModel() {
        if (this.autoSaving) return;
        if (!this.autoLoaded) {
            // Silently returning here would look like a successful save.
            this.autoError = Alpine.store('global').t('loadFailed');
            return;
        }
        const seq = ++this.autoRequestSeq;
        this.autoSaving = true;
        this.autoError = '';
        try {
            const payload = {
                enabled: this.autoModel.enabled === true,
                models: this.autoModel.models.map((e, idx) => ({
                    model: String(e.model || '').trim(),
                    priority: idx + 1
                }))
            };
            const { response } = await window.utils.request('/api/models/auto', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.status !== 'ok') {
                throw new Error(data.error || `HTTP ${response.status}`);
            }
            // Always apply a successful save: this response is authoritative even
            // if another request (e.g. a forced reload) started in the meantime.
            this.applyAutoModel(data.autoModel);
            this.autoChain = data.chain || [];
            Alpine.store('global').showToast(Alpine.store('global').t('autoModelSaved'), 'success');
        } catch (e) {
            // A concurrent forced reload may have raised autoRequestSeq; the save
            // error is still the more useful message for the user.
            this.autoError = e.message;
        } finally {
            // Keep the sequence monotonic so a stale GET cannot win afterwards.
            this.autoRequestSeq = Math.max(this.autoRequestSeq, seq);
            this.autoSaving = false;
        }
    },

    init() {
        // Ensure data is fetched when this tab becomes active (skip initial trigger)
        this.$watch('$store.global.activeTab', (val, oldVal) => {
            if (val === 'models' && oldVal !== undefined) {
                Alpine.store('data').fetchData();
                this.fetchAutoModel();
            }
        });
        this.fetchAutoModel();
    },

    /**
     * Update model configuration (delegates to shared utility)
     * @param {string} modelId - The model ID to update
     * @param {object} configUpdates - Configuration updates (pinned, hidden)
     */
    async updateModelConfig(modelId, configUpdates) {
        return window.ModelConfigUtils.updateModelConfig(modelId, configUpdates);
    }
});

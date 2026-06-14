/**
 * API Keys Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.apiKeys = () => ({
    apiKeys: [],
    loading: false,
    // Create modal
    showCreateModal: false,
    newKeyName: '',
    creating: false,
    createdKey: null,
    // Delete confirmation
    deletingId: null,

    init() {
        if (this.$store.global.settingsTab === 'access') {
            this.fetchKeys();
        }
        this.$watch('$store.global.settingsTab', (tab) => {
            if (tab === 'access') this.fetchKeys();
        });
    },

    async fetchKeys() {
        this.loading = true;
        try {
            const data = await window.utils.request('/api/api-keys');
            this.apiKeys = data.apiKeys || [];
        } catch (e) {
            window.utils.showToast?.('Failed to load API keys', 'error');
        } finally {
            this.loading = false;
        }
    },

    openCreateModal() {
        this.newKeyName = '';
        this.createdKey = null;
        this.showCreateModal = true;
    },

    closeCreateModal() {
        this.showCreateModal = false;
        this.createdKey = null;
        this.newKeyName = '';
    },

    async createKey() {
        this.creating = true;
        try {
            const data = await window.utils.request('/api/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: this.newKeyName })
            });
            this.createdKey = data.apiKey.key;
            await this.fetchKeys();
        } catch (e) {
            window.utils.showToast?.('Failed to create API key', 'error');
        } finally {
            this.creating = false;
        }
    },

    async copyCreatedKey() {
        if (!this.createdKey) return;
        try {
            await navigator.clipboard.writeText(this.createdKey);
            window.utils.showToast?.('Copied to clipboard', 'success');
        } catch (e) {
            window.utils.showToast?.('Copy failed', 'error');
        }
    },

    confirmDelete(id) {
        this.deletingId = id;
    },

    cancelDelete() {
        this.deletingId = null;
    },

    async deleteKey(id) {
        try {
            await window.utils.request(`/api/api-keys/${id}`, { method: 'DELETE' });
            this.deletingId = null;
            await this.fetchKeys();
        } catch (e) {
            window.utils.showToast?.('Failed to delete API key', 'error');
        }
    },

    formatDate(iso) {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    }
});

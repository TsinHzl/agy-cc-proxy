/**
 * API Keys Storage
 *
 * Handles loading and saving managed API keys to disk.
 * Persisted at ~/.config/antigravity-proxy/api-keys.json.
 *
 * Follows the write-lock + atomic-write template from
 * src/account-manager/storage.js (promise-chain serialization,
 * JSON validation before write, tmp+rename atomic replace).
 */

import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { API_KEYS_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Normalize a single key record from disk (field defaults).
 *
 * @param {Object} rec - Raw key record
 * @returns {Object} Normalized record
 */
function normalizeKey(rec) {
    return {
        id: rec.id,
        name: rec.name,
        key: rec.key,
        enabled: rec.enabled !== false,
        durationDays: rec.durationDays ?? null,
        activatedAt: rec.activatedAt ?? null,
        expiresAt: rec.expiresAt ?? null,
        spendingLimit: rec.spendingLimit ?? null,
        allowedAccounts: Array.isArray(rec.allowedAccounts)
            ? rec.allowedAccounts.filter(e => typeof e === 'string' && e.trim())
            : null,
        usage: {
            requests: rec.usage?.requests ?? 0,
            inputTokens: rec.usage?.inputTokens ?? 0,
            outputTokens: rec.usage?.outputTokens ?? 0
        },
        createdAt: rec.createdAt || null,
        lastUsedAt: rec.lastUsedAt ?? null,
        lastUsedIp: rec.lastUsedIp ?? null
    };
}

/**
 * Load managed API keys from disk.
 * Returns default empty state when file does not exist (zero migration).
 *
 * @param {string} keysPath - Path to the keys file
 * @returns {Promise<{version: number, keys: Array}>}
 */
export async function loadApiKeys(keysPath = API_KEYS_PATH) {
    try {
        await access(keysPath, fsConstants.F_OK);
        const data = JSON.parse(await readFile(keysPath, 'utf-8'));
        // Drop malformed records instead of crashing on them (a bad record
        // must not take down the whole key store).
        const rawKeys = Array.isArray(data.keys) ? data.keys : [];
        const keys = rawKeys
            .filter(rec => rec && typeof rec.id === 'string' && typeof rec.key === 'string')
            .map(normalizeKey);
        logger.info(`[ApiKeys] Loaded ${keys.length} API key(s) from config`);
        return { version: data.version || 1, keys };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // No keys file yet - return empty default
            return { version: 1, keys: [] };
        }
        if (error instanceof SyntaxError) {
            logger.error('[ApiKeys] Corrupted api-keys.json, archiving and returning empty state:', error.message);
            // Archive the corrupted file before returning empty state, so a
            // subsequent save cannot permanently overwrite the original data.
            try {
                await rename(keysPath, `${keysPath}.corrupted-${Date.now()}`);
            } catch (renameError) {
                logger.error('[ApiKeys] Failed to archive corrupted file:', renameError.message);
            }
            return { version: 1, keys: [] };
        }
        // Non-ENOENT read errors (EACCES, EISDIR, ...) must abort startup
        // rather than return an empty state — an empty in-memory state would
        // let the next save overwrite the real keys file with nothing.
        logger.error('[ApiKeys] Failed to load API keys:', error.message);
        throw error;
    }
}

/**
 * Save managed API keys to disk (write-lock serialized + atomic replace).
 *
 * @param {Object} state - State to persist ({version, keys})
 * @param {string} keysPath - Path to the keys file
 */
export async function saveApiKeys(state, keysPath = API_KEYS_PATH) {
    // Serialize writes to prevent concurrent corruption
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(keysPath);
        await mkdir(dir, { recursive: true });

        const payload = {
            version: state.version || 1,
            keys: state.keys.map(normalizeKey)
        };

        const json = JSON.stringify(payload, null, 2);

        // Validate JSON before writing (prevent saving corrupt data)
        JSON.parse(json);

        // Atomic write: write to temp file then rename.
        // 0o600: file holds plaintext key secrets, restrict to owner only.
        const tmpPath = keysPath + '.tmp';
        await writeFile(tmpPath, json, { mode: 0o600 });
        await rename(tmpPath, keysPath);
    } catch (error) {
        logger.error('[ApiKeys] Failed to save API keys:', error.message);
        // Rethrow so callers (scheduleSave / flushApiKeys) can surface the
        // failure instead of silently reporting success. The write lock is
        // still released in the finally block below.
        throw error;
    } finally {
        resolve();
    }
}

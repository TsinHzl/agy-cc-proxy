/**
 * Test Quota Reset Cap Handling - Unit Tests (standalone, no server needed)
 *
 * Regression tests for the daily-quota exhaustion chain:
 * 1. parseResetTime keeps trusted quota resets (quotaResetDelay / quotaResetTimeStamp)
 *    beyond the 5m distrust cap (24h sanity cap instead)
 * 2. parseResetTime still clamps untrusted long windows (plain retryDelay) to 5m
 * 3. markRateLimited does not shrink an authoritative QUOTA_EXHAUSTED window
 * 4. resetAllRateLimits preserves authoritative QUOTA_EXHAUSTED windows (> 5m)
 * 5. parseError keeps dotted model ids intact (gemini-3.8-flash-tiered)
 */

const FIFTEEN_HOURS_MS = 15 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              QUOTA RESET CAP HANDLING TEST SUITE              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const { parseResetTime, MAX_RESET_CAP_MS } = await import('../src/cloudcode/rate-limit-parser.js');
    const { markRateLimited, resetAllRateLimits } = await import('../src/account-manager/rate-limits.js');
    const { parseError } = await import('../src/server/parse-error.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assert(condition, message = '') {
        if (!condition) throw new Error(message || 'assertion failed');
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    // ------------------------------------------------------------------
    // 1. Trusted quota resets are not clamped to the 5m cap
    // ------------------------------------------------------------------

    test('quotaResetTimeStamp 15h ahead → not clamped to 5m', () => {
        const ts = new Date(Date.now() + FIFTEEN_HOURS_MS).toISOString();
        const body = JSON.stringify({ error: { code: 429, details: [{ metadata: { quotaResetTimeStamp: ts } }] } });
        const resetMs = parseResetTime(null, body);
        assert(resetMs !== null, 'resetMs should parse');
        assert(resetMs > FIVE_MINUTES_MS, `trusted 15h reset was clamped (got ${resetMs}ms)`);
        assert(resetMs <= FIFTEEN_HOURS_MS + 2000, `resetMs drifted beyond source value (got ${resetMs}ms)`);
    });

    test('quotaResetDelay (seconds form) 15h → not clamped to 5m', () => {
        const body = JSON.stringify({ error: { code: 429, details: [{ metadata: { quotaResetDelay: `${FIFTEEN_HOURS_MS / 1000}.141518082s` } }] } });
        const resetMs = parseResetTime(null, body);
        assert(resetMs !== null, 'resetMs should parse');
        assert(resetMs > FIVE_MINUTES_MS, `trusted 15h reset was clamped (got ${resetMs}ms)`);
    });

    test('trusted reset beyond 24h → sanity-capped to 24h', () => {
        const ts = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const body = JSON.stringify({ error: { code: 429, details: [{ metadata: { quotaResetTimeStamp: ts } }] } });
        const resetMs = parseResetTime(null, body);
        assert(resetMs <= 24 * 60 * 60 * 1000, `trusted reset should sanity-cap at 24h (got ${resetMs}ms)`);
    });

    // ------------------------------------------------------------------
    // 2. Untrusted long windows are still clamped to 5m
    // ------------------------------------------------------------------

    test('plain retryDelay 15h (no quota fields) → clamped to 5m cap', () => {
        const body = JSON.stringify({ error: { code: 429, details: [{ '@type': 'google.rpc.RetryInfo', retryDelay: '54895.141518082s' }] } });
        const resetMs = parseResetTime(null, body);
        assert(resetMs !== null, 'resetMs should parse');
        assertEqual(resetMs, MAX_RESET_CAP_MS, 'untrusted reset must stay clamped to the 5m cap');
    });

    // ------------------------------------------------------------------
    // 3. markRateLimited never shrinks an authoritative quota window
    // ------------------------------------------------------------------

    test('follow-up shorter 429 does not shrink QUOTA_EXHAUSTED window', () => {
        const accounts = [{ email: 'a@test.com', modelRateLimits: Object.create(null) }];
        markRateLimited(accounts, 'a@test.com', FIFTEEN_HOURS_MS, 'gemini-3.8-flash-tiered', 'QUOTA_EXHAUSTED');
        const longResetTime = accounts[0].modelRateLimits['gemini-3.8-flash-tiered'].resetTime;

        // Next endpoint's no-reset smart backoff (1m) must not overwrite the 15h window
        markRateLimited(accounts, 'a@test.com', ONE_MINUTE_MS, 'gemini-3.8-flash-tiered', 'QUOTA_EXHAUSTED');
        assertEqual(
            accounts[0].modelRateLimits['gemini-3.8-flash-tiered'].resetTime,
            longResetTime,
            'shorter follow-up 429 shrank the authoritative window'
        );
        assert(accounts[0].modelRateLimits['gemini-3.8-flash-tiered'].resetTime - Date.now() > FIVE_MINUTES_MS,
            'preserved window should still exceed 5m');
    });

    test('longer follow-up window still extends the cooldown', () => {
        const accounts = [{ email: 'a@test.com', modelRateLimits: Object.create(null) }];
        markRateLimited(accounts, 'a@test.com', ONE_MINUTE_MS, 'm1', 'QUOTA_EXHAUSTED');
        const before = accounts[0].modelRateLimits.m1.resetTime;
        markRateLimited(accounts, 'a@test.com', FIFTEEN_HOURS_MS, 'm1', 'QUOTA_EXHAUSTED');
        assert(accounts[0].modelRateLimits.m1.resetTime > before, 'longer window should extend resetTime');
    });

    test('non-quota windows keep last-write-wins behavior', () => {
        const accounts = [{ email: 'a@test.com', modelRateLimits: Object.create(null) }];
        markRateLimited(accounts, 'a@test.com', ONE_MINUTE_MS, 'm1', null);
        markRateLimited(accounts, 'a@test.com', 30 * 1000, 'm1', null);
        assert(accounts[0].modelRateLimits.m1.resetTime - Date.now() <= 30 * 1000,
            'non-quota windows should not be protected from overwriting');
    });

    // ------------------------------------------------------------------
    // 4. resetAllRateLimits preserves authoritative quota windows
    // ------------------------------------------------------------------

    test('optimistic retry keeps >5m QUOTA_EXHAUSTED, clears the rest', () => {
        const accounts = [{
            email: 'a@test.com',
            modelRateLimits: {
                trusted: { isRateLimited: true, resetTime: Date.now() + FIFTEEN_HOURS_MS, actualResetMs: FIFTEEN_HOURS_MS, reason: 'QUOTA_EXHAUSTED' },
                shortQuota: { isRateLimited: true, resetTime: Date.now() + 2 * ONE_MINUTE_MS, actualResetMs: 2 * ONE_MINUTE_MS, reason: 'QUOTA_EXHAUSTED' },
                untrustedLong: { isRateLimited: true, resetTime: Date.now() + FIFTEEN_HOURS_MS, actualResetMs: FIFTEEN_HOURS_MS, reason: null }
            }
        }];
        resetAllRateLimits(accounts);

        assert(accounts[0].modelRateLimits.trusted.isRateLimited === true,
            '>5m QUOTA_EXHAUSTED window must survive optimistic retry');
        assert(accounts[0].modelRateLimits.trusted.resetTime - Date.now() > FIVE_MINUTES_MS,
            'surviving window must keep its long resetTime');
        assert(accounts[0].modelRateLimits.shortQuota.isRateLimited === false,
            '≤5m quota window should still be reset');
        assert(accounts[0].modelRateLimits.untrustedLong.isRateLimited === false,
            'unclassified long window should still be reset');
    });

    // ------------------------------------------------------------------
    // 5. parseError keeps dotted model ids intact
    // ------------------------------------------------------------------

    test('parseError preserves dotted model id (gemini-3.8-flash-tiered)', () => {
        const err = new Error('RESOURCE_EXHAUSTED: Rate limited on gemini-3.8-flash-tiered. Quota will reset after 5m0s. Next available: 2026-11-14T00:31:21.000Z');
        const { errorType, statusCode, errorMessage } = parseError(err);
        assertEqual(statusCode, 429, 'quota exhaustion must surface as 429');
        assertEqual(errorType, 'rate_limit_error', 'quota exhaustion must map to rate_limit_error');
        assert(errorMessage.includes('gemini-3.8-flash-tiered'),
            `model id was truncated in client message: "${errorMessage}"`);
    });

    test('parseError model match still works for dot-free ids', () => {
        const err = new Error('RESOURCE_EXHAUSTED: Rate limited on claude-opus-4-5. Quota will reset after 1m0s.');
        const { errorMessage } = parseError(err);
        assert(errorMessage.includes('claude-opus-4-5'),
            `dot-free model id should be preserved: "${errorMessage}"`);
    });

    console.log('\n' + '═'.repeat(64));
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('═'.repeat(64));
    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});

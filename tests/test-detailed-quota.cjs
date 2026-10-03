/**
 * Test Detailed Quota - Unit and integration tests for detailed quota summary parsing
 *
 * Verifies that:
 * 1. fetchUserQuotaSummary correctly handles camelCase and snake_case API responses
 * 2. Bucket remaining fraction and reset time logic properly handles exhausted vs unmetered states
 * 3. Multi-endpoint failover (daily -> sandbox -> prod) works as expected
 * 4. Error states degrade gracefully to empty array []
 * 5. getDetailedAccountQuotas returns both models mapping and quota_groups array
 */

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           DETAILED QUOTA TEST SUITE                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { fetchUserQuotaSummary, getDetailedAccountQuotas } = await import('../src/cloudcode/model-api.js');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    // Test 1: Invalid/empty token handling
    await test('Empty or invalid token returns empty array', async () => {
        const res1 = await fetchUserQuotaSummary(null);
        assertEqual(res1, [], 'Null token should return empty array');
        const res2 = await fetchUserQuotaSummary('');
        assertEqual(res2, [], 'Empty string token should return empty array');
    });

    // Test 2: Normalization of camelCase quota groups
    await test('Normalizes camelCase upstream quota payload structure', async () => {
        const rawResponse = {
            quotaGroups: [
                {
                    displayName: 'Claude Models',
                    description: 'Quota for Claude 3.5 Sonnet and Haiku',
                    buckets: [
                        { window: '5h', remainingFraction: 0.85, resetTime: '2026-10-03T18:00:00Z' },
                        { window: '7d', remainingFraction: null, resetTime: null }
                    ]
                }
            ]
        };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => rawResponse
        });

        try {
            const result = await fetchUserQuotaSummary('mock-valid-token');
            assertEqual(result.length, 1);
            assertEqual(result[0].display_name, 'Claude Models');
            assertEqual(result[0].description, 'Quota for Claude 3.5 Sonnet and Haiku');
            assertEqual(result[0].buckets.length, 2);
            assertEqual(result[0].buckets[0], {
                window: '5h',
                remaining_fraction: 0.85,
                reset_time: '2026-10-03T18:00:00Z'
            });
            assertEqual(result[0].buckets[1], {
                window: '7d',
                remaining_fraction: null,
                reset_time: null
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // Test 3: Normalization of snake_case upstream quota payload structure
    await test('Normalizes snake_case upstream quota payload structure', async () => {
        const rawResponse = {
            quota_groups: [
                {
                    display_name: 'Gemini Models',
                    description: 'Quota for Gemini 1.5 Pro',
                    buckets: [
                        { window: '1d', remaining_fraction: 0.15, reset_time: '2026-10-04T00:00:00Z' },
                        { window: '1h', remaining_fraction: null, reset_time: '2026-10-03T15:00:00Z' }
                    ]
                }
            ]
        };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => rawResponse
        });

        try {
            const result = await fetchUserQuotaSummary('mock-valid-token');
            assertEqual(result.length, 1);
            assertEqual(result[0].display_name, 'Gemini Models');
            assertEqual(result[0].buckets[0].remaining_fraction, 0.15);
            // When remaining_fraction is null but reset_time is present, it indicates exhausted (0)
            assertEqual(result[0].buckets[1].remaining_fraction, 0);
            assertEqual(result[0].buckets[1].reset_time, '2026-10-03T15:00:00Z');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // Test 4: Endpoint failover handling
    await test('Fails over across endpoints when first endpoint errors', async () => {
        let callCount = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            callCount++;
            if (callCount === 1) {
                return { ok: false, status: 500, text: async () => 'Internal Server Error' };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    quotaGroups: [
                        {
                            displayName: 'Failover Group',
                            buckets: [{ window: '1h', remainingFraction: 1.0 }]
                        }
                    ]
                })
            };
        };

        try {
            const result = await fetchUserQuotaSummary('mock-valid-token');
            assertEqual(result.length, 1);
            assertEqual(result[0].display_name, 'Failover Group');
            if (callCount < 2) {
                throw new Error(`Expected at least 2 attempts, but got ${callCount}`);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // Test 5: Graceful degradation when all endpoints fail
    await test('Gracefully returns empty array when all endpoints reject', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable'
        });

        try {
            const result = await fetchUserQuotaSummary('mock-valid-token');
            assertEqual(result, []);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // Test 6: getDetailedAccountQuotas returns both models and quota_groups
    await test('getDetailedAccountQuotas returns models and quota_groups structure', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            if (String(url).includes('retrieveUserQuotaSummary')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        quotaGroups: [{ displayName: 'Group A', buckets: [] }]
                    })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    models: {
                        'claude-3-5-sonnet': {
                            displayName: 'Claude 3.5 Sonnet',
                            quotaInfo: { remainingFraction: 0.9 }
                        }
                    }
                })
            };
        };

        try {
            const result = await getDetailedAccountQuotas('mock-token', 'proj-123');
            if (!result || typeof result !== 'object') {
                throw new Error('Result must be an object');
            }
            if (!result.models || typeof result.models !== 'object') {
                throw new Error('Result must contain models object');
            }
            if (!Array.isArray(result.quota_groups)) {
                throw new Error('Result must contain quota_groups array');
            }
            assertEqual(result.quota_groups.length, 1);
            assertEqual(result.quota_groups[0].display_name, 'Group A');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

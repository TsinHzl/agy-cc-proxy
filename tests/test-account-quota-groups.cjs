const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createAccountManager() {
    const source = fs.readFileSync(
        path.join(__dirname, '../public/js/components/account-manager.js'),
        'utf8'
    );
    const context = {
        Alpine: { store: () => ({}) },
        document: { getElementById: () => ({ showModal: () => {} }) },
        localStorage: { getItem: () => null, setItem: () => {} },
        window: {
            Components: {},
            utils: { formatTimeUntil: resetTime => `in ${resetTime}` }
        }
    };

    vm.runInNewContext(source, context);
    return context.window.Components.accountManager();
}

function assertJsonEqual(actual, expected) {
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

function runTests() {
    const component = createAccountManager();
    assert.equal(
        component.getQuotaBarStyle(61),
        'width: 61%; background-image: var(--quota-safe-grad)'
    );
    assert.equal(
        component.getQuotaBarStyle(60),
        'width: 60%; background-image: var(--quota-mod-grad)'
    );
    assert.equal(
        component.getQuotaBarStyle(30),
        'width: 30%; background-image: var(--quota-warn-grad)'
    );
    assert.equal(
        component.getQuotaBarStyle(15),
        'width: 15%; background-image: var(--quota-danger-grad)'
    );

    component.openQuotaModal({
        email: 'quota@example.com',
        limits: {},
        quota_groups: [
            {
                display_name: 'Gemini Models',
                description: 'Gemini Flash, Gemini Pro',
                buckets: [
                    { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, reset_time: '2026-10-08T09:22:04Z' },
                    { window: '5h', remaining_fraction: 1, reset_time: '2026-10-04T12:37:58Z' },
                    { window: '1d', remaining_fraction: 0.5, reset_time: null }
                ]
            },
            {
                display_name: 'Claude and GPT models',
                description: 'Claude Opus, Claude Sonnet, GPT-OSS',
                buckets: [
                    { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-11T09:20:52Z' },
                    { window: '5h', remaining_fraction: 1, reset_time: '2026-10-04T14:20:52Z' }
                ]
            },
            {
                display_name: 'Other Models',
                buckets: [{ window: '7d', remaining_fraction: 0.5, reset_time: null }]
            }
        ]
    });

    assert.equal(component.selectedAccountQuotaGroups.length, 3);

    const noGroupComponent = createAccountManager();
    noGroupComponent.openQuotaModal({
        email: 'limits-only@example.com',
        limits: { 'claude-sonnet-4-6': { remainingFraction: 1 } }
    });
    assert.equal(noGroupComponent.activeQuotaTab, 'model');

    const cardQuotaModels = component.getCardQuotaModels({
        limits: {
            'gemini-3.8-flash-tiered': {
                remainingFraction: 1,
                resetTime: '2026-10-04T12:37:58Z'
            }
        }
    });
    assert.equal(cardQuotaModels[0].countdown, 'in 2026-10-04T12:37:58Z');

    const groups = component.getDetailedQuotaGroups();
    assertJsonEqual(groups, [
        {
            id: 'gemini',
            name: 'Gemini Models',
            description: 'Gemini Flash, Gemini Pro',
            buckets: [
                { id: 'weekly', apiWindow: '7d', label: 'WEEKLY', percent: 88, resetTime: '2026-10-08T09:22:04Z' },
                { id: 'five-hour', apiWindow: '5h', label: '5H', percent: 100, resetTime: '2026-10-04T12:37:58Z' }
            ]
        },
        {
            id: 'claude-gpt',
            name: 'Claude and GPT models',
            description: 'Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
                { id: 'weekly', apiWindow: '7d', label: 'WEEKLY', percent: 100, resetTime: '2026-10-11T09:20:52Z' },
                { id: 'five-hour', apiWindow: '5h', label: '5H', percent: 100, resetTime: '2026-10-04T14:20:52Z' }
            ]
        }
    ]);

    component.selectedAccountQuotaGroups = [{ display_name: 'Gemini Models', buckets: [] }];
    assertJsonEqual(component.getDetailedQuotaGroups()[0].buckets, [
        { id: 'weekly', apiWindow: '7d', label: 'WEEKLY', percent: null, resetTime: null },
        { id: 'five-hour', apiWindow: '5h', label: '5H', percent: null, resetTime: null }
    ]);

    const template = fs.readFileSync(path.join(__dirname, '../public/views/accounts.html'), 'utf8');
    assert.match(template, /activeQuotaTab === 'detailed'/);
    assert.match(template, /getDetailedQuotaGroups\(\)/);
    assert.match(template, /bucket\.label/);
    assert.match(template, /bucket\.resetTime/);
    assert.match(template, /<div\s+:style="getQuotaBarStyle\(quota\.percent\)"\s*><\/div>/);
    assert.match(template, /<div\s+:style="getQuotaBarStyle\(acc\.healthScore\)"\s*><\/div>/);
    assert.match(template, /<div\s+class="transition-all duration-500"\s+:style="getQuotaBarStyle\(limit\.remainingFraction \* 100\)"\s*>/);
    assert.match(template, /<div\s+class="transition-all duration-500"\s+:style="getQuotaBarStyle\(bucket\.percent \|\| 0\)"\s*>/);
    assert.doesNotMatch(template, /quota-tier-(?:safe|mod|warn|danger)/);

    console.log('✓ Account detailed quota groups map Weekly and 5H buckets');
}

runTests();

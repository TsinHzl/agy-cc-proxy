/**
 * Models Quota Bars Regression Tests
 * Ensures Models page owns its quota-bar gradients rather than deleted global CSS.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const modelsScriptPath = path.join(projectRoot, 'public/js/components/models.js');
const modelsViewPath = path.join(projectRoot, 'public/views/models.html');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (error) {
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
        failed++;
    }
}

function createModelsComponent() {
    const context = {
        window: { Components: {} },
        Alpine: {},
        console
    };

    vm.runInNewContext(fs.readFileSync(modelsScriptPath, 'utf8'), context, {
        filename: modelsScriptPath
    });

    return context.window.Components.models();
}

test('按配额边界返回正确的内联渐变样式', () => {
    const models = createModelsComponent();

    assert.equal(typeof models.getQuotaBarStyle, 'function');
    assert.equal(
        models.getQuotaBarStyle(15),
        'width: 15%; background-image: var(--quota-danger-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle(16),
        'width: 16%; background-image: var(--quota-warn-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle(31),
        'width: 31%; background-image: var(--quota-mod-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle(61),
        'width: 61%; background-image: var(--quota-safe-grad)'
    );
});

test('将无效与越界配额限制在 0 至 100', () => {
    const models = createModelsComponent();

    assert.equal(
        models.getQuotaBarStyle(null),
        'width: 0%; background-image: var(--quota-danger-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle('invalid'),
        'width: 0%; background-image: var(--quota-danger-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle(-1),
        'width: 0%; background-image: var(--quota-danger-grad)'
    );
    assert.equal(
        models.getQuotaBarStyle(101),
        'width: 100%; background-image: var(--quota-safe-grad)'
    );
});

test('四个 Models 配额条均使用内联渐变且不依赖 quota-tier CSS', () => {
    const html = fs.readFileSync(modelsViewPath, 'utf8');

    assert.equal((html.match(/quota-tier-(?:safe|mod|warn|danger)/g) || []).length, 0);
    assert.equal(
        (html.match(/:style="getQuotaBarStyle\((?:row\.avgQuota \?\? 0|q\.pct)\)"/g) || []).length,
        4
    );
});

console.log(`\n测试完成：${passed} 通过，${failed} 失败`);

if (failed > 0) {
    process.exit(1);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createModelsComponent() {
    const source = fs.readFileSync(
        path.join(__dirname, '../public/js/components/models.js'),
        'utf8'
    );
    const context = {
        window: { Components: {} }
    };

    vm.runInNewContext(source, context);
    return context.window.Components.models();
}

function runTests() {
    const component = createModelsComponent();
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
    assert.equal(
        component.getQuotaBarStyle('invalid'),
        'width: 0%; background-image: var(--quota-danger-grad)'
    );

    const template = fs.readFileSync(path.join(__dirname, '../public/views/models.html'), 'utf8');
    const styleBindings = template.match(/:style="getQuotaBarStyle\((?:row\.avgQuota \?\? 0|q\.pct)\)"/g) || [];
    assert.equal(styleBindings.length, 4);
    assert.doesNotMatch(template, /quota-tier-(?:safe|mod|warn|danger)/);

    console.log('✓ Models quota bars render threshold gradients through inline styles');
}

runTests();

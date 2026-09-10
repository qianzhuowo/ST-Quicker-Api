import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createPlatformAdapter, inspectSettingsSave } from '../platform.js';

const empty = () => ({ includeBody: '', excludeBody: '', includeHeaders: '' });
const parameters = label => ({ includeBody: `tag: ${label}`, excludeBody: '["temperature"]', includeHeaders: `X-Test: ${label}` });
const scoped = values => ({ include_body: values.includeBody, exclude_body: values.excludeBody, include_headers: values.includeHeaders });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function makeHost(modern, accessor) {
    const native = { chat_completion_source: 'custom', custom_include_body: 'stale legacy body', custom_exclude_body: '', custom_include_headers: '' };
    if (modern) Object.assign(native, { custom_api_format: 'openai_compat', additional_parameters_by_source: {} });
    const getParameters = (settings, source, { create = true } = {}) => {
        source ??= settings.chat_completion_source === 'custom' && settings.custom_api_format !== 'openai_compat'
            ? `custom_${settings.custom_api_format}` : settings.chat_completion_source;
        const store = settings.additional_parameters_by_source;
        if (!isRecord(store)) throw new Error('Invalid parameter store');
        const entry = store[source] ?? scoped(empty());
        if (!isRecord(entry)) throw new Error('Invalid parameter entry');
        if (create) store[source] = entry;
        return entry;
    };
    const calls = [];
    const saveSettingsDebounced = () => {};
    const platform = createPlatformAdapter({
        openai: { oai_settings: native, chat_completion_sources: { CUSTOM: 'custom' },
            ...(modern ? { getAdditionalParametersForSource: accessor ? accessor(native) : getParameters } : {}) },
        settingsApi: { saveSettingsDebounced, ...(modern ? { cancelPendingSettingsSave: () => calls.push('native-cancel') } : {}) },
        cancelDebounce: fn => { assert.equal(fn, saveSettingsDebounced); calls.push('legacy-cancel'); },
    });
    return { native, platform, calls };
}

for (const modern of [false, true]) {
    const name = modern ? 'source-scoped host' : 'legacy host';
    test(`${name}: parameter round trip and empty Profile clears previous values`, () => {
        const { native, platform } = makeHost(modern);
        platform.writeAdditionalParameters(parameters('A'), 'custom');
        assert.deepEqual(platform.readAdditionalParameters('custom'), parameters('A'));
        platform.writeAdditionalParameters(parameters('B'), 'custom');
        assert.deepEqual(platform.readAdditionalParameters('custom'), parameters('B'));
        platform.writeAdditionalParameters(empty(), 'custom');
        assert.deepEqual(platform.readAdditionalParameters('custom'), empty());
        if (modern) assert.equal(native.custom_include_body, 'stale legacy body');
    });
    test(`${name}: snapshot/rollback restores values and property presence`, () => {
        const { native, platform } = makeHost(modern);
        platform.writeAdditionalParameters(parameters('before'), 'custom');
        const original = structuredClone(native);
        const entry = native.additional_parameters_by_source?.custom;
        const snapshot = platform.snapshotConnectionState();
        platform.selectSource('claude');
        platform.writeAdditionalParameters(parameters('after'), 'claude');
        platform.restoreConnectionState(snapshot);
        assert.deepEqual(native, original);
        if (modern) assert.equal(native.additional_parameters_by_source.custom, entry);
    });
    test(`${name}: chooses the appropriate debounce cancellation contract`, () => {
        const { platform, calls } = makeHost(modern);
        platform.cancelSettingsSave();
        assert.deepEqual(calls, [modern ? 'native-cancel' : 'legacy-cancel']);
        assert.equal(platform.handlesRequestExclusions, modern);
    });
}

test('scoped reads never resurrect stale legacy parameters or another source', () => {
    const { native, platform } = makeHost(true);
    assert.deepEqual(platform.readAdditionalParameters('custom'), empty());
    assert.deepEqual(native.additional_parameters_by_source, {});
    native.additional_parameters_by_source.claude = scoped(parameters('Claude native'));
    platform.writeAdditionalParameters({ excludeBody: '["top_p"]' }, 'claude');
    assert.deepEqual(platform.readAdditionalParameters('claude'), { ...parameters('Claude native'), excludeBody: '["top_p"]' });
    assert.deepEqual(platform.readAdditionalParameters('custom'), empty());
    platform.writeAdditionalParameters(parameters('Custom'), 'custom');
    platform.writeAdditionalParameters({ excludeBody: '["top_k"]' }, 'makersuite');
    assert.equal(platform.readAdditionalParameters('claude').includeHeaders, 'X-Test: Claude native');
    assert.equal(platform.readAdditionalParameters('custom').includeHeaders, 'X-Test: Custom');
});

test('Custom subprotocols are not mistaken for OpenAI Compatible and survive rollback', () => {
    const { native, platform } = makeHost(true);
    native.custom_api_format = 'openai_responses';
    native.additional_parameters_by_source.custom_openai_responses = scoped(parameters('Responses'));
    const before = structuredClone(native);
    const snapshot = platform.snapshotConnectionState();
    assert.equal(platform.matchesSource('custom'), false);
    assert.equal(platform.supportsCustomConnection(), false);
    platform.writeAdditionalParameters(parameters('Compat'), 'custom');
    platform.selectSource('custom');
    assert.equal(native.custom_api_format, 'openai_compat');
    assert.equal(platform.matchesSource('custom'), true);
    assert.equal(native.additional_parameters_by_source.custom_openai_responses.include_body, 'tag: Responses');
    platform.restoreConnectionState(snapshot);
    assert.deepEqual(native, before);
});

test('unknown scoped host contract fails explicitly rather than writing legacy fields', () => {
    const { native, platform } = makeHost(false);
    native.additional_parameters_by_source = {};
    assert.throws(() => platform.writeAdditionalParameters(parameters('A'), 'custom'), /no supported parameter accessor/);
    assert.equal(native.custom_include_body, 'stale legacy body');
});

test('invalid scoped data fails without silently applying a partial Profile', () => {
    const { native, platform } = makeHost(true);
    native.additional_parameters_by_source = null;
    assert.throws(() => platform.readAdditionalParameters(), /Invalid parameter store/);
});

const base = { profiles: [{ id: 'a', includeBody: 'old' }], presetBindings: { A: 'a' }, quickActions: [], activeProfileId: 'a' };
const revision = { hash_algorithm: 'tt-user-settings-stable-sha256-v1', settings_hash: '1'.repeat(64) };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function inspectPatch(ops, baseline = base) {
    return await inspectSettingsSave({ path: '/api/settings/patch', moduleName: 'quickerApi',
        baselineSnapshot: baseline === undefined ? '' : JSON.stringify(baseline),
        options: { body: JSON.stringify({ base_hash: '0'.repeat(64), ops }) } });
}

test('delta saves reconstruct the exact plugin subtree, not live newer settings', async () => {
    const observed = await inspectPatch([
        { op: 'set', path: ['extension_settings', 'quickerApi', 'profiles'], value: [{ id: 'a', includeBody: 'saved' }] },
        { op: 'delete', path: ['extension_settings', 'quickerApi', 'presetBindings', 'A'] },
        { op: 'set', path: ['oai_settings', 'custom_model'], value: 'ignored' },
        { op: 'set', path: ['extension_settings', 'otherPlugin'], value: { unrelated: true } },
    ]);
    assert.deepEqual(JSON.parse(observed.snapshot), { ...base, profiles: [{ id: 'a', includeBody: 'saved' }], presetBindings: {} });
    assert.equal(base.profiles[0].includeBody, 'old');
    assert.equal(await observed.succeeded(jsonResponse(revision)), true);
});

for (const scope of [[], ['extension_settings'], ['extension_settings', 'quickerApi']]) {
    test(`delta replacement at ${JSON.stringify(scope)} is supported without a baseline`, async () => {
        const value = scope.length === 0 ? { extension_settings: { quickerApi: base } } : scope.length === 1 ? { quickerApi: base } : base;
        const observed = await inspectPatch([{ op: 'set', path: scope, value }], null);
        assert.deepEqual(JSON.parse(observed.snapshot), base);
    });
}

test('empty delta verifies an unchanged snapshot; malformed or unresolvable deltas do not confirm', async () => {
    assert.equal((await inspectPatch([])).snapshot, JSON.stringify(base));
    assert.equal(await inspectPatch([{ op: 'set', path: ['extension_settings', 'quickerApi', 'missing', 'nested'], value: true }]), null);
    assert.equal(await inspectPatch([{ op: 'unknown', path: [] }]), null);
    assert.equal(await inspectPatch([{ op: 'delete', path: ['extension_settings', 'quickerApi'] }]), null);
    assert.equal(await inspectPatch([], null), null);
});

test('patch failures, conflicts and invalid revisions are not reported as saved', async () => {
    const observed = await inspectPatch([]);
    assert.equal(await observed.succeeded(jsonResponse({}, 500)), false);
    assert.equal(await observed.succeeded(jsonResponse({}, 409)), false);
    assert.equal(await observed.succeeded(jsonResponse({})), false);
    assert.equal(await observed.succeeded(jsonResponse({ ...revision, settings_hash: 'bad' })), false);
    const response = jsonResponse(revision);
    assert.equal(await observed.succeeded(response), true);
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), revision);
});

test('delta property names cannot pollute prototypes', async () => {
    const observed = await inspectPatch([{ op: 'set', path: ['extension_settings', 'quickerApi', '__proto__'], value: { polluted: true } }]);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(JSON.parse(observed.snapshot).__proto__, { polluted: true });
});

for (const kind of ['string', 'request', 'gzip']) {
    test(`full settings save supports ${kind} bodies without consuming the caller body`, async () => {
        const body = JSON.stringify({ extension_settings: { quickerApi: base } });
        const request = new Request('http://localhost/api/settings/save', { method: 'POST', body });
        const options = kind === 'request' ? {} : kind === 'gzip'
            ? { headers: { 'Content-Encoding': 'gzip' }, body: gzipSync(body) } : { body };
        const observed = await inspectSettingsSave({ path: '/api/settings/save', moduleName: 'quickerApi', resource: request, options });
        assert.equal(observed.snapshot, JSON.stringify(base));
        assert.equal(await observed.succeeded(jsonResponse({})), true);
        assert.equal(await observed.succeeded(jsonResponse({}, 503)), false);
        assert.equal(request.bodyUsed, false);
        assert.equal(await request.text(), body);
    });
}

test('unrelated and unparseable requests pass through without save acknowledgement', async () => {
    for (const [path, body] of [['/api/presets/save', '{}'], ['/api/settings/save', 'not JSON'], ['/api/settings/patch', '{}']]) {
        assert.equal(await inspectSettingsSave({ path, moduleName: 'quickerApi', options: { body } }), null);
    }
});

// Optional source-contract check: runs the provided host's real accessor, rather
// than only its test double. No host startup, account data or backend is needed.
test('TauriTavern source contract: real accessor works with the same adapter', { skip: !process.env.TT_SOURCE_DIR }, async () => {
    const source = await readFile(path.join(process.env.TT_SOURCE_DIR, 'src/scripts/openai.js'), 'utf8');
    const start = source.indexOf('function createAdditionalParametersEntry()');
    const end = source.indexOf('function getLegacyAdditionalParameters(settings)');
    assert.ok(start >= 0 && end > start, 'Update the source-contract test when the host helper layout changes');
    const constants = ['custom_api_formats', 'custom_source_variants'].map(name => {
        const match = source.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`));
        assert.ok(match, `${name} declaration missing`);
        return match[0];
    }).join('\n');
    const factory = new Function('oai_settings', 'chat_completion_sources', `${constants}\n${source.slice(start, end).replace(/^export /gm, '')}\nreturn getAdditionalParametersForSource;`);
    const { native, platform } = makeHost(true, native => factory(native, { CUSTOM: 'custom', OPENAI: 'openai' }));
    platform.writeAdditionalParameters(parameters('real host'), 'custom');
    assert.deepEqual(platform.readAdditionalParameters(), parameters('real host'));
    platform.selectSource('claude');
    platform.writeAdditionalParameters({ excludeBody: '["top_p"]' }, 'claude');
    assert.equal(native.additional_parameters_by_source.custom.include_body, 'tag: real host');
    assert.equal(native.additional_parameters_by_source.claude.exclude_body, '["top_p"]');
    assert.equal(native.custom_include_body, 'stale legacy body');
});

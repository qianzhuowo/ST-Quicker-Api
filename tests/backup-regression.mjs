import assert from 'node:assert/strict';

// Backup and restore: one JSON file with the plugin's own data. Keys are written
// in plaintext only when asked. Restoring only adds: existing Profiles, secrets
// and native proxy presets are never replaced, and choosing a file has no deadline.
export async function runBackupRegressions({ page, state, log }) {
    const run = page.evaluate;
    const waitFor = async (expression, message) => {
        for (let i = 0; i < 100; i++) {
            if (await run(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error(message || `timed out waiting for ${expression}`);
    };
    const settle = () => waitFor('pendingOperations === 0 && !presetTransitionBlocked', 'operations did not settle');
    const customSecrets = () => state.secrets.api_key_custom;
    const activeCustom = () => customSecrets().find(entry => entry.active)?.id;
    const restore = (text, choice) => run(`(async () => {
        messages.length = 0;
        const choice = ${JSON.stringify(choice)};
        const result = await enqueueOperation(() => restoreBackup(parseBackup(${JSON.stringify(text)}), { ...choice, profiles: new Set(choice.profiles) }));
        return { result, messages: messages.map(item => item.level + ':' + item.message) };
    })()`);
    const none = { profiles: [], quickActions: false, quickUrls: false, presetBindings: false, preferences: false };

    await settle();
    state.secrets = {
        api_key_custom: [{ id: 'sid-a', active: true }, { id: 'sid-b', active: false }, { id: 'sid-solo', active: false }],
        api_key_claude: [{ id: 'test-secret', active: true }], api_key_makersuite: [{ id: 'test-secret', active: true }],
    };
    state.secretValues = { api_key_custom: { 'sid-a': 'sk-pool-a', 'sid-b': 'sk-pool-b', 'sid-solo': 'sk-solo' } };
    state.recordSecretValues = true;
    try {
        await run(`(async () => {
            proxies.length = 0;
            proxies.push({ name: 'Quicker · native-proxy-name', url: 'https://proxy.invalid', password: 'proxy-pass' });
            settings().profiles = [
                normalizeProfile({ id: 'b-pool', name: 'Pool', format: 'openai', endpoint: 'https://pool.invalid/v1', model: 'm1', availableModels: ['m1', 'm2'], secretId: 'sid-a', keyPool: ['sid-a', 'sid-b'], includeBody: '{"a":1}' }),
                normalizeProfile({ id: 'b-solo', name: 'Solo', format: 'openai', endpoint: 'https://solo.invalid/v1', model: 's1', availableModels: ['s1'], secretId: 'sid-solo' }),
                normalizeProfile({ id: 'b-proxy', name: 'Claude 反代', format: 'anthropic', endpoint: 'https://proxy.invalid', model: 'claude-x', availableModels: ['claude-x'], proxyPreset: 'Quicker · native-proxy-name' }),
                normalizeProfile({ id: 'b-draft', name: 'Draft', format: 'openai', draft: true }),
            ];
            settings().selectedProfileId = 'b-pool'; settings().activeProfileId = null;
            settings().presetBindings = Object.assign(Object.create(null), { A: 'b-pool' });
            settings().presetModels = Object.assign(Object.create(null), { A: presetModelSnapshot(settings().profiles[0], 'm2') });
            settings().quickActions = [normalizeQuickAction({ name: '方案一', profileId: 'b-pool', model: 'm2', params: { enabled: true, temperature: { value: 0.5 } } }, 0)];
            settings().quickUrls = [normalizeQuickUrl({ name: 'Mine', url: 'https://mine.invalid/v1' })];
            settings().presetLink = false; renderPanelMode();
            await readAuthoritativeSecretState();
            renderProfiles('b-pool');
        })()`);

        // 1. Without keys: no plaintext, no secret id and no native proxy preset name leaves the install.
        const plain = await run(`buildBackup(false).then(({ backup, unreadable }) => ({ json: JSON.stringify(backup), unreadable, type: backup.type,
            includes: backup.includesSecrets, names: backup.profiles.map(item => item.name), credentials: backup.profiles.map(item => item.credential) }))`);
        assert.equal(plain.type, 'st-quicker-api-backup');
        assert.equal(plain.includes, false);
        assert.equal(plain.unreadable, 0);
        assert.deepEqual(plain.names, ['Pool', 'Solo', 'Claude 反代']);
        assert.deepEqual(plain.credentials, [{ type: 'key', withheld: true }, { type: 'key', withheld: true }, { type: 'proxy', withheld: true }]);
        assert.doesNotMatch(plain.json, /sk-pool|sk-solo|proxy-pass|sid-|native-proxy-name/);
        log('backup: a backup without keys lists every saved Profile (drafts excluded) and contains no key, password, secret id or native proxy preset name');

        // 2. With keys: the whole pool (own key first) and the proxy password, in one downloaded file.
        const exported = await run(`(async () => {
            fixtureDownloads.length = 0; messages.length = 0;
            const ok = await enqueueOperation(() => exportBackup(true));
            return { ok, files: fixtureDownloads.map(file => [file.fileName, file.contentType]), text: fixtureDownloads[0]?.content,
                success: messages.filter(item => item.level === 'success').map(item => item.message) };
        })()`);
        assert.equal(exported.ok, true);
        assert.equal(exported.files.length, 1);
        assert.match(exported.files[0][0], /^quicker-api-backup-\d{8}-\d{6}\.json$/);
        assert.equal(exported.files[0][1], 'application/json');
        const file = JSON.parse(exported.text);
        assert.equal(file.type, 'st-quicker-api-backup');
        assert.equal(file.includesSecrets, true);
        assert.deepEqual(file.profiles.map(item => item.credential), [
            { type: 'key', keys: ['sk-pool-a', 'sk-pool-b'] }, { type: 'key', keys: ['sk-solo'] }, { type: 'proxy', password: 'proxy-pass' },
        ]);
        assert.equal(file.quickActions.length, 1);
        assert.deepEqual(file.presetBindings, { A: 'b-pool' });
        assert.ok(exported.success.some(message => message.includes('含密钥明文')));
        log('backup: a backup with keys holds each key pool in order and the reverse-proxy password of a proxy Profile, under the plugin\'s own type marker');

        // 3. A key that cannot be read is never silently dropped; a host that reports a failed delivery is not reported as success.
        const savedValue = state.secretValues.api_key_custom['sid-b'];
        delete state.secretValues.api_key_custom['sid-b'];
        const unreadable = await run(`(async () => {
            fixtureDownloads.length = 0; messages.length = 0;
            const withKeys = await enqueueOperation(() => exportBackup(true));
            const afterWithKeys = fixtureDownloads.length;
            const warned = messages.some(item => item.level === 'warning' && item.message.includes('明文不可读'));
            const withoutKeys = await enqueueOperation(() => exportBackup(false));
            return [withKeys, afterWithKeys, warned, withoutKeys, fixtureDownloads.length];
        })()`);
        assert.deepEqual(unreadable, [false, 0, true, true, 1]);
        state.secretValues.api_key_custom['sid-b'] = savedValue;
        const undelivered = await run(`(async () => {
            const original = window.download; messages.length = 0;
            window.download = async () => ({ delivered: false });
            try { return [await enqueueOperation(() => exportBackup(false)), messages.filter(item => item.level === 'success').length]; }
            finally { window.download = original; }
        })()`);
        assert.deepEqual(undelivered, [false, 0]);
        log('backup: an unreadable key cancels the export with a warning instead of producing an incomplete file; an undelivered file is not reported as exported');

        // 4. Only a backup of this plugin, of a known version, is accepted; unknown entries are skipped.
        const rejected = await run(`['not json', '{"type":"other","formatVersion":1,"profiles":[]}', JSON.stringify({ type: BACKUP_TYPE, formatVersion: 1 }),
            JSON.stringify({ type: BACKUP_TYPE, formatVersion: BACKUP_FORMAT_VERSION + 1, profiles: [] }),
            JSON.stringify({ type: BACKUP_TYPE, formatVersion: 1, schemaVersion: SCHEMA_VERSION + 1, profiles: [] }),
        ].map(text => { try { parseBackup(text); return 'accepted'; } catch (error) { return error.message; } })`);
        assert.match(rejected[0], /不是有效的 JSON/);
        assert.match(rejected[1], /不是 Quicker Api 的备份文件/);
        assert.match(rejected[2], /不是 Quicker Api 的备份文件/);
        assert.match(rejected[3], /更高版本/);
        assert.match(rejected[4], /更高版本/);
        const parsed = await run(`(() => {
            const backup = parseBackup(JSON.stringify({ type: BACKUP_TYPE, formatVersion: 1, profiles: [
                { name: 'X', format: 'mystery' }, { format: 'openai' }, null, { name: 'Y', format: ['openai'] },
                { name: 'Ok', format: 'openai', credential: { type: 'key', keys: ['a', 'a', ' b ', 5] }, extraCredentials: { api_key_claude: 'c', bogus: 'x', proxy: '' } },
            ] }));
            return [backup.skipped, backup.profiles.map(item => [item.name, item.credential.keys, item.extraCredentials])];
        })()`);
        assert.deepEqual(parsed, [4, [['Ok', ['a', 'b'], { api_key_claude: 'c' }]]]);
        log('backup: other files, backups of a newer version and entries of an unknown format are refused or skipped, never reinterpreted');

        // 5. Restoring into an install that has a live key and a native proxy preset of the same name.
        state.secrets.api_key_custom = [{ id: 'live', active: true }];
        state.secretValues = { api_key_custom: { live: 'sk-live' } };
        await run(`(async () => {
            settings().profiles = []; settings().quickActions = []; settings().quickUrls = [];
            settings().presetBindings = Object.create(null); settings().presetModels = Object.create(null);
            settings().selectedProfileId = null; settings().activeProfileId = null;
            proxies.length = 0; proxies.push({ name: 'Quicker · Claude 反代', url: 'https://other.invalid', password: 'native-pass' });
            await readAuthoritativeSecretState(); renderProfiles();
        })()`);
        const fresh = await restore(exported.text, { profiles: [0, 1, 2], quickActions: true, quickUrls: true, presetBindings: true, preferences: false });
        assert.deepEqual(fresh.result, { restored: 3, pending: 0, actions: 1, skippedActions: 0, urls: 1, bindings: 1, preferences: false });
        const written = customSecrets().filter(entry => entry.id !== 'live');
        assert.deepEqual(written.map(entry => [entry.label, state.secretValues.api_key_custom[entry.id]]),
            [['Pool · 1', 'sk-pool-a'], ['Pool · 2', 'sk-pool-b'], ['Solo', 'sk-solo']]);
        assert.equal(activeCustom(), 'live');
        const freshState = await run(`(() => {
            const byName = name => profiles().find(item => item.name === name);
            const pool = byName('Pool'), solo = byName('Solo'), proxy = byName('Claude 反代'), action = settings().quickActions[0];
            return { names: profiles().map(item => item.name).sort(), poolId: pool.id,
                pool: [pool.secretId, pool.keyPool, pool.model, pool.availableModels, pool.includeBody, pool.needsSecret],
                solo: [solo.secretId, Object.hasOwn(solo, 'keyPool'), solo.needsSecret], proxyPreset: proxy.proxyPreset,
                proxies: proxies.map(item => [item.name, item.url, item.password]),
                action: [action.name, action.profileId, action.model, action.params.enabled, action.params.temperature.value],
                binding: settings().presetBindings.A, bindingModel: settings().presetModels.A,
                urls: settings().quickUrls.map(item => [item.name, item.url]), selected: settings().selectedProfileId };
        })()`);
        assert.deepEqual(freshState.names, ['Claude 反代', 'Pool', 'Solo']);
        assert.notEqual(freshState.poolId, 'b-pool');
        assert.deepEqual(freshState.pool, [written[0].id, [written[0].id, written[1].id], 'm1', ['m1', 'm2'], '{"a":1}', false]);
        assert.deepEqual(freshState.solo, [written[2].id, false, false]);
        assert.equal(freshState.proxyPreset, 'Quicker · Claude 反代 (2)');
        assert.deepEqual(freshState.proxies, [
            ['Quicker · Claude 反代', 'https://other.invalid', 'native-pass'], ['Quicker · Claude 反代 (2)', 'https://proxy.invalid', 'proxy-pass'],
        ]);
        assert.deepEqual(freshState.action, ['方案一', freshState.poolId, 'm2', true, 0.5]);
        assert.equal(freshState.binding, freshState.poolId);
        assert.deepEqual(freshState.bindingModel, { profileId: freshState.poolId, format: 'openai', model: 'm2' });
        assert.deepEqual(freshState.urls, [['Mine', 'https://mine.invalid/v1']]);
        assert.equal(freshState.selected, freshState.poolId);
        log('restore: Profiles get new ids with their key pool, schemes and preset bindings re-pointed; the live key stays active and a native proxy preset of the same name is left untouched');

        // 6. Restoring again only adds: a renamed copy that reuses the saved keys, nothing existing changes.
        const before = await run('JSON.stringify(profiles())');
        const secretCount = customSecrets().length;
        const again = await restore(exported.text, { ...none, profiles: [0] });
        assert.equal(again.result.restored, 1);
        const afterAgain = await run('[JSON.stringify(profiles().slice(0, 3)), profiles()[3].name, profiles()[3].keyPool, settings().quickActions.length]');
        assert.deepEqual(afterAgain, [before, 'Pool (2)', [written[0].id, written[1].id], 1]);
        assert.equal(customSecrets().length, secretCount);
        assert.equal(activeCustom(), 'live');
        const nothing = await restore(exported.text, { ...none, quickActions: true, quickUrls: true, presetBindings: true });
        assert.deepEqual(nothing.result, { restored: 0, pending: 0, actions: 0, skippedActions: 0, urls: 0, bindings: 0, preferences: false });
        assert.ok(nothing.messages.some(message => message.startsWith('info:') && message.includes('没有新增内容')));
        const orphan = await restore(JSON.stringify({ type: 'st-quicker-api-backup', formatVersion: 1, profiles: [], quickActions: [{ name: '孤儿', profileId: 'gone', model: 'x' }] }),
            { ...none, quickActions: true });
        assert.equal(orphan.result.skippedActions, 1);
        assert.ok(orphan.messages.some(message => message.startsWith('warning:') && message.includes('已跳过')));
        assert.equal(await run('settings().quickActions.length'), 1);
        log('restore: a second restore adds a numbered copy that reuses the saved keys and changes nothing existing; duplicates are not added and a scheme whose Profile is absent is skipped');

        // 7. A backup without keys restores Profiles that ask for their key again.
        const keyless = await restore(plain.json, { ...none, profiles: [1, 2] });
        assert.equal(keyless.result.restored, 2);
        assert.equal(keyless.result.pending, 2);
        assert.ok(keyless.messages.some(message => message.startsWith('warning:') && message.includes('重新填写密钥')));
        const keylessState = await run(`(() => {
            const solo = profiles().find(item => item.name === 'Solo (2)'), proxy = profiles().find(item => item.name === 'Claude 反代 (2)');
            const preset = proxies.find(item => item.name === proxy.proxyPreset);
            return [solo.secretId, solo.needsSecret, preset.url, preset.password, proxies.filter(item => item.name === proxy.proxyPreset).length, proxies.length];
        })()`);
        assert.deepEqual(keylessState, ['', true, 'https://proxy.invalid', '', 1, 3]);
        assert.equal(customSecrets().length, secretCount);
        log('restore: Profiles restored from a backup without keys are marked as needing their key, and the user is told');

        // 7b. Rotation settings travel with the keys: the strategy, and the switched-off keys by their position.
        const rotating = await run(`(async () => {
            const pool = profiles().find(item => item.name === 'Pool');
            pool.keyRotation = 'random'; pool.keyPoolDisabled = [pool.keyPool[1]];
            fixtureDownloads.length = 0;
            const ok = await enqueueOperation(() => exportBackup(true));
            delete pool.keyRotation; delete pool.keyPoolDisabled;
            return { ok, text: fixtureDownloads[0]?.content, ids: profiles().map(item => item.id) };
        })()`);
        assert.equal(rotating.ok, true);
        const rotatingFile = JSON.parse(rotating.text);
        const rotatingIndex = rotatingFile.profiles.findIndex(item => item.name === 'Pool');
        assert.deepEqual(rotatingFile.profiles[rotatingIndex].credential, { type: 'key', keys: ['sk-pool-a', 'sk-pool-b'], rotation: 'random', disabled: [1] });
        assert.deepEqual(rotatingFile.profiles.find(item => item.name === 'Solo').credential, { type: 'key', keys: ['sk-solo'] });
        assert.equal((await restore(rotating.text, { ...none, profiles: [rotatingIndex] })).result.restored, 1);
        const offBackup = JSON.stringify({ type: 'st-quicker-api-backup', formatVersion: 1, profiles: [
            { name: 'Off Pool', format: 'openai', endpoint: 'https://off.invalid/v1', model: 'o1', credential: { type: 'key', keys: ['sk-pool-a', 'sk-pool-b'], rotation: 'off', disabled: [0, 1, 7, 'x'] } },
            { name: 'Odd Pool', format: 'openai', endpoint: 'https://odd.invalid/v1', model: 'o2', credential: { type: 'key', keys: ['sk-pool-a', 'sk-pool-b'], rotation: 'bogus', disabled: 'all' } },
        ] });
        assert.equal((await restore(offBackup, { ...none, profiles: [0, 1] })).result.restored, 2);
        const rotated = await run(`(() => { const known = new Set(${JSON.stringify(rotating.ids)}); const added = profiles().filter(item => !known.has(item.id));
            const shape = added.map(item => [item.name, item.secretId, item.keyPool, item.keyPoolDisabled || null, item.keyRotation || null, connectionKeyPool(item)]);
            settings().profiles = profiles().filter(item => known.has(item.id)); renderProfiles();
            return shape; })()`);
        const [keyA, keyB] = [written[0].id, written[1].id];
        assert.deepEqual(rotated, [
            ['Pool (3)', keyA, [keyA, keyB], [keyB], 'random', []],
            ['Off Pool', keyA, [keyA, keyB], [keyB], 'off', []],
            ['Odd Pool', keyA, [keyA, keyB], null, null, [keyA, keyB]],
        ]);
        assert.equal(customSecrets().length, secretCount);
        log('backup: the rotation strategy and the switched-off keys are exported with the keys and restored; a backup without them, or with unknown values, restores a pool that rotates in order');

        // 8. The dialog: choosing a file holds no operation, a wrong file keeps the dialog open, existing Profiles are not preselected.
        await settle();
        await run(`document.getElementById('quicker_api_backup').click()`);
        await waitFor('backupPopup !== null && ownedPopups.has(backupPopup)', 'the backup dialog did not open');
        const feed = (text, name) => run(`(() => {
            const input = document.querySelector('.quicker-api__backup [data-backup="file"]');
            const transfer = new DataTransfer();
            transfer.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/json' }));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await run(`document.querySelector('.quicker-api__backup [data-backup="pick"]').click()`);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.deepEqual(await run(`[pendingOperations, document.getElementById('quicker_api_save').disabled, backupPopup !== null,
            document.querySelectorAll('.quicker-api__backup [data-backup="restore"]').length]`), [0, false, true, 0]);
        await run('messages.length = 0; true');
        await feed('{"type":"something-else","profiles":[]}', 'other.json');
        await waitFor(`document.querySelectorAll('.quicker-api__backup-error').length === 1`, 'a wrong file did not show an error');
        assert.deepEqual(await run(`[backupPopup !== null, messages.some(item => item.level === 'error' && item.message.includes('不是 Quicker Api 的备份文件')),
            document.querySelectorAll('.quicker-api__backup [data-backup="restore"]').length]`), [true, true, 0]);
        const extended = JSON.parse(exported.text);
        extended.profiles.push({ id: 'b-new', name: 'Brand New', format: 'gemini', endpoint: '', model: 'g1', availableModels: ['g1'], credential: { type: 'none' } });
        await feed(JSON.stringify(extended), 'backup.json');
        await waitFor(`document.querySelectorAll('.quicker-api__backup [data-backup="restore"]').length === 1`, 'the backup preview did not render');
        const preview = await run(`(() => {
            const root = document.querySelector('.quicker-api__backup');
            return { rows: [...root.querySelectorAll('[data-index]')].map(input => [input.checked, input.closest('label').textContent.includes('已存在')]),
                options: Object.fromEntries([...root.querySelectorAll('[data-option]')].map(input => [input.dataset.option, input.checked])),
                errors: root.querySelectorAll('.quicker-api__backup-error').length };
        })()`);
        assert.deepEqual(preview.rows, [[false, true], [false, true], [false, true], [true, false]]);
        assert.deepEqual(preview.options, { quickActions: true, quickUrls: true, presetBindings: true, preferences: false });
        assert.equal(preview.errors, 0);
        const countBefore = await run('profiles().length');
        await run(`(() => {
            messages.length = 0;
            const root = document.querySelector('.quicker-api__backup');
            for (const input of root.querySelectorAll('[data-index], [data-option]')) input.checked = false;
            root.querySelector('[data-backup="restore"]').click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(await run(`[backupPopup !== null, profiles().length, messages.some(item => item.level === 'info' && item.message.includes('请先勾选'))]`),
            [true, countBefore, true]);
        await run(`(() => {
            const root = document.querySelector('.quicker-api__backup');
            root.querySelector('[data-index="3"]').checked = true;
            root.querySelector('[data-backup="restore"]').click();
        })()`);
        await waitFor('backupPopup === null', 'the backup dialog did not close after restoring');
        await settle();
        assert.deepEqual(await run(`(() => { const added = profiles().find(item => item.name === 'Brand New');
            return [profiles().length, added?.format, added?.model, added?.needsSecret, document.querySelectorAll('.quicker-api__backup').length, ownedPopups.size]; })()`),
            [countBefore + 1, 'gemini', 'g1', false, 0, 0]);
        assert.equal(activeCustom(), 'live');
        log('backup dialog: choosing a file holds no operation or deadline, a wrong file shows an error and keeps the dialog open, Profiles that already exist are not preselected, and restoring the selection closes the dialog');
    } finally {
        state.recordSecretValues = false;
    }
}

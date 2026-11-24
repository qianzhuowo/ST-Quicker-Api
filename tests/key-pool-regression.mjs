import assert from 'node:assert/strict';

// Key pool: a channel with several keys activates the next one in the host's key
// slot before every generation (round-robin) and resends a request whose key the
// upstream refused with the next key (failover). Only /api/secrets/rotate is used,
// so it does not depend on the host accepting a per-request key. The test server's
// generate route records the key that was active when each request arrived.
export async function runKeyPoolRegressions({ page, state, log }) {
    const run = page.evaluate;
    const settle = async () => {
        for (let i = 0; i < 100; i++) {
            if (await run('pendingOperations === 0 && !presetTransitionBlocked')) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error('operations did not settle');
    };
    const waitFor = async (expression, message) => {
        for (let i = 0; i < 100; i++) {
            if (await run(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error(message || `timed out waiting for ${expression}`);
    };
    const pool = ['pool-1', 'pool-2', 'pool-3', 'pool-4', 'pool-5'];
    state.secrets = {
        api_key_custom: [{ id: 'solo', active: true }, ...pool.map(id => ({ id, active: false }))],
        api_key_claude: [{ id: 'test-secret', active: true }], api_key_makersuite: [{ id: 'test-secret', active: true }],
    };
    delete state.secretValues;
    const rotations = () => state.requests.filter(request => request.path === '/api/secrets/rotate').length;
    const reset = async (reply = null) => {
        state.generated = [];
        state.generateReply = reply;
        await run('keyPoolCooldowns.clear(); keyPoolCursors.clear(); keyPoolLast.clear(); messages.length = 0; true');
    };
    const generate = (extra = {}) => run(`poolGenerate(${JSON.stringify(extra)})`);
    const refused = (status, statusText, message = 'refused') => ({ status, statusText, body: { error: { message } } });

    // 1. Normalization: only a pool of two or more that contains the Profile's own key is kept.
    await run(`(async () => {
        window.poolProfile = normalizeProfile({id:'pool-profile',name:'Pool',format:'openai',endpoint:'https://pool.invalid/v1',model:'pool-model',availableModels:['pool-model'],secretId:'pool-1',keyPool:['pool-1','pool-2','pool-3','pool-2','']});
        window.soloProfile = normalizeProfile({id:'solo-profile',name:'Solo',format:'openai',endpoint:'https://solo.invalid/v1',model:'solo-model',availableModels:['solo-model'],secretId:'solo',keyPool:['solo']});
        settings().profiles = [poolProfile, soloProfile]; settings().presetBindings = {}; settings().presetModels = {};
        settings().quickActions = []; settings().presetLink = false; renderPanelMode();
        window.poolGenerate = async (extra = {}) => {
            const data = { chat_completion_source: oai_settings.chat_completion_source, custom_api_format: oai_settings.custom_api_format,
                custom_url: oai_settings.custom_url, model: oai_settings.custom_model, stream: false, ...extra };
            await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data);
            const response = await fetch('/api/backends/chat-completions/generate', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(data) });
            return { status: response.status, ok: response.ok, text: await response.text(), sent: data };
        };
        await readAuthoritativeSecretState();
    })()`);
    const normalized = await run(`[poolProfile.keyPool, Object.hasOwn(soloProfile, 'keyPool'),
        Object.hasOwn(normalizeProfile({format:'openai',secretId:'x',keyPool:['a','b']}), 'keyPool'),
        Object.hasOwn(normalizeProfile({format:'anthropic',endpoint:'https://proxy.invalid',secretId:'a',keyPool:['a','b']}), 'keyPool'),
        parseKeyList(' sk-1 \\r\\n\\nsk-2\\nsk-1\\n'), parseKeyList(Array.from({length:150},(_,i)=>'k'+i).join('\\n')).length]`);
    assert.deepEqual(normalized, [['pool-1', 'pool-2', 'pool-3'], false, false, false, ['sk-1', 'sk-2'], 100]);
    log('key pool: only a pool of two or more keys that contains the channel\'s own key is kept; reverse-proxy channels have none; typed keys are one per line, de-duplicated, at most 100');

    // 2. Round-robin: every generation of the applied channel is sent with the next key.
    await run('applyProfileById(poolProfile.id)');
    await settle();
    await reset();
    for (let i = 0; i < 5; i++) assert.equal((await generate()).ok, true);
    assert.deepEqual(state.generated, ['pool-1', 'pool-2', 'pool-3', 'pool-1', 'pool-2']);
    const afterRotation = await run(`(() => { const adopted = adoptNativeActiveSecret(poolProfile); handleNativeSecretChange('api_key_custom'); renderStatus();
        return [getActiveSecret('api_key_custom')?.id, poolProfile.secretId, adopted, $('#quicker_api_status').text(), settings().activeProfileId]; })()`);
    assert.deepEqual(afterRotation, ['pool-2', 'pool-1', false, '已保存并安全应用（密钥池：3 把密钥轮询）。', 'pool-profile']);
    log('key pool: generations rotate through the keys in order; a rotated key is neither adopted as the channel key nor reported as a mismatch');

    // 3. Requests that are not this channel's own connection, or that already name a key, are left alone.
    let before = rotations();
    await reset();
    assert.equal((await generate({ custom_url: 'https://other.invalid/v1' })).ok, true);
    assert.equal((await generate({ model: 'not-a-pool-model' })).ok, true);
    const named = await generate({ secret_id: 'pool-3' });
    assert.equal(named.sent.secret_id, 'pool-3');
    assert.equal(rotations(), before, 'no key was activated for foreign requests');
    await run('applyProfileById(soloProfile.id)');
    await settle();
    before = rotations();
    await reset(() => refused(429, 'Too Many Requests'));
    assert.equal((await generate()).status, 429);
    assert.deepEqual([state.generated, rotations() - before], [['solo'], 0]);
    log('key pool: another endpoint or model, a request that already carries secret_id, and a single-key channel are neither rotated nor retried');

    // 4. Failover: a refused key is replaced by the next one and skipped by the rotation for a while.
    await run('applyProfileById(poolProfile.id)');
    await settle();
    let count = 0;
    await reset(() => (count++ === 0 ? refused(429, 'Too Many Requests') : null));
    let result = await generate();
    assert.equal(result.ok, true, result.text);
    assert.equal(state.generated.length, 2);
    assert.notEqual(state.generated[0], state.generated[1]);
    assert.match(await run(`messages.find(item => item.level === 'warning')?.message || ''`), /密钥池.*HTTP 429.*重试 1 次/);
    const cooled = state.generated[0];
    state.generated = [];
    state.generateReply = null;
    for (let i = 0; i < 4; i++) await generate();
    assert.equal(state.generated.includes(cooled), false, `a key refused a moment ago is skipped: ${JSON.stringify(state.generated)}`);
    log('key pool: a key refused with 429 is replaced by the next key within the same request, and the rotation skips it during its cooldown');

    // 5. Retry limit: never the same key twice, and at most three extra attempts however large the pool is.
    await reset(() => refused(400, 'Unauthorized'));
    result = await generate();
    assert.equal(result.status, 400);
    assert.equal(state.generated.length, 3, JSON.stringify(state.generated));
    assert.equal(new Set(state.generated).size, 3);
    await run(`poolProfile.keyPool = ${JSON.stringify(pool)}; true`);
    await reset(() => refused(403, 'Forbidden'));
    result = await generate();
    assert.equal(result.status, 403);
    assert.equal(state.generated.length, 4, JSON.stringify(state.generated));
    assert.equal(new Set(state.generated).size, 4);
    assert.match(await run(`messages.find(item => item.level === 'warning')?.message || ''`), /重试 3 次/);
    log('key pool: when every key is refused a request tries each key at most once and stops after three retries, returning the last refusal');

    // 6. Only what the host forwards verbatim counts as a refused key; response text is never searched.
    const cases = [
        ['500 whose text mentions 401/429', { status: 500, statusText: 'Internal Server Error', body: { error: { message: 'upstream said 401 Unauthorized, 429 Too Many Requests' } } }, {}, 1],
        ['400 Bad Request whose text mentions 429', { status: 400, statusText: 'Bad Request', body: { error: { message: '429 rate limit 401 403' } } }, {}, 1],
        ['502', { status: 502, statusText: 'Bad Gateway', body: { error: { message: 'Unauthorized' } } }, {}, 1],
        ['host JSON error with another reason phrase', { status: 200, body: { error: { message: 'Internal Server Error' }, quota_error: false } }, {}, 1],
        ['a normal reply whose text mentions 401', { status: 200, body: { choices: [{ message: { content: '401 Unauthorized 429 Too Many Requests' } }] } }, {}, 1],
        ['host JSON error on a streaming request', { status: 200, body: { error: { message: 'Too Many Requests' }, quota_error: false } }, { stream: true }, 1],
        ['host JSON error "Too Many Requests"', { status: 200, body: { error: { message: 'Too Many Requests' }, quota_error: false } }, {}, 2],
        ['host JSON error "Unauthorized"', { status: 200, body: { error: { message: 'Unauthorized' }, quota_error: false } }, {}, 2],
        ['host JSON quota_error', { status: 200, body: { error: { message: 'Whatever' }, quota_error: true } }, {}, 2],
        ['streaming 400 Unauthorized (the host\'s 401)', { status: 400, statusText: 'Unauthorized', body: { error: { message: 'bad key' } } }, { stream: true }, 2],
    ];
    for (const [label, reply, extra, expected] of cases) {
        let seen = 0;
        await reset(() => (seen++ === 0 ? reply : null));
        await generate(extra);
        assert.equal(state.generated.length, expected, `${label}: ${JSON.stringify(state.generated)}`);
    }
    log('key pool: retries need a forwarded 401/403/429 (or the host\'s "400 Unauthorized" / JSON error with that reason phrase); 5xx, other 400s and reply text that merely mentions those numbers are not retried');

    // 7. A credential transition blocks the generation instead of rotating.
    await reset();
    before = rotations();
    const blocked = await run(`(async () => { beginPresetTransition(); try { const data = { chat_completion_source: 'custom', custom_url: poolProfile.endpoint, model: 'pool-model' };
        await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data); return data.chat_completion_source; } finally { endPresetTransition(); } })()`);
    assert.deepEqual([blocked, rotations() - before], ['quicker_api_preset_transition', 0]);
    log('key pool: a generation blocked during a credential transition activates no key');

    // 8. Rotation settings: switched-off keys are skipped; random never repeats the key used a moment ago;
    //    failover stays on the first key until the upstream refuses it; 'off' keeps to the channel's own key.
    assert.deepEqual(await run(`(() => { const shape = raw => { const p = normalizeProfile({ format: 'openai', ...raw }); return [p.keyPool || null, p.keyPoolDisabled || null, p.keyRotation || null]; };
        return [shape({ secretId: 'a', keyPool: ['a', 'b', 'c'], keyPoolDisabled: ['a', 'c', 'x', 'c'], keyRotation: 'random' }),
            shape({ secretId: 'a', keyPool: ['a', 'b'], keyRotation: 'off' }), shape({ secretId: 'a', keyPool: ['a', 'b'], keyRotation: 'bogus' }),
            shape({ secretId: 'a', keyPool: ['a'], keyPoolDisabled: ['a'], keyRotation: 'random' })]; })()`),
    [[['a', 'b', 'c'], ['c'], 'random'], [['a', 'b'], null, 'off'], [['a', 'b'], null, null], [null, null, null]]);
    const status = () => run(`(() => { renderStatus(); return $('#quicker_api_status').text(); })()`);
    await run(`poolProfile.keyPoolDisabled = ['pool-2', 'pool-4']; true`);
    await reset();
    for (let i = 0; i < 4; i++) await generate();
    assert.deepEqual([state.generated, await status()], [['pool-1', 'pool-3', 'pool-5', 'pool-1'], '已保存并安全应用（密钥池：3 把密钥轮询）。']);

    await run(`delete poolProfile.keyPoolDisabled; poolProfile.keyRotation = 'random'; true`);
    await reset();
    for (let i = 0; i < 30; i++) await generate();
    assert.equal(state.generated.every(id => pool.includes(id)), true, JSON.stringify(state.generated));
    assert.equal(state.generated.some((id, index) => index > 0 && id === state.generated[index - 1]), false, `random repeated a key: ${JSON.stringify(state.generated)}`);
    assert.ok(new Set(state.generated).size >= 3, JSON.stringify(state.generated));
    assert.equal(await status(), '已保存并安全应用（密钥池：5 把密钥随机轮询）。');

    await run(`poolProfile.keyRotation = 'failover'; true`);
    await reset();
    for (let i = 0; i < 3; i++) await generate();
    assert.deepEqual(state.generated, ['pool-1', 'pool-1', 'pool-1']);
    count = 0;
    await reset(() => (count++ === 0 ? refused(429, 'Too Many Requests') : null));
    result = await generate();
    await generate();
    await generate();
    assert.deepEqual([result.ok, state.generated], [true, ['pool-1', 'pool-2', 'pool-2', 'pool-2']]);
    state.generated = [];
    await run('keyPoolCooldowns.clear(); true');
    await generate();
    assert.deepEqual([state.generated, await status()], [['pool-1'], '已保存并安全应用（密钥池：5 把密钥，故障时切换）。']);

    await run(`poolProfile.keyRotation = 'off'; applyProfileById(poolProfile.id)`);
    await settle();
    before = rotations();
    await reset(() => refused(429, 'Too Many Requests'));
    assert.equal((await generate()).status, 429);
    assert.deepEqual([state.generated, rotations() - before, await status()], [['pool-1'], 0, '已保存并安全应用。']);
    // Without rotation a key picked in the host's key manager becomes the channel's key: one of its
    // saved keys is selected, another one joins them.
    const adopted = await run(`(async () => { const seen = [];
        for (const id of ['pool-3', 'solo']) { await rotateSecretVerified('api_key_custom', id); adoptNativeActiveSecret(poolProfile); seen.push([poolProfile.secretId, poolProfile.keyPool.length, poolProfile.keyPool.includes(id)]); }
        return seen; })()`);
    assert.deepEqual(adopted, [['pool-3', 5, true], ['solo', 6, true]]);
    await run(`(() => { poolProfile.secretId = 'pool-1'; poolProfile.keyPool = ${JSON.stringify(pool)}; delete poolProfile.keyRotation; delete poolProfile.keyPoolDisabled; return applyProfileById(poolProfile.id); })()`);
    await settle();
    log('key pool: switched-off keys are skipped; random rotation never repeats the last key; failover rotation stays on the first key until it is refused; with rotation off only the channel\'s own key is used, is never retried, and a key picked natively is adopted');

    // A key list shows at most the last three characters of a key, whether or not the host masks it.
    assert.deepEqual(await run(`[keyPreview('sk-abcdefghijkl'), keyPreview('short'), keyPreview('*******xyz'), keyPreview('**********'), keyPreview(''), keyPreview(undefined)]`),
        ['*******jkl', '**********', '*******xyz', '**********', '', '']);

    // 9. Channel manager: one row per key. Saved keys are listed read-only and masked; new keys are added as
    //    rows or pasted in bulk; the "轮询 ON/OFF" switch, its strategy, the per-key switches and removals
    //    are saved with the channel.
    const detail = '.quicker-api__channel-detail';
    const field = (name, value) => run(`$('${detail} [data-field="${name}"]').val(${JSON.stringify(value)}).trigger('input'); true`);
    const hint = () => run(`$('${detail} [data-role="credential-hint"]').text()`);
    // Per row: the saved key's id ('' for a new key), the kind of its switch, whether it is on, whether it is disabled.
    const keyRows = () => run(`$('${detail} .quicker-api__channel-key-row').toArray().map(row => { const toggle = row.querySelector('.quicker-api__switch-input'); return [row.dataset.keyId || '', toggle.type, toggle.checked, toggle.disabled]; })`);
    const keyValues = () => run(`$('${detail} .quicker-api__channel-key-input').toArray().map(input => input.value)`);
    const keyCount = () => run(`(() => { const badge = $('${detail} [data-role="key-count"]'); return badge.prop('hidden') ? '' : badge.text(); })()`);
    const rotationUi = () => run(`(() => { const box = $('${detail} [data-role="key-rotation"]'); const select = box.find('[data-key-strategy]');
        return [box.prop('hidden'), box.find('[data-key-rotate]').prop('checked'), select.val(), select.prop('disabled'), box.find('[data-role="key-rotate-state"]').text()]; })()`);
    const keyControl = (selector, action) => run(`(() => { const control = $('${detail} ${selector}'); ${action}; return control.length; })()`);
    const keyAction = name => keyControl(`[data-key-action="${name}"]`, `control.trigger('click')`);
    // "添加" focuses the first empty row (adding one when there is none); the key is typed into it.
    const addKey = value => run(`(() => { const box = $('${detail}'); box.find('[data-key-action="add"]').trigger('click');
        return box.find('[data-key-value]').filter((_, input) => !input.value).first().val(${JSON.stringify(value)}).trigger('input').length; })()`);
    const revealed = () => run(`$('${detail} [data-key-action="reveal"]').attr('aria-pressed') === 'true'`);
    const exposureWarned = () => run(`messages.some(item => item.level === 'warning' && item.message === keyExposureGuidance().warning)`);
    const soloKeys = () => run(`[soloProfile.keyPool || null, soloProfile.keyPoolDisabled || null, soloProfile.keyRotation || null, soloProfile.secretId, soloProfile.needsSecret, connectionKeyPool(soloProfile)]`);
    const openManager = async id => {
        await run(`window.poolChannelTask = manageChannels(${JSON.stringify(id)}); true`);
        await waitFor('ownedPopups.size === 1', 'channel manager did not open');
    };
    const confirmManager = async () => {
        await run('[...ownedPopups][0].completeAffirmative()');
        await run('poolChannelTask');
        await settle();
    };
    const cancelManager = async () => {
        await run('[...ownedPopups][0].completeCancelled(); poolChannelTask');
        await settle();
    };
    await run(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedKeys = text; } } }); true`);

    await openManager('solo-profile');
    assert.deepEqual([await keyRows(), await keyValues(), await keyCount(), await rotationUi()],
        [[['solo', 'radio', true, false]], ['**********'], '', [true, false, 'sequential', true, 'OFF']]);
    assert.deepEqual(await run(`[$('${detail} .quicker-api__channel-key-input').prop('readOnly'), $('${detail} .quicker-api__channel-keys').hasClass('is-solo'), $('${detail} .quicker-api__channel-key-index').text(), $('${detail} [data-role="key-paste"]').prop('hidden'), $('${detail} [data-field="key"]').length]`),
        [true, true, '1', true, 0]);
    // Bulk paste: any of newline, space, comma or semicolon separates keys; repeats are skipped.
    await keyAction('paste');
    await run(`$('${detail} .quicker-api__channel-key-paste-input').val('sk-1\\nsk-2, sk-2;sk-3\\n\\n sk-3 ').trigger('input'); true`);
    assert.deepEqual(await run(`[$('${detail} [data-role="key-paste"]').prop('hidden'), $('${detail} [data-role="paste-count"]').text(), $('${detail} [data-key-action="paste-add"] span').text(), $('${detail} [data-key-action="paste-add"]').prop('disabled')]`),
        [false, '识别到 5 把，跳过 2 把（重复或超出上限）', '添加 3 把', false]);
    await keyAction('paste-add');
    assert.match(await hint(), /保存时添加 3 把新密钥（共 4 把）。.*密钥池：4 把密钥，每次生成按顺序换下一把/);
    assert.deepEqual([await keyRows(), await keyValues(), await keyCount(), await rotationUi()],
        [[['solo', 'checkbox', true, false], ['', 'checkbox', true, false], ['', 'checkbox', true, false], ['', 'checkbox', true, false]], ['**********', 'sk-1', 'sk-2', 'sk-3'], '4/4', [false, true, 'sequential', false, 'ON']]);
    assert.deepEqual(await run(`[$('${detail} [data-role="key-paste"]').prop('hidden'), $('${detail} .quicker-api__channel-key-index').toArray().map(e => e.textContent).join(''), $('${detail} [data-key-value]').toArray().every(e => e.classList.contains('quicker-api__secret-masked'))]`),
        [true, '1234', true]);
    // The eye shows the new keys; the saved one stays masked while the host does not allow reading it.
    await run('messages.length = 0; true');
    await keyAction('reveal');
    await waitFor(`$('${detail} [data-key-action="reveal"]').attr('aria-pressed') === 'true'`, 'new keys were not shown');
    assert.deepEqual([await run(`$('${detail} [data-key-value]').toArray().some(e => e.classList.contains('quicker-api__secret-masked'))`), (await keyValues())[0], await exposureWarned()], [false, '**********', true]);
    await keyAction('reveal');
    await waitFor(`$('${detail} [data-key-action="reveal"]').attr('aria-pressed') === 'false'`, 'new keys were not hidden again');
    // A row repeating a key is ignored; a new key can be switched off before it is saved; Enter starts the next row.
    await addKey('sk-2');
    assert.deepEqual([(await keyRows()).at(-1), await keyCount(), await run(`$('${detail} [data-key-value]').last().attr('title')`)], [['', 'checkbox', false, true], '4/4', '与前面的密钥重复，保存时会忽略']);
    await keyControl('[data-key-remove]', `control.last().trigger('click')`);
    await keyControl('[data-key-toggle^="new:"]', `control.last().prop('checked', false).trigger('change')`);
    assert.match(await hint(), /密钥池：3 把密钥/);
    assert.deepEqual([await keyCount(), (await keyRows()).map(row => row[2])], ['3/4', [true, true, true, false]]);
    await keyControl('[data-key-toggle^="new:"]', `control.last().prop('checked', true).trigger('change')`);
    await keyControl('[data-key-value]', `control.last().trigger($.Event('keydown', { key: 'Enter' }))`);
    assert.deepEqual([(await keyRows()).length, await keyCount(), await run('ownedPopups.size')], [5, '4/4', 1]);
    const liveKey = await run(`getActiveSecret('api_key_custom')?.id`);
    await confirmManager();
    let saved = await soloKeys();
    const [, second, third, fourth] = saved[0];
    assert.deepEqual([saved[0].length, saved[0][0], saved.slice(1, 5), saved[5].length, await run(`[settings().activeProfileId, getActiveSecret('api_key_custom')?.id]`)],
        [4, 'solo', [null, null, 'solo', false], 4, ['pool-profile', liveKey]]);
    assert.deepEqual(state.secrets.api_key_custom.filter(entry => /^Solo · \d$/.test(entry.label || '')).map(entry => entry.label), ['Solo · 2', 'Solo · 3', 'Solo · 4']);
    log('channel manager: keys pasted in bulk are split, deduplicated and added as rows to the channel\'s saved key; several new keys rotate by default, an empty or repeated row is ignored, and the live key of the slot is unchanged');

    // Show and copy read the saved keys only on request, and only when the host allows it.
    state.secretValues = { api_key_custom: Object.fromEntries(saved[0].map((id, index) => [id, `sk-plain-${index}`])) };
    await openManager('solo-profile');
    assert.match(await hint(), /密钥池：4 把密钥，每次生成按顺序换下一把/);
    assert.deepEqual([await keyRows(), await keyValues()], [[['solo', 'checkbox', true, false], [second, 'checkbox', true, false], [third, 'checkbox', true, false], [fourth, 'checkbox', true, false]], Array(4).fill('**********')]);
    await run('messages.length = 0; window.copiedKeys = null; true');
    await keyAction('reveal');
    await waitFor(`$('${detail} [data-key-action="reveal"]').attr('aria-pressed') === 'true'`, 'saved keys were not shown');
    assert.deepEqual([await keyValues(), await exposureWarned()], [['sk-plain-0', 'sk-plain-1', 'sk-plain-2', 'sk-plain-3'], false]);
    await addKey('sk-typed');
    await keyAction('copy');
    await waitFor('window.copiedKeys !== null', 'keys were not copied');
    assert.deepEqual(await run(`[copiedKeys, messages.some(item => item.level === 'success' && item.message === '已复制 5 把密钥。')]`), ['sk-plain-0\nsk-plain-1\nsk-plain-2\nsk-plain-3\nsk-typed', true]);
    await keyControl('[data-key-remove^="new:"]', `control.trigger('click')`);
    await keyAction('reveal');
    await waitFor(`$('${detail} [data-key-action="reveal"]').attr('aria-pressed') === 'false'`, 'saved keys were not hidden again');
    assert.deepEqual(await keyValues(), Array(4).fill('**********'));
    delete state.secretValues;
    await cancelManager();
    await openManager('solo-profile');
    await run('messages.length = 0; window.copiedKeys = null; true');
    await keyAction('reveal');
    await waitFor('messages.length > 0', 'no notice about unreadable keys');
    await keyAction('copy');
    await waitFor('messages.length > 1', 'no notice about uncopyable keys');
    assert.deepEqual([await revealed(), await keyValues(), await exposureWarned(), await run('copiedKeys')], [false, Array(4).fill('**********'), true, null]);
    log('channel manager: the eye and copy read the saved keys on request; a host that does not allow it gets the guidance and nothing is shown or copied');

    await keyControl('[data-key-strategy]', `control.val('random').trigger('change')`);
    await keyControl(`[data-key-toggle="${third}"]`, `control.prop('checked', false).trigger('change')`);
    await keyControl(`[data-key-remove="${second}"]`, `control.trigger('click')`);
    assert.match(await hint(), /密钥池：2 把密钥，每次生成随机换一把/);
    assert.deepEqual([await keyRows(), await keyCount()], [[['solo', 'checkbox', true, false], [third, 'checkbox', false, false], [fourth, 'checkbox', true, false]], '2/3']);
    await confirmManager();
    assert.deepEqual(await soloKeys(), [['solo', third, fourth], [third], 'random', 'solo', false, ['solo', fourth]]);
    assert.equal(state.secrets.api_key_custom.some(entry => entry.id === second), true, 'a removed key stays in the host\'s key store');
    log('channel manager: the rotation strategy, a switched-off key and a removed key are saved; a removed key is only unbound from the channel');

    await openManager('solo-profile');
    await keyControl('[data-key-rotate]', `control.prop('checked', false).trigger('change')`);
    assert.deepEqual([await keyRows(), await keyCount(), await rotationUi()], [[['solo', 'radio', true, false], [third, 'radio', false, false], [fourth, 'radio', false, false]], '1/3', [false, false, 'random', true, 'OFF']]);
    assert.match(await hint(), /未启用轮询：只使用选中的这一把密钥/);
    await keyControl(`[data-key-toggle="${fourth}"]`, `control.prop('checked', true).trigger('change')`);
    await confirmManager();
    assert.deepEqual(await soloKeys(), [['solo', third, fourth], [third], 'off', fourth, false, []]);
    // A new key takes over until a key is picked by hand; then the pick stands.
    await openManager('solo-profile');
    await addKey('sk-9');
    assert.match(await hint(), /保存时添加 1 把新密钥（共 4 把）。.*未启用轮询：只使用选中的这一把密钥/);
    assert.deepEqual(await keyRows(), [['solo', 'radio', false, false], [third, 'radio', false, false], [fourth, 'radio', false, false], ['', 'radio', true, false]]);
    await keyControl(`[data-key-toggle="${fourth}"]`, `control.prop('checked', true).trigger('change')`);
    assert.deepEqual((await keyRows()).map(row => row[2]), [false, false, true, false]);
    await keyControl('[data-key-toggle^="new:"]', `control.prop('checked', true).trigger('change')`);
    assert.deepEqual((await keyRows()).map(row => row[2]), [false, false, false, true]);
    await confirmManager();
    saved = await soloKeys();
    assert.deepEqual([saved[0].length, saved[0].slice(0, 3), saved[3] === saved[0][3], saved[2], saved[5]], [4, ['solo', third, fourth], true, 'off', []]);
    log('channel manager: with rotation off only the selected key is used; a new key takes over unless another key is picked, and the others are kept');

    await openManager('solo-profile');
    await keyControl('[data-key-rotate]', `control.prop('checked', true).trigger('change')`);
    await run('messages.length = 0; true');
    for (const id of ['solo', fourth, saved[0][3]]) await keyControl(`[data-key-toggle="${id}"]`, `control.prop('checked', false).trigger('change')`);
    assert.deepEqual([(await keyRows()).map(row => row[2]), await keyCount(), await run(`messages.some(item => item.level === 'info' && item.message.includes('至少需要保留一把'))`)], [[false, false, false, true], '1/4', true]);
    await cancelManager();
    assert.deepEqual((await soloKeys()).slice(1, 3), [[third], 'off'], 'a cancelled edit changes nothing');
    // "清空" removes every key from the channel; an empty row is left to type into.
    await openManager('solo-profile');
    await keyAction('clear');
    assert.deepEqual([await keyRows(), await keyValues(), await keyCount(), (await rotationUi())[0]], [[['', 'radio', false, true]], [''], '', true]);
    await confirmManager();
    assert.deepEqual(await soloKeys(), [null, null, null, '', true, []]);
    await openManager('solo-profile');
    await addKey('sk-10');
    assert.equal((await keyRows()).length, 1, 'the empty row is reused');
    await confirmManager();
    saved = await soloKeys();
    assert.deepEqual([saved[0], Boolean(saved[3]), saved[4]], [null, true, false]);
    // A new key switched off before saving is saved switched off.
    const bound = saved[3];
    await openManager('solo-profile');
    await addKey('sk-11');
    await addKey('sk-12');
    await keyControl('[data-key-toggle^="new:"]', `control.last().prop('checked', false).trigger('change')`);
    assert.deepEqual([await keyRows(), await keyCount(), (await rotationUi()).slice(0, 2)], [[[bound, 'checkbox', true, false], ['', 'checkbox', true, false], ['', 'checkbox', false, false]], '2/3', [false, true]]);
    await confirmManager();
    saved = await soloKeys();
    assert.deepEqual([saved[0].length, saved[0][0], saved[1], saved[2], saved[3], saved[5]], [3, bound, [saved[0][2]], null, bound, saved[0].slice(0, 2)]);
    log('channel manager: the last enabled key of a rotating channel cannot be switched off; clearing unbinds the channel and a new key binds it again; a new key switched off is saved switched off');

    await openManager('solo-profile');
    await addKey('pw-1');
    await addKey('pw-2');
    await field('format', 'anthropic');
    await field('endpoint', 'https://proxy.invalid');
    assert.deepEqual([await keyRows(), await keyValues(), await keyCount(), (await rotationUi())[0]], [[['', 'radio', true, false], ['', 'radio', false, false]], ['pw-1', 'pw-2'], '', true]);
    assert.deepEqual(await run(`['add', 'paste', 'copy', 'clear'].map(name => $('${detail} [data-key-action="' + name + '"]').prop('hidden'))`), [true, true, true, true]);
    assert.match(await hint(), /暂不支持密钥池/);
    await run('messages.length = 0; [...ownedPopups][0].completeAffirmative()');
    assert.deepEqual(await run(`[ownedPopups.size, soloProfile.format, messages.some(item => item.level === 'warning' && item.message.includes('暂不支持密钥池'))]`), [1, 'openai', true]);
    await cancelManager();
    log('channel manager: a reverse-proxy channel lists no saved keys, offers no rotation or bulk actions, refuses several keys and stays unsaved');

    state.generateReply = null;
    await run('teardownQuickerApi()');
}

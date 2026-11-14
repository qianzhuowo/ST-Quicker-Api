import assert from 'node:assert/strict';

// Providers own the connection: the protocol is a Profile field edited as a
// draft, picking a model applies its provider, and native presets only switch
// the provider when the user turned preset linking on.
export async function runProviderRegressions({ page, state, log }) {
    const run = page.evaluate;
    const settle = async () => {
        for (let i = 0; i < 100; i++) {
            if (await run('pendingOperations === 0 && !presetTransitionBlocked')) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error('operations did not settle');
    };
    state.secrets = { api_key_custom: [{ id: 'secret-a', active: true }], api_key_claude: [{ id: 'empty-claude', active: true }], api_key_makersuite: [{ id: 'secret-b', active: true }] };
    state.secretValues = { api_key_custom: { 'secret-a': 'sk-a' }, api_key_makersuite: { 'secret-b': 'gm-b' } };
    await run(`(async () => {
        window.provA = normalizeProfile({id:'prov-a',name:'A',format:'openai',endpoint:'https://a.invalid/v1',model:'a-model',availableModels:['a-model','a-other'],secretId:'secret-a'});
        window.provB = normalizeProfile({id:'prov-b',name:'B',format:'gemini',endpoint:'',model:'gemini-default',availableModels:['gemini-default','gemini-b'],secretId:'secret-b'});
        settings().profiles = [provA, provB]; settings().presetBindings = {}; settings().presetModels = {};
        settings().quickActions = []; settings().presetLink = false; renderPanelMode();
        await readAuthoritativeSecretState();
        await applyProfileById(provB.id);
        await applyProfileById(provA.id);
    })()`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, oai_settings.custom_url, $('#quicker_api_preset_link').prop('checked')]`),
        ['prov-a', 'custom', 'https://a.invalid/v1', false]);

    // A preset saved with B's Gemini connection, and a stale binding to B.
    await run(`(async () => {
        oai_settings.bind_preset_to_connection = true;
        await importTestPreset('Gemini-B', {...structuredClone(oai_settings), chat_completion_source:'makersuite', google_model:'gemini-b', reverse_proxy:'https://b-residue.invalid'});
        settings().presetBindings['Gemini-B'] = provB.id;
        await applyProfileById(provA.id);
        await switchTestPreset('Gemini-B');
    })()`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, selectedProfile().id, oai_settings.chat_completion_source, oai_settings.custom_url, oai_settings.reverse_proxy === 'https://b-residue.invalid', oai_settings.preset_settings_openai]`),
        ['prov-a', 'prov-a', 'custom', 'https://a.invalid/v1', false, 'Gemini-B']);
    log('with preset linking off, a preset keeps the provider connection even with native bind on and a stored binding');

    const bindingsBefore = await run('JSON.stringify(settings().presetBindings)');
    await run(`document.getElementById('update_oai_preset').click(); nativeSaveTask`);
    assert.equal(await run('nativePresetSaveIntent'), null);
    await run('saveSelectedProfile()');
    await settle();
    assert.equal(await run('JSON.stringify(settings().presetBindings)'), bindingsBefore);
    log('with preset linking off, saving a preset or the API settings records no binding');

    // B's residue is still in the shared reverse_proxy field.
    await run(`oai_settings.reverse_proxy = 'https://b-residue.invalid'; oai_settings.proxy_password = 'b-pass'; $('#quicker_api_format').val('gemini').trigger('change')`);
    assert.deepEqual(await run(`[$('#quicker_api_profile_select').val(), $('#quicker_api_url').val(), oai_settings.chat_completion_source, oai_settings.custom_url, $('#quicker_api_status').text().includes('\u5c1a\u672a\u4fdd\u5b58')]`),
        ['prov-a', 'https://a.invalid/v1', 'custom', 'https://a.invalid/v1', true]);
    log('switching a Profile to Gemini edits only its draft: no host source change and no other provider\'s URL');

    await run('saveSelectedProfile()');
    await settle();
    assert.deepEqual(await run(`[provA.format, provA.endpoint, getBoundProxyPreset(provA)?.password, oai_settings.chat_completion_source, oai_settings.reverse_proxy, oai_settings.proxy_password, settings().activeProfileId]`),
        ['gemini', 'https://a.invalid/v1', 'sk-a', 'makersuite', 'https://a.invalid/v1', 'sk-a', 'prov-a']);
    assert.deepEqual(await run(`[provB.format, provB.endpoint, provB.secretId]`), ['gemini', '', 'secret-b']);
    log('saving A as Gemini applies A\'s own URL and carries A\'s key; B stays untouched');

    await run(`(async () => {
        window.provC = normalizeProfile({id:'prov-c',name:'C',format:'openai',endpoint:'https://c.invalid/v1',model:'c-model',availableModels:['c-model'],secretId:'secret-c'});
        settings().profiles.push(provC);
    })()`);
    state.secrets.api_key_custom.push({ id: 'secret-c', active: false });
    await run(`(async () => { await readAuthoritativeSecretState(); await applyProfileById(provC.id); $('#quicker_api_format').val('anthropic').trigger('change'); messages.length = 0; await saveSelectedProfile(); })()`);
    await settle();
    assert.deepEqual(await run(`[provC.format, provC.secretId, messages.some(m => m.level === 'warning' && m.message.includes('\u91cd\u65b0\u586b\u5199'))]`), ['openai', 'secret-c', true]);
    log('a protocol change whose key cannot be read is refused instead of adopting another key');

    await run(`(async () => { await applyProfileById(provA.id); openModelPicker(); switchModelPickerView('favorites'); })()`);
    await settle();
    const groups = await run(`$('#quicker_api_model_dropdown .quicker-api__model-group-name').toArray().map(e => e.textContent)`);
    assert.deepEqual(groups, ['A', 'B', 'C']);
    assert.equal(await run(`$('#quicker_api_model_dropdown .quicker-api__model-option[data-profile-id="prov-b"][data-model="gemini-b"]').length`), 1);
    await run(`activateModelPickerOption($('#quicker_api_model_dropdown .quicker-api__model-option[data-profile-id="prov-b"][data-model="gemini-b"]')[0])`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, selectedProfile().id, oai_settings.chat_completion_source, oai_settings.google_model, oai_settings.reverse_proxy, provB.model, getEditorModel()]`),
        ['prov-b', 'prov-b', 'makersuite', 'gemini-b', '', 'gemini-default', 'gemini-b']);
    log('favorites are grouped by provider; picking another provider\'s model applies that provider with the model');

    await run(`$('#quicker_api_custom_model').val('gemini-default').trigger('change')`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.google_model, $('#quicker_api_status').text().includes('\u5c1a\u672a\u4fdd\u5b58')]`), ['prov-b', 'gemini-default', false]);
    log('switching the live provider\'s own model writes it without marking the Profile unsaved');

    await run(`$('#quicker_api_preset_link').prop('checked', true).trigger('change')`);
    assert.equal(await run('settings().presetLink'), true);
    await run(`switchTestPreset('Gemini-B')`);
    await settle();
    assert.equal(await run('settings().activeProfileId'), 'prov-b');
    await run(`(async () => { await applyProfileById(provA.id); await switchTestPreset('Gemini-B'); })()`);
    await settle();
    assert.equal(await run('settings().activeProfileId'), 'prov-b');
    log('turning preset linking on restores the binding: the preset applies its provider again');

    await runChannelRegressions({ run, state, settle, log });
    delete state.secretValues;
}

// Channel manager, per-model formats and the "格式" picker view.
async function runChannelRegressions({ run, state, settle, log }) {
    const waitFor = async (expression, message) => {
        for (let i = 0; i < 100; i++) {
            if (await run(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error(message || `timed out waiting for ${expression}`);
    };
    const openManager = async id => {
        await run(`window.channelTask = manageChannels(${JSON.stringify(id)}); true`);
        await waitFor('ownedPopups.size === 1', 'channel manager did not open');
    };
    const confirmManager = async () => {
        await run('window.channelDone = [...ownedPopups][0].completeAffirmative(); channelDone');
        await run('channelTask');
        await settle();
    };
    const cancelManager = async () => {
        await run('[...ownedPopups][0].completeCancelled(); channelTask');
    };
    const field = (name, value) => run(`$('.quicker-api__channel-detail [data-field="${name}"]').val(${JSON.stringify(value)}).trigger('input'); true`);
    const rowFormat = (model, format) => run(`$('.quicker-api__chosen-model').filter((_,r)=>$(r).find('input').val()===${JSON.stringify(model)}).find('.quicker-api__model-format-select').val(${JSON.stringify(format)}).trigger('change'); true`);

    state.secrets.api_key_custom.push({ id: 'secret-d', active: false });
    state.secretValues.api_key_custom['secret-d'] = 'sk-d';
    await run(`(async () => {
        window.provD = normalizeProfile({id:'prov-d',name:'D',format:'openai',endpoint:'https://d.invalid/v1',model:'d-chat',availableModels:['d-chat','d-gem'],secretId:'secret-d'});
        settings().profiles.push(provD);
        settings().presetLink = false; renderPanelMode();
        await readAuthoritativeSecretState();
    })()`);

    // A model of an OpenAI-compatible channel set to Gemini needs the proxy
    // slot: the channel's own key is carried there on save.
    await openManager('prov-d');
    assert.deepEqual(await run(`[$('.quicker-api__channel-item').length, $('.quicker-api__channel-item.is-active').attr('data-channel-id'), $('.quicker-api__channel-detail [data-field="endpoint"]').val()]`),
        [4, 'prov-d', 'https://d.invalid/v1']);
    assert.equal(await run(`$('.quicker-api__chosen-model').first().find('.quicker-api__model-format-select option').first().text()`), '\u8ddf\u968f\u6e20\u9053\uff08OpenAI \u517c\u5bb9\uff09');
    await rowFormat('d-gem', 'gemini');
    assert.equal(await run(`$('.quicker-api__channel-item[data-channel-id="prov-d"] .quicker-api__channel-dirty').length`), 1);
    await confirmManager();
    assert.deepEqual(await run(`[JSON.stringify(provD.modelFormats), getBoundProxyPreset({proxyPreset: provD.extraCredentials.proxy})?.password, getBoundProxyPreset({proxyPreset: provD.extraCredentials.proxy})?.url, provD.secretId, settings().activeProfileId]`),
        ['{"d-gem":"gemini"}', 'sk-d', 'https://d.invalid/v1', 'secret-d', 'prov-b']);
    log('a per-model format is set in the channel manager; its other key slot gets the channel\'s own key on save');

    // The "格式" view groups every channel's favorites by the format they use.
    await run(`(async () => { openModelPicker(); switchModelPickerView('formats'); })()`);
    const formatGroups = await run(`$('#quicker_api_model_dropdown .quicker-api__model-group-name').toArray().map(e => e.textContent)`);
    assert.deepEqual(formatGroups, ['OpenAI \u517c\u5bb9', 'Gemini']);
    const geminiRows = await run(`$('#quicker_api_model_dropdown .quicker-api__model-group').filter((_,g)=>$(g).find('.quicker-api__model-group-name').text()==='Gemini').nextUntil('.quicker-api__model-group').toArray().map(r => r.getAttribute('data-profile-id') + ':' + r.getAttribute('data-model'))`);
    assert.ok(geminiRows.includes('prov-d:d-gem') && geminiRows.includes('prov-b:gemini-b') && !geminiRows.includes('prov-d:d-chat'), JSON.stringify(geminiRows));
    await run(`activateModelPickerOption($('#quicker_api_model_dropdown .quicker-api__model-option[data-profile-id="prov-d"][data-model="d-gem"]')[0])`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, oai_settings.reverse_proxy, oai_settings.proxy_password, oai_settings.google_model, $('#quicker_api_format').val(), getEditorModel(), $('#quicker_api_status').text()]`),
        ['prov-d', 'makersuite', 'https://d.invalid/v1', 'sk-d', 'd-gem', 'openai', 'd-gem', '\u5df2\u4fdd\u5b58\u5e76\u5b89\u5168\u5e94\u7528\u3002']);
    await run(`(async () => { openModelPicker(); switchModelPickerView('favorites'); })()`);
    assert.equal(await run(`$('#quicker_api_model_dropdown .quicker-api__model-option[data-model="d-gem"]:not([data-profile-id]) .quicker-api__model-format-tag').text()`), 'Gemini');
    await run(`activateModelPickerOption($('#quicker_api_model_dropdown .quicker-api__model-option[data-model="d-chat"]:not([data-profile-id])')[0])`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, oai_settings.custom_url, oai_settings.custom_model, getActiveSecret('api_key_custom')?.id, $('#quicker_api_status').text()]`),
        ['prov-d', 'custom', 'https://d.invalid/v1', 'd-chat', 'secret-d', '\u5df2\u4fdd\u5b58\u5e76\u5b89\u5168\u5e94\u7528\u3002']);
    log('the format view groups favorites by format; picking a model connects its channel with that model\'s format and key slot');

    // A per-model format without a credential for its slot is refused, until a key is saved for it.
    await run(`(async () => {
        window.provE = normalizeProfile({id:'prov-e',name:'E',format:'gemini',endpoint:'',model:'e-gem',availableModels:['e-gem','e-oai'],secretId:'secret-b',modelFormats:{'e-oai':'openai'}});
        settings().profiles.push(provE);
        messages.length = 0;
        window.refused = await applyProfileById(provE.id, quickActionTransaction, { model: 'e-oai' });
    })()`);
    await settle();
    assert.deepEqual(await run(`[refused, settings().activeProfileId, oai_settings.chat_completion_source, messages.some(m => m.level === 'warning' && m.message.includes('\u9700\u8981\u8be5\u683c\u5f0f\u7684\u5bc6\u94a5'))]`),
        [false, 'prov-d', 'custom', true]);
    await openManager('prov-e');
    await field('key', 'sk-e');
    await confirmManager();
    const extraId = await run('provE.extraCredentials.api_key_custom');
    assert.ok(extraId && extraId.startsWith('written-'), String(extraId));
    assert.equal(await run(`getActiveSecret('api_key_custom')?.id`), 'secret-d', 'writing a channel key never changes the live key of that slot');
    await run(`applyProfileById(provE.id, quickActionTransaction, { model: 'e-oai' })`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, oai_settings.custom_model, getActiveSecret('api_key_custom')?.id === provE.extraCredentials.api_key_custom]`),
        ['prov-e', 'custom', 'e-oai', true]);
    log('a model format without a key for its slot is refused; a key typed in the channel manager is written there and used');

    // New / cancel / save / delete, all drafts until "保存".
    const countBefore = await run('profiles().length');
    await openManager('prov-d');
    await run(`$('.quicker-api__channel-new').trigger('click'); true`);
    await field('name', 'New-X');
    await cancelManager();
    assert.equal(await run('profiles().length'), countBefore);
    await openManager('prov-d');
    await run(`$('.quicker-api__channel-new').trigger('click'); true`);
    await field('name', 'New-X');
    await field('endpoint', 'https://x.invalid/v1');
    await field('key', 'sk-x');
    await run(`$('.quicker-api__manager-panel[data-page="chosen"] .quicker-api__manager-actions > input').val('x-model'); $('.quicker-api__manager-panel[data-page="chosen"] [data-action="add"]').trigger('click'); true`);
    await confirmManager();
    const created = await run(`(() => { const p = profiles().find(item => item.name === 'New-X'); return p && [p.format, p.endpoint, p.needsSecret, Boolean(p.secretId), JSON.stringify(p.availableModels), Boolean(p.draft)]; })()`);
    assert.deepEqual(created, ['openai', 'https://x.invalid/v1', false, true, '["x-model"]', false]);
    assert.deepEqual(await run(`[settings().activeProfileId, getActiveSecret('api_key_custom')?.id === provE.extraCredentials.api_key_custom]`), ['prov-e', true], 'a new channel is saved, not applied');
    const newId = await run(`profiles().find(item => item.name === 'New-X').id`);
    await openManager(newId);
    await run(`$('[data-channel-action="delete"]').trigger('click'); true`);
    assert.equal(await run(`$('.quicker-api__channel-item[data-channel-id="${newId}"]').length`), 0);
    await run('window.channelDone = [...ownedPopups][0].completeAffirmative(); true');
    await waitFor('ownedPopups.size === 2', 'delete confirmation did not open');
    await run('[...ownedPopups][1].completeAffirmative()');
    await run('channelDone');
    await run('channelTask');
    assert.equal(await run(`profiles().some(item => item.id === ${JSON.stringify(newId)})`), false);
    log('channel manager: new channels, edits and deletions are drafts committed by 保存 and discarded by 取消');

    // Removing a model with its own format drops that format, the extra
    // credential it needed and the Quicker proxy preset nobody else uses.
    const extraProxy = await run('provD.extraCredentials.proxy');
    assert.ok(extraProxy && await run(`proxies.some(p => p.name === ${JSON.stringify(extraProxy)})`));
    await run(`$('#openai_proxy_preset').val(null); toggleFavoriteModel('d-gem', 'prov-d', mainModelPicker); true`);
    assert.deepEqual(await run(`[JSON.stringify(provD.modelFormats), JSON.stringify(provD.extraCredentials), proxies.some(p => p.name === ${JSON.stringify(extraProxy)}), provD.secretId]`),
        ['{}', '{}', false, 'secret-d']);
    assert.equal(await run(`JSON.stringify(normalizeProfile({format:'openai',model:'m',availableModels:['m'],modelFormats:{gone:'gemini',m:'openai_responses'}}).modelFormats)`), '{"m":"openai_responses"}');
    const deletion = await run(`(() => {
        proxies.push({ name: 'Mine', url: 'https://mine.invalid', password: 'x' });
        const g = normalizeProfile({id:'prov-g',name:'G',format:'gemini',endpoint:'https://g.invalid',model:'g',availableModels:['g']});
        g.proxyPreset = ensureBoundProxyPreset('G', 'https://g.invalid', 'pw', '', 'prov-g');
        settings().profiles.push(g);
        const name = g.proxyPreset;
        removeProfileData(g);
        releaseUnusedProxyPresets(['Mine']);
        return [name.startsWith('Quicker \u00b7 '), proxies.some(p => p.name === name), proxies.some(p => p.name === 'Mine'), profiles().some(p => p.id === 'prov-g')];
    })()`);
    assert.deepEqual(deletion, [true, false, true, false]);
    log('removing a per-format model or deleting its channel cleans the format, extra credential and owned proxy preset');

    // The quick-action manager uses the same dropdown: favorites of a chosen
    // configuration by default, "格式" without one; "全部" is only one
    // configuration's manually fetched list; tabs share one row.
    await run(`settings().quickActions = []; window.quickTask = manageQuickActions(); true`);
    await waitFor('ownedPopups.size === 1', 'quick manager did not open');
    await run(`$('.quicker-api__quick-list-toolbar button').first().trigger('click'); true`);
    await run(`$('#quicker_api_quick_model_trigger').trigger('click'); true`);
    const noProfile = await run(`(() => { const d = $('#quicker_api_quick_model_dropdown'); const tops = d.find('[data-model-view]').toArray().map(t => Math.round(t.getBoundingClientRect().top));
        return [d.closest('dialog').length, d.find('[data-model-view].is-active').attr('data-model-view'), new Set(tops).size, tops.length, d.find('.quicker-api__model-option[data-profile-id="prov-b"][data-model="gemini-b"]').length]; })()`);
    assert.deepEqual(noProfile, [1, 'formats', 1, 3, 1]);
    await run(`$('#quicker_api_quick_model_dropdown [data-model-view="all"]').trigger('click'); true`);
    assert.deepEqual(await run(`[$('#quicker_api_quick_model_dropdown .quicker-api__model-option').length, $('#quicker_api_quick_model_dropdown [data-model-picker-action="fetch"]').prop('disabled'), pendingOperations]`), [0, true, 0]);
    await run(`$('#quicker_api_quick_model_dropdown [data-model-view="formats"]').trigger('click'); activateModelPickerOption($('#quicker_api_quick_model_dropdown .quicker-api__model-option[data-profile-id="prov-b"][data-model="gemini-b"]')[0]); true`);
    assert.deepEqual(await run(`[$('.quicker-api__quick-editor select').eq(1).val(), $('#quicker_api_quick_model_trigger .quicker-api__model-trigger-label').text(), settings().activeProfileId]`), ['prov-b', 'gemini-b', 'prov-e']);
    await run(`$('.quicker-api__quick-editor select').eq(1).val('prov-d').trigger('change'); $('#quicker_api_quick_model_trigger').trigger('click'); true`);
    assert.deepEqual(await run(`[$('#quicker_api_quick_model_dropdown [data-model-view].is-active').attr('data-model-view'), $('#quicker_api_quick_model_dropdown .quicker-api__model-option[data-model="d-chat"]:not([data-profile-id])').length]`), ['favorites', 1]);
    await run(`$('#quicker_api_quick_model_dropdown [data-model-view="all"]').trigger('click'); true`);
    assert.deepEqual(await run(`[pendingOperations, $('#quicker_api_quick_model_dropdown [data-model-picker-action="fetch"]').prop('disabled')]`), [0, false], 'opening 全部 never fetches by itself');
    await run('[...ownedPopups][0].completeCancelled(); quickTask');
    assert.deepEqual(await run(`[modelPickerHosts.has('quicker_api_quick_model'), $('#quicker_api_quick_model_portal').length, settings().quickActions.length]`), [false, 0, 0]);
    log('the quick-action manager reuses the model dropdown: configuration favorites by default, otherwise 格式; 全部 is never auto-fetched');

    const toggle = await run(`(() => { const input = document.getElementById('quicker_api_preset_link'); const before = input.checked; document.querySelector('.quicker-api__preset-link').click(); return [input.getAttribute('role'), before, input.checked, settings().presetLink]; })()`);
    assert.deepEqual(toggle, ['switch', false, true, true]);
    await run(`document.querySelector('.quicker-api__preset-link').click()`);
    assert.equal(await run('settings().presetLink'), false);
    log('the preset link switch is a labelled switch control that toggles the setting');

    // Both pill switches hug their content: the host's checkbox styling must not
    // leave the hidden input occupying space at the left edge.
    const switches = await run(`[...document.querySelectorAll('.quicker-api__switch')].map(label => { const r = label.getBoundingClientRect(); const track = label.querySelector('.quicker-api__switch-track').getBoundingClientRect(); const input = label.querySelector('input').getBoundingClientRect();
        return { text: label.textContent.trim(), gap: Math.round(track.left - r.left), input: Math.round(input.width), icon: label.querySelectorAll('i').length }; })`);
    assert.deepEqual(switches.map(item => item.text), ['\u63d2\u4ef6\u542f\u7528', '\u8054\u52a8\u9884\u8bbe']);
    assert.ok(switches.every(item => item.gap <= 8 && item.input <= 1 && item.icon === 0), JSON.stringify(switches));
    log('插件启用 and 联动预设 share one compact switch style without an extra icon or left gap');
}

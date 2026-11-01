import assert from 'node:assert/strict';

// v3.10: named draft channels, external /model sync, dropdown stale cleanup,
// per-scheme sampling parameters and the in-use quick action marker.
export async function runV310Regressions({ page, log }) {
    const run = page.evaluate;
    await run(`
        window.v310Base = normalizeProfile({id:'v310-a',name:'Channel A',format:'openai',endpoint:'https://a.invalid/v1',model:'model-a',
            availableModels:['model-a','fav-a2'],fetchedModels:['model-a','remote-a'],fetchedFromEndpoint:'https://a.invalid/v1',secretId:'test-secret',modelListVersion:2});
        settings().profiles=[v310Base]; settings().presetBindings={A:'v310-a',B:'v310-a'};
        settings().presetModels={A:presetModelSnapshot(v310Base,'model-a'),B:presetModelSnapshot(v310Base,'model-b')};
        settings().quickActions=[]; settings().activeQuickActionId='';
        settings().selectedProfileId='v310-a'; settings().activeProfileId=null;
        oai_settings.chat_completion_source='custom'; oai_settings.custom_url='https://a.invalid/v1'; oai_settings.custom_model='model-a';
        $('#chat_completion_source').val('custom'); $('#custom_model_id').val('model-a');
        applyProfileById('v310-a');
    `);
    assert.equal(await run(`settings().activeProfileId`), 'v310-a');

    // 1. New channel: name first, then an empty draft that inherits nothing.
    await run(`window.v310Prompt = promptName; promptName = async () => 'Channel B'; createProfile()`);
    const draft = await run(`(() => { const p = selectedProfile(); return {
        name:p.name, draft:p.draft, model:p.model, endpoint:p.endpoint, favorites:p.availableModels, secretId:p.secretId,
        editorModel:getEditorModel(), url:$('#quicker_api_url').val(), options:$('#quicker_api_custom_model option').toArray().map(o=>o.value).filter(Boolean),
        native:oai_settings.custom_model, active:settings().activeProfileId, saved:profiles().length,
        label:$('#quicker_api_profile_select option:selected').text(), status:$('#quicker_api_status').text() }; })()`);
    assert.equal(draft.name, 'Channel B');
    assert.equal(draft.draft, true);
    assert.deepEqual([draft.model, draft.endpoint, draft.favorites, draft.secretId, draft.editorModel, draft.url, draft.options], ['', '', [], '', '', '', []]);
    assert.deepEqual([draft.native, draft.active, draft.saved], ['model-a', 'v310-a', 2], 'creating a draft leaves the live connection untouched');
    assert.match(draft.label, /Channel B（未保存）/);
    assert.match(draft.status, /新配置尚未保存/);
    log('new channel asks for a name first and creates an empty, unapplied draft with no inherited URL, model, favorites or key');

    await run(`$('#quicker_api_custom_model').append(new Option('typed-b','typed-b')).val('typed-b').trigger('change')`);
    assert.equal(await run('oai_settings.custom_model'), 'model-a', 'editing a draft never writes to the live connection');
    await run(`$('#quicker_api_url').val('https://b.invalid/v1').trigger('input'); enqueueOperation(saveSelectedProfile)`);
    const saved = await run(`(() => { const p = profiles().find(p=>p.name==='Channel B'); return {draft:Object.hasOwn(p,'draft'), model:p.model, favorites:p.availableModels,
        endpoint:p.endpoint, secretId:p.secretId, needsSecret:p.needsSecret, active:settings().activeProfileId===p.id, native:oai_settings.custom_model, count:profiles().length}; })()`);
    assert.deepEqual(saved.favorites, ['typed-b'], 'only the chosen model is favorited; nothing from the previous channel remains');
    assert.deepEqual([saved.draft, saved.model, saved.endpoint, saved.count], [false, 'typed-b', 'https://b.invalid/v1', 2]);
    assert.notEqual(saved.secretId, 'test-secret', 'a draft never borrows the previously active key');
    assert.equal(saved.needsSecret, true);
    assert.deepEqual([saved.active, saved.native], [true, 'typed-b']);
    log('saving the draft keeps its name, favorites only its own model and never borrows the old channel key');

    await run(`promptName = async () => null; createProfile()`);
    assert.equal(await run('profiles().length'), 2, 'cancelling the name prompt creates nothing');
    await run(`promptName = async () => 'Draft C'; createProfile()`);
    await run(`$('#quicker_api_format').val('anthropic').trigger('change')`);
    assert.deepEqual(await run(`[selectedProfile().format, selectedProfile().draft, $('#quicker_api_url').val(), getEditorModel(), oai_settings.chat_completion_source]`),
        ['anthropic', true, '', '', 'custom'], 'changing a draft format keeps it blank and does not switch the live source');
    await run(`settings().profiles = profiles().filter(p => p.name !== 'Draft C'); promptName = v310Prompt; $('#quicker_api_profile_select').val('v310-a').trigger('change'); operationQueue`);
    log('cancel creates nothing and a draft format switch stays blank and unapplied');

    // 2. External model changes (/model, native control, other extensions).
    await run(`$('#custom_model_id').val('qr-model').trigger('input'); new Promise(r => setTimeout(r, 30))`);
    assert.deepEqual(await run(`[getEditorModel(), $('.quicker-api__model-trigger-label').text()]`), ['qr-model', 'qr-model']);
    await run(`pendingOperations++; $('#custom_model_id').val('busy-model').trigger('input')`);
    assert.equal(await run('getEditorModel()'), 'qr-model');
    await run(`pendingOperations--; new Promise(r => setTimeout(r, 400))`);
    assert.equal(await run('getEditorModel()'), 'busy-model', 'a change during a running operation is shown once it settles');
    log('/model and other external model changes update the panel immediately, or right after a running operation');

    await run(`(async () => {
        const preset = structuredClone(openai_settings[openai_setting_names.B]);
        oai_settings.preset_settings_openai = 'B'; $('#settings_preset_openai').val(openai_setting_names.B);
        const before = eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, { presetName: 'B', preset });
        $('#custom_model_id').val('chained-model').trigger('input');
        await before;
        Object.assign(oai_settings, preset, { preset_settings_openai: 'B', custom_model: oai_settings.custom_model });
        $('#chat_completion_source').val('custom').trigger('change');
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        await new Promise(r => setTimeout(r, 30));
    })()`);
    assert.deepEqual(await run(`[oai_settings.custom_model, getEditorModel(), $('#custom_model_id').val()]`), ['chained-model', 'chained-model', 'chained-model']);
    await run(`switchTestPreset('A')`);
    assert.deepEqual(await run(`[oai_settings.custom_model, getEditorModel()]`), ['model-a', 'model-a'], 'a plain preset switch still restores its bound model');
    log('"/preset B | /model X": a model chosen while the preset is applied wins over the preset model and is shown');

    // 3. Dropdown stale cleanup.
    await run(`$('#quicker_api_model_trigger').trigger('click')`);
    const prune = await run(`(() => { const b=$('[data-model-picker-action="prune"]'); return {disabled:b.prop('disabled'), title:b.attr('title'), stale:b.hasClass('has-stale')}; })()`);
    assert.deepEqual([prune.disabled, prune.stale], [false, true]);
    assert.match(prune.title, /1 个/);
    await run(`$('[data-model-picker-action="prune"]').trigger('click')`);
    const pruned = await run(`({favorites:[...profiles().find(p=>p.id==='v310-a').availableModels], disabled:$('[data-model-picker-action="prune"]').prop('disabled'),
        open:!$('#quicker_api_model_dropdown').prop('hidden'), current:getEditorModel()})`);
    assert.deepEqual(pruned, { favorites: ['model-a'], disabled: true, open: true, current: 'model-a' });
    await run(`closeModelPicker()`);
    log('the dropdown broom button removes stale favorites in place and disables itself when nothing is stale');

    // 4/5. Per-scheme sampling parameters and in-use marker.
    await run(`
        settings().quickActions=[
            normalizeQuickAction({id:'qa-other',name:'Other',preset:'B',profileId:'v310-a',model:'model-z',sequence:0}),
            normalizeQuickAction({id:'qa-mine',name:'Mine',profileId:'v310-a',model:'model-a',sequence:1,
                params:{enabled:true,temperature:{send:true,value:1.37},frequency_penalty:{send:false,value:null},presence_penalty:{send:true,value:null},top_p:{send:false,value:0.5}}}),
        ];
        settings().activeQuickActionId='';
    `);
    assert.deepEqual(await run(`normalizeQuickAction({id:'x',model:'m'}).params`), {
        enabled: false, temperature: { send: true, value: null }, frequency_penalty: { send: true, value: null },
        presence_penalty: { send: true, value: null }, top_p: { send: true, value: null } }, 'parameters default to off (follow the preset)');
    assert.equal(await run(`normalizeQuickAction({params:{enabled:true,temperature:{value:9}}}).params.temperature.value`), 2, 'values are clamped to the native range');
    const generated = await run(`fixtureGenerationData().then(data => ({temperature:data.temperature, top_p:Object.hasOwn(data,'top_p'), frequency_penalty:Object.hasOwn(data,'frequency_penalty'), active:activeQuickAction()?.id}))`);
    assert.deepEqual(generated, { temperature: 1.37, top_p: false, frequency_penalty: false, active: 'qa-mine' });
    log('an in-use scheme overrides temperature, leaves unset values to the preset and omits unchecked parameters');

    const menu = await run(`(() => { document.body.insertAdjacentHTML('beforeend','<button id="v310_anchor">Q</button>'); openQuickActionMenu(document.getElementById('v310_anchor'), 'rightSendForm');
        const rows = $('.quicker-api__quick-menu .ctx-item').toArray().map(e => ({name:$(e).find('.qr--button-label').text(), active:e.classList.contains('is-active'), current:e.getAttribute('aria-current'), params:!!e.querySelector('.quicker-api__quick-menu-params')}));
        const border = getComputedStyle(document.querySelector('.quicker-api__quick-menu .is-active')).borderLeftWidth;
        closeQuickActionMenu(); document.getElementById('v310_anchor').remove();
        return { rows, border }; })()`);
    assert.deepEqual(menu.rows, [{ name: 'Other', active: false, current: null, params: false }, { name: 'Mine', active: true, current: 'true', params: true }]);
    assert.equal(menu.border, '3px');
    log('the quick menu highlights the scheme matching the live preset/channel/model and marks schemes with parameters');

    await run(`$('#custom_model_id').val('model-other').trigger('input'); new Promise(r => setTimeout(r, 30))`);
    const after = await run(`fixtureGenerationData().then(data => ({temperature:data.temperature, top_p:data.top_p, active:activeQuickAction()?.id ?? null}))`);
    assert.deepEqual(after, { temperature: 0.7, top_p: 0.9, active: null }, 'leaving the scheme stops its overrides');
    await run(`$('#custom_model_id').val('model-a').trigger('input'); runQuickAction(settings().quickActions[1], ++quickActionTransaction)`);
    assert.equal(await run('settings().activeQuickActionId'), 'qa-mine');
    log('parameters apply only while the scheme is in use; running a scheme records it as the active one');

    await run(`void manageQuickActions(); new Promise(r => setTimeout(r, 30))`);
    await run(`$('.quicker-api__quick-item').eq(1).trigger('click')`);
    const editor = await run(`({rows:$('.quicker-api__quick-param').length, hidden:$('.quicker-api__quick-params-rows').prop('hidden'), checked:$('.quicker-api__quick-params-toggle input').prop('checked'),
        offRows:$('.quicker-api__quick-param.is-off').length, temp:$('.quicker-api__quick-param').eq(0).find('input[type=number]').val()})`);
    assert.deepEqual(editor, { rows: 4, hidden: false, checked: true, offRows: 2, temp: '1.37' });
    await run(`$('.quicker-api__quick-params-toggle input').prop('checked', false).trigger('change')`);
    assert.equal(await run(`[$('.quicker-api__quick-params-rows').prop('hidden'), $('.quicker-api__quick-editor').hasClass('has-unsaved-detail')].join()`), 'true,true');
    await run(`$('dialog.popup').toArray().forEach(d => d.remove()); ownedPopups.clear()`);
    log('the scheme editor exposes the four parameters with per-parameter send switches behind a default-off toggle');
}

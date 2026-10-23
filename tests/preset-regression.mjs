import assert from 'node:assert/strict';

// Invoked by regression.mjs for both hosts; all account IO stays in the fixture.
export async function runPresetRegressions({ page, state, log }) {
    const run = page.evaluate;
    await run(`(async () => {
        window.importProfile = normalizeProfile({id:'import-profile',name:'Import profile',format:'openai',
            endpoint:'https://import.invalid/v1',model:'profile-default',secretId:'test-secret',
            availableModels:['profile-default','previous-model','chosen-model']});
        settings().profiles = [importProfile]; settings().presetBindings = {}; settings().presetModels = {};
        settings().selectedProfileId = importProfile.id;
        await applyProfileById(importProfile.id);
    })()`);
    for (const bind of [true, false]) {
        const name = `Imported-${bind}`;
        await run(`(async () => {
            await applyProfileById(importProfile.id);
            renderModelControl(importProfile, 'previous-model'); syncEditorModelToNative();
            oai_settings.bind_preset_to_connection = ${bind};
            await importTestPreset(${JSON.stringify(name)}, {
                ...structuredClone(oai_settings), custom_model:'imported-default',
                custom_url:importProfile.endpoint, chat_completion_source:'custom'
            });
        })()`);
        assert.deepEqual(await run(`[oai_settings.custom_model, getEditorModel(), editorModelBaseline]`),
            bind ? ['imported-default', 'imported-default', 'imported-default'] : ['previous-model', 'previous-model', 'previous-model']);
        assert.equal(await run(`settings().presetBindings[${JSON.stringify(name)}]`), undefined);
        assert.equal(await run(`settings().activeProfileId`), 'import-profile');
        log(`import aligns the unbound model without binding or replacing connection state (native bind=${bind})`);

        state.failPreset = true;
        try {
            await run(`renderModelControl(importProfile, 'chosen-model'); document.getElementById('update_oai_preset').click(); nativeSaveTask`);
            assert.equal(await run(`settings().presetBindings[${JSON.stringify(name)}]`), undefined);
        } finally { state.failPreset = false; }
        log(`failed native update leaves imported preset unbound (native bind=${bind})`);
        await run(`renderModelControl(importProfile, 'chosen-model'); document.getElementById('update_oai_preset').click(); nativeSaveTask`);
        assert.deepEqual(await run(`[settings().presetBindings[${JSON.stringify(name)}], settings().presetModels[${JSON.stringify(name)}]?.model, importProfile.model]`),
            ['import-profile', 'chosen-model', 'profile-default']);
        await run(`renderModelControl(importProfile, 'previous-model'); syncEditorModelToNative(); switchTestPreset(${JSON.stringify(name)})`);
        assert.deepEqual(await run(`[oai_settings.custom_model, getEditorModel()]`), ['chosen-model', 'chosen-model']);
        log(`native update binds an imported preset without requiring API save (native bind=${bind})`);
    }
    // An import that changes the connection must never inherit verified API state.
    await run(`oai_settings.bind_preset_to_connection = true; importTestPreset('Foreign-connection', {
        ...structuredClone(oai_settings), custom_model:'foreign-model', custom_url:'https://foreign.invalid/v1'
    })`);
    assert.deepEqual(await run(`[settings().activeProfileId, getEditorModel(), oai_settings.custom_model]`),
        [null, 'chosen-model', 'foreign-model']);
    await run(`document.getElementById('update_oai_preset').click()`);
    assert.equal(await run(`nativePresetSaveIntent`), null);
    assert.equal(await run(`settings().presetBindings['Foreign-connection']`), undefined);
    log('changed imported endpoints invalidate active API state and cannot be silently bound');
    for (const [source, format, field] of [['claude', 'anthropic', 'claude_model'], ['makersuite', 'gemini', 'google_model']]) {
        await run(`(async () => {
            await applyProfileById(importProfile.id);
            oai_settings.bind_preset_to_connection = true;
            await importTestPreset(${JSON.stringify('Imported-' + source)}, {
                ...structuredClone(oai_settings), chat_completion_source:${JSON.stringify(source)},
                [${JSON.stringify(field)}]:'imported-provider-model', reverse_proxy:''
            });
        })()`);
        assert.deepEqual(await run(`[settings().activeProfileId, $('#quicker_api_format').val(), getEditorModel(), editorModelBaseline, $('#quicker_api_url').val()]`),
            [null, 'openai', 'profile-default', 'profile-default', 'https://import.invalid/v1']);
        await run(`document.getElementById('update_oai_preset').click()`);
        assert.equal(await run('nativePresetSaveIntent'), null);
        assert.equal(await run(`settings().presetBindings[${JSON.stringify('Imported-' + source)}]`), undefined);
        log(`cross-source ${format} import preserves the selected Profile editor without applying or binding it`);
    }
    // Delete the binding, fall back to native defaults, then import a preset
    // without connection fields. Neither the editor nor a subsequent API save
    // may adopt those defaults under the selected Profile's name.
    await run(`(async () => {
        await applyProfileById(importProfile.id);
        settings().presetBindings['Deleted'] = importProfile.id;
        handlePresetDeleted({apiId:'openai', name:'Deleted'});
        await importTestPreset('Native fallback', {
            ...structuredClone(oai_settings), custom_url:'https://native-default.invalid/v1', custom_model:'native-default'
        });
        await importTestPreset('No connection fields', {temperature:0.8});
        // Late host model notifications must not overwrite an inactive Profile.
        handleNativeModelChange();
    })()`);
    assert.deepEqual(await run(`[settings().activeProfileId, $('#quicker_api_url').val(), getEditorModel(), $('#quicker_api_key_input').attr('placeholder')]`),
        [null, 'https://import.invalid/v1', 'profile-default', '已配置密钥（点击眼睛查看）']);
    await run('saveSelectedProfile()');
    assert.deepEqual(await run(`[importProfile.endpoint, importProfile.model, importProfile.secretId]`),
        ['https://import.invalid/v1', 'profile-default', 'test-secret']);
    log('delete → fallback → import without connection fields → save preserves Profile URL/model/secret');

    // Saving must apply the full connection, not merely stamp activeProfileId.
    state.secrets = { api_key_custom: [{id:'native-secret',active:true}, {id:'test-secret',active:false}] };
    await run(`(async () => {
        $('#chat_completion_source').append($('<option>').val('openai').text('OpenAI'));
        await importTestPreset('OpenAI fallback', {
            ...structuredClone(oai_settings), chat_completion_source:'openai',
            custom_url:'https://native-default.invalid/v1', custom_model:'native-default'
        });
        $('#quicker_api_url').val('https://edited-profile.invalid/v1');
        renderModelControl(importProfile, 'edited-model');
        messages.length = 0;
    })()`);
    state.failNextRotation = true;
    await run('enqueueOperation(saveSelectedProfile)');
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, oai_settings.custom_url, oai_settings.custom_model, getActiveSecret(SECRET_KEYS.CUSTOM)?.id]`),
        [null, 'openai', 'https://native-default.invalid/v1', 'native-default', 'native-secret']);
    assert.equal(await run(`settings().presetBindings['OpenAI fallback']`), undefined);
    assert.equal(await run(`messages.some(m=>m.level==='success')`), false);
    assert.equal(await run(`$('#quicker_api_status').text().includes('已保存并安全应用')`), false);
    assert.deepEqual(await run(`[importProfile.endpoint,importProfile.model]`), ['https://edited-profile.invalid/v1', 'edited-model']);
    log('failed save application retains saved edits but preserves native connection/key and does not claim active or bind preset');
    await run('enqueueOperation(saveSelectedProfile)');
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.chat_completion_source, $('#chat_completion_source').val(), oai_settings.custom_url, oai_settings.custom_model, getActiveSecret(SECRET_KEYS.CUSTOM)?.id]`),
        ['import-profile','custom','custom','https://edited-profile.invalid/v1','edited-model','test-secret']);
    assert.equal(await run(`settings().presetBindings['OpenAI fallback']`), 'import-profile');
    assert.equal(await run(`$('#quicker_api_status').text()`), '已保存并安全应用。');
    log('saving after OpenAI fallback immediately applies Custom source, edited URL/model and bound key without reload');
    await run(`oai_settings.chat_completion_source='openai'; renderStatus()`);
    assert.equal(await run(`$('#quicker_api_status').text().includes('已保存并安全应用')`), false);
    log('status does not trust a stale active Profile marker when native source diverges');
    delete state.secrets;
    await run(`importProfile.endpoint='https://import.invalid/v1'; importProfile.model='profile-default'`);

    await run(`(async () => {
        await applyProfileById(importProfile.id);
        $('#quicker_api_url').val('https://draft.invalid/v1');
        renderModelControl(importProfile, 'draft-model');
        $('#quicker_api_key_input').val('fixture-draft-key').trigger('input');
        settings().presetBindings['Deleted draft'] = importProfile.id;
        handlePresetDeleted({apiId:'openai', name:'Deleted draft'});
        await switchTestPreset('Native fallback');
    })()`);
    assert.deepEqual(await run(`[$('#quicker_api_url').val(), getEditorModel(), $('#quicker_api_key_input').val(), keyEditorDirty]`),
        ['https://draft.invalid/v1', 'draft-model', 'fixture-draft-key', true]);
    log('deleting and switching unbound presets preserves unsaved URL/model/key drafts');

    await run(`settings().selectedProfileId = null; renderProfiles(); switchTestPreset('Native fallback')`);
    assert.deepEqual(await run(`[$('#quicker_api_url').val(), getEditorModel()]`),
        ['https://native-default.invalid/v1', 'native-default']);
    log('without a selected Profile, native connection values still populate the editor');
    await run('persistSettingsNow(); teardownQuickerApi()');
}

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
        [null, 'foreign-model', 'foreign-model']);
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
            [null, format, 'imported-provider-model', 'imported-provider-model', '']);
        await run(`document.getElementById('update_oai_preset').click()`);
        assert.equal(await run('nativePresetSaveIntent'), null);
        assert.equal(await run(`settings().presetBindings[${JSON.stringify('Imported-' + source)}]`), undefined);
        log(`cross-source import displays native ${format} model without applying or binding the previous Profile`);
    }
    await run('persistSettingsNow(); teardownQuickerApi()');
}

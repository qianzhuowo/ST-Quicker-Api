import assert from 'node:assert/strict';

// Called by regression.mjs on an isolated browser page, using synthetic profiles.
export async function runParameterRegressions({ page, state, scopedHost, log }) {
    const run = page.evaluate;
    const values = tag => ({ includeBody: `tag: ${tag}`, excludeBody: '["temperature"]', includeHeaders: `X-Test: ${tag}` });
    const blank = { includeBody: '', excludeBody: '', includeHeaders: '' };
    const profiles = [
        { id: 'params-a', name: 'Parameters A', format: 'openai', endpoint: 'https://parameters.invalid/v1', model: 'model-a', ...values('A') },
        { id: 'params-b', name: 'Parameters B', format: 'openai', endpoint: 'https://parameters.invalid/v1', model: 'model-b', ...values('B') },
        { id: 'params-empty', name: 'Empty Parameters', format: 'openai', endpoint: 'https://parameters.invalid/v1', model: 'model-a', ...blank },
        { id: 'params-claude', name: 'Claude', format: 'anthropic', endpoint: '', model: 'claude-model', ...blank, excludeBody: '["top_p"]' },
        { id: 'params-gemini', name: 'Gemini', format: 'gemini', endpoint: '', model: 'gemini-model', ...blank, excludeBody: '["top_k"]' },
    ].map(profile => ({ ...profile, secretId: 'test-secret' }));
    await run(`
        settings().profiles = ${JSON.stringify(profiles)}.map(normalizeProfile);
        settings().presetBindings = { A: 'params-a', B: 'params-b' };
        settings().presetModels = {};
        oai_settings.preset_settings_openai = 'A';
        $('#settings_preset_openai').val(openai_setting_names.A);
        if (scopedHost) {
            oai_settings.additional_parameters_by_source = {
                claude: {include_body:'native_claude: true', exclude_body:'', include_headers:'X-Native: claude'},
                makersuite: {include_body:'native_gemini: true', exclude_body:'', include_headers:'X-Native: gemini'},
                custom_openai_responses: {include_body:'responses: true', exclude_body:'', include_headers:'X-Native: responses'},
            };
        }
        for (const name of ['A', 'B']) {
            openai_settings[openai_setting_names[name]] = {
                chat_completion_source: 'custom', custom_api_format: 'openai_compat',
                custom_url: profiles()[0].endpoint, custom_model: name === 'A' ? 'model-a' : 'model-b',
                custom_include_body: 'stale_preset: true', custom_exclude_body: '', custom_include_headers: '',
                ...(scopedHost ? {additional_parameters_by_source: structuredClone(oai_settings.additional_parameters_by_source)} : {}),
            };
        }
        applyProfileById('params-a')
    `);
    assert.deepEqual(await run('nativeAdditionalParameters()'), values('A'));
    await run(`$('#quicker_api_profile_select').val('params-b').trigger('change'); operationQueue`);
    assert.deepEqual(await run('nativeAdditionalParameters()'), values('B'));
    assert.deepEqual(await run(`(async () => { const d=await fixtureGenerationData(); return [d.custom_include_body,d.custom_exclude_body,d.custom_include_headers]; })()`), ['tag: B', '["temperature"]', 'X-Test: B']);
    log('Profile dropdown switches all three native parameters and the generation envelope');

    await run(`applyProfileById('params-empty')`);
    assert.deepEqual(await run('nativeAdditionalParameters()'), blank);
    log('empty Profile clears previous body, exclusions and headers');

    await run(`applyProfileById('params-a')`);
    await run(`reopenFixtureParameterEditor(); $('#custom_include_body').val('edited: true').trigger('input'); $('#custom_include_headers').val('X-Edited: true').trigger('input')`);
    assert.equal(await run('editorHasUnsavedChanges(selectedProfile())'), true);
    await run('enqueueOperation(saveSelectedProfile)');
    assert.equal(await run('profiles()[0].includeBody'), 'edited: true');
    assert.equal(await run('profiles()[0].includeHeaders'), 'X-Edited: true');
    assert.equal(await run('editorHasUnsavedChanges(selectedProfile())'), false);
    assert.equal(state.settings.extension_settings.quickerApi.profiles[0].includeBody, 'edited: true');
    log('native parameter editor updates dirty state and Save Profile persists its actual values');

    for (const bind of [true, false]) {
        await run(`oai_settings.bind_preset_to_connection = ${bind}; switchTestPreset('B')`);
        assert.deepEqual(await run('nativeAdditionalParameters()'), values('B'));
        await run(`oai_settings.bind_preset_to_connection = ${bind}; switchTestPreset('A')`);
        assert.equal(await run('nativeAdditionalParameters().includeBody'), 'edited: true');
    }
    log('bound presets restore Profile parameters instead of stale preset values with native binding on/off');

    await run(`runQuickAction({profileId:'params-b', model:'model-b'}, quickActionTransaction)`);
    assert.deepEqual(await run('nativeAdditionalParameters()'), values('B'));
    log('quick actions share the same parameter application path');

    await run(`applyProfileById('params-claude')`);
    assert.equal(await run('nativeAdditionalParameters().excludeBody'), '["top_p"]');
    await run(`applyProfileById('params-gemini')`);
    assert.equal(await run('nativeAdditionalParameters().excludeBody'), '["top_k"]');
    const envelope = await run('fixtureGenerationData()');
    if (scopedHost) {
        assert.deepEqual(await run(`[oai_settings.additional_parameters_by_source.claude.include_body,
            oai_settings.additional_parameters_by_source.makersuite.include_headers,
            oai_settings.additional_parameters_by_source.custom.include_body,
            oai_settings.additional_parameters_by_source.custom_openai_responses.include_body]`),
        ['native_claude: true', 'X-Native: gemini', 'tag: B', 'responses: true']);
        assert.equal(envelope.custom_exclude_body, '["top_k"]');
        assert.equal(envelope.top_k, 40, 'native backend, not Quicker, excludes fields from the final provider body');
    } else {
        assert.equal(Object.hasOwn(envelope, 'top_k'), false);
    }
    log('Claude/Gemini exclusions follow profiles while native provider parameters stay isolated');

    // A real native popup captures an entry reference. A source/preset change
    // must not invoke stale input handlers and write the new Profile into it.
    if (scopedHost) {
        await run(`applyProfileById('params-a')`);
        await run('reopenFixtureParameterEditor()');
        await run(`applyProfileById('params-claude')`);
        assert.equal(await run('document.getElementById("custom_include_body").disabled'), true);
        assert.equal(await run('oai_settings.additional_parameters_by_source.custom.include_body'), 'edited: true');
        await run('reopenFixtureParameterEditor()');
        assert.equal(await run('document.getElementById("custom_exclude_body").disabled'), false);
        assert.equal(await run('document.getElementById("custom_exclude_body").value'), '["top_p"]');
        await run(`applyProfileById('params-a'); reopenFixtureParameterEditor(); oai_settings.bind_preset_to_connection=true; switchTestPreset('B')`);
        assert.equal(await run('document.getElementById("custom_include_body").disabled'), true);
        await run('reopenFixtureParameterEditor()');
        assert.equal(await run('document.getElementById("custom_include_body").value'), 'tag: B');
        log('stale popup handlers are disabled after source or preset entry replacement; reopening binds the new entry');
    }

    await run(`applyProfileById('params-a')`);
    if (scopedHost) await run(`$('#chat_completion_source').val('custom_openai_responses').trigger('change')`);
    const before = await run('snapshotNative()');
    await run(`$('#openai_proxy_password').one('input.fixtureRollback', () => { throw new Error('Synthetic apply failure'); })`);
    assert.equal(await run(`applyProfileById('params-claude')`), false);
    assert.deepEqual(await run('snapshotNative()'), before);
    if (scopedHost) assert.equal(await run(`$('#chat_completion_source').val()`), 'custom_openai_responses');
    await run(`applyProfileById('params-a')`);
    if (scopedHost) assert.equal(await run('oai_settings.custom_api_format'), 'openai_compat');
    log('failed cross-format application rolls back source, protocol and every parameter slot');

    await run(`oai_settings.custom_url='https://import-parameters.invalid/v1'`);
    const imported = await run(`(async () => (await collectNativeImportCandidates({})).find(p => p.sourceRef === 'current-custom'))()`);
    assert.equal(imported.includeBody, 'edited: true');
    assert.equal(imported.includeHeaders, 'X-Edited: true');
    if (scopedHost) {
        await run(`$('#chat_completion_source').val('custom_openai_responses').trigger('change')`);
        assert.equal(await run(`(async () => (await collectNativeImportCandidates({})).some(p => p.sourceRef === 'current-custom'))()`), false);
    }
    await run(`applyProfileById('params-a')`);
    log('native Custom import reads the correct parameter slot and does not mislabel unsupported protocols');

    await run(`switchTestPreset('A')`);
    assert.equal(await run('persistSettingsNow()'), true);
    await page.reload();
    await run('enqueueOperation(restoreInitialProfileSelection)');
    assert.equal(await run('nativeAdditionalParameters().includeBody'), 'edited: true');
    assert.equal(await run('nativeAdditionalParameters().includeHeaders'), 'X-Edited: true');
    log('saved parameter profiles survive a real browser reload and startup restoration');

    assert.equal(await run('persistSettingsNow()'), true);
    state.delaySettings = 160;
    await run(`settings().quickUrls.push({id:'before-flight',name:'Before flight',url:'https://before.invalid'}); window.inFlightSave=persistSettingsNow(); new Promise(resolve=>setTimeout(resolve,30))`);
    await run(`settings().quickUrls.push({id:'after-flight',name:'After flight',url:'https://after.invalid'}); scheduleSettingsSave(); platform.cancelSettingsSave(); window.inFlightSave`);
    assert.equal(await run('settingsSaveState'), 'pending');
    assert.equal(await run('JSON.parse(confirmedSettingsSnapshot).quickUrls.some(item=>item.id === "after-flight")'), false);
    state.delaySettings = 0;
    assert.equal(await run('persistSettingsNow()'), true);
    assert.equal(await run('settingsSaveState'), 'saved');
    assert.equal(state.settings.extension_settings.quickerApi.quickUrls.some(item => item.id === 'after-flight'), true);
    log('an older in-flight save never confirms newer unsaved edits; explicit retry persists them');

    if (scopedHost) {
        assert.ok(state.requests.some(request => request.path === '/api/settings/patch'
            && request.body.ops.some(op => op.path.length > 2 && op.path[0] === 'extension_settings' && op.path[1] === 'quickerApi')));
        log('Tauri fixture exercises granular settings patches, not just full subtree replacements');
    }
    await run('teardownQuickerApi()');
}

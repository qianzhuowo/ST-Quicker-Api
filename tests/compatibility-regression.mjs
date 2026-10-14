import assert from 'node:assert/strict';

// Run the actual plugin functions in a browser, with only HTTP/host IO simulated.
export async function runCompatibilityRegressions({ page, scopedHost, log }) {
    const run = page.evaluate;
    await run(`
        window.compatRequests = [];
        window.compatAllowExposure = false;
        window.compatFailStatus = false;
        window.compatFailRestore = false;
        window.compatSecrets = Object.fromEntries(Object.values(FORMATS).map(c => [c.secretKey, [
            {id:'original',active:true}, {id:'bound',active:false}
        ]]));
        window.compatDelegate = globalThis.fetch;
        globalThis.fetch = async (resource, options = {}) => {
            const url = String(resource);
            const body = options.body ? JSON.parse(options.body) : {};
            compatRequests.push({url, body});
            const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
            if (url === '/api/secrets/settings') return json({allowKeysExposure: compatAllowExposure});
            if (url === '/api/secrets/find') return compatAllowExposure ? json({value:'synthetic-key'}) : json({},403);
            if (url === '/api/secrets/read') return json(compatSecrets);
            if (url === '/api/secrets/rotate') {
                if (compatFailRestore && body.id === 'original') return json({},500);
                for (const entry of compatSecrets[body.key]) entry.active = entry.id === body.id;
                return json({});
            }
            if (url === '/api/secrets/write') {
                for (const entry of compatSecrets[body.key]) entry.active = false;
                compatSecrets[body.key].push({id:'written-'+compatRequests.length, active:true});
                return json({id:compatSecrets[body.key].at(-1).id});
            }
            if (url === '/api/backends/chat-completions/status') {
                if (window.compatStatusGate) { window.compatStatusReached(); await window.compatStatusGate; }
                return compatFailStatus ? json({error:'status failed'},500) : json({data:[{id:'remote-model'}]});
            }
            if (url.startsWith('https://models.invalid/')) return json({data:[{id:'direct-model'}]});
            return compatDelegate(resource, options);
        };
        window.compatCustom = normalizeProfile({id:'compat-custom',format:'openai',endpoint:'https://models.invalid/v1',model:'custom-test',secretId:'bound'});
        settings().profiles = [compatCustom]; settings().presetBindings = {}; settings().presetModels = {};
        settings().selectedProfileId = compatCustom.id;
        renderProfiles(compatCustom.id);
    `);
    const result = await run('fetchModelsForProfile(compatCustom, compatCustom.endpoint)');
    assert.deepEqual(result.models, ['remote-model']);
    const requests = await run('compatRequests');
    assert.equal(requests.some(r => r.url === '/api/secrets/find'), !scopedHost);
    assert.deepEqual(await run(`compatSecrets.api_key_custom.map(e=>[e.id,e.active])`), [['original', true], ['bound', false]]);
    assert.equal(requests.some(r => r.url.startsWith('https://')), false);
    log('protected model fetch uses backend credentials and restores the previous active key');

    await run('compatFailStatus=true');
    assert.match(await run(`fetchModelsForProfile(compatCustom,compatCustom.endpoint).then(()=>'',e=>e.message)`), /HTTP 500/);
    assert.equal(await run(`compatSecrets.api_key_custom.find(e=>e.active).id`), 'original');
    await run('compatFailStatus=false; compatRequests=[]');
    log('failed model fetch also restores credentials');

    await run(`
        window.compatStatusGate = new Promise(resolve=>window.compatReleaseStatus=resolve);
        window.compatReached = new Promise(resolve=>window.compatStatusReached=resolve);
        window.compatPending = fetchModelsForProfile(compatCustom,compatCustom.endpoint);
        compatReached;
    `);
    assert.equal(await run(`(()=>{const data={chat_completion_source:'custom'}; guardGenerationWhenBlocked(data); return data.chat_completion_source;})()`), 'quicker_api_preset_transition');
    await run(`compatReleaseStatus(); compatPending`);
    assert.equal(await run('presetTransitionBlocked'), false);
    await run('window.compatStatusGate=null');
    log('generation is blocked during the model probe credential transaction and unblocked after restore');

    await run(`for (const entry of compatSecrets.api_key_custom) entry.active=false; fetchModelsForProfile(compatCustom,compatCustom.endpoint)`);
    assert.notEqual(await run('compatSecrets.api_key_custom.find(e=>e.active).id'), 'bound');
    log('a slot without an original active credential returns to a verified empty key');

    if (scopedHost) {
        assert.equal(await run(`findSecretBounded('api_key_custom','bound')`), null);
        await run(`(async()=>{ await readAuthoritativeSecretState(); return await ensureSecret('api_key_custom','new-synthetic-key','test'); })()`);
        assert.equal(await run(`compatRequests.some(r=>r.url==='/api/secrets/find')`), false);
        await run(`compatAllowExposure=true`);
        assert.equal(await run(`findSecretBounded('api_key_custom','bound')`), 'synthetic-key');
        await run(`compatAllowExposure=false; compatRequests=[]`);
        log('TT denied exposure avoids find during save/reveal, and permission changes take effect without reload');

        assert.equal(await run(`$('#quicker_api_format option[value="opencode"]').length`), 1);
        await run(`
            window.compatOpenCode = normalizeProfile({id:'compat-opencode',name:'OpenCode',format:'opencode',endpoint:'go',opencodeApiFormat:'claude_messages',model:'new-claude',secretId:'bound',includeBody:'{"test":true}',includeHeaders:'{"X-Test":"value"}',excludeBody:'["temperature"]'});
            settings().profiles.push(compatOpenCode);
            settings().selectedProfileId=compatOpenCode.id;
            window.compatBefore = snapshotNative();
            oai_settings.reverse_proxy='https://unrelated.invalid'; oai_settings.proxy_password='unrelated';
        `);
        assert.equal(await run('applyProfile(compatOpenCode)'), true);
        assert.deepEqual(await run(`[oai_settings.chat_completion_source,oai_settings.opencode_endpoint,oai_settings.opencode_api_format,oai_settings.opencode_model,$('#model_opencode_select').val()]`), ['opencode', 'go', 'claude_messages', 'new-claude', 'new-claude']);
        assert.equal(await run('profileHasCredential(compatOpenCode, "opencode", "go")'), true);
        assert.equal(await run('profileMatchesNative(compatOpenCode)'), true);
        assert.equal(await run('proxies.length'), 0);
        assert.deepEqual(await run('nativeAdditionalParameters()'), { includeBody: '{"test":true}', includeHeaders: '{"X-Test":"value"}', excludeBody: '["temperature"]' });
        assert.equal(await run('oai_settings.proxy_password'), 'unrelated');
        log('OpenCode applies native service/protocol/model/parameters and its own secret slot, not proxy credentials');

        await run(`compatRequests=[]; fetchModelsForProfile(compatOpenCode,'go')`);
        const status = (await run('compatRequests')).find(r => r.url.endsWith('/status')).body;
        assert.equal(status.chat_completion_source, 'opencode');
        assert.equal(status.opencode_endpoint, 'go');
        assert.equal(status.opencode_api_format, 'claude_messages');
        assert.equal('custom_url' in status, false);
        assert.equal(await run(`compatRequests.some(r=>r.url==='/api/secrets/find')`), false);
        log('OpenCode model status uses native routing without exposing the key');

        await run(`$('#quicker_api_url').val('https://opencode.ai/zen/v1/'); $('#quicker_api_opencode_format').val('openai_responses'); saveSelectedProfile()`);
        assert.deepEqual(await run('[compatOpenCode.endpoint,compatOpenCode.opencodeApiFormat,oai_settings.opencode_endpoint,oai_settings.opencode_api_format]'), ['zen', 'openai_responses', 'zen', 'openai_responses']);
        await run(`$('#quicker_api_url').val('go'); $('#quicker_api_opencode_format').val('gemini'); compatRequests=[]; saveSelectedProfile()`);
        assert.equal(await run('compatRequests.length'), 0);
        assert.equal(await run('compatOpenCode.endpoint'), 'zen');
        await run(`renderProfiles(compatOpenCode.id)`);
        log('official OpenCode URLs map to service IDs; Go + Gemini is rejected before any credential mutation');

        await run(`$('#update_oai_preset').trigger('click'); nativeSaveTask`);
        assert.equal(await run(`settings().presetBindings[currentPresetName()]`), 'compat-opencode');
        assert.equal(await run(`nativePresetByName(currentPresetName()).opencode_api_format`), 'openai_responses');
        const candidates = await run('collectNativeImportCandidates(compatSecrets)');
        assert.equal(candidates.some(c => c.sourceRef === 'current-opencode'), false);
        await run(`restoreNative(compatBefore)`);
        assert.equal(await run('oai_settings.chat_completion_source'), 'custom');
        log('native preset saves retain OpenCode protocol; imports deduplicate and connection rollback restores previous source');

        await run(`
            extension_settings.connectionManager={profiles:[{id:'unsupported-custom',api:'custom','api-url':'https://unsupported.invalid/v1','custom-api-format':'openai_responses',model:'responses-model'}]};
            $('#model_claude_select').append($('<option>').val('__manage_models__').text('Manage models'));
            window.compatClaude=normalizeProfile({id:'compat-claude',format:'anthropic',model:'claude-test',secretId:'bound'});
            settings().profiles.push(compatClaude);
            $('#quicker_api_format').val('anthropic'); renderModelControl(compatClaude);
        `);
        assert.equal(await run(`$('#quicker_api_provider_model option[value="__manage_models__"]').length`), 0);
        assert.equal(await run(`modelSuggestionsForProfile('compat-claude').includes('__manage_models__')`), false);
        assert.equal(await run(`collectNativeImportCandidates(compatSecrets).then(c=>c.some(p=>p.sourceRef==='connection-manager:unsupported-custom'))`), false);
        log('TT model action entries and unsupported Connection Manager Custom protocols are not imported as models/connections');

        // Failure to restore must leave a confirmed empty key, not the probe key.
        await run(`for (const e of compatSecrets.api_key_custom) e.active=e.id==='original'; compatFailRestore=true; fetchModelsForProfile(compatCustom,compatCustom.endpoint)`);
        assert.notEqual(await run('compatSecrets.api_key_custom.find(e=>e.active).id'), 'bound');
        assert.equal(await run('settings().activeProfileId'), null);
        log('failed credential restore enters fail-closed state');
    } else {
        assert.equal(await run(`$('#quicker_api_format option[value="opencode"]').length`), 0);
        await run(`compatAllowExposure=true; compatRequests=[]`);
        assert.deepEqual((await run('fetchModelsForProfile(compatCustom,compatCustom.endpoint)')).models, ['direct-model']);
        assert.equal(await run(`compatRequests.some(r=>r.url.endsWith('/status'))`), false);
        const unavailable = await run(`(async()=>{const p=normalizeProfile({format:'opencode',endpoint:'go',opencodeApiFormat:'claude_messages'}); return [p.format,p.opencodeApiFormat,await applyProfile(p)];})()`);
        assert.deepEqual(unavailable, ['opencode', 'claude_messages', false]);
        log('legacy host retains browser model fetch and preserves unsupported OpenCode profiles without applying them');
    }
    await run('teardownQuickerApi()');
}

import assert from 'node:assert/strict';

// Exercise the real model-manager DOM/draft and fetching path on both host adapters.
export async function runModelSearchRegressions({ page, state, log, setViewport }) {
    const run = page.evaluate;
    const initialRemote = ['GPT-4o', 'gpt-4.1-mini', 'Claude-3.5-Sonnet', 'claude-haiku', 'Gemini-2.5-Pro', 'special[Model]'];
    const refreshedRemote = ['GPT-4o', 'New-Wide-Model', 'Gemini-Next', 'unmatched-model'];
    await run(`
        window.searchProfile = normalizeProfile({id:'search-profile',name:'Search models',format:'anthropic',endpoint:'',
            model:'GPT-4o',availableModels:['GPT-4o','Claude-3.5-Sonnet','custom-only'],
            fetchedModels:${JSON.stringify(initialRemote)},fetchedFromEndpoint:'',modelListVersion:2,secretId:'test-secret'});
        settings().profiles=[searchProfile]; settings().presetBindings={}; settings().presetModels={};
        settings().selectedProfileId=searchProfile.id; settings().activeProfileId=searchProfile.id;
        oai_settings.chat_completion_source='claude'; oai_settings.claude_model='GPT-4o'; oai_settings.reverse_proxy='';
        $('#chat_completion_source').val('claude'); clearKeyEditor(); renderProfiles(searchProfile.id);
        window.searchOriginalProfile=JSON.stringify(searchProfile);
        window.searchFetchDelegate=globalThis.fetch;
        globalThis.fetch=async function(resource, options) {
            if (String(resource)==='/api/backends/chat-completions/status') {
                window.searchFetchReached=true;
                await window.searchFetchGate;
                return new Response(JSON.stringify({data:${JSON.stringify(refreshedRemote)}.map(id=>({id}))}),
                    {status:200,headers:{'Content-Type':'application/json'}});
            }
            return searchFetchDelegate.apply(this,arguments);
        };
        window.searchRead=()=>({
            rows:$('.quicker-api__remote-model:not([hidden])').toArray().map(row=>({model:$(row).find('span').text(),checked:$(row).find('input').prop('checked')})),
            chosen:$('.quicker-api__chosen-model input').toArray().map(input=>input.value),
            count:$('.quicker-api__model-search-count').text(),empty:$('.quicker-api__model-list').first().find('.quicker-api__empty-state').text(),
            query:$('.quicker-api__model-search input').val(),open:Boolean(document.querySelector('dialog[open]'))
        });
        window.searchTask=manageCustomModels(); true;
    `);
    const search = query => run(`$('.quicker-api__model-search input').val(${JSON.stringify(query)}).trigger('input'); searchRead()`);
    const action = name => run(`$('.quicker-api__manager-panel').first().find('[data-action="${name}"]').trigger('click'); searchRead()`);
    const toggle = model => run(`$('.quicker-api__remote-model:not([hidden])').filter((_,row)=>$(row).find('span').text()===${JSON.stringify(model)}).trigger('click'); searchRead()`);
    const names = result => result.rows.map(row => row.model);
    const checked = result => result.rows.filter(row => row.checked).map(row => row.model);
    assert.deepEqual(names(await run('searchRead()')), initialRemote);
    assert.deepEqual(names(await search('  gPt-4  ')), ['GPT-4o', 'gpt-4.1-mini']);
    assert.deepEqual(names(await search('c35s')), ['Claude-3.5-Sonnet']);
    assert.deepEqual(names(await search('[m')), ['special[Model]']);
    const none = await search('no-such-model');
    assert.deepEqual(none.rows, []);
    assert.equal(none.count, '显示 0 / 6 个模型');
    assert.match(none.empty, /没有匹配/);
    assert.deepEqual(names(await search('   ')), initialRemote);
    log('remote model search is immediate, case-insensitive, literal, trimmed and supports non-contiguous subsequences with counts/empty feedback');

    const enter = await run(`(() => {
        let propagated=false; const listener=()=>{propagated=true;}; document.addEventListener('keydown',listener);
        const input=document.querySelector('.quicker-api__model-search input');
        const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}); input.dispatchEvent(event);
        document.removeEventListener('keydown',listener);
        return {prevented:event.defaultPrevented,propagated,open:Boolean(document.querySelector('dialog[open]'))};
    })()`);
    assert.deepEqual(enter, { prevented: true, propagated: false, open: true });
    log('Enter in model search cannot reach the host popup confirmation handler');

    await search('gpt');
    await run(`window.searchRowNodes=[...document.querySelectorAll('.quicker-api__remote-model')]; true`);
    const allGpt = await action('all');
    assert.deepEqual(checked(allGpt), ['GPT-4o', 'gpt-4.1-mini']);
    assert.ok(!allGpt.chosen.includes('claude-haiku') && !allGpt.chosen.includes('Gemini-2.5-Pro'));
    assert.deepEqual(checked(await search('claude')), ['Claude-3.5-Sonnet']);
    await toggle('claude-haiku');
    await search('gemini'); await toggle('Gemini-2.5-Pro');
    assert.deepEqual(checked(await search('gpt')), ['GPT-4o', 'gpt-4.1-mini']);
    const noGpt = await action('none');
    assert.equal(await run(`(() => { const now=[...document.querySelectorAll('.quicker-api__remote-model')]; return now.length===searchRowNodes.length && now.every((row,i)=>row===searchRowNodes[i]); })()`), true,
        'selecting, bulk actions and searching update the existing remote rows instead of rebuilding them');
    assert.deepEqual(checked(noGpt), []);
    for (const model of ['Claude-3.5-Sonnet', 'claude-haiku', 'Gemini-2.5-Pro', 'custom-only']) assert.ok(noGpt.chosen.includes(model));
    await search('claude');
    const inverted = await action('invert');
    assert.deepEqual(checked(inverted), []);
    for (const model of ['Gemini-2.5-Pro', 'custom-only']) assert.ok(inverted.chosen.includes(model));
    assert.ok(!inverted.chosen.includes('GPT-4o'));
    assert.deepEqual(checked(await action('invert')), ['Claude-3.5-Sonnet', 'claude-haiku']);
    await search('gpt');
    assert.deepEqual(checked(await action('invert')), ['GPT-4o', 'gpt-4.1-mini']);
    const noMatch = await search('no-such-model');
    for (const name of ['all', 'invert', 'none']) assert.deepEqual((await action(name)).chosen, noMatch.chosen);
    log('filtered all/invert/none only affect matching models and preserve hidden selections; favorites are independent of the current model');

    await search('');
    assert.deepEqual((await action('none')).chosen.slice().sort(), ['custom-only']);
    const all = await action('all');
    assert.deepEqual(all.chosen.slice().sort(), [...initialRemote, 'custom-only'].sort());
    assert.deepEqual((await action('invert')).chosen.slice().sort(), ['custom-only']);
    assert.equal(await run('JSON.stringify(searchProfile)===searchOriginalProfile'), true);
    await run('[...ownedPopups][0].completeCancelled(); searchTask');
    assert.equal(await run('JSON.stringify(searchProfile)===searchOriginalProfile'), true);
    assert.deepEqual(await run('[getEditorModel(),oai_settings.claude_model]'), ['GPT-4o', 'GPT-4o']);
    log('without search bulk actions retain their original scope, and cancelling all model/search edits fully rolls back');

    await run('window.searchTask=manageCustomModels(); true');
    assert.equal((await run('searchRead()')).query, '');
    await search('gem');
    await run(`window.searchFetchReached=false; window.searchFetchGate=new Promise(resolve=>window.searchReleaseFetch=resolve);
        $('.quicker-api__manager-panel').first().find('[data-action="fetch"]').trigger('click');`);
    for (let i = 0; i < 100 && !await run('window.searchFetchReached'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await run('window.searchFetchReached'), true);
    await search('nwm'); // Change the filter while the real host-model request is pending.
    await run('searchReleaseFetch()');
    for (let i = 0; i < 100 && await run(`$('.quicker-api__manager-panel').first().find('[data-action="fetch"]').prop('disabled')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const refreshed = await run('searchRead()');
    assert.deepEqual(names(refreshed), ['New-Wide-Model']);
    assert.equal(refreshed.query, 'nwm'); assert.equal(refreshed.count, '显示 1 / 4 个模型');
    assert.deepEqual(await run('searchProfile.fetchedModels'), initialRemote);
    await toggle('New-Wide-Model');
    const cleared = await run(`$('.quicker-api__model-search button').trigger('click'); searchRead()`);
    assert.deepEqual(names(cleared), refreshedRemote);
    assert.ok(checked(cleared).includes('New-Wide-Model'));
    assert.equal(await run(`document.activeElement===document.querySelector('.quicker-api__model-search input')`), true);
    log('fetch completion uses the latest search query; clearing restores the complete snapshot without losing selections');

    for (const width of [320, 768, 1280]) {
        await setViewport(width, 700);
        const layout = await run(`(() => {
            const input=document.querySelector('.quicker-api__model-search input').getBoundingClientRect();
            const clear=document.querySelector('.quicker-api__model-search button').getBoundingClientRect();
            return input.width>0 && clear.width>0 && input.left>=0 && clear.left>=0 && input.right<=innerWidth && clear.right<=innerWidth
                && Math.abs(input.top-clear.top)<1 && Math.abs(input.height-clear.height)<1;
        })()`);
        assert.equal(layout, true, `model search controls fit and align with equal heights at ${width}px`);
    }
    log('search and clear controls remain accessible at 320px, tablet and desktop widths');
    await run('[...ownedPopups][0].completeCancelled(); searchTask');
    assert.equal(await run('JSON.stringify(searchProfile)===searchOriginalProfile'), true);
    log('cancelling after a remote fetch also discards the refreshed snapshot and draft selections');
    await run('window.searchTask=manageCustomModels(); true');
    await search('nwm');
    await run(`$('.quicker-api__manager-panel').first().find('[data-action="fetch"]').trigger('click');`);
    for (let i = 0; i < 100 && await run(`$('.quicker-api__manager-panel').first().find('[data-action="fetch"]').prop('disabled')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(names(await run('searchRead()')), ['New-Wide-Model']);
    await toggle('New-Wide-Model');
    await run('[...ownedPopups][0].completeAffirmative(); searchTask');
    assert.equal(await run('searchProfile.availableModels.includes("New-Wide-Model")'), true);
    assert.deepEqual(await run('searchProfile.fetchedModels'), refreshedRemote);
    assert.equal(await run('persistSettingsNow()'), true);
    const saved = state.settings.extension_settings.quickerApi.profiles.find(profile => profile.id === 'search-profile');
    assert.ok(saved.availableModels.includes('New-Wide-Model'));
    assert.deepEqual(saved.fetchedModels, refreshedRemote);
    assert.equal(Object.hasOwn(saved, 'searchQuery'), false);
    await page.reload();
    assert.ok(await run(`profiles().find(p=>p.id==='search-profile').availableModels.includes('New-Wide-Model')`));
    assert.deepEqual(await run(`profiles().find(p=>p.id==='search-profile').fetchedModels`), refreshedRemote);
    await run('window.searchTask=manageCustomModels(); true');
    assert.deepEqual(await run(`$('.quicker-api__remote-model:not([hidden]) span').toArray().map(span=>span.textContent)`), refreshedRemote);
    assert.equal(await run(`$('.quicker-api__model-search input').val()`), '');
    await run('[...ownedPopups][0].completeCancelled(); searchTask');
    log('confirm persists selections and the full fetched snapshot, not the filtered subset; a real reload retains them with a fresh empty search');
    await run('teardownQuickerApi()');
}

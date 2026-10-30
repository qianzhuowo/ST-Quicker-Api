import assert from 'node:assert/strict';

// Exercise the searchable model picker, favorites migration and stale cleanup
// through the real plugin DOM on both host adapters.
export async function runModelPickerRegressions({ page, log, setViewport }) {
    const run = page.evaluate;
    const waitFor = async (expression, label) => {
        for (let i = 0; i < 150; i++) {
            if (await run(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail(`Timed out waiting for ${label}`);
    };

    // 1. Migration: every v1 list keeps only the current model plus entries absent from the fetched snapshot.
    const migration = await run(`(() => {
        const uncurated = normalizeProfile({id:'m1',format:'openai',endpoint:'https://m.invalid/v1',model:'cur',
            availableModels:['cur','r1','r2','manual'],fetchedModels:['r1','r2','cur'],fetchedFromEndpoint:'https://m.invalid/v1',customized:false});
        const curated = normalizeProfile({id:'m2',format:'openai',model:'cur',availableModels:['r1','manual'],fetchedModels:['r1','r2'],customized:true});
        const legacyNoFetch = normalizeProfile({id:'m3',format:'openai',model:'cur',availableModels:['a','b']});
        const current = normalizeProfile({id:'m4',format:'openai',model:'cur',availableModels:['other'],modelListVersion:2});
        return {
            uncurated:uncurated.availableModels, curated:curated.availableModels, legacyNoFetch:legacyNoFetch.availableModels,
            current:current.availableModels, idempotent:JSON.stringify(normalizeProfile(structuredClone(uncurated)))===JSON.stringify(uncurated),
            noFlag:!Object.hasOwn(uncurated,'customized'), version:uncurated.modelListVersion, fetched:uncurated.fetchedModels,
        };
    })()`);
    assert.deepEqual(migration.uncurated, ['cur', 'manual']);
    assert.deepEqual(migration.curated, ['cur', 'manual'], 'curated v1 lists are migrated the same way; remote entries remain in All');
    assert.deepEqual(migration.legacyNoFetch, ['cur', 'a', 'b']);
    assert.deepEqual(migration.current, ['other']);
    assert.deepEqual(migration.fetched, ['r1', 'r2', 'cur']);
    assert.equal(migration.idempotent, true);
    assert.equal(migration.noFlag, true);
    assert.equal(migration.version, 2);
    log('legacy lists keep only the current model (plus models missing from the snapshot) as favorites; without a snapshot nothing is dropped; migration is idempotent');

    // 2. Picker views, favorites and selection.
    await run(`
        window.pickerProfile = normalizeProfile({id:'picker-profile',name:'Picker',format:'anthropic',endpoint:'',model:'fav-a',
            availableModels:['fav-a','gone-model'],fetchedModels:['fav-a','remote-b','remote-c'],fetchedFromEndpoint:'',modelListVersion:2,secretId:'test-secret'});
        settings().profiles=[pickerProfile]; settings().presetBindings={}; settings().presetModels={};
        settings().selectedProfileId=pickerProfile.id; settings().activeProfileId=pickerProfile.id;
        oai_settings.chat_completion_source='claude'; oai_settings.claude_model='fav-a'; oai_settings.reverse_proxy='';
        $('#chat_completion_source').val('claude'); clearKeyEditor(); renderProfiles(pickerProfile.id);
        window.pickerStatusCalls=0; window.pickerRemote=['fav-a','remote-b','remote-new'];
        window.pickerDelegate=globalThis.fetch;
        globalThis.fetch=async function(resource) {
            if (String(resource)==='/api/backends/chat-completions/status') {
                pickerStatusCalls++;
                return new Response(JSON.stringify({data:pickerRemote.map(id=>({id}))}),{status:200,headers:{'Content-Type':'application/json'}});
            }
            return pickerDelegate.apply(this,arguments);
        };
        window.pickerRead=()=>({
            open:$('.quicker-api__model-picker').hasClass('is-open') && !$('#quicker_api_model_dropdown').prop('hidden'),
            view:$('[data-model-view].is-active').attr('data-model-view'),
            counts:$('[data-model-view] small').toArray().map(s=>s.textContent),
            rows:$('.quicker-api__model-option').toArray().map(r=>({model:r.getAttribute('data-model'),add:r.getAttribute('data-add-model'),
                favorite:r.classList.contains('is-favorite'),stale:r.classList.contains('is-stale'),selected:r.classList.contains('is-selected'),
                badge:$(r).find('.quicker-api__model-option-badges small').text()})),
            label:$('.quicker-api__model-trigger-label').text(), mark:$('.quicker-api__model-trigger-mark').attr('class'),
            value:$('#quicker_api_custom_model').val(), native:oai_settings.claude_model,
            favorites:[...pickerProfile.availableModels], empty:$('.quicker-api__model-options .quicker-api__empty-state').text(),
        });
        true;
    `);
    const read = () => run('pickerRead()');
    const models = state => state.rows.map(row => row.model ?? `+${row.add}`);
    const search = query => run(`$('.quicker-api__model-search-input').val(${JSON.stringify(query)}).trigger('input'); pickerRead()`);
    const tab = view => run(`$('[data-model-view="${view}"]').trigger('click'); pickerRead()`);
    const star = model => run(`$('.quicker-api__model-option').filter((_,r)=>r.getAttribute('data-model')===${JSON.stringify(model)}).find('.quicker-api__model-star').trigger('click'); pickerRead()`);
    const pick = model => run(`$('.quicker-api__model-option').filter((_,r)=>r.getAttribute('data-model')===${JSON.stringify(model)}).trigger('click'); pickerRead()`);
    const open = () => run(`$('#quicker_api_model_trigger').trigger('click'); pickerRead()`);

    let state = await read();
    assert.equal(state.open, false);
    assert.equal(state.label, 'fav-a');
    assert.match(state.mark, /is-favorite/);
    state = await open();
    assert.equal(state.open, true);
    assert.equal(state.view, 'favorites');
    assert.deepEqual(models(state), ['fav-a', 'gone-model']);
    assert.deepEqual(state.rows.map(row => row.stale), [false, true]);
    assert.deepEqual(state.counts, ['2', '3']);
    log('a fresh session opens on favorites, and favorites missing from the remote snapshot are flagged stale');

    state = await tab('all');
    assert.equal(state.view, 'all');
    assert.deepEqual(models(state), ['fav-a', 'remote-b', 'remote-c']);
    assert.deepEqual(state.rows.map(row => row.favorite), [true, false, false]);
    assert.equal(await run('pickerStatusCalls'), 0, 'existing snapshot must not auto-fetch');
    state = await star('remote-b');
    assert.ok(state.favorites.includes('remote-b'));
    assert.equal(state.rows.find(row => row.model === 'remote-b').favorite, true);
    assert.equal(state.open, true, 'starring keeps the picker open');
    state = await star('fav-a');
    assert.ok(!state.favorites.includes('fav-a'), 'the current model can be unfavorited');
    assert.equal(state.value, 'fav-a', 'unfavoriting does not change the selection');
    assert.doesNotMatch(state.mark, /is-favorite/);
    await star('fav-a');
    log('the full list marks favorites and toggles favorites in place, including the current model');

    state = await search('rmtc');
    assert.deepEqual(models(state), ['remote-c', '+rmtc'], 'a non-exact query also offers to add it as a new ID');
    state = await pick('remote-c');
    assert.equal(state.open, false);
    assert.equal(state.value, 'remote-c');
    assert.equal(state.native, 'remote-c');
    assert.equal(state.label, 'remote-c');
    assert.match(state.mark, /fa-cloud/);
    state = await open();
    assert.equal(state.view, 'all', 'selecting a model keeps the chosen view');
    state = await tab('favorites');
    assert.deepEqual(models(state), ['remote-c', 'gone-model', 'remote-b', 'fav-a']);
    assert.equal(state.rows[0].badge, '当前·未收藏');
    log('search filters the picker, selection syncs the native model, and the current model stays visible in favorites');

    state = await search('brand-new-model');
    assert.deepEqual(models(state), ['+brand-new-model']);
    state = await run(`(() => {
        const input=document.querySelector('.quicker-api__model-search-input');
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        return pickerRead();
    })()`);
    assert.equal(state.open, false);
    assert.equal(state.value, 'brand-new-model');
    assert.equal(state.native, 'brand-new-model');
    assert.ok(state.favorites.includes('brand-new-model'));
    await open();
    await search('');
    state = await run(`(() => {
        const input=document.querySelector('.quicker-api__model-search-input');
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        return pickerRead();
    })()`);
    assert.equal(state.value, 'gone-model', 'ArrowDown moves from the selected (last) favorite and wraps to the first');
    await open();
    state = await run(`(() => {
        document.querySelector('.quicker-api__model-search-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        return {...pickerRead(), focused:document.activeElement?.id};
    })()`);
    assert.equal(state.open, false);
    assert.equal(state.focused, 'quicker_api_model_trigger');
    await open();
    state = await run(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); pickerRead()`);
    assert.equal(state.open, false);
    log('typing an unknown ID favorites and uses it; keyboard navigation, Escape and outside clicks behave like a combobox');

    // 3. Fetch switches to the full list and keeps the picker open.
    await run(`$('#quicker_api_custom_model').val('fav-a').trigger('change'); messages.length=0;`);
    await open();
    await tab('favorites');
    await run(`$('[data-model-picker-action="fetch"]').trigger('click')`);
    await waitFor('pickerStatusCalls===1 && pendingOperations===0', 'picker fetch');
    state = await read();
    assert.equal(state.open, true, 'fetching from the picker keeps it open');
    assert.equal(state.view, 'all');
    assert.deepEqual(models(state), ['fav-a', 'remote-b', 'remote-new']);
    assert.equal(state.value, 'fav-a');
    assert.deepEqual(await run('pickerProfile.fetchedModels'), ['fav-a', 'remote-b', 'remote-new']);
    assert.ok(await run(`messages.some(m=>m.level==='warning' && m.message.includes('2 个收藏模型'))`), 'stale favorites are reported after fetch');
    await run(`$('[data-model-view="favorites"]').trigger('click')`);
    state = await read();
    assert.deepEqual(state.rows.filter(row => row.stale).map(row => row.model), ['gone-model', 'brand-new-model']);
    await run('closeModelPicker()');
    log('fetching switches to the full list, preserves the selection and flags favorites missing from the new snapshot');

    // Auto-fetch once when the full list is empty.
    await run(`
        window.emptyProfile = normalizeProfile({id:'empty-profile',name:'Empty',format:'anthropic',endpoint:'',model:'only',availableModels:['only'],modelListVersion:2,secretId:'test-secret'});
        settings().profiles.push(emptyProfile); settings().selectedProfileId=emptyProfile.id; settings().activeProfileId=emptyProfile.id;
        oai_settings.claude_model='only'; renderProfiles(emptyProfile.id); pickerStatusCalls=0; true;
    `);
    await open();
    state = await tab('favorites');
    assert.deepEqual(models(state), ['only']);
    await tab('all');
    await waitFor('pickerStatusCalls===1 && pendingOperations===0', 'auto fetch');
    state = await read();
    assert.deepEqual(models(state).slice(0, 3), ['only', 'fav-a', 'remote-b']);
    await run(`emptyProfile.fetchedModels=[]; renderModelControl(emptyProfile)`);
    await tab('favorites');
    await tab('all');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await run('pickerStatusCalls'), 1, 'auto fetch runs at most once per profile/endpoint per session');
    state = await read();
    assert.equal(models(state)[0], 'only');
    assert.ok(models(state).includes('claude-model'), 'without a snapshot the host built-in list is the fallback');
    await run('closeModelPicker()');
    log('an empty full list auto-fetches once per session and otherwise offers a manual fetch');

    // 4. Model manager stale indicator and one-click cleanup.
    await run(`settings().selectedProfileId=pickerProfile.id; settings().activeProfileId=pickerProfile.id; oai_settings.claude_model='fav-a'; renderProfiles(pickerProfile.id); true`);
    const before = await run('JSON.stringify(pickerProfile.availableModels)');
    await run('window.managerTask=manageCustomModels(); true');
    const managerRead = () => run(`({
        badge:$('.quicker-api__stale-badge').text(), hidden:$('.quicker-api__stale-badge').prop('hidden'),
        stale:$('.quicker-api__chosen-model.is-stale input').toArray().map(i=>i.value),
        chosen:$('.quicker-api__chosen-model input').toArray().map(i=>i.value),
        prune:$('[data-action="prune"]').text(), disabled:$('[data-action="prune"]').prop('disabled'),
    })`);
    let manager = await managerRead();
    assert.equal(manager.badge, '⚠ 2 个失效');
    assert.deepEqual(manager.stale.sort(), ['brand-new-model', 'gone-model']);
    assert.equal(manager.prune, '清理失效 (2)');
    await run(`$('[data-action="prune"]').trigger('click')`);
    manager = await managerRead();
    assert.deepEqual(manager.stale, []);
    assert.equal(manager.hidden, true);
    assert.equal(manager.disabled, true);
    assert.ok(!manager.chosen.includes('gone-model') && manager.chosen.includes('fav-a'));
    await run('[...ownedPopups][0].completeCancelled(); managerTask');
    assert.equal(await run('JSON.stringify(pickerProfile.availableModels)'), before, 'cancel rolls back the cleanup');
    await run('window.managerTask=manageCustomModels(); true');
    await run(`$('[data-action="prune"]').trigger('click')`);
    await run('[...ownedPopups][0].completeAffirmative(); managerTask');
    assert.deepEqual(await run('pickerProfile.availableModels'), ['remote-b', 'fav-a']);
    assert.equal(await run(`$('#quicker_api_custom_model').val()`), 'fav-a');
    log('the manager flags stale favorites, cleans them in one click, and only saves on confirm');

    // 5. Layout of the open picker: a fixed overlay (never stretches the host
    // panel), flips above when there is no room below, 2 columns on phones / 3 on desktop.
    for (const [width, columns] of [[320, '2'], [768, '3'], [1280, '3']]) {
        await setViewport(width, 700);
        const before = await run(`(() => { const out=[]; for (let n=document.getElementById('quicker_api_model_trigger'); n; n=n.parentElement) out.push(n.scrollHeight); return out; })()`);
        await open();
        const layout = await run(`(() => {
            const trigger=document.querySelector('#quicker_api_model_trigger').getBoundingClientRect();
            const element=document.querySelector('#quicker_api_model_dropdown');
            const dropdown=element.getBoundingClientRect();
            const option=document.querySelector('.quicker-api__model-option');
            const r=option.getBoundingClientRect();
            const heights=[]; for (let n=document.getElementById('quicker_api_model_trigger'); n; n=n.parentElement) heights.push(n.scrollHeight);
            const placed=dropdown.top>=trigger.bottom-1 || dropdown.bottom<=trigger.top+1;
            return {ok:trigger.width>0 && dropdown.left>=0 && dropdown.right<=innerWidth+1 && dropdown.top>=0 && dropdown.bottom<=innerHeight+1 && placed
                && option.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),
                portaled:!document.getElementById('quicker_api').contains(element) && Boolean(element.closest('.openDrawer.pinnedOpen')),
                columns:getComputedStyle(element).getPropertyValue('--quicker-api-model-columns').trim(),
                heights, trigger:trigger.toJSON(), dropdown:dropdown.toJSON(), width:innerWidth};
        })()`);
        assert.ok(layout.ok, JSON.stringify(layout));
        assert.ok(layout.portaled, 'the open dropdown is portaled out of the settings panel inside a pinned .openDrawer');
        assert.deepEqual(layout.heights, before, 'opening the dropdown must not change the scroll height of any ancestor');
        assert.equal(layout.columns, columns);
        await run('closeModelPicker()');
        assert.equal(await run(`document.getElementById('quicker_api').contains(document.getElementById('quicker_api_model_dropdown')) && !document.getElementById('quicker_api_model_portal')`), true);
    }
    log('the open picker is a fixed overlay: inside the viewport, never stretches the panel, 2 columns on phones and 3 on desktop');

    // 6. Layout switch next to fetch: normal -> compact -> single on desktop; phones skip compact.
    await run(`localStorage.removeItem('quickerApi.modelPickerLayout'); true`);
    const layoutState = () => run(`(() => { const d=document.getElementById('quicker_api_model_dropdown'); const b=d.querySelector('[data-model-picker-action="layout"]');
        return [d.dataset.layout, getComputedStyle(d).getPropertyValue('--quicker-api-model-columns').trim(), localStorage.getItem('quickerApi.modelPickerLayout'), b.getAttribute('aria-label')]; })()`);
    const cycle = () => run(`$('#quicker_api_model_dropdown [data-model-picker-action="layout"]').trigger('click'); true`);
    await setViewport(1280, 700);
    await open();
    assert.deepEqual((await layoutState()).slice(0, 3), ['normal', '3', null]);
    assert.match((await layoutState())[3], /普通.*切换为紧凑/);
    await cycle();
    assert.deepEqual((await layoutState()).slice(0, 3), ['compact', '4', 'compact']);
    await cycle();
    assert.deepEqual((await layoutState()).slice(0, 3), ['single', '1', 'single']);
    assert.equal(await run(`(() => { const o=[...document.querySelectorAll('.quicker-api__model-option')]; return o.length>1 && o.every(x=>Math.abs(x.getBoundingClientRect().width-o[0].getBoundingClientRect().width)<1) && new Set(o.map(x=>Math.round(x.getBoundingClientRect().left))).size===1; })()`), true, 'single layout puts one model per row');
    assert.equal(await run(`!document.getElementById('quicker_api_model_dropdown').hidden`), true, 'switching layout keeps the dropdown open');
    await cycle();
    assert.deepEqual((await layoutState()).slice(0, 3), ['normal', '3', 'normal']);
    await cycle();
    await run('closeModelPicker()');
    await setViewport(320, 700);
    await open();
    assert.deepEqual((await layoutState()).slice(0, 3), ['normal', '2', 'compact'], 'a stored compact layout shows as normal on phones');
    await cycle();
    assert.deepEqual((await layoutState()).slice(0, 3), ['single', '1', 'single']);
    await cycle();
    assert.deepEqual((await layoutState()).slice(0, 3), ['normal', '2', 'normal']);
    await run('closeModelPicker()');
    log('the layout switch cycles normal/compact/single on desktop and normal/single on phones, and persists');

    // 7. Phones: the dropdown is fully visible next to the trigger wherever the trigger sits,
    // even when `position: fixed` is not relative to the viewport (filtered, offset <body>).
    await setViewport(360, 560);
    const placement = async (y, hostShift = false) => {
        await run(`(() => {
            const control=document.getElementById('quicker_api_model_trigger'); control.style.transform='';
            document.body.style.filter=${hostShift ? "'opacity(1)'" : "''"}; document.body.style.marginTop=${hostShift ? "'37px'" : "''"};
            const r=document.getElementById('quicker_api_model_trigger').getBoundingClientRect();
            control.style.transform='translateY(' + (${y} - r.top) + 'px)'; return true; })()`);
        await open();
        const result = await run(`(() => {
            const t=document.getElementById('quicker_api_model_trigger').getBoundingClientRect();
            const d=document.getElementById('quicker_api_model_dropdown').getBoundingClientRect();
            const above=d.bottom<=t.top+1, below=d.top>=t.bottom-1;
            const gap=above ? t.top-d.bottom : d.top-t.bottom;
            return { visible: d.top>=0 && d.bottom<=innerHeight+0.5 && d.left>=0 && d.right<=innerWidth+0.5 && d.height>=80,
                adjacent: (above || below) && gap>=0 && gap<=6, above, trigger:[Math.round(t.top),Math.round(t.bottom)], dropdown:[Math.round(d.top),Math.round(d.bottom)] }; })()`);
        await run('closeModelPicker()');
        return result;
    };
    for (const [label, y, shift] of [['top', 6, false], ['bottom', 520, false], ['top (shifted host)', 50, true], ['bottom (shifted host)', 520, true]]) {
        const result = await placement(y, shift);
        assert.ok(result.visible && result.adjacent, `${label}: ${JSON.stringify(result)}`);
        assert.equal(result.above, /bottom/.test(label), `${label} opens ${/bottom/.test(label) ? 'above' : 'below'}: ${JSON.stringify(result)}`);
    }
    await run(`document.getElementById('quicker_api_model_trigger').style.transform=''; document.body.style.filter=''; document.body.style.marginTop=''; true`);
    log('on phones the dropdown stays fully visible and attached to the trigger near the top and bottom, even with a shifted fixed-position host');
    await run('teardownQuickerApi()');
}

import assert from 'node:assert/strict';

// Quick entry menu: schemes and a quick model list coexist. A switch at the top
// of the menu chooses what it lists and is remembered. Picking a model applies
// that channel with that model through the scheme queue; schemes and their
// parameter overrides keep working.
export async function runQuickMenuRegressions({ page, state, log }) {
    const run = page.evaluate;
    const waitFor = async (expression, message) => {
        for (let i = 0; i < 100; i++) {
            if (await run(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error(message || `timed out waiting for ${expression}`);
    };
    const settle = () => waitFor('pendingOperations === 0 && !presetTransitionBlocked', 'operations did not settle');
    await settle();
    state.secrets = Object.fromEntries(['api_key_custom', 'api_key_claude', 'api_key_makersuite'].map(key => [key, [{ id: 'test-secret', active: true }]]));
    delete state.secretValues;
    await run(`(async () => {
        window.qmA = normalizeProfile({id:'qm-a',name:'Alpha',format:'openai',endpoint:'https://a.invalid/v1',model:'a1',availableModels:['a1','a2'],secretId:'test-secret'});
        window.qmB = normalizeProfile({id:'qm-b',name:'Beta',format:'openai',endpoint:'https://b.invalid/v1',model:'b1',availableModels:['b1','b2'],secretId:'test-secret'});
        settings().profiles = [qmB, qmA,
            normalizeProfile({id:'qm-draft',name:'Draft',format:'openai',availableModels:['d1'],draft:true}),
            normalizeProfile({id:'qm-empty',name:'Empty',format:'openai',endpoint:'https://e.invalid/v1',secretId:'test-secret'})];
        settings().presetBindings = {}; settings().presetModels = {}; settings().presetLink = false;
        settings().quickActions = [normalizeQuickAction({id:'qm-s',name:'Scheme',profileId:'qm-a',model:'a2',sequence:0,params:{enabled:true,temperature:{send:true,value:1.11}}})];
        settings().activeQuickActionId = ''; delete settings().quickMenuMode; settings().quickMenuMode = normalizeQuickMenuMode(settings().quickMenuMode);
        renderPanelMode();
        await readAuthoritativeSecretState();
        document.body.insertAdjacentHTML('beforeend', '<button id="qm_anchor">Q</button>');
        window.qmOpen = () => { closeQuickActionMenu(); openQuickActionMenu(document.getElementById('qm_anchor'), 'rightSendForm'); };
        window.qmView = () => ({ mode: settings().quickMenuMode, open: Boolean(quickActionMenu),
            modes: $('.quicker-api__quick-mode').toArray().map(button => [button.dataset.quickMode, button.getAttribute('aria-pressed')]),
            schemes: $('.quicker-api__quick-menu .ctx-item:not(.quicker-api__quick-model)').toArray().map(item => $(item).find('.qr--button-label').text()),
            groups: $('.quicker-api__quick-group > span').toArray().map(item => item.textContent),
            models: $('.quicker-api__quick-model').toArray().map(item => [item.dataset.profileId, item.dataset.model, item.classList.contains('is-active'), item.getAttribute('aria-current')]) });
        return await applyProfileById('qm-a');
    })()`);
    await settle();
    assert.deepEqual(await run('[settings().activeProfileId, oai_settings.custom_model, normalizeQuickMenuMode("bogus"), normalizeQuickMenuMode("models")]'),
        ['qm-a', 'a1', 'schemes', 'models']);

    // 1. Schemes stay the default content.
    const schemes = await run('qmOpen(), qmView()');
    assert.deepEqual(schemes, { mode: 'schemes', open: true, modes: [['schemes', 'true'], ['models', 'false']], schemes: ['Scheme'], groups: [], models: [] });
    log('quick menu: schemes remain the default content, with a switch for the quick model list');

    // 1b. One head row: the content switch on the left, the manager behind a gear on the right.
    const head = await run(`(() => { const menu = document.querySelector('.quicker-api__quick-menu'); const head = menu.querySelector(':scope > .quicker-api__quick-head');
        const rect = el => el.getBoundingClientRect(); const mid = el => (rect(el).top + rect(el).bottom) / 2;
        const modes = [...head.querySelectorAll('.quicker-api__quick-mode')]; const gear = head.querySelector('.quicker-api__quick-manage');
        return { first: menu.firstElementChild === head, headers: menu.querySelectorAll(':scope > .ctx-header').length, labels: modes.map(button => button.textContent),
            gear: [gear.tagName, gear.getAttribute('aria-label'), gear.textContent.trim(), gear.querySelectorAll('i.fa-gear').length],
            oneRow: modes.every(button => Math.abs(mid(button) - mid(gear)) < 2), oneLine: modes.every(button => rect(button).width > rect(button).height && getComputedStyle(button).whiteSpace === 'nowrap'),
            order: rect(modes[0]).right <= rect(modes[1]).left + 1 && rect(modes[1]).right <= rect(gear).left + 1, inside: rect(gear).right <= rect(head).right + 1 && rect(head).right <= rect(menu).right + 1,
            focus: document.activeElement === modes[0] }; })()`);
    assert.deepEqual(head, { first: true, headers: 1, labels: ['方案', '模型'], gear: ['BUTTON', '便捷按钮管理', '', 1], oneRow: true, oneLine: true, order: true, inside: true, focus: true });
    await run(`document.querySelector('.quicker-api__quick-manage').click(); true`);
    await waitFor(`document.querySelector('.quicker-api__quick-manager') !== null && ownedPopups.size === 1`, 'the gear did not open the manager');
    assert.equal(await run('Boolean(quickActionMenu)'), false);
    await run('[...ownedPopups][0].completeCancelled()');
    await waitFor('ownedPopups.size === 0', 'the manager did not close');
    await run('qmOpen(); true');
    log('quick menu: the content switch and the gear that opens the manager share one head row; the labels stay on one line');

    // 2. The switch re-renders the same menu with every saved channel's favorites and remembers the choice.
    const models = await run(`(() => { document.querySelector('.quicker-api__quick-mode[data-quick-mode="models"]').click();
        return { ...qmView(), anchored: quickActionMenu?.data('anchor') === document.getElementById('qm_anchor'), focus: document.activeElement?.dataset?.quickMode || '' }; })()`);
    assert.deepEqual(models, { mode: 'models', open: true, modes: [['schemes', 'false'], ['models', 'true']], schemes: [], groups: ['Alpha', 'Beta'],
        models: [['qm-a', 'a1', true, 'true'], ['qm-a', 'a2', false, null], ['qm-b', 'b1', false, null], ['qm-b', 'b2', false, null]], anchored: true, focus: 'models' });
    assert.deepEqual(await run(`$('.quicker-api__quick-group > span').toArray().map(span => [getComputedStyle(span).whiteSpace, span.getBoundingClientRect().height < parseFloat(getComputedStyle(span).fontSize) * 2])`),
        [['nowrap', true], ['nowrap', true]]);
    log('quick menu: the model list groups the favorites of every saved channel (drafts and channels without favorites excluded) and marks the live model');

    // 3. Picking a model of another channel applies that channel with that model; no scheme is created or selected.
    await run(`(() => { messages.length = 0; document.querySelector('.quicker-api__quick-model[data-profile-id="qm-b"][data-model="b2"]').click(); return quickActionQueue; })()`);
    await settle();
    assert.deepEqual(await run(`[settings().activeProfileId, oai_settings.custom_url, oai_settings.custom_model, Boolean(quickActionMenu), settings().activeQuickActionId,
        settings().quickActions.length, messages.some(item => item.level === 'success' && item.message.includes('Beta · b2')), messages.filter(item => item.level === 'error').length]`),
        ['qm-b', 'https://b.invalid/v1', 'b2', false, '', 1, true, 0]);
    const reopened = await run('qmOpen(), qmView()');
    assert.equal(reopened.mode, 'models');
    assert.deepEqual(reopened.models.filter(row => row[2]), [['qm-b', 'b2', true, 'true']]);
    log('quick menu: picking a model applies its channel and model through the scheme queue, adds no scheme, and the menu reopens on the model list');

    // 4. Schemes still run from the menu, with their parameter overrides.
    await run(`document.querySelector('.quicker-api__quick-mode[data-quick-mode="schemes"]').click()`);
    assert.deepEqual((await run('qmView()')).schemes, ['Scheme']);
    await run(`(() => { document.querySelector('.quicker-api__quick-menu .ctx-item').click(); return quickActionQueue; })()`);
    await settle();
    assert.deepEqual(await run(`fixtureGenerationData().then(data => [settings().activeProfileId, oai_settings.custom_model, settings().activeQuickActionId, data.temperature])`),
        ['qm-a', 'a2', 'qm-s', 1.11]);
    // A model picked from the list that no scheme describes sends the preset's own parameters.
    await run(`(() => { settings().quickMenuMode = 'models'; qmOpen(); document.querySelector('.quicker-api__quick-model[data-profile-id="qm-a"][data-model="a1"]').click(); return quickActionQueue; })()`);
    await settle();
    assert.deepEqual(await run(`fixtureGenerationData().then(data => [oai_settings.custom_model, settings().activeQuickActionId, activeQuickAction()?.id || '', data.temperature])`),
        ['a1', '', '', 0.7]);
    log('quick menu: schemes still run from the menu with their parameter overrides; a model picked from the list that matches no scheme uses the preset parameters');

    // 5. Nothing to list.
    const empty = await run(`(() => { const saved = settings().profiles; settings().profiles = saved.filter(item => item.id === 'qm-empty');
        qmOpen(); const text = $('.quicker-api__quick-menu-empty .qr--button-label').text(); closeQuickActionMenu(); settings().profiles = saved; return text; })()`);
    assert.equal(empty, '暂无收藏模型');
    await run(`closeQuickActionMenu(); document.getElementById('qm_anchor').remove(); settings().quickMenuMode = 'schemes'; true`);
    log('quick menu: the model list says so when no channel has a favorite model');
}

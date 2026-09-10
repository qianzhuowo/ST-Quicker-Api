import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runParameterRegressions } from './parameter-regression.mjs';

// Run from the plugin: node tests/regression.mjs
// Override CHROME_PATH and ST_PUBLIC_DIR when the host/browser is elsewhere.
const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = process.env.ST_PUBLIC_DIR || path.resolve(root, '../../../..');
const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let browserPath;
for (const candidate of candidates) { try { await access(candidate); browserPath = candidate; break; } catch { /* Try next. */ } }
assert.ok(browserPath, 'Set CHROME_PATH to a Chromium-based browser executable');

const host = process.env.QUICKER_TEST_HOST || 'sillytavern';
assert.ok(['sillytavern', 'tauritavern'].includes(host), 'QUICKER_TEST_HOST must be sillytavern or tauritavern');
const scopedHost = host === 'tauritavern';
const savePath = scopedHost ? '/api/settings/patch' : '/api/settings/save';
const profile = { id: 'profile-test', name: '配置名称不重复格式 ' + '长名称'.repeat(20), format: 'openai', endpoint: 'https://example.invalid/v1', model: 'profile-default', availableModels: ['profile-default', 'model-a', 'model-b', 'model-c'], secretId: 'test-secret' };
const preset = model => ({ chat_completion_source: 'custom', custom_url: profile.endpoint, custom_model: model, bind_preset_to_connection: true,
    ...(scopedHost ? { custom_api_format: 'openai_compat', additional_parameters_by_source: {}, additional_parameters_migration_version: 1 } : {}),
});
const state = {
    settings: {
        extension_settings: { quickerApi: {
            schemaVersion: 12, migratedFromCustomOpenAIProfiles: true, profiles: [profile], selectedProfileId: profile.id, activeProfileId: profile.id,
            presetBindings: { A: profile.id, B: profile.id }, quickActionPlacement: 'disabled', panelCollapsed: true,
            quickActions: Array.from({ length: 8 }, (_, i) => ({ id: `qa-${i}`, name: '超长方案名称'.repeat(12), profileId: profile.id, model: 'model-a', sequence: i })),
            quickUrls: [{ id: 'url', name: 'Test', url: profile.endpoint }],
        } },
        oai_settings: { ...preset('model-a'), preset_settings_openai: 'A' },
    },
    presets: { A: preset('model-a'), B: preset('model-b') },
    failSettings: false, failPreset: false, delayedModel: '', requests: [],
};
const assets = {
    '/jquery.js': await readFile(path.join(publicRoot, 'lib/jquery-3.5.1.min.js')),
    '/host.css': (await readFile(path.join(publicRoot, 'style.css'), 'utf8')).replace(/@import[^;]*;/g, ''),
    '/popup.css': (await readFile(path.join(publicRoot, 'css/popup.css'), 'utf8')).replace(/@import[^;]*;/g, ''),
    '/plugin.css': await readFile(path.join(root, 'style.css')),
    '/fixture.js': await readFile(path.join(root, 'tests/host-fixture.js')),
    '/plugin.js': (await readFile(path.join(root, 'platform.js'), 'utf8')).replace(/^export /gm, '') + '\n'
        + (await readFile(path.join(root, 'index.js'), 'utf8')).replace(/^import .*;\r?\n/gm, '').split('jQuery(() => {')[0]
        + '\ninitializeSettings(); $("#chat_completion_source").after(toolbarHtml()); bindEvents(); renderProfiles(); watchForDomChanges(); window.fixtureReady = true;',
};
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/popup.css"><link rel="stylesheet" href="/plugin.css"><style>:root{--SmartThemeBlurTintColor:#20232b;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#667;--SmartThemeQuoteColor:#9ad;--mainFontSize:16px;--mainFontFamily:Arial;--black30a:#0004}body{margin:0;padding:8px;overflow:auto;height:auto}#openai_api{display:block;max-width:700px}#native{display:none}</style></head><body><div id="openai_api"><select id="chat_completion_source"><option value="custom">Custom</option><option value="claude">Claude</option><option value="makersuite">Gemini</option>${scopedHost ? '<option value="custom_openai_responses">Responses</option>' : ''}</select></div><div id="native"><select id="settings_preset_openai"></select><button id="update_oai_preset">Update</button><button id="new_oai_preset">New</button><input id="custom_model_id"><input id="custom_api_url_text"><input id="openai_reverse_proxy"><input id="openai_proxy_password"><input id="custom_include_body"><input id="custom_exclude_body"><input id="custom_include_headers"><select id="model_claude_select"><option value="claude-model">Claude</option></select><select id="model_google_select"><option value="gemini-model">Gemini</option></select><button id="api_button_openai">Connect</button></div><script>const fixtureData=${JSON.stringify({ ...state.settings, host, presets: state.presets }).replace(/</g, '\\u003c')};</script><script src="/jquery.js"></script><script src="/fixture.js"></script><script src="/plugin.js"></script></body></html>`);
            return;
        }
        if (assets[url.pathname]) {
            res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
            res.end(assets[url.pathname]);
            return;
        }
        if (!url.pathname.startsWith('/api/')) { res.writeHead(404).end(); return; }
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        const body = buffers.length ? JSON.parse(Buffer.concat(buffers)) : {};
        state.requests.push({ path: url.pathname, body });
        res.setHeader('Content-Type', 'application/json');
        switch (url.pathname) {
            case '/api/settings/save':
                if (state.failSettings) { res.writeHead(500).end('{}'); return; }
                state.settings = body;
                if (state.delaySettings) await new Promise(resolve => setTimeout(resolve, state.delaySettings));
                res.end('{}'); return;
            case '/api/settings/patch': {
                if (state.failSettings) { res.writeHead(500).end('{}'); return; }
                for (const op of body.ops) {
                    if (!op.path.length) { state.settings = op.value; continue; }
                    let parent = state.settings;
                    for (const key of op.path.slice(0, -1)) parent = parent[key];
                    if (op.op === 'delete') delete parent[op.path.at(-1)];
                    else parent[op.path.at(-1)] = op.value;
                }
                if (state.delaySettings) await new Promise(resolve => setTimeout(resolve, state.delaySettings));
                res.end(JSON.stringify({ hash_algorithm: 'tt-user-settings-stable-sha256-v1', settings_hash: '1'.repeat(64) })); return;
            }
            case '/api/presets/save':
                if (state.failPreset) { res.writeHead(500).end('{}'); return; }
                if (body.apiId === 'openai') state.presets[body.name] = body.preset;
                if (body.preset?.custom_model === state.delayedModel) await new Promise(resolve => setTimeout(resolve, 180));
                res.end(JSON.stringify({ name: body.name })); return;
            case '/api/secrets/read':
                res.end(JSON.stringify(Object.fromEntries(['api_key_custom', 'api_key_claude', 'api_key_makersuite'].map(key => [key, [{ id: 'test-secret', active: true }]])))); return;
            case '/api/secrets/rotate': res.end('{}'); return;
            default: res.writeHead(404).end('{}');
        }
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const userDataDir = await mkdtemp(path.join(tmpdir(), 'quicker-api-test-'));
let browser, socket;
let passed = 0;
const log = label => { passed++; console.log(`PASS ${label}`); };
try {
    browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Browser launch timed out')), 15000);
        browser.once('error', reject);
        browser.stderr.on('data', data => {
            const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
    });
    socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0;
    const pending = new Map();
    const exceptions = [];
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        if (!pending.has(message.id)) return;
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    };
    function cdp(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    async function newPage(preload = '') {
        const { browserContextId } = await cdp('Target.createBrowserContext');
        const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
        await cdp('Runtime.enable', {}, sessionId);
        const evaluate = async expression => {
            const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result.value;
        };
        const waitForFixture = async () => {
            for (let i = 0; i < 100; i++) {
                try {
                    if (await evaluate('Boolean(window.fixtureReady)')) return;
                } catch { /* The old execution context may disappear during navigation. */ }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`Fixture failed to load: ${JSON.stringify(exceptions)}`);
        };
        if (preload) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);
        await cdp('Page.navigate', { url: origin }, sessionId);
        await waitForFixture();
        const reload = async () => {
            await evaluate('window.fixtureReady = false');
            await cdp('Page.reload', {}, sessionId);
            await waitForFixture();
        };
        return { sessionId, evaluate, reload };
    }
    const page = await newPage();
    const run = page.evaluate;
    assert.deepEqual(await run('[Boolean(document.getElementById("quicker_api_storage")), Boolean(document.getElementById("quicker_api_save"))]'), [false, true]);
    log('redundant storage button is removed while the API save button remains');
    assert.deepEqual(await run('[settings().schemaVersion, settings().presetModels.A.model, settings().presetModels.B.model]'), [13, 'model-a', 'model-b']);
    log('schema 12 migration preserves distinct native preset models');
    assert.deepEqual(await run('[panelCollapsed, Object.hasOwn(settings(), "panelCollapsed"), document.getElementById("quicker_api_body").hidden]'), [false, false, false]);
    log('legacy server fold flag is removed and does not control browser defaults');

    await run(`$('#quicker_api_custom_model').val('model-c'); oai_settings.custom_model = 'stale-native'; document.getElementById('update_oai_preset').click(); nativeSaveTask`);
    assert.equal(state.presets.A.custom_model, 'model-c');
    assert.deepEqual(await run('[settings().presetModels.A.model, settings().presetModels.B.model, profiles()[0].model]'), ['model-c', 'model-b', 'profile-default']);
    log('native update snapshots the panel model without saving the Profile default');

    state.failPreset = true;
    await run(`$('#quicker_api_custom_model').val('model-a'); document.getElementById('update_oai_preset').click(); nativeSaveTask`);
    assert.equal(await run('settings().presetModels.A.model'), 'model-c');
    state.failPreset = false;
    log('failed native save does not overwrite the successful binding');

    await run(`$('#quicker_api_url').val('https://different.invalid/v1'); document.getElementById('update_oai_preset').click()`);
    assert.equal(await run('nativePresetSaveIntent'), null);
    await run(`$('#quicker_api_url').val(profiles()[0].endpoint); pendingOperations++; document.getElementById('update_oai_preset').click(); pendingOperations--`);
    assert.equal(await run('nativePresetSaveIntent'), null);
    log('unsaved connection edits and pending operations block unsafe native saves');

    await run(`$('#quicker_api_custom_model').val('model-c'); captureNativePresetSave(new Event('click'), 'update'); fetch('/api/presets/save', {method:'POST', headers:getRequestHeaders(), body:JSON.stringify({apiId:'kobold',name:'A',preset:{}})})`);
    assert.equal(await run('nativePresetSaveIntent?.type'), 'update');
    await run('clearNativePresetSaveIntent()');
    assert.equal(await run(`requestPath('https://unrelated.invalid/api/presets/save')`), '');
    log('unrelated preset API and cross-origin requests are not observed');

    await run(`captureNativePresetSave(new Event('click'), 'create'); const cancelled = document.createElement('dialog'); cancelled.className='popup'; document.body.append(cancelled); cancelled.showModal(); new Promise(resolve => setTimeout(resolve, 120))`);
    await run(`document.querySelector('dialog[open]').remove(); new Promise(resolve => setTimeout(resolve, 150))`);
    assert.equal(await run('nativePresetSaveIntent'), null);
    assert.equal(await run('settings().presetBindings.C'), undefined);
    log('cancelled native create dialog clears intent without making a binding');

    await run(`captureNativePresetSave(new Event('click'), 'create'); fetch(new Request(location.origin+'/api/presets/save', {method:'POST',headers:getRequestHeaders(),body:JSON.stringify({apiId:'openai', name:'C', preset:structuredClone(oai_settings)})}))`);
    assert.equal(await run('settings().presetModels.C.model'), 'model-c');
    await run(`handlePresetRenamed({apiId:'openai',oldName:'C',newName:'Renamed'}); handlePresetDeleted({apiId:'openai',name:'Renamed'})`);
    assert.equal(await run('settings().presetModels.Renamed'), undefined);
    log('Request-object create saves, rename and delete maintain model bindings');

    state.delayedModel = 'model-a';
    await run(`$('#quicker_api_custom_model').val('model-a'); document.getElementById('update_oai_preset').click(); window.firstSave=nativeSaveTask; new Promise(resolve=>setTimeout(resolve,30))`);
    await run(`$('#quicker_api_custom_model').val('model-c'); document.getElementById('update_oai_preset').click(); Promise.all([window.firstSave,nativeSaveTask])`);
    assert.equal(await run('settings().presetModels.A.model'), 'model-c');
    state.delayedModel = '';
    log('late older save responses do not replace the latest model binding');

    for (const bind of [true, false]) {
        await run(`oai_settings.bind_preset_to_connection = ${bind}; switchTestPreset('B')`);
        assert.deepEqual(await run('[oai_settings.custom_model, getEditorModel()]'), ['model-b', 'model-b']);
        await run(`oai_settings.bind_preset_to_connection = ${bind}; switchTestPreset('A')`);
        assert.deepEqual(await run('[oai_settings.custom_model, getEditorModel()]'), ['model-c', 'model-c']);
    }
    log('preset switching restores each model with native connection binding on or off');

    await run('enqueueOperation(restoreInitialProfileSelection)');
    assert.equal(await run('getEditorModel()'), 'model-c');
    log('startup restoration does not replace the bound model with Profile default');
    await run(`profiles()[0].name += ' renamed'; renderProfiles(profiles()[0].id)`);
    assert.equal(await run('getEditorModel()'), 'model-c');
    await run(`profiles()[0].name = ${JSON.stringify(profile.name)}; renderProfiles(profiles()[0].id)`);
    log('renaming/re-rendering an active Profile preserves its current preset model');

    await run('persistSettingsNow()');
    const sharedSnapshot = await run('JSON.stringify(settings())');
    const foldRequestCount = state.requests.filter(request => request.path === savePath).length;
    await run(`$('#quicker_api_key_input').val('draft-only-not-a-real-key').trigger('input'); document.getElementById('quicker_api_toggle').click()`);
    const folded = await run(`({text:$('#quicker_api_summary').text(),hidden:$('#quicker_api_body').prop('hidden'),key:$('#quicker_api_key_input').val(),expanded:$('#quicker_api_toggle').attr('aria-expanded')})`);
    assert.equal(folded.text, `OpenAI Compatible · ${profile.name} · model-c`);
    assert.equal(folded.hidden, true); assert.equal(folded.key, 'draft-only-not-a-real-key'); assert.equal(folded.expanded, 'false');
    const churn = await run(`(async () => {
        flushPanelState();
        const summary = document.getElementById('quicker_api_summary');
        const textNode = summary.firstChild;
        const observer = new MutationObserver(() => {});
        observer.observe(summary, { childList:true, subtree:true, characterData:true, attributes:true });
        const originalStringify = JSON.stringify;
        const originalSetItem = Storage.prototype.setItem;
        let serializations = 0, writes = 0;
        JSON.stringify = function(...args) { serializations++; return originalStringify.apply(this,args); };
        Storage.prototype.setItem = function(key, value) { if (key === PANEL_COLLAPSED_STORAGE_KEY) writes++; return originalSetItem.call(this,key,value); };
        try {
            for (let i = 0; i < 20; i++) document.getElementById('quicker_api_toggle').click();
            const immediateWrites = writes;
            JSON.stringify = originalStringify;
            renderPanelSummary(); renderPanelSummary();
            const mutations = observer.takeRecords().length;
            observer.disconnect();
            await new Promise(resolve => setTimeout(resolve, 650));
            const leave = new Event('beforeunload', {cancelable:true}); warnBeforeLeaving(leave);
            return {serializations, mutations, sameText:textNode === summary.firstChild, immediateWrites, writes, saveState:settingsSaveState, warns:leave.defaultPrevented};
        } finally {
            JSON.stringify = originalStringify;
            Storage.prototype.setItem = originalSetItem;
            observer.disconnect();
        }
    })()`);
    assert.deepEqual(churn, { serializations: 0, mutations: 0, sameText: true, immediateWrites: 0, writes: 1, saveState: 'saved', warns: false });
    assert.equal(state.requests.filter(request => request.path === savePath).length, foldRequestCount);
    assert.equal(await run('JSON.stringify(settings())'), sharedSnapshot);
    assert.equal(await run('localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY)'), 'true');
    assert.equal(await run('getComputedStyle(document.getElementById("quicker_api_toggle")).touchAction'), 'manipulation');
    assert.ok(!Object.hasOwn(state.settings.extension_settings.quickerApi, 'panelCollapsed'));
    assert.ok(!JSON.stringify(state.settings).includes('draft-only-not-a-real-key'));
    log('folds preserve drafts without server saves, serialization, or summary DOM churn');
    log('rapid toggles coalesce local writes off the click path and do not warn on leaving');
    await run(`togglePanel(); window.dispatchEvent(new Event('pagehide'))`);
    assert.equal(await run('localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY)'), 'false');
    await run(`togglePanel(); window.dispatchEvent(new Event('pagehide')); clearKeyEditor()`);
    assert.equal(await run('localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY)'), 'true');
    log('pagehide flushes the final browser preference before deferred writes run');
    await page.reload();
    assert.deepEqual(await run('[panelCollapsed, document.getElementById("quicker_api_body").hidden]'), [true, true]);
    log('the same browser remembers folding after a real page reload');

    state.failSettings = true;
    assert.equal(await run(`settings().quickUrls.push({id:'second', name:'Second',url:'https://second.invalid/v1'}); persistSettingsNow()`), false);
    assert.equal(await run('settingsSaveState'), 'error');
    assert.ok(await run(`messages.some(item => item.level === 'warning' && item.message.includes('请检查连接并重试保存') && !item.message.includes('图标'))`));
    state.failSettings = false;
    assert.equal(await run('persistSettingsNow()'), true);
    assert.equal(await run('settingsSaveState'), 'saved');
    log('settings failure is surfaced and retry waits for the successful server response');

    const other = await newPage();
    assert.deepEqual(await other.evaluate('[panelCollapsed, settings().presetModels.A.model, settings().quickUrls.length, settings().quickActions.length]'), [false, 'model-c', 2, 8]);
    assert.deepEqual(await run('[panelCollapsed, localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY)]'), [true, 'true']);
    await other.evaluate('enqueueOperation(restoreInitialProfileSelection)');
    assert.equal(await other.evaluate('getEditorModel()'), 'model-c');
    await other.evaluate('persistSettingsNow()');
    log('a new browser shares server API settings but has an independent fold preference');

    const restricted = await newPage(`Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Blocked by test','SecurityError')}}); window.requestIdleCallback=undefined;`);
    await restricted.evaluate('persistSettingsNow()');
    const restrictedRequestCount = state.requests.filter(request => request.path === savePath).length;
    assert.equal(await restricted.evaluate('panelCollapsed'), false);
    await restricted.evaluate(`document.getElementById('quicker_api_toggle').click(); new Promise(resolve=>setTimeout(resolve,200))`);
    assert.deepEqual(await restricted.evaluate('[panelCollapsed, document.getElementById("quicker_api_body").hidden, panelStateSaveHandle, settingsSaveState]'), [true, true, null, 'saved']);
    assert.equal(state.requests.filter(request => request.path === savePath).length, restrictedRequestCount);
    await restricted.evaluate('teardownQuickerApi()');
    log('blocked localStorage and missing idle callbacks keep folding usable without server fallback');

    await run('togglePanel(); void manageQuickActions()');
    for (const [width, height] of [[320, 568], [375, 667], [768, 500], [1024, 340], [320, 300]]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true }, page.sessionId);
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const layout = await run(`(() => {
            const dialog = document.querySelector('dialog[open]');
            const save = dialog.querySelector('.quicker-api__quick-header-actions .quicker-api__save-button');
            const rect = save.getBoundingClientRect();
            const columns = dialog.querySelector('.quicker-api__quick-columns'); columns.scrollTop = columns.scrollHeight;
            const detail = dialog.querySelector('.quicker-api__quick-editor-actions .quicker-api__save-button');
            const dr = detail.getBoundingClientRect();
            return {width:innerWidth,height:innerHeight,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},detail:{left:dr.left,right:dr.right,top:dr.top,bottom:dr.bottom},hit:save.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)),overflows:dialog.scrollWidth>dialog.clientWidth+2};
        })()`);
        assert.ok(layout.rect.left >= 0 && layout.rect.right <= width && layout.rect.top >= 0 && layout.rect.bottom <= height, JSON.stringify({ width, height, layout }));
        assert.ok(layout.hit, `Header save is clipped at ${width}x${height}`);
        assert.ok(!layout.overflows, `Horizontal overflow at ${width}x${height}`);
        assert.ok(layout.detail.top >= 0 && layout.detail.bottom <= height, `Detail save is unreachable: ${JSON.stringify(layout)}`);
        log(`save buttons remain accessible at ${width}x${height}, including long names`);
    }
    await run(`document.querySelector('dialog[open] .quicker-api__quick-field input').value='Unsaved'; $('dialog[open] .quicker-api__quick-field input').first().trigger('input'); $('dialog[open] .quicker-api__quick-header-actions .quicker-api__save-button').trigger('click')`);
    assert.ok(await run(`messages.some(item => item.message.includes('当前方案还有未确认'))`));
    log('global save refuses to silently discard an unconfirmed detail draft');

    await run(`$('dialog[open] .quicker-api__quick-editor-actions .quicker-api__save-button').trigger('click'); $('dialog[open] .quicker-api__quick-header-actions .quicker-api__save-button').trigger('click')`);
    for (let i = 0; i < 50 && await run(`Boolean(document.querySelector('dialog[open]'))`); i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await run(`Boolean(document.querySelector('dialog[open]'))`), false);
    assert.equal(state.settings.extension_settings.quickerApi.quickActions[0].name, 'Unsaved');
    log('detail plus global save persists schemes before closing the manager');

    await run(`settings().profiles.push(normalizeProfile({id:'claude',name:'Claude test',format:'anthropic',secretId:'test-secret',model:'claude-custom'})); settings().selectedProfileId='claude'; settings().activeProfileId='claude'; oai_settings.chat_completion_source='claude'; oai_settings.claude_model='claude-custom'; $('#chat_completion_source').val('claude'); renderProfiles('claude');`);
    assert.equal(await run('getEditorModel()'), 'claude-custom');
    await run(`syncEditorModelToNative()`);
    assert.equal(await run('oai_settings.claude_model'), 'claude-custom');
    log('provider models missing from native options are retained and synchronized');

    await run(`$('#quicker_api_key_input').val('revealed-test-key'); keyEditorDirty=false; captureNativePresetSave(new Event('click'),'update')`);
    assert.equal(await run('nativePresetSaveIntent?.format'), 'anthropic');
    await run(`clearNativePresetSaveIntent(); clearKeyEditor(); settings().profiles.push(normalizeProfile({id:'gemini',name:'Gemini test',format:'gemini',secretId:'test-secret',model:'gemini-custom'})); settings().selectedProfileId='gemini'; settings().activeProfileId='gemini'; oai_settings.chat_completion_source='makersuite'; oai_settings.google_model='gemini-custom'; $('#chat_completion_source').val('makersuite'); renderProfiles('gemini'); syncEditorModelToNative()`);
    assert.equal(await run('oai_settings.google_model'), 'gemini-custom');
    log('revealed credentials are not dirty edits; Gemini custom models also synchronize');

    await run(`persistSettingsNow()`);
    await run(`window.oldWrapper=globalThis.fetch; window.oldDelegate=originalFetch; togglePanel(); teardownQuickerApi()`);
    assert.deepEqual(await run('[panelStateSaveHandle, localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY)]'), [null, 'true']);
    assert.equal(await run(`globalThis.fetch===window.oldDelegate && !document.getElementById('quicker_api') && settingsSaveWaiters.size===0`), true);
    assert.equal(await run(`window.oldWrapper('/api/secrets/read',{method:'POST',headers:getRequestHeaders(),body:'{}'}).then(response=>response.ok)`), true);
    log('teardown restores fetch and leaves retained wrapper delegates safe');

    await other.evaluate('teardownQuickerApi()');
    await runParameterRegressions({ page: await newPage(), state, scopedHost, log });
    assert.deepEqual(exceptions, [], `Unexpected browser exceptions: ${JSON.stringify(exceptions)}`);
    console.log(`\n${passed} regression checks passed (${host}). Host APIs and account data were simulated in memory.`);
} finally {
    socket?.close();
    if (browser && browser.exitCode === null) {
        const closed = new Promise(resolve => browser.once('close', resolve));
        browser.kill();
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await new Promise(resolve => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

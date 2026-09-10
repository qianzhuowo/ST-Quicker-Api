// Isolated host adapter for regression.mjs. All HTTP requests go to the test
// server, which holds synthetic settings in memory; no real account is used.
const extension_settings = fixtureData.extension_settings;
const oai_settings = fixtureData.oai_settings;
const openai_settings = Object.values(fixtureData.presets);
const openai_setting_names = Object.fromEntries(Object.keys(fixtureData.presets).map((name, i) => [name, i]));
const chat_completion_sources = { CUSTOM: 'custom', CLAUDE: 'claude', MAKERSUITE: 'makersuite' };
const SECRET_KEYS = { CUSTOM: 'api_key_custom', CLAUDE: 'api_key_claude', MAKERSUITE: 'api_key_makersuite' };
const secret_state = Object.fromEntries(Object.values(SECRET_KEYS).map(key => [key, [{ id: 'test-secret', active: true }]]));
const proxies = [];
const yaml = { parse: text => JSON.parse(text) }; // Test exclusions use the JSON subset of YAML.
const scopedHost = fixtureData.host === 'tauritavern';
function fixtureParameters(settings = oai_settings, source, { create = true } = {}) {
    source ??= settings.chat_completion_source === 'custom' && settings.custom_api_format !== 'openai_compat'
        ? `custom_${settings.custom_api_format}` : settings.chat_completion_source;
    const store = settings.additional_parameters_by_source ??= {};
    let entry = store[source];
    if (entry === undefined) {
        entry = { include_body: '', exclude_body: '', include_headers: '' };
        if (create) store[source] = entry;
    }
    return entry;
}
const openaiHost = { oai_settings, chat_completion_sources, ...(scopedHost ? { getAdditionalParametersForSource: fixtureParameters } : {}) };
const event_types = new Proxy({}, { get: (_, key) => key });
const eventSource = {
    listeners: new Map(),
    on(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
    once(type, fn) { const wrapper = (...args) => { this.removeListener(type, wrapper); return fn(...args); }; this.on(type, wrapper); },
    removeListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); },
    makeLast(type, fn) { this.removeListener(type, fn); this.on(type, fn); },
    async emit(type, ...args) { for (const fn of [...(this.listeners.get(type) || [])]) await fn(...args); },
};
const messages = [];
const toastr = Object.fromEntries(['info', 'warning', 'error', 'success'].map(level => [level, message => messages.push({ level, message })]));
const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
let fixtureSaveBaseline = structuredClone({ extension_settings, oai_settings });
let fixtureSavePromise = null;
let fixtureSaveQueued = false;
function fixtureDiff(base, next, path = [], ops = []) {
    if (JSON.stringify(base) === JSON.stringify(next)) return ops;
    if (!base || !next || typeof base !== 'object' || typeof next !== 'object' || Array.isArray(base) || Array.isArray(next)) {
        ops.push({ op: 'set', path, value: next });
    } else {
        for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
            if (!Object.hasOwn(next, key)) ops.push({ op: 'delete', path: [...path, key] });
            else fixtureDiff(base[key], next[key], [...path, key], ops);
        }
    }
    return ops;
}
async function saveSettings() {
    if (scopedHost && fixtureSavePromise) { fixtureSaveQueued = true; return fixtureSavePromise; }
    fixtureSavePromise = (async () => {
        let success;
        do {
            fixtureSaveQueued = false;
            const payload = structuredClone({ extension_settings, oai_settings });
            const body = scopedHost
                ? { base_hash: '0'.repeat(64), ops: fixtureDiff(fixtureSaveBaseline, payload) } : payload;
            const response = await fetch(scopedHost ? '/api/settings/patch' : '/api/settings/save', {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body),
            });
            success = response.ok;
            if (success) fixtureSaveBaseline = payload;
        } while (scopedHost && fixtureSaveQueued && success);
        return scopedHost ? success : undefined;
    })();
    try { return await fixtureSavePromise; } finally { fixtureSavePromise = null; }
}
let saveTimer;
function saveSettingsDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(() => void saveSettings(), 80); }
function cancelDebounce() { clearTimeout(saveTimer); }
const settingsHost = { saveSettingsDebounced, ...(scopedHost ? { cancelPendingSettingsSave: () => cancelDebounce() } : {}) };
const POPUP_TYPE = { DISPLAY: 4, INPUT: 3, CONFIRM: 1 };
class Popup {
    constructor(content, type, value, options = {}) {
        this.options = options;
        this.dlg = document.createElement('dialog');
        this.dlg.className = 'popup';
        this.dlg.innerHTML = '<div class="popup-body"><div class="popup-content"></div><div class="popup-controls"></div></div>';
        $(this.dlg).find('.popup-content').append(content);
    }
    show() {
        document.body.append(this.dlg);
        this.dlg.showModal();
        return new Promise(resolve => { this.resolve = resolve; });
    }
    async complete(result) {
        if (this.options.onClosing && !await this.options.onClosing(this)) return;
        this.dlg.close();
        this.dlg.remove();
        this.resolve?.(result);
    }
    completeCancelled() { return this.complete(false); }
    completeAffirmative() { return this.complete(true); }
}

// Reproduce the relevant native event order: update snapshots settings inside
// its bubble-phase click handler, BEFORE awaiting the preset POST.
let nativeSaveTask = Promise.resolve();
$('#update_oai_preset').on('click', () => {
    const name = oai_settings.preset_settings_openai;
    const preset = structuredClone(oai_settings);
    nativeSaveTask = fetch('/api/presets/save', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ apiId: 'openai', name, preset }),
    }).then(async response => {
        if (response.ok) {
            const data = await response.json();
            openai_settings[openai_setting_names[data.name]] = preset;
        }
    });
});
$('#custom_model_id').on('input', function () { oai_settings.custom_model = this.value; });
$('#model_claude_select').on('change', function () { oai_settings.claude_model = this.value; });
$('#model_google_select').on('change', function () { oai_settings.google_model = this.value; });
$('#chat_completion_source').on('change', function () {
    if (scopedHost && this.value.startsWith('custom_')) {
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_api_format = this.value.slice(7);
    } else {
        oai_settings.chat_completion_source = this.value;
        if (scopedHost && this.value === 'custom') oai_settings.custom_api_format = 'openai_compat';
    }
});
for (const [id, key] of [['custom_api_url_text', 'custom_url'], ['openai_reverse_proxy', 'reverse_proxy'], ['openai_proxy_password', 'proxy_password']]) {
    $(`#${id}`).val(oai_settings[key] || '').on('input', function () { oai_settings[key] = this.value; });
}
function bindFixtureParameterInputs() {
    const entry = scopedHost ? fixtureParameters() : oai_settings;
    for (const field of ['include_body', 'exclude_body', 'include_headers']) {
        const key = scopedHost ? field : `custom_${field}`;
        $(`#custom_${field}`).val(entry[key] || '').off('input.fixtureNative').on('input.fixtureNative', function () { entry[key] = this.value; });
    }
}
bindFixtureParameterInputs();
function reopenFixtureParameterEditor() {
    for (const field of ['include_body', 'exclude_body', 'include_headers']) {
        const input = document.getElementById(`custom_${field}`);
        input.replaceWith(input.cloneNode());
        document.getElementById(`custom_${field}`).disabled = false;
    }
    bindFixtureParameterInputs();
    configureAdditionalParametersPopup();
}
// Construct the same transport parameter fields as the respective host.
async function fixtureGenerationData() {
    const parameters = scopedHost ? fixtureParameters() : {
        include_body: oai_settings.custom_include_body, exclude_body: oai_settings.custom_exclude_body, include_headers: oai_settings.custom_include_headers,
    };
    const modelField = { custom: 'custom_model', claude: 'claude_model', makersuite: 'google_model' }[oai_settings.chat_completion_source];
    const data = { chat_completion_source: oai_settings.chat_completion_source,
        custom_api_format: oai_settings.custom_api_format, custom_url: oai_settings.custom_url,
        reverse_proxy: oai_settings.reverse_proxy, model: oai_settings[modelField], temperature: 0.7, top_p: 0.9, top_k: 40,
        ...((scopedHost || oai_settings.chat_completion_source === 'custom') ? {
            custom_include_body: parameters.include_body, custom_exclude_body: parameters.exclude_body,
            custom_include_headers: parameters.include_headers,
        } : {}) };
    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data);
    return data;
}
$('#custom_model_id').val(oai_settings.custom_model);
$('#chat_completion_source').val(oai_settings.chat_completion_source);
for (const [name, i] of Object.entries(openai_setting_names)) $('#settings_preset_openai').append($('<option>').val(i).text(name));
$('#settings_preset_openai').val(openai_setting_names[oai_settings.preset_settings_openai]);

async function switchTestPreset(name) {
    const preset = structuredClone(openai_settings[openai_setting_names[name]]);
    oai_settings.preset_settings_openai = name;
    $('#settings_preset_openai').val(openai_setting_names[name]);
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, { presetName: name, preset });
    if (oai_settings.bind_preset_to_connection) {
        Object.assign(oai_settings, preset, { preset_settings_openai: name });
        $('#chat_completion_source').val(oai_settings.chat_completion_source).trigger('change');
    }
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
}

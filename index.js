import { extension_settings } from '../../../extensions.js';
import { chat_completion_sources, oai_settings, openai_settings, openai_setting_names, proxies } from '../../../openai.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { cancelDebounce } from '../../../utils.js';
import { eventSource, event_types, getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { yaml } from '../../../../lib.js';
import * as openaiHost from '../../../openai.js';
import * as settingsHost from '../../../../script.js';
import { createPlatformAdapter, inspectSettingsSave, normalizeOpenCodeEndpoint, validateOpenCodeConnection } from './platform.js';

const platform = createPlatformAdapter({ openai: openaiHost, settingsApi: settingsHost, cancelDebounce, $: (...args) => $(...args) });

const MODULE_NAME = 'quickerApi';
const LEGACY_MODULE_NAME = 'customOpenAIProfiles';
const SCHEMA_VERSION = 15;
const PANEL_COLLAPSED_STORAGE_KEY = 'quickerApi.panelCollapsed';
const MODEL_PICKER_LAYOUT_STORAGE_KEY = 'quickerApi.modelPickerLayout';
// Dropdown option layouts. "compact" is desktop-only; phones show it as normal.
const MODEL_PICKER_LAYOUTS = {
    normal: { label: '普通', icon: 'fa-table-cells-large' },
    compact: { label: '紧凑', icon: 'fa-table-cells' },
    single: { label: '单行', icon: 'fa-list' },
};
const EMPTY_SECRET_LABEL = 'Quicker Api · No key';
const BUILTIN_QUICK_URLS = Object.freeze([
    { name: 'OpenAI', url: 'https://api.openai.com/v1' },
    { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
    { name: 'DeepSeek', url: 'https://api.deepseek.com/beta' },
    { name: 'Groq', url: 'https://api.groq.com/openai/v1' },
    { name: 'Mistral AI', url: 'https://api.mistral.ai/v1' },
    { name: 'xAI', url: 'https://api.x.ai/v1' },
    { name: 'Chutes', url: 'https://llm.chutes.ai/v1' },
    { name: 'Moonshot', url: 'https://api.moonshot.ai/v1' },
    { name: 'Fireworks', url: 'https://api.fireworks.ai/inference/v1' },
    { name: 'SiliconFlow', url: 'https://api.siliconflow.com/v1' },
    { name: 'SiliconFlow CN', url: 'https://api.siliconflow.cn/v1' },
    { name: 'AIML API', url: 'https://api.aimlapi.com/v1' },
    { name: 'NanoGPT', url: 'https://nano-gpt.com/api/v1' },
    { name: 'CometAPI', url: 'https://api.cometapi.com/v1' },
]);
const SUPPORTED_SOURCES = new Set([
    chat_completion_sources.CUSTOM,
    chat_completion_sources.CLAUDE,
    chat_completion_sources.MAKERSUITE,
    ...(platform.supportsOpenCode ? [chat_completion_sources.OPENCODE] : []),
]);
const CUSTOM_PROTOCOLS = {
    openai_responses: '自定义 (兼容 OpenAI Responses)',
    claude_messages: '自定义 (兼容 Claude Messages)',
    gemini_generate_content: '自定义 (兼容 Gemini generateContent)',
    gemini_interactions: '自定义 (兼容 Gemini Interactions)',
};
for (const protocol of Object.keys(CUSTOM_PROTOCOLS)) {
    if (platform.supportsCustomFormat(protocol)) SUPPORTED_SOURCES.add(platform.customSelection(protocol));
}
const FORMATS = Object.freeze({
    openai: {
        label: 'OpenAI Compatible',
        source: chat_completion_sources.CUSTOM,
        secretKey: SECRET_KEYS.CUSTOM,
        keyInput: '#api_key_custom',
        modelField: 'custom_model',
        modelInput: '#custom_model_id',
        endpointField: 'custom_url',
        endpointInput: '#custom_api_url_text',
    },
    ...Object.fromEntries(Object.entries(CUSTOM_PROTOCOLS).map(([apiFormat, label]) => [apiFormat, {
        label, apiFormat, source: chat_completion_sources.CUSTOM,
        secretKey: SECRET_KEYS.CUSTOM, keyInput: '#api_key_custom',
        modelField: 'custom_model', modelInput: '#custom_model_id',
        endpointField: 'custom_url', endpointInput: '#custom_api_url_text',
    }])),
    anthropic: {
        label: 'Anthropic',
        source: chat_completion_sources.CLAUDE,
        secretKey: SECRET_KEYS.CLAUDE,
        keyInput: '#api_key_claude',
        modelField: 'claude_model',
        modelInput: '#model_claude_select',
        endpointField: 'reverse_proxy',
        endpointInput: '#openai_reverse_proxy',
    },
    // Preserve stored OpenCode profiles even on hosts without this capability;
    // never reinterpret them as Custom profiles with a different credential slot.
    opencode: {
        label: 'OpenCode (Zen / Go)',
        source: chat_completion_sources.OPENCODE || 'opencode',
        secretKey: SECRET_KEYS.OPENCODE || 'api_key_opencode',
        keyInput: '#api_key_opencode',
        modelField: 'opencode_model',
        modelInput: '#model_opencode_select',
        endpointField: 'opencode_endpoint',
        endpointInput: '#opencode_endpoint',
    },
    gemini: {
        label: 'Gemini',
        source: chat_completion_sources.MAKERSUITE,
        secretKey: SECRET_KEYS.MAKERSUITE,
        keyInput: '#api_key_makersuite',
        modelField: 'google_model',
        modelInput: '#model_google_select',
        endpointField: 'reverse_proxy',
        endpointInput: '#openai_reverse_proxy',
    },
});
const MODEL_LIST_VERSION = 2;
const DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    profiles: [],
    selectedProfileId: null,
    activeProfileId: null,
    emptySecretIds: {},
    presetBindings: {},
    presetModels: {},
    migratedFromCustomOpenAIProfiles: false,
    blockedSecretKeys: {},
    quickActions: [],
    quickActionPlacement: 'leftSendForm',
    quickUrls: [],
};

let operationQueue = Promise.resolve();
let pendingOperations = 0;
let syncingEditorModel = false;
// Model picker view is session-only: every page load starts on favorites, and a
// successful fetch switches to the full list until the user switches back.
let modelPickerView = 'favorites';
let modelPickerProfile = null;
const modelPickerAutoFetched = new Set();
let keyEditorDirty = false;
let nativeCreateMonitor = null;
let nativeIntentExpiry = null;
let presetSaveSequence = 0;
const latestPresetSaves = new Map();
let confirmedSettingsSnapshot = '';
let settingsSaveState = 'saved';
let settingsSaveTimer = null;
let settingsRequestSequence = 0;
let confirmedSettingsSequence = 0;
const settingsSaveWaiters = new Set();
let panelCollapsed = readBrowserPanelState();
let panelSummaryText = '';
let panelStateDirty = false;
let panelStateSaveHandle = null;
let panelStateSaveUsesIdle = false;
let profileSelectionGeneration = 0;
let extensionDisabled = false;
let teardownPending = false;
let presetChangeTimer = null;
let presetTransitionBlocked = false;
let presetConnectWasDisabled = false;
let nativePresetSaveIntent = null;
let originalFetch = null;
let presetObservedFetch = null;
let editorModelBaseline = '';
let quickActionQueue = Promise.resolve();
let quickActionTransaction = 0;
let quickActionBlockingToken = 0;
let quickPresetWaitCancel = null;
let quickActionMenu = null;
let quickActionPopper = null;
let quickActionPlacementPopup = null;
let quickActionObserver = null;
let quickActionRenderPending = false;
let quickUrlMenu = null;
let quickUrlPortal = null;
const nativePresetCaptureHandlers = {};
const ownedPopups = new Set();
const activeFetchControllers = new Set();


function settings() {
    return extension_settings[MODULE_NAME];
}

function profiles() {
    return settings().profiles;
}

function finishSettingsSave(snapshot, success) {
    if (extensionDisabled || teardownPending || !snapshot) return;
    if (success) confirmedSettingsSnapshot = snapshot;
    if (snapshot === JSON.stringify(settings())) {
        clearTimeout(settingsSaveTimer);
        const previous = settingsSaveState;
        settingsSaveState = success ? 'saved' : 'error';
        if (!success && previous !== 'error') toastr.warning('Quicker Api 设置尚未确认保存到服务器，请检查连接并重试保存；请勿直接刷新，以免丢失未保存的修改。');
    }
    for (const waiter of [...settingsSaveWaiters]) {
        if (waiter.snapshot === snapshot) waiter.complete(success);
    }
}

function scheduleSettingsSave() {
    if (extensionDisabled || teardownPending) return;
    const snapshot = JSON.stringify(settings());
    settingsSaveState = snapshot === confirmedSettingsSnapshot ? 'saved' : 'pending';
    clearTimeout(settingsSaveTimer);
    if (settingsSaveState === 'pending') {
        settingsSaveTimer = setTimeout(() => finishSettingsSave(snapshot, false), 15000);
    }
    saveSettingsDebounced();
}

async function persistSettingsNow() {
    if (extensionDisabled || teardownPending) return false;
    scheduleSettingsSave();
    platform.cancelSettingsSave();
    const snapshot = JSON.stringify(settings());
    // Verify the exact plugin snapshot through the host's full/delta save
    // response. A save event or a fulfilled promise alone is not confirmation.
    return await new Promise(resolve => {
        const waiter = { snapshot, complete: null };
        const timer = setTimeout(() => { finishSettingsSave(snapshot, false); waiter.complete(false); }, 15000);
        waiter.complete = success => {
            clearTimeout(timer);
            settingsSaveWaiters.delete(waiter);
            resolve(success);
        };
        settingsSaveWaiters.add(waiter);
        void saveSettings().then(result => {
            if (result === false) finishSettingsSave(snapshot, false);
        }).catch(() => finishSettingsSave(snapshot, false));
    });
}

function warnBeforeLeaving(event) {
    if (extensionDisabled || settingsSaveState === 'saved') return;
    event.preventDefault();
    event.returnValue = '';
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeModelList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => normalizeText(item).slice(0, 500)).filter(Boolean))].slice(0, 1000);
}

function sanitizeName(value) {
    return normalizeText(value).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 120);
}

function makeId(prefix = 'profile') {
    return globalThis.crypto?.randomUUID
        ? `${prefix}-${globalThis.crypto.randomUUID()}`
        : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function hasManagedModels(format) {
    return Object.hasOwn(FORMATS, format);
}

function isCustomFormat(format) {
    return FORMATS[format]?.source === chat_completion_sources.CUSTOM;
}

function isFormatSupported(format) {
    return format === 'opencode' ? platform.supportsOpenCode
        : Boolean(FORMATS[format]) && (!isCustomFormat(format) || platform.supportsCustomFormat(FORMATS[format].apiFormat));
}

function supportsCustomParameters(format) {
    return isCustomFormat(format) || format === 'opencode';
}

function matchesFormat(format, native) {
    if (arguments.length < 2) native = oai_settings;
    const config = FORMATS[format];
    return Boolean(config && native) && platform.matchesSource(config.source, native, config.apiFormat);
}

function usesProxyProfile(format, endpoint) {
    return (format === 'anthropic' || format === 'gemini') && Boolean(endpoint);
}

function nativeEndpoint(format) {
    const value = String(oai_settings[FORMATS[format].endpointField] || '');
    return format === 'opencode' ? normalizeOpenCodeEndpoint(value) : value;
}

function editorEndpoint(format) {
    const value = normalizeText($('#quicker_api_url').val());
    return format === 'opencode' ? validateOpenCodeConnection(value, String($('#quicker_api_opencode_format').val())) : value;
}

function renderOpenCodeFields(profile, format) {
    if (format === 'opencode') $('#quicker_api_format option[value="opencode"]').prop('disabled', !platform.supportsOpenCode);
    $('#quicker_api_opencode_fields').toggle(format === 'opencode');
    $('#quicker_api_opencode_format').val(profile?.opencodeApiFormat || oai_settings.opencode_api_format || 'openai_compat');
    $('#quicker_api_url').attr('type', format === 'opencode' ? 'text' : 'url')
        .attr('placeholder', format === 'opencode' ? 'zen / go 或官方 OpenCode URL' : 'Custom 必填；Anthropic / Gemini 留空使用官方端点');
}

function normalizeFormat(value) {
    return Object.hasOwn(FORMATS, value) ? value : 'openai';
}

function getSecretEntries(key) {
    return Array.isArray(secret_state[key]) ? secret_state[key] : [];
}

function getSecretEntry(key, id) {
    return getSecretEntries(key).find(entry => entry.id === id) || null;
}

function getActiveSecret(key) {
    return getSecretEntries(key).find(entry => entry.active) || null;
}

function selectedProfile() {
    const id = String($('#quicker_api_profile_select').val() || '');
    return profiles().find(profile => profile.id === id) || null;
}

function currentPresetName() {
    return normalizeText(oai_settings.preset_settings_openai || $('#settings_preset_openai option:selected').text());
}

function nativePresetByName(name) {
    return Object.hasOwn(openai_setting_names, name) ? openai_settings[openai_setting_names[name]] : null;
}

function presetModelSnapshot(profile, model) {
    return { profileId: profile.id, format: profile.format, model: normalizeText(model).slice(0, 500) };
}

function boundPresetModel(name, profile) {
    const snapshot = settings().presetModels[name];
    if (snapshot?.profileId === profile.id && snapshot.format === profile.format) return snapshot.model;
    const preset = nativePresetByName(name);
    const config = FORMATS[profile.format];
    if (matchesFormat(profile.format, preset) && typeof preset[config.modelField] === 'string') {
        return normalizeText(preset[config.modelField]);
    }
    return profile.model;
}

function uniqueName(baseName, ignoredId = null) {
    const base = sanitizeName(baseName) || 'API Profile';
    const used = new Set(profiles().filter(profile => profile.id !== ignoredId).map(profile => profile.name.toLocaleLowerCase()));
    if (!used.has(base.toLocaleLowerCase())) return base;
    let index = 2;
    while (used.has(`${base} (${index})`.toLocaleLowerCase())) index++;
    return `${base} (${index})`;
}

function normalizeQuickAction(raw, index = 0) {
    return {
        id: normalizeText(raw?.id) || makeId('quick-action'),
        name: sanitizeName(raw?.name),
        preset: normalizeText(raw?.preset).slice(0, 500),
        profileId: normalizeText(raw?.profileId),
        model: normalizeText(raw?.model).slice(0, 500),
        sequence: Number.isFinite(Number(raw?.sequence)) ? Number(raw.sequence) : index,
    };
}

function normalizeQuickUrl(raw) {
    return {
        id: normalizeText(raw?.id) || makeId('quick-url'),
        name: sanitizeName(raw?.name),
        url: String(raw?.url || '').trim().slice(0, 2048),
    };
}

function normalizeProfile(raw) {
    const format = normalizeFormat(raw?.format);
    const model = String(raw?.model || '').slice(0, 500);
    const managed = hasManagedModels(format);
    const fetchedModels = managed ? normalizeModelList(raw?.fetchedModels) : [];
    let availableModels = managed ? normalizeModelList(raw?.availableModels) : [];
    if (managed && raw?.modelListVersion !== MODEL_LIST_VERSION) {
        // Version 1 kept the current model in the list and, for uncurated
        // profiles, mirrored every fetched model into it. Favorites now keep only
        // the current model; everything in the fetched snapshot is still
        // reachable from "All". Entries absent from the snapshot (added by hand)
        // stay, otherwise they would be lost entirely.
        const fetched = new Set(fetchedModels);
        if (fetched.size) availableModels = availableModels.filter(item => item === model || !fetched.has(item));
        if (model && !availableModels.includes(model)) availableModels.unshift(model);
    }
    return {
        id: normalizeText(raw?.id) || makeId(),
        name: sanitizeName(raw?.name) || 'API Profile',
        format,
        endpoint: String(raw?.endpoint || (format === 'opencode' ? 'zen' : '')).slice(0, 2048),
        opencodeApiFormat: format === 'opencode' ? String(raw?.opencodeApiFormat || 'openai_compat') : '',
        model,
        availableModels,
        fetchedModels,
        modelListVersion: MODEL_LIST_VERSION,
        fetchedFromEndpoint: hasManagedModels(format)
            ? String(raw?.fetchedFromEndpoint || (raw?.fetchedModels?.length ? raw?.endpoint : '') || '').slice(0, 2048)
            : '',
        includeBody: supportsCustomParameters(format) ? String(raw?.includeBody || '').slice(0, 100000) : '',
        excludeBody: String(raw?.excludeBody || '').slice(0, 100000),
        includeHeaders: supportsCustomParameters(format) ? String(raw?.includeHeaders || '').slice(0, 100000) : '',
        secretId: String(raw?.secretId || ''),
        proxyPreset: String(raw?.proxyPreset || ''),
        needsSecret: Boolean(raw?.needsSecret),
        // Opaque source reference used only to suppress already-migrated native
        // entries when their credential cannot be exposed across secret slots.
        nativeImportFingerprint: String(raw?.nativeImportFingerprint || '').slice(0, 5000),
        updatedAt: String(raw?.updatedAt || ''),
    };
}

function initializeSettings() {
    // SillyTavern loads extension_settings from the user's settings.json before
    // activating extension scripts, including extensions installed at runtime.
    const originalSnapshot = JSON.stringify(extension_settings[MODULE_NAME]);
    confirmedSettingsSnapshot = originalSnapshot || '';
    let changed = false;
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        changed = true;
    }
    const value = extension_settings[MODULE_NAME];
    const storedVersion = Number(value.schemaVersion || 0);
    if (storedVersion > SCHEMA_VERSION) {
        toastr.error('Quicker Api 数据来自更高版本。当前扩展保持停用以避免损坏配置。');
        return false;
    }

    if (!value.migratedFromCustomOpenAIProfiles) {
        const legacy = extension_settings[LEGACY_MODULE_NAME];
        if (legacy && typeof legacy === 'object' && Array.isArray(legacy.profiles) && !Array.isArray(value.profiles)) {
            value.profiles = structuredClone(legacy.profiles);
            value.activeProfileId = legacy.activeProfileId || null;
            value.selectedProfileId = legacy.activeProfileId || null;
            value.emptySecretIds = legacy.emptySecretId ? { [SECRET_KEYS.CUSTOM]: String(legacy.emptySecretId) } : {};
        } else if (legacy && typeof legacy === 'object' && Array.isArray(legacy.profiles) && (!value.profiles || value.profiles.length === 0)) {
            value.profiles = structuredClone(legacy.profiles);
            value.activeProfileId = legacy.activeProfileId || null;
            value.selectedProfileId = legacy.activeProfileId || null;
            value.emptySecretIds = legacy.emptySecretId ? { [SECRET_KEYS.CUSTOM]: String(legacy.emptySecretId) } : {};
        }
        value.migratedFromCustomOpenAIProfiles = true;
        changed = true;
    }

    value.profiles = Array.isArray(value.profiles) ? value.profiles.map(profile => normalizeProfile(profile)) : [];
    value.emptySecretIds = value.emptySecretIds && typeof value.emptySecretIds === 'object' ? value.emptySecretIds : {};
    value.presetBindings = Object.assign(Object.create(null), value.presetBindings && typeof value.presetBindings === 'object' && !Array.isArray(value.presetBindings) ? value.presetBindings : {});
    value.presetModels = Object.assign(Object.create(null), value.presetModels && typeof value.presetModels === 'object' && !Array.isArray(value.presetModels) ? value.presetModels : {});
    // This is a browser UI preference, not part of the shared API settings.
    // Remove the old server field once; never copy it into a new browser.
    if (Object.hasOwn(value, 'panelCollapsed')) {
        delete value.panelCollapsed;
        changed = true;
    }
    value.blockedSecretKeys = value.blockedSecretKeys && typeof value.blockedSecretKeys === 'object' ? value.blockedSecretKeys : {};
    value.quickActionPlacement = ['leftSendForm', 'rightSendForm', 'qrButtons', 'disabled'].includes(value.quickActionPlacement)
        ? value.quickActionPlacement
        : 'rightSendForm';
    value.quickActions = Array.isArray(value.quickActions)
        ? value.quickActions.map(normalizeQuickAction).filter(action => action.preset || action.profileId || action.model)
        : [];
    value.quickActions.sort((a, b) => a.sequence - b.sequence).forEach((action, index) => { action.sequence = index; });
    value.quickUrls = Array.isArray(value.quickUrls)
        ? value.quickUrls.map(normalizeQuickUrl).filter(item => item.name && isValidQuickUrl(item.url))
        : [];
    const seenQuickUrlIds = new Set();
    value.quickUrls.forEach(item => {
        if (seenQuickUrlIds.has(item.id)) item.id = makeId('quick-url');
        seenQuickUrlIds.add(item.id);
    });
    for (const key of Object.keys(value.blockedSecretKeys)) {
        if (!Object.values(FORMATS).some(config => config.secretKey === key)) delete value.blockedSecretKeys[key];
    }
    value.activeProfileId = value.profiles.some(profile => profile.id === value.activeProfileId) ? value.activeProfileId : null;
    const normalizedSelectedProfileId = value.profiles.some(profile => profile.id === value.selectedProfileId)
        ? value.selectedProfileId
        : value.activeProfileId;
    if (value.selectedProfileId !== normalizedSelectedProfileId) changed = true;
    value.selectedProfileId = normalizedSelectedProfileId;
    value.schemaVersion = SCHEMA_VERSION;

    for (const [name, profileId] of Object.entries(value.presetBindings)) {
        if (!sanitizeName(name) || !value.profiles.some(profile => profile.id === profileId)) {
            delete value.presetBindings[name];
            changed = true;
        }
    }
    for (const [name, snapshot] of Object.entries(value.presetModels)) {
        const profile = value.profiles.find(item => item.id === value.presetBindings[name]);
        if (!profile || snapshot?.profileId !== profile.id || snapshot?.format !== profile.format || typeof snapshot.model !== 'string') {
            delete value.presetModels[name];
            changed = true;
        } else {
            value.presetModels[name] = presetModelSnapshot(profile, snapshot.model);
        }
    }
    // Older bindings contain only a Profile ID. Recover each model from its
    // own native preset, never copy one Profile default into every binding.
    for (const [name, profileId] of Object.entries(value.presetBindings)) {
        if (Object.hasOwn(value.presetModels, name)) continue;
        const profile = value.profiles.find(item => item.id === profileId);
        const preset = nativePresetByName(name);
        const config = FORMATS[profile.format];
        if (matchesFormat(profile.format, preset) && typeof preset[config.modelField] === 'string') {
            value.presetModels[name] = presetModelSnapshot(profile, preset[config.modelField]);
            changed = true;
        }
    }
    if (storedVersion !== SCHEMA_VERSION) changed = true;
    if (changed || originalSnapshot !== JSON.stringify(value)) scheduleSettingsSave();
    return true;
}

function keyExposureGuidance() {
    if (platform.isTauriHost) {
        return {
            warning: '请打开“用户设置 → TauriTavern Settings（齿轮）→ Misc（杂项）”，启用“允许显示密钥”，保存后重启 TauriTavern。该权限只用于查看或复制密钥，不影响获取模型。',
            title: '在 TauriTavern 中允许查看密钥',
            intro: '这是 TauriTavern 的独立设置，不在 SillyTavern 原生杂项页中：',
            steps: ['打开用户设置面板', '点击 TauriTavern Settings（齿轮）', '进入 Misc（杂项）并启用“允许显示密钥”', '保存设置后重启 TauriTavern'],
        };
    }
    return {
        warning: '请在 config.yaml 中将 allowKeysExposure 设置为 true，然后重启 SillyTavern。',
        title: '允许查看已保存密钥',
        intro: '编辑 SillyTavern 的 config.yaml：',
        code: 'allowKeysExposure: true',
        steps: ['修改后重启 SillyTavern'],
    };
}

function keyExposureHelpHtml() {
    const guidance = keyExposureGuidance();
    const steps = guidance.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
    const code = guidance.code ? `<pre><code>${escapeHtml(guidance.code)}</code></pre>` : '';
    return `<strong>${escapeHtml(guidance.title)}</strong><p>${escapeHtml(guidance.intro)}</p>${code}<ul>${steps}</ul><p>启用后，Quicker Api 才能：</p><ul><li>点击眼睛查看已保存密钥</li><li>复制已保存密钥</li></ul>`;
}

function toolbarHtml() {
    const formatOptions = Object.entries(FORMATS).filter(([format]) => isFormatSupported(format)).map(([value, config]) => `<option value="${value}">${config.label}</option>`).join('');
    return `
        <section id="quicker_api" class="quicker-api">
            <div class="quicker-api__title">
                <button id="quicker_api_toggle" class="quicker-api__toggle" type="button" aria-expanded="true" aria-controls="quicker_api_body" title="收起 Quicker Api">
                    <span class="quicker-api__brand"><i class="fa-solid fa-bolt"></i> Quicker Api</span>
                    <span id="quicker_api_summary" class="quicker-api__summary"></span>
                    <i class="fa-solid fa-chevron-up quicker-api__chevron" aria-hidden="true"></i>
                </button>
            </div>
            <div id="quicker_api_body">
            <div class="quicker-api__field quicker-api__profile-field">
                <label for="quicker_api_profile_select">配置</label>
                <div class="quicker-api__row">
                    <select id="quicker_api_profile_select" class="text_pole" aria-label="API 配置"></select>
                    <button id="quicker_api_new" class="menu_button quicker-api__icon-button" type="button" title="新增 API 设置" aria-label="新增 API 设置"><i class="fa-solid fa-plus"></i></button>
                    <button id="quicker_api_save" class="menu_button quicker-api__icon-button quicker-api__save-button" type="button" title="保存 API 设置" aria-label="保存 API 设置"><i class="fa-solid fa-floppy-disk"></i></button>
                    <button id="quicker_api_rename" class="menu_button quicker-api__icon-button" type="button" title="重命名 API 设置" aria-label="重命名 API 设置"><i class="fa-solid fa-pen"></i></button>
                    <button id="quicker_api_copy" class="menu_button quicker-api__icon-button" type="button" title="复制 API 设置" aria-label="复制 API 设置"><i class="fa-solid fa-clone"></i></button>
                    <button id="quicker_api_import_native" class="menu_button quicker-api__text-button" type="button" title="批量迁移 SillyTavern 的 OpenAI、Reverse Proxy Presets 和 Connection Manager 配置" aria-label="导入原 OAI 设置"><i class="fa-solid fa-file-import"></i><span class="quicker-api__desktop-label">导入原 OAI 设置</span></button>
                    <button id="quicker_api_delete" class="menu_button quicker-api__icon-button quicker-api__delete-button" type="button" title="删除 API 设置" aria-label="删除 API 设置"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="quicker-api__field">
                <label for="quicker_api_format">格式</label>
                <select id="quicker_api_format" class="text_pole" aria-label="API 格式">${formatOptions}</select>
            </div>
            <div class="quicker-api__field">
                <label for="quicker_api_url">URL</label>
                <div class="quicker-api__row quicker-api__url-row">
                    <input id="quicker_api_url" class="text_pole" type="url" autocomplete="off" placeholder="Custom 必填；Anthropic / Gemini 留空使用官方端点" />
                    <button id="quicker_api_quick_url" class="menu_button quicker-api__text-button" type="button" title="从常用端点中快捷填入 URL" aria-label="快捷 URL" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-link"></i><span class="quicker-api__desktop-label">快捷 URL</span><i class="fa-solid fa-caret-down quicker-api__desktop-label"></i></button>
                </div>
            </div>
            <div id="quicker_api_opencode_fields" class="quicker-api__field" style="display:none">
                <label for="quicker_api_opencode_format">OpenCode 协议</label>
                <select id="quicker_api_opencode_format" class="text_pole">
                    <option value="openai_compat">OpenAI Chat Completions</option>
                    <option value="openai_responses">OpenAI Responses</option>
                    <option value="claude_messages">Anthropic Messages</option>
                    <option value="gemini">Gemini（仅 Zen）</option>
                </select>
            </div>
            <div class="quicker-api__field quicker-api__key-field">
                <label for="quicker_api_key_input">Key / Password</label>
                <div class="quicker-api__row quicker-api__key-row">
                    <input id="quicker_api_key_input" class="text_pole flex1 quicker-api__secret-masked" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="无凭据" />
                    <div class="quicker-api__key-actions">
                        <span id="quicker_api_key_help" class="fa-solid fa-circle-question note-link-span quicker-api__key-help" tabindex="0" role="button" aria-label="查看密钥明文权限说明" aria-describedby="quicker_api_key_help_tooltip"></span>
                        <aside id="quicker_api_key_help_tooltip" class="quicker-api__key-help-tooltip" role="tooltip">${keyExposureHelpHtml()}</aside>
                        <button id="quicker_api_reveal_key" class="menu_button" type="button" title="显示或隐藏密码" aria-label="显示或隐藏密码"><i class="fa-solid fa-eye-slash"></i></button>
                        <button id="quicker_api_copy_key" class="menu_button" type="button" title="复制密钥" aria-label="复制密钥"><i class="fa-solid fa-copy"></i></button>
                        <div id="quicker_api_native_key_manager" class="menu_button fa-solid fa-key fa-fw manage-api-keys" title="Manage API keys" aria-label="Manage API keys" data-i18n="[title]Manage API keys" data-key="api_key_custom"></div>
                    </div>
                </div>
            </div>
            <div class="quicker-api__field quicker-api__model-field">
                <label>模型</label>
                <div id="quicker_api_model_control" class="quicker-api__row"></div>
            </div>
            <div class="quicker-api__field quicker-api__parameters-field">
                <label>参数</label>
                <div class="quicker-api__row">
                    <button id="quicker_api_additional_parameters" class="menu_button quicker-api__text-button" type="button" title="打开 SillyTavern 原生附加参数编辑器"><i class="fa-solid fa-sliders"></i><span>附加参数</span></button>
                </div>
            </div>
            <div id="quicker_api_status" class="quicker-api__status"></div>
            </div>
        </section>`;
}

function readBrowserPanelState() {
    try {
        return globalThis.localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        // Storage may be blocked in private/embedded browsers. Keep a page-only
        // preference in that case, without falling back to server settings.
        return false;
    }
}

function flushPanelState() {
    if (panelStateSaveHandle !== null) {
        if (panelStateSaveUsesIdle) globalThis.cancelIdleCallback?.(panelStateSaveHandle);
        else clearTimeout(panelStateSaveHandle);
        panelStateSaveHandle = null;
    }
    if (!panelStateDirty) return;
    panelStateDirty = false;
    try {
        globalThis.localStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, String(panelCollapsed));
    } catch {
        // Folding must still work even if the browser refuses persistence.
    }
}

function schedulePanelStateSave() {
    panelStateDirty = true;
    if (panelStateSaveHandle !== null) return;
    // Coalesce rapid toggles and keep synchronous localStorage work off the
    // click path. pagehide/teardown flush the final value if we leave sooner.
    panelStateSaveUsesIdle = typeof globalThis.requestIdleCallback === 'function';
    panelStateSaveHandle = panelStateSaveUsesIdle
        ? globalThis.requestIdleCallback(flushPanelState, { timeout: 500 })
        : setTimeout(flushPanelState, 100);
}

function setAttributeIfChanged(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function renderPanelCollapseState() {
    const panel = document.getElementById('quicker_api');
    const body = document.getElementById('quicker_api_body');
    const toggle = document.getElementById('quicker_api_toggle');
    if (!panel || !body || !toggle) return;
    if (panel.classList.contains('is-collapsed') !== panelCollapsed) panel.classList.toggle('is-collapsed', panelCollapsed);
    if (body.hidden !== panelCollapsed) body.hidden = panelCollapsed;
    setAttributeIfChanged(toggle, 'aria-expanded', String(!panelCollapsed));
    setAttributeIfChanged(toggle, 'aria-label', `${panelCollapsed ? '展开' : '收起'} Quicker Api：${panelSummaryText}`);
    setAttributeIfChanged(toggle, 'title', panelCollapsed ? panelSummaryText : '收起 Quicker Api');
}

function renderPanelSummary() {
    const summary = document.getElementById('quicker_api_summary');
    if (!summary) return;
    const format = normalizeFormat($('#quicker_api_format').val());
    panelSummaryText = `${FORMATS[format].label} · ${selectedProfile()?.name || '未选择配置'} · ${getEditorModel(format) || '未选择模型'}`;
    if (summary.textContent !== panelSummaryText) summary.textContent = panelSummaryText;
    setAttributeIfChanged(summary, 'title', panelSummaryText);
    renderPanelCollapseState();
}

function togglePanel() {
    if (extensionDisabled || teardownPending) return;
    panelCollapsed = !panelCollapsed;
    if (panelCollapsed && quickUrlMenu) closeQuickUrlMenu();
    renderPanelCollapseState();
    schedulePanelStateSave();
}

function setStatus(message = '', state = '') {
    $('#quicker_api_status').text(message).attr('data-state', state);
}

function clearKeyEditor(placeholder = '未配置密钥') {
    keyEditorDirty = false;
    $('#quicker_api_key_input').val('').addClass('quicker-api__secret-masked').attr('placeholder', placeholder);
    $('#quicker_api_reveal_key i').attr('class', 'fa-solid fa-eye-slash');
}

function profileHasCredential(profile, format, endpoint) {
    if (!profile) return false;
    if (usesProxyProfile(format, endpoint)) return Boolean(getBoundProxyPreset(profile)?.password);
    const config = FORMATS[format];
    return Boolean(profile.secretId
        && !profile.needsSecret
        && profile.secretId !== settings().emptySecretIds[config.secretKey]
        && getSecretEntry(config.secretKey, profile.secretId));
}

function updateCredentialEditor(profile = selectedProfile()) {
    const format = profile?.format || normalizeFormat($('#quicker_api_format').val());
    const config = FORMATS[format];
    const endpoint = profile?.endpoint ?? normalizeText($('#quicker_api_url').val());
    const proxyMode = usesProxyProfile(format, endpoint);
    const hasCredential = profileHasCredential(profile, format, endpoint);
    const placeholder = proxyMode
        ? (hasCredential ? '已配置代理密码（点击眼睛查看）' : '未配置代理密码')
        : (hasCredential ? '已配置密钥（点击眼睛查看）' : '未配置密钥');
    clearKeyEditor(placeholder);
    $('#quicker_api_native_key_manager').attr('data-key', config.secretKey).data('key', config.secretKey).toggle(!proxyMode);
}

function getEditorModel(format = normalizeFormat($('#quicker_api_format').val())) {
    if (hasManagedModels(format)) return normalizeText($('#quicker_api_custom_model').val());
    return normalizeText($('#quicker_api_provider_model').val());
}

function syncEditorModelToNative() {
    const format = normalizeFormat($('#quicker_api_format').val());
    const config = FORMATS[format];
    const model = getEditorModel(format);
    if (platform.isModelAction(model)) return;
    syncingEditorModel = true;
    try {
        oai_settings[config.modelField] = model;
        const input = $(config.modelInput);
        if (input.is('select') && !input.find('option').filter((_, option) => option.value === model).length) {
            input.append($('<option>').val(model).text(model));
        }
        input.val(model).trigger(isCustomFormat(format) ? 'input' : 'change');
    } finally {
        syncingEditorModel = false;
    }
}

function handleNativeModelChange() {
    if (syncingEditorModel || extensionDisabled || teardownPending || presetTransitionBlocked || pendingOperations) return;
    const format = normalizeFormat($('#quicker_api_format').val());
    if (!matchesFormat(format)) return;
    const profile = selectedProfile();
    if (profile && (settings().activeProfileId !== profile.id || !profileMatchesNative(profile, { includeModel: false }))) return;
    // Keep the panel aligned with changes made by native controls/other extensions.
    renderModelControl(selectedProfile(), String(oai_settings[FORMATS[format].modelField] || ''));
    renderStatus();
}

function nativeAdditionalParameters(source) {
    return platform.readAdditionalParameters(source);
}

function applyNativeAdditionalParameters(profile) {
    platform.writeAdditionalParameters(profile, isCustomFormat(profile.format) ? platform.customSelection(FORMATS[profile.format].apiFormat) : FORMATS[profile.format].source);
}

function nativeProviderModels(format) {
    if (format !== 'anthropic' && format !== 'gemini') return [];
    return $(FORMATS[format].modelInput).find('option').toArray()
        .map(option => option.value).filter(value => !platform.isModelAction(value));
}

function profileFetchedModels(profile, endpoint = profile?.endpoint) {
    if (!profile || !hasManagedModels(profile.format)) return [];
    return normalizeText(profile.fetchedFromEndpoint) === normalizeText(endpoint) ? normalizeModelList(profile.fetchedModels) : [];
}

// A favorite is stale only when a non-empty remote snapshot exists and lacks it.
function staleFavoriteModels(favorites, fetched) {
    const remote = new Set(normalizeModelList(fetched));
    return remote.size ? normalizeModelList(favorites).filter(model => !remote.has(model)) : [];
}

function modelPickerData() {
    const format = normalizeFormat($('#quicker_api_format').val());
    const profile = modelPickerProfile?.format === format ? modelPickerProfile : null;
    const current = normalizeText($('#quicker_api_custom_model').val());
    const favorites = normalizeModelList(profile?.availableModels || []);
    const fetched = profileFetchedModels(profile);
    // "All" is the latest remote snapshot; the host's built-in list is only a
    // fallback before anything has been fetched.
    const all = fetched.length ? fetched : normalizeModelList(nativeProviderModels(format));
    return { format, profile, current, favorites, fetched, all, stale: new Set(staleFavoriteModels(favorites, fetched)) };
}

function renderModelControl(profile = selectedProfile(), modelOverride = null) {
    const format = normalizeFormat($('#quicker_api_format').val());
    const root = $('#quicker_api_model_control');
    // While open, the dropdown lives in <body>; drop it explicitly before re-rendering.
    const previousDropdown = $('#quicker_api_model_dropdown');
    const previousSearch = previousDropdown.find('.quicker-api__model-search-input');
    const reopen = root.find('.quicker-api__model-picker').hasClass('is-open');
    const query = String(previousSearch.val() ?? '');
    const refocus = previousSearch.is(':focus');
    if (reopen) unbindModelPickerPosition();
    previousDropdown.remove();
    $('#quicker_api_model_portal').remove();
    root.empty();
    modelPickerProfile = profile;
    const current = normalizeText(modelOverride ?? profile?.model ?? oai_settings[FORMATS[format].modelField]);
    const models = normalizeModelList([current, ...(profile?.availableModels || []), ...profileFetchedModels(profile), ...nativeProviderModels(format)]);
    // The hidden select stays the single source of the editor model value.
    const select = $('<select id="quicker_api_custom_model" class="quicker-api__model-value" aria-hidden="true" tabindex="-1" hidden>')
        .append($('<option>').val('').text('— 选择模型 —'));
    for (const model of models) select.append($('<option>').val(model).text(model));
    select.val(current);
    const picker = $(`<div class="quicker-api__model-picker">
        <button id="quicker_api_model_trigger" class="text_pole quicker-api__model-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="quicker_api_model_dropdown" aria-label="选择模型">
            <i class="quicker-api__model-trigger-mark" aria-hidden="true"></i><span class="quicker-api__model-trigger-label"></span><i class="fa-solid fa-chevron-down quicker-api__model-trigger-caret" aria-hidden="true"></i>
        </button>
        <div id="quicker_api_model_dropdown" class="quicker-api__model-dropdown" hidden>
            <div class="quicker-api__model-tabs" role="tablist" aria-label="模型列表">
                <button type="button" role="tab" data-model-view="favorites" title="收藏的模型"><i class="fa-solid fa-star"></i><span>收藏</span><small></small></button>
                <button type="button" role="tab" data-model-view="all" title="最近一次获取的全部模型"><i class="fa-solid fa-cloud"></i><span>全部</span><small></small></button>
            </div>
            <div class="quicker-api__model-search-row">
                <input class="text_pole quicker-api__model-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="搜索或输入新模型 ID" aria-label="搜索模型" aria-controls="quicker_api_model_options">
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="add" title="添加模型" aria-label="添加模型"><i class="fa-solid fa-plus"></i></button>
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="fetch" title="获取模型" aria-label="获取模型"><i class="fa-solid fa-arrows-rotate"></i></button>
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="layout"><i class="fa-solid"></i></button>
            </div>
            <div id="quicker_api_model_options" class="quicker-api__model-options" role="listbox" aria-label="模型"></div>
        </div>
    </div>`);
    root.append(
        picker,
        select,
        $('<button id="quicker_api_add_model" class="menu_button" type="button" title="添加模型到收藏并使用" aria-label="添加模型到收藏并使用"><i class="fa-solid fa-plus"></i><span class="quicker-api__desktop-label">添加</span><span class="quicker-api__mobile-label">添加模型</span></button>'),
        $('<button id="quicker_api_fetch_models" class="menu_button" type="button" title="获取模型并切换到“全部”列表"><i class="fa-solid fa-arrows-rotate"></i><span class="quicker-api__desktop-label">获取模型</span><span class="quicker-api__mobile-label">获取模型</span></button>'),
        $('<button id="quicker_api_manage_models" class="menu_button" type="button" title="批量管理收藏与远端模型列表"><i class="fa-solid fa-list-check"></i><span class="quicker-api__desktop-label">管理模型列表</span><span class="quicker-api__mobile-label">管理模型</span></button>'),
        $('<button class="menu_button quicker-api__manage-actions" type="button" title="便捷按钮管理"><i class="fa-solid fa-bolt"></i><span class="quicker-api__desktop-label">便捷按钮管理</span><span class="quicker-api__mobile-label">便捷按钮</span></button>'),
    );
    updateModelTrigger();
    if (reopen) openModelPicker({ query, focusSearch: refocus });
    renderPanelSummary();
}

function updateModelTrigger() {
    const trigger = $('#quicker_api_model_trigger');
    if (!trigger.length) return;
    const data = modelPickerData();
    const favorite = data.favorites.includes(data.current);
    const stale = Boolean(data.current && data.fetched.length && !data.all.includes(data.current));
    const mark = !data.current ? '' : stale ? 'fa-solid fa-triangle-exclamation is-stale' : favorite ? 'fa-solid fa-star is-favorite' : 'fa-solid fa-cloud';
    trigger.toggleClass('is-empty', !data.current)
        .attr('title', stale ? `${data.current}（云端最新列表中已不存在）` : (data.current || '选择模型'));
    trigger.find('.quicker-api__model-trigger-mark').attr('class', `quicker-api__model-trigger-mark ${mark}`);
    trigger.find('.quicker-api__model-trigger-label').text(data.current || '— 选择模型 —');
}

function modelPickerElement() {
    return $('#quicker_api_model_control .quicker-api__model-picker');
}

// The dropdown is portaled to <body> while open (like the quick URL menu) so it
// never adds to the scroll height of the host's settings panel.
function modelPickerDropdown() {
    return $('#quicker_api_model_dropdown');
}

let modelPickerColumns = 1;
let modelPickerPositionFrame = 0;
let modelPickerLayout = null;

function readModelPickerLayout() {
    if (modelPickerLayout) return modelPickerLayout;
    let stored = null;
    try {
        stored = globalThis.localStorage.getItem(MODEL_PICKER_LAYOUT_STORAGE_KEY);
    } catch {
        // Storage may be blocked; the layout then lasts for this page only.
    }
    modelPickerLayout = Object.hasOwn(MODEL_PICKER_LAYOUTS, stored) ? stored : 'normal';
    return modelPickerLayout;
}

function isNarrowModelPicker() {
    return (globalThis.visualViewport?.width || window.innerWidth) <= 760;
}

// The layout that actually applies: phones have no compact layout.
function effectiveModelPickerLayout() {
    const layout = readModelPickerLayout();
    return layout === 'compact' && isNarrowModelPicker() ? 'normal' : layout;
}

function cycleModelPickerLayout() {
    const order = isNarrowModelPicker() ? ['normal', 'single'] : ['normal', 'compact', 'single'];
    const current = effectiveModelPickerLayout();
    modelPickerLayout = order[(order.indexOf(current) + 1) % order.length];
    try {
        globalThis.localStorage.setItem(MODEL_PICKER_LAYOUT_STORAGE_KEY, modelPickerLayout);
    } catch {
        // Keep the in-memory choice.
    }
    positionModelPicker();
}

function applyModelPickerLayout(dropdown) {
    const layout = effectiveModelPickerLayout();
    const narrow = isNarrowModelPicker();
    modelPickerColumns = layout === 'single' ? 1 : layout === 'compact' ? 4 : narrow ? 2 : 3;
    dropdown.style.setProperty('--quicker-api-model-columns', String(modelPickerColumns));
    dropdown.dataset.layout = layout;
    const order = narrow ? ['normal', 'single'] : ['normal', 'compact', 'single'];
    const next = MODEL_PICKER_LAYOUTS[order[(order.indexOf(layout) + 1) % order.length]];
    const button = dropdown.querySelector('[data-model-picker-action="layout"]');
    if (!button) return;
    const label = `展示形式：${MODEL_PICKER_LAYOUTS[layout].label}（点击切换为${next.label}）`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.firstElementChild.className = `fa-solid ${MODEL_PICKER_LAYOUTS[layout].icon}`;
}

// The area of the layout viewport the user can actually see, in client coordinates.
function visibleViewportRect() {
    const viewport = globalThis.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const left = viewport?.offsetLeft ?? 0;
    return { top, left, bottom: top + (viewport?.height || window.innerHeight), right: left + (viewport?.width || window.innerWidth) };
}

function positionModelPicker() {
    modelPickerPositionFrame = 0;
    const dropdown = document.getElementById('quicker_api_model_dropdown');
    const trigger = document.getElementById('quicker_api_model_trigger');
    if (!dropdown || dropdown.hidden || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const view = visibleViewportRect();
    // The trigger was hidden (drawer closed) or scrolled fully out of view.
    if ((!rect.width && !rect.height) || rect.bottom < view.top || rect.top > view.bottom) return closeModelPicker();
    applyModelPickerLayout(dropdown);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const margin = 8;
    const gap = 4;
    const width = Math.min(view.right - view.left - margin * 2, Math.max(rect.width, 40 * rem));
    const left = Math.max(view.left + margin, Math.min(rect.left, view.right - margin - width));
    const below = view.bottom - rect.bottom - gap - margin;
    const above = rect.top - view.top - gap - margin;
    const placeAbove = below < 15 * rem && above > below;
    // Never taller than the visible space on the chosen side.
    const maxHeight = Math.max(6 * rem, Math.min(30 * rem, placeAbove ? above : below, view.bottom - view.top - margin * 2));
    Object.assign(dropdown.style, { left: `${left}px`, top: '0px', bottom: '', width: `${width}px`, maxHeight: `${maxHeight}px` });
    const height = dropdown.getBoundingClientRect().height;
    const wanted = placeAbove ? rect.top - gap - height : rect.bottom + gap;
    const top = Math.max(view.top + margin, Math.min(wanted, view.bottom - margin - height));
    dropdown.style.top = `${top}px`;
    // `position: fixed` is not always relative to the viewport (a transformed,
    // filtered or zoomed ancestor, or mobile browser chrome can shift it).
    // Measure where it really landed and correct by the difference.
    const placed = dropdown.getBoundingClientRect();
    const dx = left - placed.left;
    const dy = top - placed.top;
    if (Math.abs(dx) > 0.5) dropdown.style.left = `${left + dx}px`;
    if (Math.abs(dy) > 0.5) dropdown.style.top = `${top + dy}px`;
    dropdown.classList.toggle('is-above', placeAbove);
}

function scheduleModelPickerPosition(event) {
    // Scrolling the option list itself never moves the anchor.
    if (event?.type === 'scroll' && event.target instanceof Node && document.getElementById('quicker_api_model_dropdown')?.contains(event.target)) return;
    if (!modelPickerPositionFrame) modelPickerPositionFrame = requestAnimationFrame(positionModelPicker);
}

function bindModelPickerPosition() {
    window.addEventListener('resize', scheduleModelPickerPosition);
    globalThis.visualViewport?.addEventListener('resize', scheduleModelPickerPosition);
    document.addEventListener('scroll', scheduleModelPickerPosition, true);
}

function unbindModelPickerPosition() {
    window.removeEventListener('resize', scheduleModelPickerPosition);
    globalThis.visualViewport?.removeEventListener('resize', scheduleModelPickerPosition);
    document.removeEventListener('scroll', scheduleModelPickerPosition, true);
    if (modelPickerPositionFrame) cancelAnimationFrame(modelPickerPositionFrame);
    modelPickerPositionFrame = 0;
}

function openModelPicker({ query = '', focusSearch = true } = {}) {
    const picker = modelPickerElement();
    const dropdown = modelPickerDropdown();
    if (!picker.length || !dropdown.length) return;
    const wasOpen = picker.hasClass('is-open');
    picker.addClass('is-open');
    // .openDrawer.pinnedOpen keeps the host from treating clicks here as
    // "outside the drawer"; it only exists while the dropdown is open.
    let portal = $('#quicker_api_model_portal');
    if (!portal.length) portal = $('<div id="quicker_api_model_portal" class="quicker-api__model-portal openDrawer pinnedOpen">').appendTo(document.body);
    dropdown.appendTo(portal).prop('hidden', false);
    $('#quicker_api_model_trigger').attr('aria-expanded', 'true');
    positionModelPicker();
    if (!wasOpen) bindModelPickerPosition();
    const search = dropdown.find('.quicker-api__model-search-input').val(query);
    renderModelPickerOptions();
    // Avoid summoning the on-screen keyboard on touch devices.
    if (focusSearch && !globalThis.matchMedia?.('(pointer: coarse)').matches) search[0]?.focus({ preventScroll: true });
}

function closeModelPicker({ focusTrigger = false } = {}) {
    const picker = modelPickerElement();
    const dropdown = modelPickerDropdown();
    if (!picker.hasClass('is-open')) {
        // A stale portaled dropdown must never outlive its picker.
        if (!picker.length) $('#quicker_api_model_portal').remove();
        return;
    }
    unbindModelPickerPosition();
    picker.removeClass('is-open');
    dropdown.prop('hidden', true).appendTo(picker);
    $('#quicker_api_model_portal').remove();
    $('#quicker_api_model_trigger').attr('aria-expanded', 'false');
    if (focusTrigger) $('#quicker_api_model_trigger').trigger('focus');
}

function renderModelPickerOptions() {
    const picker = modelPickerDropdown();
    if (!picker.length) return;
    const data = modelPickerData();
    const view = modelPickerView;
    const query = normalizeText(picker.find('.quicker-api__model-search-input').val());
    picker.find('[data-model-view]').each((_, tab) => {
        const active = tab.dataset.modelView === view;
        $(tab).toggleClass('is-active', active).attr('aria-selected', String(active))
            .find('small').text(tab.dataset.modelView === 'favorites' ? data.favorites.length : data.all.length);
    });
    const favorites = new Set(data.favorites);
    const base = view === 'favorites' ? data.favorites : data.all;
    const entries = (data.current && !base.includes(data.current) ? [data.current, ...base] : base)
        .filter(model => matchesModelSearch(model, query));
    const list = picker.find('.quicker-api__model-options').empty();
    for (const model of entries) {
        const isFavorite = favorites.has(model);
        const selected = model === data.current;
        const stale = data.stale.has(model);
        const star = $('<button type="button" class="quicker-api__model-star" tabindex="-1">')
            .attr({ 'aria-pressed': String(isFavorite), 'aria-label': `${isFavorite ? '取消收藏' : '收藏'} ${model}`, title: isFavorite ? '取消收藏' : '收藏' })
            .prop('disabled', !data.profile)
            .append($('<i>').addClass(isFavorite ? 'fa-solid fa-star' : 'fa-regular fa-star'));
        const badges = $('<span class="quicker-api__model-option-badges">');
        if (stale) badges.append($('<i class="fa-solid fa-triangle-exclamation" title="云端最新列表中已不存在">'));
        if (selected && !base.includes(model)) badges.append($('<small>').text(view === 'favorites' && !isFavorite ? '当前·未收藏' : '当前'));
        if (selected) badges.append($('<i class="fa-solid fa-check" aria-hidden="true">'));
        list.append($('<div class="quicker-api__model-option" role="option">')
            .attr({ 'data-model': model, 'aria-selected': String(selected), title: stale ? `${model}（云端最新列表中已不存在）` : model })
            .toggleClass('is-favorite', isFavorite).toggleClass('is-selected', selected).toggleClass('is-stale', stale)
            .append(star, $('<span class="quicker-api__model-option-name">').text(model), badges));
    }
    if (query && data.profile && !favorites.has(query) && !data.all.includes(query) && query !== data.current) {
        list.append($('<div class="quicker-api__model-option quicker-api__model-add" role="option" aria-selected="false">')
            .attr('data-add-model', query)
            .append($('<i class="fa-solid fa-plus" aria-hidden="true">'), $('<span class="quicker-api__model-option-name">').text(`收藏并使用“${query}”`)));
    }
    if (!list.children().length) {
        const message = !data.profile ? '请先选择并保存 API 配置'
            : query ? '没有匹配的模型'
                : view === 'favorites' ? '收藏为空：在“全部”中点 ☆ 收藏，或输入模型 ID 添加'
                    : '尚未获取模型列表，点击下方“获取模型”';
        list.append($('<div class="quicker-api__empty-state">').text(message));
    }
    const fetchLabel = data.fetched.length ? '刷新列表' : '获取模型';
    picker.find('[data-model-picker-action="fetch"]').attr({ title: fetchLabel, 'aria-label': fetchLabel });
    const options = list.children('.quicker-api__model-option');
    const selectedIndex = options.toArray().findIndex(option => option.classList.contains('is-selected'));
    // Content height changed: re-place it (an upward list must stay anchored to the trigger).
    positionModelPicker();
    setModelPickerActive(selectedIndex >= 0 && !query ? selectedIndex : 0, { scroll: true });
}

function setModelPickerActive(index, { scroll = true } = {}) {
    const options = modelPickerDropdown().find('.quicker-api__model-option');
    options.removeClass('is-active');
    if (!options.length) return;
    const active = options.eq(Math.max(0, Math.min(index, options.length - 1))).addClass('is-active');
    if (scroll) active[0]?.scrollIntoView?.({ block: 'nearest' });
}

function moveModelPickerActive(step) {
    const options = modelPickerDropdown().find('.quicker-api__model-option');
    if (!options.length) return;
    const last = options.length - 1;
    const index = Math.max(0, options.toArray().findIndex(option => option.classList.contains('is-active')));
    const next = index + step;
    // Moving past an edge clamps to the edge first, then wraps around.
    setModelPickerActive(next > last ? (index === last ? 0 : last) : next < 0 ? (index === 0 ? last : 0) : next);
}

function activateModelPickerOption(option) {
    const row = $(option);
    const added = row.attr('data-add-model');
    if (added !== undefined) {
        if (!modelPickerProfile) return;
        closeModelPicker({ focusTrigger: true });
        return favoriteAndUseModel(modelPickerProfile, added);
    }
    const model = row.attr('data-model');
    if (model === undefined) return;
    $('#quicker_api_custom_model').val(model).trigger('change');
    closeModelPicker({ focusTrigger: true });
}

function toggleFavoriteModel(model) {
    const profile = modelPickerProfile;
    if (!profile || !hasManagedModels(profile.format)) return toastr.info('请先选择并保存 API 配置。');
    const favorites = normalizeModelList(profile.availableModels);
    profile.availableModels = favorites.includes(model) ? favorites.filter(item => item !== model) : [...favorites, model];
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    const index = modelPickerDropdown().find('.quicker-api__model-option').toArray().findIndex(option => option.getAttribute('data-model') === model);
    renderModelPickerOptions();
    if (index >= 0) setModelPickerActive(index, { scroll: false });
    updateModelTrigger();
}

function switchModelPickerView(view) {
    modelPickerView = view === 'all' ? 'all' : 'favorites';
    renderModelPickerOptions();
    const data = modelPickerData();
    const profile = data.profile;
    if (modelPickerView !== 'all' || data.fetched.length || !profile || profile !== selectedProfile()) return;
    // First visit to an empty full list: fetch once per profile/endpoint per session.
    const key = `${profile.id}\n${profile.endpoint}`;
    if (modelPickerAutoFetched.has(key)) return;
    modelPickerAutoFetched.add(key);
    void enqueueOperation(fetchCustomModels);
}

function bindModelPickerEvents() {
    $(document).on('click.quickerApi', '#quicker_api_model_trigger', () => {
        if (modelPickerElement().hasClass('is-open')) closeModelPicker();
        else openModelPicker();
    });
    $(document).on('keydown.quickerApi', '#quicker_api_model_trigger', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openModelPicker();
        }
    });
    $(document).on('click.quickerApi', '#quicker_api_model_dropdown [data-model-view]', function () {
        switchModelPickerView(this.dataset.modelView);
    });
    $(document).on('input.quickerApi', '.quicker-api__model-search-input', renderModelPickerOptions);
    $(document).on('keydown.quickerApi', '.quicker-api__model-picker, #quicker_api_model_dropdown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeModelPicker({ focusTrigger: true });
            return;
        }
        if (!$(event.target).is('.quicker-api__model-search-input')) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveModelPickerActive((event.key === 'ArrowDown' ? 1 : -1) * modelPickerColumns);
        } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.target.value) {
            // With an empty search box there is no caret to move: walk the grid.
            event.preventDefault();
            moveModelPickerActive(event.key === 'ArrowRight' ? 1 : -1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            const active = modelPickerDropdown().find('.quicker-api__model-option.is-active');
            if (active.length) activateModelPickerOption(active[0]);
        }
    });
    $(document).on('click.quickerApi', '.quicker-api__model-star', function (event) {
        event.stopPropagation();
        toggleFavoriteModel($(this).closest('.quicker-api__model-option').attr('data-model'));
    });
    $(document).on('click.quickerApi', '.quicker-api__model-option', function () {
        activateModelPickerOption(this);
    });
    $(document).on('click.quickerApi', '[data-model-picker-action]', function () {
        const query = normalizeText(modelPickerDropdown().find('.quicker-api__model-search-input').val());
        if (this.dataset.modelPickerAction === 'add') {
            closeModelPicker();
            void addCustomModel(query || '');
        } else if (this.dataset.modelPickerAction === 'layout') {
            cycleModelPickerLayout();
            setModelPickerActive(modelPickerDropdown().find('.quicker-api__model-option.is-active').index(), { scroll: true });
        } else {
            void enqueueOperation(fetchCustomModels);
        }
    });
    $(document).on('pointerdown.quickerApi', event => {
        const picker = modelPickerElement();
        if (picker.hasClass('is-open') && !picker[0].contains(event.target) && !modelPickerDropdown()[0]?.contains(event.target)) closeModelPicker();
    });
}

function renderProfileEditor(profile = selectedProfile(), modelOverride = null) {
    const format = profile?.format || normalizeFormat($('#quicker_api_format').val());
    $('#quicker_api_format').val(format);
    $('#quicker_api_url').val(profile?.endpoint ?? nativeEndpoint(format));
    renderOpenCodeFields(profile, format);
    renderModelControl(profile, modelOverride);
    editorModelBaseline = getEditorModel(format);
}

function renderProfiles(preferredId = null) {
    const select = $('#quicker_api_profile_select').empty().append($('<option>').val('').text('— 选择 API Profile —'));
    for (const profile of [...profiles()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!isFormatSupported(profile.format) && !$('#quicker_api_format option').toArray().some(option => option.value === profile.format)) {
            $('#quicker_api_format').append($('<option disabled>').val(profile.format).text(`${FORMATS[profile.format].label}（当前宿主不支持）`));
        }
        select.append($('<option>').val(profile.id).text(`[${FORMATS[profile.format].label}] ${profile.name}`));
    }
    const selectedId = preferredId ?? settings().selectedProfileId ?? '';
    select.val(profiles().some(profile => profile.id === selectedId) ? selectedId : '');
    const profile = selectedProfile();
    if (profile) $('#quicker_api_format').val(profile.format);
    const activeModel = profile && settings().activeProfileId === profile.id
        && matchesFormat(profile.format)
        ? String(oai_settings[FORMATS[profile.format].modelField] || '') : null;
    renderProfileEditor(profile, activeModel);
    updateCredentialEditor(profile);
    renderStatus();
}

function profileMatchesNative(profile, { includeModel = true } = {}) {
    const config = FORMATS[profile.format];
    if (!matchesFormat(profile.format)) return false;
    if (includeModel && String(oai_settings[config.modelField] || '') !== profile.model) return false;
    if (nativeEndpoint(profile.format) !== profile.endpoint) return false;
    if (profile.format === 'opencode' && oai_settings.opencode_api_format !== profile.opencodeApiFormat) return false;
    if (usesProxyProfile(profile.format, profile.endpoint)) {
        const proxyPreset = getBoundProxyPreset(profile);
        if (!proxyPreset || String(oai_settings.proxy_password || '') !== String(proxyPreset.password || '')) return false;
    }
    const additional = nativeAdditionalParameters();
    if (additional.excludeBody !== profile.excludeBody) return false;
    return !supportsCustomParameters(profile.format)
        || (additional.includeBody === profile.includeBody
            && additional.includeHeaders === profile.includeHeaders);
}

function getBlockedSecretMessage(key) {
    return String(settings().blockedSecretKeys[key] || '');
}

function editorHasUnsavedChanges(profile) {
    if (!profile) return false;
    const additional = nativeAdditionalParameters();
    return normalizeFormat($('#quicker_api_format').val()) !== profile.format
        || normalizeText($('#quicker_api_url').val()) !== normalizeText(profile.endpoint)
        || (profile.format === 'opencode' && $('#quicker_api_opencode_format').val() !== profile.opencodeApiFormat)
        || getEditorModel() !== editorModelBaseline
        || additional.excludeBody !== profile.excludeBody
        || (supportsCustomParameters(profile.format) && (additional.includeBody !== profile.includeBody
            || additional.includeHeaders !== profile.includeHeaders))
        || (keyEditorDirty && Boolean(normalizeText($('#quicker_api_key_input').val())));
}

function renderStatus(extraMessage = '') {
    renderPanelSummary();
    const profile = selectedProfile();
    const presetName = currentPresetName();
    if (profile) {
        if (!isFormatSupported(profile.format)) return setStatus('当前宿主不支持该格式；配置已保留但不能应用。', 'warning');
        const proxyMode = usesProxyProfile(profile.format, profile.endpoint);
        const blockedMessage = proxyMode ? '' : getBlockedSecretMessage(FORMATS[profile.format].secretKey);
        if (blockedMessage) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
        if (settings().activeProfileId !== profile.id) return setStatus(extraMessage || '所选 Profile 未应用。', 'warning');
        if (editorHasUnsavedChanges(profile)) return setStatus('当前修改尚未保存。', 'warning');
        if (!profileMatchesNative(profile, { includeModel: false })
            || (!proxyMode && getActiveSecret(FORMATS[profile.format].secretKey)?.id !== profile.secretId)) {
            return setStatus('原生连接与所选 Profile 不一致，请重新应用。', 'warning');
        }
        if (presetName && settings().presetBindings[presetName] !== profile.id) return setStatus('当前 preset 未绑定到所选 Profile。', 'warning');
        if (!profileHasCredential(profile, profile.format, profile.endpoint)) return setStatus('当前 Profile 凭据为空。', 'warning');
        return setStatus('已保存并安全应用。');
    }
    if (Object.keys(settings().blockedSecretKeys).length) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
    if (presetName && !settings().presetBindings[presetName]) return setStatus('当前 preset 未绑定。', 'warning');
    setStatus(extraMessage || '所选 Profile 未应用。', 'warning');
}

function setOperationControlsDisabled(disabled) {
    $('#quicker_api select, #quicker_api button:not(#quicker_api_toggle)').prop('disabled', disabled);
}

function setCredentialSafetyBlock(secretKey, message) {
    settings().blockedSecretKeys[secretKey] = message || `${secretKey} 密钥状态无法确认；使用该官方来源时生成请求将被阻断。`;
    settings().activeProfileId = null;
    scheduleSettingsSave();
    renderProfiles(settings().selectedProfileId);
}

function clearCredentialSafetyBlock(secretKey) {
    if (!settings().blockedSecretKeys[secretKey]) return;
    delete settings().blockedSecretKeys[secretKey];
    scheduleSettingsSave();
}

function beginPresetTransition() {
    if (!presetTransitionBlocked) presetConnectWasDisabled = Boolean($('#api_button_openai').prop('disabled'));
    presetTransitionBlocked = true;
    $('#api_button_openai').prop('disabled', true);
}

function endPresetTransition({ force = false } = {}) {
    if (teardownPending && !force) return;
    if (!presetTransitionBlocked) return;
    presetTransitionBlocked = false;
    $('#api_button_openai').prop('disabled', presetConnectWasDisabled);
}

function requestMatchesProfile(profile, generateData) {
    if (!profile || !matchesFormat(profile.format, generateData)) return false;
    if (String(generateData.model || '') !== profile.model) return false;
    const endpointField = FORMATS[profile.format].endpointField;
    if (profile.format === 'opencode' && generateData.opencode_api_format !== profile.opencodeApiFormat) return false;
    return normalizeText(generateData[endpointField]) === normalizeText(profile.endpoint);
}

function excludeProfileBodyParameters(profile, generateData) {
    if (platform.handlesRequestExclusions || !profile?.excludeBody || !requestMatchesProfile(profile, generateData)) return;
    try {
        const parsed = yaml.parse(profile.excludeBody);
        const keys = Array.isArray(parsed)
            ? parsed
            : (parsed && typeof parsed === 'object' ? Object.keys(parsed) : [parsed]);
        for (const key of keys) {
            if (typeof key === 'string' && key) delete generateData[key];
        }
    } catch (error) {
        console.warn('[QuickerApi] Invalid exclude-body YAML; request was left unchanged:', error);
    }
}

function guardGenerationWhenBlocked(generateData) {
    if (extensionDisabled || !generateData || typeof generateData !== 'object') return;
    if (presetTransitionBlocked) {
        generateData.chat_completion_source = 'quicker_api_preset_transition';
        generateData.custom_url = '';
        generateData.reverse_proxy = '';
        toastr.error('Quicker Api 正在安全切换预设凭据，本次生成已阻断。');
        return;
    }
    const format = Object.values(FORMATS).find(config => config.source === generateData.chat_completion_source);
    if (!format) return;
    const usesProxyCredential = [chat_completion_sources.CLAUDE, chat_completion_sources.MAKERSUITE].includes(format.source) && Boolean(generateData.reverse_proxy);
    const blockedMessage = settings().blockedSecretKeys[format.secretKey];
    if (!usesProxyCredential && blockedMessage) {
        generateData.chat_completion_source = 'quicker_api_safety_blocked';
        generateData.custom_url = '';
        generateData.reverse_proxy = '';
        toastr.error(blockedMessage);
        return;
    }
    const profile = profiles().find(item => item.id === settings().activeProfileId) || null;
    excludeProfileBodyParameters(profile, generateData);
}

function enqueueOperation(operation) {
    pendingOperations++;
    const run = async () => {
        if (extensionDisabled || teardownPending) return;
        const presetWasDisabled = Boolean($('#settings_preset_openai').prop('disabled'));
        setOperationControlsDisabled(true);
        $('#settings_preset_openai').prop('disabled', true);
        try {
            return await operation();
        } catch (error) {
            console.error('[QuickerApi] Operation failed:', error);
            toastr.error('Quicker Api 操作失败；未确认的连接不会被启用。');
            renderProfiles(settings().selectedProfileId);
        } finally {
            if (!extensionDisabled) setOperationControlsDisabled(false);
            $('#settings_preset_openai').prop('disabled', presetWasDisabled);
        }
    };
    operationQueue = operationQueue.then(run, run).finally(() => { pendingOperations--; });
    return operationQueue;
}

async function readAuthoritativeSecretState() {
    try {
        const { response, data: state } = await fetchJsonWithTimeout('/api/secrets/read', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        }, 15000);
        if (!response.ok) return null;
        if (!state || typeof state !== 'object') return null;
        for (const config of Object.values(FORMATS)) {
            secret_state[config.secretKey] = Array.isArray(state[config.secretKey]) ? state[config.secretKey] : [];
        }
        return state;
    } catch (error) {
        console.error('[QuickerApi] Authoritative secret read failed:', error);
        return null;
    }
}

async function writeSecretVerified(key, value, label) {
    try {
        const { response, data } = await fetchJsonWithTimeout('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key, value, label }),
        }, 15000);
        if (!response.ok) return '';
        const id = normalizeText(data?.id);
        const state = id ? await readAuthoritativeSecretState() : null;
        if (!id || !state?.[key]?.some(entry => entry.id === id && entry.active)) return '';
        const input = Object.values(FORMATS).find(config => config.secretKey === key)?.keyInput;
        if (input) $(input).val('').trigger('input');
        void eventSource.emit(event_types.SECRET_WRITTEN, key).catch(error =>
            console.warn('[QuickerApi] SECRET_WRITTEN listener failed:', error));
        return id;
    } catch (error) {
        console.error('[QuickerApi] Secret write failed:', error);
        return '';
    }
}

async function rotateSecretVerified(key, id) {
    if (!id) return false;
    try {
        const response = await fetchWithTimeout('/api/secrets/rotate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key, id }),
        }, 15000);
        if (!response.ok) return false;
        const state = await readAuthoritativeSecretState();
        return Boolean(state && Array.isArray(state[key]) && state[key].some(entry => entry.id === id && entry.active));
    } catch (error) {
        console.error('[QuickerApi] Secret rotation failed:', error);
        return false;
    }
}

async function ensureEmptySecret(key) {
    const storedId = String(settings().emptySecretIds[key] || '');
    if (storedId && await rotateSecretVerified(key, storedId)) return storedId;
    const id = await writeSecretVerified(key, '', EMPTY_SECRET_LABEL);
    const state = id ? await readAuthoritativeSecretState() : null;
    if (id && state?.[key]?.some(entry => entry.id === id && entry.active)) {
        settings().emptySecretIds[key] = id;
        scheduleSettingsSave();
        return id;
    }
    return '';
}

function snapshotNative() {
    return {
        custom_url: String(oai_settings.custom_url || ''),
        custom_model: String(oai_settings.custom_model || ''),
        connection: platform.snapshotConnectionState(),
        reverse_proxy: String(oai_settings.reverse_proxy || ''),
        claude_model: String(oai_settings.claude_model || ''),
        google_model: String(oai_settings.google_model || ''),
        proxy_password: String(oai_settings.proxy_password || ''),
    };
}

function restoreNative(snapshot) {
    oai_settings.custom_url = snapshot.custom_url;
    oai_settings.custom_model = snapshot.custom_model;
    oai_settings.reverse_proxy = snapshot.reverse_proxy;
    oai_settings.claude_model = snapshot.claude_model;
    oai_settings.google_model = snapshot.google_model;
    oai_settings.proxy_password = snapshot.proxy_password;
    $('#custom_api_url_text').val(snapshot.custom_url).trigger('input');
    $('#custom_model_id').val(snapshot.custom_model).trigger('input');
    $('#openai_reverse_proxy').val(snapshot.reverse_proxy).trigger('input');
    $('#openai_proxy_password').val(snapshot.proxy_password).trigger('input');
    $('#model_claude_select').val(snapshot.claude_model).trigger('change');
    $('#model_google_select').val(snapshot.google_model).trigger('change');
    platform.restoreConnectionState(snapshot.connection);
}

async function enterFailClosedState(message, affectedSecretKey = SECRET_KEYS.CUSTOM) {
    const safeId = await ensureEmptySecret(affectedSecretKey);
    if (affectedSecretKey === SECRET_KEYS.CUSTOM) {
        oai_settings.custom_url = '';
        oai_settings.custom_model = '';
        $('#custom_api_url_text').val('').trigger('input');
        $('#custom_model_id').val('').trigger('input');
        platform.selectSource(chat_completion_sources.CUSTOM);
    }
    settings().activeProfileId = null;
    if (safeId) {
        delete settings().blockedSecretKeys[affectedSecretKey];
    } else {
        settings().blockedSecretKeys[affectedSecretKey] = `${message} ${affectedSecretKey} 密钥槽状态无法确认，生成已阻断。`;
    }
    scheduleSettingsSave();
    renderProfiles();
    toastr.error(`${message} ${safeId ? '受影响密钥槽已切换至安全空密钥。' : '无法确认安全空密钥，使用该槽的生成已阻断。'}`);
}

async function rollbackCredentialOrFailClosed(config, previousSecretId, message) {
    if (previousSecretId && await rotateSecretVerified(config.secretKey, previousSecretId)) return true;
    await enterFailClosedState(message, config.secretKey);
    return false;
}

async function rollbackStaleCredential(config, previousSecretId, message) {
    if (previousSecretId && await rotateSecretVerified(config.secretKey, previousSecretId)) return true;
    const safeId = await ensureEmptySecret(config.secretKey);
    if (safeId) {
        toastr.warning('旧 Profile 已取消，但原密钥无法恢复；对应密钥槽已切换到安全空密钥。');
        return false;
    }
    setCredentialSafetyBlock(config.secretKey, message);
    return false;
}

async function rollbackOrFailClosed(config, previousSecretId, nativeSnapshot, message) {
    restoreNative(nativeSnapshot);
    return await rollbackCredentialOrFailClosed(config, previousSecretId, message);
}

function applyNativeFields(profile, proxyPassword = '', applyModel = true) {
    const config = FORMATS[profile.format];
    if (profile.format === 'opencode') {
        validateOpenCodeConnection(profile.endpoint, profile.opencodeApiFormat);
        oai_settings.opencode_api_format = profile.opencodeApiFormat;
        $('#opencode_api_format').val(profile.opencodeApiFormat).trigger('input');
    }
    oai_settings[config.endpointField] = profile.endpoint;
    $(config.endpointInput).val(profile.endpoint).trigger('input');
    if (applyModel) {
        oai_settings[config.modelField] = profile.model;
        if (profile.model) {
            if (!applyExplicitModel(profile.model, profile.format)) throw new Error('无法应用 Profile 模型，请检查模型 ID。');
        } else {
            $(config.modelInput).val('').trigger(isCustomFormat(profile.format) ? 'input' : 'change');
        }
    }
    applyNativeAdditionalParameters(profile);
    if (profile.format === 'anthropic' || profile.format === 'gemini') {
        oai_settings.proxy_password = proxyPassword;
        $('#openai_proxy_password').val(proxyPassword).trigger('input');
    }
    platform.selectSource(config.source, config.apiFormat);
}

function getBoundProxyPreset(profile) {
    if (!profile?.proxyPreset) return null;
    return proxies.find(proxy => proxy.name === profile.proxyPreset) || null;
}

function ensureProxyPresetOption(name) {
    if (!$('#openai_proxy_preset option').filter((_, option) => option.value === name).length) {
        $('#openai_proxy_preset').append($('<option>').val(name).text(name));
    }
}

function proxyPresetIsShared(name, ownerProfileId) {
    const usedByOtherQuickerProfile = profiles().some(profile => profile.id !== ownerProfileId && profile.proxyPreset === name);
    const usedByConnectionManager = Array.isArray(extension_settings?.connectionManager?.profiles)
        && extension_settings.connectionManager.profiles.some(profile => profile?.proxy === name);
    return usedByOtherQuickerProfile || usedByConnectionManager;
}

function ensureBoundProxyPreset(profileName, endpoint, password, existingName = '', ownerProfileId = '') {
    if (!endpoint) return '';
    const existing = existingName ? proxies.find(proxy => proxy.name === existingName) : null;
    const canUpdateExisting = existing
        && existing.name.startsWith('Quicker · ')
        && !proxyPresetIsShared(existing.name, ownerProfileId);
    if (canUpdateExisting) {
        existing.url = endpoint;
        existing.password = password;
        ensureProxyPresetOption(existing.name);
        return existing.name;
    }
    const base = `Quicker · ${sanitizeName(profileName) || 'Proxy'}`;
    let name = base;
    let index = 2;
    while (proxies.some(proxy => proxy.name === name)) name = `${base} (${index++})`;
    proxies.push({ name, url: endpoint, password });
    ensureProxyPresetOption(name);
    return name;
}

async function applyProfile(profile, expectedGeneration = profileSelectionGeneration, keepPresetTransition = false, applyModel = true) {
    if (!profile || extensionDisabled || expectedGeneration !== profileSelectionGeneration) return false;
    if (profile.format === 'opencode') {
        if (!platform.supportsOpenCode) { toastr.warning('当前宿主不支持原生 OpenCode；配置已保留但不能应用。'); return false; }
        validateOpenCodeConnection(profile.endpoint, profile.opencodeApiFormat);
    }
    if (!isFormatSupported(profile.format)) { toastr.warning('当前宿主不支持该格式；配置已保留但不能应用。'); return false; }
    const config = FORMATS[profile.format];
    const previousSelection = settings().activeProfileId;
    const nativeSnapshot = snapshotNative();
    const proxyMode = usesProxyProfile(profile.format, profile.endpoint);
    if (proxyMode) {
        const proxyPreset = getBoundProxyPreset(profile);
        if (!proxyPreset || normalizeText(proxyPreset.url) !== normalizeText(profile.endpoint)) {
            toastr.error(`${config.label} 反代 Profile 缺少匹配的原生 Reverse Proxy Preset，请重新保存该 Profile。`);
            renderProfiles(settings().selectedProfileId);
            return false;
        }
        try {
            applyNativeFields(profile, String(proxyPreset.password || ''), applyModel);
            if ($('#openai_proxy_preset option').filter((_, option) => option.value === proxyPreset.name).length) {
                $('#openai_proxy_preset').val(proxyPreset.name).trigger('change');
            }
            if (extensionDisabled) throw new Error('Extension disabled while applying proxy profile');
            settings().activeProfileId = profile.id;
            if (!keepPresetTransition) endPresetTransition();
            scheduleSettingsSave();
            renderProfiles(profile.id);
            if (!applyModel) {
                renderModelControl(profile, String(oai_settings[config.modelField] || ''));
                editorModelBaseline = getEditorModel(profile.format);
            }
            return true;
        } catch (error) {
            console.error('[QuickerApi] Proxy field application failed:', error);
            restoreNative(nativeSnapshot);
            settings().activeProfileId = previousSelection;
            scheduleSettingsSave();
            renderProfiles(settings().selectedProfileId);
            return false;
        }
    }

    const authoritative = await readAuthoritativeSecretState();
    if (expectedGeneration !== profileSelectionGeneration || extensionDisabled) return false;
    if (!authoritative) {
        toastr.error('无法通过 /api/secrets/read 验证密钥状态，已取消切换。');
        renderProfiles(settings().selectedProfileId);
        return false;
    }
    const previousSecretId = authoritative[config.secretKey]?.find(entry => entry.active)?.id || '';
    let targetSecretId = profile.secretId;
    if (!targetSecretId || !authoritative[config.secretKey]?.some(entry => entry.id === targetSecretId)) {
        const expectedSecret = Boolean(profile.needsSecret || targetSecretId);
        targetSecretId = await ensureEmptySecret(config.secretKey);
        if (expectedGeneration !== profileSelectionGeneration || extensionDisabled) {
            await rollbackStaleCredential(config, previousSecretId, 'Profile 已被新的原生预设取消，但密钥状态无法确认；生成请求已阻断。');
            return false;
        }
        if (!targetSecretId) {
            await rollbackOrFailClosed(config, previousSecretId, nativeSnapshot, '无法建立目标格式的安全空密钥。');
            renderProfiles(settings().selectedProfileId);
            return false;
        }
        profile.secretId = targetSecretId;
        profile.needsSecret = expectedSecret;
        if (expectedSecret) toastr.warning('原绑定密钥不存在，已改用安全空密钥；请重新绑定后再连接。');
    } else {
        const activated = await rotateSecretVerified(config.secretKey, targetSecretId);
        if (expectedGeneration !== profileSelectionGeneration || extensionDisabled) {
            await rollbackStaleCredential(config, previousSecretId, 'Profile 已被新的原生预设取消，但密钥状态无法确认；生成请求已阻断。');
            return false;
        }
        if (!activated) {
            await rollbackOrFailClosed(config, previousSecretId, nativeSnapshot, '目标密钥激活无法确认且回滚失败。');
            renderProfiles(settings().selectedProfileId);
            return false;
        }
    }

    if (getActiveSecret(config.secretKey)?.id !== targetSecretId) {
        await rollbackOrFailClosed(config, previousSecretId, nativeSnapshot, '密钥权威状态不一致且回滚失败。');
        renderProfiles(settings().selectedProfileId);
        return false;
    }

    try {
        applyNativeFields(profile, '', applyModel);
        if (extensionDisabled) throw new Error('Extension disabled while applying profile');
        clearCredentialSafetyBlock(config.secretKey);
        settings().activeProfileId = profile.id;
        if (!keepPresetTransition) endPresetTransition();
        scheduleSettingsSave();
        renderProfiles(profile.id);
        if (!applyModel) {
            renderModelControl(profile, String(oai_settings[config.modelField] || ''));
            editorModelBaseline = getEditorModel(profile.format);
        }
        return true;
    } catch (error) {
        console.error('[QuickerApi] Native field application failed:', error);
        await rollbackOrFailClosed(config, previousSecretId, nativeSnapshot, '原生字段应用失败且回滚密钥失败。');
        renderProfiles(settings().selectedProfileId);
        return false;
    }
}

function captureNativeProfile(name, format, existing = {}, connection = {}) {
    const normalizedFormat = normalizeFormat(format);
    const config = FORMATS[normalizedFormat];
    const additional = nativeAdditionalParameters(isCustomFormat(normalizedFormat) ? platform.customSelection(config.apiFormat) : config.source);
    const endpoint = connection.endpoint ?? nativeEndpoint(normalizedFormat);
    const proxyMode = usesProxyProfile(normalizedFormat, endpoint);
    const activeSecret = getActiveSecret(config.secretKey);
    const retainedSecretId = existing.format === normalizedFormat ? String(existing.secretId || '') : '';
    const secretId = proxyMode ? '' : (retainedSecretId || activeSecret?.id || '');
    const needsSecret = !proxyMode && (!secretId || secretId === settings().emptySecretIds[config.secretKey]);
    const profileName = name || existing.name;
    const profileId = existing.id || makeId();
    const proxyPreset = proxyMode
        ? ensureBoundProxyPreset(profileName, endpoint, String(connection.proxyPassword ?? oai_settings.proxy_password ?? ''), existing.proxyPreset, profileId)
        : '';
    return normalizeProfile({
        ...existing,
        id: profileId,
        name: uniqueName(profileName, existing.id),
        format: normalizedFormat,
        opencodeApiFormat: normalizedFormat === 'opencode' ? (connection.opencodeApiFormat ?? oai_settings.opencode_api_format) : '',
        endpoint,
        model: getEditorModel(normalizedFormat),
        includeBody: supportsCustomParameters(normalizedFormat) ? additional.includeBody : '',
        excludeBody: additional.excludeBody,
        includeHeaders: supportsCustomParameters(normalizedFormat) ? additional.includeHeaders : '',
        secretId,
        proxyPreset,
        needsSecret,
        updatedAt: new Date().toISOString(),
    });
}

async function callQuickerPopup(content, type, inputValue = '', popupOptions = {}) {
    if (extensionDisabled || teardownPending) return type === POPUP_TYPE.INPUT ? null : false;
    const popup = new Popup(content, type, inputValue, popupOptions);
    ownedPopups.add(popup);
    try {
        return await popup.show();
    } finally {
        ownedPopups.delete(popup);
    }
}

async function cancelOwnedPopups() {
    const popups = [...ownedPopups];
    await Promise.allSettled(popups.map(popup => popup.completeCancelled()));
}

async function promptName(message, initialValue = '') {
    const result = await callQuickerPopup(message, POPUP_TYPE.INPUT, initialValue);
    if (result === null || result === false || result === undefined) return null;
    return sanitizeName(result) || null;
}

function isValidQuickUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function closeQuickUrlMenu() {
    quickUrlPortal?.remove();
    quickUrlPortal = null;
    quickUrlMenu = null;
    $('#quicker_api_quick_url').attr('aria-expanded', 'false');
    $(document).off('.quickerApiQuickUrl');
    $(window).off('.quickerApiQuickUrl');
    $(globalThis.visualViewport).off('.quickerApiQuickUrl');
}

function positionQuickUrlMenu() {
    if (!quickUrlMenu?.length) return;
    const button = document.getElementById('quicker_api_quick_url');
    if (!button) return closeQuickUrlMenu();
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = globalThis.visualViewport?.width || window.innerWidth;
    const viewportHeight = globalThis.visualViewport?.height || window.innerHeight;
    const menuWidth = Math.min(Math.max(rect.width, 300), viewportWidth - margin * 2);
    quickUrlMenu.css({ width: `${menuWidth}px`, left: '0px', top: '0px' });
    const menuHeight = quickUrlMenu.outerHeight();
    const left = Math.min(Math.max(margin, rect.right - menuWidth), viewportWidth - menuWidth - margin);
    const fitsBelow = rect.bottom + menuHeight + margin <= viewportHeight;
    const top = fitsBelow ? rect.bottom + 4 : Math.max(margin, rect.top - menuHeight - 4);
    quickUrlMenu.css({ left: `${left}px`, top: `${top}px` });
}

function fillQuickUrl(url) {
    const input = $('#quicker_api_url').val(url).trigger('input');
    closeQuickUrlMenu();
    const mobilePointer = globalThis.matchMedia?.('(max-width: 760px) and (pointer: coarse)').matches;
    if (mobilePointer) input.trigger('blur');
    else input.trigger('focus');
}

async function addCustomQuickUrl() {
    closeQuickUrlMenu();
    const content = $('<div class="quicker-api__quick-url-editor">').append(
        $('<label>').append(
            $('<span>').text('简称'),
            $('<input class="text_pole" type="text" autocomplete="off" maxlength="120" placeholder="例如：我的反代">'),
        ),
        $('<label>').append(
            $('<span>').text('URL'),
            $('<input class="text_pole" type="url" autocomplete="off" maxlength="2048" placeholder="https://example.com/v1">'),
        ),
    );
    const confirmed = await callQuickerPopup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: '添加', cancelButton: '取消', animation: 'none',
    });
    if (!confirmed) return;
    const [nameInput, urlInput] = content.find('input').get();
    const name = sanitizeName(nameInput?.value);
    const url = normalizeText(urlInput?.value).slice(0, 2048);
    if (!name) return toastr.warning('快捷 URL 简称不能为空。');
    if (!isValidQuickUrl(url)) return toastr.warning('请输入有效的 http:// 或 https:// URL。');
    if (settings().quickUrls.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return toastr.warning('已存在同名的自定义快捷 URL。');
    }
    settings().quickUrls.push(normalizeQuickUrl({ id: makeId('quick-url'), name, url }));
    scheduleSettingsSave();
    toastr.success(`已添加快捷 URL：${name}`);
}

function quickUrlItem(item, custom = false) {
    const row = $('<div class="quicker-api__quick-url-item" role="none">');
    const select = $('<button class="quicker-api__quick-url-select" type="button" role="menuitem">')
        .attr('title', item.url)
        .append($('<strong>').text(item.name), $('<small>').text(item.url))
        .on('click', () => fillQuickUrl(item.url));
    row.append(select);
    if (custom) {
        row.append($('<button class="quicker-api__quick-url-delete" type="button" aria-label="删除自定义快捷 URL" title="删除">')
            .append('<i class="fa-solid fa-trash"></i>')
            .on('click', event => {
                event.stopPropagation();
                settings().quickUrls = settings().quickUrls.filter(candidate => candidate.id !== item.id);
                scheduleSettingsSave();
                openQuickUrlMenu();
            }));
    }
    return row;
}

function openQuickUrlMenu() {
    closeQuickUrlMenu();
    const menu = $('<div class="quicker-api__quick-url-menu" role="menu" aria-label="快捷 URL">');
    menu.append($('<div class="quicker-api__quick-url-heading">').text('SillyTavern 原生服务端点'));
    BUILTIN_QUICK_URLS.forEach(item => menu.append(quickUrlItem(item)));
    if (settings().quickUrls.length) {
        menu.append($('<div class="quicker-api__quick-url-heading">').text('自定义'));
        settings().quickUrls.forEach(item => menu.append(quickUrlItem(item, true)));
    }
    menu.append($('<button class="quicker-api__quick-url-add" type="button" role="menuitem">')
        .append('<i class="fa-solid fa-plus"></i>', $('<span>').text('添加快捷 URL'))
        .on('click', () => void addCustomQuickUrl()));
    menu.on('touchstart touchend pointerdown pointerup mousedown mouseup click', event => {
        event.stopPropagation();
        if (event.type === 'mousedown') event.preventDefault();
    });
    quickUrlPortal = $('<div class="quicker-api__quick-url-portal openDrawer pinnedOpen">').appendTo(document.body);
    quickUrlMenu = menu.appendTo(quickUrlPortal);
    $('#quicker_api_quick_url').attr('aria-expanded', 'true');
    positionQuickUrlMenu();
    $(document)
        .on('pointerdown.quickerApiQuickUrl', event => {
            if (!$(event.target).closest('.quicker-api__quick-url-menu, #quicker_api_quick_url').length) closeQuickUrlMenu();
        })
        .on('keydown.quickerApiQuickUrl', event => {
            if (event.key === 'Escape') {
                closeQuickUrlMenu();
                $('#quicker_api_quick_url').trigger('focus');
            }
        });
    $(window).on('resize.quickerApiQuickUrl scroll.quickerApiQuickUrl', positionQuickUrlMenu);
    $(globalThis.visualViewport).on('resize.quickerApiQuickUrl scroll.quickerApiQuickUrl', positionQuickUrlMenu);
}

function toggleQuickUrlMenu() {
    if (quickUrlMenu) closeQuickUrlMenu();
    else openQuickUrlMenu();
}

function createProfile() {
    clearKeyEditor();
    settings().selectedProfileId = null;
    scheduleSettingsSave();
    const select = $('#quicker_api_profile_select');
    select.find('option[value=""]').text('— 新建 API 配置（未保存） —');
    select.val('');
    renderProfileEditor(null);
    updateCredentialEditor(null);
    setStatus('正在新建 API 配置；填写后请点击“保存 API 配置”。', 'warning');
    toastr.info('已进入新建模式；填写连接信息后点击“保存 API 配置”即可创建 Profile。');
    $('#quicker_api_url').trigger('focus');
}

function importIdentity(format, endpoint, credentialIdentity, apiFormat = '') {
    const protocol = format === 'opencode' ? `|${apiFormat || 'openai_compat'}` : '';
    return `${format}${protocol}|${normalizeText(endpoint).toLocaleLowerCase()}|${credentialIdentity}`;
}

function nativeImportFingerprint(candidate, format, endpoint) {
    const sourceRef = normalizeText(candidate.sourceRef || candidate.sourceLabel).toLocaleLowerCase();
    const credentialRef = candidate.sourceSecretKey && candidate.sourceSecretId
        ? `secret:${candidate.sourceSecretKey}:${candidate.sourceSecretId}`
        : (candidate.proxyPreset ? `proxy:${normalizeText(candidate.proxyPreset).toLocaleLowerCase()}` : 'no-source-credential');
    const protocol = format === 'opencode' ? `|${candidate.opencodeApiFormat || 'openai_compat'}` : '';
    return `${sourceRef}|${format}${protocol}|${normalizeText(endpoint).toLocaleLowerCase()}|${credentialRef}`.slice(0, 5000);
}

async function credentialDescriptor(secretKey = '', secretId = '', plainValue = '') {
    const value = normalizeText(plainValue);
    if (value) return { value, identity: `value:${value}`, exposureDenied: false };
    if (!secretKey || !secretId || !getSecretEntry(secretKey, secretId)) {
        return { value: '', identity: 'empty:', exposureDenied: false };
    }
    const exposed = await findSecretBounded(secretKey, secretId);
    if (exposed === null) return { value: '', identity: `secret:${secretKey}:${secretId}`, exposureDenied: true };
    const normalized = normalizeText(exposed);
    return { value: normalized, identity: normalized ? `value:${normalized}` : 'empty:', exposureDenied: false };
}

async function collectNativeImportCandidates(authoritative) {
    const candidates = [];
    const add = async candidate => {
        const format = normalizeFormat(candidate.format);
        const endpoint = normalizeText(candidate.endpoint);
        const credential = await credentialDescriptor(candidate.sourceSecretKey, candidate.sourceSecretId, candidate.plainKey);
        const normalized = {
            ...candidate,
            format,
            name: sanitizeName(candidate.name) || '原生连接配置',
            endpoint,
            model: normalizeText(candidate.model),
            includeBody: supportsCustomParameters(format) ? String(candidate.includeBody || '') : '',
            excludeBody: supportsCustomParameters(format) ? String(candidate.excludeBody || '') : '',
            includeHeaders: supportsCustomParameters(format) ? String(candidate.includeHeaders || '') : '',
            sourceSecretId: String(candidate.sourceSecretId || ''),
            credential,
            identity: importIdentity(format, endpoint, credential.identity, candidate.opencodeApiFormat),
            fingerprint: nativeImportFingerprint(candidate, format, endpoint),
        };
        if (!candidates.some(item => item.identity === normalized.identity)) candidates.push(normalized);
    };

    const activeCustom = authoritative[SECRET_KEYS.CUSTOM]?.find(entry => entry.active) || null;
    const currentCustomUrl = normalizeText(oai_settings.custom_url);
    const currentCustomFormat = Object.keys(FORMATS).find(format => isCustomFormat(format) && isFormatSupported(format) && matchesFormat(format, { ...oai_settings, chat_completion_source: chat_completion_sources.CUSTOM }));
    if (currentCustomFormat && (currentCustomUrl || oai_settings.custom_model || activeCustom)) {
        await add({
            sourceRef: 'current-custom', sourceLabel: `当前 ${FORMATS[currentCustomFormat].label}`,
            name: '当前 Custom 配置', format: currentCustomFormat, endpoint: currentCustomUrl,
            model: oai_settings.custom_model, sourceSecretKey: SECRET_KEYS.CUSTOM,
            sourceSecretId: activeCustom?.id,
            ...nativeAdditionalParameters(platform.customSelection(FORMATS[currentCustomFormat].apiFormat)),
        });
    }

    if (platform.supportsOpenCode && oai_settings.chat_completion_source === chat_completion_sources.OPENCODE) {
        await add({
            sourceRef: 'current-opencode', sourceLabel: '当前 OpenCode', name: '当前 OpenCode 配置', format: 'opencode',
            endpoint: nativeEndpoint('opencode'), opencodeApiFormat: oai_settings.opencode_api_format || 'openai_compat',
            model: oai_settings.opencode_model, sourceSecretKey: SECRET_KEYS.OPENCODE,
            sourceSecretId: authoritative[SECRET_KEYS.OPENCODE]?.find(entry => entry.active)?.id,
            ...nativeAdditionalParameters(chat_completion_sources.OPENCODE),
        });
    }

    const activeOpenAI = authoritative[SECRET_KEYS.OPENAI]?.find(entry => entry.active) || null;
    const reverseProxy = normalizeText(oai_settings.reverse_proxy);
    if (reverseProxy || oai_settings.openai_model || activeOpenAI) {
        await add({
            sourceRef: reverseProxy ? 'current-openai:reverse-proxy' : 'current-openai:official',
            sourceLabel: '当前 OpenAI', name: '当前 OpenAI 配置', format: 'openai',
            endpoint: reverseProxy || 'https://api.openai.com/v1', model: oai_settings.openai_model,
            plainKey: reverseProxy ? oai_settings.proxy_password : '',
            sourceSecretKey: reverseProxy ? '' : SECRET_KEYS.OPENAI,
            sourceSecretId: reverseProxy ? '' : activeOpenAI?.id,
        });
    }

    const managerProfiles = Array.isArray(extension_settings?.connectionManager?.profiles)
        ? extension_settings.connectionManager.profiles : [];
    const referencedProxyNames = new Set(managerProfiles.map(profile => profile?.proxy).filter(Boolean));
    const sourceFormats = { openai: 'openai', custom: 'openai', claude: 'anthropic', makersuite: 'gemini' };
    for (const nativeProfile of managerProfiles) {
        const protocol = nativeProfile?.['custom-api-format'] || 'openai_compat';
        const format = nativeProfile?.api === 'custom' ? (protocol === 'openai_compat' ? 'openai' : protocol) : sourceFormats[nativeProfile?.api];
        if (!format || !isFormatSupported(format)) continue;
        const config = FORMATS[format];
        const proxy = nativeProfile.proxy ? proxies.find(item => item.name === nativeProfile.proxy) : null;
        const endpoint = isCustomFormat(format)
            ? normalizeText(proxy?.url || nativeProfile['api-url'] || 'https://api.openai.com/v1')
            : normalizeText(proxy?.url || nativeProfile['api-url']);
        const proxyMode = usesProxyProfile(format, endpoint);
        const usesProxyCredential = Boolean(proxy?.url);
        await add({
            sourceRef: `connection-manager:${normalizeText(nativeProfile.id || nativeProfile.name)}`,
            sourceLabel: `Connection Manager (${nativeProfile.api})`, name: nativeProfile.name, format,
            endpoint, model: nativeProfile.model, proxyPreset: proxyMode ? proxy?.name || '' : '',
            plainKey: usesProxyCredential ? proxy.password : '',
            // Any non-empty Anthropic/Gemini endpoint is a reverse proxy. If
            // Connection Manager has no bound proxy preset, never substitute
            // the provider's official secret as that proxy password.
            sourceSecretKey: usesProxyCredential || proxyMode ? '' : (nativeProfile.api === 'openai' ? SECRET_KEYS.OPENAI : config.secretKey),
            sourceSecretId: usesProxyCredential || proxyMode ? '' : nativeProfile['secret-id'],
        });
    }

    for (const proxy of proxies) {
        if (!normalizeText(proxy?.url) || proxy.name === 'None' || referencedProxyNames.has(proxy.name)) continue;
        await add({
            sourceRef: `reverse-proxy-preset:${normalizeText(proxy.name)}`,
            sourceLabel: 'Reverse Proxy Preset', name: proxy.name, format: 'openai', endpoint: proxy.url,
            model: '', plainKey: proxy.password, sourceSecretKey: '', sourceSecretId: '',
        });
    }

    const existing = new Set();
    const existingFingerprints = new Set(profiles().map(profile => normalizeText(profile.nativeImportFingerprint)).filter(Boolean));
    for (const profile of profiles()) {
        const proxyMode = usesProxyProfile(profile.format, profile.endpoint);
        const proxy = proxyMode ? getBoundProxyPreset(profile) : null;
        const credential = await credentialDescriptor(
            proxyMode ? '' : FORMATS[profile.format].secretKey,
            proxyMode ? '' : profile.secretId,
            proxyMode ? proxy?.password : '',
        );
        existing.add(importIdentity(profile.format, profile.endpoint, credential.identity, profile.opencodeApiFormat));
    }
    return candidates.filter(candidate => !existing.has(candidate.identity) && !existingFingerprints.has(candidate.fingerprint));
}

function buildNativeImportPreview(candidates) {
    const content = $('<div class="quicker-api__model-manager quicker-api__migration">')
        .append($('<div class="quicker-api__manager-note">').text('仅列出尚未存在的原生连接；选择后迁移，不修改原配置。'));
    const list = $('<div class="quicker-api__model-list">');
    candidates.forEach((candidate, index) => {
        const checkbox = $('<input type="checkbox">').attr('data-index', index);
        const details = $('<div class="quicker-api__migration-summary">')
            .text(`${candidate.name} · ${candidate.endpoint || '官方端点'}`);
        list.append($('<label class="quicker-api__model-item quicker-api__remote-model">').append(checkbox, details));
    });
    return content.append(list);
}

async function resolveNativeImportCredential(candidate, authoritative) {
    const targetKey = FORMATS[candidate.format].secretKey;
    if (usesProxyProfile(candidate.format, candidate.endpoint) && candidate.proxyPreset) {
        return { secretId: '', proxyPreset: candidate.proxyPreset, needsSecret: !candidate.credential.value, exposureDenied: false };
    }
    if (candidate.sourceSecretKey === targetKey && candidate.sourceSecretId
        && authoritative[targetKey]?.some(entry => entry.id === candidate.sourceSecretId)) {
        return { secretId: candidate.sourceSecretId, proxyPreset: '', needsSecret: false, exposureDenied: false };
    }
    if (!candidate.credential.value) {
        return { secretId: '', proxyPreset: '', needsSecret: true, exposureDenied: candidate.credential.exposureDenied };
    }
    const result = await ensureSecret(targetKey, candidate.credential.value, candidate.name);
    return { secretId: result.id, proxyPreset: '', needsSecret: !result.id, exposureDenied: false };
}

async function importNativeProfile() {
    const authoritative = await readAuthoritativeSecretState();
    if (!authoritative) return toastr.error('无法读取原生凭据状态，已取消迁移。');
    const candidates = await collectNativeImportCandidates(authoritative);
    if (!candidates.length) return toastr.info('未检测到尚未迁移的原生连接配置。');
    const preview = buildNativeImportPreview(candidates);
    const confirmed = await callQuickerPopup(preview, POPUP_TYPE.CONFIRM, '', {
        okButton: '添加',
        cancelButton: '取消',
        animation: 'none',
    });
    if (!confirmed) return;
    const indexes = preview.find('input[type="checkbox"]:checked').map((_, input) => Number(input.dataset.index)).get();
    if (!indexes.length) return;

    const baselineIds = {};
    const targetKeys = new Set(indexes.map(index => FORMATS[candidates[index].format].secretKey));
    for (const key of targetKeys) {
        baselineIds[key] = authoritative[key]?.find(entry => entry.active)?.id || await ensureEmptySecret(key);
        if (!baselineIds[key]) return toastr.error('无法建立凭据安全基线，已取消迁移。');
    }
    let imported = 0;
    let pending = 0;
    try {
        for (const index of indexes) {
            const candidate = candidates[index];
            const credential = await resolveNativeImportCredential(candidate, authoritative);
            profiles().push(normalizeProfile({
                id: makeId(), name: uniqueName(candidate.name), format: candidate.format,
                endpoint: candidate.endpoint, model: candidate.model,
                includeBody: candidate.includeBody, excludeBody: candidate.excludeBody,
                includeHeaders: candidate.includeHeaders,
                secretId: credential.secretId, proxyPreset: credential.proxyPreset,
                needsSecret: credential.needsSecret,
                nativeImportFingerprint: candidate.fingerprint,
                opencodeApiFormat: candidate.opencodeApiFormat,
                availableModels: hasManagedModels(candidate.format) ? [candidate.model] : [],
                updatedAt: new Date().toISOString(),
            }));
            imported++;
            if (credential.needsSecret || credential.exposureDenied) pending++;
        }
    } finally {
        for (const [key, id] of Object.entries(baselineIds)) {
            if (!await rotateSecretVerified(key, id)) await enterFailClosedState('迁移后无法恢复原活动凭据。', key);
        }
    }
    scheduleSettingsSave();
    renderProfiles(settings().selectedProfileId);
    if (imported) toastr.success(`已迁移 ${imported} 个原生连接配置。`);
    if (pending) toastr.warning(`${pending} 个配置需要重新配置凭据。`);
}

async function saveSelectedProfile() {
    let current = selectedProfile();
    const isNew = !current;
    const previousEndpoint = normalizeText(current?.endpoint);
    const format = normalizeFormat($('#quicker_api_format').val());
    if (!isFormatSupported(format)) return toastr.warning('当前宿主不支持该格式。');
    let editorUrl;
    try { editorUrl = editorEndpoint(format); } catch (error) { toastr.warning(error.message); return; }
    if (isCustomFormat(format) && !editorUrl) {
        toastr.warning('Custom URL 不能为空。');
        return;
    }
    if (!current) {
        const name = await promptName('输入新 API 配置名称：', `${FORMATS[format].label} ${profiles().length + 1}`);
        if (!name) return;
        current = normalizeProfile({ id: makeId(), name: uniqueName(name), format });
    }
    const config = FORMATS[format];
    const proxyMode = usesProxyProfile(format, editorUrl);
    if (!proxyMode && !await readAuthoritativeSecretState()) {
        toastr.error('无法读取权威密钥状态，已取消保存 API 配置。');
        return;
    }
    const keyValue = keyEditorDirty ? normalizeText($('#quicker_api_key_input').val()) : '';
    let captureBase = current;
    if (keyValue) {
        const credentialDraft = normalizeProfile({ ...structuredClone(current), format });
        if (!await saveAndBindInputKey(credentialDraft, format, editorUrl)) return;
        captureBase = credentialDraft;
    }
    // Capture the editor without changing the live connection first: applyProfile
    // must snapshot the original source/fields for credential verification/rollback.
    const retainedProxy = proxyMode && captureBase.format === format
        && normalizeText(captureBase.endpoint) === editorUrl ? getBoundProxyPreset(captureBase) : null;
    Object.assign(current, captureNativeProfile(current.name, format, captureBase, {
        endpoint: editorUrl,
        opencodeApiFormat: String($('#quicker_api_opencode_format').val() || ''),
        proxyPassword: keyValue || retainedProxy?.password,
    }));
    if (hasManagedModels(format)) {
        // Favorites are explicit; only a brand-new profile starts with its model favorited.
        if (isNew) current.availableModels = normalizeModelList([...(current.availableModels || []), current.model]);
        if (!isNew && previousEndpoint !== normalizeText(current.endpoint)) {
            current.fetchedModels = [];
            current.fetchedFromEndpoint = '';
        } else {
            current.fetchedModels = normalizeModelList(current.fetchedModels);
        }
    }
    if (isNew) profiles().push(current);
    settings().selectedProfileId = current.id;
    // Saving data is not proof that its source and credential are active.
    settings().activeProfileId = null;
    let applied = false;
    try {
        applied = await applyProfile(current);
    } catch (error) {
        console.error('[QuickerApi] Saved Profile application failed:', error);
    }
    const presetName = currentPresetName();
    if (applied && presetName) {
        settings().presetBindings[presetName] = current.id;
        settings().presetModels[presetName] = presetModelSnapshot(current, current.model);
    }
    scheduleSettingsSave();
    renderProfiles(current.id);
    if (await persistSettingsNow()) {
        if (applied) toastr.success('API 配置已保存并应用到 SillyTavern。');
        else toastr.warning('API 配置已保存，但未能应用；请检查连接与密钥状态后重新选择该 Profile。');
    }
}

async function renameSelectedProfile() {
    const profile = selectedProfile();
    if (!profile) return;
    const name = await promptName('输入新的配置名称：', profile.name);
    if (!name) return;
    profile.name = uniqueName(name, profile.id);
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    renderProfiles(profile.id);
}

async function copySelectedProfile() {
    const profile = selectedProfile();
    if (!profile) return;
    const name = await promptName('输入复制配置的名称：', `${profile.name} 副本`);
    if (!name) return;
    const copy = normalizeProfile({ ...structuredClone(profile), id: makeId(), name: uniqueName(name), updatedAt: new Date().toISOString() });
    profiles().push(copy);
    settings().selectedProfileId = copy.id;
    scheduleSettingsSave();
    renderProfiles(copy.id);
    toastr.success('配置已复制。');
}

async function deleteSelectedProfile() {
    const profile = selectedProfile();
    if (!profile) return;
    const content = $('<div>').append($('<p>').text(`删除 Profile“${profile.name}”？`), $('<p>').text('不会删除任何原生密钥；相关原生预设绑定会被解除。'));
    if (!await callQuickerPopup(content, POPUP_TYPE.CONFIRM)) return;
    settings().profiles = profiles().filter(item => item.id !== profile.id);
    for (const [name, id] of Object.entries(settings().presetBindings)) {
        if (id === profile.id) {
            delete settings().presetBindings[name];
            delete settings().presetModels[name];
        }
    }
    if (settings().activeProfileId === profile.id) settings().activeProfileId = null;
    if (settings().selectedProfileId === profile.id) settings().selectedProfileId = null;
    scheduleSettingsSave();
    renderProfiles();
}


async function findMatchingSecret(key, value) {
    if (!await canReadSecretPlaintext()) return { entry: null, exposureAvailable: false };
    let readable = false;
    for (const entry of getSecretEntries(key)) {
        const existing = await findSecretBounded(key, entry.id);
        if (existing === null) continue;
        readable = true;
        if (existing === value) return { entry, exposureAvailable: true };
    }
    return { entry: null, exposureAvailable: readable };
}

async function ensureSecret(key, value, label) {
    const normalized = normalizeText(value);
    if (!normalized) return { id: '', reused: false, exposureAvailable: true };
    const match = await findMatchingSecret(key, normalized);
    if (match.entry) {
        const activated = await rotateSecretVerified(key, match.entry.id);
        return { id: activated ? match.entry.id : '', reused: true, exposureAvailable: true };
    }
    const id = await writeSecretVerified(key, normalized, label);
    const state = id ? await readAuthoritativeSecretState() : null;
    const verified = Boolean(id && state?.[key]?.some(entry => entry.id === id && entry.active));
    return { id: verified ? id : '', reused: false, exposureAvailable: match.exposureAvailable };
}

async function saveAndBindInputKey(profile = selectedProfile(), requestedFormat = profile?.format, endpointOverride = null) {
    if (!profile) {
        toastr.info('请先选择或新建配置。');
        return false;
    }
    const format = normalizeFormat(requestedFormat);
    const config = FORMATS[format];
    const endpoint = endpointOverride === null ? String(oai_settings[config.endpointField] || '') : String(endpointOverride || '');
    const value = normalizeText($('#quicker_api_key_input').val() || $(config.keyInput).val());
    if (usesProxyProfile(format, endpoint)) {
        if (!value) return true;
        profile.proxyPreset = ensureBoundProxyPreset(profile.name, endpoint, value, profile.proxyPreset, profile.id);
        profile.secretId = '';
        profile.needsSecret = false;
        oai_settings.proxy_password = value;
        $('#openai_proxy_password').val(value).trigger('input');
        profile.updatedAt = new Date().toISOString();
        scheduleSettingsSave();
        return true;
    }
    if (!value) return true;
    const before = await readAuthoritativeSecretState();
    if (!before) {
        toastr.error('无法读取写入前的权威密钥状态。');
        return false;
    }
    const previousId = before[config.secretKey]?.find(entry => entry.active)?.id || '';
    const result = await ensureSecret(config.secretKey, value, profile.name);
    if (!result.id) {
        if (!previousId || !await rotateSecretVerified(config.secretKey, previousId)) await enterFailClosedState('密钥保存状态无法确认且回滚失败。', config.secretKey);
        toastr.error('密钥保存或激活状态无法确认。');
        return false;
    }
    clearCredentialSafetyBlock(config.secretKey);
    profile.secretId = result.id;
    profile.needsSecret = false;
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    if (!result.exposureAvailable) toastr.warning('凭据已保存；findSecret 无权限，无法检查历史密钥是否同值。');
    return true;
}

async function readBoundSecret(profile) {
    if (usesProxyProfile(profile?.format, profile?.endpoint)) {
        const proxyPreset = getBoundProxyPreset(profile);
        if (!proxyPreset) {
            toastr.warning('当前 Profile 没有可用的原生 Reverse Proxy Preset。');
            return null;
        }
        return String(proxyPreset.password || '');
    }
    if (!profile?.secretId) {
        toastr.info('当前 Profile 未绑定密钥。');
        return null;
    }
    const value = await findSecretBounded(FORMATS[profile.format].secretKey, profile.secretId);
    if (value === null) {
        toastr.warning(keyExposureGuidance().warning);
        renderStatus('密钥明文不可读');
        return null;
    }
    return value;
}

async function revealBoundSecret() {
    const profile = selectedProfile();
    const input = $('#quicker_api_key_input');
    if (!String(input.val() || '')) {
        const value = await readBoundSecret(profile);
        if (value === null) return;
        input.val(value);
    }
    const showing = !input.hasClass('quicker-api__secret-masked');
    input.toggleClass('quicker-api__secret-masked', showing);
    $('#quicker_api_reveal_key i').attr('class', showing ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye');
}

async function copyBoundSecret() {
    const inputValue = String($('#quicker_api_key_input').val() || '');
    const value = inputValue || await readBoundSecret(selectedProfile());
    if (value === null) return;
    try {
        let timeoutId = null;
        await Promise.race([
            navigator.clipboard.writeText(value),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Clipboard write timed out')), 5000);
            }),
        ]).finally(() => clearTimeout(timeoutId));
        toastr.success('绑定密钥已复制到剪贴板。');
    } catch {
        toastr.error('浏览器拒绝剪贴板写入。');
    }
}

async function addCustomModel(initial = null) {
    const profile = selectedProfile();
    if (!profile || !hasManagedModels(profile.format)) return toastr.info('请先选择并保存 API 配置。');
    const model = await promptName('输入模型 ID（将加入收藏并使用）：', typeof initial === 'string' ? initial : getEditorModel(profile.format));
    if (!model) return;
    favoriteAndUseModel(profile, model);
}

function favoriteAndUseModel(profile, model) {
    profile.availableModels = normalizeModelList([...(profile.availableModels || []), model]);
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    renderModelControl(profile, model);
    syncEditorModelToNative();
    renderStatus();
}

function modelIdsFromPayload(payload) {
    const items = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    return normalizeModelList(items.map(item => typeof item === 'string' ? item : item?.id));
}

function buildModelsEndpoint(endpoint) {
    const url = new URL(endpoint);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/i, '').replace(/\/$/, '') + '/models';
    return url.toString();
}

function customHeaderObject(value) {
    if (!normalizeText(value)) return {};
    const parsed = yaml.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('附加请求头必须是 YAML / JSON 对象。');
    return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => key && item != null).map(([key, item]) => [key, String(item)]));
}

async function fetchWithTimeout(resource, options, timeout = 15000, consumeResponse = null) {
    const controller = new AbortController();
    activeFetchControllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        return consumeResponse ? await consumeResponse(response) : response;
    } finally {
        clearTimeout(timeoutId);
        activeFetchControllers.delete(controller);
    }
}

async function fetchJsonWithTimeout(resource, options, timeout = 15000) {
    return await fetchWithTimeout(resource, options, timeout, async response => ({
        response,
        data: response.ok ? await response.json() : null,
    }));
}

async function canReadSecretPlaintext() {
    // Older SillyTavern releases do not expose this endpoint. Keep their existing
    // find semantics; TT must preflight to avoid native permission-error toasts.
    if (!platform.preferBackendModels) return true;
    try {
        const { response, data } = await fetchJsonWithTimeout('/api/secrets/settings', {
            method: 'POST', headers: getRequestHeaders(),
        });
        return response.ok && data?.allowKeysExposure === true;
    } catch { return false; }
}

async function findSecretBounded(key, id) {
    if (extensionDisabled || teardownPending || !await canReadSecretPlaintext()) return null;
    try {
        const { response, data } = await fetchJsonWithTimeout('/api/secrets/find', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key, id }),
        }, 15000);
        if (!response.ok) return null;
        return data?.value ?? null;
    } catch (error) {
        console.warn('[QuickerApi] Secret lookup failed or timed out:', key, error);
        return null;
    }
}

async function fetchModelsForProfile(profile, endpoint) {
    if (!isFormatSupported(profile.format)) throw new Error('当前宿主不支持该格式；配置已保留。');
    if (profile.format === 'opencode') {
        if (!platform.supportsOpenCode) throw new Error('当前宿主不支持原生 OpenCode。');
        validateOpenCodeConnection(endpoint, profile.opencodeApiFormat);
    }
    const config = FORMATS[profile.format];
    const provider = profile.format === 'anthropic' || profile.format === 'gemini';
    const proxy = usesProxyProfile(profile.format, endpoint) ? getBoundProxyPreset(profile) : null;
    if (usesProxyProfile(profile.format, endpoint) && !proxy) throw new Error('代理凭据绑定缺失，请先保存配置。');
    const backendOnly = platform.preferBackendModels || profile.format !== 'openai';
    let frontendError = null;
    if (!backendOnly) try {
        const key = profile.secretId ? await findSecretBounded(config.secretKey, profile.secretId) : '';
        if (profile.secretId && key === null) throw new Error('浏览器无权读取已保存 Key');
        const headers = { Accept: 'application/json', ...customHeaderObject(profile.includeHeaders) };
        if (key && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${key}`;
        const { response, data } = await fetchJsonWithTimeout(buildModelsEndpoint(endpoint), { method: 'GET', headers, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const models = modelIdsFromPayload(data);
        if (!models.length) throw new Error('前端 /models 响应未包含模型列表');
        return { models, route: '前端 /models' };
    } catch (error) {
        frontendError = error;
        console.warn('[QuickerApi] Frontend /models failed; falling back to backend status:', error);
    }

    let previousActiveId = '';
    let desiredSecretId = '';
    // Model probes temporarily rotate the host's global credential slot. Block
    // generation for the whole transaction, not just the asynchronous rotation.
    const transitionWasBlocked = presetTransitionBlocked;
    beginPresetTransition();
    try {
        const authoritative = await readAuthoritativeSecretState();
        if (!authoritative) throw new Error(`无法读取 ${config.label} 密钥权威状态`);
        const customEntries = Array.isArray(authoritative[config.secretKey]) ? authoritative[config.secretKey] : [];
        previousActiveId = customEntries.find(entry => entry.active)?.id || await ensureEmptySecret(config.secretKey);
        if (!previousActiveId) throw new Error('无法建立模型获取前的安全凭据基线');
        const boundSecretExists = Boolean(profile.secretId && customEntries.some(entry => entry.id === profile.secretId));
        if (profile.secretId && !boundSecretExists) {
            profile.secretId = '';
            profile.needsSecret = true;
            scheduleSettingsSave();
            updateCredentialEditor(profile);
        }
        desiredSecretId = boundSecretExists ? profile.secretId : await ensureEmptySecret(config.secretKey);
        if (!desiredSecretId) throw new Error(`无法建立 Profile 对应的安全 ${config.label} 密钥`);
        if (previousActiveId !== desiredSecretId && !await rotateSecretVerified(config.secretKey, desiredSecretId)) {
            throw new Error(`无法激活 Profile 绑定的 ${config.label} 密钥`);
        }

        const { response, data } = await fetchJsonWithTimeout('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: config.source,
                reverse_proxy: provider ? endpoint : '',
                proxy_password: proxy ? String(proxy.password || '') : '',
                ...(profile.format === 'opencode' ? {
                    opencode_endpoint: validateOpenCodeConnection(endpoint, profile.opencodeApiFormat),
                    opencode_api_format: profile.opencodeApiFormat,
                } : provider ? {} : { custom_url: endpoint, custom_api_format: config.apiFormat || 'openai_compat' }),
                custom_include_headers: profile.includeHeaders,
            }),
            cache: 'no-cache',
        }, 20000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const models = modelIdsFromPayload(data);
        if (!models.length) throw new Error('当前宿主或服务未返回模型列表；可通过“添加”手动填写模型 ID。');
        return { models, route: backendOnly ? '后端 status' : '后端 status fallback', frontendError };
    } catch (backendError) {
        const error = new Error(`${frontendError ? `前端 /models：${frontendError.message}；` : ''}后端 status：${backendError.message}`);
        error.cause = backendError;
        throw error;
    } finally {
        try {
            if (previousActiveId && desiredSecretId && previousActiveId !== desiredSecretId) {
                const restored = await rotateSecretVerified(config.secretKey, previousActiveId);
                if (!restored) await enterFailClosedState(`模型获取后无法恢复原 ${config.label} 活动密钥。`, config.secretKey);
            }
        } finally {
            if (!transitionWasBlocked) endPresetTransition();
        }
    }
}

async function fetchCustomModels() {
    const profile = selectedProfile();
    if (!profile || !hasManagedModels(profile.format)) return toastr.info('请先选择并保存 API 配置。');
    if (keyEditorDirty && normalizeText($('#quicker_api_key_input').val())) return toastr.info('请先点击保存按钮保存当前 Key，再获取模型。');
    if (profile.format === 'opencode' && $('#quicker_api_opencode_format').val() !== profile.opencodeApiFormat) return toastr.info('协议已变化，请先保存配置再获取模型。');
    const editorUrl = normalizeText($('#quicker_api_url').val());
    if (!editorUrl && isCustomFormat(profile.format)) return toastr.warning('请先填写 Custom URL。');
    if (editorUrl !== normalizeText(profile.endpoint)) return toastr.info('URL 已变化，请先保存配置；保存会清空旧远端快照并保留已选模型。');
    try {
        const result = await fetchModelsForProfile(profile, editorUrl);
        profile.fetchedModels = result.models;
        profile.fetchedFromEndpoint = editorUrl;
        profile.updatedAt = new Date().toISOString();
        scheduleSettingsSave();
        modelPickerView = 'all';
        renderModelControl(profile, getEditorModel(profile.format) || profile.model);
        const stale = staleFavoriteModels(profile.availableModels, result.models);
        toastr.success(`通过${result.route}获取 ${result.models.length} 个模型，已切换到“全部”列表。`);
        if (stale.length) toastr.warning(`${stale.length} 个收藏模型不在云端最新列表中，可在“管理模型列表”中一键清理。`);
        renderStatus();
    } catch (error) {
        console.error('[QuickerApi] Model fetch failed:', error);
        toastr.error(`获取模型失败：${error.message}`);
        renderStatus();
    }
}

function matchesModelSearch(model, query) {
    const text = String(model).toLowerCase();
    let position = 0;
    // Ordered subsequences also include ordinary substring matches. Treat the
    // query as literal text, not a regular expression or a wildcard pattern.
    for (const character of normalizeText(query).toLowerCase()) {
        position = text.indexOf(character, position);
        if (position < 0) return false;
        position += character.length;
    }
    return true;
}

async function manageCustomModels() {
    const profile = selectedProfile();
    if (!profile || !hasManagedModels(profile.format)) return toastr.info('请先选择并保存 API 配置。');
    if (keyEditorDirty && normalizeText($('#quicker_api_key_input').val())) return toastr.info('Key 尚未保存，请先点击保存按钮再管理或获取模型。');
    const endpoint = normalizeText($('#quicker_api_url').val());
    if (endpoint !== normalizeText(profile.endpoint)) return toastr.info('URL 已变化，请先保存配置再管理模型。');

    const draft = {
        current: normalizeText(getEditorModel(profile.format) || profile.model),
        available: normalizeModelList(profile.availableModels),
        fetched: profile.fetchedFromEndpoint === endpoint ? normalizeModelList(profile.fetchedModels) : [],
        fetchedFromEndpoint: profile.fetchedFromEndpoint === endpoint ? endpoint : '',
    };
    const initialDraft = structuredClone(draft);

    const content = $('<div class="quicker-api__model-manager quicker-api__model-manager--paged">');
    content.append($('<div class="quicker-api__manager-note">').text('所有修改仅在确认后保存，取消会完整回滚。'));
    // Narrow screens show one panel at a time behind these tabs (no page scrolling needed).
    const pageTabs = $(`<div class="quicker-api__manager-pages" role="tablist" aria-label="管理页面">
        <button type="button" role="tab" class="menu_button" data-page="remote"><i class="fa-solid fa-cloud-arrow-down"></i><span>远端模型</span><small></small></button>
        <button type="button" role="tab" class="menu_button" data-page="chosen"><i class="fa-solid fa-star"></i><span>收藏</span><small></small></button>
    </div>`);
    const columns = $('<div class="quicker-api__manager-columns">');
    const remotePanel = $('<section class="quicker-api__manager-panel" data-page="remote" role="tabpanel">');
    const chosenPanel = $('<section class="quicker-api__manager-panel" data-page="chosen" role="tabpanel">');
    const showPage = page => {
        content.attr('data-page', page);
        pageTabs.find('[data-page]').each((_, tab) => {
            const active = tab.dataset.page === page;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
        });
    };
    pageTabs.on('click', '[data-page]', function () {
        showPage(this.dataset.page);
    });
    showPage('remote');
    const remoteActions = $('<div class="quicker-api__manager-actions">').append(
        $('<button type="button" class="menu_button" data-action="fetch"><i class="fa-solid fa-arrows-rotate"></i><span>获取</span></button>'),
        $('<button type="button" class="menu_button" data-action="all">全选</button>'),
        $('<button type="button" class="menu_button" data-action="invert">反选</button>'),
        $('<button type="button" class="menu_button" data-action="none">全不选</button>'),
    );
    const customInput = $('<input class="text_pole" type="text" autocomplete="off" placeholder="自定义模型 ID">');
    const chosenActions = $('<div class="quicker-api__manager-actions">').append(
        customInput,
        $('<button type="button" class="menu_button" data-action="add"><i class="fa-solid fa-plus"></i><span>新增</span></button>'),
        $('<button type="button" class="menu_button quicker-api__prune-stale" data-action="prune" title="移除云端最新列表中已不存在的收藏"><i class="fa-solid fa-broom"></i><span>清理失效</span></button>'),
        $('<button type="button" class="menu_button" data-action="clear">清空</button>'),
        $('<button type="button" class="menu_button" data-action="reset">重置</button>'),
    );
    const remoteSearch = $('<div class="quicker-api__model-search">');
    const searchInput = $('<input class="text_pole" type="search" autocomplete="off" placeholder="搜索远端模型" aria-label="搜索远端模型">');
    const clearSearch = $('<button type="button" class="menu_button" aria-label="清空模型搜索">清空搜索</button>');
    const searchCount = $('<small class="quicker-api__model-search-count" role="status" aria-live="polite">');
    remoteSearch.append(searchInput, clearSearch);
    const searchHelp = $('<small class="quicker-api__model-search-help">').text('忽略大小写，支持部分名称或按顺序输入不连续字符；筛选时批量操作仅影响匹配项。');
    const remoteList = $('<div class="quicker-api__model-list">');
    const chosenList = $('<div class="quicker-api__model-list">');
    const chosenTitle = $('<h4><i class="fa-solid fa-star"></i> 收藏（下拉“收藏”列表）</h4>');
    const staleBadge = $('<span class="quicker-api__stale-badge" role="status" aria-live="polite">');
    chosenTitle.append(staleBadge);
    remotePanel.append($('<h4><i class="fa-solid fa-cloud-arrow-down"></i> 远端模型（勾选 = 收藏）</h4>'), remoteActions, remoteSearch, searchHelp, searchCount, remoteList);
    chosenPanel.append(chosenTitle, chosenActions, chosenList);
    columns.append(remotePanel, chosenPanel);
    content.append(pageTabs, columns);

    const normalizeDraft = () => {
        draft.available = normalizeModelList(draft.available);
    };
    const draftStaleModels = () => staleFavoriteModels(draft.available, draft.fetched);
    const filteredRemoteModels = () => draft.fetched.filter(model => matchesModelSearch(model, searchInput.val()));

    // Remote rows are built once per snapshot (lists can hold hundreds of
    // models); selecting and searching only update attributes on those rows.
    let remoteRows = new Map();
    let renderedFetched = null;
    const remoteEmpty = document.createElement('div');
    remoteEmpty.className = 'quicker-api__empty-state';
    const buildRemoteRows = () => {
        renderedFetched = draft.fetched;
        remoteRows = new Map();
        const fragment = document.createDocumentFragment();
        for (const model of draft.fetched) {
            const row = document.createElement('div');
            row.className = 'quicker-api__model-item quicker-api__remote-model';
            row.setAttribute('role', 'checkbox');
            row.tabIndex = 0;
            row.dataset.model = model;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.tabIndex = -1;
            checkbox.setAttribute('aria-label', `选择 ${model}`);
            const name = document.createElement('span');
            name.textContent = model;
            const source = document.createElement('small');
            source.textContent = '远端';
            row.append(checkbox, name, source);
            remoteRows.set(model, { row, checkbox });
            fragment.append(row);
        }
        remoteList[0].replaceChildren(remoteEmpty, fragment);
    };
    const syncRemoteChecks = () => {
        const selected = new Set(draft.available);
        for (const [model, { row, checkbox }] of remoteRows) {
            const checked = selected.has(model);
            if (checkbox.checked !== checked) checkbox.checked = checked;
            if (row.getAttribute('aria-checked') !== String(checked)) row.setAttribute('aria-checked', String(checked));
        }
    };
    const syncRemoteFilter = () => {
        const query = searchInput.val();
        let shown = 0;
        for (const [model, { row }] of remoteRows) {
            const visible = matchesModelSearch(model, query);
            if (row.hidden === visible) row.hidden = !visible;
            if (visible) shown += 1;
        }
        searchCount.text(`显示 ${shown} / ${draft.fetched.length} 个模型`);
        remoteEmpty.hidden = shown > 0;
        remoteEmpty.textContent = shown ? ''
            : !draft.fetched.length ? '尚无当前 URL 的远端快照'
                : '没有匹配的远端模型，请尝试其他关键词或清空搜索';
    };

    const chosenButton = (op, icon, label) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.dataset.op = op;
        button.title = label;
        button.setAttribute('aria-label', label);
        const glyph = document.createElement('i');
        glyph.className = `fa-solid ${icon}`;
        button.append(glyph);
        return button;
    };
    const chosenRows = new Map();
    const chosenEmpty = document.createElement('div');
    chosenEmpty.className = 'quicker-api__empty-state';
    chosenEmpty.textContent = '收藏列表为空';
    chosenList[0].append(chosenEmpty);
    const createChosenRow = model => {
        const row = document.createElement('div');
        row.className = 'quicker-api__model-item quicker-api__chosen-model';
        const position = document.createElement('span');
        position.className = 'quicker-api__drag-index';
        const input = document.createElement('input');
        input.className = 'text_pole';
        input.type = 'text';
        input.readOnly = true;
        input.value = model;
        input.setAttribute('aria-label', `模型 ${model}`);
        const label = document.createElement('small');
        const up = chosenButton('up', 'fa-arrow-up', '上移');
        const down = chosenButton('down', 'fa-arrow-down', '下移');
        const actions = document.createElement('div');
        actions.className = 'quicker-api__item-actions';
        actions.append(chosenButton('edit', 'fa-pen', '编辑'), chosenButton('remove', 'fa-trash', '删除'), up, down);
        row.append(position, input, label, actions);
        const entry = { row, position, input, label, up, down, index: -1, source: '' };
        chosenRows.set(model, entry);
        return entry;
    };
    const renderChosen = () => {
        const remote = new Set(draft.fetched);
        const stale = new Set(draftStaleModels());
        staleBadge.text(stale.size ? `⚠ ${stale.size} 个失效` : '').attr('title', stale.size ? '这些收藏不在当前 URL 的云端最新列表中' : '').prop('hidden', !stale.size);
        chosenActions.find('[data-action="prune"]').prop('disabled', !stale.size)
            .find('span').text(stale.size ? `清理失效 (${stale.size})` : '清理失效');
        const wanted = new Set(draft.available);
        for (const [model, entry] of chosenRows) {
            if (wanted.has(model)) continue;
            entry.row.remove();
            chosenRows.delete(model);
        }
        chosenEmpty.hidden = draft.available.length > 0;
        // Keyed update: rows for unchanged models are reused and only touched
        // where their position, flags or source actually changed.
        const last = draft.available.length - 1;
        let cursor = chosenEmpty.nextSibling;
        draft.available.forEach((model, index) => {
            const entry = chosenRows.get(model) ?? createChosenRow(model);
            const isStale = stale.has(model);
            const source = isStale ? 'stale' : remote.has(model) ? 'remote' : 'custom';
            if (entry.index !== index) {
                entry.index = index;
                entry.row.dataset.index = String(index);
                entry.position.textContent = String(index + 1);
            }
            entry.up.disabled = index === 0;
            entry.down.disabled = index === last;
            if (!entry.input.readOnly || entry.input.value !== model) {
                entry.input.readOnly = true;
                entry.input.value = model;
            }
            if (entry.source !== source) {
                entry.source = source;
                entry.row.classList.toggle('is-stale', isStale);
                if (isStale) entry.row.title = '云端最新列表中已不存在该模型';
                else entry.row.removeAttribute('title');
                entry.label.replaceChildren();
                if (isStale) {
                    const warning = document.createElement('i');
                    warning.className = 'fa-solid fa-triangle-exclamation';
                    warning.setAttribute('aria-hidden', 'true');
                    entry.label.append(warning, ' ');
                }
                entry.label.append(isStale ? '云端已无' : source === 'remote' ? '远端' : '自定义');
            }
            if (entry.row === cursor) cursor = cursor.nextSibling;
            else chosenList[0].insertBefore(entry.row, cursor);
        });
        pageTabs.find('[data-page="remote"] small').text(String(draft.fetched.length));
        pageTabs.find('[data-page="chosen"] small').text(stale.size ? `${draft.available.length} · ⚠${stale.size}` : String(draft.available.length));
        pageTabs.find('[data-page="chosen"]').toggleClass('has-stale', stale.size > 0);
    };
    // A draft edit: only the checkboxes and the (short) favorites list change.
    const updateDraft = () => {
        normalizeDraft();
        syncRemoteChecks();
        renderChosen();
    };
    const renderManager = () => {
        normalizeDraft();
        if (renderedFetched !== draft.fetched) buildRemoteRows();
        syncRemoteChecks();
        syncRemoteFilter();
        renderChosen();
    };

    const toggleRemoteModel = (model, checked) => {
        draft.available = checked ? [...draft.available, model] : draft.available.filter(item => item !== model);
        updateDraft();
    };
    remoteList.on('click', '.quicker-api__remote-model', function (event) {
        const model = this.dataset.model;
        const checkbox = remoteRows.get(model)?.checkbox;
        toggleRemoteModel(model, event.target === checkbox ? checkbox.checked : !draft.available.includes(model));
    }).on('keydown', '.quicker-api__remote-model', function (event) {
        if (event.target !== this || (event.key !== ' ' && event.key !== 'Enter')) return;
        event.preventDefault();
        event.stopPropagation(); // Host Popup treats Enter as confirmation.
        toggleRemoteModel(this.dataset.model, !draft.available.includes(this.dataset.model));
    });

    const commitChosenEdit = input => {
        if (input.readOnly) return;
        const index = Number(input.closest('.quicker-api__chosen-model')?.dataset.index);
        const model = draft.available[index];
        const next = normalizeText(input.value);
        if (model === undefined || !next || (next !== model && draft.available.includes(next))) return renderChosen();
        draft.available[index] = next;
        if (draft.current === model) draft.current = next;
        updateDraft();
    };
    chosenList.on('click', '[data-op]', function () {
        const row = this.closest('.quicker-api__chosen-model');
        const index = Number(row?.dataset.index);
        if (!Number.isInteger(index)) return;
        const op = this.dataset.op;
        if (op === 'edit') {
            const input = row.querySelector('input');
            input.readOnly = false;
            input.focus();
            input.select();
            return;
        }
        if (op === 'remove') draft.available.splice(index, 1);
        const swap = op === 'up' ? index - 1 : op === 'down' ? index + 1 : -1;
        if (swap >= 0 && swap < draft.available.length) {
            [draft.available[swap], draft.available[index]] = [draft.available[index], draft.available[swap]];
        }
        updateDraft();
    }).on('keydown', '.quicker-api__chosen-model > input', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation(); // Host Popup treats Enter as confirmation.
            commitChosenEdit(this);
        }
        if (event.key === 'Escape') renderChosen();
    }).on('change', '.quicker-api__chosen-model > input', function () {
        commitChosenEdit(this);
    });

    remoteActions.on('click', 'button', async function () {
        const action = String($(this).data('action'));
        if (action === 'fetch') {
            const button = $(this).prop('disabled', true);
            try {
                const result = await fetchModelsForProfile(profile, endpoint);
                draft.fetched = result.models;
                draft.fetchedFromEndpoint = endpoint;
                toastr.success(`通过${result.route}获取 ${result.models.length} 个模型；确认后保存快照。`);
            } catch (error) {
                console.error('[QuickerApi] Model manager fetch failed:', error);
                toastr.error(`获取模型失败：${error.message}`);
            } finally {
                button.prop('disabled', false);
                renderManager();
            }
            return;
        }
        const matching = filteredRemoteModels();
        const remote = new Set(matching);
        if (action === 'all') draft.available = [...draft.available, ...matching];
        if (action === 'invert') {
            const chosen = new Set(draft.available);
            draft.available = [
                ...draft.available.filter(model => !remote.has(model)),
                ...matching.filter(model => !chosen.has(model)),
            ];
        }
        if (action === 'none') draft.available = draft.available.filter(model => !remote.has(model));
        updateDraft();
    });
    const addDraftModel = () => {
        const model = normalizeText(customInput.val());
        if (!model) return;
        draft.available = [...draft.available, model];
        customInput.val('');
        updateDraft();
    };
    chosenActions.on('click', 'button', function () {
        const action = String($(this).data('action'));
        if (action === 'add') addDraftModel();
        if (action === 'prune') {
            const stale = new Set(draftStaleModels());
            if (!stale.size) return;
            draft.available = draft.available.filter(model => !stale.has(model));
            updateDraft();
            toastr.info(`已移除 ${stale.size} 个失效收藏；点击保存后生效。${stale.has(draft.current) ? '当前选中的模型不受影响，但它已不在云端列表中。' : ''}`);
        }
        if (action === 'clear') {
            draft.available = [];
            updateDraft();
        }
        if (action === 'reset') {
            Object.assign(draft, structuredClone(initialDraft));
            renderManager();
        }
    });
    customInput.on('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addDraftModel();
        }
    });
    searchInput.on('input', syncRemoteFilter).on('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation(); // Host Popup treats Enter as confirmation.
        }
    });
    clearSearch.on('click', () => {
        searchInput.val('');
        syncRemoteFilter();
        searchInput.trigger('focus');
    });
    renderManager();

    if (!await callQuickerPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: '保存',
        cancelButton: '取消',
        animation: 'none',
    })) return;
    normalizeDraft();
    profile.availableModels = draft.available;
    profile.fetchedModels = draft.fetched;
    profile.fetchedFromEndpoint = draft.fetchedFromEndpoint;
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    renderModelControl(profile, draft.current);
    syncEditorModelToNative();
    renderStatus();
}

function quickActionDisplayName(action, index = 0) {
    return sanitizeName(action.name) || `方案${index + 1}`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function presetOptionsHtml(selected = '') {
    const names = $('#settings_preset_openai option').map((_, option) => normalizeText(option.textContent)).get().filter(Boolean);
    const missing = selected && !names.includes(selected)
        ? [`<option value="${escapeHtml(selected)}" selected>⚠ 已不存在：${escapeHtml(selected)}</option>`]
        : [];
    return ['<option value="">— 不切换 preset —</option>', ...missing, ...names.map(name =>
        `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`,
    )].join('');
}

function profileOptionsHtml(selected = '') {
    const exists = profiles().some(profile => profile.id === selected);
    const missing = selected && !exists
        ? [`<option value="${escapeHtml(selected)}" selected>⚠ Profile 已不存在</option>`]
        : [];
    return ['<option value="">— 不切换 Profile —</option>', ...missing, ...profiles().map(profile =>
        `<option value="${escapeHtml(profile.id)}"${profile.id === selected ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`,
    )].join('');
}

function modelSuggestionsForProfile(profileId = '') {
    const profile = profiles().find(item => item.id === profileId) || null;
    if (!profile) return [];
    return normalizeModelList([profile.model, ...(profile.availableModels || []),
        ...profileFetchedModels(profile, profile.endpoint), ...nativeProviderModels(profile.format)]);
}

function normalizeQuickActionPlacement(value, fallback = 'rightSendForm') {
    return ['leftSendForm', 'rightSendForm', 'qrButtons', 'disabled'].includes(value) ? value : fallback;
}

async function chooseQuickActionPlacement(current, onConfirm) {
    if (quickActionPlacementPopup) await quickActionPlacementPopup.completeCancelled();
    let selected = normalizeQuickActionPlacement(current);
    const content = $('<div class="quicker-api__placement-popup">');
    const confirm = $('<button type="button" class="menu_button quicker-api__save-button" title="应用" aria-label="应用入口位置"><i class="fa-solid fa-check"></i></button>');
    const cancel = $('<button type="button" class="menu_button" title="取消" aria-label="取消入口位置更改"><i class="fa-solid fa-xmark"></i></button>');
    const header = $('<div class="quicker-api__placement-header">').append(
        $('<strong>').text('便捷入口位置'),
        $('<div class="quicker-api__placement-actions">').append(confirm, cancel),
    );
    const choices = $('<div class="quicker-api__placement-choices">').append(
        $('<button type="button" class="menu_button" data-placement="leftSendForm"><i class="fa-solid fa-arrow-left"></i><span>发送栏左侧</span></button>'),
        $('<button type="button" class="menu_button" data-placement="rightSendForm"><i class="fa-solid fa-arrow-right"></i><span>发送栏右侧</span></button>'),
        $('<button type="button" class="menu_button" data-placement="qrButtons"><i class="fa-solid fa-table-cells-large"></i><span>Quick Reply 按钮栏</span></button>'),
        $('<button type="button" class="menu_button" data-placement="disabled"><i class="fa-solid fa-ban"></i><span>不使用便捷按钮</span></button>'),
    );
    const renderSelection = () => choices.find('[data-placement]').each((_, button) => {
        $(button).toggleClass('is-selected', String($(button).data('placement')) === selected);
    });
    content.append(header, choices);
    renderSelection();
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { animation: 'none' });
    quickActionPlacementPopup = popup;
    ownedPopups.add(popup);
    choices.on('click', '[data-placement]', function () {
        selected = normalizeQuickActionPlacement(String($(this).data('placement')));
        renderSelection();
    });
    confirm.on('click', async () => {
        onConfirm(selected);
        await popup.completeAffirmative();
    });
    cancel.on('click', () => void popup.completeCancelled());
    try {
        await popup.show();
    } finally {
        ownedPopups.delete(popup);
        if (quickActionPlacementPopup === popup) quickActionPlacementPopup = null;
    }
}

async function manageQuickActions() {
    if (extensionDisabled || teardownPending) return;
    const globalDraft = settings().quickActions.map(action => normalizeQuickAction(structuredClone(action)));
    const initialGlobalSnapshot = JSON.stringify(globalDraft);
    let draftPlacement = normalizeQuickActionPlacement(settings().quickActionPlacement);
    let selectedId = globalDraft[0]?.id || '';
    let detailDraft = selectedId ? structuredClone(globalDraft[0]) : null;
    let detailBaseline = detailDraft ? JSON.stringify(detailDraft) : '';
    let detailCandidates = detailDraft ? modelSuggestionsForProfile(detailDraft.profileId) : [];

    const content = $('<div class="quicker-api__quick-manager">');
    const header = $('<header class="quicker-api__quick-header">');
    const title = $('<div class="quicker-api__quick-title"><i class="fa-solid fa-bolt"></i><span>便捷按钮管理</span></div>');
    const placementButton = $('<button type="button" class="menu_button" title="入口位置" aria-label="设置便捷入口位置"><i class="fa-solid fa-gear"></i><span>位置设置</span></button>');
    const saveAll = $('<button type="button" class="menu_button quicker-api__save-button" title="保存全部方案到 SillyTavern" aria-label="保存全部方案到 SillyTavern"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>');
    const close = $('<button type="button" class="menu_button" title="关闭并丢弃更改" aria-label="关闭并丢弃更改"><i class="fa-solid fa-xmark"></i></button>');
    header.append(title, $('<div class="quicker-api__quick-header-actions">').append(placementButton, saveAll, close));
    const add = $('<button class="menu_button" type="button"><i class="fa-solid fa-plus"></i><span>新增方案</span></button>');
    const list = $('<div class="quicker-api__quick-list">');
    const listItems = $('<div class="quicker-api__quick-list-items" role="listbox" aria-label="便捷方案">');
    list.append($('<div class="quicker-api__quick-list-toolbar">').append(add), listItems);
    const editor = $('<div class="quicker-api__quick-editor">');
    content.append(header, $('<div class="quicker-api__quick-columns">').append(list, editor));

    let managerSaving = false;
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', {
        animation: 'none', onClosing: () => !managerSaving || teardownPending,
    });
    let managerOpen = true;
    ownedPopups.add(popup);
    const selectAction = (id, force = false) => {
        if (!force && id === selectedId) return;
        selectedId = id;
        const action = globalDraft.find(item => item.id === selectedId) || null;
        detailDraft = action ? structuredClone(action) : null;
        detailBaseline = detailDraft ? JSON.stringify(detailDraft) : '';
        detailCandidates = detailDraft ? modelSuggestionsForProfile(detailDraft.profileId) : [];
        render();
    };
    const field = (label, control) => $('<label class="quicker-api__quick-field">').append($('<span>').text(label), control);
    const updateDetailSaveState = () => editor.toggleClass('has-unsaved-detail', Boolean(detailDraft) && JSON.stringify(detailDraft) !== detailBaseline);
    const renderEditor = () => {
        editor.empty().removeClass('has-unsaved-detail');
        if (!detailDraft) {
            editor.append($('<div class="quicker-api__empty-state">').text('新增方案后，可自由组合 preset、Profile 与 model。'));
            return;
        }
        const name = $('<input class="text_pole" type="text" maxlength="120" placeholder="留空自动命名为方案N">').val(detailDraft.name);
        const preset = $(`<select class="text_pole">${presetOptionsHtml(detailDraft.preset)}</select>`);
        const profileSelect = $(`<select class="text_pole">${profileOptionsHtml(detailDraft.profileId)}</select>`);
        const modelInput = $('<input class="text_pole" type="text" maxlength="500" placeholder="可直接输入自定义模型 ID">').val(detailDraft.model);
        const modelSelect = $('<select class="text_pole" aria-label="从配置模型列表选择"></select>');
        const refreshModels = () => {
            const models = normalizeModelList([...modelSuggestionsForProfile(detailDraft.profileId), ...detailCandidates, detailDraft.model]);
            modelSelect.empty().append($('<option value="">— 从模型列表选择 —</option>'));
            models.forEach(model => modelSelect.append($('<option>').val(model).text(model)));
            modelSelect.val(models.includes(detailDraft.model) ? detailDraft.model : '');
        };
        refreshModels();
        const fetchModels = $('<button type="button" class="menu_button" title="拉取所选 Profile 的模型"><i class="fa-solid fa-arrows-rotate"></i><span>拉取模型</span></button>');
        const modelControl = $('<div class="quicker-api__quick-model-control">').append(modelInput, modelSelect, fetchModels);
        const selectedProfileValue = () => profiles().find(item => item.id === detailDraft.profileId) || null;
        fetchModels.prop('disabled', !hasManagedModels(selectedProfileValue()?.format));
        name.on('input', () => { detailDraft.name = sanitizeName(name.val()); updateDetailSaveState(); });
        preset.on('change', () => { detailDraft.preset = normalizeText(preset.val()); updateDetailSaveState(); });
        profileSelect.on('change', () => {
            detailDraft.profileId = normalizeText(profileSelect.val());
            detailCandidates = modelSuggestionsForProfile(detailDraft.profileId);
            renderEditor();
        });
        modelSelect.on('change', () => {
            const selectedModel = normalizeText(modelSelect.val()).slice(0, 500);
            if (!selectedModel) return;
            detailDraft.model = selectedModel;
            modelInput.val(selectedModel);
            updateDetailSaveState();
        });
        modelInput.on('input', () => {
            detailDraft.model = normalizeText(modelInput.val()).slice(0, 500);
            const exists = modelSelect.find('option').filter((_, option) => option.value === detailDraft.model).length;
            modelSelect.val(exists ? detailDraft.model : '');
            updateDetailSaveState();
        });
        fetchModels.on('click', async () => {
            const profile = selectedProfileValue();
            if (!profile || !hasManagedModels(profile.format)) return toastr.info('请选择 API Profile 后拉取模型。');
            const endpoint = normalizeText(profile.endpoint);
            if (!endpoint) return toastr.warning('所选 Profile 没有可用的 Custom URL。');
            fetchModels.prop('disabled', true);
            let fetchError = null;
            const result = await enqueueOperation(async () => {
                try {
                    return await fetchModelsForProfile(structuredClone(profile), endpoint);
                } catch (error) {
                    fetchError = error;
                    return null;
                }
            });
            // The operation queue does not settle until fetchModelsForProfile's
            // finally block has restored (or fail-closed) the Custom credential.
            // If the manager closed meanwhile, never write back into its draft.
            if (!managerOpen || extensionDisabled || teardownPending) return;
            if (!result) {
                if (fetchError) console.error('[QuickerApi] Quick action model fetch failed:', fetchError);
                if (fetchError) toastr.error(`获取模型失败：${error.message}`);
                if (detailDraft) renderEditor();
                return;
            }
            if (!detailDraft || detailDraft.profileId !== profile.id) return;
            detailCandidates = normalizeModelList([...detailCandidates, ...result.models]);
            toastr.success(`通过${result.route}获取 ${result.models.length} 个模型；结果仅用于当前方案草稿。`);
            renderEditor();
        });
        const saveScheme = $('<button type="button" class="menu_button quicker-api__save-button"><i class="fa-solid fa-floppy-disk"></i><span>保存方案</span></button>');
        const cancelScheme = $('<button type="button" class="menu_button"><span>取消</span></button>');
        saveScheme.on('click', () => {
            if (!detailDraft.preset && !detailDraft.profileId && !detailDraft.model) return toastr.warning('方案至少需要 preset、Profile 或 model 中的一项。');
            const index = globalDraft.findIndex(item => item.id === selectedId);
            if (index < 0) return;
            globalDraft[index] = normalizeQuickAction(structuredClone(detailDraft), index);
            detailDraft = structuredClone(globalDraft[index]);
            detailBaseline = JSON.stringify(detailDraft);
            render();
            toastr.success('方案修改已保存；点击顶部“保存”后写入设置。');
        });
        cancelScheme.on('click', () => selectAction(selectedId, true));
        editor.append(
            $('<h4 class="quicker-api__quick-editor-title">').text('方案详情'),
            $('<div class="quicker-api__quick-editor-fields">').append(
                field('名称', name), field('预设', preset), field('配置', profileSelect), field('模型', modelControl),
            ),
            $('<div class="quicker-api__quick-editor-actions">').append(saveScheme, cancelScheme),
        );
        updateDetailSaveState();
    };
    const updateSaveState = () => saveAll.toggleClass('is-dirty', JSON.stringify(globalDraft) !== initialGlobalSnapshot);
    const render = () => {
        listItems.empty();
        globalDraft.forEach((action, index) => {
            const row = $('<div class="quicker-api__quick-item" role="option" tabindex="0">')
                .toggleClass('is-selected', action.id === selectedId)
                .attr('aria-selected', action.id === selectedId);
            const name = $('<span class="quicker-api__quick-select">').text(quickActionDisplayName(action, index)).attr('title', quickActionDisplayName(action, index));
            const makeRowButton = (label, icon, disabled, handler, danger = false) => $('<button type="button" class="menu_button">')
                .toggleClass('quicker-api__delete-button', danger).attr({ title: label, 'aria-label': label }).prop('disabled', disabled)
                .append($(`<i class="fa-solid ${icon}"></i>`)).on('click', event => { event.stopPropagation(); handler(); });
            const up = makeRowButton('上移', 'fa-arrow-up', index === 0, () => {
                [globalDraft[index - 1], globalDraft[index]] = [globalDraft[index], globalDraft[index - 1]]; render();
            });
            const down = makeRowButton('下移', 'fa-arrow-down', index === globalDraft.length - 1, () => {
                [globalDraft[index + 1], globalDraft[index]] = [globalDraft[index], globalDraft[index + 1]]; render();
            });
            const copy = makeRowButton('复制', 'fa-clone', false, () => {
                const clone = normalizeQuickAction({ ...structuredClone(action), id: makeId('quick-action'), name: `${quickActionDisplayName(action, index)} 副本` }, index + 1);
                globalDraft.splice(index + 1, 0, clone); selectAction(clone.id);
            });
            const remove = makeRowButton('删除', 'fa-trash', false, () => {
                globalDraft.splice(index, 1);
                selectAction(globalDraft[Math.min(index, globalDraft.length - 1)]?.id || '');
            }, true);
            row.append(name, up, down, copy, remove).on('click', () => selectAction(action.id)).on('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAction(action.id); }
            });
            listItems.append(row);
        });
        renderEditor();
        updateSaveState();
    };
    add.on('click', () => {
        const action = normalizeQuickAction({ id: makeId('quick-action'), sequence: globalDraft.length });
        globalDraft.push(action);
        selectAction(action.id);
    });
    placementButton.on('click', () => void chooseQuickActionPlacement(draftPlacement, value => {
        draftPlacement = value;
        settings().quickActionPlacement = value;
        scheduleSettingsSave();
        ensureQuickActionEntries();
        toastr.success('便捷入口位置已应用。');
    }));
    close.on('click', () => void popup.completeCancelled());
    saveAll.on('click', async () => {
        if (detailDraft && JSON.stringify(detailDraft) !== detailBaseline) return toastr.warning('当前方案还有未确认的修改，请先点击“保存方案”或“取消”。');
        const invalid = globalDraft.find(action => !action.preset && !action.profileId && !action.model);
        if (invalid) return toastr.warning('请先点击“保存方案”确认每个方案；每项至少需要 preset、Profile 或 model。');
        const validProfileIds = new Set(profiles().map(profile => profile.id));
        if (globalDraft.some(action => action.profileId && !validProfileIds.has(action.profileId))) return toastr.warning('方案引用了已不存在的 Profile，请重新选择并保存方案。');
        const validPresetNames = new Set($('#settings_preset_openai option').map((_, option) => normalizeText(option.textContent)).get());
        if (globalDraft.some(action => action.preset && !validPresetNames.has(action.preset))) return toastr.warning('方案引用了已不存在的 preset，请重新选择并保存方案。');
        globalDraft.forEach((action, index) => {
            action.name = sanitizeName(action.name) || `方案${index + 1}`;
            action.sequence = index;
        });
        if (managerSaving) return;
        managerSaving = true;
        content.find('.quicker-api__quick-columns').prop('inert', true);
        placementButton.prop('disabled', true);
        settings().quickActions = structuredClone(globalDraft);
        settings().quickActionPlacement = draftPlacement;
        saveAll.prop('disabled', true);
        close.prop('disabled', true);
        const saved = await persistSettingsNow();
        managerSaving = false;
        content.find('.quicker-api__quick-columns').prop('inert', false);
        placementButton.prop('disabled', false);
        saveAll.prop('disabled', false);
        close.prop('disabled', false);
        if (saved && managerOpen) {
            ensureQuickActionEntries();
            toastr.success('便捷方案已保存到 SillyTavern。');
            void popup.completeAffirmative();
        }
    });
    render();
    let result = null;
    try {
        result = await popup.show();
    } finally {
        managerOpen = false;
        ownedPopups.delete(popup);
    }
    if (!result || extensionDisabled || teardownPending) return;
    ensureQuickActionEntries();
}

function findFormatForCurrentSource() {
    return Object.keys(FORMATS).find(format => isFormatSupported(format) && matchesFormat(format)) || '';
}

function applyExplicitModel(model, preferredFormat = '') {
    const value = normalizeText(model);
    if (!value) return true;
    if (platform.isModelAction(value)) return false;
    const inferredFormat = preferredFormat || findFormatForCurrentSource();
    if (!Object.hasOwn(FORMATS, inferredFormat)) return false;
    const format = inferredFormat;
    const config = FORMATS[format];
    const input = $(config.modelInput);
    if (!input.length) return false;
    if (isCustomFormat(format)) {
        oai_settings[config.modelField] = value;
        input.val(value).trigger('input');
    } else {
        if (!input.find('option').filter((_, option) => option.value === value).length) {
            input.append($('<option data-quicker-api-custom="true">').val(value).text(`${value} (Custom)`));
        }
        input.val(value).trigger('change');
        oai_settings[config.modelField] = value;
    }
    return String(input.val() || '') === value && String(oai_settings[config.modelField] || '') === value;
}

function waitForPresetAfter(expectedName, token) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(warningTimer);
            eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, listener);
            if (quickPresetWaitCancel === cancel) quickPresetWaitCancel = null;
            resolve(value);
        };
        const cancel = () => finish(false);
        const listener = async () => {
            if (token !== quickActionTransaction) return finish(false);
            await operationQueue;
            finish(currentPresetName() === expectedName);
        };
        const warningTimer = setTimeout(() => {
            if (!settled && token === quickActionTransaction) {
                toastr.warning('Preset 仍在应用或回滚中；为避免凭据错配，生成保持阻断。后续便捷方案会在本次事务完成后执行。');
            }
        }, 30000);
        quickPresetWaitCancel = cancel;
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, listener);
    });
}

async function selectPresetForQuickAction(name, token) {
    const option = $('#settings_preset_openai option').filter((_, item) => normalizeText(item.textContent) === name).first();
    if (!option.length || token !== quickActionTransaction) return false;
    const after = waitForPresetAfter(name, token);
    $('#settings_preset_openai').val(option.val()).trigger('change');
    return await after;
}

async function applyProfileById(profileId, token = quickActionTransaction, { applyModel = true, manageTransition = true } = {}) {
    const profile = profiles().find(item => item.id === profileId);
    if (!profile || token !== quickActionTransaction) return false;
    const generation = ++profileSelectionGeneration;
    settings().selectedProfileId = profile.id;
    scheduleSettingsSave();
    renderProfiles(profile.id);
    if (manageTransition) beginPresetTransition();
    try {
        return await enqueueOperation(async () => {
            if (token !== quickActionTransaction || generation !== profileSelectionGeneration) return false;
            return await applyProfile(profile, generation, true, applyModel);
        });
    } finally {
        if (manageTransition) endPresetTransition();
    }
}

async function runQuickAction(action, token) {
    if (extensionDisabled || teardownPending || token !== quickActionTransaction) return;
    closeQuickActionMenu();
    beginPresetTransition();
    quickActionBlockingToken = token;
    try {
        if (action.preset && !await selectPresetForQuickAction(action.preset, token)) {
            if (token === quickActionTransaction) toastr.error('便捷方案的 preset 不存在或切换未完成。');
            return;
        }
        if (token !== quickActionTransaction) return;
        let profile = null;
        if (action.profileId) {
            profile = profiles().find(item => item.id === action.profileId) || null;
            const applyModel = !action.preset && !action.model;
            if (!profile || !await applyProfileById(action.profileId, token, { applyModel, manageTransition: false })) {
                if (token === quickActionTransaction) toastr.error('便捷方案的 Profile 未能安全应用。');
                return;
            }
        }
        if (token !== quickActionTransaction) return;
        if (action.model && !applyExplicitModel(action.model, profile?.format || '')) {
            toastr.error('便捷方案模型写入验证失败。');
            return;
        }
        if (token !== quickActionTransaction) return;
        renderProfiles(settings().selectedProfileId);
        if (action.model) renderModelControl(profile || selectedProfile(), action.model);
        toastr.success(`已应用${quickActionDisplayName(action)}。`);
    } finally {
        if (quickActionBlockingToken === token) {
            quickActionBlockingToken = 0;
            endPresetTransition();
        }
    }
}

async function waitForStableOperationQueue(timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (!extensionDisabled && !teardownPending) {
        const snapshot = operationQueue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timeoutId = null;
        const settled = await Promise.race([
            snapshot.then(() => true, () => true),
            new Promise(resolve => {
                timeoutId = setTimeout(() => resolve(false), remaining);
            }),
        ]).finally(() => clearTimeout(timeoutId));
        if (!settled || extensionDisabled || teardownPending) return false;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (operationQueue === snapshot) return true;
    }
    return false;
}

function queueQuickAction(action) {
    const snapshot = structuredClone(action);
    const run = async () => {
        if (extensionDisabled || teardownPending) return;
        const queueIdle = await waitForStableOperationQueue(30000);
        if (!queueIdle || extensionDisabled || teardownPending) {
            if (!extensionDisabled && !teardownPending) toastr.error('Quicker Api 仍有未完成操作，便捷方案已取消。');
            return;
        }
        const token = ++quickActionTransaction;
        profileSelectionGeneration++;
        return await runQuickAction(snapshot, token);
    };
    // Keep actions strictly sequential. A newer click must never cancel an
    // in-flight credential rollback and release its generation block early.
    quickActionQueue = quickActionQueue.then(run, run);
    return quickActionQueue;
}

function closeQuickActionMenu() {
    quickActionPopper?.destroy?.();
    quickActionPopper = null;
    quickActionMenu?.remove();
    quickActionMenu = null;
    $(document).off('.quickerApiMenu');
    $(window).off('.quickerApiMenu');
    $(globalThis.visualViewport).off('.quickerApiMenu');
}

function openQuickActionMenu(anchor, placement) {
    if (quickActionMenu?.data('anchor') === anchor) return closeQuickActionMenu();
    closeQuickActionMenu();
    const actions = [...settings().quickActions].sort((a, b) => a.sequence - b.sequence);
    const menu = $('<ul class="list-group ctx-menu quicker-api__quick-menu" role="list" tabindex="-1">').data('anchor', anchor).appendTo(document.body);
    quickActionMenu = menu;
    const settingsItem = $('<li class="list-group-item ctx-header quicker-api__quick-manage" role="listitem" tabindex="0" data-quicker-api-actionable="true" title="便捷按钮管理">')
        .append(
            $('<div class="qr--button-icon fa-solid fa-gear">'),
            $('<div class="qr--button-label">').text('设置'),
        )
        .on('click', () => { closeQuickActionMenu(); void manageQuickActions(); });
    menu.append(settingsItem);
    if (!actions.length) menu.append($('<li class="list-group-item ctx-item quicker-api__quick-menu-empty" role="listitem" aria-disabled="true">').append(
        $('<div class="qr--button-icon fa-solid qr--hidden">'),
        $('<div class="qr--button-label">').text('暂无方案'),
    ));
    actions.forEach((action, index) => {
        const name = quickActionDisplayName(action, index);
        menu.append($('<li class="list-group-item ctx-item" role="listitem" tabindex="0" data-quicker-api-actionable="true">')
            .attr('title', name)
            .append(
                $('<div class="qr--button-icon fa-solid qr--hidden">'),
                $('<div class="qr--button-label">').text(name),
            )
            .on('click', () => { closeQuickActionMenu(); void queueQuickAction(action); }));
    });
    const actionable = () => menu.find('[data-quicker-api-actionable="true"]');
    menu.on('keydown', '[data-quicker-api-actionable="true"]', event => {
        const items = actionable();
        const index = items.index(event.currentTarget);
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.eq(next).trigger('focus');
    });
    quickActionPopper = globalThis.Popper?.createPopper?.(anchor, menu[0], {
        placement: placement === 'qrButtons' ? 'bottom-start' : placement === 'leftSendForm' ? 'top-start' : 'top-end',
        modifiers: [
            { name: 'offset', options: { offset: [0, 8] } },
            { name: 'preventOverflow', options: { padding: 8 } },
            { name: 'computeStyles', options: { gpuAcceleration: false } },
        ],
    }) || null;
    if (!quickActionPopper) {
        const rect = anchor.getBoundingClientRect();
        menu.css({ position: 'fixed', left: `${Math.max(8, Math.min(rect.left, innerWidth - menu.outerWidth() - 8))}px`, top: `${Math.max(8, rect.top - menu.outerHeight() - 8)}px` });
    }
    const closeOnViewport = () => closeQuickActionMenu();
    $(document).on('pointerdown.quickerApiMenu', event => {
        if (!menu[0].contains(event.target) && !anchor.contains(event.target)) closeQuickActionMenu();
    }).on('focusin.quickerApiMenu', event => {
        if (!menu[0].contains(event.target) && event.target !== anchor) closeQuickActionMenu();
    }).on('keydown.quickerApiMenu', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeQuickActionMenu(); anchor.focus?.(); }
        if (event.key === 'Tab') closeQuickActionMenu();
    });
    $(window).on('resize.quickerApiMenu scroll.quickerApiMenu blur.quickerApiMenu', closeOnViewport);
    $(globalThis.visualViewport).on('resize.quickerApiMenu scroll.quickerApiMenu', closeOnViewport);
    actionable().first().trigger('focus');
}

function makeQuickActionEntry(id, placement) {
    const entry = placement !== 'qrButtons'
        ? $('<div class="quicker-api__quick-entry fa-solid fa-bolt interactable" role="button" tabindex="0" aria-label="Quicker Api 便捷方案" title="Quicker Api 便捷方案"></div>')
        : $('<button type="button" class="qr--button quicker-api__quick-entry" aria-label="Quicker Api 便捷方案" title="Quicker Api 便捷方案"><i class="fa-solid fa-bolt"></i><span>Quicker Api</span></button>');
    return entry.attr('id', id)
        .on('click.quickerApi', event => { event.stopPropagation(); openQuickActionMenu(event.currentTarget, placement); })
        .on('keydown.quickerApi', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openQuickActionMenu(event.currentTarget, placement); }
        });
}

function activeQuickReplyButtonContainer() {
    const candidates = $('#qr--bar > .qr--buttons, #qr--popout > .qr--body > .qr--buttons');
    const visible = candidates.filter(':visible').first();
    return visible.length ? visible : candidates.first();
}

function ensureQuickActionEntries() {
    if (extensionDisabled || teardownPending) return;
    const placement = normalizeQuickActionPlacement(settings().quickActionPlacement);
    if (placement === 'disabled') {
        $('#quicker_api_quick_left, #quicker_api_quick_right, [data-quicker-api-qr-entry]').remove();
        closeQuickActionMenu();
        return;
    }
    if (placement === 'leftSendForm') {
        $('#quicker_api_quick_right, [data-quicker-api-qr-entry]').remove();
        if (!document.getElementById('quicker_api_quick_left')) {
            const extensionsButton = document.getElementById('extensionsMenuButton');
            if (!extensionsButton?.parentElement) return;
            extensionsButton.insertAdjacentElement('afterend', makeQuickActionEntry('quicker_api_quick_left', placement)[0]);
        }
        return;
    }
    if (placement === 'rightSendForm') {
        $('#quicker_api_quick_left, [data-quicker-api-qr-entry]').remove();
        if (!document.getElementById('quicker_api_quick_right')) {
            const sendButton = document.getElementById('send_but');
            const entry = makeQuickActionEntry('quicker_api_quick_right', placement)[0];
            sendButton?.parentElement?.insertBefore(entry, sendButton);
        }
        return;
    }
    $('#quicker_api_quick_left, #quicker_api_quick_right').remove();
    const container = activeQuickReplyButtonContainer();
    if (!container.length) return;
    const current = $('[data-quicker-api-qr-entry]');
    if (current.length && current.parent()[0] === container[0]) return;
    current.remove();
    makeQuickActionEntry('quicker_api_quick_qr', placement).attr('data-quicker-api-qr-entry', 'true').prependTo(container);
}

function scheduleQuickActionEntries() {
    if (quickActionRenderPending || extensionDisabled) return;
    quickActionRenderPending = true;
    queueMicrotask(() => { quickActionRenderPending = false; ensureQuickActionEntries(); });
}

function handleNativePresetChangeBefore({ presetName } = {}) {
    if (extensionDisabled) return;
    platform.rememberParameterEditors();
    const generation = ++profileSelectionGeneration;
    clearTimeout(presetChangeTimer);
    beginPresetTransition();
    const name = normalizeText(presetName || currentPresetName());
    const profile = profiles().find(item => item.id === settings().presetBindings[name]);
    if (profile) {
        settings().selectedProfileId = profile.id;
        scheduleSettingsSave();
        renderProfiles(profile.id);
    }
    return enqueueOperation(async () => {
        if (profile && generation === profileSelectionGeneration) {
            await applyProfile(profile, generation, true, false);
        }
    });
}

async function handleNativePresetChange() {
    if (extensionDisabled) return false;
    platform.syncParameterEditors();
    beginPresetTransition();
    const generation = ++profileSelectionGeneration;
    const quickActionOwnsBlock = Boolean(quickActionBlockingToken);
    clearTimeout(presetChangeTimer);
    const presetName = currentPresetName();
    const profileId = settings().presetBindings[presetName];
    const profile = profiles().find(item => item.id === profileId);
    try {
        if (!profile) {
            // Unbound imports still apply native model/connection deltas. A model
            // change alone does not invalidate a previously verified connection,
            // but a changed endpoint, format, proxy credential or parameters does.
            const active = profiles().find(item => item.id === settings().activeProfileId);
            if (!active || !profileMatchesNative(active, { includeModel: false })) {
                settings().activeProfileId = null;
            }
            scheduleSettingsSave();
            const selected = selectedProfile();
            // A selected Profile owns its editor, including unsaved URL/key/model
            // drafts. An unrelated native preset must not become its save input.
            if (selected) {
                if (settings().activeProfileId === selected.id) {
                    renderModelControl(selected, String(oai_settings[FORMATS[selected.format].modelField] || ''));
                    editorModelBaseline = getEditorModel(selected.format);
                }
                renderStatus();
                return false;
            }
            renderProfiles(settings().selectedProfileId);
            // Native input events were suppressed during the transition. Read
            // the final native model explicitly instead of the Profile default;
            // never write a previous editor model back into an imported preset.
            const format = Object.keys(FORMATS).find(key => isFormatSupported(key) && matchesFormat(key));
            if (format) {
                const selected = selectedProfile();
                $('#quicker_api_format').val(format);
                $('#quicker_api_url').val(nativeEndpoint(format));
                renderOpenCodeFields(null, format);
                renderModelControl(selected?.format === format ? selected : null, String(oai_settings[FORMATS[format].modelField] || ''));
                editorModelBaseline = getEditorModel(format);
                updateCredentialEditor(settings().activeProfileId === selected?.id ? selected : null);
            }
            setStatus('当前 preset 未绑定。', 'warning');
            return false;
        }
        return await enqueueOperation(async () => {
            if (generation !== profileSelectionGeneration) return false;
            const applied = await applyProfile(profile, generation, true, false);
            if (applied) restoreBoundPresetModel(presetName, profile);
            else setStatus('所选 Profile 未应用。', 'warning');
            return applied;
        });
    } finally {
        if (!quickActionOwnsBlock) endPresetTransition();
    }
}

function handlePresetRenamed({ apiId, oldName, newName } = {}) {
    if (extensionDisabled || apiId !== 'openai' || !oldName || !newName) return;
    const profileId = settings().presetBindings[oldName];
    if (!profileId) return;
    delete settings().presetBindings[oldName];
    settings().presetBindings[newName] = profileId;
    if (Object.hasOwn(settings().presetModels, oldName)) {
        settings().presetModels[newName] = settings().presetModels[oldName];
        delete settings().presetModels[oldName];
    }
    scheduleSettingsSave();
    renderProfiles(settings().selectedProfileId);
}

function handlePresetDeleted({ apiId, name } = {}) {
    if (extensionDisabled || apiId !== 'openai' || !name || !settings().presetBindings[name]) return;
    delete settings().presetBindings[name];
    delete settings().presetModels[name];
    scheduleSettingsSave();
    // Removing a binding does not change the selected Profile or its draft.
    renderStatus();
}

function restoreBoundPresetModel(name, profile) {
    const model = boundPresetModel(name, profile);
    renderModelControl(profile, model);
    syncEditorModelToNative();
    editorModelBaseline = getEditorModel(profile.format);
    renderStatus();
}

function bindPresetAfterVerifiedSave(name, intent, preset) {
    if (extensionDisabled || teardownPending) return;
    const presetName = normalizeText(name);
    const profile = profiles().find(item => item.id === intent.profileId);
    if (!presetName || !profile || profile.format !== intent.format) return;
    const config = FORMATS[profile.format];
    if (!matchesFormat(profile.format, preset) || typeof preset[config.modelField] !== 'string') return;
    settings().presetBindings[presetName] = profile.id;
    settings().presetModels[presetName] = presetModelSnapshot(profile, preset[config.modelField]);
    if (currentPresetName() === presetName && selectedProfile()?.id === profile.id
        && getEditorModel() === normalizeText(preset[config.modelField])) {
        editorModelBaseline = getEditorModel();
    }
    scheduleSettingsSave();
    renderStatus();
}

function clearNativePresetSaveIntent() {
    nativePresetSaveIntent = null;
    clearInterval(nativeCreateMonitor);
    clearTimeout(nativeIntentExpiry);
    nativeCreateMonitor = null;
    nativeIntentExpiry = null;
}

function monitorNativeCreatePopup(intent) {
    let popupSeen = false;
    nativeCreateMonitor = setInterval(() => {
        if (nativePresetSaveIntent !== intent) return clearInterval(nativeCreateMonitor);
        const popupOpen = Boolean(document.querySelector('dialog.popup[open], .popup[open]'));
        popupSeen ||= popupOpen;
        if ((popupSeen && !popupOpen) || Date.now() > intent.expiresAt) clearNativePresetSaveIntent();
    }, 100);
}

function requestPath(resource) {
    try {
        const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource?.url, globalThis.location.href);
        return url.origin === globalThis.location.origin ? url.pathname : '';
    } catch {
        return '';
    }
}

async function requestJson(resource, options) {
    try {
        if (typeof options?.body === 'string') return JSON.parse(options.body);
        if (typeof Request !== 'undefined' && resource instanceof Request && !options?.body) return await resource.clone().json();
    } catch {
        // An unrelated/non-JSON request must pass through unchanged.
    }
    return null;
}

function matchesPresetSaveIntent(intent, body) {
    if (!intent || extensionDisabled || teardownPending || Date.now() > intent.expiresAt) return false;
    if (intent.generation !== profileSelectionGeneration || pendingOperations || presetTransitionBlocked) return false;
    if (body?.apiId !== 'openai' || !normalizeText(body.name)) return false;
    if (intent.type === 'update' && normalizeText(body.name) !== intent.presetName) return false;
    const profile = selectedProfile();
    if (profile?.id !== intent.profileId || settings().activeProfileId !== profile.id || profile.format !== intent.format) return false;
    const config = FORMATS[intent.format];
    return matchesFormat(intent.format, body.preset)
        && normalizeText(body.preset[config.modelField]) === intent.model
        && normalizeText(body.preset[config.endpointField]) === normalizeText(profile.endpoint);
}

function installPresetSaveObserver() {
    if (originalFetch) return;
    const stableFetchDelegate = globalThis.fetch;
    originalFetch = stableFetchDelegate;
    presetObservedFetch = async function quickerApiObservedFetch(resource, options = {}) {
        const path = requestPath(resource);
        const method = String(options.method || resource?.method || 'GET').toUpperCase();
        const intent = nativePresetSaveIntent;
        let body = null;
        let observedIntent = null;
        let settingsObservation = null;
        const settingsSequence = ++settingsRequestSequence;
        if (method === 'POST' && !extensionDisabled && !teardownPending) {
            settingsObservation = await inspectSettingsSave({
                path, resource, options, moduleName: MODULE_NAME, baselineSnapshot: confirmedSettingsSnapshot,
            });
        }
        if (method === 'POST' && path === '/api/presets/save' && intent) {
            body = await requestJson(resource, options);
            if (nativePresetSaveIntent === intent && matchesPresetSaveIntent(intent, body)) {
                observedIntent = intent;
                clearNativePresetSaveIntent();
                latestPresetSaves.set(normalizeText(body.name), intent.sequence);
            }
        }
        // Keep a stable delegate: later extensions may still call this wrapper
        // after teardown. Never mutate the request, response, or their bodies.
        let response;
        try {
            response = await stableFetchDelegate.apply(this, arguments);
        } catch (error) {
            if (settingsObservation) finishSettingsSave(settingsObservation.snapshot, false);
            throw error;
        }
        if (settingsObservation) {
            const success = await settingsObservation.succeeded(response);
            if (settingsSequence >= confirmedSettingsSequence) {
                if (success) confirmedSettingsSequence = settingsSequence;
                finishSettingsSave(settingsObservation.snapshot, success);
            }
        }
        if (!observedIntent || !response.ok || extensionDisabled || teardownPending) return response;
        try {
            const result = await response.clone().json();
            const savedName = normalizeText(result?.name);
            const validName = savedName && (observedIntent.type === 'create' || savedName === observedIntent.presetName);
            if (validName && latestPresetSaves.get(normalizeText(body.name)) === observedIntent.sequence) {
                bindPresetAfterVerifiedSave(savedName, observedIntent, body.preset);
            }
        } catch (error) {
            console.warn('[QuickerApi] Could not verify native preset save response:', error);
        }
        return response;
    };
    globalThis.fetch = presetObservedFetch;
}

function captureNativePresetSave(event, type) {
    clearNativePresetSaveIntent();
    if (extensionDisabled || teardownPending) return;
    if (!SUPPORTED_SOURCES.has(oai_settings.chat_completion_source)) return;
    const profile = selectedProfile();
    const stop = message => {
        event.preventDefault();
        event.stopImmediatePropagation();
        toastr.warning(message);
    };
    if (pendingOperations || presetTransitionBlocked) return stop('API 配置正在切换，请完成后再保存预设。');
    if (!profile) return; // Leave purely native saves/new unsaved Profiles alone.
    if (settings().activeProfileId !== profile.id) return stop('所选 API 配置尚未安全应用，请先应用或保存 API 配置。');
    if (profile.format !== normalizeFormat($('#quicker_api_format').val())
        || FORMATS[profile.format].source !== oai_settings.chat_completion_source
        || (profile.format === 'opencode' && $('#quicker_api_opencode_format').val() !== profile.opencodeApiFormat)
        || normalizeText($('#quicker_api_url').val()) !== normalizeText(profile.endpoint)
        || (keyEditorDirty && normalizeText($('#quicker_api_key_input').val()))) {
        return stop('URL、Key 或格式有未保存修改，请先点击 Quicker Api 的“保存 API 设置”。仅切换模型无需这一步。');
    }
    // Native saveOpenAIPreset snapshots oai_settings synchronously in its click
    // handler. Synchronize BEFORE that handler, not after observing its fetch.
    syncEditorModelToNative();
    const intent = {
        type, profileId: profile.id, format: profile.format, model: getEditorModel(),
        presetName: currentPresetName(), generation: profileSelectionGeneration,
        sequence: ++presetSaveSequence, expiresAt: Date.now() + (type === 'create' ? 120000 : 5000),
    };
    nativePresetSaveIntent = intent;
    nativeIntentExpiry = setTimeout(() => {
        if (nativePresetSaveIntent === intent) clearNativePresetSaveIntent();
    }, type === 'create' ? 120000 : 5000);
    if (type === 'create') monitorNativeCreatePopup(intent);
}

function bindNativePresetSaveCapture() {
    nativePresetCaptureHandlers.update = event => captureNativePresetSave(event, 'update');
    nativePresetCaptureHandlers.create = event => captureNativePresetSave(event, 'create');
    nativePresetCaptureHandlers.cancel = event => {
        if (nativePresetSaveIntent?.type !== 'create') return;
        if ((event.type === 'keydown' && event.key === 'Escape')
            || (event.type === 'click' && event.target?.closest?.('.popup-button-cancel, .popup-button-close'))) {
            clearNativePresetSaveIntent();
        }
    };
    document.addEventListener('click', nativePresetCaptureHandlers.cancel, true);
    document.addEventListener('keydown', nativePresetCaptureHandlers.cancel, true);
    document.getElementById('update_oai_preset')?.addEventListener('click', nativePresetCaptureHandlers.update, true);
    document.getElementById('new_oai_preset')?.addEventListener('click', nativePresetCaptureHandlers.create, true);
}

function bindEvents() {
    installPresetSaveObserver();
    bindNativePresetSaveCapture();
    $('#quicker_api_toggle').on('click', togglePanel);
    window.addEventListener('pagehide', flushPanelState);
    window.addEventListener('beforeunload', warnBeforeLeaving);
    $('#quicker_api_profile_select').on('change', function () {
        clearKeyEditor();
        const profile = profiles().find(item => item.id === String($(this).val())) || null;
        settings().selectedProfileId = profile?.id || null;
        scheduleSettingsSave();
        if (!profile) return renderStatus();
        $('#quicker_api_format').val(profile.format);
        void applyProfileById(profile.id, quickActionTransaction, { applyModel: true, manageTransition: true });
    });
    $('#quicker_api_format').on('change', function () {
        clearKeyEditor();
        const format = normalizeFormat($(this).val());
        const source = FORMATS[format].source;
        platform.selectSource(source, FORMATS[format].apiFormat);
        $('#quicker_api_url').val(nativeEndpoint(format));
        const profile = selectedProfile()?.format === format ? selectedProfile() : null;
        renderOpenCodeFields(profile, format);
        renderModelControl(profile);
        updateCredentialEditor(profile);
        renderStatus();
    });
    $('#quicker_api_new').on('click', createProfile);
    $('#quicker_api_quick_url').on('click', toggleQuickUrlMenu);
    $('#quicker_api_additional_parameters').on('click', () => $('#customize_additional_parameters').trigger('click'));
    $('#quicker_api_save').on('click', () => void enqueueOperation(saveSelectedProfile));
    $('#quicker_api_rename').on('click', renameSelectedProfile);
    $('#quicker_api_copy').on('click', copySelectedProfile);
    $('#quicker_api_import_native').on('click', () => void enqueueOperation(importNativeProfile));
    $('#quicker_api_delete').on('click', deleteSelectedProfile);
    $('#quicker_api_reveal_key').on('click', () => void enqueueOperation(revealBoundSecret));
    $('#quicker_api_copy_key').on('click', () => void enqueueOperation(copyBoundSecret));
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, handleNativePresetChangeBefore);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, handleNativePresetChange);
    eventSource.on(event_types.PRESET_RENAMED, handlePresetRenamed);
    eventSource.on(event_types.PRESET_DELETED, handlePresetDeleted);
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, guardGenerationWhenBlocked);
    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, guardGenerationWhenBlocked);
    $('#quicker_api_url').on('input', function () {
        const format = normalizeFormat($('#quicker_api_format').val());
        const proxyMode = usesProxyProfile(format, normalizeText($(this).val()));
        $('#quicker_api_native_key_manager').attr('data-key', FORMATS[format].secretKey).data('key', FORMATS[format].secretKey).toggle(!proxyMode);
        renderStatus();
    });
    $('#quicker_api_opencode_format').on('change', renderStatus);
    $('#quicker_api_key_input').on('input', () => { keyEditorDirty = true; renderStatus(); });
    $(document).on('input.quickerApi', '#custom_include_body, #custom_exclude_body, #custom_include_headers', renderStatus);
    $(document).on('change.quickerApi', '#quicker_api_custom_model, #quicker_api_provider_model', () => {
        syncEditorModelToNative();
        updateModelTrigger();
        renderStatus();
    });
    bindModelPickerEvents();
    $(document).on('click.quickerApi', '#quicker_api_add_model', addCustomModel);
    $(document).on('click.quickerApi', '#quicker_api_fetch_models', () => void enqueueOperation(fetchCustomModels));
    $(document).on('click.quickerApi', '#quicker_api_manage_models', manageCustomModels);
    $(document).on('click.quickerApi', '.quicker-api__manage-actions', () => void manageQuickActions());
    $('#custom_model_id').on('input.quickerApi', handleNativeModelChange);
    $('#model_claude_select, #model_google_select, #model_opencode_select').on('change.quickerApi', handleNativeModelChange);
    eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, handleNativeModelChange);
    $('#chat_completion_source').on('change.quickerApi', function () {
        platform.syncParameterEditors();
        updatePanelVisibility();
        // Preset-driven source changes are reconciled by the AFTER handler.
        if (presetTransitionBlocked) return;
        const entry = Object.entries(FORMATS).find(([format]) => isFormatSupported(format) && matchesFormat(format));
        if (!entry) return;
        $('#quicker_api_format').val(entry[0]);
        const profile = selectedProfile()?.format === entry[0] ? selectedProfile() : null;
        renderProfileEditor(profile);
        updateCredentialEditor(profile);
        renderStatus();
    });
    $(document).on('click.quickerApi', '.secretKeyManager button, .secretKeyManager .menu_button', () => setTimeout(renderStatus, 250));
    ensureQuickActionEntries();
}

function updateAdditionalParametersButton() {
    const supported = SUPPORTED_SOURCES.has(String($('#chat_completion_source').val()));
    $('#quicker_api_additional_parameters').toggle(supported);
}

function configureAdditionalParametersPopup() {
    platform.rememberParameterEditors();
    const excludeInput = document.getElementById('custom_exclude_body');
    if (!excludeInput || excludeInput.dataset.quickerApiConfigured === 'true') return;
    excludeInput.dataset.quickerApiConfigured = 'true';
    const format = normalizeFormat($('#quicker_api_format').val());
    if (supportsCustomParameters(format)) return;
    const root = $(excludeInput).closest('.height100p');
    root.addClass('quicker-api__exclude-only-popup');
    root.children('h3').removeAttr('data-i18n').text('排除主体参数');
    root.find('#custom_include_body, #custom_include_headers')
        .closest('.flex1.flex-container.flexFlowColumn')
        .hide();
    $('<small class="quicker-api__exclude-only-hint">')
        .text('这些顶层字段会在请求发送前移除，适用于当前 Anthropic / Gemini Profile。')
        .insertBefore($(excludeInput).closest('.flex1.flex-container.flexFlowColumn'));
}

function updatePanelVisibility() {
    const supported = SUPPORTED_SOURCES.has(String($('#chat_completion_source').val()));
    $('#quicker_api').toggle(supported);
    updateAdditionalParametersButton();
    if (supported) {
        $('#custom_form, #claude_form, #makersuite_form').addClass('quicker-api__native-provider');
    } else {
        $('#custom_form, #claude_form, #makersuite_form').removeClass('quicker-api__native-provider');
    }
}

async function restoreInitialProfileSelection() {
    const currentPreset = currentPresetName();
    const boundId = currentPreset ? settings().presetBindings[currentPreset] : '';
    let target = profiles().find(profile => profile.id === boundId) || null;
    if (!target) target = profiles().find(profile => profile.id === settings().selectedProfileId) || null;
    if (!target) target = profiles().find(profile => profile.id === settings().activeProfileId) || null;
    if (!target) target = profiles().find(profile => profileMatchesNative(profile)) || null;
    if (!target && profiles().length === 1) target = profiles()[0];
    settings().selectedProfileId = target?.id || null;
    settings().activeProfileId = null;
    scheduleSettingsSave();
    renderProfiles(target?.id || null);
    if (!target) return;
    const generation = ++profileSelectionGeneration;
    beginPresetTransition();
    try {
        const isBound = target.id === boundId;
        const applied = await applyProfile(target, generation, true, !isBound);
        if (applied && isBound) restoreBoundPresetModel(currentPreset, target);
        if (!applied) renderStatus('所选 Profile 未应用。');
    } finally {
        endPresetTransition();
    }
}

async function teardownQuickerApi() {
    if (teardownPending || extensionDisabled) return false;
    teardownPending = true;
    flushPanelState();
    window.removeEventListener('pagehide', flushPanelState);
    beginPresetTransition();
    setOperationControlsDisabled(true);
    quickActionObserver?.disconnect();
    quickActionObserver = null;
    closeQuickActionMenu();
    closeQuickUrlMenu();
    quickActionPlacementPopup = null;
    $('#quicker_api_quick_left, #quicker_api_quick_right, [data-quicker-api-qr-entry]').remove();
    quickPresetWaitCancel?.();
    quickPresetWaitCancel = null;
    await cancelOwnedPopups();
    for (const controller of [...activeFetchControllers]) controller.abort();
    quickActionTransaction++;
    profileSelectionGeneration++;
    clearTimeout(presetChangeTimer);
    presetChangeTimer = null;

    // Keep the generation guard active until every already-started credential
    // operation has observed the stale generation and completed rollback.
    await quickActionQueue.catch(() => undefined);
    let stableQueue = null;
    do {
        stableQueue = operationQueue;
        await stableQueue.catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 0));
    } while (operationQueue !== stableQueue);

    extensionDisabled = true;
    teardownPending = false;
    quickActionBlockingToken = 0;
    endPresetTransition({ force: true });
    quickActionRenderPending = false;
    clearKeyEditor();
    $('#quicker_api').remove();
    unbindModelPickerPosition();
    $('#quicker_api_model_portal').remove();
    $('#custom_form, #claude_form, #makersuite_form').removeClass('quicker-api__native-provider');
    $(document).off('.quickerApi').off('.quickerApiMenu');
    $(window).off('.quickerApiMenu');
    $(globalThis.visualViewport).off('.quickerApiMenu');
    $('#custom_api_url_text, #custom_model_id, #openai_reverse_proxy, #model_claude_select, #model_google_select, #model_opencode_select, #chat_completion_source').off('.quickerApi');
    eventSource.removeListener(event_types.CHATCOMPLETION_MODEL_CHANGED, handleNativeModelChange);
    eventSource.removeListener(event_types.OAI_PRESET_CHANGED_BEFORE, handleNativePresetChangeBefore);
    eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, handleNativePresetChange);
    eventSource.removeListener(event_types.PRESET_RENAMED, handlePresetRenamed);
    eventSource.removeListener(event_types.PRESET_DELETED, handlePresetDeleted);
    eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, guardGenerationWhenBlocked);
    const updateButton = document.getElementById('update_oai_preset');
    const createButton = document.getElementById('new_oai_preset');
    if (nativePresetCaptureHandlers.update) updateButton?.removeEventListener('click', nativePresetCaptureHandlers.update, true);
    if (nativePresetCaptureHandlers.create) createButton?.removeEventListener('click', nativePresetCaptureHandlers.create, true);
    if (nativePresetCaptureHandlers.cancel) {
        document.removeEventListener('click', nativePresetCaptureHandlers.cancel, true);
        document.removeEventListener('keydown', nativePresetCaptureHandlers.cancel, true);
    }
    delete nativePresetCaptureHandlers.update;
    delete nativePresetCaptureHandlers.create;
    delete nativePresetCaptureHandlers.cancel;
    clearNativePresetSaveIntent();
    clearTimeout(settingsSaveTimer);
    for (const waiter of [...settingsSaveWaiters]) waiter.complete(false);
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    latestPresetSaves.clear();
    platform.dispose();
    if (presetObservedFetch && globalThis.fetch === presetObservedFetch) globalThis.fetch = originalFetch;
    originalFetch = null;
    presetObservedFetch = null;
    return true;
}

function detectConflict() {
    if (!document.getElementById('apihub_container')) return false;
    toastr.warning('Quicker Api 与 API Hub 都会管理连接；Quicker Api 已停止注入以避免冲突。');
    return true;
}

function watchForDomChanges() {
    quickActionObserver = new MutationObserver(mutations => {
        const elementNodes = mutations.flatMap(mutation => [...mutation.addedNodes, ...mutation.removedNodes])
            .filter(node => node.nodeType === Node.ELEMENT_NODE);
        const apiHubAdded = elementNodes.some(node => node.id === 'apihub_container' || node.querySelector?.('#apihub_container'));
        if (elementNodes.some(node => node.id === 'custom_exclude_body' || node.querySelector?.('#custom_exclude_body'))) {
            configureAdditionalParametersPopup();
        }
        if (apiHubAdded || document.getElementById('apihub_container')) {
            void teardownQuickerApi().then(didTeardown => {
                if (didTeardown) toastr.warning('检测到 API Hub，Quicker Api 已在安全回滚完成后停用。');
            });
            return;
        }
        const placement = normalizeQuickActionPlacement(settings().quickActionPlacement);
        const entryMissing = placement === 'disabled'
            ? false
            : placement === 'leftSendForm'
                ? !document.getElementById('quicker_api_quick_left')
                : placement === 'rightSendForm'
                    ? !document.getElementById('quicker_api_quick_right')
                    : !document.querySelector('[data-quicker-api-qr-entry]');
        const qrChanged = placement === 'qrButtons' && elementNodes.some(node =>
            node.matches?.('.qr--buttons, [data-quicker-api-qr-entry], #qr--bar, #qr--popout')
            || node.querySelector?.('.qr--buttons, [data-quicker-api-qr-entry], #qr--bar, #qr--popout'));
        if (entryMissing || qrChanged) scheduleQuickActionEntries();
    });
    quickActionObserver.observe(document.body, { childList: true, subtree: true });
    configureAdditionalParametersPopup();
}

jQuery(() => {
    if (!initializeSettings() || detectConflict()) return;
    const apiPanel = document.getElementById('openai_api');
    if (!apiPanel) {
        console.warn('[QuickerApi] #openai_api not found; extension was not initialized.');
        return;
    }
    if (document.getElementById('quicker_api')) return;
    $('#chat_completion_source').after(toolbarHtml());
    $('#quicker_api_format').val(findFormatForCurrentSource() || 'openai');
    updatePanelVisibility();
    bindEvents();
    renderProfiles();
    watchForDomChanges();
    void enqueueOperation(async () => {
        if (!await readAuthoritativeSecretState()) toastr.warning('Quicker Api 暂时无法读取权威密钥状态；切换将保持阻断。');
        await restoreInitialProfileSelection();
    });
    console.log('[QuickerApi] Extension loaded');
});

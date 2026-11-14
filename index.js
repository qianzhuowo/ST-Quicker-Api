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
    // Off by default: native presets carry prompts/parameters only and never
    // switch the provider. When on, a preset applies and records its bound
    // Profile (presetBindings/presetModels are kept either way).
    presetLink: false,
    presetBindings: {},
    presetModels: {},
    migratedFromCustomOpenAIProfiles: false,
    blockedSecretKeys: {},
    quickActions: [],
    quickActionPlacement: 'leftSendForm',
    // The quick action last applied by the user; its parameter overrides are
    // used only while the live connection still matches it.
    activeQuickActionId: '',
    quickUrls: [],
    // The user switched back to the host's own connection UI: the panel hides
    // and stops managing the connection until it is switched back on.
    nativeUi: false,
};

let operationQueue = Promise.resolve();
let pendingOperations = 0;
let syncingEditorModel = 0;
// Model picker view is session-only: every page load starts on favorites, and a
// successful fetch switches to the full list until the user switches back.
// Every model dropdown is the same component; a host supplies its data and
// what picking means. Only one dropdown is open at a time.
const modelPickerHosts = new Map();
let openModelPickerHost = null;
let modelPickerProfile = null;
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
// A /model (or other native model change) made while a native preset switch is
// still being applied; it is newer than the preset's model and is re-applied
// once the switch settles.
let presetSwitchActive = false;
let presetSwitchModel = null;
let presetSwitchIncoming = null;
let presetSwitchBaseline = {};
let presetSwitchTimer = null;
let nativeModelReconcileTimer = null;
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

// The confirmation deadline only covers the host never sending this snapshot.
// Once a save request carrying it is on the wire, its own response decides:
// large settings over a remote/mobile link can legitimately take longer.
function markSettingsSaveSent(snapshot) {
    if (extensionDisabled || teardownPending || !snapshot) return;
    if (snapshot === JSON.stringify(settings())) clearTimeout(settingsSaveTimer);
    for (const waiter of settingsSaveWaiters) {
        if (waiter.snapshot === snapshot) clearTimeout(waiter.timer);
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
        const waiter = { snapshot, complete: null, timer: null };
        waiter.timer = setTimeout(() => { finishSettingsSave(snapshot, false); waiter.complete(false); }, 15000);
        waiter.complete = success => {
            clearTimeout(waiter.timer);
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

function presetLinkEnabled() {
    return settings().presetLink === true;
}

// With preset linking off, a native preset must not touch the connection the
// selected provider owns, whatever the host's own bind_preset_to_connection is.
function stripPresetConnection(preset, settingsToUpdate) {
    if (!preset || typeof preset !== 'object' || !settingsToUpdate || typeof settingsToUpdate !== 'object') return;
    for (const [key, entry] of Object.entries(settingsToUpdate)) {
        if (Array.isArray(entry) && entry[3] === true) delete preset[key];
    }
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

// Sampling parameters a quick action may override per request. The setting
// names are the native preset fields used to prefill the editor.
const QUICK_ACTION_PARAMETERS = Object.freeze([
    { key: 'temperature', label: '温度', setting: 'temp_openai', min: 0, max: 2 },
    { key: 'frequency_penalty', label: '频率惩罚', setting: 'freq_pen_openai', min: -2, max: 2 },
    { key: 'presence_penalty', label: '存在惩罚', setting: 'pres_pen_openai', min: -2, max: 2 },
    { key: 'top_p', label: 'Top P', setting: 'top_p_openai', min: 0, max: 1 },
]);

function normalizeQuickActionParameterValue(value, spec) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(spec.max, Math.max(spec.min, Math.round(number * 100) / 100)) : null;
}

function normalizeQuickActionParameters(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        ...Object.fromEntries(QUICK_ACTION_PARAMETERS.map(spec => [spec.key, {
            send: raw?.[spec.key]?.send !== false,
            value: normalizeQuickActionParameterValue(raw?.[spec.key]?.value, spec),
        }])),
    };
}

function normalizeQuickAction(raw, index = 0) {
    return {
        id: normalizeText(raw?.id) || makeId('quick-action'),
        name: sanitizeName(raw?.name),
        preset: normalizeText(raw?.preset).slice(0, 500),
        profileId: normalizeText(raw?.profileId),
        model: normalizeText(raw?.model).slice(0, 500),
        // Editing aid kept per scheme: picking another channel's model also
        // makes that channel the scheme's configuration.
        followChannel: raw?.followChannel !== false,
        params: normalizeQuickActionParameters(raw?.params),
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

function normalizeModelFormats(raw, format) {
    if (!raw || typeof raw !== 'object' || format === 'opencode') return {};
    return Object.fromEntries(Object.entries(raw)
        .map(([model, value]) => [normalizeText(model).slice(0, 500), String(value || '')])
        .filter(([model, value]) => model && value !== format && value !== 'opencode' && Object.hasOwn(FORMATS, value)));
}

function normalizeExtraCredentials(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw)
        .map(([slot, value]) => [String(slot), String(value || '')])
        .filter(([slot, value]) => slot && value));
}

function favoriteEntries(raw, favorites) {
    if (!raw || typeof raw !== 'object') return {};
    const keep = new Set(favorites);
    return Object.fromEntries(Object.entries(raw).filter(([model]) => keep.has(normalizeText(model))));
}

// The single way to change a provider's favorites: format overrides exist only
// for favorites, and extra credentials only for the key slots those overrides
// still use. Quicker proxy presets nobody uses any more are released.
function setFavoriteModels(profile, models) {
    const before = profileProxyNames(profile);
    profile.availableModels = normalizeModelList(models);
    profile.modelFormats = normalizeModelFormats(favoriteEntries(profile.modelFormats, profile.availableModels), profile.format);
    const primary = credentialSlot(profile.format, profile.endpoint);
    const needed = new Set(profileFormats(profile).map(format => credentialSlot(format, profile.endpoint)).filter(slot => slot !== primary));
    profile.extraCredentials = Object.fromEntries(Object.entries(profile.extraCredentials || {}).filter(([slot]) => needed.has(slot)));
    releaseUnusedProxyPresets(before);
}

function profileProxyNames(profile) {
    return [profile?.proxyPreset, profile?.extraCredentials?.proxy].filter(Boolean);
}

// Remove Quicker-created proxy presets among `names` that no channel, Connection
// Manager profile or the host's current selection uses. Native keys are never
// deleted: a key may be shared, and the user manages them in the key manager.
function releaseUnusedProxyPresets(names) {
    const used = new Set(profiles().flatMap(profileProxyNames));
    const selected = $('#openai_proxy_preset').val();
    for (const name of new Set(names)) {
        if (!name.startsWith('Quicker · ') || used.has(name) || name === selected || proxyPresetIsShared(name, '')) continue;
        const index = proxies.findIndex(proxy => proxy.name === name);
        if (index >= 0) proxies.splice(index, 1);
        $('#openai_proxy_preset option').filter((_, option) => option.value === name).remove();
    }
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
    const profile = {
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
        // Per-model protocol overrides, only for favorites; a model without one uses `format`.
        modelFormats: normalizeModelFormats(favoriteEntries(raw?.modelFormats, availableModels), format),
        // Credentials of other key slots those overrides need (slot -> secret id / proxy preset).
        extraCredentials: normalizeExtraCredentials(raw?.extraCredentials),
        // Opaque source reference used only to suppress already-migrated native
        // entries when their credential cannot be exposed across secret slots.
        nativeImportFingerprint: String(raw?.nativeImportFingerprint || '').slice(0, 5000),
        // Created by "new" and named, but its connection was never saved.
        // A draft is never applied to the host and inherits nothing from it.
        draft: Boolean(raw?.draft),
        updatedAt: String(raw?.updatedAt || ''),
    };
    if (!profile.draft) delete profile.draft;
    return profile;
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
    value.nativeUi = value.nativeUi === true;
    value.presetLink = value.presetLink === true;
    value.quickActionPlacement = ['leftSendForm', 'rightSendForm', 'qrButtons', 'disabled'].includes(value.quickActionPlacement)
        ? value.quickActionPlacement
        : 'rightSendForm';
    value.quickActions = Array.isArray(value.quickActions)
        ? value.quickActions.map(normalizeQuickAction).filter(action => action.preset || action.profileId || action.model)
        : [];
    value.quickActions.sort((a, b) => a.sequence - b.sequence).forEach((action, index) => { action.sequence = index; });
    value.activeQuickActionId = value.quickActions.some(action => action.id === value.activeQuickActionId) ? value.activeQuickActionId : '';
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
                    <span class="quicker-api__native-hint">已切回原生界面</span>
                    <i class="fa-solid fa-chevron-up quicker-api__chevron" aria-hidden="true"></i>
                </button>
                <label class="quicker-api__switch quicker-api__mode-switch" for="quicker_api_mode" title="关闭后切回 SillyTavern 原生界面">
                    <input id="quicker_api_mode" class="quicker-api__switch-input" type="checkbox" role="switch" checked />
                    <span class="quicker-api__switch-track" aria-hidden="true"><span class="quicker-api__switch-thumb"></span></span>
                    <span class="quicker-api__switch-label">插件启用</span>
                </label>
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
                    <label class="quicker-api__switch quicker-api__preset-link" for="quicker_api_preset_link" title="开启后：切换原生预设会应用它绑定的 API 配置，保存预设或 API 配置会记录绑定。关闭时：预设只管提示词与参数，不改供应商、URL 与模型。">
                        <input id="quicker_api_preset_link" class="quicker-api__switch-input" type="checkbox" role="switch" />
                        <span class="quicker-api__switch-track" aria-hidden="true"><span class="quicker-api__switch-thumb"></span></span>
                        <span class="quicker-api__switch-label">联动预设</span>
                    </label>
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
    if (extensionDisabled || teardownPending || settings().nativeUi) return;
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

function credentialSlot(format, endpoint) {
    return usesProxyProfile(format, endpoint) ? 'proxy' : FORMATS[format].secretKey;
}

// The plaintext a Profile authenticates with, '' when it has none, or null when
// the host does not expose it.
async function readProfileCredential(profile) {
    if (usesProxyProfile(profile.format, profile.endpoint)) return String(getBoundProxyPreset(profile)?.password || '');
    const key = FORMATS[profile.format].secretKey;
    if (!profile.secretId || profile.secretId === settings().emptySecretIds[key]) return '';
    return await findSecretBounded(key, profile.secretId);
}

// Formats a single model may use instead of its provider's format. OpenCode has
// its own endpoint semantics, so it neither gives nor takes per-model formats.
function modelFormatChoices(profile) {
    if (!profile || profile.format === 'opencode') return [];
    return Object.keys(FORMATS).filter(format => format !== 'opencode' && isFormatSupported(format));
}

// The format a model of this provider is spoken in: its own override, else the provider's.
function effectiveFormat(profile, model) {
    const override = profile?.modelFormats?.[normalizeText(model)];
    return override && override !== profile.format && modelFormatChoices(profile).includes(override) ? override : profile?.format;
}

function profileFormats(profile) {
    if (!profile) return [];
    const choices = modelFormatChoices(profile);
    return [...new Set([profile.format, ...Object.values(profile.modelFormats || {}).filter(format => choices.includes(format))])];
}

// The connection a provider makes when it speaks `format`: its own fields and
// URL, with the credential of the key slot that format uses. The provider's
// own format is the provider itself.
function connectionFor(profile, format = profile?.format) {
    if (!profile || !format || format === profile.format) return profile;
    const slot = credentialSlot(format, profile.endpoint);
    const extra = profile.extraCredentials || {};
    const credential = slot === credentialSlot(profile.format, profile.endpoint)
        ? { secretId: profile.secretId, proxyPreset: profile.proxyPreset, needsSecret: profile.needsSecret }
        : slot === 'proxy'
            ? { secretId: '', proxyPreset: String(extra.proxy || ''), needsSecret: false }
            : { secretId: String(extra[slot] || ''), proxyPreset: '', needsSecret: !extra[slot] };
    return {
        ...profile,
        ...credential,
        format,
        opencodeApiFormat: '',
        includeBody: supportsCustomParameters(format) ? profile.includeBody : '',
        includeHeaders: supportsCustomParameters(format) ? profile.includeHeaders : '',
        connectionOf: profile,
    };
}

// The provider format the host is connected with right now, if any.
function liveFormat(profile) {
    return profileFormats(profile).find(format => matchesFormat(format)) || null;
}

function liveConnection(profile) {
    return connectionFor(profile, liveFormat(profile) || profile?.format);
}

// A per-model format whose key slot differs from the provider's needs its own
// stored credential; it never borrows whatever that slot holds.
function connectionMissingCredential(connection) {
    const profile = connection?.connectionOf;
    if (!profile || credentialSlot(connection.format, connection.endpoint) === credentialSlot(profile.format, profile.endpoint)) return false;
    if (usesProxyProfile(connection.format, connection.endpoint)) return !getBoundProxyPreset(connection);
    return !connection.secretId || !getSecretEntry(FORMATS[connection.format].secretKey, connection.secretId);
}

function setConnectionSecret(profile, format, secretId) {
    const slot = credentialSlot(format, profile.endpoint);
    if (slot === credentialSlot(profile.format, profile.endpoint)) {
        profile.secretId = secretId;
        profile.needsSecret = false;
    } else {
        profile.extraCredentials = { ...profile.extraCredentials, [slot]: secretId };
    }
}

function credentialSlotLabel(slot) {
    if (slot === 'proxy') return '反代密码';
    return FORMATS[Object.keys(FORMATS).find(format => FORMATS[format].secretKey === slot)]?.label || slot;
}

async function writeExtraSecret(key, value, label) {
    // Writing rotates the slot briefly; block generation and native key
    // adoption until the slot's live key is back.
    const transitionWasBlocked = presetTransitionBlocked;
    beginPresetTransition();
    try {
        const before = await readAuthoritativeSecretState();
        if (!before) return '';
        const previousId = before[key]?.find(entry => entry.active)?.id || '';
        const result = await ensureSecret(key, value, label);
        // An extra slot is written for later use; the live key of that slot stays.
        if (previousId && previousId !== result.id && !await rotateSecretVerified(key, previousId)) {
            await enterFailClosedState('额外密钥写入后无法恢复原活动密钥。', key);
            return '';
        }
        return result.id;
    } finally {
        if (!transitionWasBlocked) endPresetTransition();
    }
}

// The credentials for the extra key slots this provider's per-model formats
// need, given its (new) format and URL. A typed key goes everywhere; otherwise
// an existing extra credential stays and a missing one is carried from the
// provider's own key. Returns the new map, or null when a key is unavailable.
async function provisionModelCredentials(profile, format, endpoint, keyValue = '') {
    const target = { ...profile, format, endpoint };
    const primary = credentialSlot(format, endpoint);
    const needed = new Map();
    for (const modelFormat of profileFormats(target)) {
        const slot = credentialSlot(modelFormat, endpoint);
        if (slot !== primary && !needed.has(slot)) needed.set(slot, modelFormat);
    }
    const current = profile.extraCredentials || {};
    const result = {};
    let carried;
    const providerKey = async () => {
        if (carried === undefined) carried = profile.draft ? '' : await readProfileCredential(profile);
        return carried;
    };
    for (const [slot, modelFormat] of needed) {
        const typed = normalizeText(keyValue);
        if (slot === 'proxy') {
            const existing = current.proxy ? proxies.find(proxy => proxy.name === current.proxy) : null;
            const password = typed || String(existing?.password || '') || await providerKey();
            if (!password) return provisionFailed(slot);
            result.proxy = ensureBoundProxyPreset(`${profile.name} · ${FORMATS[modelFormat].label}`, endpoint, password, current.proxy, profile.id);
            continue;
        }
        if (!typed && current[slot] && getSecretEntry(slot, current[slot])) {
            result[slot] = current[slot];
            continue;
        }
        const value = typed || await providerKey();
        if (!value) return provisionFailed(slot);
        const id = await writeExtraSecret(slot, value, `${profile.name} · ${FORMATS[modelFormat].label}`);
        if (!id) {
            toastr.error(`${credentialSlotLabel(slot)} 密钥保存状态无法确认。`);
            return null;
        }
        result[slot] = id;
    }
    return result;
}

function provisionFailed(slot) {
    toastr.warning(`有模型使用的格式需要把密钥另存到「${credentialSlotLabel(slot)}」，但原密钥明文不可读：请在 Key 输入框填写后保存。`);
    return null;
}

function updateCredentialEditor(profile = selectedProfile()) {
    // Describe the credential for the connection being edited: a protocol or
    // URL change can move it to another key slot, where it is carried on save.
    const format = normalizeFormat($('#quicker_api_format').val() || profile?.format);
    const config = FORMATS[format];
    const endpoint = normalizeText($('#quicker_api_url').val());
    const proxyMode = usesProxyProfile(format, endpoint);
    const sameSlot = Boolean(profile) && credentialSlot(profile.format, profile.endpoint) === credentialSlot(format, endpoint);
    const hasCredential = sameSlot && profileHasCredential(profile, format, endpoint);
    const carried = !sameSlot && profileHasCredential(profile, profile?.format, profile?.endpoint);
    const placeholder = carried ? '保存时沿用原密钥（不可读时需重新填写）'
        : proxyMode
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
    // A draft is not connected to the host yet; its editor model stays local.
    if (selectedProfile()?.draft) return;
    const format = liveFormat(selectedProfile()) || normalizeFormat($('#quicker_api_format').val());
    const config = FORMATS[format];
    const model = getEditorModel(format);
    if (platform.isModelAction(model)) return;
    withEditorSync(() => {
        oai_settings[config.modelField] = model;
        const input = $(config.modelInput);
        if (input.is('select') && !input.find('option').filter((_, option) => option.value === model).length) {
            input.append($('<option>').val(model).text(model));
        }
        input.val(model).trigger(isCustomFormat(format) ? 'input' : 'change');
    });
    recordPresetModel(selectedProfile(), model);
}

// A model switched while the current preset is bound to the live Profile is
// that preset's model from now on. Unbound presets and other Profiles (e.g. a
// new channel applied without being bound) never overwrite a binding's model.
function recordPresetModel(profile, model) {
    if (!profile || profile.draft || settings().nativeUi || settings().activeProfileId !== profile.id) return;
    if (!presetLinkEnabled() || presetTransitionBlocked || presetSwitchActive || !model || platform.isModelAction(model)) return;
    if (!profileMatchesNative(profile, { includeModel: false })) return;
    const presetName = currentPresetName();
    if (!presetName || settings().presetBindings[presetName] !== profile.id) return;
    editorModelBaseline = model;
    const snapshot = settings().presetModels[presetName];
    if (snapshot?.profileId === profile.id && snapshot.format === profile.format && snapshot.model === model) return;
    settings().presetModels[presetName] = presetModelSnapshot(profile, model);
    scheduleSettingsSave();
}

// Native model events fired synchronously by our own writes are not external
// model choices; this marks them for handleNativeModelChange.
function withEditorSync(callback) {
    syncingEditorModel++;
    try {
        return callback();
    } finally {
        syncingEditorModel--;
    }
}

function nativeModelFor(format, source = oai_settings) {
    return normalizeText(source?.[FORMATS[format].modelField]);
}

// The single path that makes the panel follow the native model, whoever set
// it (native controls, /model in Quick Replies or STscript, other extensions).
function reconcileNativeModel() {
    clearTimeout(nativeModelReconcileTimer);
    nativeModelReconcileTimer = null;
    if (extensionDisabled || teardownPending) return;
    if (pendingOperations || presetTransitionBlocked || presetSwitchActive) {
        // The running operation/preset switch renders its own result; check
        // again afterwards so a model chosen meanwhile is not left unshown.
        nativeModelReconcileTimer = setTimeout(reconcileNativeModel, 150);
        return;
    }
    const profile = selectedProfile();
    if (profile?.draft) return;
    // A provider may be live in one of its per-model formats.
    const format = profile ? liveFormat(profile) : normalizeFormat($('#quicker_api_format').val());
    if (!format || !matchesFormat(format)) return;
    // Follow the host whenever the panel shows the host's live connection,
    // even if the Profile was not (re)applied by the plugin in this session.
    if (profile && !profileMatchesNative(profile, { includeModel: false })) return;
    const model = nativeModelFor(format);
    if (platform.isModelAction(model) || model === getEditorModel(format)) return;
    renderModelControl(profile, model);
    // A model the host switched on the live connection is not a Profile edit.
    if (profile && settings().activeProfileId === profile.id) editorModelBaseline = model;
    recordPresetModel(profile, model);
    renderStatus();
}

function handleNativeModelChange(_event, data) {
    if (syncingEditorModel || extensionDisabled || teardownPending) return;
    if (presetSwitchActive) {
        // A model set while a preset is still being applied (e.g. "/preset A |
        // /model B") is newer than the preset; re-apply it when the switch ends.
        if (data?.source === 'preset') return;
        const format = findFormatForCurrentSource();
        const model = format ? nativeModelFor(format) : '';
        // Source changes inside the preset switch re-fire the old or incoming
        // model; only a different value is a choice made during the switch.
        if (model && !platform.isModelAction(model) && model !== presetSwitchBaseline[format]
            && model !== nativeModelFor(format, presetSwitchIncoming)) {
            presetSwitchModel = { format, model };
        }
        return;
    }
    reconcileNativeModel();
}

function beginPresetSwitch(preset) {
    if (presetSwitchActive) {
        presetSwitchIncoming = preset && typeof preset === 'object' ? preset : presetSwitchIncoming;
        return;
    }
    presetSwitchActive = true;
    presetSwitchModel = null;
    presetSwitchIncoming = preset && typeof preset === 'object' ? preset : null;
    presetSwitchBaseline = Object.fromEntries(Object.keys(FORMATS).map(format => [format, nativeModelFor(format)]));
    clearTimeout(presetSwitchTimer);
    // A superseded preset may never emit AFTER; never keep recording forever.
    presetSwitchTimer = setTimeout(() => finishPresetSwitch(), 30000);
}

function finishPresetSwitch() {
    clearTimeout(presetSwitchTimer);
    presetSwitchTimer = null;
    const pending = presetSwitchModel;
    presetSwitchActive = false;
    presetSwitchModel = null;
    presetSwitchIncoming = null;
    presetSwitchBaseline = {};
    if (extensionDisabled || teardownPending) return;
    if (pending && findFormatForCurrentSource() === pending.format && nativeModelFor(pending.format) !== pending.model) {
        applyExplicitModel(pending.model, pending.format);
    }
    reconcileNativeModel();
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

// The main panel's dropdown: picking a model uses it on the host connection.
const mainModelPicker = {
    id: 'quicker_api_model',
    view: 'favorites',
    emptyLabel: '— 选择模型 —',
    // The edited Profile keeps its favorites while a new protocol is drafted.
    profile: () => modelPickerProfile,
    format: () => normalizeFormat($('#quicker_api_format').val()),
    current: () => normalizeText($('#quicker_api_custom_model').val()),
    portalParent: () => document.body,
    isPicked: profile => settings().activeProfileId === profile.id,
    canAdd: data => Boolean(data.profile),
    addLabel: model => `收藏并使用“${model}”`,
    add: model => modelPickerProfile && favoriteAndUseModel(modelPickerProfile, model),
    addAction: query => void addCustomModel(query || ''),
    canFetch: () => true,
    fetch: () => void enqueueOperation(fetchCustomModels),
    pick(model, providerId) {
        if (providerId && (providerId !== modelPickerProfile?.id || this.view === 'formats')) {
            const provider = profiles().find(item => item.id === providerId);
            if (provider) void useProviderModel(provider, model);
            return;
        }
        $('#quicker_api_custom_model').val(model).trigger('change');
    },
};
modelPickerHosts.set(mainModelPicker.id, mainModelPicker);

function modelPickerHostOf(element) {
    return modelPickerHosts.get($(element).closest('[data-picker-host]').attr('data-picker-host')) || null;
}

function modelPickerData(host = mainModelPicker) {
    const profile = host.profile();
    const format = host.format();
    const current = host.current();
    const favorites = normalizeModelList(profile?.availableModels || []);
    const fetched = profileFetchedModels(profile);
    // "All" is one provider's last manually fetched list; the host's built-in
    // list is only a fallback before anything has been fetched. Nothing is
    // ever fetched automatically, and without a provider there is no list.
    const all = fetched.length ? fetched : profile ? normalizeModelList(nativeProviderModels(format)) : [];
    // Favorites of every other saved provider; picking one applies that provider.
    const providers = profiles()
        .filter(item => item !== profile && !item.draft && isFormatSupported(item.format) && normalizeModelList(item.availableModels).length)
        .sort((a, b) => a.name.localeCompare(b.name));
    // Every saved provider's favorites, grouped by the format each model is spoken in.
    const byFormat = new Map();
    const owners = [profile, ...providers].filter(item => item && !item.draft && isFormatSupported(item.format));
    for (const owner of owners) {
        for (const model of normalizeModelList(owner.availableModels)) {
            const modelFormat = effectiveFormat(owner, model);
            if (!byFormat.has(modelFormat)) byFormat.set(modelFormat, []);
            byFormat.get(modelFormat).push({ profile: owner, model });
        }
    }
    const formatGroups = Object.keys(FORMATS).filter(key => byFormat.has(key)).map(key => ({ format: key, entries: byFormat.get(key) }));
    return { host, format, profile, current, favorites, fetched, all, providers, formatGroups, stale: new Set(staleFavoriteModels(favorites, fetched)) };
}

const FORMAT_SHORT_LABELS = Object.freeze({
    openai: 'OpenAI 兼容',
    openai_responses: 'OpenAI Responses',
    claude_messages: 'Claude Messages',
    gemini_generate_content: 'Gemini generateContent',
    gemini_interactions: 'Gemini Interactions',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    opencode: 'OpenCode',
});

function formatShortLabel(format) {
    return FORMAT_SHORT_LABELS[format] || FORMATS[format]?.label || format;
}

// Marks a model that is spoken in a format other than its provider's.
function modelFormatTag(profile, model) {
    if (!profile) return null;
    const modelFormat = effectiveFormat(profile, model);
    if (modelFormat === profile.format) return null;
    return $('<small class="quicker-api__model-format-tag">').text(formatShortLabel(modelFormat)).attr('title', `此模型使用 ${FORMATS[modelFormat].label} 格式`);
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
    if (reopen) closeModelPicker({ host: mainModelPicker });
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
    root.append(
        buildModelPicker(mainModelPicker),
        select,
        $('<button id="quicker_api_add_model" class="menu_button" type="button" title="添加模型到收藏并使用" aria-label="添加模型到收藏并使用"><i class="fa-solid fa-plus"></i><span class="quicker-api__desktop-label">添加</span><span class="quicker-api__mobile-label">添加模型</span></button>'),
        $('<button id="quicker_api_fetch_models" class="menu_button" type="button" title="获取模型并切换到“全部”列表"><i class="fa-solid fa-arrows-rotate"></i><span class="quicker-api__desktop-label">获取模型</span><span class="quicker-api__mobile-label">获取模型</span></button>'),
        $('<button id="quicker_api_channels" class="menu_button" type="button" title="渠道管理：供应商连接、收藏模型与单模型协议"><i class="fa-solid fa-server"></i><span class="quicker-api__desktop-label">渠道管理</span><span class="quicker-api__mobile-label">渠道管理</span></button>'),
        $('<button class="menu_button quicker-api__manage-actions" type="button" title="便捷按钮管理"><i class="fa-solid fa-bolt"></i><span class="quicker-api__desktop-label">便捷按钮管理</span><span class="quicker-api__mobile-label">便捷按钮</span></button>'),
    );
    updateModelTrigger(mainModelPicker);
    if (reopen) openModelPicker({ host: mainModelPicker, query, focusSearch: refocus });
    renderPanelSummary();
}

// The one dropdown markup; ids derive from the host id.
function buildModelPicker(host) {
    const id = host.id;
    return $(`<div id="${id}_picker" class="quicker-api__model-picker" data-picker-host="${id}">
        <button id="${id}_trigger" class="text_pole quicker-api__model-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}_dropdown" aria-label="选择模型">
            <i class="quicker-api__model-trigger-mark" aria-hidden="true"></i><span class="quicker-api__model-trigger-label"></span><i class="fa-solid fa-chevron-down quicker-api__model-trigger-caret" aria-hidden="true"></i>
        </button>
        <div id="${id}_dropdown" class="quicker-api__model-dropdown" data-picker-host="${id}" hidden>
            <div class="quicker-api__model-tabs" role="tablist" aria-label="模型列表">
                <button type="button" role="tab" data-model-view="favorites" title="收藏的模型"><i class="fa-solid fa-star"></i><span>收藏</span><small></small></button>
                <button type="button" role="tab" data-model-view="all" title="最近一次获取的全部模型"><i class="fa-solid fa-cloud"></i><span>全部</span><small></small></button>
                <button type="button" role="tab" data-model-view="formats" title="所有渠道的收藏，按格式分组"><i class="fa-solid fa-layer-group"></i><span>格式</span><small></small></button>
            </div>
            <div class="quicker-api__model-search-row">
                <input class="text_pole quicker-api__model-search-input" type="search" autocomplete="off" spellcheck="false" placeholder="搜索或输入新模型 ID" aria-label="搜索模型" aria-controls="${id}_options">
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="add" title="添加模型" aria-label="添加模型"><i class="fa-solid fa-plus"></i></button>
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="fetch" title="获取模型" aria-label="获取模型"><i class="fa-solid fa-arrows-rotate"></i></button>
                <button type="button" class="menu_button quicker-api__model-icon-button quicker-api__model-prune" data-model-picker-action="prune" title="清理失效收藏" aria-label="清理失效收藏"><i class="fa-solid fa-broom"></i></button>
                <button type="button" class="menu_button quicker-api__model-icon-button" data-model-picker-action="layout"><i class="fa-solid"></i></button>
            </div>
            <div id="${id}_options" class="quicker-api__model-options" role="listbox" aria-label="模型"></div>
        </div>
    </div>`);
}

function updateModelTrigger(host = mainModelPicker) {
    const trigger = $(`#${host.id}_trigger`);
    if (!trigger.length) return;
    const data = modelPickerData(host);
    const favorite = data.favorites.includes(data.current);
    const stale = Boolean(data.current && data.fetched.length && !data.all.includes(data.current));
    const mark = !data.current ? '' : stale ? 'fa-solid fa-triangle-exclamation is-stale' : favorite ? 'fa-solid fa-star is-favorite' : 'fa-solid fa-cloud';
    trigger.toggleClass('is-empty', !data.current)
        .attr('title', stale ? `${data.current}（云端最新列表中已不存在）` : (data.current || '选择模型'));
    trigger.find('.quicker-api__model-trigger-mark').attr('class', `quicker-api__model-trigger-mark ${mark}`);
    trigger.find('.quicker-api__model-trigger-label').text(data.current || host.emptyLabel);
}

function currentModelPickerHost() {
    return openModelPickerHost || mainModelPicker;
}

function modelPickerElement(host = currentModelPickerHost()) {
    return $(`#${host.id}_picker`);
}

// The dropdown is portaled out of its container while open (like the quick URL
// menu) so it never adds to the scroll height of the panel or dialog.
function modelPickerDropdown(host = currentModelPickerHost()) {
    return $(`#${host.id}_dropdown`);
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
    const host = openModelPickerHost;
    if (!host) return;
    const dropdown = document.getElementById(`${host.id}_dropdown`);
    const trigger = document.getElementById(`${host.id}_trigger`);
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
    if (event?.type === 'scroll' && event.target instanceof Node && modelPickerDropdown()[0]?.contains(event.target)) return;
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

function openModelPicker({ host = mainModelPicker, query = '', focusSearch = true } = {}) {
    if (openModelPickerHost && openModelPickerHost !== host) closeModelPicker();
    const picker = modelPickerElement(host);
    const dropdown = modelPickerDropdown(host);
    if (!picker.length || !dropdown.length) return;
    const wasOpen = picker.hasClass('is-open');
    if (!wasOpen) host.opening?.();
    openModelPickerHost = host;
    picker.addClass('is-open');
    // .openDrawer.pinnedOpen keeps the host from treating clicks here as
    // "outside the drawer"; it only exists while the dropdown is open.
    let portal = $(`#${host.id}_portal`);
    if (!portal.length) portal = $(`<div id="${host.id}_portal" class="quicker-api__model-portal openDrawer pinnedOpen">`).appendTo(host.portalParent());
    dropdown.appendTo(portal).prop('hidden', false);
    $(`#${host.id}_trigger`).attr('aria-expanded', 'true');
    positionModelPicker();
    if (!wasOpen) bindModelPickerPosition();
    const search = dropdown.find('.quicker-api__model-search-input').val(query);
    renderModelPickerOptions(host);
    // Avoid summoning the on-screen keyboard on touch devices.
    if (focusSearch && !globalThis.matchMedia?.('(pointer: coarse)').matches) search[0]?.focus({ preventScroll: true });
}

function closeModelPicker({ host = currentModelPickerHost(), focusTrigger = false } = {}) {
    const picker = modelPickerElement(host);
    const dropdown = modelPickerDropdown(host);
    if (openModelPickerHost === host) openModelPickerHost = null;
    if (!picker.hasClass('is-open')) {
        // A stale portaled dropdown must never outlive its picker.
        if (!picker.length) $(`#${host.id}_portal`).remove();
        return;
    }
    unbindModelPickerPosition();
    picker.removeClass('is-open');
    dropdown.prop('hidden', true).appendTo(picker);
    $(`#${host.id}_portal`).remove();
    $(`#${host.id}_trigger`).attr('aria-expanded', 'false');
    if (focusTrigger) $(`#${host.id}_trigger`).trigger('focus');
}

function renderModelPickerOptions(host = currentModelPickerHost()) {
    const picker = modelPickerDropdown(host);
    if (!picker.length) return;
    const data = modelPickerData(host);
    const view = host.view;
    const query = normalizeText(picker.find('.quicker-api__model-search-input').val());
    picker.find('[data-model-view]').each((_, tab) => {
        const active = tab.dataset.modelView === view;
        const count = tab.dataset.modelView === 'favorites' ? data.favorites.length
            : tab.dataset.modelView === 'all' ? data.all.length
                : data.formatGroups.reduce((total, group) => total + group.entries.length, 0);
        $(tab).toggleClass('is-active', active).attr('aria-selected', String(active)).find('small').text(count);
    });
    const list = picker.find('.quicker-api__model-options').empty();
    if (view === 'formats') return renderFormatGroups(picker, list, data, query);
    const favorites = new Set(data.favorites);
    const base = view === 'favorites' ? data.favorites : data.all;
    const entries = (data.current && !base.includes(data.current) ? [data.current, ...base] : base)
        .filter(model => matchesModelSearch(model, query));
    const grouped = view === 'favorites' && data.providers.length > 0;
    const groupHeader = profile => $('<div class="quicker-api__model-group" role="presentation">')
        .append($('<span class="quicker-api__model-group-name">').text(profile?.name || '当前配置'),
            profile ? $('<small>').text(FORMATS[profile.format]?.label || '') : null);
    const currentHeader = grouped ? groupHeader(data.profile) : null;
    if (currentHeader) list.append(currentHeader);
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
        badges.prepend(modelFormatTag(data.profile, model));
        list.append($('<div class="quicker-api__model-option" role="option">')
            .attr({ 'data-model': model, 'aria-selected': String(selected), title: stale ? `${model}（云端最新列表中已不存在）` : model })
            .toggleClass('is-favorite', isFavorite).toggleClass('is-selected', selected).toggleClass('is-stale', stale)
            .append(star, $('<span class="quicker-api__model-option-name">').text(model), badges));
    }
    if (query && data.host.canAdd(data) && !favorites.has(query) && !data.all.includes(query) && query !== data.current) {
        list.append($('<div class="quicker-api__model-option quicker-api__model-add" role="option" aria-selected="false">')
            .attr('data-add-model', query)
            .append($('<i class="fa-solid fa-plus" aria-hidden="true">'), $('<span class="quicker-api__model-option-name">').text(data.host.addLabel(query))));
    }
    if (grouped) {
        if (!currentHeader.next().length) currentHeader.remove();
        for (const provider of data.providers) {
            const models = normalizeModelList(provider.availableModels).filter(model => matchesModelSearch(model, query));
            if (!models.length) continue;
            list.append(groupHeader(provider));
            for (const model of models) {
                const star = $('<button type="button" class="quicker-api__model-star" tabindex="-1" aria-pressed="true" title="取消收藏">')
                    .attr('aria-label', `取消收藏 ${model}`)
                    .append($('<i class="fa-solid fa-star">'));
                list.append($('<div class="quicker-api__model-option is-favorite" role="option" aria-selected="false">')
                    .attr({ 'data-model': model, 'data-profile-id': provider.id, title: `${provider.name} · ${model}（选择后切换到该供应商）` })
                    .append(star, $('<span class="quicker-api__model-option-name">').text(model), $('<span class="quicker-api__model-option-badges">').append(modelFormatTag(provider, model))));
            }
        }
    }
    const message = query ? '没有匹配的模型'
        : !data.profile ? (view === 'all' ? '请先选择配置，再点 ↻ 获取它的模型列表' : '请先选择并保存 API 配置')
            : view === 'favorites' ? '收藏为空：在“全部”中点 ☆ 收藏，或输入模型 ID 添加'
                : '尚未获取模型列表，点上方 ↻ 手动获取';
    finishModelPickerOptions(picker, list, data, query, message);
}

// "格式" view: every saved provider's favorites grouped by the format each
// model is spoken in. Picking a row applies that provider with that model.
function renderFormatGroups(picker, list, data, query) {
    for (const group of data.formatGroups) {
        const entries = group.entries.filter(entry => matchesModelSearch(entry.model, query) || matchesModelSearch(entry.profile.name, query));
        if (!entries.length) continue;
        list.append($('<div class="quicker-api__model-group" role="presentation">')
            .toggleClass('is-current', group.format === liveFormat(data.profile))
            .append($('<span class="quicker-api__model-group-name">').text(formatShortLabel(group.format)), $('<small>').text(`${entries.length} 个模型`)));
        for (const { profile, model } of entries) {
            const selected = profile === data.profile && model === data.current && data.host.isPicked(profile);
            const star = $('<button type="button" class="quicker-api__model-star" tabindex="-1" aria-pressed="true" title="取消收藏">')
                .attr('aria-label', `取消收藏 ${model}`)
                .append($('<i class="fa-solid fa-star">'));
            const badges = $('<span class="quicker-api__model-option-badges">');
            if (selected) badges.append($('<i class="fa-solid fa-check" aria-hidden="true">'));
            list.append($('<div class="quicker-api__model-option is-favorite quicker-api__model-option--provider" role="option">')
                .attr({ 'data-model': model, 'data-profile-id': profile.id, 'aria-selected': String(selected), title: `${profile.name} · ${model}` })
                .toggleClass('is-selected', selected)
                .append(star, $('<span class="quicker-api__model-option-name">').append(
                    $('<span>').text(model),
                    $('<small class="quicker-api__model-option-provider">').text(profile.name),
                ), badges));
        }
    }
    finishModelPickerOptions(picker, list, data, query, query ? '没有匹配的模型' : '还没有收藏的模型：在“全部”或“渠道管理”中收藏');
}

function finishModelPickerOptions(picker, list, data, query, emptyMessage) {
    if (!list.children('.quicker-api__model-option').length) {
        list.empty();
        list.append($('<div class="quicker-api__empty-state">').text(emptyMessage));
    }
    const fetchLabel = data.fetched.length ? '刷新列表' : '获取模型';
    picker.find('[data-model-picker-action="fetch"]').attr({ title: fetchLabel, 'aria-label': fetchLabel }).prop('disabled', !data.host.canFetch(data));
    const pruneLabel = data.stale.size ? `清理失效收藏（${data.stale.size} 个不在云端最新列表中）` : '清理失效收藏（当前无失效收藏）';
    picker.find('[data-model-picker-action="prune"]').attr({ title: pruneLabel, 'aria-label': pruneLabel })
        .prop('disabled', !data.profile || !data.stale.size).toggleClass('has-stale', data.stale.size > 0);
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
    const host = modelPickerHostOf(option) || currentModelPickerHost();
    const added = row.attr('data-add-model');
    if (added !== undefined) {
        if (!host.canAdd(modelPickerData(host))) return;
        closeModelPicker({ host, focusTrigger: true });
        return host.add(added);
    }
    const model = row.attr('data-model');
    if (model === undefined) return;
    closeModelPicker({ host, focusTrigger: true });
    host.pick(model, row.attr('data-profile-id') || '');
}

// Same rule as the manager's "清理失效": drop favorites missing from the
// latest remote snapshot. The current selection itself is left unchanged.
function pruneStaleFavorites(host = currentModelPickerHost()) {
    const data = modelPickerData(host);
    const profile = data.profile;
    if (!profile || !hasManagedModels(profile.format) || !data.stale.size) return;
    setFavoriteModels(profile, data.favorites.filter(model => !data.stale.has(model)));
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    renderModelPickerOptions(host);
    updateModelTrigger(host);
    toastr.success(`已移除 ${data.stale.size} 个失效收藏。${data.stale.has(data.current) ? '当前模型仍保持选中，但它已不在云端列表中。' : ''}`);
}

function toggleFavoriteModel(model, providerId = '', host = currentModelPickerHost()) {
    const profile = providerId ? profiles().find(item => item.id === providerId) : host.profile();
    if (!profile || !hasManagedModels(profile.format)) return toastr.info('请先选择并保存 API 配置。');
    const favorites = normalizeModelList(profile.availableModels);
    setFavoriteModels(profile, favorites.includes(model) ? favorites.filter(item => item !== model) : [...favorites, model]);
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    const index = modelPickerDropdown(host).find('.quicker-api__model-option').toArray()
        .findIndex(option => option.getAttribute('data-model') === model && (option.getAttribute('data-profile-id') || '') === providerId);
    renderModelPickerOptions(host);
    if (index >= 0) setModelPickerActive(index, { scroll: false });
    updateModelTrigger(host);
    if (host !== mainModelPicker) updateModelTrigger(mainModelPicker);
}

function switchModelPickerView(view, host = currentModelPickerHost()) {
    host.view = ['all', 'formats'].includes(view) ? view : 'favorites';
    renderModelPickerOptions(host);
}

function bindModelPickerEvents() {
    $(document).on('click.quickerApi', '.quicker-api__model-trigger', function () {
        const host = modelPickerHostOf(this);
        if (!host) return;
        if (modelPickerElement(host).hasClass('is-open')) closeModelPicker({ host });
        else openModelPicker({ host });
    });
    $(document).on('keydown.quickerApi', '.quicker-api__model-trigger', function (event) {
        const host = modelPickerHostOf(this);
        if (host && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            openModelPicker({ host });
        }
    });
    $(document).on('click.quickerApi', '.quicker-api__model-dropdown [data-model-view]', function () {
        const host = modelPickerHostOf(this);
        if (host) switchModelPickerView(this.dataset.modelView, host);
    });
    $(document).on('input.quickerApi', '.quicker-api__model-search-input', function () {
        const host = modelPickerHostOf(this);
        if (host) renderModelPickerOptions(host);
    });
    $(document).on('keydown.quickerApi', '.quicker-api__model-picker, .quicker-api__model-dropdown', event => {
        const host = modelPickerHostOf(event.target);
        if (!host) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeModelPicker({ host, focusTrigger: true });
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
            const active = modelPickerDropdown(host).find('.quicker-api__model-option.is-active');
            if (active.length) activateModelPickerOption(active[0]);
        }
    });
    $(document).on('click.quickerApi', '.quicker-api__model-star', function (event) {
        event.stopPropagation();
        const row = $(this).closest('.quicker-api__model-option');
        toggleFavoriteModel(row.attr('data-model'), row.attr('data-profile-id') || '', modelPickerHostOf(this) || currentModelPickerHost());
    });
    $(document).on('click.quickerApi', '.quicker-api__model-option', function () {
        activateModelPickerOption(this);
    });
    $(document).on('click.quickerApi', '[data-model-picker-action]', function () {
        const host = modelPickerHostOf(this) || currentModelPickerHost();
        const query = normalizeText(modelPickerDropdown(host).find('.quicker-api__model-search-input').val());
        const action = this.dataset.modelPickerAction;
        if (action === 'add') {
            closeModelPicker({ host });
            host.addAction(query);
        } else if (action === 'layout') {
            cycleModelPickerLayout();
            setModelPickerActive(modelPickerDropdown(host).find('.quicker-api__model-option.is-active').index(), { scroll: true });
        } else if (action === 'prune') {
            pruneStaleFavorites(host);
        } else {
            host.fetch();
        }
    });
    $(document).on('pointerdown.quickerApi', event => {
        const host = openModelPickerHost;
        if (!host) return;
        const picker = modelPickerElement(host);
        if (!picker[0]?.contains(event.target) && !modelPickerDropdown(host)[0]?.contains(event.target)) closeModelPicker({ host });
    });
}

function renderProfileEditor(profile = selectedProfile(), modelOverride = null) {
    const format = profile?.format || normalizeFormat($('#quicker_api_format').val());
    $('#quicker_api_format').val(format);
    // The editor only ever shows a Profile's own connection. Host fields such as
    // reverse_proxy are shared by several providers and would leak another
    // Profile's URL into this one.
    $('#quicker_api_url').val(profile?.endpoint ?? '');
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
        select.append($('<option>').val(profile.id).text(`[${FORMATS[profile.format].label}] ${profile.name}${profile.draft ? '（未保存）' : ''}`));
    }
    const selectedId = preferredId ?? settings().selectedProfileId ?? '';
    select.val(profiles().some(profile => profile.id === selectedId) ? selectedId : '');
    const profile = selectedProfile();
    if (profile) $('#quicker_api_format').val(profile.format);
    const activeFormat = profile && settings().activeProfileId === profile.id ? liveFormat(profile) : null;
    const activeModel = activeFormat ? String(oai_settings[FORMATS[activeFormat].modelField] || '') : null;
    renderProfileEditor(profile, activeModel);
    updateCredentialEditor(profile);
    renderStatus();
}

function profileMatchesNative(profile, { includeModel = true } = {}) {
    // The host may be connected with the provider's own format or with one of
    // its per-model formats; compare against that connection.
    const format = liveFormat(profile);
    if (!format) return false;
    const connection = connectionFor(profile, format);
    const config = FORMATS[format];
    if (includeModel && (String(oai_settings[config.modelField] || '') !== profile.model || effectiveFormat(profile, profile.model) !== format)) return false;
    if (nativeEndpoint(format) !== connection.endpoint) return false;
    if (format === 'opencode' && oai_settings.opencode_api_format !== connection.opencodeApiFormat) return false;
    if (usesProxyProfile(format, connection.endpoint)) {
        const proxyPreset = getBoundProxyPreset(connection);
        if (!proxyPreset || String(oai_settings.proxy_password || '') !== String(proxyPreset.password || '')) return false;
    }
    const additional = nativeAdditionalParameters();
    if (additional.excludeBody !== connection.excludeBody) return false;
    return !supportsCustomParameters(format)
        || (additional.includeBody === connection.includeBody
            && additional.includeHeaders === connection.includeHeaders);
}

function getBlockedSecretMessage(key) {
    return String(settings().blockedSecretKeys[key] || '');
}

// The host's key manager is where a key is picked for the live connection.
// While that connection is this applied Profile, the picked key IS the
// Profile's key; otherwise saving or reloading would re-activate the old one.
function adoptNativeActiveSecret(profile) {
    if (!profile || profile.draft || settings().activeProfileId !== profile.id) return false;
    const connection = liveConnection(profile);
    if (usesProxyProfile(connection.format, connection.endpoint) || !profileMatchesNative(profile, { includeModel: false })) return false;
    const key = FORMATS[connection.format].secretKey;
    if (getBlockedSecretMessage(key)) return false;
    const active = getActiveSecret(key);
    if (!active || active.id === connection.secretId || active.id === settings().emptySecretIds[key]) return false;
    setConnectionSecret(profile, connection.format, active.id);
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    return true;
}

function handleNativeSecretChange(key) {
    // Plugin-owned rotations/writes run inside operations or preset transitions.
    if (extensionDisabled || teardownPending || pendingOperations || presetTransitionBlocked || settings().nativeUi) return;
    const profile = selectedProfile();
    if (profile && FORMATS[liveConnection(profile).format].secretKey === key && adoptNativeActiveSecret(profile)) {
        updateCredentialEditor(profile);
    }
    renderStatus();
}

function editorConnectionDirty(profile) {
    return normalizeFormat($('#quicker_api_format').val()) !== profile.format
        || normalizeText($('#quicker_api_url').val()) !== normalizeText(profile.endpoint)
        || (profile.format === 'opencode' && $('#quicker_api_opencode_format').val() !== profile.opencodeApiFormat)
        || (keyEditorDirty && Boolean(normalizeText($('#quicker_api_key_input').val())));
}

function editorHasUnsavedChanges(profile) {
    if (!profile) return false;
    // Parameters are compared with the connection the host is using, which
    // may be one of the provider's per-model formats.
    const connection = settings().activeProfileId === profile.id ? liveConnection(profile) : profile;
    const additional = nativeAdditionalParameters();
    return editorConnectionDirty(profile)
        || getEditorModel() !== editorModelBaseline
        || additional.excludeBody !== connection.excludeBody
        || (supportsCustomParameters(connection.format) && (additional.includeBody !== connection.includeBody
            || additional.includeHeaders !== connection.includeHeaders));
}

function renderStatus(extraMessage = '') {
    renderPanelSummary();
    const profile = selectedProfile();
    const presetName = currentPresetName();
    if (profile) {
        if (!isFormatSupported(profile.format)) return setStatus('当前宿主不支持该格式；配置已保留但不能应用。', 'warning');
        if (profile.draft) return setStatus('新配置尚未保存：填写 URL、Key 与模型后点击“保存 API 设置”。', 'warning');
        const connection = liveConnection(profile);
        const proxyMode = usesProxyProfile(connection.format, connection.endpoint);
        const blockedMessage = proxyMode ? '' : getBlockedSecretMessage(FORMATS[connection.format].secretKey);
        if (blockedMessage) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
        if (settings().activeProfileId !== profile.id) return setStatus(extraMessage || '所选 Profile 未应用。', 'warning');
        if (editorHasUnsavedChanges(profile)) return setStatus('当前修改尚未保存。', 'warning');
        if (!profileMatchesNative(profile, { includeModel: false })
            || (!proxyMode && getActiveSecret(FORMATS[connection.format].secretKey)?.id !== connection.secretId)) {
            return setStatus('原生连接与所选 Profile 不一致，请重新应用。', 'warning');
        }
        if (presetLinkEnabled() && presetName && settings().presetBindings[presetName] !== profile.id) return setStatus('当前 preset 未绑定到所选 Profile。', 'warning');
        if (!profileHasCredential(connection, connection.format, connection.endpoint)) return setStatus('当前 Profile 凭据为空。', 'warning');
        return setStatus('已保存并安全应用。');
    }
    if (Object.keys(settings().blockedSecretKeys).length) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
    if (presetLinkEnabled() && presetName && !settings().presetBindings[presetName]) return setStatus('当前 preset 未绑定。', 'warning');
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
    if (!profile) return false;
    const format = effectiveFormat(profile, generateData.model);
    if (!matchesFormat(format, generateData)) return false;
    if (String(generateData.model || '') !== profile.model && !normalizeModelList(profile.availableModels).includes(String(generateData.model || ''))) return false;
    const endpointField = FORMATS[format].endpointField;
    if (format === 'opencode' && generateData.opencode_api_format !== profile.opencodeApiFormat) return false;
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
    applyQuickActionParameters(generateData);
}

// A quick action is "in use" when every part it sets matches the live state.
function quickActionMatchesCurrent(action) {
    if (!action || (!action.preset && !action.profileId && !action.model)) return false;
    if (action.preset && currentPresetName() !== action.preset) return false;
    let format = findFormatForCurrentSource();
    if (action.profileId) {
        const profile = profiles().find(item => item.id === action.profileId);
        if (!profile || settings().activeProfileId !== profile.id || !profileMatchesNative(profile, { includeModel: false })) return false;
        format = liveFormat(profile);
    }
    return !action.model || (Boolean(format) && matchesFormat(format) && nativeModelFor(format) === action.model);
}

function activeQuickAction() {
    // The scheme the user last clicked wins while it still matches; otherwise
    // the first matching scheme (in menu order) describes the current state.
    const preferred = settings().quickActions.find(item => item.id === settings().activeQuickActionId);
    if (quickActionMatchesCurrent(preferred)) return preferred;
    return [...settings().quickActions].sort((a, b) => a.sequence - b.sequence).find(quickActionMatchesCurrent) || null;
}

function applyQuickActionParameters(generateData) {
    const params = activeQuickAction()?.params;
    if (!params?.enabled) return;
    for (const spec of QUICK_ACTION_PARAMETERS) {
        const entry = params[spec.key];
        if (!entry.send) delete generateData[spec.key];
        else if (entry.value !== null) generateData[spec.key] = entry.value;
    }
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
    withEditorSync(() => restoreNativeFields(snapshot));
}

// ST names the proxy password input #openai_proxy_password; TauriTavern renamed it
// #openai_proxy_access_key. Both hosts' input handlers copy the field into
// oai_settings.proxy_password, so the same trigger keeps either host in sync.
function setNativeProxyPasswordField(value) {
    $('#openai_proxy_password, #openai_proxy_access_key').val(value ?? '').trigger('input');
}

function restoreNativeFields(snapshot) {
    oai_settings.custom_url = snapshot.custom_url;
    oai_settings.custom_model = snapshot.custom_model;
    oai_settings.reverse_proxy = snapshot.reverse_proxy;
    oai_settings.claude_model = snapshot.claude_model;
    oai_settings.google_model = snapshot.google_model;
    oai_settings.proxy_password = snapshot.proxy_password;
    $('#custom_api_url_text').val(snapshot.custom_url).trigger('input');
    $('#custom_model_id').val(snapshot.custom_model).trigger('input');
    $('#openai_reverse_proxy').val(snapshot.reverse_proxy).trigger('input');
    setNativeProxyPasswordField(snapshot.proxy_password);
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

function applyNativeFields(profile, proxyPassword = '', applyModel = true, modelOverride = null) {
    withEditorSync(() => writeNativeFields(profile, proxyPassword, applyModel, modelOverride));
}

function writeNativeFields(profile, proxyPassword, applyModel, modelOverride = null) {
    const config = FORMATS[profile.format];
    if (profile.format === 'opencode') {
        validateOpenCodeConnection(profile.endpoint, profile.opencodeApiFormat);
        oai_settings.opencode_api_format = profile.opencodeApiFormat;
        $('#opencode_api_format').val(profile.opencodeApiFormat).trigger('input');
    }
    oai_settings[config.endpointField] = profile.endpoint;
    $(config.endpointInput).val(profile.endpoint).trigger('input');
    if (applyModel) {
        const model = modelOverride ?? profile.model;
        oai_settings[config.modelField] = model;
        if (model) {
            if (!applyExplicitModel(model, profile.format)) throw new Error('无法应用 Profile 模型，请检查模型 ID。');
        } else {
            $(config.modelInput).val('').trigger(isCustomFormat(profile.format) ? 'input' : 'change');
        }
    }
    applyNativeAdditionalParameters(profile);
    if (profile.format === 'anthropic' || profile.format === 'gemini') {
        oai_settings.proxy_password = proxyPassword;
        setNativeProxyPasswordField(proxyPassword);
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

async function applyProfile(profile, expectedGeneration = profileSelectionGeneration, keepPresetTransition = false, applyModel = true, modelOverride = null) {
    if (!profile || extensionDisabled || expectedGeneration !== profileSelectionGeneration) return false;
    if (profile.draft) {
        toastr.warning(`“${profile.name}”尚未保存连接信息，不能应用。`);
        renderProfiles(settings().selectedProfileId);
        return false;
    }
    if (profile.format === 'opencode') {
        if (!platform.supportsOpenCode) { toastr.warning('当前宿主不支持原生 OpenCode；配置已保留但不能应用。'); return false; }
        validateOpenCodeConnection(profile.endpoint, profile.opencodeApiFormat);
    }
    if (!isFormatSupported(profile.format)) { toastr.warning('当前宿主不支持该格式；配置已保留但不能应用。'); return false; }
    // The model decides the protocol: a per-model format connects the provider
    // with that format and the credential of that format's key slot.
    const targetModel = applyModel ? normalizeText(modelOverride ?? profile.model) : '';
    const connection = connectionFor(profile, applyModel ? effectiveFormat(profile, targetModel) : profile.format);
    if (connectionMissingCredential(connection)) {
        toastr.warning(`模型“${targetModel}”使用 ${FORMATS[connection.format].label} 格式，需要该格式的密钥：请在渠道管理中填写 Key 后保存。`);
        renderProfiles(settings().selectedProfileId);
        return false;
    }
    const config = FORMATS[connection.format];
    const previousSelection = settings().activeProfileId;
    const nativeSnapshot = snapshotNative();
    const proxyMode = usesProxyProfile(connection.format, connection.endpoint);
    if (proxyMode) {
        const proxyPreset = getBoundProxyPreset(connection);
        if (!proxyPreset || normalizeText(proxyPreset.url) !== normalizeText(connection.endpoint)) {
            toastr.error(`${config.label} 反代 Profile 缺少匹配的原生 Reverse Proxy Preset，请重新保存该 Profile。`);
            renderProfiles(settings().selectedProfileId);
            return false;
        }
        try {
            applyNativeFields(connection, String(proxyPreset.password || ''), applyModel, modelOverride);
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
    let targetSecretId = connection.secretId;
    if (!targetSecretId || !authoritative[config.secretKey]?.some(entry => entry.id === targetSecretId)) {
        if (connection !== profile && credentialSlot(connection.format, connection.endpoint) !== credentialSlot(profile.format, profile.endpoint)) {
            toastr.warning(`${config.label} 格式的密钥已不存在：请在渠道管理中填写 Key 后保存。`);
            renderProfiles(settings().selectedProfileId);
            return false;
        }
        const expectedSecret = Boolean(connection.needsSecret || targetSecretId);
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
        setConnectionSecret(profile, connection.format, targetSecretId);
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
        applyNativeFields(connection, '', applyModel, modelOverride);
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
    // A key belongs to its slot: a Profile moved to another slot keeps none
    // rather than adopting the key another Profile left active there.
    const sameSlot = !existing.format || FORMATS[existing.format]?.secretKey === config.secretKey;
    const retainedSecretId = sameSlot ? String(existing.secretId || '') : '';
    // A draft only uses a key typed for it, never the slot's active key.
    const secretId = proxyMode ? '' : (retainedSecretId || (existing.draft || !sameSlot ? '' : activeSecret?.id) || '');
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
        draft: false,
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

async function createProfile() {
    if (extensionDisabled || teardownPending) return;
    const format = normalizeFormat($('#quicker_api_format').val());
    const name = await promptName('输入新 API 配置名称：', `${FORMATS[format].label} ${profiles().length + 1}`);
    if (!name) return;
    // The draft starts empty: it never inherits the previous Profile's URL,
    // model, favorites or credential, and is not applied until it is saved.
    const profile = normalizeProfile({ id: makeId(), name: uniqueName(name), format: isFormatSupported(format) ? format : 'openai', draft: true, updatedAt: new Date().toISOString() });
    profiles().push(profile);
    settings().selectedProfileId = profile.id;
    scheduleSettingsSave();
    renderProfiles(profile.id);
    toastr.info(`已创建“${profile.name}”；填写 URL、Key 与模型后点击“保存 API 设置”即可启用。`);
    $('#quicker_api_url').trigger('focus');
}

// A draft owns the editor format; switching format keeps it a blank draft
// instead of falling back to the host's current URL/model.
function retargetDraftFormat(format) {
    const draft = selectedProfile();
    if (!draft?.draft) return false;
    if (draft.format !== format) {
        Object.assign(draft, normalizeProfile({ ...draft, format, endpoint: '', opencodeApiFormat: '', availableModels: [], fetchedModels: [] }));
        scheduleSettingsSave();
    }
    renderProfiles(draft.id);
    return true;
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
    const isNew = !current || current.draft;
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
    const keyTyped = keyEditorDirty ? normalizeText($('#quicker_api_key_input').val()) : '';
    if (!keyTyped && !isNew) adoptNativeActiveSecret(current);
    // A protocol/URL change can move the credential to another key slot. Carry
    // the Profile's own key there; never adopt whatever that slot holds now.
    const slotChanged = !isNew && credentialSlot(current.format, current.endpoint) !== credentialSlot(format, editorUrl);
    let keyValue = keyTyped;
    if (!keyValue && slotChanged && profileHasCredential(current, current.format, current.endpoint)) {
        const carried = await readProfileCredential(current);
        if (!carried) {
            toastr.warning('协议或 URL 变更后密钥需存入新位置，但原密钥明文不可读：请在 Key 输入框重新填写后保存。');
            return;
        }
        keyValue = carried;
    }
    // Per-model formats in other key slots get their own copy of the key.
    const extraCredentials = await provisionModelCredentials(current, format, editorUrl, keyValue);
    if (!extraCredentials) return;
    let captureBase = current;
    if (keyValue) {
        const credentialDraft = normalizeProfile({ ...structuredClone(current), format });
        if (!await saveAndBindInputKey(credentialDraft, format, editorUrl, keyValue)) return;
        captureBase = credentialDraft;
    }
    // Capture the editor without changing the live connection first: applyProfile
    // must snapshot the original source/fields for credential verification/rollback.
    const retainedProxy = proxyMode && captureBase.format === format
        && normalizeText(captureBase.endpoint) === editorUrl ? getBoundProxyPreset(captureBase) : null;
    const ownProxyPassword = !isNew && proxyMode && usesProxyProfile(current.format, current.endpoint)
        ? String(getBoundProxyPreset(current)?.password || '') : undefined;
    const proxiesBefore = profileProxyNames(current);
    Object.assign(current, captureNativeProfile(current.name, format, captureBase, {
        endpoint: editorUrl,
        opencodeApiFormat: String($('#quicker_api_opencode_format').val() || ''),
        // A draft or a Profile moved to another slot never borrows the live
        // connection's proxy password.
        proxyPassword: keyValue || retainedProxy?.password || ownProxyPassword || (captureBase.draft || slotChanged ? '' : undefined),
    }));
    delete current.draft;
    current.extraCredentials = extraCredentials;
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
    if (!profiles().includes(current)) profiles().push(current);
    releaseUnusedProxyPresets(proxiesBefore);
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
    // A new channel is only applied; the current preset keeps its binding and
    // model until this channel is saved again or a native preset is saved.
    if (applied && presetName && !isNew && presetLinkEnabled()) {
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
    const usedBy = settings().quickActions.filter(action => action.profileId === profile.id).map((action, index) => quickActionDisplayName(action, index));
    const content = $('<div>').append($('<p>').text(`删除 Profile“${profile.name}”？`), $('<p>').text('不会删除任何原生密钥；相关原生预设绑定会被解除。'));
    if (usedBy.length) content.append($('<p>').text(`便捷方案「${usedBy.join('、')}」使用了该配置，删除后会被标记为失效，需要重新选择配置。`));
    if (!await callQuickerPopup(content, POPUP_TYPE.CONFIRM)) return;
    removeProfileData(profile);
    scheduleSettingsSave();
    renderProfiles();
}


async function findMatchingSecret(key, value) {
    if (!await canReadSecretPlaintext()) return { entry: null, exposureAvailable: false, exposureBlocked: 'not-allowed' };
    const entries = getSecretEntries(key);
    // Nothing saved yet means there is nothing to compare against.
    if (!entries.length) return { entry: null, exposureAvailable: true };
    let readable = false;
    for (const entry of entries) {
        const existing = await findSecretBounded(key, entry.id);
        if (existing === null) continue;
        readable = true;
        if (existing === value) return { entry, exposureAvailable: true };
    }
    return { entry: null, exposureAvailable: readable, exposureBlocked: readable ? '' : 'lookup-failed' };
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
    return { id: verified ? id : '', reused: false, exposureAvailable: match.exposureAvailable, exposureBlocked: match.exposureBlocked || '' };
}

async function saveAndBindInputKey(profile = selectedProfile(), requestedFormat = profile?.format, endpointOverride = null, valueOverride = null) {
    if (!profile) {
        toastr.info('请先选择或新建配置。');
        return false;
    }
    const format = normalizeFormat(requestedFormat);
    const config = FORMATS[format];
    const endpoint = endpointOverride === null ? String(oai_settings[config.endpointField] || '') : String(endpointOverride || '');
    const value = normalizeText(valueOverride ?? ($('#quicker_api_key_input').val() || $(config.keyInput).val()));
    if (usesProxyProfile(format, endpoint)) {
        if (!value) return true;
        profile.proxyPreset = ensureBoundProxyPreset(profile.name, endpoint, value, profile.proxyPreset, profile.id);
        profile.secretId = '';
        profile.needsSecret = false;
        oai_settings.proxy_password = value;
        setNativeProxyPasswordField(value);
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
    if (!result.exposureAvailable) {
        toastr.warning(result.exposureBlocked === 'not-allowed'
            ? '凭据已保存；未允许查看密钥，无法检查历史密钥是否同值。'
            : '凭据已保存；读取历史密钥失败，无法检查是否同值。');
    }
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
    setFavoriteModels(profile, [...(profile.availableModels || []), model]);
    profile.updatedAt = new Date().toISOString();
    scheduleSettingsSave();
    return useProviderModel(profile, model);
}

// Choosing a model is choosing its provider. This is the single path that
// writes a picked model into the host connection: the provider's own model
// when it is live, otherwise the provider is applied together with the model.
async function useProviderModel(profile, model) {
    const value = normalizeText(model);
    if (!profile || !value || platform.isModelAction(value)) return false;
    const editing = profile === selectedProfile();
    if (editing && getEditorModel() !== value) renderModelControl(profile, value);
    if (editing && (profile.draft || editorConnectionDirty(profile))) {
        // An unsaved connection is not live yet; the model waits for the save.
        renderStatus();
        return false;
    }
    if (editing && settings().activeProfileId === profile.id && profileMatchesNative(profile, { includeModel: false })
        && liveFormat(profile) === effectiveFormat(profile, value)) {
        syncEditorModelToNative();
        // Switching the model of the live provider is not a Profile edit.
        editorModelBaseline = value;
        renderStatus();
        return true;
    }
    if (profile.draft || !isFormatSupported(profile.format)) return false;
    clearKeyEditor();
    const applied = await applyProfileById(profile.id, quickActionTransaction, { model: value });
    if (applied) {
        editorModelBaseline = getEditorModel(profile.format);
        recordPresetModel(profile, value);
    }
    renderStatus();
    return applied;
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
    if (profile.draft) return toastr.info('请先填写并保存新配置的 URL 与 Key，再获取模型。');
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
        mainModelPicker.view = 'all';
        renderModelControl(profile, getEditorModel(profile.format) || profile.model);
        const stale = staleFavoriteModels(profile.availableModels, result.models);
        toastr.success(`通过${result.route}获取 ${result.models.length} 个模型，已切换到“全部”列表。`);
        if (stale.length) toastr.warning(`${stale.length} 个收藏模型不在云端最新列表中，可在“渠道管理”中一键清理。`);
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

// ---------------------------------------------------------------------------
// Channel manager: providers (connection + model catalog) in one place.
// Every edit is a draft; "保存" commits all channels, "取消" discards them.
// ---------------------------------------------------------------------------

function channelDraftFrom(profile) {
    return {
        id: profile.id,
        isNew: false,
        deleted: false,
        name: profile.name,
        format: profile.format,
        endpoint: profile.endpoint,
        opencodeApiFormat: profile.opencodeApiFormat || 'openai_compat',
        key: '',
        available: normalizeModelList(profile.availableModels),
        fetched: profileFetchedModels(profile),
        fetchedFromEndpoint: profileFetchedModels(profile).length ? normalizeText(profile.endpoint) : '',
        formats: { ...(profile.modelFormats || {}) },
    };
}

function newChannelDraft(name) {
    const format = isFormatSupported('openai') ? 'openai' : Object.keys(FORMATS).find(isFormatSupported);
    return {
        id: makeId(), isNew: true, deleted: false, name, format, endpoint: format === 'opencode' ? 'zen' : '',
        opencodeApiFormat: 'openai_compat', key: '', available: [], fetched: [], fetchedFromEndpoint: '', formats: {},
    };
}

const channelCatalogBaselines = new WeakMap();

function channelSnapshot(draft) {
    return JSON.stringify({ ...draft, available: normalizeModelList(draft.available), formats: channelModelFormats(draft) });
}

// Only favorites keep an override, and only one that differs from the channel.
function channelModelFormats(draft) {
    const favorites = new Set(normalizeModelList(draft.available));
    return normalizeModelFormats(Object.fromEntries(Object.entries(draft.formats || {}).filter(([model]) => favorites.has(model))), draft.format);
}

function channelConnectionChanged(draft, profile) {
    if (draft.isNew || !profile) return true;
    return draft.format !== profile.format
        || normalizeText(draft.endpoint) !== normalizeText(profile.endpoint)
        || (draft.format === 'opencode' && draft.opencodeApiFormat !== profile.opencodeApiFormat)
        || Boolean(normalizeText(draft.key));
}

// Saves a provider's connection without applying it: credentials are written
// into their key slots while every slot keeps its live key. A live provider is
// re-applied by the caller.
async function saveChannelConnection(profile, draft) {
    const format = normalizeFormat(draft.format);
    if (!isFormatSupported(format)) {
        toastr.warning(`“${draft.name}”：当前宿主不支持该格式。`);
        return false;
    }
    let endpoint = normalizeText(draft.endpoint).slice(0, 2048);
    try {
        if (format === 'opencode') endpoint = validateOpenCodeConnection(endpoint, draft.opencodeApiFormat);
    } catch (error) {
        toastr.warning(`“${draft.name}”：${error.message}`);
        return false;
    }
    if (isCustomFormat(format) && !endpoint) {
        toastr.warning(`“${draft.name}”：URL 不能为空。`);
        return false;
    }
    const proxyMode = usesProxyProfile(format, endpoint);
    if (!proxyMode && !await readAuthoritativeSecretState()) {
        toastr.error('无法读取权威密钥状态，已取消保存渠道。');
        return false;
    }
    const saved = !profile.draft && !draft.isNew;
    const slotChanged = saved && credentialSlot(profile.format, profile.endpoint) !== credentialSlot(format, endpoint);
    let keyValue = normalizeText(draft.key);
    if (!keyValue && slotChanged && profileHasCredential(profile, profile.format, profile.endpoint)) {
        const carried = await readProfileCredential(profile);
        if (!carried) {
            toastr.warning(`“${draft.name}”：协议或 URL 变更后密钥需存入新位置，但原密钥明文不可读：请在 API 密钥中重新填写后保存。`);
            return false;
        }
        keyValue = carried;
    }
    const extraCredentials = await provisionModelCredentials({ ...profile, name: draft.name, modelFormats: channelModelFormats(draft) }, format, endpoint, keyValue);
    if (!extraCredentials) return false;
    let secretId = saved && !slotChanged ? profile.secretId : '';
    let proxyPreset = '';
    if (proxyMode) {
        const password = keyValue || (saved && !slotChanged ? String(getBoundProxyPreset(profile)?.password || '') : '');
        proxyPreset = ensureBoundProxyPreset(draft.name, endpoint, password, saved && !slotChanged ? profile.proxyPreset : '', profile.id);
        secretId = '';
    } else if (keyValue) {
        secretId = await writeExtraSecret(FORMATS[format].secretKey, keyValue, draft.name);
        if (!secretId) {
            toastr.error(`“${draft.name}”：密钥保存或激活状态无法确认。`);
            return false;
        }
    }
    const endpointChanged = normalizeText(profile.endpoint) !== endpoint;
    Object.assign(profile, normalizeProfile({
        ...profile,
        format,
        endpoint,
        opencodeApiFormat: format === 'opencode' ? draft.opencodeApiFormat : '',
        includeBody: supportsCustomParameters(format) ? profile.includeBody : '',
        includeHeaders: supportsCustomParameters(format) ? profile.includeHeaders : '',
        secretId,
        proxyPreset,
        needsSecret: !proxyMode && (!secretId || secretId === settings().emptySecretIds[FORMATS[format].secretKey]),
        extraCredentials,
        fetchedModels: endpointChanged ? [] : profile.fetchedModels,
        fetchedFromEndpoint: endpointChanged ? '' : profile.fetchedFromEndpoint,
        draft: false,
        updatedAt: new Date().toISOString(),
    }));
    delete profile.draft;
    return true;
}

function removeProfileData(profile) {
    settings().profiles = profiles().filter(item => item.id !== profile.id);
    for (const [name, id] of Object.entries(settings().presetBindings)) {
        if (id === profile.id) {
            delete settings().presetBindings[name];
            delete settings().presetModels[name];
        }
    }
    if (settings().activeProfileId === profile.id) settings().activeProfileId = null;
    if (settings().selectedProfileId === profile.id) settings().selectedProfileId = null;
    releaseUnusedProxyPresets(profileProxyNames(profile));
}

async function manageChannels(initialId = settings().selectedProfileId) {
    if (extensionDisabled || teardownPending) return;
    const drafts = new Map(profiles().filter(profile => !profile.draft).map(profile => [profile.id, channelDraftFrom(profile)]));
    // Unsaved panel drafts become new channels here.
    for (const profile of profiles().filter(item => item.draft)) {
        drafts.set(profile.id, { ...newChannelDraft(profile.name), id: profile.id, format: profile.format, endpoint: profile.endpoint, isNew: true, panelDraft: true });
    }
    const initial = new Map([...drafts].map(([id, draft]) => [id, channelSnapshot(draft)]));
    let currentId = drafts.has(initialId) ? initialId : drafts.keys().next().value || null;
    let catalog = null;

    const content = $('<div class="quicker-api__channels" data-view="detail">');
    const sidebar = $(`<aside class="quicker-api__channels-sidebar" aria-label="渠道列表">
        <div class="quicker-api__channels-head">
            <h3><i class="fa-solid fa-server"></i><span>渠道</span></h3>
            <button type="button" class="menu_button quicker-api__channel-new" data-channel-action="new" title="新建渠道"><i class="fa-solid fa-plus"></i><span>新建</span></button>
        </div>
        <div class="quicker-api__channels-list" role="listbox" aria-label="渠道"></div>
    </aside>`);
    const detail = $('<section class="quicker-api__channel-detail">');
    content.append(sidebar, detail);
    const list = sidebar.find('.quicker-api__channels-list');

    const isLive = id => settings().activeProfileId === id && Boolean(profiles().find(item => item.id === id && !item.draft && profileMatchesNative(item, { includeModel: false })));
    const isDirty = draft => draft.isNew || draft.deleted || channelSnapshot(draft) !== initial.get(draft.id);

    const renderSidebar = () => {
        list.empty();
        const visible = [...drafts.values()].filter(draft => !draft.deleted);
        if (!visible.length) list.append($('<div class="quicker-api__empty-state">').text('还没有渠道'));
        for (const draft of visible) {
            const live = isLive(draft.id);
            list.append($('<button type="button" class="quicker-api__channel-item" role="option">')
                .attr({ 'data-channel-id': draft.id, 'aria-selected': String(draft.id === currentId) })
                .toggleClass('is-active', draft.id === currentId)
                .append(
                    $('<span class="quicker-api__channel-avatar" aria-hidden="true">').text((draft.name || '?').slice(0, 1).toUpperCase()),
                    $('<span class="quicker-api__channel-text">').append(
                        $('<span class="quicker-api__channel-name">').text(draft.name || '未命名'),
                        $('<small class="quicker-api__channel-format">').text(`${formatShortLabel(draft.format)} · ${normalizeModelList(draft.available).length} 个模型`),
                    ),
                    $('<span class="quicker-api__channel-flags">').append(
                        live ? $('<i class="quicker-api__channel-live" title="生效中">') : null,
                        isDirty(draft) ? $('<i class="quicker-api__channel-dirty" title="有未保存的修改">') : null,
                    ),
                ));
        }
    };

    const refreshChrome = () => {
        renderSidebar();
        const draft = drafts.get(currentId);
        if (!draft) return;
        detail.find('.quicker-api__channel-title').text(draft.name || '未命名');
    };

    const renderDetail = () => {
        detail.empty();
        catalog = null;
        const draft = drafts.get(currentId);
        if (!draft || draft.deleted) {
            detail.append($('<div class="quicker-api__channel-empty">').append(
                $('<i class="fa-solid fa-server" aria-hidden="true">'),
                $('<p>').text('选择左侧渠道进行编辑，或新建一个渠道。'),
                $('<button type="button" class="menu_button" data-channel-action="new"><i class="fa-solid fa-plus"></i><span>新建渠道</span></button>'),
            ));
            return;
        }
        const profile = profiles().find(item => item.id === draft.id) || null;
        const live = isLive(draft.id);
        const header = $(`<header class="quicker-api__channel-header">
            <button type="button" class="menu_button quicker-api__channel-back" data-channel-action="back" title="返回渠道列表" aria-label="返回渠道列表"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="quicker-api__channel-heading"><h3 class="quicker-api__channel-title"></h3></div>
            <div class="quicker-api__channel-header-actions"></div>
        </header>`);
        header.find('.quicker-api__channel-heading').append(
            live ? $('<span class="quicker-api__channel-badge is-live"><i class="fa-solid fa-circle"></i>生效中</span>') : null,
        );
        header.find('.quicker-api__channel-header-actions').append(
            draft.isNew ? $('<span class="quicker-api__channel-badge">未保存</span>') : null,
            $('<button type="button" class="menu_button quicker-api__channel-delete" data-channel-action="delete" title="删除渠道"><i class="fa-solid fa-trash"></i><span>删除</span></button>'),
        );
        header.find('.quicker-api__channel-title').text(draft.name || '未命名');

        const formatSelect = $('<select class="text_pole" data-field="format">');
        for (const [key, config] of Object.entries(FORMATS)) {
            if (isFormatSupported(key) || key === draft.format) formatSelect.append($('<option>').val(key).text(config.label).prop('disabled', !isFormatSupported(key)));
        }
        formatSelect.val(draft.format);
        const opencodeSelect = $('<select class="text_pole" data-field="opencodeApiFormat">');
        for (const option of $('#quicker_api_opencode_format option').toArray()) opencodeSelect.append($('<option>').val(option.value).text(option.textContent));
        if (!opencodeSelect.children().length) opencodeSelect.append($('<option>').val('openai_compat').text('OpenAI Chat'));
        opencodeSelect.val(draft.opencodeApiFormat);
        const keyInput = $('<input class="text_pole" type="password" autocomplete="new-password" spellcheck="false" data-field="key">').val(draft.key);
        const field = (label, control, extraClass = '') => $(`<label class="quicker-api__channel-field ${extraClass}">`).append($('<span>').text(label), control);
        const connection = $('<div class="quicker-api__channel-card" data-card="connection">').append(
            $('<h4><i class="fa-solid fa-plug"></i><span>连接</span></h4>'),
            $('<div class="quicker-api__channel-grid">').append(
                field('名称', $('<input class="text_pole" type="text" maxlength="120" autocomplete="off" data-field="name">').val(draft.name)),
                field('API 协议', formatSelect),
                field('API 地址', $('<input class="text_pole" type="url" autocomplete="off" spellcheck="false" maxlength="2048" data-field="endpoint" placeholder="https://example.com/v1">').val(draft.endpoint), 'is-wide'),
                field('OpenCode 协议', opencodeSelect, 'quicker-api__channel-opencode'),
                field('API 密钥', $('<div class="quicker-api__channel-key">').append(
                    keyInput,
                    $('<button type="button" class="menu_button" data-channel-action="reveal" title="显示/隐藏输入的密钥" aria-label="显示/隐藏输入的密钥"><i class="fa-solid fa-eye"></i></button>'),
                ), 'is-wide'),
            ),
            // Only what the key input's placeholder cannot say.
            $('<small class="quicker-api__channel-hint" data-role="credential-hint" hidden>'),
        );
        const models = $('<div class="quicker-api__channel-card" data-card="models">');
        detail.append(header, connection, models);
        catalog = buildChannelCatalog(draft, profile, {
            onChange: () => { refreshChrome(); renderCredentialHint(); },
        });
        models.append(catalog.element);

        const renderCredentialHint = () => {
            const slot = credentialSlot(draft.format, normalizeText(draft.endpoint));
            const saved = profile && !profile.draft && !draft.isNew;
            const hasOwn = saved && credentialSlot(profile.format, profile.endpoint) === slot && profileHasCredential(profile, profile.format, profile.endpoint);
            const extraSlots = [...new Set(profileFormats({ format: draft.format, modelFormats: channelModelFormats(draft) })
                .map(format => credentialSlot(format, normalizeText(draft.endpoint))).filter(item => item !== slot))];
            const parts = [];
            if (!normalizeText(draft.key) && !hasOwn && saved && profileHasCredential(profile, profile.format, profile.endpoint)) parts.push('协议或地址变更：保存时沿用原密钥（不可读时需重新填写）。');
            if (extraSlots.length) parts.push(`部分模型的格式另需「${extraSlots.map(credentialSlotLabel).join('、')}」密钥，保存时会写入同一密钥。`);
            connection.find('[data-role="credential-hint"]').text(parts.join(' ')).prop('hidden', !parts.length);
            keyInput.attr('placeholder', hasOwn ? '留空使用已保存凭据' : (usesProxyProfile(draft.format, normalizeText(draft.endpoint)) ? '代理密码' : 'API Key'));
            connection.find('.quicker-api__channel-opencode').prop('hidden', draft.format !== 'opencode');
        };
        renderCredentialHint();

        connection.on('input change', '[data-field]', function () {
            const name = this.dataset.field;
            draft[name] = name === 'name' ? String(this.value).slice(0, 120) : String(this.value);
            if (name === 'format') {
                if (draft.format === 'opencode' && !normalizeText(draft.endpoint)) {
                    draft.endpoint = 'zen';
                    connection.find('[data-field="endpoint"]').val('zen');
                }
                catalog?.refreshFormats();
            }
            if (name === 'endpoint' || name === 'format' || name === 'opencodeApiFormat' || name === 'key') catalog?.refreshFetchState();
            renderCredentialHint();
            refreshChrome();
        }).on('keydown', 'input', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation(); // Host Popup treats Enter as confirmation.
            }
        });
    };

    const selectChannel = id => {
        currentId = id;
        content.attr('data-view', 'detail');
        renderSidebar();
        renderDetail();
    };

    content.on('click', '[data-channel-id]', function () {
        selectChannel(this.dataset.channelId);
    });
    content.on('click', '[data-channel-action]', async function () {
        const action = this.dataset.channelAction;
        if (action === 'back') return content.attr('data-view', 'list');
        if (action === 'reveal') {
            const input = detail.find('[data-field="key"]');
            const show = input.attr('type') === 'password';
            input.attr('type', show ? 'text' : 'password');
            $(this).find('i').attr('class', show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye');
            return;
        }
        if (action === 'new') {
            const used = new Set([...drafts.values()].filter(draft => !draft.deleted).map(draft => draft.name.toLocaleLowerCase()));
            let index = drafts.size + 1;
            while (used.has(`渠道 ${index}`.toLocaleLowerCase())) index++;
            const draft = newChannelDraft(`渠道 ${index}`);
            drafts.set(draft.id, draft);
            selectChannel(draft.id);
            detail.find('[data-field="name"]').trigger('focus').trigger('select');
            return;
        }
        if (action === 'delete') {
            const draft = drafts.get(currentId);
            if (!draft) return;
            if (draft.isNew && !draft.panelDraft) drafts.delete(draft.id);
            else draft.deleted = true;
            currentId = [...drafts.values()].find(item => !item.deleted)?.id || null;
            content.attr('data-view', currentId ? 'detail' : 'list');
            renderSidebar();
            renderDetail();
            toastr.info(`已标记删除“${draft.name}”，点击保存后生效。`);
        }
    });

    renderSidebar();
    renderDetail();

    const commit = async () => {
        const deleted = [...drafts.values()].filter(draft => draft.deleted);
        const usedBy = deleted.flatMap(draft => settings().quickActions.filter(action => action.profileId === draft.id).map((action, index) => quickActionDisplayName(action, index)));
        if (deleted.length) {
            const message = $('<div>').append(
                $('<p>').text(`删除渠道“${deleted.map(draft => draft.name).join('、')}”？`),
                $('<p>').text('不会删除任何原生密钥；相关原生预设绑定会被解除。'),
            );
            if (usedBy.length) message.append($('<p>').text(`便捷方案「${usedBy.join('、')}」使用了这些渠道，删除后会被标记为失效。`));
            if (!await callQuickerPopup(message, POPUP_TYPE.CONFIRM)) return false;
        }
        const names = new Map();
        for (const draft of drafts.values()) {
            if (draft.deleted) continue;
            const name = sanitizeName(draft.name);
            if (!name) {
                selectChannel(draft.id);
                toastr.warning('渠道名称不能为空。');
                return false;
            }
            if (names.has(name.toLocaleLowerCase())) {
                selectChannel(draft.id);
                toastr.warning(`渠道名称“${name}”重复。`);
                return false;
            }
            names.set(name.toLocaleLowerCase(), draft.id);
            draft.name = name;
        }
        const liveBefore = profiles().find(item => item.id === settings().activeProfileId && isLive(item.id)) || null;
        const liveFormatBefore = liveBefore ? liveFormat(liveBefore) : null;
        const liveModel = liveFormatBefore ? nativeModelFor(liveFormatBefore) : '';
        let reapply = false;
        // Saving writes credentials into key slots: block generation and
        // native key adoption for the whole commit.
        const transitionWasBlocked = presetTransitionBlocked;
        beginPresetTransition();
        try {
            for (const draft of deleted) {
                const profile = profiles().find(item => item.id === draft.id);
                if (profile) removeProfileData(profile);
            }
            for (const draft of drafts.values()) {
                if (draft.deleted || !isDirty(draft)) continue;
                let profile = profiles().find(item => item.id === draft.id);
                if (!profile) profile = normalizeProfile({ id: draft.id, name: draft.name, format: draft.format, draft: true });
                const proxiesBefore = profileProxyNames(profile);
                if (channelConnectionChanged(draft, profile.draft ? null : profile)) {
                    if (!await saveChannelConnection(profile, draft)) {
                        selectChannel(draft.id);
                        scheduleSettingsSave();
                        return false;
                    }
                    if (!profiles().includes(profile)) profiles().push(profile);
                    if (profile === liveBefore) reapply = true;
                } else {
                    const nextFormats = channelModelFormats(draft);
                    const extra = await provisionModelCredentials({ ...profile, modelFormats: nextFormats }, profile.format, profile.endpoint, '');
                    if (!extra) {
                        selectChannel(draft.id);
                        return false;
                    }
                    profile.extraCredentials = extra;
                }
                profile.name = uniqueName(draft.name, profile.id);
                profile.modelFormats = channelModelFormats({ ...draft, format: profile.format });
                setFavoriteModels(profile, draft.available);
                releaseUnusedProxyPresets(proxiesBefore);
                if (normalizeText(draft.fetchedFromEndpoint) === normalizeText(profile.endpoint) && draft.fetched.length) {
                    profile.fetchedModels = normalizeModelList(draft.fetched);
                    profile.fetchedFromEndpoint = profile.endpoint;
                }
                profile.updatedAt = new Date().toISOString();
                draft.isNew = false;
                delete draft.panelDraft;
                initial.set(draft.id, channelSnapshot(draft));
                if (profile === liveBefore && liveModel && effectiveFormat(profile, liveModel) !== liveFormatBefore) reapply = true;
            }
        } finally {
            if (!transitionWasBlocked) endPresetTransition();
        }
        scheduleSettingsSave();
        if (reapply && liveBefore && profiles().includes(liveBefore)) {
            const applied = await applyProfileById(liveBefore.id, quickActionTransaction, { model: liveModel || liveBefore.model });
            if (!applied) toastr.warning(`“${liveBefore.name}”已保存，但未能重新应用；请检查连接与密钥后重新选择。`);
        }
        renderProfiles(settings().selectedProfileId);
        if (await persistSettingsNow()) toastr.success('渠道已保存。');
        return true;
    };

    await callQuickerPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        okButton: '保存',
        cancelButton: '取消',
        animation: 'none',
        onClosing: async popup => (popup.result ? await commit() : true),
    });
    catalog = null;
}

// The model catalog of one channel draft: favorites (with per-model formats,
// order and editing) and the remote snapshot (fetch, search, bulk selection).
function buildChannelCatalog(draft, profile, { onChange }) {
    const content = $('<div class="quicker-api__model-manager quicker-api__model-manager--paged">');
    const pageTabs = $(`<div class="quicker-api__manager-pages" role="tablist" aria-label="模型目录">
        <button type="button" role="tab" class="menu_button" data-page="chosen"><i class="fa-solid fa-star"></i><span>收藏目录</span><small></small></button>
        <button type="button" role="tab" class="menu_button" data-page="remote"><i class="fa-solid fa-cloud-arrow-down"></i><span>远端模型</span><small></small></button>
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
    showPage('chosen');
    const remoteActions = $('<div class="quicker-api__manager-actions">').append(
        $('<button type="button" class="menu_button" data-action="fetch"><i class="fa-solid fa-arrows-rotate"></i><span>获取可用模型</span></button>'),
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
        $('<button type="button" class="menu_button" data-action="reset" title="撤销本次对这个渠道收藏目录的所有修改（增删、排序、格式），回到打开渠道管理时的样子">撤销修改</button>'),
    );
    const remoteSearch = $('<div class="quicker-api__model-search">');
    const searchInput = $('<input class="text_pole" type="search" autocomplete="off" placeholder="搜索远端模型" aria-label="搜索远端模型">');
    const clearSearch = $('<button type="button" class="menu_button" aria-label="清空模型搜索">清空搜索</button>');
    const searchCount = $('<small class="quicker-api__model-search-count" role="status" aria-live="polite">');
    remoteSearch.append(searchInput, clearSearch);
    const searchHelp = $('<small class="quicker-api__model-search-help">').text('忽略大小写，支持部分名称或按顺序输入不连续字符；筛选时批量操作仅影响匹配项。');
    const fetchHint = $('<small class="quicker-api__model-search-help quicker-api__fetch-hint">');
    const remoteList = $('<div class="quicker-api__model-list">');
    const chosenList = $('<div class="quicker-api__model-list">');
    const chosenTitle = $('<h4><i class="fa-solid fa-star"></i> 收藏（模型下拉中的“收藏”列表）</h4>');
    const staleBadge = $('<span class="quicker-api__stale-badge" role="status" aria-live="polite">');
    chosenTitle.append(staleBadge);
    const formatHelp = $('<small class="quicker-api__model-search-help">').text('每个模型可单独指定 API 协议；“跟随渠道”时使用渠道的协议。');
    remotePanel.append($('<h4><i class="fa-solid fa-cloud-arrow-down"></i> 远端模型（勾选 = 收藏）</h4>'), remoteActions, fetchHint, remoteSearch, searchHelp, searchCount, remoteList);
    chosenPanel.append(chosenTitle, chosenActions, formatHelp, chosenList);
    columns.append(chosenPanel, remotePanel);
    content.append(pageTabs, columns);

    // The catalog as it was when the manager opened, kept across channel switches.
    if (!channelCatalogBaselines.has(draft)) channelCatalogBaselines.set(draft, structuredClone({ available: draft.available, fetched: draft.fetched, fetchedFromEndpoint: draft.fetchedFromEndpoint, formats: draft.formats }));
    const initialCatalog = channelCatalogBaselines.get(draft);
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
    // Fetching uses the saved connection and credential.
    const fetchBlocker = () => {
        if (!profile || profile.draft || draft.isNew) return '新渠道需先保存连接，才能获取可用模型。';
        if (channelConnectionChanged(draft, profile)) return '连接有未保存的修改，保存后才能获取可用模型。';
        return '';
    };
    const refreshFetchState = () => {
        const blocker = fetchBlocker();
        fetchHint.text(blocker).prop('hidden', !blocker);
        remoteActions.find('[data-action="fetch"]').attr('title', blocker || '从当前渠道获取模型列表');
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
    const fillFormatSelect = select => {
        const choices = modelFormatChoices({ format: draft.format }).filter(format => format !== draft.format);
        select.replaceChildren();
        const follow = document.createElement('option');
        follow.value = '';
        follow.textContent = `跟随渠道（${formatShortLabel(draft.format)}）`;
        select.append(follow);
        for (const format of choices) {
            const option = document.createElement('option');
            option.value = format;
            option.textContent = formatShortLabel(format);
            select.append(option);
        }
        select.hidden = !choices.length;
        select.dataset.channelFormat = draft.format;
    };
    const chosenRows = new Map();
    const chosenEmpty = document.createElement('div');
    chosenEmpty.className = 'quicker-api__empty-state';
    chosenEmpty.textContent = '收藏列表为空：在“远端模型”中勾选，或输入自定义模型 ID 新增';
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
        const format = document.createElement('select');
        format.className = 'text_pole quicker-api__model-format-select';
        format.setAttribute('aria-label', `${model} 的 API 协议`);
        fillFormatSelect(format);
        const up = chosenButton('up', 'fa-arrow-up', '上移');
        const down = chosenButton('down', 'fa-arrow-down', '下移');
        const actions = document.createElement('div');
        actions.className = 'quicker-api__item-actions';
        actions.append(chosenButton('edit', 'fa-pen', '编辑'), chosenButton('remove', 'fa-trash', '删除'), up, down);
        row.append(position, input, label, format, actions);
        const entry = { row, position, input, label, format, up, down, index: -1, source: '' };
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
            if (entry.format.dataset.channelFormat !== draft.format) fillFormatSelect(entry.format);
            const override = draft.formats[model] && draft.formats[model] !== draft.format ? draft.formats[model] : '';
            if (entry.format.value !== override) entry.format.value = [...entry.format.options].some(option => option.value === override) ? override : '';
            entry.row.classList.toggle('has-format', Boolean(entry.format.value));
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
        onChange?.();
    };
    const renderCatalog = () => {
        normalizeDraft();
        if (renderedFetched !== draft.fetched) buildRemoteRows();
        syncRemoteChecks();
        syncRemoteFilter();
        renderChosen();
        refreshFetchState();
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
        if (next !== model && draft.formats[model]) {
            draft.formats[next] = draft.formats[model];
            delete draft.formats[model];
        }
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
        if (op === 'remove') {
            delete draft.formats[draft.available[index]];
            draft.available.splice(index, 1);
        }
        const swap = op === 'up' ? index - 1 : op === 'down' ? index + 1 : -1;
        if (swap >= 0 && swap < draft.available.length) {
            [draft.available[swap], draft.available[index]] = [draft.available[index], draft.available[swap]];
        }
        updateDraft();
    }).on('change', '.quicker-api__model-format-select', function () {
        const index = Number(this.closest('.quicker-api__chosen-model')?.dataset.index);
        const model = draft.available[index];
        if (model === undefined) return;
        if (this.value) draft.formats[model] = this.value;
        else delete draft.formats[model];
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
            const blocker = fetchBlocker();
            if (blocker) return toastr.info(blocker);
            const button = $(this).prop('disabled', true);
            const endpoint = normalizeText(profile.endpoint);
            try {
                const result = await fetchModelsForProfile(profile, endpoint);
                draft.fetched = result.models;
                draft.fetchedFromEndpoint = endpoint;
                toastr.success(`通过${result.route}获取 ${result.models.length} 个模型；点击保存后保存快照。`);
            } catch (error) {
                console.error('[QuickerApi] Channel manager fetch failed:', error);
                toastr.error(`获取模型失败：${error.message}`);
            } finally {
                button.prop('disabled', false);
                renderCatalog();
                onChange?.();
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
            toastr.info(`已移除 ${stale.size} 个失效收藏；点击保存后生效。`);
        }
        if (action === 'clear') {
            draft.available = [];
            draft.formats = {};
            updateDraft();
        }
        if (action === 'reset') {
            Object.assign(draft, structuredClone(initialCatalog));
            renderCatalog();
            onChange?.();
        }
    });
    customInput.on('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation(); // Host Popup treats Enter as confirmation.
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
    renderCatalog();
    return {
        element: content,
        refreshFormats: renderChosen,
        refreshFetchState,
    };
}

function quickActionDisplayName(action, index = 0) {
    return sanitizeName(action.name) || `方案${index + 1}`;
}

function nativePresetNames() {
    return $('#settings_preset_openai option').map((_, option) => normalizeText(option.textContent)).get().filter(Boolean);
}

// References a scheme holds that no longer resolve. A scheme with problems is
// kept (and flagged) but never executed until it is fixed.
function quickActionProblems(action) {
    const problems = [];
    if (action?.profileId && !profiles().some(profile => profile.id === action.profileId)) problems.push('引用的 API 配置已不存在');
    if (action?.preset && !nativePresetNames().includes(action.preset)) problems.push(`预设“${action.preset}”已不存在`);
    return problems;
}

// Value the preset would send: the scheme's own preset, otherwise the current one.
function presetParameterValue(presetName, spec) {
    const preset = presetName ? nativePresetByName(presetName) : null;
    const value = Number(preset && Object.hasOwn(preset, spec.setting) ? preset[spec.setting] : oai_settings[spec.setting]);
    return Number.isFinite(value) ? value : null;
}

function quickActionParametersEditor(draft, onChange) {
    const params = draft.params;
    const root = $('<fieldset class="quicker-api__quick-params">').toggleClass('is-enabled', params.enabled);
    const toggle = $('<input type="checkbox">').prop('checked', params.enabled);
    const presetLabel = draft.preset || '当前预设';
    root.append($('<legend>').append($('<label class="checkbox_label quicker-api__quick-params-toggle">').append(
        toggle, $('<span>').text('预设参数'),
        $('<small>').text(params.enabled ? `覆盖“${presetLabel}”的采样参数` : '关闭：参数跟随预设'),
    )));
    const rows = $('<div class="quicker-api__quick-params-rows">').prop('hidden', !params.enabled);
    for (const spec of QUICK_ACTION_PARAMETERS) {
        const entry = params[spec.key];
        const presetValue = presetParameterValue(draft.preset, spec);
        const send = $('<input type="checkbox">').prop('checked', entry.send).attr('aria-label', `发送${spec.label}`);
        const range = $('<input type="range" step="0.01">').attr({ min: spec.min, max: spec.max, 'aria-label': spec.label });
        const number = $('<input class="text_pole" type="number" step="0.01">').attr({ min: spec.min, max: spec.max, 'aria-label': `${spec.label}数值`, placeholder: presetValue === null ? '' : String(presetValue) });
        const shown = entry.value ?? presetValue ?? spec.min;
        range.val(shown);
        number.val(entry.value ?? '');
        const hint = $('<small class="quicker-api__quick-param-hint">');
        const row = $('<div class="quicker-api__quick-param">').append(
            $('<label class="checkbox_label">').attr('title', '取消勾选则本方案不发送该参数').append(send, $('<span>').text(spec.label)),
            range, number, hint,
        );
        const renderRow = () => {
            row.toggleClass('is-off', !entry.send);
            range.prop('disabled', !entry.send);
            number.prop('disabled', !entry.send);
            hint.text(!entry.send ? '不发送' : entry.value === null ? `跟随预设（${presetValue ?? '—'}）` : `预设 ${presetValue ?? '—'}`);
        };
        const refresh = () => { renderRow(); onChange(); };
        send.on('change', () => { entry.send = send.prop('checked'); refresh(); });
        range.on('input', () => {
            entry.value = normalizeQuickActionParameterValue(range.val(), spec);
            number.val(entry.value ?? '');
            refresh();
        });
        number.on('input', () => {
            entry.value = normalizeQuickActionParameterValue(number.val(), spec);
            if (entry.value !== null) range.val(entry.value);
            refresh();
        }).on('change', () => number.val(entry.value ?? ''));
        renderRow();
        rows.append(row);
    }
    rows.append($('<small class="quicker-api__quick-params-help">').text('数值留空表示跟随预设；取消勾选则该参数不会发送。仅在该方案处于使用中时生效，不修改预设文件。'));
    toggle.on('change', () => {
        params.enabled = toggle.prop('checked');
        root.toggleClass('is-enabled', params.enabled);
        rows.prop('hidden', !params.enabled);
        root.find('legend small').text(params.enabled ? `覆盖“${presetLabel}”的采样参数` : '关闭：参数跟随预设');
        onChange();
    });
    return root.append(rows);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

function presetOptionsHtml(selected = '') {
    const names = nativePresetNames();
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
    return ['<option value="">— 不切换 Profile —</option>', ...missing, ...profiles().filter(profile => !profile.draft || profile.id === selected).map(profile =>
        `<option value="${escapeHtml(profile.id)}"${profile.id === selected ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`,
    )].join('');
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
        render();
    };
    // The scheme's model uses the same dropdown as the main panel: a chosen
    // configuration opens on its favorites, no configuration on "格式".
    const quickProfile = () => profiles().find(item => item.id === detailDraft?.profileId && !item.draft) || null;
    const setQuickModel = model => {
        if (!detailDraft) return;
        detailDraft.model = normalizeText(model).slice(0, 500);
        renderEditor();
    };
    const fetchQuickModels = async () => {
        const profile = quickProfile();
        if (!profile) return;
        let fetchError = null;
        const result = await enqueueOperation(async () => {
            try {
                return await fetchModelsForProfile(structuredClone(profile), normalizeText(profile.endpoint));
            } catch (error) {
                fetchError = error;
                return null;
            }
        });
        // The operation queue does not settle until fetchModelsForProfile's
        // finally block has restored (or fail-closed) the Custom credential.
        if (!managerOpen || extensionDisabled || teardownPending || !profiles().includes(profile)) return;
        if (!result) {
            if (fetchError) console.error('[QuickerApi] Quick action model fetch failed:', fetchError);
            if (fetchError) toastr.error(`获取模型失败：${fetchError.message}`);
            return;
        }
        profile.fetchedModels = result.models;
        profile.fetchedFromEndpoint = normalizeText(profile.endpoint);
        profile.updatedAt = new Date().toISOString();
        scheduleSettingsSave();
        quickModelPicker.view = 'all';
        renderModelPickerOptions(quickModelPicker);
        updateModelTrigger(quickModelPicker);
        updateModelTrigger(mainModelPicker);
        toastr.success(`通过${result.route}获取 ${result.models.length} 个模型。`);
    };
    const quickModelPicker = {
        id: 'quicker_api_quick_model',
        view: 'favorites',
        emptyLabel: '— 不切换模型 —',
        profile: quickProfile,
        format: () => quickProfile()?.format || '',
        current: () => normalizeText(detailDraft?.model),
        // The dialog is in the top layer; the dropdown must live inside it.
        portalParent: () => popup.dlg || content[0],
        opening() { this.view = quickProfile() ? 'favorites' : 'formats'; },
        isPicked: () => true,
        canAdd: () => Boolean(detailDraft),
        addLabel: model => `使用“${model}”`,
        add: setQuickModel,
        addAction: query => query ? setQuickModel(query) : toastr.info('请在搜索框输入模型 ID。'),
        canFetch: data => Boolean(data.profile && hasManagedModels(data.profile.format) && normalizeText(data.profile.endpoint)),
        fetch: () => void fetchQuickModels(),
        pick(model, providerId) {
            if (providerId && detailDraft?.followChannel) detailDraft.profileId = providerId;
            setQuickModel(model);
        },
    };
    modelPickerHosts.set(quickModelPicker.id, quickModelPicker);
    const field = (label, control) => $('<label class="quicker-api__quick-field">').append($('<span>').text(label), control);
    const updateDetailSaveState = () => editor.toggleClass('has-unsaved-detail', Boolean(detailDraft) && JSON.stringify(detailDraft) !== detailBaseline);
    const renderEditor = () => {
        closeModelPicker({ host: quickModelPicker });
        editor.empty().removeClass('has-unsaved-detail');
        if (!detailDraft) {
            editor.append($('<div class="quicker-api__empty-state">').text('新增方案后，可自由组合 preset、Profile 与 model。'));
            return;
        }
        const name = $('<input class="text_pole" type="text" maxlength="120" placeholder="留空自动命名为方案N">').val(detailDraft.name);
        const preset = $(`<select class="text_pole">${presetOptionsHtml(detailDraft.preset)}</select>`);
        const profileSelect = $(`<select class="text_pole">${profileOptionsHtml(detailDraft.profileId)}</select>`);
        const clearModel = $('<button type="button" class="menu_button" title="不切换模型" aria-label="清除模型"><i class="fa-solid fa-xmark"></i></button>')
            .prop('disabled', !detailDraft.model)
            .on('click', () => { detailDraft.model = ''; renderEditor(); });
        const modelControl = $('<div class="quicker-api__quick-model-control">').append(buildModelPicker(quickModelPicker), clearModel);
        const followSwitch = $(`<label class="quicker-api__switch" for="quicker_api_quick_follow_channel" title="开：从其他渠道或“格式”里选模型，会把“配置”一起改成该渠道。关：只写模型名，“配置”保持你自己选的（可为空，运行时作用于当时正在使用的连接）。">
                <input id="quicker_api_quick_follow_channel" class="quicker-api__switch-input" type="checkbox" role="switch" />
                <span class="quicker-api__switch-track" aria-hidden="true"><span class="quicker-api__switch-thumb"></span></span>
                <span class="quicker-api__switch-label">连同渠道一起切换</span>
            </label>`);
        // A div, not a <label>: the title row holds the switch's own label.
        const modelField = $('<div class="quicker-api__quick-field">').append(
            $('<div class="quicker-api__quick-field-head">').append($('<span>').text('模型'), followSwitch),
            modelControl,
        );
        followSwitch.find('input').prop('checked', detailDraft.followChannel).on('change', function () {
            detailDraft.followChannel = this.checked;
            updateDetailSaveState();
        });
        name.on('input', () => { detailDraft.name = sanitizeName(name.val()); updateDetailSaveState(); });
        preset.on('change', () => { detailDraft.preset = normalizeText(preset.val()); renderEditor(); });
        profileSelect.on('change', () => {
            detailDraft.profileId = normalizeText(profileSelect.val());
            renderEditor();
        });
        const saveScheme = $('<button type="button" class="menu_button quicker-api__save-button"><i class="fa-solid fa-floppy-disk"></i><span>保存方案</span></button>');
        const cancelScheme = $('<button type="button" class="menu_button"><span>取消</span></button>');
        saveScheme.on('click', () => {
            if (!detailDraft.preset && !detailDraft.profileId && !detailDraft.model) return toastr.warning('方案至少需要 preset、Profile 或 model 中的一项。');
            // Only the scheme being confirmed is validated; other schemes keep
            // their (possibly stale) references and are flagged in the list.
            const problems = quickActionProblems(detailDraft);
            if (problems.length) return toastr.warning(`${problems.join('；')}，请重新选择后再保存方案。`);
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
                field('名称', name), field('预设', preset), field('配置', profileSelect), modelField,
                quickActionParametersEditor(detailDraft, updateDetailSaveState),
            ),
            $('<div class="quicker-api__quick-editor-actions">').append(saveScheme, cancelScheme),
        );
        updateModelTrigger(quickModelPicker);
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
            const problems = quickActionProblems(action);
            if (problems.length) {
                row.addClass('is-broken');
                name.prepend($('<i class="fa-solid fa-triangle-exclamation quicker-api__quick-broken" aria-hidden="true"></i>'))
                    .attr('title', `${quickActionDisplayName(action, index)}：${problems.join('；')}`);
            }
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
        const broken = globalDraft.filter(action => quickActionProblems(action).length).length;
        globalDraft.forEach((action, index) => {
            action.name = sanitizeName(action.name) || `方案${index + 1}`;
            action.sequence = index;
        });
        if (managerSaving) return;
        managerSaving = true;
        content.find('.quicker-api__quick-columns').prop('inert', true);
        placementButton.prop('disabled', true);
        settings().quickActions = structuredClone(globalDraft);
        if (!globalDraft.some(action => action.id === settings().activeQuickActionId)) settings().activeQuickActionId = '';
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
            if (broken) toastr.warning(`${broken} 个方案引用的配置或预设已不存在（列表中以 ⚠ 标出），在修复前无法执行。`);
            void popup.completeAffirmative();
        }
    });
    render();
    let result = null;
    try {
        result = await popup.show();
    } finally {
        managerOpen = false;
        closeModelPicker({ host: quickModelPicker });
        modelPickerHosts.delete(quickModelPicker.id);
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
    withEditorSync(() => {
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
    });
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

async function applyProfileById(profileId, token = quickActionTransaction, { applyModel = true, manageTransition = true, model = null } = {}) {
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
            return await applyProfile(profile, generation, true, applyModel, model);
        });
    } finally {
        if (manageTransition) endPresetTransition();
    }
}

async function runQuickAction(action, token) {
    if (extensionDisabled || teardownPending || token !== quickActionTransaction) return;
    closeQuickActionMenu();
    const problems = quickActionProblems(action);
    if (problems.length) {
        toastr.error(`${quickActionDisplayName(action)}无法执行：${problems.join('；')}。请在“便捷按钮管理”中重新选择。`);
        return;
    }
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
            // A scheme model is applied together with its provider so its own
            // per-model format and credential are used.
            const options = action.model ? { model: action.model, manageTransition: false } : { applyModel: !action.preset, manageTransition: false };
            if (!profile || !await applyProfileById(action.profileId, token, options)) {
                if (token === quickActionTransaction) toastr.error('便捷方案的 Profile 未能安全应用。');
                return;
            }
        }
        if (token !== quickActionTransaction) return;
        if (action.model && !profile && !applyExplicitModel(action.model, '')) {
            toastr.error('便捷方案模型写入验证失败。');
            return;
        }
        if (token !== quickActionTransaction) return;
        renderProfiles(settings().selectedProfileId);
        if (action.model) renderModelControl(profile || selectedProfile(), action.model);
        settings().activeQuickActionId = action.id;
        scheduleSettingsSave();
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
    const current = activeQuickAction();
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
        const inUse = action === current;
        const broken = quickActionProblems(action).length > 0;
        menu.append($('<li class="list-group-item ctx-item" role="listitem" tabindex="0" data-quicker-api-actionable="true">')
            .toggleClass('is-active', inUse).toggleClass('is-broken', broken)
            .attr({ title: broken ? `${name}（引用的配置或预设已不存在）` : inUse ? `${name}（当前正在使用）` : name, 'aria-current': inUse ? 'true' : null })
            .append(
                $('<div class="qr--button-icon fa-solid">').addClass(broken ? 'fa-triangle-exclamation' : 'fa-check').toggleClass('qr--hidden', !inUse && !broken),
                $('<div class="qr--button-label">').text(name),
                action.params?.enabled ? $('<div class="quicker-api__quick-menu-params fa-solid fa-sliders" title="此方案自定义了预设参数">') : null,
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

function handleNativePresetChangeBefore({ presetName, preset, settingsToUpdate } = {}) {
    if (extensionDisabled || settings().nativeUi) return;
    if (!presetLinkEnabled()) return stripPresetConnection(preset, settingsToUpdate);
    beginPresetSwitch(preset);
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
    try {
        return await applyNativePresetChange();
    } finally {
        finishPresetSwitch();
    }
}

async function applyNativePresetChange() {
    if (extensionDisabled || settings().nativeUi) return false;
    platform.syncParameterEditors();
    if (!presetLinkEnabled()) {
        // The connection was stripped from the preset; only parameters changed.
        renderStatus();
        return false;
    }
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
        if (settingsObservation) markSettingsSaveSent(settingsObservation.snapshot);
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
    if (extensionDisabled || teardownPending || settings().nativeUi || !presetLinkEnabled()) return;
    if (!SUPPORTED_SOURCES.has(oai_settings.chat_completion_source)) return;
    const profile = selectedProfile();
    const stop = message => {
        event.preventDefault();
        event.stopImmediatePropagation();
        toastr.warning(message);
    };
    if (pendingOperations || presetTransitionBlocked) return stop('API 配置正在切换，请完成后再保存预设。');
    if (!profile || profile.draft) return; // Leave purely native saves and unsaved drafts alone.
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
    $('#quicker_api_mode').on('change', function () {
        const nativeUi = !this.checked;
        // Show the real state until the switch is accepted (it may be refused while busy).
        renderPanelMode();
        void setNativeUi(nativeUi);
    });
    window.addEventListener('pagehide', flushPanelState);
    window.addEventListener('beforeunload', warnBeforeLeaving);
    $('#quicker_api_profile_select').on('change', function () {
        clearKeyEditor();
        const profile = profiles().find(item => item.id === String($(this).val())) || null;
        settings().selectedProfileId = profile?.id || null;
        scheduleSettingsSave();
        if (!profile) return renderStatus();
        $('#quicker_api_format').val(profile.format);
        if (profile.draft) return renderProfiles(profile.id);
        // The current preset's binding remembers the model last used with it.
        const presetName = currentPresetName();
        const bound = presetLinkEnabled() && Boolean(presetName) && settings().presetBindings[presetName] === profile.id;
        void applyProfileById(profile.id, quickActionTransaction, { applyModel: !bound, manageTransition: true }).then(applied => {
            if (applied && bound && settings().activeProfileId === profile.id && currentPresetName() === presetName) {
                restoreBoundPresetModel(presetName, profile);
            }
        });
    });
    $('#quicker_api_format').on('change', function () {
        clearKeyEditor();
        const format = normalizeFormat($(this).val());
        if (retargetDraftFormat(format)) return;
        // The protocol belongs to the Profile draft: the host connection, URL and
        // credential stay untouched until the Profile is saved and applied.
        const profile = selectedProfile();
        const model = normalizeText($('#quicker_api_custom_model').val());
        renderOpenCodeFields(profile?.format === format ? profile : null, format);
        renderModelControl(profile, model);
        updateCredentialEditor(profile);
        renderStatus();
    });
    $('#quicker_api_new').on('click', () => void createProfile());
    $('#quicker_api_quick_url').on('click', toggleQuickUrlMenu);
    $('#quicker_api_additional_parameters').on('click', () => $('#customize_additional_parameters').trigger('click'));
    $('#quicker_api_preset_link').on('change', function () {
        settings().presetLink = $(this).prop('checked') === true;
        if (!settings().presetLink) clearNativePresetSaveIntent();
        scheduleSettingsSave();
        renderStatus();
    });
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
    eventSource.on(event_types.SECRET_ROTATED, handleNativeSecretChange);
    eventSource.on(event_types.SECRET_WRITTEN, handleNativeSecretChange);
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
        void useProviderModel(selectedProfile(), getEditorModel());
        updateModelTrigger();
        renderStatus();
    });
    bindModelPickerEvents();
    $(document).on('click.quickerApi', '#quicker_api_add_model', addCustomModel);
    $(document).on('click.quickerApi', '#quicker_api_fetch_models', () => void enqueueOperation(fetchCustomModels));
    $(document).on('click.quickerApi', '#quicker_api_channels', () => void manageChannels());
    $(document).on('click.quickerApi', '.quicker-api__manage-actions', () => void manageQuickActions());
    $('#custom_model_id').on('input.quickerApi', handleNativeModelChange);
    $('#model_claude_select, #model_google_select, #model_opencode_select').on('change.quickerApi', handleNativeModelChange);
    eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, handleNativeModelChange);
    $('#chat_completion_source').on('change.quickerApi', function () {
        platform.syncParameterEditors();
        updatePanelVisibility();
        // Preset-driven source changes are reconciled by the AFTER handler.
        if (presetTransitionBlocked) return;
        // The host's source only reports whether the selected Profile is live;
        // it never rewrites the Profile editor.
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

// Native editors the panel replaces while it manages the current source. The
// reverse-proxy drawer is where Claude/Gemini endpoints live natively; the
// panel owns those endpoints (and their bound proxy presets) itself.
function nativeProviderEditors() {
    return $('#custom_form, #claude_form, #makersuite_form').add($('#openai_proxy_preset').closest('.inline-drawer'));
}

function updatePanelVisibility() {
    const supported = SUPPORTED_SOURCES.has(String($('#chat_completion_source').val()));
    $('#quicker_api').toggle(supported);
    updateAdditionalParametersButton();
    nativeProviderEditors().toggleClass('quicker-api__native-provider', supported && !settings().nativeUi);
    renderPanelMode();
}

function renderPanelMode() {
    const nativeUi = settings().nativeUi;
    $('#quicker_api').toggleClass('is-native-ui', nativeUi);
    $('#quicker_api_mode')
        .prop('checked', !nativeUi)
        .closest('label').attr('title', nativeUi ? '开启后切回 Quicker Api 界面' : '关闭后切回 SillyTavern 原生界面');
    $('#quicker_api_preset_link').prop('checked', presetLinkEnabled());
}

// Native UI hands the connection to the host's own controls. Switching back
// takes it over again exactly like a page load does.
async function setNativeUi(nativeUi) {
    if (extensionDisabled || teardownPending || pendingOperations || presetTransitionBlocked) return;
    if (settings().nativeUi === nativeUi) return;
    closeModelPicker();
    closeQuickUrlMenu();
    settings().nativeUi = nativeUi;
    scheduleSettingsSave();
    updatePanelVisibility();
    if (nativeUi) return;
    await enqueueOperation(async () => {
        if (!await readAuthoritativeSecretState()) toastr.warning('Quicker Api 暂时无法读取权威密钥状态；切换将保持阻断。');
        await restoreInitialProfileSelection();
    });
}

async function restoreInitialProfileSelection() {
    const currentPreset = currentPresetName();
    const boundId = currentPreset && presetLinkEnabled() ? settings().presetBindings[currentPreset] : '';
    let target = profiles().find(profile => profile.id === boundId) || null;
    if (!target) target = profiles().find(profile => profile.id === settings().selectedProfileId) || null;
    if (!target) target = profiles().find(profile => profile.id === settings().activeProfileId) || null;
    if (!target) target = profiles().find(profile => !profile.draft && profileMatchesNative(profile)) || null;
    if (!target && profiles().length === 1) target = profiles()[0];
    // A key picked in the host's key manager for this live connection is kept.
    adoptNativeActiveSecret(target);
    settings().selectedProfileId = target?.id || null;
    settings().activeProfileId = null;
    scheduleSettingsSave();
    renderProfiles(target?.id || null);
    if (!target || target.draft) return;
    const generation = ++profileSelectionGeneration;
    beginPresetTransition();
    try {
        const isBound = target.id === boundId;
        // The host already restored the last model the user ran with. When its
        // live connection is this Profile, that model wins over any default or
        // preset snapshot; those only seed a connection that must be switched.
        const keepLiveModel = profileMatchesNative(target, { includeModel: false }) && Boolean(nativeModelFor(target.format));
        const applied = await applyProfile(target, generation, true, !isBound && !keepLiveModel);
        if (applied && isBound && !keepLiveModel) restoreBoundPresetModel(currentPreset, target);
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
    openModelPickerHost = null;
    $('.quicker-api__model-portal').remove();
    nativeProviderEditors().removeClass('quicker-api__native-provider');
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
    eventSource.removeListener(event_types.SECRET_ROTATED, handleNativeSecretChange);
    eventSource.removeListener(event_types.SECRET_WRITTEN, handleNativeSecretChange);
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
        if (!settings().nativeUi) await restoreInitialProfileSelection();
        else renderStatus();
    });
    console.log('[QuickerApi] Extension loaded');
});

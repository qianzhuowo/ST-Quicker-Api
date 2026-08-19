import { extension_settings } from '../../../extensions.js';
import { chat_completion_sources, oai_settings, proxies } from '../../../openai.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { yaml } from '../../../../lib.js';

const MODULE_NAME = 'quickerApi';
const LEGACY_MODULE_NAME = 'customOpenAIProfiles';
const SCHEMA_VERSION = 12;
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
]);
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
const DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    profiles: [],
    selectedProfileId: null,
    activeProfileId: null,
    emptySecretIds: {},
    presetBindings: {},
    migratedFromCustomOpenAIProfiles: false,
    blockedSecretKeys: {},
    quickActions: [],
    quickActionPlacement: 'leftSendForm',
    quickUrls: [],
};

let operationQueue = Promise.resolve();
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
    const availableModels = format === 'openai' ? normalizeModelList(raw?.availableModels) : [];
    if (model && !availableModels.includes(model)) availableModels.unshift(model);
    return {
        id: normalizeText(raw?.id) || makeId(),
        name: sanitizeName(raw?.name) || 'API Profile',
        format,
        endpoint: String(raw?.endpoint || '').slice(0, 2048),
        model,
        availableModels,
        fetchedModels: format === 'openai' ? normalizeModelList(raw?.fetchedModels) : [],
        customized: format === 'openai'
            ? (Object.hasOwn(raw || {}, 'customized') ? Boolean(raw?.customized) : Boolean(raw?.fetchedModels?.length))
            : false,
        fetchedFromEndpoint: format === 'openai'
            ? String(raw?.fetchedFromEndpoint || (raw?.fetchedModels?.length ? raw?.endpoint : '') || '').slice(0, 2048)
            : '',
        includeBody: format === 'openai' ? String(raw?.includeBody || '').slice(0, 100000) : '',
        excludeBody: String(raw?.excludeBody || '').slice(0, 100000),
        includeHeaders: format === 'openai' ? String(raw?.includeHeaders || '').slice(0, 100000) : '',
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
    value.presetBindings = value.presetBindings && typeof value.presetBindings === 'object' ? value.presetBindings : {};
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
    if (storedVersion !== SCHEMA_VERSION) changed = true;
    if (changed) saveSettingsDebounced();
    return true;
}

function toolbarHtml() {
    const formatOptions = Object.entries(FORMATS).map(([value, config]) => `<option value="${value}">${config.label}</option>`).join('');
    return `
        <section id="quicker_api" class="quicker-api">
            <div class="quicker-api__title">
                <span><i class="fa-solid fa-bolt"></i> Quicker Api</span>
                <span title="配置保存在 SillyTavern 用户设置中"><i class="fa-solid fa-database"></i></span>
            </div>
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
            <div class="quicker-api__field quicker-api__key-field">
                <label for="quicker_api_key_input">Key / Password</label>
                <div class="quicker-api__row quicker-api__key-row">
                    <input id="quicker_api_key_input" class="text_pole flex1 quicker-api__secret-masked" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="无凭据" />
                    <div class="quicker-api__key-actions">
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
        </section>`;
}

function setStatus(message = '', state = '') {
    $('#quicker_api_status').text(message).attr('data-state', state);
}

function clearKeyEditor(placeholder = '未配置密钥') {
    $('#quicker_api_key_input').val('').addClass('quicker-api__secret-masked').attr('placeholder', placeholder);
    $('#quicker_api_reveal_key i').attr('class', 'fa-solid fa-eye-slash');
}

function profileHasCredential(profile, format, endpoint) {
    if (!profile) return false;
    if (format !== 'openai' && endpoint) return Boolean(getBoundProxyPreset(profile)?.password);
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
    const proxyMode = format !== 'openai' && Boolean(endpoint);
    const hasCredential = profileHasCredential(profile, format, endpoint);
    const placeholder = proxyMode
        ? (hasCredential ? '已配置代理密码（点击眼睛查看）' : '未配置代理密码')
        : (hasCredential ? '已配置密钥（点击眼睛查看）' : '未配置密钥');
    clearKeyEditor(placeholder);
    $('#quicker_api_native_key_manager').attr('data-key', config.secretKey).data('key', config.secretKey).toggle(!proxyMode);
}

function getEditorModel(format = normalizeFormat($('#quicker_api_format').val())) {
    if (format === 'openai') return normalizeText($('#quicker_api_custom_model').val());
    return normalizeText($('#quicker_api_provider_model').val());
}

function syncEditorModelToNative() {
    const format = normalizeFormat($('#quicker_api_format').val());
    const config = FORMATS[format];
    const model = getEditorModel(format);
    oai_settings[config.modelField] = model;
    $(config.modelInput).val(model).trigger(format === 'openai' ? 'input' : 'change');
}

function syncEditorConnectionToNative() {
    const format = normalizeFormat($('#quicker_api_format').val());
    const config = FORMATS[format];
    const endpoint = normalizeText($('#quicker_api_url').val());
    oai_settings[config.endpointField] = endpoint;
    $(config.endpointInput).val(endpoint).trigger('input');
    syncEditorModelToNative();
}

function nativeAdditionalParameters() {
    return {
        includeBody: String(oai_settings.custom_include_body || ''),
        excludeBody: String(oai_settings.custom_exclude_body || ''),
        includeHeaders: String(oai_settings.custom_include_headers || ''),
    };
}

function applyNativeAdditionalParameters(profile) {
    const values = {
        '#custom_include_body': String(profile?.includeBody || ''),
        '#custom_exclude_body': String(profile?.excludeBody || ''),
        '#custom_include_headers': String(profile?.includeHeaders || ''),
    };
    oai_settings.custom_include_body = values['#custom_include_body'];
    oai_settings.custom_exclude_body = values['#custom_exclude_body'];
    oai_settings.custom_include_headers = values['#custom_include_headers'];
    for (const [selector, value] of Object.entries(values)) {
        const input = $(selector);
        if (input.length) input.val(value).trigger('input');
    }
}

function renderModelControl(profile = selectedProfile(), modelOverride = null) {
    const format = normalizeFormat($('#quicker_api_format').val());
    const root = $('#quicker_api_model_control').empty();
    if (format !== 'openai') {
        const nativeSelect = $(FORMATS[format].modelInput);
        const draftSelect = $('<select id="quicker_api_provider_model" class="text_pole flex1" aria-label="Provider 模型">');
        nativeSelect.find('option').each((_, option) => draftSelect.append($(option).clone()));
        draftSelect.val(modelOverride ?? profile?.model ?? String(oai_settings[FORMATS[format].modelField] || ''));
        root.append(
            draftSelect,
            $('<button class="menu_button quicker-api__manage-actions" type="button" title="便捷按钮管理"><i class="fa-solid fa-bolt"></i><span class="quicker-api__desktop-label">便捷按钮管理</span><span class="quicker-api__mobile-label">便捷按钮</span></button>'),
        );
        return;
    }
    const current = normalizeText(modelOverride ?? profile?.model ?? oai_settings.custom_model);
    const models = normalizeModelList([...(profile?.availableModels || []), current]);
    const select = $('<select id="quicker_api_custom_model" class="text_pole flex1" aria-label="Custom 模型">')
        .append($('<option>').val('').text('— 选择模型 —'));
    for (const model of models) select.append($('<option>').val(model).text(model));
    select.val(current);
    root.append(
        select,
        $('<button id="quicker_api_add_model" class="menu_button" type="button" title="添加并使用自定义模型" aria-label="添加并使用自定义模型"><i class="fa-solid fa-plus"></i><span class="quicker-api__desktop-label">添加</span></button>'),
        $('<button id="quicker_api_fetch_models" class="menu_button" type="button" title="通过 SillyTavern status 后端获取模型"><i class="fa-solid fa-arrows-rotate"></i><span class="quicker-api__desktop-label">获取模型</span><span class="quicker-api__mobile-label">获取</span></button>'),
        $('<button id="quicker_api_manage_models" class="menu_button" type="button" title="管理自定义与远端模型列表"><i class="fa-solid fa-list-check"></i><span class="quicker-api__desktop-label">管理模型列表</span><span class="quicker-api__mobile-label">管理模型</span></button>'),
        $('<button class="menu_button quicker-api__manage-actions" type="button" title="便捷按钮管理"><i class="fa-solid fa-bolt"></i><span class="quicker-api__desktop-label">便捷按钮管理</span><span class="quicker-api__mobile-label">便捷按钮</span></button>'),
    );
}

function renderProfileEditor(profile = selectedProfile()) {
    const format = profile?.format || normalizeFormat($('#quicker_api_format').val());
    $('#quicker_api_format').val(format);
    $('#quicker_api_url').val(profile?.endpoint ?? String(oai_settings[FORMATS[format].endpointField] || ''));
    renderModelControl(profile);
    editorModelBaseline = getEditorModel(format);
}

function renderProfiles(preferredId = null) {
    const select = $('#quicker_api_profile_select').empty().append($('<option>').val('').text('— 选择 API Profile —'));
    for (const profile of [...profiles()].sort((a, b) => a.name.localeCompare(b.name))) {
        select.append($('<option>').val(profile.id).text(`[${FORMATS[profile.format].label}] ${profile.name}`));
    }
    const selectedId = preferredId ?? settings().selectedProfileId ?? '';
    select.val(profiles().some(profile => profile.id === selectedId) ? selectedId : '');
    const profile = selectedProfile();
    if (profile) $('#quicker_api_format').val(profile.format);
    renderProfileEditor(profile);
    updateCredentialEditor(profile);
    renderStatus();
}

function profileMatchesNative(profile) {
    const config = FORMATS[profile.format];
    if (oai_settings.chat_completion_source !== config.source) return false;
    if (String(oai_settings[config.modelField] || '') !== profile.model) return false;
    if (String(oai_settings[config.endpointField] || '') !== profile.endpoint) return false;
    if (profile.format !== 'openai' && profile.endpoint) {
        const proxyPreset = getBoundProxyPreset(profile);
        if (!proxyPreset || String(oai_settings.proxy_password || '') !== String(proxyPreset.password || '')) return false;
    }
    const additional = nativeAdditionalParameters();
    if (additional.excludeBody !== profile.excludeBody) return false;
    return profile.format !== 'openai'
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
        || getEditorModel() !== editorModelBaseline
        || additional.excludeBody !== profile.excludeBody
        || (profile.format === 'openai' && (additional.includeBody !== profile.includeBody
            || additional.includeHeaders !== profile.includeHeaders))
        || Boolean(normalizeText($('#quicker_api_key_input').val()));
}

function renderStatus(extraMessage = '') {
    const profile = selectedProfile();
    const presetName = currentPresetName();
    if (profile) {
        const proxyMode = profile.format !== 'openai' && Boolean(profile.endpoint);
        const blockedMessage = proxyMode ? '' : getBlockedSecretMessage(FORMATS[profile.format].secretKey);
        if (blockedMessage) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
        if (settings().activeProfileId !== profile.id) return setStatus(extraMessage || '所选 Profile 未应用。', 'warning');
        if (editorHasUnsavedChanges(profile)) return setStatus('当前修改尚未保存。', 'warning');
        if (presetName && settings().presetBindings[presetName] !== profile.id) return setStatus('当前 preset 未绑定到所选 Profile。', 'warning');
        if (!profileHasCredential(profile, profile.format, profile.endpoint)) return setStatus('当前 Profile 凭据为空。', 'warning');
        return setStatus('已保存并安全应用。');
    }
    if (Object.keys(settings().blockedSecretKeys).length) return setStatus('安全阻断：凭据状态无法确认。', 'warning');
    if (presetName && !settings().presetBindings[presetName]) return setStatus('当前 preset 未绑定。', 'warning');
    setStatus(extraMessage || '所选 Profile 未应用。', 'warning');
}

function setOperationControlsDisabled(disabled) {
    $('#quicker_api select, #quicker_api button').prop('disabled', disabled);
}

function setCredentialSafetyBlock(secretKey, message) {
    settings().blockedSecretKeys[secretKey] = message || `${secretKey} 密钥状态无法确认；使用该官方来源时生成请求将被阻断。`;
    settings().activeProfileId = null;
    saveSettingsDebounced();
    renderProfiles(settings().selectedProfileId);
}

function clearCredentialSafetyBlock(secretKey) {
    if (!settings().blockedSecretKeys[secretKey]) return;
    delete settings().blockedSecretKeys[secretKey];
    saveSettingsDebounced();
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
    if (!profile || generateData.chat_completion_source !== FORMATS[profile.format].source) return false;
    if (String(generateData.model || '') !== profile.model) return false;
    const endpointField = profile.format === 'openai' ? 'custom_url' : 'reverse_proxy';
    return normalizeText(generateData[endpointField]) === normalizeText(profile.endpoint);
}

function excludeProfileBodyParameters(profile, generateData) {
    if (!profile?.excludeBody || !requestMatchesProfile(profile, generateData)) return;
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
    const usesProxyCredential = format.source !== chat_completion_sources.CUSTOM && Boolean(generateData.reverse_proxy);
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
    operationQueue = operationQueue.then(run, run);
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
        saveSettingsDebounced();
        return id;
    }
    return '';
}

function snapshotNative() {
    return {
        source: oai_settings.chat_completion_source,
        custom_url: String(oai_settings.custom_url || ''),
        custom_model: String(oai_settings.custom_model || ''),
        custom_include_body: String(oai_settings.custom_include_body || ''),
        custom_exclude_body: String(oai_settings.custom_exclude_body || ''),
        custom_include_headers: String(oai_settings.custom_include_headers || ''),
        reverse_proxy: String(oai_settings.reverse_proxy || ''),
        claude_model: String(oai_settings.claude_model || ''),
        google_model: String(oai_settings.google_model || ''),
        proxy_password: String(oai_settings.proxy_password || ''),
    };
}

function restoreNative(snapshot) {
    oai_settings.custom_url = snapshot.custom_url;
    oai_settings.custom_model = snapshot.custom_model;
    oai_settings.custom_include_body = snapshot.custom_include_body;
    oai_settings.custom_exclude_body = snapshot.custom_exclude_body;
    oai_settings.custom_include_headers = snapshot.custom_include_headers;
    oai_settings.reverse_proxy = snapshot.reverse_proxy;
    oai_settings.claude_model = snapshot.claude_model;
    oai_settings.google_model = snapshot.google_model;
    oai_settings.proxy_password = snapshot.proxy_password;
    $('#custom_api_url_text').val(snapshot.custom_url).trigger('input');
    $('#custom_model_id').val(snapshot.custom_model).trigger('input');
    applyNativeAdditionalParameters({
        includeBody: snapshot.custom_include_body,
        excludeBody: snapshot.custom_exclude_body,
        includeHeaders: snapshot.custom_include_headers,
    });
    $('#openai_reverse_proxy').val(snapshot.reverse_proxy).trigger('input');
    $('#openai_proxy_password').val(snapshot.proxy_password).trigger('input');
    $('#model_claude_select').val(snapshot.claude_model).trigger('change');
    $('#model_google_select').val(snapshot.google_model).trigger('change');
    $('#chat_completion_source').val(snapshot.source).trigger('change');
}

async function enterFailClosedState(message, affectedSecretKey = SECRET_KEYS.CUSTOM) {
    const safeId = await ensureEmptySecret(affectedSecretKey);
    if (affectedSecretKey === SECRET_KEYS.CUSTOM) {
        oai_settings.custom_url = '';
        oai_settings.custom_model = '';
        $('#custom_api_url_text').val('').trigger('input');
        $('#custom_model_id').val('').trigger('input');
        $('#chat_completion_source').val(chat_completion_sources.CUSTOM).trigger('change');
    }
    settings().activeProfileId = null;
    if (safeId) {
        delete settings().blockedSecretKeys[affectedSecretKey];
    } else {
        settings().blockedSecretKeys[affectedSecretKey] = `${message} ${affectedSecretKey} 密钥槽状态无法确认，生成已阻断。`;
    }
    saveSettingsDebounced();
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
    oai_settings[config.endpointField] = profile.endpoint;
    $(config.endpointInput).val(profile.endpoint).trigger('input');
    if (applyModel) {
        oai_settings[config.modelField] = profile.model;
        $(config.modelInput).val(profile.model).trigger(profile.format === 'openai' ? 'input' : 'change');
    }
    applyNativeAdditionalParameters(profile);
    if (profile.format !== 'openai') {
        oai_settings.proxy_password = proxyPassword;
        $('#openai_proxy_password').val(proxyPassword).trigger('input');
    }
    if (oai_settings.chat_completion_source !== config.source) {
        $('#chat_completion_source').val(config.source).trigger('change');
    }
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
    const config = FORMATS[profile.format];
    const previousSelection = settings().activeProfileId;
    const nativeSnapshot = snapshotNative();
    const proxyMode = profile.format !== 'openai' && Boolean(profile.endpoint);
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
            saveSettingsDebounced();
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
            saveSettingsDebounced();
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
        saveSettingsDebounced();
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

function captureNativeProfile(name, format, existing = {}) {
    const normalizedFormat = normalizeFormat(format);
    const config = FORMATS[normalizedFormat];
    const endpoint = String(oai_settings[config.endpointField] || '');
    const proxyMode = normalizedFormat !== 'openai' && Boolean(endpoint);
    const activeSecret = getActiveSecret(config.secretKey);
    const retainedSecretId = existing.format === normalizedFormat ? String(existing.secretId || '') : '';
    const secretId = proxyMode ? '' : (retainedSecretId || activeSecret?.id || '');
    const needsSecret = !proxyMode && (!secretId || secretId === settings().emptySecretIds[config.secretKey]);
    const profileName = name || existing.name;
    const profileId = existing.id || makeId();
    const proxyPreset = proxyMode
        ? ensureBoundProxyPreset(profileName, endpoint, String(oai_settings.proxy_password || ''), existing.proxyPreset, profileId)
        : '';
    return normalizeProfile({
        ...existing,
        id: profileId,
        name: uniqueName(profileName, existing.id),
        format: normalizedFormat,
        endpoint,
        model: getEditorModel(normalizedFormat),
        includeBody: normalizedFormat === 'openai' ? String(oai_settings.custom_include_body || '') : '',
        excludeBody: String(oai_settings.custom_exclude_body || ''),
        includeHeaders: normalizedFormat === 'openai' ? String(oai_settings.custom_include_headers || '') : '',
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
    saveSettingsDebounced();
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
                saveSettingsDebounced();
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
    saveSettingsDebounced();
    const select = $('#quicker_api_profile_select');
    select.find('option[value=""]').text('— 新建 API 配置（未保存） —');
    select.val('');
    renderProfileEditor(null);
    updateCredentialEditor(null);
    setStatus('正在新建 API 配置；填写后请点击“保存 API 配置”。', 'warning');
    toastr.info('已进入新建模式；填写连接信息后点击“保存 API 配置”即可创建 Profile。');
    $('#quicker_api_url').trigger('focus');
}

function importIdentity(format, endpoint, credentialIdentity) {
    return `${format}|${normalizeText(endpoint).toLocaleLowerCase()}|${credentialIdentity}`;
}

function nativeImportFingerprint(candidate, format, endpoint) {
    const sourceRef = normalizeText(candidate.sourceRef || candidate.sourceLabel).toLocaleLowerCase();
    const credentialRef = candidate.sourceSecretKey && candidate.sourceSecretId
        ? `secret:${candidate.sourceSecretKey}:${candidate.sourceSecretId}`
        : (candidate.proxyPreset ? `proxy:${normalizeText(candidate.proxyPreset).toLocaleLowerCase()}` : 'no-source-credential');
    return `${sourceRef}|${format}|${normalizeText(endpoint).toLocaleLowerCase()}|${credentialRef}`.slice(0, 5000);
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
            includeBody: format === 'openai' ? String(candidate.includeBody || '') : '',
            excludeBody: format === 'openai' ? String(candidate.excludeBody || '') : '',
            includeHeaders: format === 'openai' ? String(candidate.includeHeaders || '') : '',
            sourceSecretId: String(candidate.sourceSecretId || ''),
            credential,
            identity: importIdentity(format, endpoint, credential.identity),
            fingerprint: nativeImportFingerprint(candidate, format, endpoint),
        };
        if (!candidates.some(item => item.identity === normalized.identity)) candidates.push(normalized);
    };

    const activeCustom = authoritative[SECRET_KEYS.CUSTOM]?.find(entry => entry.active) || null;
    const currentCustomUrl = normalizeText(oai_settings.custom_url);
    if (currentCustomUrl || oai_settings.custom_model || activeCustom) {
        await add({
            sourceRef: 'current-custom', sourceLabel: '当前自定义（兼容 OpenAI）',
            name: '当前 Custom 配置', format: 'openai', endpoint: currentCustomUrl,
            model: oai_settings.custom_model, sourceSecretKey: SECRET_KEYS.CUSTOM,
            sourceSecretId: activeCustom?.id,
            includeBody: oai_settings.custom_include_body,
            excludeBody: oai_settings.custom_exclude_body,
            includeHeaders: oai_settings.custom_include_headers,
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
        const format = sourceFormats[nativeProfile?.api];
        if (!format) continue;
        const config = FORMATS[format];
        const proxy = nativeProfile.proxy ? proxies.find(item => item.name === nativeProfile.proxy) : null;
        const endpoint = format === 'openai'
            ? normalizeText(proxy?.url || nativeProfile['api-url'] || 'https://api.openai.com/v1')
            : normalizeText(proxy?.url || nativeProfile['api-url']);
        const proxyMode = format !== 'openai' && Boolean(endpoint);
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
        const proxyMode = profile.format !== 'openai' && Boolean(profile.endpoint);
        const proxy = proxyMode ? getBoundProxyPreset(profile) : null;
        const credential = await credentialDescriptor(
            proxyMode ? '' : FORMATS[profile.format].secretKey,
            proxyMode ? '' : profile.secretId,
            proxyMode ? proxy?.password : '',
        );
        existing.add(importIdentity(profile.format, profile.endpoint, credential.identity));
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
    if (candidate.proxyPreset && candidate.format !== 'openai') {
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
                availableModels: candidate.format === 'openai' ? [candidate.model] : [],
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
    saveSettingsDebounced();
    renderProfiles(settings().selectedProfileId);
    if (imported) toastr.success(`已迁移 ${imported} 个原生连接配置。`);
    if (pending) toastr.warning(`${pending} 个配置需要重新配置凭据。`);
}

async function saveSelectedProfile() {
    let current = selectedProfile();
    const isNew = !current;
    const previousEndpoint = normalizeText(current?.endpoint);
    const format = normalizeFormat($('#quicker_api_format').val());
    const editorEndpoint = normalizeText($('#quicker_api_url').val());
    if (format === 'openai' && !editorEndpoint) {
        toastr.warning('OpenAI Compatible URL 不能为空。');
        return;
    }
    if (!current) {
        const name = await promptName('输入新 API 配置名称：', `${FORMATS[format].label} ${profiles().length + 1}`);
        if (!name) return;
        current = normalizeProfile({ id: makeId(), name: uniqueName(name), format });
    }
    const config = FORMATS[format];
    const proxyMode = format !== 'openai' && Boolean(editorEndpoint);
    if (!proxyMode && !await readAuthoritativeSecretState()) {
        toastr.error('无法读取权威密钥状态，已取消保存 API 配置。');
        return;
    }
    const keyValue = normalizeText($('#quicker_api_key_input').val());
    let captureBase = current;
    if (keyValue) {
        const credentialDraft = normalizeProfile({ ...structuredClone(current), format });
        if (!await saveAndBindInputKey(credentialDraft, format, editorEndpoint)) return;
        captureBase = credentialDraft;
    }
    syncEditorConnectionToNative();
    Object.assign(current, captureNativeProfile(current.name, format, captureBase));
    if (format === 'openai') {
        current.availableModels = normalizeModelList([...(current.availableModels || []), current.model]);
        if (!isNew && previousEndpoint !== normalizeText(current.endpoint)) {
            current.fetchedModels = [];
            current.fetchedFromEndpoint = '';
        } else {
            current.fetchedModels = normalizeModelList(current.fetchedModels);
        }
    }
    if (isNew) profiles().push(current);
    settings().selectedProfileId = current.id;
    settings().activeProfileId = current.id;
    const presetName = currentPresetName();
    if (presetName) settings().presetBindings[presetName] = current.id;
    saveSettingsDebounced();
    renderProfiles(current.id);
    toastr.success('API 配置已保存。');
}

async function renameSelectedProfile() {
    const profile = selectedProfile();
    if (!profile) return;
    const name = await promptName('输入新的配置名称：', profile.name);
    if (!name) return;
    profile.name = uniqueName(name, profile.id);
    profile.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
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
    saveSettingsDebounced();
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
        if (id === profile.id) delete settings().presetBindings[name];
    }
    if (settings().activeProfileId === profile.id) settings().activeProfileId = null;
    if (settings().selectedProfileId === profile.id) settings().selectedProfileId = null;
    saveSettingsDebounced();
    renderProfiles();
}


async function findMatchingSecret(key, value) {
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
    if (format !== 'openai' && endpoint) {
        if (!value) return true;
        profile.proxyPreset = ensureBoundProxyPreset(profile.name, endpoint, value, profile.proxyPreset, profile.id);
        profile.secretId = '';
        profile.needsSecret = false;
        oai_settings.proxy_password = value;
        $('#openai_proxy_password').val(value).trigger('input');
        profile.updatedAt = new Date().toISOString();
        saveSettingsDebounced();
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
    saveSettingsDebounced();
    if (!result.exposureAvailable) toastr.warning('凭据已保存；findSecret 无权限，无法检查历史密钥是否同值。');
    return true;
}

async function readBoundSecret(profile) {
    if (profile?.format !== 'openai' && profile?.endpoint) {
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
        toastr.warning('当前实例未授予 findSecret 明文权限（allowKeysExposure）；已降级为仅显示标签和管理入口。');
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

async function addCustomModel() {
    const profile = selectedProfile();
    if (!profile || profile.format !== 'openai') return toastr.info('请先选择并保存 OpenAI Compatible 配置。');
    const model = await promptName('输入 Custom 模型 ID：', getEditorModel('openai'));
    if (!model) return;
    profile.availableModels = normalizeModelList([...(profile.availableModels || []), model]);
    profile.customized = true;
    profile.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    renderModelControl(profile);
    $('#quicker_api_custom_model').val(model);
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
    try {
        const parsed = JSON.parse(value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
        return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => key && typeof item === 'string'));
    } catch {
        return {};
    }
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

async function findSecretBounded(key, id) {
    if (extensionDisabled || teardownPending) return null;
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
    let frontendError = null;
    try {
        const key = profile.secretId ? await findSecretBounded(SECRET_KEYS.CUSTOM, profile.secretId) : '';
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
    try {
        const authoritative = await readAuthoritativeSecretState();
        if (!authoritative) throw new Error('无法读取 Custom 密钥权威状态');
        const customEntries = Array.isArray(authoritative[SECRET_KEYS.CUSTOM]) ? authoritative[SECRET_KEYS.CUSTOM] : [];
        previousActiveId = customEntries.find(entry => entry.active)?.id || '';
        const boundSecretExists = Boolean(profile.secretId && customEntries.some(entry => entry.id === profile.secretId));
        if (profile.secretId && !boundSecretExists) {
            profile.secretId = '';
            profile.needsSecret = true;
            saveSettingsDebounced();
            updateCredentialEditor(profile);
        }
        desiredSecretId = boundSecretExists ? profile.secretId : await ensureEmptySecret(SECRET_KEYS.CUSTOM);
        if (!desiredSecretId) throw new Error('无法建立 Profile 对应的安全 Custom 密钥');
        if (previousActiveId !== desiredSecretId && !await rotateSecretVerified(SECRET_KEYS.CUSTOM, desiredSecretId)) {
            throw new Error('无法激活 Profile 绑定的 Custom 密钥');
        }

        const { response, data } = await fetchJsonWithTimeout('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: chat_completion_sources.CUSTOM,
                reverse_proxy: '',
                proxy_password: '',
                custom_url: endpoint,
                custom_include_headers: profile.includeHeaders,
            }),
            cache: 'no-cache',
        }, 20000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const models = modelIdsFromPayload(data);
        if (!models.length) throw new Error('后端 status 响应未包含模型列表');
        return { models, route: '后端 status fallback', frontendError };
    } catch (backendError) {
        const error = new Error(`前端 /models：${frontendError?.message || '失败'}；后端 status：${backendError.message}`);
        error.cause = backendError;
        throw error;
    } finally {
        if (previousActiveId && desiredSecretId && previousActiveId !== desiredSecretId) {
            const restored = await rotateSecretVerified(SECRET_KEYS.CUSTOM, previousActiveId);
            if (!restored) await enterFailClosedState('模型获取后无法恢复原 Custom 活动密钥。', SECRET_KEYS.CUSTOM);
        }
    }
}

async function fetchCustomModels() {
    const profile = selectedProfile();
    if (!profile || profile.format !== 'openai') return toastr.info('请先选择并保存 OpenAI Compatible 配置。');
    if (normalizeText($('#quicker_api_key_input').val())) return toastr.info('请先点击保存按钮保存当前 Key，再获取模型。');
    const editorUrl = normalizeText($('#quicker_api_url').val());
    if (!editorUrl) return toastr.warning('请先填写 Custom URL。');
    if (editorUrl !== normalizeText(profile.endpoint)) return toastr.info('URL 已变化，请先保存配置；保存会清空旧远端快照并保留已选模型。');
    try {
        const result = await fetchModelsForProfile(profile, editorUrl);
        profile.fetchedModels = result.models;
        profile.fetchedFromEndpoint = editorUrl;
        if (!profile.customized) profile.availableModels = normalizeModelList([profile.model, ...result.models]);
        profile.updatedAt = new Date().toISOString();
        saveSettingsDebounced();
        renderModelControl(profile);
        $('#quicker_api_custom_model').val(profile.model);
        toastr.success(`通过${result.route}获取 ${result.models.length} 个模型。`);
        renderStatus();
    } catch (error) {
        console.error('[QuickerApi] Model fetch failed:', error);
        toastr.error('前端 /models 与后端 status 均获取失败。');
        renderStatus();
    }
}

async function manageCustomModels() {
    const profile = selectedProfile();
    if (!profile || profile.format !== 'openai') return toastr.info('请先选择并保存 OpenAI Compatible 配置。');
    if (normalizeText($('#quicker_api_key_input').val())) return toastr.info('Key 尚未保存，请先点击保存按钮再管理或获取模型。');
    const endpoint = normalizeText($('#quicker_api_url').val());
    if (endpoint !== normalizeText(profile.endpoint)) return toastr.info('URL 已变化，请先保存配置再管理模型。');

    const draft = {
        current: normalizeText(getEditorModel('openai') || profile.model),
        available: normalizeModelList(profile.availableModels),
        fetched: profile.fetchedFromEndpoint === endpoint ? normalizeModelList(profile.fetchedModels) : [],
        fetchedFromEndpoint: profile.fetchedFromEndpoint === endpoint ? endpoint : '',
        customized: Boolean(profile.customized),
    };
    if (draft.current && !draft.available.includes(draft.current)) draft.available.unshift(draft.current);
    const initialDraft = structuredClone(draft);

    const content = $('<div class="quicker-api__model-manager">');
    content.append($('<div class="quicker-api__manager-note">').text('所有修改仅在确认后保存，取消会完整回滚。'));
    const columns = $('<div class="quicker-api__manager-columns">');
    const remotePanel = $('<section class="quicker-api__manager-panel">');
    const chosenPanel = $('<section class="quicker-api__manager-panel">');
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
        $('<button type="button" class="menu_button" data-action="clear">清空</button>'),
        $('<button type="button" class="menu_button" data-action="reset">重置</button>'),
    );
    const remoteList = $('<div class="quicker-api__model-list">');
    const chosenList = $('<div class="quicker-api__model-list">');
    remotePanel.append($('<h4><i class="fa-solid fa-cloud-arrow-down"></i> 远端模型</h4>'), remoteActions, remoteList);
    chosenPanel.append($('<h4><i class="fa-solid fa-list-check"></i> 下拉留存 / 自定义</h4>'), chosenActions, chosenList);
    columns.append(remotePanel, chosenPanel);
    content.append(columns);

    const ensureCurrent = () => {
        draft.available = normalizeModelList(draft.available);
        if (draft.current && !draft.available.includes(draft.current)) draft.available.unshift(draft.current);
    };
    const markCustomized = () => {
        draft.customized = true;
        ensureCurrent();
    };
    const renderManager = () => {
        ensureCurrent();
        const selected = new Set(draft.available);
        const remote = new Set(draft.fetched);
        remoteList.empty();
        if (!draft.fetched.length) remoteList.append($('<div class="quicker-api__empty-state">').text('尚无当前 URL 的远端快照'));
        for (const model of draft.fetched) {
            const checkbox = $('<input type="checkbox">').prop('checked', selected.has(model)).attr('aria-label', `选择 ${model}`);
            const row = $('<div class="quicker-api__model-item quicker-api__remote-model" role="checkbox" tabindex="0">')
                .attr('aria-checked', selected.has(model)).append(checkbox, $('<span>').text(model), $('<small>').text('远端'));
            const toggle = checked => {
                if (checked) draft.available = normalizeModelList([...draft.available, model]);
                else if (model !== draft.current) draft.available = draft.available.filter(item => item !== model);
                markCustomized();
                renderManager();
            };
            checkbox.on('click', event => event.stopPropagation()).on('change', () => toggle(checkbox.prop('checked')));
            row.on('click', () => toggle(!selected.has(model))).on('keydown', event => {
                if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    toggle(!selected.has(model));
                }
            });
            remoteList.append(row);
        }

        chosenList.empty();
        if (!draft.available.length) chosenList.append($('<div class="quicker-api__empty-state">').text('留存列表为空'));
        draft.available.forEach((model, index) => {
            const input = $('<input class="text_pole" type="text" readonly>').val(model).attr('aria-label', `模型 ${model}`);
            const edit = $('<button type="button" class="menu_button" title="编辑" aria-label="编辑"><i class="fa-solid fa-pen"></i></button>');
            const remove = $('<button type="button" class="menu_button" title="删除" aria-label="删除"><i class="fa-solid fa-trash"></i></button>');
            const up = $('<button type="button" class="menu_button" title="上移" aria-label="上移"><i class="fa-solid fa-arrow-up"></i></button>').prop('disabled', index === 0);
            const down = $('<button type="button" class="menu_button" title="下移" aria-label="下移"><i class="fa-solid fa-arrow-down"></i></button>').prop('disabled', index === draft.available.length - 1);
            const commitEdit = () => {
                const next = normalizeText(input.val());
                if (!next || (next !== model && draft.available.includes(next))) return renderManager();
                draft.available[index] = next;
                if (draft.current === model) draft.current = next;
                markCustomized();
                renderManager();
            };
            edit.on('click', () => input.prop('readonly', false).trigger('focus').trigger('select'));
            input.on('keydown', event => {
                if (event.key === 'Enter') commitEdit();
                if (event.key === 'Escape') renderManager();
            }).on('change', commitEdit);
            remove.on('click', () => {
                const deletingCurrent = draft.current === model;
                draft.available.splice(index, 1);
                if (deletingCurrent) draft.current = draft.available[0] || '';
                markCustomized();
                renderManager();
            });
            up.on('click', () => {
                [draft.available[index - 1], draft.available[index]] = [draft.available[index], draft.available[index - 1]];
                markCustomized();
                renderManager();
            });
            down.on('click', () => {
                [draft.available[index + 1], draft.available[index]] = [draft.available[index], draft.available[index + 1]];
                markCustomized();
                renderManager();
            });
            const source = remote.has(model) ? '远端' : '自定义';
            chosenList.append($('<div class="quicker-api__model-item quicker-api__chosen-model">').append(
                $('<span class="quicker-api__drag-index">').text(index + 1), input, $('<small>').text(source),
                $('<div class="quicker-api__item-actions">').append(edit, remove, up, down),
            ));
        });
    };

    remoteActions.on('click', 'button', async function () {
        const action = String($(this).data('action'));
        if (action === 'fetch') {
            const button = $(this).prop('disabled', true);
            try {
                const result = await fetchModelsForProfile(profile, endpoint);
                draft.fetched = result.models;
                draft.fetchedFromEndpoint = endpoint;
                if (!draft.customized) draft.available = normalizeModelList([draft.current, ...result.models]);
                toastr.success(`通过${result.route}获取 ${result.models.length} 个模型；确认后保存快照。`);
            } catch (error) {
                console.error('[QuickerApi] Model manager fetch failed:', error);
                toastr.error('前端 /models 与后端 status 均获取失败。');
            } finally {
                button.prop('disabled', false);
                renderManager();
            }
            return;
        }
        if (action === 'all') draft.available = normalizeModelList([...draft.available, ...draft.fetched]);
        if (action === 'invert') {
            const remote = new Set(draft.fetched);
            draft.available = normalizeModelList([
                ...draft.available.filter(model => !remote.has(model) || !draft.fetched.includes(model)),
                ...draft.fetched.filter(model => !draft.available.includes(model)),
            ]);
        }
        if (action === 'none') draft.available = draft.available.filter(model => !draft.fetched.includes(model) || model === draft.current);
        markCustomized();
        renderManager();
    });
    const addDraftModel = () => {
        const model = normalizeText(customInput.val());
        if (!model) return;
        draft.available = normalizeModelList([...draft.available, model]);
        customInput.val('');
        markCustomized();
        renderManager();
    };
    chosenActions.on('click', 'button', function () {
        const action = String($(this).data('action'));
        if (action === 'add') addDraftModel();
        if (action === 'clear') {
            draft.available = [];
            draft.current = '';
            markCustomized();
            renderManager();
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
    renderManager();

    if (!await callQuickerPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: '保存',
        cancelButton: '取消',
        animation: 'none',
    })) return;
    ensureCurrent();
    profile.availableModels = draft.available;
    profile.fetchedModels = draft.fetched;
    profile.customized = draft.customized;
    profile.fetchedFromEndpoint = draft.fetchedFromEndpoint;
    profile.updatedAt = new Date().toISOString();
    saveSettingsDebounced();
    renderModelControl(profile);
    $('#quicker_api_custom_model').val(draft.current);
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
    if (profile.format === 'openai') return normalizeModelList([profile.model, ...(profile.availableModels || [])]);
    const native = $(FORMATS[profile.format].modelInput).find('option').map((_, option) => String(option.value || '')).get();
    return normalizeModelList([profile.model, ...native]);
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
    const saveAll = $('<button type="button" class="menu_button quicker-api__save-button"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>');
    const close = $('<button type="button" class="menu_button" title="关闭并丢弃更改" aria-label="关闭并丢弃更改"><i class="fa-solid fa-xmark"></i></button>');
    header.append(title.append(placementButton), $('<div class="quicker-api__quick-header-actions">').append(saveAll, close));
    const add = $('<button class="menu_button" type="button"><i class="fa-solid fa-plus"></i><span>新增方案</span></button>');
    const list = $('<div class="quicker-api__quick-list">');
    const listItems = $('<div class="quicker-api__quick-list-items" role="listbox" aria-label="便捷方案">');
    list.append($('<div class="quicker-api__quick-list-toolbar">').append(add), listItems);
    const editor = $('<div class="quicker-api__quick-editor">');
    content.append(header, $('<div class="quicker-api__quick-columns">').append(list, editor));

    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', { animation: 'none' });
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
        fetchModels.prop('disabled', selectedProfileValue()?.format !== 'openai');
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
            if (!profile || profile.format !== 'openai') return toastr.info('请选择 OpenAI Compatible Profile 后拉取模型。');
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
                if (fetchError) toastr.error('前端 /models 与后端 status 均获取失败。');
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
        saveSettingsDebounced();
        ensureQuickActionEntries();
        toastr.success('便捷入口位置已应用。');
    }));
    close.on('click', () => void popup.completeCancelled());
    saveAll.on('click', () => {
        const invalid = globalDraft.find(action => !action.preset && !action.profileId && !action.model);
        if (invalid) return toastr.warning('请先在右侧保存每个方案；每项至少需要 preset、Profile 或 model。');
        const validProfileIds = new Set(profiles().map(profile => profile.id));
        if (globalDraft.some(action => action.profileId && !validProfileIds.has(action.profileId))) return toastr.warning('方案引用了已不存在的 Profile，请重新选择并保存方案。');
        const validPresetNames = new Set($('#settings_preset_openai option').map((_, option) => normalizeText(option.textContent)).get());
        if (globalDraft.some(action => action.preset && !validPresetNames.has(action.preset))) return toastr.warning('方案引用了已不存在的 preset，请重新选择并保存方案。');
        globalDraft.forEach((action, index) => {
            action.name = sanitizeName(action.name) || `方案${index + 1}`;
            action.sequence = index;
        });
        void popup.completeAffirmative();
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
    settings().quickActions = globalDraft;
    settings().quickActionPlacement = draftPlacement;
    saveSettingsDebounced();
    ensureQuickActionEntries();
}

function findFormatForCurrentSource() {
    return Object.entries(FORMATS).find(([, config]) => config.source === oai_settings.chat_completion_source)?.[0] || '';
}

function applyExplicitModel(model, preferredFormat = '') {
    const value = normalizeText(model);
    if (!value) return true;
    const inferredFormat = preferredFormat || findFormatForCurrentSource();
    if (!Object.hasOwn(FORMATS, inferredFormat)) return false;
    const format = inferredFormat;
    const config = FORMATS[format];
    const input = $(config.modelInput);
    if (!input.length) return false;
    if (format === 'openai') {
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
    saveSettingsDebounced();
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
    const generation = ++profileSelectionGeneration;
    clearTimeout(presetChangeTimer);
    beginPresetTransition();
    const name = normalizeText(presetName || currentPresetName());
    const profile = profiles().find(item => item.id === settings().presetBindings[name]);
    if (profile) {
        settings().selectedProfileId = profile.id;
        saveSettingsDebounced();
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
    beginPresetTransition();
    const generation = ++profileSelectionGeneration;
    const quickActionOwnsBlock = Boolean(quickActionBlockingToken);
    clearTimeout(presetChangeTimer);
    const presetName = currentPresetName();
    const profileId = settings().presetBindings[presetName];
    const profile = profiles().find(item => item.id === profileId);
    try {
        if (!profile) {
            settings().activeProfileId = null;
            saveSettingsDebounced();
            renderProfiles(settings().selectedProfileId);
            setStatus('当前 preset 未绑定。', 'warning');
            return false;
        }
        return await enqueueOperation(async () => {
            if (generation !== profileSelectionGeneration) return false;
            const applied = await applyProfile(profile, generation, true, false);
            if (!applied) setStatus('所选 Profile 未应用。', 'warning');
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
    saveSettingsDebounced();
    renderProfiles(settings().selectedProfileId);
}

function handlePresetDeleted({ apiId, name } = {}) {
    if (extensionDisabled || apiId !== 'openai' || !name || !settings().presetBindings[name]) return;
    delete settings().presetBindings[name];
    saveSettingsDebounced();
    renderProfiles(settings().selectedProfileId);
}

function bindPresetAfterVerifiedSave(name, profileId) {
    const presetName = normalizeText(name);
    if (!presetName || !profiles().some(profile => profile.id === profileId)) return;
    settings().presetBindings[presetName] = profileId;
    editorModelBaseline = getEditorModel();
    saveSettingsDebounced();
    renderStatus();
}

function monitorNativeCreatePopup(intent) {
    let popupSeen = false;
    const startedAt = Date.now();
    const timer = setInterval(() => {
        if (nativePresetSaveIntent !== intent) return clearInterval(timer);
        const popupOpen = Boolean(document.querySelector('dialog.popup[open], .popup[open]'));
        popupSeen ||= popupOpen;
        if ((popupSeen && !popupOpen) || Date.now() - startedAt > 120000) {
            clearInterval(timer);
            setTimeout(() => {
                if (nativePresetSaveIntent === intent) nativePresetSaveIntent = null;
            }, 3000);
        }
    }, 100);
}

function installPresetSaveObserver() {
    if (originalFetch) return;
    const stableFetchDelegate = globalThis.fetch;
    originalFetch = stableFetchDelegate;
    presetObservedFetch = async function quickerApiObservedFetch(resource, options = {}) {
        const url = typeof resource === 'string' ? resource : resource?.url;
        const intent = nativePresetSaveIntent;
        const observesPresetSave = intent && normalizeText(url).includes('/api/presets/save');
        let body = null;
        if (observesPresetSave) {
            nativePresetSaveIntent = null;
            try {
                body = JSON.parse(String(options?.body || 'null'));
            } catch {
                body = null;
            }
        }
        // Keep a stable delegate in this closure. A later extension may wrap our
        // wrapper, so teardown must never invalidate its downstream delegate.
        const response = await stableFetchDelegate.apply(this, arguments);
        if (!observesPresetSave) return response;
        if (!response.ok || body?.apiId !== 'openai') return response;
        try {
            const result = await response.clone().json();
            const savedName = normalizeText(result?.name || body?.name);
            const validUpdate = intent.type === 'update' && savedName === intent.presetName;
            const validCreate = intent.type === 'create' && savedName && !intent.knownPresetNames.has(savedName.toLocaleLowerCase());
            if (validUpdate || validCreate) bindPresetAfterVerifiedSave(savedName, intent.profileId);
        } catch (error) {
            console.warn('[QuickerApi] Could not verify native preset save response:', error);
        }
        return response;
    };
    globalThis.fetch = presetObservedFetch;
}

function bindNativePresetSaveCapture() {
    nativePresetCaptureHandlers.update = () => {
        if (extensionDisabled) return;
        const profile = selectedProfile();
        nativePresetSaveIntent = profile ? {
            type: 'update', profileId: profile.id, presetName: currentPresetName(),
        } : null;
        const intent = nativePresetSaveIntent;
        setTimeout(() => {
            if (nativePresetSaveIntent === intent) nativePresetSaveIntent = null;
        }, 1000);
    };
    nativePresetCaptureHandlers.create = () => {
        if (extensionDisabled) return;
        const profile = selectedProfile();
        nativePresetSaveIntent = profile ? {
            type: 'create',
            profileId: profile.id,
            knownPresetNames: new Set($('#settings_preset_openai option').map((_, option) => normalizeText(option.textContent).toLocaleLowerCase()).get()),
        } : null;
        if (nativePresetSaveIntent) monitorNativeCreatePopup(nativePresetSaveIntent);
    };
    document.getElementById('update_oai_preset')?.addEventListener('click', nativePresetCaptureHandlers.update, true);
    document.getElementById('new_oai_preset')?.addEventListener('click', nativePresetCaptureHandlers.create, true);
}

function bindEvents() {
    installPresetSaveObserver();
    bindNativePresetSaveCapture();
    $('#quicker_api_profile_select').on('change', function () {
        clearKeyEditor();
        const profile = profiles().find(item => item.id === String($(this).val())) || null;
        settings().selectedProfileId = profile?.id || null;
        saveSettingsDebounced();
        if (!profile) return renderStatus();
        $('#quicker_api_format').val(profile.format);
        void applyProfileById(profile.id, quickActionTransaction, { applyModel: true, manageTransition: true });
    });
    $('#quicker_api_format').on('change', function () {
        clearKeyEditor();
        const format = normalizeFormat($(this).val());
        const source = FORMATS[format].source;
        if (oai_settings.chat_completion_source !== source) $('#chat_completion_source').val(source).trigger('change');
        $('#quicker_api_url').val(String(oai_settings[FORMATS[format].endpointField] || ''));
        const profile = selectedProfile()?.format === format ? selectedProfile() : null;
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
        const proxyMode = format !== 'openai' && Boolean(normalizeText($(this).val()));
        $('#quicker_api_native_key_manager').attr('data-key', FORMATS[format].secretKey).data('key', FORMATS[format].secretKey).toggle(!proxyMode);
        renderStatus();
    });
    $('#quicker_api_key_input').on('input', renderStatus);
    $(document).on('input.quickerApi', '#custom_include_body, #custom_exclude_body, #custom_include_headers', renderStatus);
    $(document).on('change.quickerApi', '#quicker_api_custom_model, #quicker_api_provider_model', () => {
        syncEditorModelToNative();
        renderStatus();
    });
    $(document).on('click.quickerApi', '#quicker_api_add_model', addCustomModel);
    $(document).on('click.quickerApi', '#quicker_api_fetch_models', () => void enqueueOperation(fetchCustomModels));
    $(document).on('click.quickerApi', '#quicker_api_manage_models', manageCustomModels);
    $(document).on('click.quickerApi', '.quicker-api__manage-actions', () => void manageQuickActions());
    $('#chat_completion_source').on('change.quickerApi', function () {
        updatePanelVisibility();
        const entry = Object.entries(FORMATS).find(([, config]) => config.source === String($(this).val()));
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
    const excludeInput = document.getElementById('custom_exclude_body');
    if (!excludeInput || excludeInput.dataset.quickerApiConfigured === 'true') return;
    excludeInput.dataset.quickerApiConfigured = 'true';
    const format = normalizeFormat($('#quicker_api_format').val());
    if (format === 'openai') return;
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
    let target = profiles().find(profile => profile.id === settings().selectedProfileId) || null;
    if (!target) target = profiles().find(profile => profile.id === boundId) || null;
    if (!target) target = profiles().find(profile => profile.id === settings().activeProfileId) || null;
    if (!target) target = profiles().find(profile => profileMatchesNative(profile)) || null;
    if (!target && profiles().length === 1) target = profiles()[0];
    settings().selectedProfileId = target?.id || null;
    settings().activeProfileId = null;
    saveSettingsDebounced();
    renderProfiles(target?.id || null);
    if (!target) return;
    const generation = ++profileSelectionGeneration;
    beginPresetTransition();
    try {
        const applied = await applyProfile(target, generation, true);
        if (!applied) renderStatus('所选 Profile 未应用。');
    } finally {
        endPresetTransition();
    }
}

async function teardownQuickerApi() {
    if (teardownPending || extensionDisabled) return false;
    teardownPending = true;
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
    $('#custom_form, #claude_form, #makersuite_form').removeClass('quicker-api__native-provider');
    $(document).off('.quickerApi').off('.quickerApiMenu');
    $(window).off('.quickerApiMenu');
    $(globalThis.visualViewport).off('.quickerApiMenu');
    $('#custom_api_url_text, #custom_model_id, #openai_reverse_proxy, #model_claude_select, #model_google_select, #chat_completion_source').off('.quickerApi');
    eventSource.removeListener(event_types.OAI_PRESET_CHANGED_BEFORE, handleNativePresetChangeBefore);
    eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, handleNativePresetChange);
    eventSource.removeListener(event_types.PRESET_RENAMED, handlePresetRenamed);
    eventSource.removeListener(event_types.PRESET_DELETED, handlePresetDeleted);
    eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, guardGenerationWhenBlocked);
    const updateButton = document.getElementById('update_oai_preset');
    const createButton = document.getElementById('new_oai_preset');
    if (nativePresetCaptureHandlers.update) updateButton?.removeEventListener('click', nativePresetCaptureHandlers.update, true);
    if (nativePresetCaptureHandlers.create) createButton?.removeEventListener('click', nativePresetCaptureHandlers.create, true);
    delete nativePresetCaptureHandlers.update;
    delete nativePresetCaptureHandlers.create;
    nativePresetSaveIntent = null;
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

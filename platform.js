// Host-specific behavior lives here; Profile/credential/preset business logic stays shared.
const PARAMETER_FIELDS = [
    ['includeBody', 'include_body', 'custom_include_body'],
    ['excludeBody', 'exclude_body', 'custom_exclude_body'],
    ['includeHeaders', 'include_headers', 'custom_include_headers'],
];
const CUSTOM_FORMAT_SELECTIONS = {
    openai_compat: 'custom',
    openai_responses: 'custom_openai_responses',
    claude_messages: 'custom_claude_messages',
    gemini_interactions: 'custom_gemini_interactions',
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createPlatformAdapter({ openai, settingsApi, cancelDebounce, $ }) {
    const native = openai.oai_settings;
    const customSource = openai.chat_completion_sources.CUSTOM;
    const usesSourceParameters = typeof openai.getAdditionalParametersForSource === 'function';
    const editorBindings = new WeakMap();

    function parameterEntry(settings = native, source, create = false) {
        if (usesSourceParameters) {
            return openai.getAdditionalParametersForSource(settings, source, { create });
        }
        if (Object.hasOwn(settings, 'additional_parameters_by_source')) {
            throw new Error('Host has source-scoped parameters but no supported parameter accessor.');
        }
        return settings;
    }

    function readAdditionalParameters(source, settings = native) {
        const entry = parameterEntry(settings, source);
        return Object.fromEntries(PARAMETER_FIELDS.map(([profileKey, scopedKey, legacyKey]) =>
            [profileKey, String(entry[usesSourceParameters ? scopedKey : legacyKey] || '')]));
    }

    // Tauri's popup handlers close over an entry object, not the current source.
    // Never trigger those handlers after a source/preset has replaced that entry.
    function rememberParameterEditors() {
        if (!usesSourceParameters || !$) return;
        for (const [, , id] of PARAMETER_FIELDS) {
            $(`#${id}`).each((_, input) => {
                if (!editorBindings.has(input)) {
                    editorBindings.set(input, { entry: parameterEntry(native, undefined, true), disabled: input.disabled });
                }
            });
        }
    }

    function syncParameterEditors({ emitLegacyInput = false } = {}) {
        if (!$) return;
        const entry = parameterEntry();
        for (const [, scopedKey, legacyKey] of PARAMETER_FIELDS) {
            $(`#${legacyKey}`).each((_, input) => {
                const binding = editorBindings.get(input);
                if (usesSourceParameters && binding && binding.entry !== entry) {
                    input.disabled = true;
                    const root = $(input).closest('.height100p');
                    if (!root.find('.quicker-api__stale-parameters').length) {
                        $('<small class="quicker-api__stale-parameters">')
                            .text('API 来源或预设已切换，请关闭并重新打开附加参数编辑器。')
                            .prependTo(root);
                    }
                    return;
                }
                if (binding) input.disabled = binding.disabled;
                $(input).closest('.height100p').find('.quicker-api__stale-parameters').remove();
                $(input).val(String(entry[usesSourceParameters ? scopedKey : legacyKey] || ''));
                if (emitLegacyInput && !usesSourceParameters) $(input).trigger('input');
            });
        }
    }

    function writeAdditionalParameters(profile, source) {
        rememberParameterEditors();
        const entry = parameterEntry(native, source, true);
        for (const [profileKey, scopedKey, legacyKey] of PARAMETER_FIELDS) {
            // Quicker manages only exclusions for Claude/Gemini. Preserve the
            // host's independent body/headers rather than silently clearing them.
            if (usesSourceParameters && source !== customSource && profileKey !== 'excludeBody') continue;
            entry[usesSourceParameters ? scopedKey : legacyKey] = String(profile?.[profileKey] || '');
        }
        syncParameterEditors({ emitLegacyInput: true });
    }

    function supportsCustomConnection(settings = native) {
        return !Object.hasOwn(settings, 'custom_api_format') || !settings.custom_api_format
            || settings.custom_api_format === 'openai_compat';
    }

    function matchesSource(source, settings = native) {
        return settings.chat_completion_source === source
            && (source !== customSource || supportsCustomConnection(settings));
    }

    function selectSource(source) {
        rememberParameterEditors();
        const changed = !matchesSource(source) || ($ && $('#chat_completion_source').val() !== source);
        native.chat_completion_source = source;
        if (source === customSource && Object.hasOwn(native, 'custom_api_format')) native.custom_api_format = 'openai_compat';
        if (changed && $) $('#chat_completion_source').val(source).trigger('change');
        syncParameterEditors();
    }

    function snapshotConnectionState() {
        rememberParameterEditors();
        const fields = ['chat_completion_source', 'custom_api_format', 'additional_parameters_by_source',
            ...PARAMETER_FIELDS.map(([, , key]) => key)];
        return structuredClone(Object.fromEntries(fields.filter(key => Object.hasOwn(native, key)).map(key => [key, native[key]])));
    }

    function restoreConnectionState(snapshot) {
        rememberParameterEditors();
        const fields = ['custom_api_format', ...PARAMETER_FIELDS.map(([, , key]) => key)];
        for (const key of fields) {
            if (Object.hasOwn(snapshot, key)) native[key] = snapshot[key];
            else delete native[key];
        }
        if (Object.hasOwn(snapshot, 'additional_parameters_by_source')) {
            const savedStore = snapshot.additional_parameters_by_source;
            if (!isObject(savedStore)) throw new Error('Invalid additional parameter snapshot.');
            const store = isObject(native.additional_parameters_by_source) ? native.additional_parameters_by_source : {};
            for (const key of Object.keys(store)) if (!Object.hasOwn(savedStore, key)) delete store[key];
            for (const [key, value] of Object.entries(savedStore)) {
                // Keep surviving entry identities so an already-open popup stays valid.
                const entry = Object.hasOwn(store, key) && isObject(store[key]) ? store[key] : {};
                for (const field of Object.keys(entry)) delete entry[field];
                for (const [field, fieldValue] of Object.entries(value)) {
                    Object.defineProperty(entry, field, { value: structuredClone(fieldValue), enumerable: true, writable: true, configurable: true });
                }
                Object.defineProperty(store, key, { value: entry, enumerable: true, writable: true, configurable: true });
            }
            native.additional_parameters_by_source = store;
        } else {
            delete native.additional_parameters_by_source;
        }
        native.chat_completion_source = snapshot.chat_completion_source;
        const selection = snapshot.chat_completion_source === customSource
            ? (CUSTOM_FORMAT_SELECTIONS[snapshot.custom_api_format] || customSource) : snapshot.chat_completion_source;
        if ($) $('#chat_completion_source').val(selection).trigger('change');
        syncParameterEditors({ emitLegacyInput: true });
    }

    function cancelSettingsSave() {
        if (typeof settingsApi.cancelPendingSettingsSave === 'function') settingsApi.cancelPendingSettingsSave();
        else cancelDebounce(settingsApi.saveSettingsDebounced);
    }

    function dispose() {
        if (!$) return;
        for (const [, , id] of PARAMETER_FIELDS) {
            $(`#${id}`).each((_, input) => {
                const binding = editorBindings.get(input);
                if (binding) input.disabled = binding.disabled;
                editorBindings.delete(input);
            });
        }
        $('.quicker-api__stale-parameters').remove();
    }

    return {
        readAdditionalParameters, writeAdditionalParameters, matchesSource, selectSource, supportsCustomConnection,
        snapshotConnectionState, restoreConnectionState, rememberParameterEditors, syncParameterEditors,
        cancelSettingsSave, dispose,
        // This host applies exclusions to the final provider body. Deleting fields
        // from its transport envelope early can remove routing/validation inputs.
        handlesRequestExclusions: usesSourceParameters,
    };
}

async function readSavePayload(resource, options) {
    const request = typeof Request !== 'undefined' && resource instanceof Request ? resource.clone() : null;
    const headers = new Headers(options?.headers ?? request?.headers);
    const body = options?.body !== undefined ? new Response(options.body) : request;
    if (!body) return null;
    const encoding = headers.get('Content-Encoding');
    if (encoding && encoding !== 'identity') {
        if (encoding !== 'gzip' || typeof DecompressionStream !== 'function') return null;
        return await new Response(body.body.pipeThrough(new DecompressionStream('gzip'))).json();
    }
    return await body.json();
}

// Reconstruct ONLY our subtree from the last acknowledged snapshot. Do not use
// live settings: they may already contain edits made after the host took its snapshot.
function snapshotAfterPatch(baselineSnapshot, patch, moduleName) {
    if (!Array.isArray(patch?.ops) || typeof patch.base_hash !== 'string') return '';
    const prefix = ['extension_settings', moduleName];
    let value = baselineSnapshot ? JSON.parse(baselineSnapshot) : undefined;
    for (const op of patch.ops) {
        if (!Array.isArray(op?.path) || !op.path.every(key => typeof key === 'string')
            || !['set', 'delete'].includes(op.op)) return '';
        if (op.path.some((key, index) => index < prefix.length && key !== prefix[index])) continue;
        if (op.path.length <= prefix.length) {
            value = op.op === 'set' ? op.value : undefined;
            for (const key of prefix.slice(op.path.length)) value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
            value = value === undefined ? undefined : structuredClone(value);
            continue;
        }
        const path = op.path.slice(prefix.length);
        let parent = value;
        for (const key of path.slice(0, -1)) {
            if (!isObject(parent) || !Object.hasOwn(parent, key)) return '';
            parent = parent[key];
        }
        if (!isObject(parent)) return '';
        const key = path.at(-1);
        if (op.op === 'delete') delete parent[key];
        else Object.defineProperty(parent, key, { value: structuredClone(op.value), enumerable: true, writable: true, configurable: true });
    }
    return isObject(value) ? JSON.stringify(value) : '';
}

export async function inspectSettingsSave({ path, resource, options, moduleName, baselineSnapshot }) {
    if (path !== '/api/settings/save' && path !== '/api/settings/patch') return null;
    try {
        const payload = await readSavePayload(resource, options);
        const isPatch = path === '/api/settings/patch';
        const snapshot = isPatch ? snapshotAfterPatch(baselineSnapshot, payload, moduleName)
            : (isObject(payload?.extension_settings?.[moduleName]) ? JSON.stringify(payload.extension_settings[moduleName]) : '');
        if (!snapshot) return null;
        return {
            snapshot,
            async succeeded(response) {
                if (!response.ok) return false;
                if (!isPatch) return true;
                // Tauri considers a 2xx patch without a valid revision a failure.
                try {
                    const result = await response.clone().json();
                    return result?.hash_algorithm === 'tt-user-settings-stable-sha256-v1'
                        && typeof result.settings_hash === 'string' && /^[0-9a-f]{64}$/.test(result.settings_hash);
                } catch { return false; }
            },
        };
    } catch {
        // Unknown/compressed payloads must pass through untouched, never be
        // optimistically reported as saved. The caller retains its timeout guard.
        return null;
    }
}

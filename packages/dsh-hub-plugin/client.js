window.__ModuleLoader__.load({
  id: 'dsh-hub-plugin',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const LOCALE_NS = 'dsh-hub.browser';
    const SETTINGS_KEY = 'dsh-hub';
    const STATUS_ENDPOINT = '/plugins/dsh-hub-plugin/status.json';
    const MODEL_SETTINGS_ENDPOINT = '/plugins/dsh-hub-plugin/model-settings.json';
    const MODEL_SETTINGS_TEST_ENDPOINT = '/plugins/dsh-hub-plugin/model-settings/test.json';
    const LIVE_STATUS_POLL_MS = 15000;
    const HISTORY_AUTOLOAD_THRESHOLD_PX = 240;
    const HISTORY_AUTOLOAD_RECHECK_MS = 150;

    const copy = {
      zh: {
        title: 'dsh-hub 远程访问',
        description: '插件模式连接中心的状态、诊断与 hosted 模型设置卡片。',
        statusFallback: '等待 host 侧提供 dsh-hub plugin 状态摘要。',
        liveLoading: '正在读取 host 侧实时状态…',
        liveOk: '已同步 host 侧实时状态。',
        liveError: '实时状态读取失败，将继续显示最近一次状态。',
        refresh: '刷新诊断',
        connection: '连接',
        diagnostics: '诊断',
        instanceUrl: '实例入口',
        noInstanceUrl: '入伙后显示',
        workspaceMapping: 'Session / workspace 映射',
        historyRelay: '最近历史加载',
        boundaryA: 'plugin tunnel 使用 delivery=plugin，并通过 deploymentMode 区分 remote / hosted 组合。',
        boundaryB: 'registry key 和 replacement grant 只作为一次性输入；browser card 不读取或保存秘密。',
        boundaryC: '目录选择器使用显式 remote-capabilities overlay；同一 overlay 会让 canOpenPath=false 以隐藏/禁用相关 UI，但不拦截 direct host.openPath RPC。',
        historyAutoLoad: '远程访问时，滚动到会话顶部会自动加载更早历史；原生“加载更早”按钮仍保留作为手动兜底。',
        historyRetry: '历史加载失败，点击重试',
        historyRetrying: '正在重试历史加载…',
        modelSettings: 'Hosted 模型设置',
        modelSettingsDescription: '仅 hosted DSH 可用。API key 只写入这台 DSH 的本地凭据，Hub 服务端不解析也不持久化。',
        modelSettingsHostedOnly: '当前实例不是 hosted 模式，模型设置由实例机器本地 DSH 管理。',
        modelSettingsUnavailable: 'Hosted 模型设置暂不可用',
        modelSettingsLoading: '正在加载模型设置…',
        modelSettingsLoadError: '模型设置加载失败。',
        modelSettingsReady: 'Hosted 模型设置可用。',
        currentDefaultModel: '当前默认模型',
        providerKind: '提供方类型',
        deepseekOfficial: 'DeepSeek 官方',
        openaiCompatible: 'OpenAI 兼容 / 自定义 Base URL',
        providerId: '提供方 ID',
        displayName: '显示名称',
        apiProtocol: 'API 协议',
        baseURL: 'Base URL',
        modelId: '模型 ID',
        apiKey: 'API Key',
        apiKeyPlaceholder: '留空则保留现有凭据',
        saveModelSettings: '保存设置',
        testConnection: '测试连接',
        saving: '正在保存…',
        testing: '正在测试…',
        modelSettingsSaved: '模型设置已保存。',
        modelSettingsSaveError: '模型设置保存失败。',
        modelSettingsTestOk: '连接测试成功。',
        modelSettingsTestFail: '连接测试失败。',
        credentialConfigured: '凭据已配置',
        missingChecks: '缺少检查',
      },
      en: {
        title: 'dsh-hub remote access',
        description: 'Status, diagnostics, and hosted model settings card for plugin-mode hub connectivity.',
        statusFallback: 'Waiting for the host side to provide the dsh-hub plugin status summary.',
        liveLoading: 'Reading live host-side status…',
        liveOk: 'Live host-side status synced.',
        liveError: 'Live status read failed; showing the last known status.',
        refresh: 'Refresh diagnostics',
        connection: 'Connection',
        diagnostics: 'Diagnostics',
        instanceUrl: 'Instance URL',
        noInstanceUrl: 'Shown after join',
        workspaceMapping: 'Session / workspace mapping',
        historyRelay: 'Latest history load',
        boundaryA: 'The plugin tunnel uses delivery=plugin and reports deploymentMode for remote / hosted composition.',
        boundaryB: 'Registry key and replacement grant are one-shot inputs; the browser card does not read or store secrets.',
        boundaryC: 'Directory picker uses the explicit remote-capabilities overlay; the same overlay makes canOpenPath=false for UI gating but does not intercept direct host.openPath RPC.',
        historyAutoLoad: 'During remote access, scrolling near the top auto-loads older history; the native Load older button remains as a manual fallback.',
        historyRetry: 'History load failed. Retry',
        historyRetrying: 'Retrying history load…',
        modelSettings: 'Hosted model settings',
        modelSettingsDescription: 'Available only for hosted DSH. API keys are written only to this DSH local credential store; the Hub service does not parse or persist them.',
        modelSettingsHostedOnly: 'This instance is not in hosted mode; model settings are managed by the instance-side local DSH.',
        modelSettingsUnavailable: 'Hosted model settings are unavailable',
        modelSettingsLoading: 'Loading model settings…',
        modelSettingsLoadError: 'Failed to load model settings.',
        modelSettingsReady: 'Hosted model settings are available.',
        currentDefaultModel: 'Current default model',
        providerKind: 'Provider kind',
        deepseekOfficial: 'DeepSeek Official',
        openaiCompatible: 'OpenAI-compatible / custom Base URL',
        providerId: 'Provider ID',
        displayName: 'Display name',
        apiProtocol: 'API protocol',
        baseURL: 'Base URL',
        modelId: 'Model ID',
        apiKey: 'API key',
        apiKeyPlaceholder: 'Leave blank to keep the existing credential',
        saveModelSettings: 'Save settings',
        testConnection: 'Test connection',
        saving: 'Saving…',
        testing: 'Testing…',
        modelSettingsSaved: 'Model settings saved.',
        modelSettingsSaveError: 'Failed to save model settings.',
        modelSettingsTestOk: 'Connection test succeeded.',
        modelSettingsTestFail: 'Connection test failed.',
        credentialConfigured: 'Credential configured',
        missingChecks: 'Missing checks',
      },
    };

    function translate(props, key) {
      if (typeof props?.t === 'function') return props.t(key);
      const lang = typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      return copy[lang][key] ?? copy.en[key] ?? key;
    }

    function row(text) {
      return React.createElement('li', { style: { margin: '4px 0' } }, text);
    }

    const secretPattern = /\b(?:dhk|dhr|dht|dit)_[A-Za-z0-9_-]+\b/g;
    const posixPathPattern = /(^|[\s"'(=,:;])\/(?:Users|home|root|var|tmp|private\/var|Volumes|mnt|opt|srv|workspace)\/[^\s"',)<>\]]+/g;
    const windowsPathPattern = /\b[A-Za-z]:\\[^\s"',)<>\]]+/g;
    const uncPathPattern = /\\\\[^\\\s"',)<>\]]+\\[^\s"',)<>\]]+/g;

    function redactPublicText(value) {
      return String(value)
        .replace(secretPattern, '[redacted-secret]')
        .replace(posixPathPattern, '$1[redacted-path]')
        .replace(windowsPathPattern, '[redacted-path]')
        .replace(uncPathPattern, '[redacted-path]');
    }

    function statusViewFromProps(props) {
      return props?.statusView ?? props?.status?.statusView ?? props?.plugin?.statusView ?? null;
    }

    async function fetchBrowserStatusView({ refresh = false } = {}) {
      const url = refresh ? `${STATUS_ENDPOINT}?refresh=1` : STATUS_ENDPOINT;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
      const payload = await response.json();
      return payload?.statusView ?? null;
    }

    function textValue(value, fallback = '-') {
      if (value === null || value === undefined || value === '') return fallback;
      return redactPublicText(value);
    }

    function metric(label, value) {
      return React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 12, margin: '3px 0' } },
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, label),
        React.createElement('span', null, value),
      );
    }

    function controlStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '5px 7px',
        fontSize: 12,
      };
    }

    function buttonStyle(primary = false) {
      return {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: primary ? 'var(--dsw-alias-bg-brand)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        padding: '4px 8px',
        fontSize: 12,
        cursor: 'pointer',
      };
    }

    function field(props, labelKey, input) {
      return React.createElement(
        'label',
        { style: { display: 'block', margin: '7px 0', color: 'var(--dsw-alias-label-secondary)' } },
        React.createElement('span', { style: { display: 'block', marginBottom: 3 } }, translate(props, labelKey)),
        input,
      );
    }

    async function fetchJson(url, options = {}) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error?.message || `request failed with ${response.status}`);
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    async function fetchModelSettings() {
      return fetchJson(MODEL_SETTINGS_ENDPOINT);
    }

    function providerById(settings, providerId) {
      const providers = Array.isArray(settings?.providers) ? settings.providers : [];
      return providers.find((provider) => provider?.id === providerId) ?? null;
    }

    function firstModelId(provider) {
      const model = Array.isArray(provider?.models) ? provider.models.find((item) => item?.id) : null;
      return model?.id ?? '';
    }

    function initialModelSettingsForm(settings) {
      const defaultProvider = settings?.defaultModel?.provider;
      const deepseek = providerById(settings, 'deepseek-official');
      const custom = defaultProvider && defaultProvider !== 'deepseek-official'
        ? providerById(settings, defaultProvider)
        : null;
      const provider = custom ?? deepseek;
      const kind = custom ? 'openai-compatible' : 'deepseek-official';
      return {
        providerKind: kind,
        providerId: custom?.id ?? 'custom-openai',
        displayName: custom?.displayName ?? 'Custom OpenAI',
        api: custom?.api === 'openai-responses' ? 'openai-responses' : 'openai-completions',
        baseURL: provider?.baseURL ?? (kind === 'deepseek-official' ? 'https://api.deepseek.com' : ''),
        model: settings?.defaultModel?.model ?? firstModelId(provider),
        apiKey: '',
      };
    }

    function safeMessage(error, props, fallbackKey) {
      return textValue(error?.message, translate(props, fallbackKey));
    }

    function buildModelSettingsPayload(form) {
      const providerKind = form.providerKind === 'openai-compatible' ? 'openai-compatible' : 'deepseek-official';
      const model = String(form.model ?? '').trim();
      const apiKey = String(form.apiKey ?? '').trim();
      if (providerKind === 'deepseek-official') {
        return {
          providerKind,
          baseURL: String(form.baseURL ?? '').trim() || 'https://api.deepseek.com',
          ...(model ? { model } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
      }
      const providerId = String(form.providerId ?? '').trim();
      return {
        providerKind,
        providerId,
        displayName: String(form.displayName ?? '').trim() || providerId,
        api: form.api === 'openai-responses' ? 'openai-responses' : 'openai-completions',
        baseURL: String(form.baseURL ?? '').trim(),
        ...(model ? { model, models: [{ id: model, name: model }] } : { models: [] }),
        ...(apiKey ? { apiKey } : {}),
      };
    }

    function ModelSettingsPanel(props) {
      const { view } = props;
      const deploymentMode = view?.connection?.deploymentMode ?? 'unknown';
      const [settings, setSettings] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [loadState, setLoadState] = React.useState('idle');
      const [message, setMessage] = React.useState(null);

      React.useEffect(() => {
        let disposed = false;
        async function load() {
          if (deploymentMode !== 'hosted' || typeof fetch !== 'function') return;
          setLoadState('loading');
          try {
            const payload = await fetchModelSettings();
            if (disposed) return;
            setSettings(payload);
            setForm(initialModelSettingsForm(payload));
            setLoadState('ok');
          } catch (error) {
            if (disposed) return;
            setLoadState('error');
            setMessage({ kind: 'error', text: safeMessage(error, props, 'modelSettingsLoadError') });
          }
        }
        void load();
        return () => {
          disposed = true;
        };
      }, [deploymentMode]);

      if (deploymentMode !== 'hosted') {
        return React.createElement(
          'section',
          { style: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px' } },
          React.createElement('strong', null, translate(props, 'modelSettings')),
          React.createElement('p', { style: { margin: '4px 0 0', color: 'var(--dsw-alias-label-tertiary)' } }, translate(props, 'modelSettingsHostedOnly')),
        );
      }

      const eligible = settings?.hostedEligible === true;
      const busy = loadState === 'loading' || loadState === 'saving' || loadState === 'testing';
      const disabled = !eligible || !form || busy;
      const currentDefault = settings?.defaultModel?.provider && settings?.defaultModel?.model
        ? `${settings.defaultModel.provider}/${settings.defaultModel.model}`
        : '-';
      const selectedProvider = providerById(settings, form?.providerKind === 'deepseek-official' ? 'deepseek-official' : form?.providerId);
      const credentialConfigured = selectedProvider?.credential?.configured === true;
      const missing = Array.isArray(settings?.preflight?.missing) ? settings.preflight.missing.join(', ') : '';

      const setField = (name, value) => {
        setForm((previous) => ({ ...(previous ?? initialModelSettingsForm(settings)), [name]: value }));
        setMessage(null);
      };
      const save = async () => {
        if (!form) return;
        setLoadState('saving');
        try {
          const payload = await fetchJson(MODEL_SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildModelSettingsPayload(form)),
          });
          setSettings(payload);
          setForm(initialModelSettingsForm(payload));
          setMessage({ kind: 'ok', text: translate(props, 'modelSettingsSaved') });
          setLoadState('ok');
        } catch (error) {
          setMessage({ kind: 'error', text: safeMessage(error, props, 'modelSettingsSaveError') });
          setLoadState('ok');
        }
      };
      const test = async () => {
        if (!form) return;
        setLoadState('testing');
        try {
          const payload = await fetchJson(MODEL_SETTINGS_TEST_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildModelSettingsPayload(form)),
          });
          setMessage({
            kind: payload.ok ? 'ok' : 'error',
            text: payload.ok ? translate(props, 'modelSettingsTestOk') : `${translate(props, 'modelSettingsTestFail')} ${textValue(payload.status)}`,
          });
          setLoadState('ok');
        } catch (error) {
          setMessage({ kind: 'error', text: safeMessage(error, props, 'modelSettingsTestFail') });
          setLoadState('ok');
        }
      };

      return React.createElement(
        'section',
        { style: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px' } },
        React.createElement('strong', null, translate(props, 'modelSettings')),
        React.createElement('p', { style: { margin: '4px 0 7px', color: 'var(--dsw-alias-label-tertiary)' } }, translate(props, 'modelSettingsDescription')),
        loadState === 'loading'
          ? React.createElement('p', { style: { margin: '4px 0', color: 'var(--dsw-alias-label-tertiary)' } }, translate(props, 'modelSettingsLoading'))
          : null,
        settings && !eligible
          ? React.createElement('p', { style: { margin: '4px 0', color: 'var(--dsw-alias-label-tertiary)' } }, `${translate(props, 'modelSettingsUnavailable')}${missing ? `: ${textValue(missing)}` : ''}`)
          : null,
        settings && eligible
          ? React.createElement('p', { style: { margin: '4px 0', color: 'var(--dsw-alias-label-tertiary)' } }, `${translate(props, 'modelSettingsReady')} ${translate(props, 'currentDefaultModel')}: ${textValue(currentDefault)}; ${translate(props, 'credentialConfigured')}: ${credentialConfigured ? 'yes' : 'no'}`)
          : null,
        form ? React.createElement(
          React.Fragment,
          null,
          field(props, 'providerKind', React.createElement('select', {
            value: form.providerKind,
            disabled,
            onChange: (event) => setField('providerKind', event.target.value),
            style: controlStyle(),
          },
          React.createElement('option', { value: 'deepseek-official' }, translate(props, 'deepseekOfficial')),
          React.createElement('option', { value: 'openai-compatible' }, translate(props, 'openaiCompatible')))),
          form.providerKind === 'openai-compatible' ? field(props, 'providerId', React.createElement('input', {
            value: form.providerId,
            disabled,
            onChange: (event) => setField('providerId', event.target.value),
            style: controlStyle(),
          })) : null,
          form.providerKind === 'openai-compatible' ? field(props, 'displayName', React.createElement('input', {
            value: form.displayName,
            disabled,
            onChange: (event) => setField('displayName', event.target.value),
            style: controlStyle(),
          })) : null,
          form.providerKind === 'openai-compatible' ? field(props, 'apiProtocol', React.createElement('select', {
            value: form.api,
            disabled,
            onChange: (event) => setField('api', event.target.value),
            style: controlStyle(),
          },
          React.createElement('option', { value: 'openai-completions' }, 'openai-completions'),
          React.createElement('option', { value: 'openai-responses' }, 'openai-responses'))) : null,
          field(props, 'baseURL', React.createElement('input', {
            value: form.baseURL,
            disabled,
            onChange: (event) => setField('baseURL', event.target.value),
            style: controlStyle(),
          })),
          field(props, 'modelId', React.createElement('input', {
            value: form.model,
            disabled,
            onChange: (event) => setField('model', event.target.value),
            style: controlStyle(),
          })),
          field(props, 'apiKey', React.createElement('input', {
            value: form.apiKey,
            disabled,
            type: 'password',
            placeholder: translate(props, 'apiKeyPlaceholder'),
            onChange: (event) => setField('apiKey', event.target.value),
            style: controlStyle(),
          })),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            React.createElement('button', {
              type: 'button',
              disabled,
              onClick: () => { void save(); },
              style: buttonStyle(true),
            }, loadState === 'saving' ? translate(props, 'saving') : translate(props, 'saveModelSettings')),
            React.createElement('button', {
              type: 'button',
              disabled,
              onClick: () => { void test(); },
              style: buttonStyle(false),
            }, loadState === 'testing' ? translate(props, 'testing') : translate(props, 'testConnection')),
          ),
        ) : null,
        message ? React.createElement('p', {
          role: 'status',
          style: {
            margin: '7px 0 0',
            color: message.kind === 'ok' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        }, message.text) : null,
      );
    }

    function mappingText(view, props) {
      const mapping = view?.diagnostics?.workspaceMapping;
      if (!mapping) return translate(props, 'statusFallback');
      return `sessions=${textValue(mapping.sessionCount)}, workspaces=${textValue(mapping.workspaceCount)}, linked=${textValue(mapping.linkedSessionCount)}, unlinked=${textValue(mapping.unlinkedSessionCount)}, stale=${textValue(mapping.staleWorkspaceSessionCount)}`;
    }

    function historyRelayText(view, props) {
      const recent = view?.diagnostics?.historyRelay?.recent;
      const latest = Array.isArray(recent) && recent.length ? recent[recent.length - 1] : null;
      if (!latest) return translate(props, 'statusFallback');
      const parts = [
        textValue(latest.terminalState),
        latest.errorCode ? `code=${textValue(latest.errorCode)}` : null,
        latest.status ? `status=${textValue(latest.status)}` : null,
        `raw=${textValue(latest.rawResponseBytes)}B`,
        `normalized=${textValue(latest.normalizedBytes)}B`,
        `elapsed=${textValue(latest.elapsedMs)}ms`,
      ].filter(Boolean);
      return parts.join(', ');
    }

    function DshHubSettingsCard(props) {
      const initialView = statusViewFromProps(props);
      const [liveView, setLiveView] = React.useState(null);
      const [liveState, setLiveState] = React.useState('idle');
      const view = liveView ?? initialView;
      const connection = view?.connection ?? {};
      const summary = view?.summary ?? {};

      React.useEffect(() => {
        let disposed = false;
        async function load() {
          if (typeof fetch !== 'function') return;
          setLiveState('loading');
          try {
            const next = await fetchBrowserStatusView();
            if (disposed) return;
            if (next) setLiveView(next);
            setLiveState('ok');
          } catch {
            if (!disposed) setLiveState('error');
          }
        }
        void load();
        const timer = setInterval(() => {
          void load();
        }, LIVE_STATUS_POLL_MS);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, []);

      async function refreshDiagnostics() {
        if (typeof fetch !== 'function') return;
        setLiveState('loading');
        try {
          const next = await fetchBrowserStatusView({ refresh: true });
          if (next) setLiveView(next);
          setLiveState('ok');
        } catch {
          setLiveState('error');
        }
      }

      const liveMessage = liveState === 'loading'
        ? translate(props, 'liveLoading')
        : liveState === 'ok'
          ? translate(props, 'liveOk')
          : liveState === 'error'
            ? translate(props, 'liveError')
            : null;
      return React.createElement(
        'li',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-3)',
            color: 'var(--dsw-alias-label-primary)',
            padding: '14px 16px',
            listStyle: 'none',
          },
        },
        React.createElement('h3', { style: { margin: '0 0 6px', fontSize: 14, lineHeight: '20px' } }, translate(props, 'title')),
        React.createElement('p', { style: { margin: '0 0 10px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' } }, translate(props, 'description')),
        React.createElement('p', { role: 'status', style: { margin: '0 0 8px', fontSize: 13, lineHeight: '20px' } }, textValue(summary.message, translate(props, 'statusFallback'))),
        liveMessage ? React.createElement('p', { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' } }, liveMessage) : null,
        React.createElement(
          'section',
          { style: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px' } },
          React.createElement('strong', null, translate(props, 'connection')),
          metric('state', textValue(connection.state)),
          metric('delivery', textValue(connection.delivery)),
          metric('deploymentMode', textValue(connection.deploymentMode)),
          metric('protocol', textValue(connection.protocol)),
          metric('instanceId', textValue(connection.instanceId)),
          metric(translate(props, 'instanceUrl'), textValue(connection.instanceUrl, translate(props, 'noInstanceUrl'))),
          metric('target', textValue(connection.target)),
        ),
        React.createElement(
          'section',
          { style: { margin: '0 0 10px', fontSize: 12, lineHeight: '18px' } },
          React.createElement('strong', null, translate(props, 'diagnostics')),
          metric(translate(props, 'workspaceMapping'), mappingText(view, props)),
          metric(translate(props, 'historyRelay'), historyRelayText(view, props)),
          React.createElement('button', {
            type: 'button',
            onClick: () => {
              void refreshDiagnostics();
            },
            style: {
              marginTop: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              padding: '4px 8px',
              fontSize: 12,
              cursor: 'pointer',
            },
          }, translate(props, 'refresh')),
        ),
        React.createElement(ModelSettingsPanel, { ...props, view }),
        React.createElement(
          'ul',
          { style: { margin: 0, paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } },
          row(translate(props, 'boundaryA')),
          row(translate(props, 'boundaryB')),
          row(translate(props, 'boundaryC')),
          row(translate(props, 'historyAutoLoad')),
        ),
      );
    }

    function isLoopbackHostname(hostname) {
      const value = String(hostname ?? '').trim().toLowerCase();
      return value === ''
        || value === 'localhost'
        || value === '::1'
        || value === '[::1]'
        || value === '0.0.0.0'
        || value.startsWith('127.');
    }

    function originOfUrl(value) {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    }

    function historyAutoLoadEnabledForBrowser(locationLike = globalThis.location, statusView = null) {
      if (isLoopbackHostname(locationLike?.hostname)) return false;
      if (statusView?.capabilities?.sessionHistoryAutoLoad !== true) return false;
      const currentOrigin = originOfUrl(locationLike?.href) ?? originOfUrl(locationLike?.origin);
      const instanceOrigin = originOfUrl(statusView?.connection?.instanceUrl);
      return currentOrigin !== null && currentOrigin === instanceOrigin;
    }

    async function resolveHistoryAutoLoadEnabled({
      locationLike = globalThis.location,
      fetchStatusView = fetchBrowserStatusView,
    } = {}) {
      try {
        const statusView = await fetchStatusView();
        return historyAutoLoadEnabledForBrowser(locationLike, statusView);
      } catch {
        return false;
      }
    }

    function findHistoryScrollports(doc = globalThis.document) {
      if (!doc?.querySelectorAll) return [];
      const ports = [];
      const seen = new Set();
      for (const flow of doc.querySelectorAll('[data-chat-flow]')) {
        const port = flow.closest?.('[data-conversation-scroll]') ?? flow.parentElement ?? flow;
        if (!port || seen.has(port)) continue;
        seen.add(port);
        ports.push(port);
      }
      return ports;
    }

    function shouldAutoLoadHistory(snapshot, scrollport, {
      thresholdPx = HISTORY_AUTOLOAD_THRESHOLD_PX,
      inFlight = false,
      enabled = true,
      armed = true,
    } = {}) {
      if (!enabled || !armed || inFlight || !scrollport) return false;
      if (!snapshot || snapshot.openState !== 'open' || snapshot.hasMore !== true || snapshot.loadingOlder === true) return false;
      return Number(scrollport.scrollTop ?? Number.POSITIVE_INFINITY) <= thresholdPx;
    }

    function createHistoryAutoLoadController({
      session,
      doc = globalThis.document,
      locationLike = globalThis.location,
      thresholdPx = HISTORY_AUTOLOAD_THRESHOLD_PX,
      recheckMs = HISTORY_AUTOLOAD_RECHECK_MS,
      timer = globalThis,
      fetchStatusView = fetchBrowserStatusView,
      logError = () => {},
      onLoadStart = () => {},
      onLoadError = () => {},
    } = {}) {
      if (!session || typeof session.getSnapshot !== 'function' || typeof session.loadOlder !== 'function') {
        return { start() { return () => {}; } };
      }

      let disposed = false;
      let inFlight = false;
      let enabled = false;
      let armed = true;
      let listeners = [];
      let subscriptions = [];
      let observer = null;
      let recheckTimer = null;

      const clearRecheck = () => {
        if (recheckTimer === null || typeof timer?.clearTimeout !== 'function') return;
        timer.clearTimeout(recheckTimer);
        recheckTimer = null;
      };

      const scheduleCheck = () => {
        if (disposed || typeof timer?.setTimeout !== 'function') return;
        clearRecheck();
        recheckTimer = timer.setTimeout(() => {
          recheckTimer = null;
          check({ allowLoad: false });
        }, recheckMs);
      };

      const detach = () => {
        for (const { port, onScroll } of listeners) port.removeEventListener?.('scroll', onScroll);
        listeners = [];
      };

      const unsubscribe = () => {
        for (const stop of subscriptions) stop();
        subscriptions = [];
      };

      const attach = () => {
        const current = findHistoryScrollports(doc);
        const same = current.length === listeners.length && current.every((port, index) => port === listeners[index]?.port);
        if (same) return;
        detach();
        listeners = current.map((port) => {
          const onScroll = () => {
            check({ allowLoad: true });
          };
          port.addEventListener?.('scroll', onScroll, { passive: true });
          return { port, onScroll };
        });
      };

      const isNearTop = (port) => Number(port?.scrollTop ?? Number.POSITIVE_INFINITY) <= thresholdPx;

      const updateArming = () => {
        if (listeners.some(({ port }) => !isNearTop(port))) armed = true;
      };

      const load = () => {
        if (disposed || inFlight) return;
        armed = false;
        inFlight = true;
        onLoadStart();
        void (async () => {
          try {
            await session.loadOlder();
          } catch (error) {
            logError(error);
            onLoadError(error);
          } finally {
            inFlight = false;
          }
        })();
      };

      function check({ allowLoad = false } = {}) {
        if (disposed) return;
        attach();
        updateArming();
        if (!allowLoad) return;
        const snapshot = session.getSnapshot();
        for (const { port } of listeners) {
          if (shouldAutoLoadHistory(snapshot, port, { thresholdPx, inFlight, enabled, armed })) {
            load();
            break;
          }
        }
      }

      return {
        start() {
          Promise.resolve(
            typeof locationLike?.historyAutoLoadEnabled === 'boolean'
              ? locationLike.historyAutoLoadEnabled
              : resolveHistoryAutoLoadEnabled({ locationLike, fetchStatusView }),
          ).then((value) => {
            if (disposed) return;
            enabled = value === true;
            if (!enabled) return;
            attach();
            if (typeof session.subscribe === 'function') {
              subscriptions.push(session.subscribe(() => scheduleCheck()));
            }
            if (typeof MutationObserver !== 'undefined' && doc?.body) {
              observer = new MutationObserver(() => scheduleCheck());
              observer.observe(doc.body, { childList: true, subtree: true });
            }
          }, () => {});
          return () => {
            disposed = true;
            clearRecheck();
            if (observer) observer.disconnect();
            unsubscribe();
            detach();
          };
        },
        check,
      };
    }

    function HistoryAutoLoadController(props) {
      const { session } = props;
      const [historyError, setHistoryError] = React.useState(false);
      const [retrying, setRetrying] = React.useState(false);
      React.useEffect(() => {
        const controller = createHistoryAutoLoadController({
          session,
          logError: () => {},
          onLoadStart: () => setHistoryError(false),
          onLoadError: () => setHistoryError(true),
        });
        return controller.start();
      }, [session]);
      if (!historyError || !session || typeof session.loadOlder !== 'function') return null;
      const label = retrying ? translate(props, 'historyRetrying') : translate(props, 'historyRetry');
      return React.createElement('button', {
        type: 'button',
        disabled: retrying,
        onClick: () => {
          setRetrying(true);
          setHistoryError(false);
          void (async () => {
            try {
              await session.loadOlder();
            } catch {
              setHistoryError(true);
            } finally {
              setRetrying(false);
            }
          })();
        },
        style: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          padding: '3px 8px',
          fontSize: 12,
          cursor: retrying ? 'default' : 'pointer',
        },
      }, label);
    }

    const inject = ['slots', 'locale', 'sessions'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, copy), 'dsh-hub-plugin: browser card dictionaries');
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SETTINGS_KEY,
        locale: LOCALE_NS,
      }, DshHubSettingsCard));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-hub-history-autoload',
        order: 100,
        inject: (sessionId) => ({
          session: ctx.sessions?.binding?.(sessionId)?.session ?? null,
        }),
      }, HistoryAutoLoadController));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.SETTINGS_KEY = SETTINGS_KEY;
    exports.STATUS_ENDPOINT = STATUS_ENDPOINT;
    exports.HISTORY_AUTOLOAD_THRESHOLD_PX = HISTORY_AUTOLOAD_THRESHOLD_PX;
    exports.HistoryAutoLoadController = HistoryAutoLoadController;
    exports.createHistoryAutoLoadController = createHistoryAutoLoadController;
    exports.findHistoryScrollports = findHistoryScrollports;
    exports.historyAutoLoadEnabledForBrowser = historyAutoLoadEnabledForBrowser;
    exports.resolveHistoryAutoLoadEnabled = resolveHistoryAutoLoadEnabled;
    exports.shouldAutoLoadHistory = shouldAutoLoadHistory;
    return module.exports;
  },
});

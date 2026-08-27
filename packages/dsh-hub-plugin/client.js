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
    const LIVE_STATUS_POLL_MS = 15000;

    const copy = {
      zh: {
        title: 'dsh-hub 远程访问',
        description: '插件模式连接中心的只读状态与诊断卡片。',
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
        boundaryA: 'plugin tunnel 使用 delivery=plugin，并复用 dsh-hub v1.1 协议。',
        boundaryB: 'registry key 和 replacement grant 只作为一次性输入；browser card 不读取或保存秘密。',
        boundaryC: '目录选择器使用显式 remote-capabilities overlay；同一 overlay 会让 canOpenPath=false 以隐藏/禁用相关 UI，但不拦截 direct host.openPath RPC。',
      },
      en: {
        title: 'dsh-hub remote access',
        description: 'Read-only status and diagnostics card for plugin-mode hub connectivity.',
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
        boundaryA: 'The plugin tunnel uses delivery=plugin and reuses dsh-hub protocol v1.1.',
        boundaryB: 'Registry key and replacement grant are one-shot inputs; the browser card does not read or store secrets.',
        boundaryC: 'Directory picker uses the explicit remote-capabilities overlay; the same overlay makes canOpenPath=false for UI gating but does not intercept direct host.openPath RPC.',
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

    function mappingText(view, props) {
      const mapping = view?.diagnostics?.workspaceMapping;
      if (!mapping) return translate(props, 'statusFallback');
      return `sessions=${textValue(mapping.sessionCount)}, workspaces=${textValue(mapping.workspaceCount)}, linked=${textValue(mapping.linkedSessionCount)}, unlinked=${textValue(mapping.unlinkedSessionCount)}, stale=${textValue(mapping.staleWorkspaceSessionCount)}`;
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
        React.createElement(
          'ul',
          { style: { margin: 0, paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } },
          row(translate(props, 'boundaryA')),
          row(translate(props, 'boundaryB')),
          row(translate(props, 'boundaryC')),
        ),
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, copy), 'dsh-hub-plugin: browser card dictionaries');
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SETTINGS_KEY,
        locale: LOCALE_NS,
      }, DshHubSettingsCard));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.SETTINGS_KEY = SETTINGS_KEY;
    exports.STATUS_ENDPOINT = STATUS_ENDPOINT;
    return module.exports;
  },
});

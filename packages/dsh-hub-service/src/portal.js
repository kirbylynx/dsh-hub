export function portalHtml({ nonce }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-hub portal</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  header { display:flex; align-items:center; justify-content:space-between; padding: 12px 20px; background:#1e293b; border-bottom:1px solid #334155; }
  header h1 { font-size: 18px; margin: 0; }
  .subtitle { font-weight:400; color:#64748b; font-size:13px; }
  .user { color:#94a3b8; font-size: 13px; }
  main { max-width: 1080px; margin: 24px auto; padding: 0 20px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius: 10px; padding: 16px 18px; margin-bottom: 20px; }
  .card h2 { margin: 0 0 12px; font-size: 15px; color:#93c5fd; display:flex; gap:10px; align-items:center; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align:left; padding: 8px 10px; border-bottom:1px solid #334155; vertical-align: top; }
  th { color:#94a3b8; font-weight:600; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.online { background:#052e16; color:#4ade80; border:1px solid #166534; }
  .badge.offline { background:#450a0a; color:#f87171; border:1px solid #7f1d1d; }
  .badge.delivery { background:#172554; color:#93c5fd; border:1px solid #1e40af; }
  .badge.dsh { background:#1c1917; color:#fbbf24; border:1px solid #44403c; }
  button { background:#2563eb; color:#fff; border:0; border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  button.secondary { background:#334155; }
  input { background:#0f172a; border:1px solid #334155; color:#e2e8f0; border-radius:6px; padding:6px 10px; font-size:13px; }
  .namespace-input { width:280px; }
  .key { font-family: ui-monospace, monospace; color:#fbbf24; word-break: break-all; }
  .hint { color:#94a3b8; font-size:12px; margin-top:8px; }
  .empty { color:#94a3b8; font-size:13px; padding: 12px 0; }
  .hidden { display:none; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; }
  #diagnosticsPanel pre { white-space:pre-wrap; word-break:break-word; background:#020617; border:1px solid #1e293b; border-radius:8px; padding:12px; color:#cbd5e1; font-size:12px; }
  .recommendations { margin: 10px 0 0; padding-left: 18px; color:#cbd5e1; }
  #modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:10; }
  #modal.open { display:block; }
  #modal .frame { position:absolute; inset: 4% 8%; background:#fff; border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  #modal iframe { flex:1; width:100%; border:0; background:#fff; }
  #modal .bar { display:flex; align-items:center; justify-content:space-between; background:#1e293b; padding:8px 14px; color:#e2e8f0; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>dsh-hub <span class="subtitle">— 多租户远程接入/控制中心</span></h1>
  <span class="user" id="user"></span>
</header>
<main>
  <div class="card">
    <h2>创建 namespace</h2>
    <input id="nsName" class="namespace-input" placeholder="namespace 名称，如 my-team" />
    <button id="createNamespaceButton" type="button">创建并获取 registry key</button>
    <div class="hint">registry key 用于实例「入伙」注册（namespace 级，可共享；如需轮换/吊销请见 API 文档）。</div>
    <div id="newKey" class="key hidden"></div>
  </div>
  <div class="card">
    <h2>实例 <span id="count" class="subtitle"></span></h2>
    <div id="instances"><div class="empty">加载中…</div></div>
  </div>
  <div id="diagnosticsPanel" class="card hidden">
    <h2>远程兼容诊断 <span id="diagnosticsTitle" class="subtitle"></span></h2>
    <div id="diagnosticsBody" class="empty">尚未运行诊断。</div>
  </div>
</main>

<div id="modal">
  <div class="frame">
    <div class="bar"><span id="modalTitle"></span><button id="closeModalButton" class="secondary" type="button">关闭</button></div>
    <iframe id="modalFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe>
  </div>
</div>

<script nonce="${nonce}">
let PORTAL = null;

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || body.error || r.statusText);
  }
  if (r.status === 204) return null;
  return r.json();
}

function randomIdempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function namespaceIdempotencyKey(name) {
  const storageKey = 'dsh-hub:namespace-create';
  const pending = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (pending?.name === name && pending?.key) return pending.key;
  const key = randomIdempotencyKey();
  localStorage.setItem(storageKey, JSON.stringify({ name, key }));
  return key;
}

function instanceUrl(id) {
  const u = PORTAL.instanceUrl;
  return u.scheme + '://' + id + '.' + u.baseDomain + (u.port ? ':' + u.port : '') + '/';
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function text(tag, value, className = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = value;
  return el;
}

function badge(label, className) {
  return text('span', label, 'badge ' + className);
}

function setEmpty(message) {
  const root = document.getElementById('instances');
  clearNode(root);
  root.appendChild(text('div', message, 'empty'));
}

async function load() {
  try {
    PORTAL = await api('/api/portal');
  } catch (e) {
    setEmpty('未认证或中心不可用：' + e.message);
    return;
  }
  document.getElementById('user').textContent = 'user: ' + PORTAL.user;
  const list = PORTAL.instances || [];
  document.getElementById('count').textContent = list.length ? '(' + list.length + ')' : '';
  if (!list.length) {
    setEmpty('暂无实例。在本机运行 dsh-hub-client join / run 后刷新。');
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of ['实例', 'namespace', 'delivery', '主机', 'DSH 版本', '状态', '操作']) {
    headRow.appendChild(text('th', name));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const i of list) {
    const row = document.createElement('tr');
    const online = i.connectionState === 'online';
    row.appendChild(text('td', i.instanceId, 'key'));
    row.appendChild(text('td', i.namespaceName || i.namespace_name || '-'));
    const deliveryCell = document.createElement('td');
    deliveryCell.appendChild(badge(i.delivery || '-', 'delivery'));
    row.appendChild(deliveryCell);
    row.appendChild(text('td', i.hostname || '-'));
    row.appendChild(text('td', i.dshVersion || i.dsh_version || '-'));
    const statusCell = document.createElement('td');
    statusCell.appendChild(badge(online ? '在线' : '离线', online ? 'online' : 'offline'));
    if (i.dshHealth) {
      statusCell.appendChild(document.createTextNode(' '));
      statusCell.appendChild(badge(i.dshHealth.lastReportedOnline ? 'DSH 在线' : 'DSH 离线', 'dsh'));
      if (i.dshHealth.freshness === 'stale') {
        statusCell.appendChild(document.createTextNode(' '));
        statusCell.appendChild(badge('stale', 'offline'));
      }
    }
    row.appendChild(statusCell);
    const actions = document.createElement('td');
    actions.className = 'actions';
    const iframeButton = document.createElement('button');
    iframeButton.type = 'button';
    iframeButton.textContent = 'iframe';
    iframeButton.addEventListener('click', () => openIframe(i.instanceId, i.namespaceName || i.namespace_name || '-'));
    actions.appendChild(iframeButton);
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'secondary';
    openButton.textContent = '新窗口';
    openButton.addEventListener('click', () => window.open(instanceUrl(i.instanceId)));
    actions.appendChild(openButton);
    const diagButton = document.createElement('button');
    diagButton.type = 'button';
    diagButton.className = 'secondary';
    diagButton.textContent = '诊断';
    diagButton.addEventListener('click', () => showDiagnostics(i.instanceId, i.namespaceName || i.namespace_name || '-'));
    actions.appendChild(diagButton);
    row.appendChild(actions);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  const root = document.getElementById('instances');
  clearNode(root);
  root.appendChild(table);
}

async function createNamespace() {
  const name = document.getElementById('nsName').value.trim();
  if (!name) return alert('请输入 namespace 名称');
  try {
    const r = await api('/api/namespaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': namespaceIdempotencyKey(name),
        'X-CSRF-Token': PORTAL.csrfToken,
      },
      body: JSON.stringify({ name }),
    });
    localStorage.removeItem('dsh-hub:namespace-create');
    const el = document.getElementById('newKey');
    el.classList.remove('hidden');
    el.textContent = 'registry key: ' + r.registryKey;
    load();
  } catch (e) { alert(e.message); }
}

async function showDiagnostics(id, ns) {
  const panel = document.getElementById('diagnosticsPanel');
  const body = document.getElementById('diagnosticsBody');
  panel.classList.remove('hidden');
  document.getElementById('diagnosticsTitle').textContent = ns + ' / ' + id;
  clearNode(body);
  body.className = 'empty';
  body.textContent = '诊断中…';
  try {
    const result = await api('/api/instances/' + encodeURIComponent(id) + '/diagnostics?refresh=1');
    renderDiagnostics(body, result);
  } catch (e) {
    body.className = 'empty';
    body.textContent = '诊断失败：' + e.message;
  }
}

function renderDiagnostics(root, result) {
  clearNode(root);
  root.className = '';
  const lines = [
    'checkedAt: ' + result.checkedAt,
    'connection: ' + result.relay.connectionState + ', activeRelaySessions=' + result.relay.activeRelaySessions + ', dshOnline=' + result.relay.dshOnline,
    'session.list: ok=' + result.dshApi.sessionList.ok + ', status=' + result.dshApi.sessionList.status + ', items=' + result.dshApi.sessionList.itemCount,
    'workspace.list: ok=' + result.dshApi.workspaceList.ok + ', status=' + result.dshApi.workspaceList.status + ', items=' + result.dshApi.workspaceList.itemCount,
    'workspace mapping: sessions=' + result.workspaceMapping.sessionCount + ', workspaces=' + result.workspaceMapping.workspaceCount + ', linked=' + result.workspaceMapping.linkedSessionCount + ', unlinked=' + result.workspaceMapping.unlinkedSessionCount + ', stale=' + result.workspaceMapping.staleWorkspaceSessionCount,
    'events.mux: opened=' + result.websocket.eventsMux.opened + ', messages=' + result.websocket.eventsMux.messages + ', idle=' + result.websocket.eventsMux.idle + ', error=' + (result.websocket.eventsMux.error || '-'),
    'events.host: opened=' + result.websocket.eventsHost.opened + ', messages=' + result.websocket.eventsHost.messages + ', idle=' + result.websocket.eventsHost.idle + ', error=' + (result.websocket.eventsHost.error || '-'),
    'directory picker: ' + result.hostCapabilities.inferredDirectoryPicker + (result.hostCapabilities.remoteLimited ? ' (remote-limited)' : ''),
  ];
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\\n');
  root.appendChild(pre);
  const recs = Array.isArray(result.recommendations) ? result.recommendations : [];
  if (recs.length) {
    const title = text('div', '建议处置：', 'hint');
    root.appendChild(title);
    const list = document.createElement('ul');
    list.className = 'recommendations';
    for (const rec of recs) {
      const item = document.createElement('li');
      item.textContent = '[' + rec.severity + '] ' + rec.code + ' — ' + rec.message;
      list.appendChild(item);
    }
    root.appendChild(list);
  }
}

function openIframe(id, ns) {
  document.getElementById('modalTitle').textContent = ns + ' / ' + id;
  document.getElementById('modalFrame').src = instanceUrl(id);
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.getElementById('modalFrame').src = 'about:blank';
}

document.getElementById('createNamespaceButton').addEventListener('click', createNamespace);
document.getElementById('closeModalButton').addEventListener('click', closeModal);
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}

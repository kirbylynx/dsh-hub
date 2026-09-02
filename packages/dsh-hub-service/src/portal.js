export function portalHtml({ nonce }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-hub portal</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin:0; background:#0f172a; color:#e2e8f0; }
  header { height:52px; display:flex; align-items:center; justify-content:space-between; padding:0 20px; background:#1e293b; border-bottom:1px solid #334155; }
  header h1 { font-size:18px; margin:0; }
  .subtitle { font-weight:400; color:#94a3b8; font-size:13px; }
  .layout { display:grid; grid-template-columns:220px 1fr; min-height:calc(100vh - 53px); }
  nav { background:#111827; border-right:1px solid #334155; padding:16px 12px; }
  nav button { width:100%; margin-bottom:8px; text-align:left; background:transparent; border:1px solid transparent; }
  nav button.active { background:#1e293b; border-color:#334155; }
  main { max-width:1180px; width:100%; box-sizing:border-box; padding:24px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius:10px; padding:16px 18px; margin-bottom:20px; }
  .card h2 { margin:0 0 12px; font-size:15px; color:#93c5fd; display:flex; gap:10px; align-items:center; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #334155; vertical-align:top; }
  th { color:#94a3b8; font-weight:600; }
  label { display:block; margin:8px 0 4px; color:#cbd5e1; font-size:12px; }
  input, select { background:#0f172a; border:1px solid #334155; color:#e2e8f0; border-radius:6px; padding:6px 10px; font-size:13px; }
  button { background:#2563eb; color:#fff; border:0; border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  button.secondary { background:#334155; }
  button.danger { background:#991b1b; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .row { display:flex; gap:10px; align-items:end; flex-wrap:wrap; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .badge.online { background:#052e16; color:#4ade80; border:1px solid #166534; }
  .badge.offline { background:#450a0a; color:#f87171; border:1px solid #7f1d1d; }
  .badge.delivery { background:#172554; color:#93c5fd; border:1px solid #1e40af; }
  .badge.dsh { background:#1c1917; color:#fbbf24; border:1px solid #44403c; }
  .key { font-family:ui-monospace, monospace; color:#fbbf24; word-break:break-all; }
  .hint, .user { color:#94a3b8; font-size:12px; }
  .empty { color:#94a3b8; font-size:13px; padding:12px 0; }
  .hidden { display:none; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; }
  #diagnosticsPanel pre { white-space:pre-wrap; word-break:break-word; background:#020617; border:1px solid #1e293b; border-radius:8px; padding:12px; color:#cbd5e1; font-size:12px; }
  .recommendations { margin:10px 0 0; padding-left:18px; color:#cbd5e1; }
  #modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:10; }
  #modal.open { display:block; }
  #modal .frame { position:absolute; inset:4% 8%; background:#fff; border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  #modal iframe { flex:1; width:100%; border:0; background:#fff; }
  #modal .bar { display:flex; align-items:center; justify-content:space-between; background:#1e293b; padding:8px 14px; color:#e2e8f0; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>dsh-hub <span class="subtitle">— 多用户远程接入/控制中心</span></h1>
  <span class="user" id="user"></span>
</header>
<div class="layout">
  <nav id="nav"></nav>
  <main>
    <section id="view-instances"></section>
    <section id="view-namespaces" class="hidden"></section>
    <section id="view-users" class="hidden"></section>
  </main>
</div>

<div id="modal">
  <div class="frame">
    <div class="bar"><span id="modalTitle"></span><button id="closeModalButton" class="secondary" type="button">关闭</button></div>
    <iframe id="modalFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe>
  </div>
</div>

<script nonce="${nonce}">
let PORTAL = null;
let CURRENT_VIEW = 'instances';

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || body.error || r.statusText);
  }
  if (r.status === 204) return null;
  return r.json();
}

function postJson(url, body, extraHeaders = {}) {
  return api(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-CSRF-Token': PORTAL.csrfToken, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function patchJson(url, body) {
  return api(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'X-CSRF-Token': PORTAL.csrfToken },
    body: JSON.stringify(body),
  });
}

function deleteJson(url) {
  return api(url, { method: 'DELETE', headers: { 'X-CSRF-Token': PORTAL.csrfToken } });
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

function el(tag, textValue = null, className = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== null) node.textContent = textValue;
  return node;
}

function badge(label, className) {
  return el('span', label, 'badge ' + className);
}

function button(label, className, onClick) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function select(options, value) {
  const node = document.createElement('select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option;
    item.textContent = option;
    if (option === value) item.selected = true;
    node.appendChild(item);
  }
  return node;
}

function table(headers, rows) {
  const tableNode = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of headers) headRow.appendChild(el('th', name));
  thead.appendChild(headRow);
  tableNode.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const row = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell ?? '';
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  tableNode.appendChild(tbody);
  return tableNode;
}

function switchView(view) {
  CURRENT_VIEW = view;
  for (const id of ['instances', 'namespaces', 'users']) {
    document.getElementById('view-' + id).classList.toggle('hidden', id !== view);
  }
  for (const node of document.querySelectorAll('nav button')) {
    node.classList.toggle('active', node.dataset.view === view);
  }
}

function navButton(label, view) {
  const node = button(label, null, () => switchView(view));
  node.dataset.view = view;
  return node;
}

function renderNav() {
  const nav = document.getElementById('nav');
  clearNode(nav);
  nav.appendChild(navButton('实例', 'instances'));
  nav.appendChild(navButton('Namespaces', 'namespaces'));
  if (PORTAL.me?.capabilities?.canListUsers) nav.appendChild(navButton('用户', 'users'));
  if (PORTAL.authLogoutUrl) {
    const logout = document.createElement('a');
    logout.href = PORTAL.authLogoutUrl;
    logout.textContent = '退出登录';
    logout.className = 'hint';
    nav.appendChild(logout);
  }
}

async function load() {
  try {
    PORTAL = await api('/api/portal');
  } catch (e) {
    const root = document.getElementById('view-instances');
    clearNode(root);
    root.appendChild(el('div', '未认证或中心不可用：' + e.message, 'empty'));
    return;
  }
  document.getElementById('user').textContent = 'user: ' + PORTAL.user + (PORTAL.me?.systemAdmin ? ' · system admin' : '');
  renderNav();
  renderInstances();
  renderNamespaces();
  if (PORTAL.me?.capabilities?.canListUsers) await renderUsers();
  switchView(CURRENT_VIEW);
}

function renderInstances() {
  const root = document.getElementById('view-instances');
  clearNode(root);
  const card = el('div', null, 'card');
  card.appendChild(el('h2', '实例 ' + ((PORTAL.instances || []).length ? '(' + PORTAL.instances.length + ')' : '')));
  const list = PORTAL.instances || [];
  if (!list.length) {
    card.appendChild(el('div', '暂无实例。在本机运行 dsh-hub-client join / run 后刷新。', 'empty'));
    root.appendChild(card);
    return;
  }
  const rows = list.map((i) => {
    const state = document.createElement('div');
    state.appendChild(badge(i.connectionState === 'online' ? '在线' : '离线', i.connectionState === 'online' ? 'online' : 'offline'));
    if (i.dshHealth) {
      state.appendChild(document.createTextNode(' '));
      state.appendChild(badge(i.dshHealth.lastReportedOnline ? 'DSH 在线' : 'DSH 离线', 'dsh'));
      if (i.dshHealth.freshness === 'stale') {
        state.appendChild(document.createTextNode(' '));
        state.appendChild(badge('stale', 'offline'));
      }
    }
    const actions = el('div', null, 'actions');
    const iframe = button('iframe', null, () => openIframe(i.instanceId, i.namespaceName || '-'));
    iframe.disabled = i.canOpen === false;
    actions.appendChild(iframe);
    const open = button('新窗口', 'secondary', () => window.open(instanceUrl(i.instanceId)));
    open.disabled = i.canOpen === false;
    actions.appendChild(open);
    actions.appendChild(button('诊断', 'secondary', () => showDiagnostics(i.instanceId, i.namespaceName || '-')));
    return [
      keyText(i.instanceId),
      i.namespaceName || '-',
      i.role || '-',
      badge(i.delivery || '-', 'delivery'),
      badge(i.deploymentMode || 'unknown', 'delivery'),
      i.hostname || '-',
      i.dshVersion || '-',
      state,
      actions,
    ];
  });
  card.appendChild(table(['实例', 'namespace', '角色', 'delivery', 'mode', '主机', 'DSH 版本', '状态', '操作'], rows));
  root.appendChild(card);
  const diag = el('div', null, 'card hidden');
  diag.id = 'diagnosticsPanel';
  diag.appendChild(el('h2', '远程兼容诊断'));
  const body = el('div', '尚未运行诊断。', 'empty');
  body.id = 'diagnosticsBody';
  diag.appendChild(body);
  root.appendChild(diag);
}

function keyText(value) {
  return el('span', value, 'key');
}

function renderNamespaces() {
  const root = document.getElementById('view-namespaces');
  clearNode(root);
  const createCard = el('div', null, 'card');
  createCard.appendChild(el('h2', '创建 namespace'));
  if (PORTAL.me?.capabilities?.canCreateNamespace) {
    const row = el('div', null, 'row');
    const wrap = document.createElement('div');
    wrap.appendChild(el('label', 'namespace 名称'));
    const input = document.createElement('input');
    input.id = 'nsName';
    input.placeholder = 'my-team';
    wrap.appendChild(input);
    row.appendChild(wrap);
    row.appendChild(button('创建并获取 registry key', null, createNamespace));
    createCard.appendChild(row);
    createCard.appendChild(el('div', 'registry key 用于实例入伙注册；更新 registry key 不影响已获得 instance token 的实例。', 'hint'));
    const key = el('div', null, 'key hidden');
    key.id = 'newKey';
    createCard.appendChild(key);
  } else {
    createCard.appendChild(el('div', '当前用户无创建 namespace 权限。', 'empty'));
  }
  root.appendChild(createCard);

  const listCard = el('div', null, 'card');
  listCard.appendChild(el('h2', 'Namespaces'));
  const namespaces = PORTAL.namespaces || [];
  if (!namespaces.length) {
    listCard.appendChild(el('div', '暂无 namespace。', 'empty'));
  } else {
    listCard.appendChild(table(['名称', 'ID', '角色', 'registry key', '操作'], namespaces.map((n) => {
      const actions = el('div', null, 'actions');
      actions.appendChild(button('成员', 'secondary', () => loadMembers(n.namespaceId, n.name)));
      actions.appendChild(button('邀请', 'secondary', () => loadInvites(n.namespaceId, n.name)));
      return [
        n.name,
        keyText(n.namespaceId),
        n.role || '-',
        n.registryKey?.prefix ? n.registryKey.prefix + '… v' + n.registryKey.version : '-',
        actions,
      ];
    })));
  }
  root.appendChild(listCard);
  const detail = el('div', null, 'card hidden');
  detail.id = 'namespaceDetail';
  root.appendChild(detail);
}

async function createNamespace() {
  const input = document.getElementById('nsName');
  const name = input.value.trim();
  if (!name) return alert('请输入 namespace 名称');
  try {
    const r = await postJson('/api/namespaces', { name }, { 'Idempotency-Key': namespaceIdempotencyKey(name) });
    localStorage.removeItem('dsh-hub:namespace-create');
    const out = document.getElementById('newKey');
    out.classList.remove('hidden');
    out.textContent = 'registry key: ' + r.registryKey;
    await load();
  } catch (e) {
    alert(e.message);
  }
}

async function loadMembers(namespaceId, name) {
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  detail.appendChild(el('h2', '成员 · ' + name));
  try {
    const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members');
    const addRow = el('div', null, 'row');
    const username = document.createElement('input');
    username.placeholder = 'username';
    const role = select(['viewer', 'member', 'namespace_admin'], 'member');
    addRow.appendChild(username);
    addRow.appendChild(role);
    addRow.appendChild(button('添加已有用户', null, async () => {
      await postJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members', { username: username.value.trim(), role: role.value });
      await loadMembers(namespaceId, name);
    }));
    detail.appendChild(addRow);
    detail.appendChild(table(['用户', '角色', '状态', '操作'], data.members.map((m) => {
      const roleSelect = select(['viewer', 'member', 'namespace_admin'], m.role);
      const actions = el('div', null, 'actions');
      actions.appendChild(button('保存角色', 'secondary', async () => {
        await patchJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members/' + encodeURIComponent(m.userId), { role: roleSelect.value });
        await loadMembers(namespaceId, name);
      }));
      actions.appendChild(button('移除', 'danger', async () => {
        await deleteJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members/' + encodeURIComponent(m.userId));
        await loadMembers(namespaceId, name);
      }));
      return [m.username, roleSelect, m.status + ' / ' + m.userStatus, actions];
    })));
  } catch (e) {
    detail.appendChild(el('div', '加载成员失败：' + e.message, 'empty'));
  }
}

async function loadInvites(namespaceId, name) {
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  detail.appendChild(el('h2', '邀请 · ' + name));
  try {
    const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId) + '/invites');
    const createRow = el('div', null, 'row');
    const role = select(['viewer', 'member', 'namespace_admin'], 'member');
    const email = document.createElement('input');
    email.placeholder = 'email hint';
    createRow.appendChild(role);
    createRow.appendChild(email);
    createRow.appendChild(button('创建邀请', null, async () => {
      const result = await postJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/invites', { role: role.value, emailHint: email.value.trim() });
      alert('邀请链接：' + location.origin + '/invite/' + result.invite.token);
      await loadInvites(namespaceId, name);
    }));
    detail.appendChild(createRow);
    detail.appendChild(table(['角色', '状态', '邮箱提示', '过期时间', '操作'], data.invites.map((i) => {
      const actions = el('div', null, 'actions');
      if (i.status === 'active') {
        actions.appendChild(button('撤销', 'danger', async () => {
          await postJson('/api/invites/' + encodeURIComponent(i.inviteId) + '/revoke', {});
          await loadInvites(namespaceId, name);
        }));
      }
      return [i.role, i.status, i.emailHint || '-', i.expiresAt || '-', actions];
    })));
  } catch (e) {
    detail.appendChild(el('div', '加载邀请失败：' + e.message, 'empty'));
  }
}

async function renderUsers() {
  const root = document.getElementById('view-users');
  clearNode(root);
  const card = el('div', null, 'card');
  card.appendChild(el('h2', '用户'));
  try {
    const data = await api('/api/system/users');
    card.appendChild(table(['用户', '显示名', '状态', '系统管理员', '操作'], data.users.map((u) => {
      const actions = el('div', null, 'actions');
      if (u.status === 'active') {
        actions.appendChild(button('禁用', 'danger', async () => {
          await postJson('/api/system/users/' + encodeURIComponent(u.userId) + '/disable', { reason: 'portal action' });
          await renderUsers();
        }));
      } else {
        actions.appendChild(button('恢复', null, async () => {
          await postJson('/api/system/users/' + encodeURIComponent(u.userId) + '/restore', { reason: 'portal action' });
          await renderUsers();
        }));
      }
      return [u.username, u.displayName || '-', u.status, u.systemAdmin ? 'yes' : 'no', actions];
    })));
  } catch (e) {
    card.appendChild(el('div', '加载用户失败：' + e.message, 'empty'));
  }
  root.appendChild(card);
}

async function showDiagnostics(id, ns) {
  const panel = document.getElementById('diagnosticsPanel');
  const body = document.getElementById('diagnosticsBody');
  panel.classList.remove('hidden');
  clearNode(body);
  body.className = 'empty';
  body.textContent = '诊断中… ' + ns + ' / ' + id;
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
    root.appendChild(el('div', '建议处置：', 'hint'));
    const ul = document.createElement('ul');
    ul.className = 'recommendations';
    for (const rec of recs) {
      const li = document.createElement('li');
      li.textContent = rec.code + ': ' + rec.message;
      ul.appendChild(li);
    }
    root.appendChild(ul);
  }
}

function openIframe(id, namespaceName) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = namespaceName + ' / ' + id;
  document.getElementById('modalFrame').src = instanceUrl(id);
  modal.classList.add('open');
}

document.getElementById('closeModalButton').addEventListener('click', () => {
  document.getElementById('modalFrame').src = 'about:blank';
  document.getElementById('modal').classList.remove('open');
});
load();
</script>
</body>
</html>`;
}

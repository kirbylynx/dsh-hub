export const portalUiScript = String.raw`
let PORTAL = null;
let CURRENT_VIEW = 'dashboard';
const STATE = {
  selectedNamespaceId: null,
  selectedInstanceId: null,
  revealedKeys: new Map(),
  pages: {
    namespaces: { items: [], nextCursor: null, cursors: [], limit: 50, filters: { q: '', scope: '', owner: '' } },
    instances: { items: [], nextCursor: null, cursors: [], limit: 50, filters: { q: '', namespace: '', mode: '', status: '', delivery: '', connection: '' } },
    users: { items: [], nextCursor: null, cursors: [], limit: 50, loaded: false, filters: { q: '', status: '', systemAdmin: '' } },
    audit: { items: [], nextCursor: null, cursors: [], limit: 200, loaded: false, filters: { q: '', namespace: '', actor: '', action: '', result: '', from: '', to: '' } },
  },
};

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, textValue, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined && textValue !== null) node.textContent = textValue;
  return node;
}

function badge(label, className) {
  return el('span', label, 'badge ' + (className || ''));
}

function button(label, className, onClick) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', function (event) {
    try {
      Promise.resolve(onClick(event)).catch(function (error) {
        alert('操作失败：' + error.message);
      });
    } catch (error) {
      alert('操作失败：' + error.message);
    }
  });
  return node;
}

function input(value, placeholder) {
  const node = document.createElement('input');
  node.value = value || '';
  node.placeholder = placeholder || '';
  return node;
}

function dateTimeInput(value) {
  const node = input(value, '');
  node.type = 'datetime-local';
  return node;
}

function textarea(value, placeholder) {
  const node = document.createElement('textarea');
  node.value = value || '';
  node.placeholder = placeholder || '';
  return node;
}

function select(options, value) {
  const node = document.createElement('select');
  options.forEach(function (option) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    if (option.value === value) item.selected = true;
    node.appendChild(item);
  });
  return node;
}

function field(labelText, control) {
  const wrap = el('div');
  wrap.appendChild(el('label', labelText));
  wrap.appendChild(control);
  return wrap;
}

function table(headers, rows) {
  const tableNode = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach(function (name) { headRow.appendChild(el('th', name)); });
  thead.appendChild(headRow);
  tableNode.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(function (cells) {
    const row = document.createElement('tr');
    cells.forEach(function (cell) {
      const td = document.createElement('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell == null ? '' : String(cell);
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  tableNode.appendChild(tbody);
  return tableNode;
}

function surface(title, description) {
  const node = el('div', null, 'surface');
  const head = el('div', null, 'surface-head');
  const text = el('div');
  text.appendChild(el('h2', title));
  if (description) text.appendChild(el('p', description));
  head.appendChild(text);
  node.appendChild(head);
  const body = el('div', null, 'surface-body');
  node.appendChild(body);
  return { node: node, head: head, body: body };
}

function switchView(view) {
  CURRENT_VIEW = view;
  ['dashboard', 'namespaces', 'instances', 'users', 'audit'].forEach(function (id) {
    const section = document.getElementById('view-' + id);
    if (section) section.classList.toggle('hidden', id !== view);
  });
  document.querySelectorAll('nav button').forEach(function (node) {
    node.classList.toggle('active', node.dataset.view === view);
  });
  renderCurrentView();
}

function navButton(label, view) {
  const node = button(label, null, function () { switchView(view); });
  node.dataset.view = view;
  return node;
}

function renderNav() {
  const nav = document.getElementById('nav');
  clearNode(nav);
  nav.appendChild(navButton('Dashboard', 'dashboard'));
  nav.appendChild(navButton('Namespaces', 'namespaces'));
  nav.appendChild(navButton('Instances', 'instances'));
  if (PORTAL.me && PORTAL.me.capabilities && PORTAL.me.capabilities.canListUsers) nav.appendChild(navButton('Users', 'users'));
  if (PORTAL.me && PORTAL.me.capabilities && PORTAL.me.capabilities.canViewGlobalAudit) nav.appendChild(navButton('Audit', 'audit'));
  if (PORTAL.authLogoutUrl) {
    const logout = document.createElement('a');
    logout.href = PORTAL.authLogoutUrl;
    logout.textContent = '退出登录';
    nav.appendChild(logout);
  }
}

function meCapabilities() {
  return (PORTAL && PORTAL.me && PORTAL.me.capabilities) || {};
}

function namespaceCapabilities(namespace) {
  return namespace.capabilities || {};
}

function instanceCapabilities(instance) {
  return instance.capabilities || {
    canOpen: instance.canOpen !== false,
    canViewDiagnostics: true,
    canIssueReplacementGrant: false,
    canRevoke: false,
    canRecover: false,
  };
}

async function load() {
  try {
    PORTAL = await api('/api/portal');
  } catch (error) {
    const root = document.getElementById('view-dashboard');
    clearNode(root);
    root.appendChild(el('div', '未认证或中心不可用：' + error.message, 'empty'));
    return;
  }
  STATE.pages.namespaces.items = PORTAL.namespaces || [];
  STATE.pages.namespaces.nextCursor = PORTAL.namespaceNextCursor || null;
  STATE.pages.instances.items = PORTAL.instances || [];
  STATE.pages.instances.nextCursor = PORTAL.instanceNextCursor || null;
  document.getElementById('user').textContent = 'user: ' + PORTAL.user + (PORTAL.me.systemAdmin ? ' · system admin' : '');
  renderNav();
  switchView(CURRENT_VIEW);
}

function renderCurrentView() {
  if (!PORTAL) return;
  if (CURRENT_VIEW === 'dashboard') renderDashboard();
  if (CURRENT_VIEW === 'namespaces') renderNamespaces();
  if (CURRENT_VIEW === 'instances') renderInstances();
  if (CURRENT_VIEW === 'users') renderUsers();
  if (CURRENT_VIEW === 'audit') renderAudit();
}

function renderDashboard() {
  const root = document.getElementById('view-dashboard');
  clearNode(root);
  const pane = surface('Dashboard', '当前用户可访问范围内的首屏 namespace、实例和管理能力摘要。');
  const grid = el('div', null, 'grid');
  grid.appendChild(metric('首屏 Namespaces', String(STATE.pages.namespaces.items.length) + (STATE.pages.namespaces.nextCursor ? '+' : '')));
  grid.appendChild(metric('首屏 Instances', String(STATE.pages.instances.items.length) + (STATE.pages.instances.nextCursor ? '+' : '')));
  grid.appendChild(metric('首屏在线实例', STATE.pages.instances.items.filter(function (i) { return i.connectionState === 'online'; }).length));
  grid.appendChild(metric('权限', PORTAL.me.systemAdmin ? 'system' : 'user'));
  pane.body.appendChild(grid);
  root.appendChild(pane.node);
}

function metric(label, value) {
  const node = el('div', null, 'metric');
  node.appendChild(el('strong', String(value)));
  node.appendChild(el('span', label));
  return node;
}

function renderPager(kind, reload) {
  const page = STATE.pages[kind];
  const node = el('div', null, 'pager');
  const limit = select([{ value:'50', label:'50/页' }, { value:'100', label:'100/页' }, { value:'200', label:'200/页' }], String(page.limit));
  limit.addEventListener('change', function () {
    page.limit = Number(limit.value);
    page.cursors = [];
    reload();
  });
  node.appendChild(limit);
  const prev = button('上一页', 'secondary', function () {
    page.cursors.pop();
    reload();
  });
  prev.disabled = page.cursors.length === 0;
  const next = button('下一页', 'secondary', function () {
    if (page.nextCursor) {
      page.cursors.push(page.nextCursor);
      reload();
    }
  });
  next.disabled = !page.nextCursor;
  node.appendChild(prev);
  node.appendChild(next);
  return node;
}

async function reloadNamespaces() {
  const page = STATE.pages.namespaces;
  const params = Object.assign({}, page.filters, { limit: page.limit, cursor: page.cursors[page.cursors.length - 1] || '' });
  const data = await api('/api/namespaces?' + queryString(params));
  page.items = data.namespaces || data.items || [];
  page.nextCursor = data.nextCursor || null;
  renderNamespaces();
}

async function reloadInstances() {
  const page = STATE.pages.instances;
  const params = Object.assign({}, page.filters, { limit: page.limit, cursor: page.cursors[page.cursors.length - 1] || '' });
  const data = await api('/api/instances?' + queryString(params));
  page.items = data.instances || data.items || [];
  page.nextCursor = data.nextCursor || null;
  renderInstances();
}

async function reloadUsers() {
  const page = STATE.pages.users;
  const params = Object.assign({}, page.filters, { limit: page.limit, cursor: page.cursors[page.cursors.length - 1] || '' });
  const data = await api('/api/users?' + queryString(params));
  page.items = data.users || data.items || [];
  page.nextCursor = data.nextCursor || null;
  page.loaded = true;
  renderUsers();
}

async function reloadAudit() {
  const page = STATE.pages.audit;
  const params = Object.assign({}, page.filters, {
    limit: page.limit,
    cursor: page.cursors[page.cursors.length - 1] || '',
    from: page.filters.from ? Date.parse(page.filters.from) : '',
    to: page.filters.to ? Date.parse(page.filters.to) : '',
  });
  const data = await api('/api/audit?' + queryString(params));
  page.items = data.items || [];
  page.nextCursor = data.nextCursor || null;
  page.loaded = true;
  renderAudit();
}

function renderNamespaces() {
  const root = document.getElementById('view-namespaces');
  clearNode(root);
  const create = surface('创建 namespace', 'namespace 是用户自己的 DSH 实例分组，可通过成员关系共享给其他用户。');
  if (meCapabilities().canCreateNamespace) {
    const name = input('', '例如 MacMini');
    const desc = input('', '可选描述');
    const owner = input('', 'system_admin 可填写 owner username');
    const row = el('div', null, 'toolbar');
    row.appendChild(field('名称', name));
    row.appendChild(field('描述', desc));
    if (meCapabilities().canCreateNamespaceForUser) row.appendChild(field('归属用户', owner));
    row.appendChild(button('创建并显示 registry key', null, async function () {
      if (!name.value.trim()) return alert('请输入 namespace 名称');
      const body = { name: name.value.trim() };
      if (desc.value.trim()) body.description = desc.value.trim();
      if (owner.value.trim()) body.ownerUsername = owner.value.trim();
      const result = await postJson('/api/namespaces', body, { 'Idempotency-Key': randomIdempotencyKey() });
      STATE.revealedKeys.set(result.namespaceId, result.registryKey);
      alert('namespace 已创建，registry key 已显示，可点击复制。');
      await reloadNamespaces();
      await showNamespaceDetail(result.namespaceId);
    }));
    create.body.appendChild(row);
    create.body.appendChild(el('div', 'registry key 是实例入伙凭证；更新 key 不影响已经获得 instance token 的实例。', 'hint'));
  } else {
    create.body.appendChild(el('div', '当前用户无创建 namespace 权限。', 'empty'));
  }
  root.appendChild(create.node);

  const pane = surface('Namespaces', '按归属用户、角色、实例数量和 registry key 状态管理可访问的 namespace。');
  const page = STATE.pages.namespaces;
  const q = input(page.filters.q, '搜索名称 / ID / owner');
  const scopeOptions = [
    { value:'', label:'默认范围' },
    { value:'mine', label:'我的' },
    { value:'shared', label:'共享给我的' },
  ];
  if (meCapabilities().canListUsers || meCapabilities().canCreateNamespaceForUser || PORTAL.me.systemAdmin) {
    scopeOptions.push({ value:'all', label:'全部（system）' });
  } else if (page.filters.scope === 'all') {
    page.filters.scope = '';
  }
  const scope = select(scopeOptions, page.filters.scope);
  const owner = input(page.filters.owner, 'owner username');
  const toolbar = el('div', null, 'toolbar');
  toolbar.appendChild(field('搜索', q));
  toolbar.appendChild(field('范围', scope));
  if (meCapabilities().canCreateNamespaceForUser) toolbar.appendChild(field('owner', owner));
  toolbar.appendChild(button('筛选', 'secondary', async function () {
    page.filters.q = q.value.trim();
    page.filters.scope = scope.value;
    page.filters.owner = owner.value.trim();
    page.cursors = [];
    await reloadNamespaces();
  }));
  pane.body.appendChild(toolbar);
  if (!page.items.length) {
    pane.body.appendChild(el('div', '暂无 namespace。', 'empty'));
  } else {
    pane.body.appendChild(table(['名称', '归属', '角色', '实例/成员', 'registry key', '操作'], page.items.map(namespaceRow)));
  }
  pane.body.appendChild(renderPager('namespaces', reloadNamespaces));
  root.appendChild(pane.node);

  const detail = el('div', null, 'surface hidden');
  detail.id = 'namespaceDetail';
  root.appendChild(detail);
}

function namespaceRow(n) {
  const name = el('div');
  name.appendChild(el('div', n.name));
  name.appendChild(el('div', n.shortId || n.namespaceId, 'muted mono'));
  if (n.nameConflict) name.appendChild(el('div', '同一 owner 下存在同名，请重命名修复。', 'notice'));
  const rk = el('div');
  const revealedKey = STATE.revealedKeys.get(n.namespaceId);
  rk.appendChild(el('span', revealedKey || (n.registryKey ? n.registryKey.prefix + '… v' + n.registryKey.version : '-'), 'mono'));
  if (n.registryKey && !n.registryKey.secretAvailable) rk.appendChild(el('div', '旧 key 不可展示，更新后可复制。', 'hint'));
  const actions = el('div', null, 'actions');
  actions.appendChild(button('详情', 'secondary', function () { return showNamespaceDetail(n.namespaceId); }));
  if (canRevealNamespace(n)) {
    const revealed = STATE.revealedKeys.has(n.namespaceId);
    actions.appendChild(button(revealed ? '🙈 隐藏 key' : '👁 显示 key', 'ghost', function () {
      return toggleRegistryKey(n, false);
    }));
    if (revealed) actions.appendChild(button('复制 key', 'ghost', function () { return copyRegistryKey(n); }));
  }
  if (canRotateNamespace(n)) actions.appendChild(button('更新 key', 'danger', function () { return rotateRegistryKeyUi(n); }));
  return [
    name,
    (n.ownerUsername || '-') + (n.scope ? ' · ' + n.scope : ''),
    badge(n.role || '-', n.role === 'system_admin' || n.role === 'namespace_owner' ? 'active' : ''),
    String(n.instanceCount || 0) + '（在线 ' + String(n.onlineInstanceCount || 0) + '） / ' + String(n.memberCount || 0),
    rk,
    actions,
  ];
}

function canRevealNamespace(n) {
  return namespaceCapabilities(n).canRevealRegistryKey === true;
}

function canRotateNamespace(n) {
  return namespaceCapabilities(n).canRotateRegistryKey === true;
}

function canEditNamespace(n) {
  return namespaceCapabilities(n).canEdit === true;
}

async function showNamespaceDetail(namespaceId) {
  STATE.selectedNamespaceId = namespaceId;
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId));
  const n = data.namespace;
  const head = el('div', null, 'surface-head');
  const title = el('div');
  title.appendChild(el('h2', 'Namespace · ' + n.name));
  title.appendChild(el('p', (n.ownerUsername || '-') + ' · ' + n.namespaceId));
  head.appendChild(title);
  detail.appendChild(head);
  const body = el('div', null, 'surface-body detail-grid');
  const form = el('div', null, 'stack');
  const name = input(n.name, 'namespace 名称');
  const desc = textarea(n.description || '', '描述');
  form.appendChild(field('名称', name));
  form.appendChild(field('描述', desc));
  const save = button('保存基础信息', null, async function () {
    await patchJson('/api/namespaces/' + encodeURIComponent(n.namespaceId), {
      name: name.value.trim(),
      description: desc.value.trim(),
    }, { 'Idempotency-Key': randomIdempotencyKey() });
    await reloadNamespaces();
    await showNamespaceDetail(n.namespaceId);
  });
  save.disabled = !canEditNamespace(n);
  form.appendChild(save);
  if (n.registryKey) form.appendChild(el(
    'div',
    'registry key: ' + (STATE.revealedKeys.get(n.namespaceId) || '***') + ' · prefix ' + n.registryKey.prefix + '… v' + n.registryKey.version,
    'key',
  ));
  body.appendChild(form);
  const ops = el('div', null, 'stack');
  if (canRevealNamespace(n)) {
    const keyActions = el('div', null, 'actions');
    const revealed = STATE.revealedKeys.has(n.namespaceId);
    keyActions.appendChild(button(revealed ? '🙈 隐藏 registry key' : '👁 显示 registry key', 'secondary', function () {
      return toggleRegistryKey(n, true);
    }));
    if (revealed) keyActions.appendChild(button('复制 registry key', 'secondary', function () { return copyRegistryKey(n); }));
    ops.appendChild(keyActions);
  }
  if (canRotateNamespace(n)) ops.appendChild(button('更新 registry key', 'danger', function () { return rotateRegistryKeyUi(n); }));
  const caps = namespaceCapabilities(n);
  if (caps.canManageMembers) ops.appendChild(button('成员管理', 'secondary', function () { return loadMembers(n); }));
  if (caps.canManageInvites) ops.appendChild(button('邀请管理', 'secondary', function () { return loadInvites(n); }));
  if (caps.canViewAudit) ops.appendChild(button('namespace 审计', 'secondary', function () { return loadNamespaceAudit(n.namespaceId, n.name); }));
  body.appendChild(ops);
  detail.appendChild(body);
}

function canManageNamespace(namespace) {
  const caps = namespaceCapabilities(namespace);
  return caps.canManageMembers === true || caps.canManageInvites === true || caps.canViewAudit === true;
}

async function toggleRegistryKey(n, refreshDetail) {
  if (STATE.revealedKeys.has(n.namespaceId)) {
    STATE.revealedKeys.delete(n.namespaceId);
  } else {
    const data = await postJson('/api/namespaces/' + encodeURIComponent(n.namespaceId) + '/registry-key/reveal', {});
    STATE.revealedKeys.set(n.namespaceId, data.registryKey);
  }
  if (refreshDetail) await showNamespaceDetail(n.namespaceId);
  else renderNamespaces();
}

async function copyRegistryKey(n) {
  const registryKey = STATE.revealedKeys.get(n.namespaceId);
  if (!registryKey) return alert('请先显示 registry key');
  const copied = await copyText(registryKey);
  alert(copied ? 'registry key 已复制到剪贴板。' : '浏览器未允许写入剪贴板，请手动复制已显示的 key。');
}

async function rotateRegistryKeyUi(n) {
  if (!n.registryKey) return alert('当前 namespace 没有 active registry key');
  if (!confirm('确认更新 registry key？新实例需使用新 key，已入伙实例不受影响。')) return;
  const data = await postJson('/api/namespaces/' + encodeURIComponent(n.namespaceId) + '/rotate', {
    expectedVersion: n.registryKey.version,
    reason: 'portal action',
  }, { 'Idempotency-Key': randomIdempotencyKey() });
  STATE.revealedKeys.set(n.namespaceId, data.registryKey);
  alert('新 registry key 已生成并显示，可点击复制。');
  await reloadNamespaces();
  await showNamespaceDetail(n.namespaceId);
}

async function loadMembers(namespace) {
  const namespaceId = namespace.namespaceId;
  const name = namespace.name;
  const caps = namespaceCapabilities(namespace);
  const allowedRoles = Array.isArray(caps.allowedMemberRoles) ? caps.allowedMemberRoles : [];
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  detail.appendChild(el('div', null, 'surface-head')).appendChild(el('h2', '成员 · ' + name));
  const body = el('div', null, 'surface-body');
  detail.appendChild(body);
  try {
    const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members');
    const addRow = el('div', null, 'toolbar');
    const username = input('', 'username');
    const role = select(roleOptionsFor(allowedRoles), 'member');
    addRow.appendChild(field('用户', username));
    addRow.appendChild(field('角色', role));
    addRow.appendChild(button('添加已有用户', null, async function () {
      if (!username.value.trim()) return alert('请输入准确的 username');
      if (!confirm('确认将用户 ' + username.value.trim() + ' 添加为 ' + role.value + '？')) return;
      await postJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members', { username: username.value.trim(), role: role.value });
      await loadMembers(namespace);
    }));
    body.appendChild(addRow);
    body.appendChild(table(['用户', '角色', '状态', '操作'], data.members.map(function (m) {
      const canEditMember = m.status === 'active'
        && allowedRoles.includes(m.role);
      const roleSelect = canEditMember ? select(roleOptionsFor(allowedRoles), m.role) : badge(m.role, '');
      const actions = el('div', null, 'actions');
      if (canEditMember) {
        actions.appendChild(button('保存角色', 'secondary', async function () {
          if (!confirm('确认将 ' + m.username + ' 的角色更新为 ' + roleSelect.value + '？')) return;
          await patchJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members/' + encodeURIComponent(m.userId), { role: roleSelect.value });
          await loadMembers(namespace);
        }));
        actions.appendChild(button('移除', 'danger', async function () {
          if (!confirm('确认移除成员 ' + m.username + '？')) return;
          await deleteJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/members/' + encodeURIComponent(m.userId));
          await loadMembers(namespace);
        }));
      }
      return [m.username, roleSelect, m.status + ' / ' + m.userStatus, actions];
    })));
  } catch (error) {
    body.appendChild(el('div', '加载成员失败：' + error.message, 'empty'));
  }
}

function roleOptions(includeOwner) {
  const items = [
    { value:'viewer', label:'viewer' },
    { value:'member', label:'member' },
    { value:'namespace_admin', label:'namespace_admin' },
  ];
  if (includeOwner) items.push({ value:'namespace_owner', label:'namespace_owner' });
  return items;
}

function roleOptionsFor(allowedRoles) {
  const allowed = new Set(allowedRoles && allowedRoles.length ? allowedRoles : ['viewer', 'member']);
  return roleOptions(true).filter(function (item) { return allowed.has(item.value); });
}

async function loadInvites(namespace) {
  const namespaceId = namespace.namespaceId;
  const name = namespace.name;
  const caps = namespaceCapabilities(namespace);
  const allowedInviteRoles = Array.isArray(caps.allowedInviteRoles) ? caps.allowedInviteRoles : [];
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  detail.appendChild(el('div', null, 'surface-head')).appendChild(el('h2', '邀请 · ' + name));
  const body = el('div', null, 'surface-body');
  detail.appendChild(body);
  try {
    const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId) + '/invites');
    const createRow = el('div', null, 'toolbar');
    const role = select(roleOptionsFor(allowedInviteRoles), 'member');
    const email = input('', 'email hint');
    createRow.appendChild(field('角色', role));
    createRow.appendChild(field('邮箱提示', email));
    createRow.appendChild(button('创建邀请', null, async function () {
      const result = await postJson('/api/namespaces/' + encodeURIComponent(namespaceId) + '/invites', { role: role.value, emailHint: email.value.trim() });
      alert('邀请链接：' + location.origin + '/invite/' + result.invite.token);
      await loadInvites(namespace);
    }));
    body.appendChild(createRow);
    body.appendChild(table(['角色', '状态', '邮箱提示', '过期时间', '操作'], data.invites.map(function (i) {
      const actions = el('div', null, 'actions');
      if (i.status === 'active' && allowedInviteRoles.includes(i.role)) {
        actions.appendChild(button('撤销', 'danger', async function () {
          if (!confirm('确认撤销该邀请？')) return;
          await postJson('/api/invites/' + encodeURIComponent(i.inviteId) + '/revoke', {});
          await loadInvites(namespace);
        }));
      }
      return [i.role, i.status, i.emailHint || '-', i.expiresAt || '-', actions];
    })));
  } catch (error) {
    body.appendChild(el('div', '加载邀请失败：' + error.message, 'empty'));
  }
}

async function loadNamespaceAudit(namespaceId, name) {
  const detail = document.getElementById('namespaceDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  detail.appendChild(el('div', null, 'surface-head')).appendChild(el('h2', '审计 · ' + name));
  const body = el('div', null, 'surface-body');
  detail.appendChild(body);
  try {
    const data = await api('/api/namespaces/' + encodeURIComponent(namespaceId) + '/audit?limit=50');
    body.appendChild(auditTable(data.items || []));
  } catch (error) {
    body.appendChild(el('div', '加载审计失败：' + error.message, 'empty'));
  }
}

function renderInstances() {
  const root = document.getElementById('view-instances');
  clearNode(root);
  const pane = surface('Instances', '查看实例在线状态、打开 DSH、发放 replacement grant，或吊销/恢复访问。');
  const page = STATE.pages.instances;
  const q = input(page.filters.q, '搜索实例 / installation / hostname / namespace');
  const mode = select([{ value:'', label:'全部模式' }, { value:'remote', label:'remote' }, { value:'hosted', label:'hosted' }], page.filters.mode);
  const status = select([{ value:'', label:'全部状态' }, { value:'active', label:'active' }, { value:'revoked', label:'revoked' }], page.filters.status);
  const connection = select([{ value:'', label:'全部连接' }, { value:'online', label:'online' }, { value:'offline', label:'offline' }], page.filters.connection);
  const toolbar = el('div', null, 'toolbar');
  toolbar.appendChild(field('搜索', q));
  toolbar.appendChild(field('模式', mode));
  toolbar.appendChild(field('访问', status));
  toolbar.appendChild(field('连接', connection));
  toolbar.appendChild(button('筛选', 'secondary', async function () {
    page.filters.q = q.value.trim();
    page.filters.mode = mode.value;
    page.filters.status = status.value;
    page.filters.connection = connection.value;
    page.cursors = [];
    await reloadInstances();
  }));
  pane.body.appendChild(toolbar);
  if (!page.items.length) {
    pane.body.appendChild(el('div', '暂无实例。运行 dsh-hub-client plugin-join / run 后刷新。', 'empty'));
  } else {
    pane.body.appendChild(table(['实例', 'namespace', '类型', '主机/版本', '状态', '操作'], page.items.map(instanceRow)));
  }
  pane.body.appendChild(renderPager('instances', reloadInstances));
  root.appendChild(pane.node);
  const diag = el('div', null, 'surface hidden');
  diag.id = 'diagnosticsPanel';
  const head = el('div', null, 'surface-head');
  const diagTitle = el('h2', '实例详情 / 远程兼容诊断');
  diagTitle.id = 'diagnosticsTitle';
  head.appendChild(diagTitle);
  diag.appendChild(head);
  const body = el('div', '尚未运行诊断。', 'surface-body empty');
  body.id = 'diagnosticsBody';
  diag.appendChild(body);
  root.appendChild(diag);
}

function instanceRow(i) {
  const caps = instanceCapabilities(i);
  const name = el('div');
  name.appendChild(el('div', i.instanceId, 'mono'));
  name.appendChild(el('div', i.installationId || '-', 'muted mono'));
  const status = el('div');
  status.appendChild(badge(i.connectionState === 'online' ? 'online' : 'offline', i.connectionState));
  status.appendChild(document.createTextNode(' '));
  status.appendChild(badge(i.state || '-', i.state));
  if (i.dshHealth) {
    status.appendChild(document.createTextNode(' '));
    status.appendChild(badge(i.dshHealth.lastReportedOnline ? 'DSH online' : 'DSH offline', i.dshHealth.freshness === 'stale' ? 'warn' : 'active'));
  }
  const actions = el('div', null, 'actions');
  actions.appendChild(button('详情', 'secondary', function () { return showInstanceDetail(i.instanceId); }));
  const iframe = button('iframe', null, function () { openIframe(i.instanceId, i.namespaceName || '-'); });
  iframe.disabled = caps.canOpen === false;
  actions.appendChild(iframe);
  const open = button('新窗口', 'secondary', function () { window.open(instanceUrl(i.instanceId), '_blank', 'noopener,noreferrer'); });
  open.disabled = caps.canOpen === false;
  actions.appendChild(open);
  if (caps.canViewDiagnostics) actions.appendChild(button('诊断', 'secondary', function () { return showDiagnostics(i.instanceId, i.namespaceName || '-'); }));
  if (caps.canIssueReplacementGrant) actions.appendChild(button('replacement', 'secondary', function () { return issueReplacementGrantUi(i); }));
  if (i.state === 'active' && caps.canRevoke) actions.appendChild(button('revoke', 'danger', function () { return revokeInstanceUi(i); }));
  if (i.state === 'revoked' && caps.canRecover) actions.appendChild(button('recover', null, function () { return recoverInstanceUi(i); }));
  const type = el('div');
  type.appendChild(badge(i.delivery || '-', ''));
  type.appendChild(el('div', i.deploymentMode || 'unknown', 'muted'));
  return [
    name,
    (i.namespaceName || '-') + ' · ' + (i.ownerUsername || '-'),
    type,
    (i.hostname || '-') + ' / ' + (i.dshVersion || '-'),
    status,
    actions,
  ];
}

async function issueReplacementGrantUi(i) {
  const reason = prompt('replacement grant reason', 'portal action');
  if (!reason) return;
  const data = await postJson('/api/instances/' + encodeURIComponent(i.instanceId) + '/replacement-grants', { reason: reason }, { 'Idempotency-Key': randomIdempotencyKey() });
  await copyText(data.replacementGrant);
  alert('replacement grant 只展示一次，已尝试复制：' + data.replacementGrant);
}

async function revokeInstanceUi(i) {
  const reason = prompt('revoke reason', 'portal action');
  if (!reason) return;
  await postJson('/api/instances/' + encodeURIComponent(i.instanceId) + '/revoke', { reason: reason });
  await reloadInstances();
}

async function recoverInstanceUi(i) {
  const reason = prompt('recover reason', 'portal action');
  if (!reason) return;
  await postJson('/api/instances/' + encodeURIComponent(i.instanceId) + '/recover', { reason: reason });
  await reloadInstances();
}

async function renderUsers() {
  const root = document.getElementById('view-users');
  clearNode(root);
  const pane = surface('Users', 'system_admin 可查看用户状态、系统管理员标记，以及 namespace/membership 摘要。');
  const page = STATE.pages.users;
  const q = input(page.filters.q, '搜索 username / display name / email');
  const status = select([{ value:'', label:'全部状态' }, { value:'active', label:'active' }, { value:'disabled', label:'disabled' }], page.filters.status);
  const systemAdmin = select([{ value:'', label:'全部用户' }, { value:'true', label:'system admin' }, { value:'false', label:'非 system admin' }], page.filters.systemAdmin);
  const toolbar = el('div', null, 'toolbar');
  toolbar.appendChild(field('搜索', q));
  toolbar.appendChild(field('状态', status));
  toolbar.appendChild(field('系统管理员', systemAdmin));
  toolbar.appendChild(button('筛选', 'secondary', async function () {
    page.filters.q = q.value.trim();
    page.filters.status = status.value;
    page.filters.systemAdmin = systemAdmin.value;
    page.cursors = [];
    await reloadUsers();
  }));
  pane.body.appendChild(toolbar);
  try {
    if (!page.loaded) {
      pane.body.appendChild(el('div', '加载中…', 'empty'));
      root.appendChild(pane.node);
      reloadUsers().catch(function (error) {
        page.loaded = true;
        page.items = [];
        root.appendChild(el('div', '加载用户失败：' + error.message, 'empty'));
      });
      return;
    }
    if (!page.items.length) pane.body.appendChild(el('div', '暂无用户。', 'empty'));
    else pane.body.appendChild(table(['用户', '状态', 'system', 'namespace/membership', '操作'], page.items.map(userRow)));
    pane.body.appendChild(renderPager('users', reloadUsers));
  } catch (error) {
    pane.body.appendChild(el('div', '加载用户失败：' + error.message, 'empty'));
  }
  root.appendChild(pane.node);
  const detail = el('div', null, 'surface hidden');
  detail.id = 'userDetail';
  root.appendChild(detail);
}

function userRow(u) {
  const user = el('div');
  user.appendChild(el('div', u.username));
  user.appendChild(el('div', u.displayName || u.email || '-', 'muted'));
  const actions = el('div', null, 'actions');
  actions.appendChild(button('详情', 'secondary', function () { return showUserDetail(u.userId); }));
  if (u.status === 'active') {
    actions.appendChild(button('禁用', 'danger', async function () {
      const reason = prompt('disable reason', 'portal action');
      if (!reason) return;
      await postJson('/api/users/' + encodeURIComponent(u.userId) + '/disable', { reason: reason });
      await reloadUsers();
    }));
  } else {
    actions.appendChild(button('恢复', null, async function () {
      const reason = prompt('restore reason', 'portal action');
      if (!reason) return;
      await postJson('/api/users/' + encodeURIComponent(u.userId) + '/restore', { reason: reason });
      await reloadUsers();
    }));
  }
  return [
    user,
    badge(u.status, u.status),
    u.systemAdmin ? 'yes' : 'no',
    String(u.ownedNamespaceCount || 0) + ' / ' + String(u.activeMembershipCount || 0),
    actions,
  ];
}

async function showUserDetail(userId) {
  const detail = document.getElementById('userDetail');
  detail.classList.remove('hidden');
  clearNode(detail);
  const data = await api('/api/users/' + encodeURIComponent(userId));
  const user = data.user;
  const pane = surface('用户详情 · ' + user.username, '最小用户资料与 namespace/membership 摘要。');
  pane.body.appendChild(table(['字段', '值'], [
    ['User ID', user.userId],
    ['Display name', user.displayName || '-'],
    ['Email', user.email || '-'],
    ['Status', user.status],
    ['System admin', user.systemAdmin ? 'yes' : 'no'],
    ['Owned namespaces', user.ownedNamespaceCount],
    ['Active memberships', user.activeMembershipCount],
    ['Created', user.createdAt || '-'],
    ['Updated', user.updatedAt || '-'],
  ]));
  detail.appendChild(pane.node);
}

async function renderAudit() {
  const root = document.getElementById('view-audit');
  clearNode(root);
  const pane = surface('Audit', '最近管理动作和拒绝事件，默认每页 200 条。');
  const page = STATE.pages.audit;
  const q = input(page.filters.q, '搜索 request/object/details');
  const namespace = input(page.filters.namespace, 'namespace id');
  const actor = input(page.filters.actor, 'actor');
  const action = input(page.filters.action, 'action');
  const result = input(page.filters.result, 'result');
  const from = dateTimeInput(page.filters.from);
  const to = dateTimeInput(page.filters.to);
  const toolbar = el('div', null, 'toolbar');
  toolbar.appendChild(field('搜索', q));
  toolbar.appendChild(field('namespace', namespace));
  toolbar.appendChild(field('actor', actor));
  toolbar.appendChild(field('action', action));
  toolbar.appendChild(field('result', result));
  toolbar.appendChild(field('起始时间', from));
  toolbar.appendChild(field('结束时间', to));
  toolbar.appendChild(button('筛选', 'secondary', async function () {
    page.filters.q = q.value.trim();
    page.filters.namespace = namespace.value.trim();
    page.filters.actor = actor.value.trim();
    page.filters.action = action.value.trim();
    page.filters.result = result.value.trim();
    page.filters.from = from.value;
    page.filters.to = to.value;
    page.cursors = [];
    await reloadAudit();
  }));
  pane.body.appendChild(toolbar);
  try {
    if (!page.loaded) {
      pane.body.appendChild(el('div', '加载中…', 'empty'));
      root.appendChild(pane.node);
      reloadAudit().catch(function (error) {
        page.loaded = true;
        page.items = [];
        root.appendChild(el('div', '加载审计失败：' + error.message, 'empty'));
      });
      return;
    }
    pane.body.appendChild(auditTable(page.items || []));
    pane.body.appendChild(renderPager('audit', reloadAudit));
  } catch (error) {
    pane.body.appendChild(el('div', '加载审计失败：' + error.message, 'empty'));
  }
  root.appendChild(pane.node);
}

function auditTable(items) {
  if (!items.length) return el('div', '暂无审计事件。', 'empty');
  return table(['时间', 'actor', 'namespace', '目标', '动作', '结果', 'details'], items.map(function (item) {
    return [
      item.time || '-',
      [item.actorType, item.actorId].filter(Boolean).join(':') || '-',
      item.namespaceId || '-',
      item.instanceId || item.targetUserId || item.inviteId || '-',
      item.action,
      item.result,
      JSON.stringify(item.details || {}),
    ];
  }));
}

async function showDiagnostics(id, ns) {
  const panel = document.getElementById('diagnosticsPanel');
  const body = document.getElementById('diagnosticsBody');
  document.getElementById('diagnosticsTitle').textContent = '远程兼容诊断';
  panel.classList.remove('hidden');
  clearNode(body);
  body.className = 'surface-body empty';
  body.textContent = '诊断中… ' + ns + ' / ' + id;
  try {
    const result = await api('/api/instances/' + encodeURIComponent(id) + '/diagnostics?refresh=1');
    renderDiagnostics(body, result);
  } catch (error) {
    body.className = 'surface-body empty';
    body.textContent = '诊断失败：' + error.message;
  }
}

async function showInstanceDetail(id) {
  const panel = document.getElementById('diagnosticsPanel');
  const body = document.getElementById('diagnosticsBody');
  document.getElementById('diagnosticsTitle').textContent = '实例详情';
  panel.classList.remove('hidden');
  clearNode(body);
  body.className = 'surface-body empty';
  body.textContent = '加载中…';
  const data = await api('/api/instances/' + encodeURIComponent(id));
  const instance = data.instance;
  const lines = [
    'instance: ' + instance.instanceId,
    'installation: ' + (instance.installationId || '-'),
    'namespace: ' + (instance.namespaceName || '-') + ' (' + instance.namespaceId + ')',
    'owner: ' + (instance.ownerUsername || '-'),
    'connection/access: ' + instance.connectionState + ' / ' + instance.state,
    'delivery/mode: ' + instance.delivery + ' / ' + instance.deploymentMode,
    'host: ' + (instance.hostname || '-'),
    'client/DSH: ' + (instance.clientVersion || '-') + ' / ' + (instance.dshVersion || '-'),
    'last seen: ' + (instance.lastSeenAt || '-'),
    'created: ' + (instance.createdAt || '-'),
  ];
  body.className = 'surface-body';
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\n');
  body.appendChild(pre);
}

function renderDiagnostics(root, result) {
  clearNode(root);
  root.className = 'surface-body';
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
  pre.textContent = lines.join('\n');
  root.appendChild(pre);
  const recs = Array.isArray(result.recommendations) ? result.recommendations : [];
  if (recs.length) {
    root.appendChild(el('div', '建议处置：', 'hint'));
    const ul = document.createElement('ul');
    ul.className = 'recommendations';
    recs.forEach(function (rec) {
      const li = document.createElement('li');
      li.textContent = rec.code + ': ' + rec.message;
      ul.appendChild(li);
    });
    root.appendChild(ul);
  }
}

function openIframe(id, namespaceName) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = namespaceName + ' / ' + id;
  document.getElementById('modalFrame').src = instanceUrl(id);
  modal.classList.add('open');
}

document.getElementById('closeModalButton').addEventListener('click', function () {
  document.getElementById('modalFrame').src = 'about:blank';
  document.getElementById('modal').classList.remove('open');
});

load();
`;

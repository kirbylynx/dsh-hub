const BASIC_INSTANCE_ACTIONS = new Set([
  'namespace.view',
  'instance.view',
  'instance.open',
  'instance.diagnostics.view',
]);

const VIEWER_ACTIONS = new Set([
  'namespace.view',
  'instance.view',
  'instance.diagnostics.view',
]);

const ADMIN_ACTIONS = new Set([
  ...BASIC_INSTANCE_ACTIONS,
  'namespace.member.invite_basic',
  'namespace.member.add_basic',
  'namespace.member.update_basic',
  'namespace.member.remove_basic',
  'instance.replacement.create',
  'instance.revoke',
  'instance.recover',
  'audit.view',
]);

const OWNER_ACTIONS = new Set([
  ...ADMIN_ACTIONS,
  'namespace.registry.rotate',
  'namespace.member.invite_admin',
  'namespace.member.add_admin',
  'namespace.member.update_admin',
  'namespace.member.remove_admin',
]);

const SYSTEM_ACTIONS = new Set([
  'namespace.create',
  'user.list',
  'user.disable',
  'user.restore',
]);

export function authorize({ user, isSystemAdmin = false, namespaceRole = null, action }) {
  if (!user || user.status !== 'active') return deny('USER_DISABLED_OR_MISSING');
  if (isSystemAdmin) return allow('system_admin');
  if (SYSTEM_ACTIONS.has(action)) return deny('SYSTEM_ADMIN_REQUIRED');
  if (!namespaceRole) return deny('MEMBERSHIP_REQUIRED');
  if (namespaceRole === 'namespace_owner') {
    return OWNER_ACTIONS.has(action) ? allow(namespaceRole) : deny('ROLE_NOT_ALLOWED');
  }
  if (namespaceRole === 'namespace_admin') {
    return ADMIN_ACTIONS.has(action) ? allow(namespaceRole) : deny('ROLE_NOT_ALLOWED');
  }
  if (namespaceRole === 'member') {
    return BASIC_INSTANCE_ACTIONS.has(action) ? allow(namespaceRole) : deny('ROLE_NOT_ALLOWED');
  }
  if (namespaceRole === 'viewer') {
    return VIEWER_ACTIONS.has(action) ? allow(namespaceRole) : deny('ROLE_NOT_ALLOWED');
  }
  return deny('ROLE_NOT_ALLOWED');
}

export function memberActionForRole(prefix, role) {
  if (role === 'namespace_admin') return `${prefix}_admin`;
  if (role === 'member' || role === 'viewer') return `${prefix}_basic`;
  return `${prefix}_owner`;
}

function allow(scope) {
  return { allow: true, scope, reason: 'ALLOW' };
}

function deny(reason) {
  return { allow: false, reason };
}

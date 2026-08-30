export const DEPLOYMENT_MODE_REMOTE = 'remote';
export const DEPLOYMENT_MODE_HOSTED = 'hosted';
export const DEPLOYMENT_MODE_UNKNOWN = 'unknown';

export const DEPLOYMENT_MODES = Object.freeze([
  DEPLOYMENT_MODE_REMOTE,
  DEPLOYMENT_MODE_HOSTED,
]);

export const DSH_HUB_HOSTED_MARKER_FILE = 'hosted-mode.json';
export const DSH_HUB_HOSTED_WORKSPACE_ROOT = '/workspace';

export function normalizeDeploymentMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DEPLOYMENT_MODES.includes(text) ? text : null;
}

export function deploymentModeOrDefault(value, fallback = DEPLOYMENT_MODE_REMOTE) {
  return normalizeDeploymentMode(value) ?? fallback;
}

export function publicDeploymentMode(value) {
  return normalizeDeploymentMode(value) ?? DEPLOYMENT_MODE_UNKNOWN;
}

export function hostedModeMarkerPayload({
  workspaceRoot = DSH_HUB_HOSTED_WORKSPACE_ROOT,
} = {}) {
  return Object.freeze({
    kind: 'dsh-hub-hosted',
    version: 1,
    deploymentMode: DEPLOYMENT_MODE_HOSTED,
    workspaceRoot,
  });
}

export function hostedModeMarkerText(options = {}) {
  return `${JSON.stringify(hostedModeMarkerPayload(options), null, 2)}\n`;
}

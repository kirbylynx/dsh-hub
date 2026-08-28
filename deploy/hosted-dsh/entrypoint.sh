#!/usr/bin/env bash
set -euo pipefail

DSH_HOME="${DSH_HOME:-/dsh-home}"
DSH_HUB_PROFILE="${DSH_HUB_PROFILE:-web}"
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"
DSH_HUB_PLUGIN_SOURCE="${DSH_HUB_PLUGIN_SOURCE:-/opt/dsh-hub/packages/dsh-hub-plugin}"
DSH_HUB_PLUGIN_CONFIG_DIR="${DSH_HUB_PLUGIN_CONFIG_DIR:-${DSH_HOME}/dsh-hub-plugin}"
DSH_HUB_REMOTE_PATCH="${DSH_HUB_REMOTE_PATCH:-hosted-capabilities.patch.yml}"
DSH_HUB_INSTANCE_NAME="${DSH_HUB_INSTANCE_NAME:-${HOSTNAME:-hosted-dsh}}"

export DSH_HOME
export DSH_HUB_PLUGIN_CONFIG_DIR

require_config() {
  if [ -z "${DSH_HUB_ENDPOINT:-}" ]; then
    echo "DSH_HUB_ENDPOINT is required" >&2
    exit 2
  fi
  if [ -z "${DSH_HUB_NAMESPACE:-}" ]; then
    echo "DSH_HUB_NAMESPACE is required" >&2
    exit 2
  fi
}

prepare_profile() {
  mkdir -p "$DSH_HOME" "$DSH_HUB_PLUGIN_CONFIG_DIR" /workspace /logs

  # Let DSH create or refresh the selected profile before installing the hub plugin.
  dsh --profile "$DSH_HUB_PROFILE" --dump-config >/tmp/dsh-hub-profile.json

  dsh-hub-client plugin-install \
    --profile "$DSH_HUB_PROFILE" \
    --dsh-home "$DSH_HOME" \
    --plugin-source "$DSH_HUB_PLUGIN_SOURCE" \
    --endpoint "$DSH_HUB_ENDPOINT" \
    --namespace "$DSH_HUB_NAMESPACE" \
    --instance-name "$DSH_HUB_INSTANCE_NAME" \
    --apply \
    --force \
    --json >/logs/plugin-install.last.json
}

resolve_remote_patch_path() {
  if [ -n "$DSH_HUB_REMOTE_PATCH" ]; then
    case "$DSH_HUB_REMOTE_PATCH" in
      /*) patch_path="$DSH_HUB_REMOTE_PATCH" ;;
      */*) patch_path="$DSH_HUB_REMOTE_PATCH" ;;
      *) patch_path="${DSH_HOME}/profiles/${DSH_HUB_PROFILE}/node_modules/dsh-hub-plugin/${DSH_HUB_REMOTE_PATCH}" ;;
    esac
    printf '%s\n' "$patch_path"
  fi
}

cmd="${1:-start}"
if [ "$#" -gt 0 ]; then shift; fi

case "$cmd" in
  start)
    require_config
    prepare_profile
    remote_patch_args=()
    if remote_patch_path="$(resolve_remote_patch_path)"; then
      if [ -n "$remote_patch_path" ]; then
        remote_patch_args=(--remote-patch "$remote_patch_path")
      fi
    fi
    exec dsh-hub-web \
      --profile "$DSH_HUB_PROFILE" \
      --dsh-home "$DSH_HOME" \
      "${remote_patch_args[@]}" \
      --endpoint "$DSH_HUB_ENDPOINT" \
      --namespace "$DSH_HUB_NAMESPACE" \
      --instance-name "$DSH_HUB_INSTANCE_NAME" \
      -- \
      --host 127.0.0.1 \
      --port "$DSH_WEB_PORT" \
      --no-open \
      "$@"
    ;;
  join)
    require_config
    prepare_profile
    exec dsh-hub-client plugin-join \
      --profile "$DSH_HUB_PROFILE" \
      --dsh-home "$DSH_HOME" \
      --plugin-source "$DSH_HUB_PLUGIN_SOURCE" \
      --plugin-config-dir "$DSH_HUB_PLUGIN_CONFIG_DIR" \
      --endpoint "$DSH_HUB_ENDPOINT" \
      --target "127.0.0.1:${DSH_WEB_PORT}" \
      --instance-name "$DSH_HUB_INSTANCE_NAME" \
      "$@"
    ;;
  install-check)
    remote_patch_args=()
    if remote_patch_path="$(resolve_remote_patch_path)"; then
      if [ -n "$remote_patch_path" ]; then
        remote_patch_args=(--remote-patch "$remote_patch_path")
      fi
    fi
    exec dsh-hub-client plugin-install-check \
      --profile "$DSH_HUB_PROFILE" \
      --dsh-home "$DSH_HOME" \
      "${remote_patch_args[@]}" \
      --plugin-config-dir "$DSH_HUB_PLUGIN_CONFIG_DIR" \
      "$@"
    ;;
  shell)
    exec bash "$@"
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac

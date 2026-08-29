# dsh-hub-plugin

语言：[English](README.md) | 简体中文

v0.1.2 plugin-first 交付基线：这是 DSH 进程内插件交付方式的连接状态、session/workspace 诊断摘要、browser card live status bridge、显式远程 host capability overlay、远程 history autoload、一行启动包装 `dsh-hub-web`、只读安装检查 `plugin-install-check`、profile 安装器 `plugin-install` 和入伙 CLI `plugin-join` 基线；它保留 M4D-3 入伙/凭据 runtime、M4D-2 tunnel adapter、M4D-1 browser settings card 与 M4C 目录选择 overlay。

当前能力：

- 声明标准 DSH bundle：`dsh.bundle.patch -> ./cordis.patch.yml`；
- 在 web profile 中插入一个默认关闭的 host 插件 row；
- 注册 `dsh-hub` settings namespace；
- 提供 `ctx.dshHubPlugin` 只读状态服务；
- 读取同进程 `ctx.webServer.host/port` 作为后续 loopback target 的来源；
- 提供 `PluginTunnelAdapter`，复用 `dsh-hub-client` 的 v1.1 `runTunnel` 状态机，启动时固定 `delivery=plugin`、禁用 CLI 进程信号处理，并把 target 固定为同进程 DSH webServer loopback；
- 提供 `PluginCredentialStore` 和 `PluginRuntime`：用 registry key 或 replacement grant 调用既有 `/api/register` 时上报 `delivery=plugin`，成功后仅保存 endpoint、installationId、instanceId、instanceToken、过期/续期时间、target 和版本等 instance credentials；
- 插件启用且 endpoint 匹配已有 instance credentials 时可自动启动 tunnel；endpoint/webServer route 变化会停止旧 tunnel，旧 endpoint credentials 不会被误用于新 hub；
- 已有 instance credentials 时拒绝 registry key 静默重入伙；恢复必须使用 owner replacement grant，并复用 installation ID；
- token rotate 会先停旧 tunnel、保存新 token 后再接管，且对外只返回脱敏摘要；leave 会自助吊销并清理本地 instance credentials；
- 提供 `statusView`：展示 connection state、delivery、协议版本、instance URL 推导 hint、target、token 过期时间、最近状态/错误；
- 提供 `diagnostics()`：只读探测同进程 DSH loopback root、`session.list`、`workspace.list`、`events.mux`、`events.host`，并只返回 session/workspace 映射计数、受控错误和推荐处置；
- 提供 `remote-capabilities.patch.yml`，显式启用后禁用默认 auto/native directory picker、挂载 DSH browse picker host/client rows，并通过 `api-gateway.config.nativeOpen=false` 让 `host.describe.canOpenPath=false`，用于 UI gating；
- 提供 `hosted-capabilities.patch.yml` 和 `dsh-hub-plugin/restricted-directory-picker` 用于 VPS/container 托管 DSH：browser picker 从 `/workspace` 开始，拒绝 `/workspace` 外路径，跳过真实路径指向根目录外的 symlink，并且只允许在 `/workspace` 下新建目录；
- 声明 `dsh.client` 和 `./client` lazy-CJS browser bundle，在 DSH Plugins settings 页注册一个只读 `dsh-hub` 状态与诊断卡片。
- 将浏览器 history autoload 限制在远程 origin，先加载最新消息，并依赖实例侧 client relay 在 DSH history 响应离开实例前完成请求下压、响应瘦身和 byte cap；
- 提供 `dsh-hub-web`：不修改真实 DSH profile，启动时应用已有 enabled patch，或从 `--endpoint/--namespace` 生成临时非秘密 enabled patch，并显式叠加 `remote-capabilities.patch.yml` 后执行 `dsh web`；
- 提供 `dsh-hub-client plugin-install-check`：只读检查 DSH 命令、web profile、bundle/dependency、plugin package、enabled patch、remote overlay 和 plugin credentials 文件是否存在，不读取或打印任何 token。
- 提供 `dsh-hub-client plugin-install`：默认 dry-run；显式 `--apply` 后只写 profile package metadata、本地 plugin symlink 和非秘密 enabled patch，`--enabled-patch` 路径必须位于所选 profile 目录内，并在覆盖前备份；
- 提供 `dsh-hub-client plugin-join`：从目标 profile 已安装的 plugin package 动态加载并复用 `PluginRuntime.join({ start:false })`，只保存 plugin instance credentials，不启动 tunnel；推荐用 `--registry-key-stdin` / `--replacement-grant-stdin` 输入一次性 secret。

一行启动远程 plugin 模式：

```bash
# 只读检查；不会修改 ~/.dsh，也不会打印 registry key / replacement grant / instance token
dsh-hub-client plugin-install-check

# 默认 dry-run：预览 profile package、symlink 和 enabled patch 变化
dsh-hub-client plugin-install --endpoint https://control.hub.example.com --namespace my-team

# 显式写入：不接收 registry key/replacement grant/instance token
dsh-hub-client plugin-install --endpoint https://control.hub.example.com --namespace my-team --apply

# 复用 PluginRuntime.join；secret 从 stdin 进入，不落 settings 或日志
printf '%s' "$DSH_HUB_REGISTRY_KEY" | dsh-hub-client plugin-join \
  --endpoint https://control.hub.example.com --registry-key-stdin

# 使用 profile 中已有 dsh-hub-enabled.patch.yml 启动
dsh-hub-web
```

显式启用远程 host capability overlay 的形式：

```bash
DSH_HUB_REMOTE_PATCH="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-hub-plugin/remote-capabilities.patch.yml"
dsh web --patch "$DSH_HUB_REMOTE_PATCH"
```

该 overlay 不在默认 bundle patch 中自动启用，目的是保持 plugin disabled/default-off 时不改变原始 DSH 行为。它会禁用实例机器 native picker，并让 `canOpenPath=false` 以隐藏/禁用依赖该 capability 的 UI affordance；它不提供远程 openPath 替代 UI，也不拦截 direct `host.openPath` RPC。

hosted 容器应使用更严格的 hosted overlay：

```bash
DSH_HUB_HOSTED_PATCH="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-hub-plugin/hosted-capabilities.patch.yml"
dsh web --patch "$DSH_HUB_HOSTED_PATCH"
```

hosted overlay 保留相同的 `canOpenPath=false` gating，但会把 whole-filesystem browse backend 替换为根目录固定在 `/workspace` 的 restricted picker。这个 hosted-only 行为不会自动应用到普通本机 plugin 模式。

当前明确不做：

- 不把 registry key 或 replacement grant 写入 DSH settings、plugin store、URL、browser card 或日志；它们只作为一次性入伙输入；
- browser card 会同源 `fetch` `/plugins/dsh-hub-plugin/status.json` 读取最小脱敏 `statusView`，但不读取、录入或保存任何秘密，也不建立 WebSocket；
- 不在默认 bundle patch 中替换 directory picker；
- 不提供 remote `host.openPath` 替代；显式 overlay 只通过 `api-gateway.config.nativeOpen=false` 关闭 `canOpenPath` 能力广告 / UI gating；
- `plugin-install` 不接收 registry key/replacement grant/instance token，且底层安装 helper 默认也是 dry-run；`plugin-join` 不启动 tunnel、不把一次性 secret 写入 settings/profile/URL/日志；安装/启用必须由用户单独授权。

browser settings card 使用 DSH rc.7 已验证的 lazy-CJS 形态：`package.json` 声明 `dsh.client`，`exports["./client"]` 指向会调用 `window.__ModuleLoader__.load({ id, factory })` 的 classic script。

本地开发依赖固定到当前已验证的 DSH `0.1.0-rc.7` 相关包。`npm run test:m4:skeleton` 不只检查 profile patch，还会在临时 `DSH_HOME` 中短时启动 `dsh --profile web --port 0`，确认插件入口可被真实 DSH loader 导入。`npm run test:m4:host-capabilities` 会在临时 `DSH_HOME` 中验证默认 composition 不变，并用显式 overlay 验证 browse picker rows、`api-gateway.config.nativeOpen=false` 与 runtime activation。`npm run test:m4:open-path` 会验证默认 composition 不设置 `nativeOpen:false`、显式 overlay 只 patch 既有 api gateway、运行时 `host.describe.canOpenPath=false`、状态模型标记 `can-open-path-overlay-available` 且 `openPathAdapter=false`。`npm run test:m4:browser-card` 会验证 `dsh.client` graph、`/plugins/dsh-hub-plugin/client.js` serving、browser factory 的 `settings.plugin.item` 注册形态和 history autoload gating。`npm run test:m4:tunnel-adapter` 会验证 M4D-2 adapter 的 loopback target、`delivery=plugin`、无 CLI signal handler、缺 credentials 不启动边界。`npm run test:m4:plugin-credentials` 会验证 M4D-3 的 registry/replacement 入伙、只保存 instance credentials、enabled+已有凭据自动启动、target 不可用先拒绝注册、已有凭据拒绝 registry key rejoin、route 变化停止旧 tunnel、旧 endpoint credentials 不可启动，以及 rotate/leave 生命周期。`npm run test:m4:plugin-status` 会验证 M4D-4/M4D-5 的状态视图、instance URL 推导、本地诊断摘要、路径/secret 脱敏、同源 live status endpoint 和 browser card 展示。`npm run test:g11:hosted-picker` 会验证 hosted overlay 和 restricted picker 只允许选择 `/workspace` 以内路径。`npm run test:m4:plugin-cli` 会验证 M4D-7A 的一行启动包装、临时 enabled patch、显式 overlay 参数、只读安装检查和 secret 不泄露。`npm run test:m4:plugin-install` 会验证 M4D-7B 的默认 dry-run、`--apply` 写入、profile/enabled patch 路径越界拒绝、失败不产生半安装、`PluginRuntime.join({ start:false })` 入伙、stdin/JSON secret 不泄露、registry rejoin 拒绝和 replacement grant 跨 endpoint 防护。G1 history normalizer/tunnel 测试覆盖远程 history 请求下压、响应瘦身、raw/final byte cap 和错误分类。

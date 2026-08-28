# 托管 DSH 容器

语言：[English](README.md) | 简体中文

这个模板是 G11 的基线：在 Docker 里运行一个手工管理的 DSH 实例，并通过
`dsh-hub-plugin` 接入 `dsh-hub`。

它有意独立于 hub service 部署模板。容器不会发布 DSH Web 端口；远程访问仍然通过
hub 的实例子域和 plugin tunnel。

## 范围

包含：

- 一个包含 Node.js、固定 `@deepseek-ai/dsh@0.1.0-rc.7`、
  `dsh-hub-client` 和 `dsh-hub-plugin` 的托管 DSH 镜像；
- 一个手工命名实例的 Compose 服务，例如 `dsh-0001`；
- DSH home、workspace 和 logs 的宿主机挂载；
- 非 root 运行、只读根文件系统、drop capabilities、`no-new-privileges`、
  资源限制、healthcheck 和 Docker 日志轮转；
- `start`、`join`、`install-check` 和 `shell` entrypoint 模式。

不包含：

- 托管实例自动分配；
- 多用户归属和权限管理；
- 强敌对租户隔离承诺；
- 公开暴露容器内 DSH Web 端口；
- 在 Compose 环境变量里长期保存 registry key、replacement grant 或 instance token。

## 准备私有部署副本

真实部署不要直接修改 public 仓库里的 `.env.example`。应把该目录或至少 env 文件复制到
私有运维 overlay：

```bash
cp deploy/hosted-dsh/.env.example deploy/hosted-dsh/.env
```

编辑 `.env`：

```dotenv
DSH_HOSTED_INSTANCE_ID=dsh-0001
DSH_HOST_DATA_ROOT=/data/docker
DSH_HUB_ENDPOINT=https://control.hub.example.com
DSH_HUB_NAMESPACE=my-team
DSH_HUB_INSTANCE_NAME=hosted-dsh-0001
DSH_VERSION=0.1.0-rc.7
```

启动容器前先创建宿主机目录：

```bash
sudo mkdir -p \
  /data/docker/dsh-0001/dsh-home \
  /data/docker/dsh-0001/workspace \
  /data/docker/dsh-0001/logs
sudo chown -R 10001:10001 /data/docker/dsh-0001
```

## 检查和构建

```bash
npm run deploy:g11:hosted-dsh:check

docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml build hosted-dsh
```

检查脚本会验证 Compose 渲染和基础安全护栏。它不会连接真实 hub，也不证明某台真实 VPS
已经部署成功。

## 手工入伙

registry key 或 replacement grant 应通过 stdin 或交互提示输入。不要把它写入 `.env`、
镜像或 Compose 环境变量。

交互输入：

```bash
docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm hosted-dsh join
```

stdin 输入：

```bash
printf '%s' "$DSH_HUB_REGISTRY_KEY" | docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm -T hosted-dsh join --registry-key-stdin
```

replacement grant：

```bash
printf '%s' "$DSH_HUB_REPLACEMENT_GRANT" | docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm -T hosted-dsh join --replacement-grant-stdin
```

成功后只会把 plugin instance credentials 保存到挂载的 DSH home 下。一次性 registry
key 或 replacement grant 不会被 `plugin-join` 持久化。

## 启动

```bash
docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml up -d hosted-dsh
```

然后打开 hub Portal，确认托管实例 online。用户仍通过常规实例子域访问：

```text
https://<instanceId>.instances.<baseDomain>/
```

## 运维注意事项

- 每个托管 DSH 实例使用一个独立宿主机目录。
- 不挂载 Docker socket。
- 不使用 `privileged: true`。
- 不 bind-mount `/`、`/home`、`/root`、`/var/run` 等宽泛宿主机目录。
- VPS 管理员可以读取所有挂载实例数据，不应承诺对宿主机管理员保密。
- 真实部署证据应保存在私有运维 overlay。

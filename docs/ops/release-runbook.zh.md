# 发布、部署与验证运行手册

语言：[English](release-runbook.md) | 简体中文

本文描述自托管 dsh-hub operator 可采用的保守发布流程。真实部署证据应保存在公开仓库之外。

## 1. Release candidate

在可追溯的分支或 commit 上准备 release candidate：

```bash
git status --short --branch
git diff --check
npm test
git log --oneline --decorate -5
```

部署证据和 release notes 完成前，不要创建最终 tag。如果先部署 release candidate，应记录准确的运行代码 commit，并与后续 documentation-only 收口 commit 区分开。

## 2. 公开文档审查

发布文档前：

- 检查示例是否使用 `hub.example.com` 等占位符；
- 不要把真实域名、IP、本机路径、服务器用户、私有仓库 URL 放进公开仓库；
- 不要包含 registry key、replacement grant、instance token、provider API key、cookie 或 Authorization header；
- 未验证步骤应标注为 planned 或 recommended，不要写成 completed。

## 3. 部署前服务器快照

修改前先在服务器上记录当前状态：

```bash
cd /opt/dsh-hub
git status --short --branch
git rev-parse HEAD
git stash list

cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml ps
```

如果 hosted DSH 模板在单独目录部署，也在对应目录重复这些检查。

使用 Docker label 确认运行中的 Compose 来源，不要只看目录名：

```bash
container_id="$(docker compose --env-file .env -f docker-compose.yml ps -q dsh-hub-service)"
docker inspect "$container_id" \
  --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }} {{ index .Config.Labels "com.docker.compose.project.config_files" }}'
```

如果 working dir、Compose file 或 `.env` 来源不符合预期，先停止，不要继续部署。

## 4. 部署前备份

重建或重启服务前，先创建并验证 SQLite 备份。命令模板见 [SQLite 备份与恢复](sqlite-backup-restore.zh.md)。

至少记录：

- source commit；
- Compose 文件和环境文件；
- 备份路径、大小和权限；
- integrity check 结果；
- schema version 和 namespace/instance 摘要。

## 5. 部署

从明确的 release candidate commit 部署：

```bash
cd /opt/dsh-hub
git fetch --all --tags
release_ref="v0.1.4"
git checkout "$release_ref"
git rev-parse HEAD

cd deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
docker compose --env-file .env -f docker-compose.yml ps
```

升级期间不要运行 `docker compose down -v`，除非这是一个单独批准的销毁数据维护流程。

## 6. 验证

建议检查：

```bash
curl -fsS http://127.0.0.1:18081/healthz
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | head
curl -i https://hub.example.com/
curl -i https://control.hub.example.com/
curl -i https://inst-example.instances.hub.example.com/
```

如果使用 hosted DSH，还要验证 hosted 容器、tunnel、instance URL 和脱敏 model settings endpoint。

## 7. 最终收口与 tag

部署验证后：

1. 用已验证 commit 和 evidence 摘要更新 release notes。
2. 提交收口文档。
3. 将 release 分支合并到 `main`。
4. 在最终收口 commit 上创建 release tag。
5. 推送 `main` 和 tag。

示例：

```bash
git checkout main
release_branch="v0.1.4"
git merge --ff-only "$release_branch"
git tag v0.1.4
git push origin main
git push origin v0.1.4
```

如果 tag commit 包含运行镜像构建之后产生的 documentation-only evidence，应同时记录运行代码 commit 和最终文档收口 commit。

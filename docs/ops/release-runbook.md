# Release, deploy, and verify runbook

Language: English | [简体中文](release-runbook.zh.md)

This runbook describes a conservative release flow for self-hosted dsh-hub
operators. It assumes that real deployment evidence is kept outside the public
repository.

## 1. Release candidate

Prepare a release candidate on a branch or commit that can be traced later:

```bash
git status --short --branch
git diff --check
npm test
git log --oneline --decorate -5
```

Do not create a final tag before deployment evidence and release notes are
complete. If you deploy a release candidate first, record the exact running code
commit and distinguish it from later documentation-only closeout commits.

## 2. Public documentation review

Before publishing docs:

- check that examples use placeholders such as `hub.example.com`;
- keep real domains, IP addresses, local paths, server users, and private repo
  URLs out of the public repository;
- do not include registry keys, replacement grants, instance tokens, provider
  API keys, cookies, or Authorization headers;
- label unverified steps as planned or recommended, not completed.

## 3. Pre-deploy server snapshot

On the server, capture the current state before changing anything:

```bash
cd /opt/dsh-hub
git status --short --branch
git rev-parse HEAD
git stash list

cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml ps
```

If your hosted DSH template is deployed separately, repeat the same checks in
that deployment directory.

Use Docker labels to confirm the running Compose source instead of relying only
on directory names:

```bash
container_id="$(docker compose --env-file .env -f docker-compose.yml ps -q dsh-hub-service)"
docker inspect "$container_id" \
  --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }} {{ index .Config.Labels "com.docker.compose.project.config_files" }}'
```

Stop if the working directory, Compose file, or `.env` source is not what you
expected.

## 4. Backup before deploy

Create and verify a SQLite backup before rebuilding or restarting services.
Use [SQLite backup and restore](sqlite-backup-restore.md) as the command
template.

At minimum, record:

- source commit;
- Compose file and environment file;
- backup path, size, and mode;
- integrity check result;
- schema version and namespace/instance summaries.

## 5. Deploy

Deploy from the known release candidate commit:

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

Do not run `docker compose down -v` during an upgrade unless you are explicitly
destroying data in a separate, approved maintenance procedure.

## 6. Verify

Recommended checks:

```bash
curl -fsS http://127.0.0.1:18081/healthz
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | head
curl -i https://hub.example.com/
curl -i https://control.hub.example.com/
curl -i https://inst-example.instances.hub.example.com/
```

For hosted DSH, also verify the hosted container, tunnel, instance URL, and
redacted model settings endpoint.

## 7. Final closeout and tag

After deployment verification:

1. Update release notes with the verified commit and evidence summary.
2. Commit the closeout documentation.
3. Merge the release branch into `main`.
4. Create the release tag on the final closeout commit.
5. Push `main` and the tag.

Example:

```bash
git checkout main
release_branch="v0.1.4"
git merge --ff-only "$release_branch"
git tag v0.1.4
git push origin main
git push origin v0.1.4
```

If the tag commit includes documentation-only evidence that was produced after
the running image was built, record both the running code commit and the final
documentation closeout commit.

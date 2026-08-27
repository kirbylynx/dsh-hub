# M3 recovery and rollback baseline

Language: English | [简体中文](README.zh.md)

This directory contains the local M3B recovery baseline for `dsh-hub`.

It is intentionally a rehearsal aid, not an automated production deployment
tool. The check does not SSH to a server, does not connect production services,
and does not modify code, config, Docker volumes, Caddy, Authelia, or real DSH
instances.

In short: the local check does not connect to production servers, read
production secrets, or modify any production configuration.

## Files

- `check-recovery.mjs`: local consistency check for the recovery runbook plus a
  SQLite backup/restore smoke using a temporary database.
- `docs/ops/m3-recovery-runbook.md`: operator runbook for backup, restore,
  upgrade, and rollback in the existing-Caddy deployment shape.

## Local check

```bash
npm run deploy:m3:recovery:check
```

The smoke test creates a temporary `hub.db`, writes one namespace, one plugin
instance and one active instance token, creates a backup with `VACUUM INTO`,
sets the backup to `0600`, restores it into another temporary path, opens the
restored database through the current schema loader, and verifies namespace,
instance, token and schema readback.

## Self-hosted shape covered by the runbook

The self-hosted guidance is written for the existing-Caddy profile:

- system Caddy remains the only public `:80/:443` listener;
- Docker Compose manages only Authelia and `dsh-hub-service`;
- `dsh-hub-service` binds loopback only, currently `127.0.0.1:18081`;
- SQLite lives in Docker named volume `hub_data:/data` as `/data/hub.db`;
- SQLite is backed up with SQLite online backup semantics, using
  `VACUUM INTO` or an equivalent consistent backup, not by copying an active
  WAL database file directly.

The runbook requires manual evidence capture for real deployment health, restore,
upgrade and rollback. This local baseline proves that the repository has a
repeatable recovery check; it does not claim that a real deployment recovery
drill has already been executed.

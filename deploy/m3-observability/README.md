# M3 observability baseline

Language: English | [简体中文](README.zh.md)

This directory contains the local M3B observability baseline for
`dsh-hub-service`.

It is intentionally not a production deployment. The service `/metrics`
endpoint is internal-only and must be scraped from the same host or another
explicitly trusted private path. The M2 Caddy profiles continue to reject public
`/metrics` before proxying.

## Files

- `alerts.dsh-hub.yml`: Prometheus alert rules for the current service metrics.
- `check-alerts.mjs`: local consistency check for alert metric names and
  forbidden high-cardinality or secret-bearing labels.

## Local check

```bash
npm run deploy:m3:alerts:check
```

## Recommended same-host scrape

For the existing-Caddy self-hosted profile, Prometheus should scrape the loopback
service endpoint directly:

```yaml
scrape_configs:
  - job_name: dsh-hub-service
    metrics_path: /metrics
    static_configs:
      - targets:
          - 127.0.0.1:18081
```

Do not scrape `https://hub.example.com/metrics`,
`https://control.hub.example.com/metrics`, or instance domains. Those public
routes are intentionally blocked.

## Scope

This baseline covers rule syntax shape, safe metric references, and runbook
links. It does not configure Alertmanager receivers, paging, dashboards, long
production stress tests, backup/restore drills, or upgrade/rollback drills.

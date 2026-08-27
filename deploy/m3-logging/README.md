# M3B-6 logging retention check

Language: English | [简体中文](README.zh.md)

This folder contains the local check for the M3B-6 logging retention and
redaction baseline.

```bash
npm run deploy:m3:logging:check
```

The check does not connect to the production server and does not change any
runtime configuration. The full check requires
Docker Compose because it renders both deployment profiles and verifies bounded
`json-file` log retention (`10m × 7`). It also verifies that service/client log
helpers redact credential-shaped values before writing to stdout.

The root `npm test` suite uses the no-Docker subset below for the redaction and
documentation guardrails:

```bash
npm run test:m3:logging-redaction
```

Production use still requires an explicit deployment step and an operator-owned
decision on external log shipping, Alertmanager receivers, and incident ticket
retention.

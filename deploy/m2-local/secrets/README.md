# M2 local example secrets

Language: English | [简体中文](README.zh.md)

These files exist only so `docker compose config` can render locally.

Do not use them on a VPS. For a real deployment, create replacement files with:

```bash
node -e "console.log(Buffer.from(require('crypto').randomBytes(32)).toString('base64url'))"
openssl rand -base64 48
```

For the LLDAP-backed template, create non-example replacements for the token
keyrings, Authelia secrets, and LLDAP secrets before using the stack outside
local validation.

Keep real secret files out of Git. `.dockerignore` already excludes non-example
JSON/TXT files in this directory.

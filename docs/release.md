# Release Checklist

Bugrecall package is currently private (`"private": true`). This checklist prepares release readiness without publishing.

## Pre-release checks

```bash
npm install
npm run build
npm run typecheck
npm run doctor
npm run phase13a:check
npm run phase13b:check
npm run phase13c:check
npm run phase13d:check
npm run phase12e:check
npm run eval:retrieval
npm run package:check
npm run final:check
```

## Package validation

Run npm pack dry-run:

```bash
npm pack --dry-run --json
```

Confirm package contents exclude local artifacts (for example `.agent`, `*.db`, `.env`, `node_modules`).

CI should run at minimum:
- `phase13d:check`
- `package:check`

## Dashboard smoke test

```bash
node bin/pma.js dashboard
```

Open:

`http://127.0.0.1:1453`

## MCP smoke test

```bash
node bin/pma.js
```

Note: this is stdio MCP mode; do not expect normal CLI output on stdout.

## Version bump process

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Run full checks above.
4. Commit and tag release candidate.

## Publish status

Publishing is intentionally disabled in this phase because package stays private.

# Local Data, Privacy, and Safety

## Storage layout

- SQLite source-of-truth:
  - `.agent/memory.db`
- Optional vector index:
  - `.agent/lancedb/`

`.agent/` is created under repository root.

## Git hygiene

- Add `.agent/` to `.gitignore`.
- Do not commit `.agent/`.

## Privacy

- Bugrecall is local-first.
- No cloud sync by default.
- User corrections and memory records stay local unless you export manually.

## Error/log storage

- Bugrecall stores normalized errors and signatures.
- Full raw terminal logs are not intended to be stored fully by default.

## Dashboard exposure

- Dashboard default host: `127.0.0.1`
- Dashboard default port: `1453`
- Remote bind blocked unless `BUGRECALL_DASHBOARD_ALLOW_REMOTE=1`

## Command safety model

- No arbitrary user-provided shell command execution through MCP tools.
- Structured command kinds only (`test`, `lint`, `build`, `typecheck`).
- `spawn(..., shell: false)` path used for command execution.

## Patch safety model

- Search/replace patch requires exact unique match.
- Snapshot captured before successful patch writes.
- Restore is project/workspace-isolated.
